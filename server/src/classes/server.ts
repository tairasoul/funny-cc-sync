import fs from "fs";
import express from "express";
import expressWs from "express-ws";
import path from "path";
import process from "process";
import luaparse from "luaparse";
import { inspect } from "util";
import msgpack from "@msgpack/msgpack";
import hash from "hash-it";
import { WebSocket } from "ws";
import bundler from "luabundle";
import * as lua from "luamin";

const luamin = lua.default

type ProjectItem = {
  type: "library" | "script";
  files: string[];
  channelName: string;
  requiredChannels?: string[];
  directories?: string[];
} | {
  type: "library" | "script";
  files?: string[];
  channelName: string;
  requiredChannels?: string[];
  directories: string[];
}

type Project = {
  rootDir: string;
  project: ProjectItem[];
};

type SyncFile = {
  filePath: string;
  fileData: string;
}

type SyncRequest = {
  type: "library";
  files: SyncFile[];
} | {
  type: "script";
  files: SyncFile[];
} | {
  type: "deletion";
  files: string[];
}

type LuaRequire = {
  fullString: string;
  requiredModule: string;
}

type ModifiedLuaRequire = {
  original: string;
  replacement: string;
}

type CCRequest = {
  type: "subscribe";
  channels: string[];
}

const BuiltinModules = [
  "cc.audio.dfpwm",
  "cc.completion",
  "cc.expect",
  "cc.image.nft",
  "cc.pretty",
  "cc.require",
  "cc.shell.completion",
  "cc.strings"
]

export class SyncServer {
  private port: number;
  private project: Project | undefined;
  private server: expressWs.Application;
  private channelsChanged: string[] = [];
  private channelHashes: Map<string, number> = new Map();
  private subscribed: Map<WebSocket, string[]> = new Map();
  private files: Map<ProjectItem, string[]> = new Map();
  private fileBuffered: Map<ProjectItem, string[]> = new Map();
  private luaRoot: string;
  private minify: boolean;

  constructor(port: number, projectPath: string, luaFilesDir: string, minify = false) {
    this.port = port;
    this.minify = minify;
    this.luaRoot = luaFilesDir;
    this.project = JSON.parse(fs.readFileSync(path.join(process.cwd(), projectPath), 'utf8'));
    const expr = express();
    this.server = expressWs(expr).app;
  }

  setup() {
    this.server.get("/", (req, res) => {
      const channels: {channel: string; type: string}[] = [];
      for (const channel of this.project.project)
        channels.push({channel: channel.channelName, type: channel.type});
      res.send(Buffer.from(msgpack.encode(channels)).toString("base64"));
    })
    this.server.ws("/subscribe", (ws) => {
      ws.once("message", (data, binary) => {
        const decode = Buffer.from(data as unknown as string, "base64");
        const uint = new Uint8Array(decode);
        const decoded = msgpack.decode(uint) as CCRequest;
        decoded.channels = decoded.channels.filter((v) => this.project.project.find((b) => b.channelName === v));
        if (decoded.channels.length === 0) {
          ws.close();
          return;
        }
        this.subscribed.set(ws, decoded.channels);
        this.newSubscription(ws);
        ws.once("close", () => this.subscribed.delete(ws));
      })
    })
    setInterval(() => {
      this.UpdateHashes();
    }, 500)
    this.server.get("/sync.lua", (req, res) => {
      const file = path.join(this.luaRoot, "sync.lua");
      res.send(bundler.bundle(file, {
        resolveModule: (modu) => {
          if (modu === "msgpack")
            return path.join(this.luaRoot, "msgpack.lua");
          if (modu === "base64")
            return path.join(this.luaRoot, "base64.lua");
        },
        ignoredModuleNames: BuiltinModules
      }));
    })
    this.server.listen(this.port, () => {
      console.log(`hosting sync server on port ${this.port}`);
    })
  }

  private newSubscription(ws: WebSocket) {
    const subscribedChannels = this.subscribed.get(ws);
    const requests: SyncRequest[] = [];
    for (const channel of subscribedChannels)
      requests.push(...this.getRequestsForChannel(channel));
    ws.send(msgpack.encode(requests));
  }

  private getChannels() {
    const channels: string[] = [];
    for (const item of this.project.project)
      channels.push(item.channelName);
    return channels;
  }

  private assembleRequire(statement: luaparse.LocalStatement) {
    const requires: LuaRequire[] = [];
    for (const expr of statement.init) {
      if (expr.type !== "CallExpression") continue;
      if (expr.base.type !== "Identifier") continue;
      if (expr.base.name !== "require") continue;
      let string = "require(";
      const module = expr.arguments[0];
      if (module.type !== "StringLiteral") continue;
      string += module.raw;
      string += ")";
      requires.push({
        fullString: string,
        requiredModule: module.raw.replaceAll('"', "")
      })
    }
    return requires;
  }

  private preprocess(content: string) {
    let newContent = content;
    const ast = luaparse.parse(newContent, { luaVersion: "5.2"});
    const requires = ast.body.filter((v) => v.type === "LocalStatement" && v.init.filter((v) => v.type === "CallExpression").find((v) => v.base.type === "Identifier" && v.base.name === "require"));
    const assembled: LuaRequire[] = [];
    for (const req of requires)
      assembled.push(...this.assembleRequire(req as luaparse.LocalStatement));
    const modifiedRequires: ModifiedLuaRequire[] = [];
    for (const req of assembled) {
      if (BuiltinModules.includes(req.requiredModule.replaceAll('"', ""))) continue;
      let replacedRequire = req.requiredModule.replaceAll('"', "")
      if (!replacedRequire.startsWith("/"))
        replacedRequire = `/${replacedRequire}`; 
      const modifiedString = `require("${replacedRequire}")`;
      modifiedRequires.push({
        original: req.fullString,
        replacement: modifiedString
      })
    }
    for (const modified of modifiedRequires) {
      newContent = newContent.replace(modified.original, modified.replacement);
    }
    if (this.minify)
      newContent = luamin.minify(newContent);
    return newContent;
  }

  private processFiles(channel: ProjectItem) {
    const data: SyncFile[] = [];
    const removals: { type: "deletion"; files: string[]}[] = [];
    for (const file of channel.files ?? []) {
      const fdata = fs.readFileSync(path.join(process.cwd(), this.project.rootDir, file), 'utf8');
      const processed = this.preprocess(fdata);
      data.push({
        fileData: processed,
        filePath: file
      })
    }
    const realFiles: string[] = [];
    for (const directory of channel.directories ?? []) {
      const dirpath = path.join(process.cwd(), this.project.rootDir, directory);
      const files = fs.readdirSync(dirpath, { recursive: true, encoding: "utf8" });
      for (const file of files) {
        const filepath = path.join(dirpath, file);
        const stat = fs.statSync(filepath);
        if (!stat.isFile()) continue;
        realFiles.push(path.join(directory, file));
        const fdata = fs.readFileSync(filepath, 'utf8');
        const processed = this.preprocess(fdata);
        data.push({
          fileData: processed,
          filePath: path.join(directory, file)
        })
      }
    }
    this.fileBuffered.set(channel, realFiles);
    const removed = (this.files.get(channel) ?? []).filter((v) => !realFiles.includes(v));
    if (removed.length > 0)
      removals.push({
        type: "deletion",
        files: removed
      })

    return {data, removals};
  }

  private updateFiles() {
    this.fileBuffered.forEach((v, k) => this.files.set(k, v));
  }

  private processLibrary(channel: string) {
    const pchannel = this.project.project.find((v) => v.channelName === channel);
    if (!pchannel) throw `Channel ${channel} does not exist!`;
    if (pchannel.type === "script") throw `Script channel ${channel} should not be getting processed in processLibrary!`;
    const channelRequests: SyncRequest[] = [];
    if (pchannel.requiredChannels)
      for (const required of pchannel.requiredChannels) {
        const processed = this.processLibrary(required);
        channelRequests.push(...processed);
      }
    const files = this.processFiles(pchannel);
    channelRequests.push(
      {
        files: files.data,
        type: "library"
      }
    )
    if (files.removals.length > 0)
      channelRequests.push(...files.removals);
    return channelRequests;
  }

  private processChannel(channel: string) {
    const pchannel = this.project.project.find((v) => v.channelName === channel);
    if (!pchannel) throw `Channel ${channel} does not exist!`;
    if (pchannel.type === "library") throw `Library channel ${channel} should not be getting processed in processChannel!`;
    const channelRequests: SyncRequest[] = [];
    if (pchannel.requiredChannels)
      for (const required of pchannel.requiredChannels) {
        const processed = this.runProcess(required);
        channelRequests.push(...processed);
      }
    const files = this.processFiles(pchannel);
    channelRequests.push(
      {
        files: files.data,
        type: "script"
      }
    )
    if (files.removals.length > 0)
      channelRequests.push(...files.removals);
    return channelRequests;
  }

  private runProcess(channel: string): SyncRequest[] {
    const ch = this.project.project.find((v) => v.channelName === channel);
    if (!ch) throw `Channel ${channel} does not exist!`;
    if (ch.type === "library")
      return this.processLibrary(channel);
    return this.processChannel(channel);
  }

  private getRequestsForChannel(channel: string) {
    const pchannel = this.project.project.find((v) => v.channelName === channel);
    if (!pchannel) throw `Channel ${channel} does not exist!`;
    const requests: SyncRequest[] = this.runProcess(channel);
    return requests;
  }

  private UpdateHashes() {
    let changed = false;
    for (const channel of this.getChannels()) {
      const requests = this.getRequestsForChannel(channel);
      const channelHash = hash(requests);
      const previousHash = this.channelHashes.get(channel);
      if (channelHash !== previousHash) {
        changed = true;
        this.channelHashes.set(channel, channelHash);
        this.channelsChanged.push(channel);
      }
    }
    if (changed)
      this.sendForChanged();
  }

  private sendForChanged() {
    const data: Map<string, SyncRequest[]> = new Map();
    for (const channel of this.channelsChanged) {
      const requests = this.getRequestsForChannel(channel);
      data.set(channel, requests);
    }
    this.subscribed.forEach((channels, ws) => {
      for (const channel of channels) {
        if (!data.has(channel)) continue;
        ws.send(msgpack.encode(data.get(channel)!));
      }
    })
    this.channelsChanged = [];
    this.updateFiles();
  }
}
