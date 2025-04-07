import express from "express";
import expressWs from "express-ws";
import path from "path";
import fs from "fs";
import chokidar from "chokidar"
import WebSocket from "ws";
import * as lua from "luamin";
import bundler from "luabundle";
import { fileURLToPath } from "url";
const __dirname = path.dirname(decodeURIComponent(fileURLToPath(import.meta.url)));

const luamin = lua.default;

type ProjectJsonDes = {
  [channelName: string]: string[];
}

const cwd = process.cwd();
const fileJsonPath = path.resolve(cwd, "project.json");
if (!fileJsonPath) {
  console.error("No project.json found!");
  process.exit(1);
}

const channelsRequiringChange: { [channel: string]: boolean} = {}

const channels = JSON.parse(fs.readFileSync(fileJsonPath, { encoding: "utf8" })) as ProjectJsonDes;

const channelClients: { [channel: string]: WebSocket[] } = {};

function bundleChannel(channel: string) {
  const files = channels[channel].map((v) => path.resolve(cwd, "build", v));
  const mappedFiles: string[] = [];
  for (const file of files) {
    const stat = fs.statSync(file);
    if (stat.isFile()) {
      mappedFiles.push(file);
    }
    else {
      const read = fs.readdirSync(file, { encoding: "utf8", recursive: true });
      for (const rfile of read) {
        const resolved = path.resolve(file, rfile);
        const stat = fs.statSync(resolved);
        if (stat.isFile())
          mappedFiles.push(resolved);
      }
    }
  }
  const mainFile = mappedFiles.find((v) => v.endsWith("main.lua"));
  return bundler.bundle(mainFile, {
    resolveModule: (name) => {
      for (const file of mappedFiles) {
        if (file.replace(".lua", "").endsWith(name.replace(/\./g, "/")))
          return file
      }
      return null;
    },
    ignoredModuleNames: [
      "cc.audio.dfpwm",
      "cc.completion",
      "cc.expect",
      "cc.image.nft",
      "cc.pretty",
      "cc.require",
      "cc.shell.completion",
      "cc.strings"
    ]
  })
}

function sendFileData(channel: string) {
  console.log(`change detected for channel ${channel}`)
  channelsRequiringChange[channel] = false;
  const bundled = bundleChannel(channel);
  const sending = {
    event: "change",
    filePath: `${channel}.lua`,
    data: bundled
  }
  const clients = channelClients[channel];
  for (const client of clients)
    client.send(JSON.stringify(sending));
}

for (const channel in channels) {
  channelsRequiringChange[channel] = false;
  channelClients[channel] = [];
  const ch = channels[channel];
  for (const file of ch) {
    const resolved = path.resolve(cwd, "build", file.startsWith("/") ? file.slice(1) : file);
    chokidar.watch(resolved).on("add", (pth) => {
      console.log(pth);
      channelsRequiringChange[channel] = true;
    }).on("change", (pth) => {
      channelsRequiringChange[channel] = true;
    }).on("unlink", (pth) => {
      channelsRequiringChange[channel] = true;
    })
  }
}

setInterval(() => {
  for (const channel in channelsRequiringChange) {
    if (channelsRequiringChange[channel]) {
      sendFileData(channel);
    }
  }
}, 200);

const app = express() as Express.Application as expressWs.Application;
const exWs = expressWs(app);

app.get("/channels", (req, res) => {
  res.send(Object.keys(channels).join(","));
})

app.get("/sync.lua", (req, res) => {
  const file = path.resolve(__dirname, "..", "..", "ingame-client", "sync.lua")
  const minified = luamin.minify(fs.readFileSync(file, "utf8"));
  res.send(minified);
})

for (const channel in channels) {
  app.ws(`/channels/${channel}`, (socket) => {
    console.log(`new connection on channel ${channel}`);
    console.log("setting up bulk data send");
    const data = bundleChannel(channel) as string;
    setTimeout(() => {
      console.log(`sending bulk data for ${channel}.lua`);
      socket.send(JSON.stringify({
        event: "change",
        filePath: `${channel}.lua`,
        data
      }))
    }, 200);
    channelClients[channel].push(socket as WebSocket);
  })
}

app.listen(10234, () => {
  console.log("listening on port 10234")
})
