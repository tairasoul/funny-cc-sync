import fs from "fs";
import express from "express";
import expressWs from "express-ws";
import path from "path";
import process from "process";
import luaparse from "luaparse";
import msgpack from "@msgpack/msgpack";
import hash from "hash-it";
import bundler from "luabundle";
import * as lua from "luamin";
const luamin = lua.default;
const BuiltinModules = [
    "cc.audio.dfpwm",
    "cc.completion",
    "cc.expect",
    "cc.image.nft",
    "cc.pretty",
    "cc.require",
    "cc.shell.completion",
    "cc.strings"
];
export class SyncServer {
    port;
    project;
    server;
    channelsChanged = [];
    channelHashes = new Map();
    subscribed = new Map();
    files = new Map();
    fileBuffered = new Map();
    latestMessage = new Map();
    requestCount = new Map();
    luaRoot;
    minify;
    constructor(port, projectPath, luaFilesDir, minify = false) {
        this.port = port;
        this.minify = minify;
        this.luaRoot = luaFilesDir;
        this.project = JSON.parse(fs.readFileSync(path.join(process.cwd(), projectPath), 'utf8'));
        const expr = express();
        this.server = expressWs(expr).app;
    }
    setup() {
        this.server.get("/", (req, res) => {
            const channels = [];
            for (const channel of this.project.project)
                channels.push({ channel: channel.channelName, type: channel.type });
            res.send(Buffer.from(msgpack.encode(channels)).toString("base64"));
        });
        this.server.ws("/subscribe", (ws) => {
            ws.once("message", (data, binary) => {
                const decode = Buffer.from(data, "base64");
                const uint = new Uint8Array(decode);
                const decoded = msgpack.decode(uint);
                this.latestMessage.set(ws, data);
                decoded.channels = decoded.channels.filter((v) => this.project.project.find((b) => b.channelName === v));
                if (decoded.channels.length === 0) {
                    ws.close();
                    this.latestMessage.delete(ws);
                    return;
                }
                this.requestCount.set(ws, -1);
                this.subscribed.set(ws, decoded.channels);
                this.newSubscription(ws);
                ws.once("close", () => this.subscribed.delete(ws));
                ws.on("message", (data) => {
                    this.latestMessage.set(ws, data);
                });
            });
        });
        setInterval(() => {
            this.UpdateHashes();
        }, 500);
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
        });
        this.server.listen(this.port, () => {
            console.log(`hosting sync server on port ${this.port}`);
        });
    }
    waitForVariableToBe(value, variableGetter, checkInterval = 100) {
        return new Promise((resolve) => {
            const interval = setInterval(() => {
                if (variableGetter() === value) {
                    clearInterval(interval);
                    resolve();
                }
            }, checkInterval);
        });
    }
    async newSubscription(ws) {
        const subscribedChannels = this.subscribed.get(ws);
        for (const channel of subscribedChannels) {
            const requests = this.getRequestsForChannel(channel);
            for (const request of requests) {
                const requestCount = this.requestCount.get(ws);
                await this.waitForVariableToBe(`waiting${requestCount + 1}`, () => this.latestMessage.get(ws), 1);
                this.requestCount.set(ws, requestCount + 1);
                ws.send(msgpack.encode(request));
            }
        }
    }
    getChannels() {
        const channels = [];
        for (const item of this.project.project)
            channels.push(item.channelName);
        return channels;
    }
    assembleRequire(statement) {
        const requires = [];
        for (const expr of statement.init) {
            if (expr.type !== "CallExpression")
                continue;
            if (expr.base.type !== "Identifier")
                continue;
            if (expr.base.name !== "require")
                continue;
            let string = "require(";
            const module = expr.arguments[0];
            if (module.type !== "StringLiteral")
                continue;
            string += module.raw;
            string += ")";
            requires.push({
                fullString: string,
                requiredModule: module.raw.replaceAll('"', "")
            });
        }
        return requires;
    }
    preprocess(content) {
        let newContent = content;
        const ast = luaparse.parse(newContent, { luaVersion: "5.2" });
        const requires = ast.body.filter((v) => v.type === "LocalStatement" && v.init.filter((v) => v.type === "CallExpression").find((v) => v.base.type === "Identifier" && v.base.name === "require"));
        const assembled = [];
        for (const req of requires)
            assembled.push(...this.assembleRequire(req));
        const modifiedRequires = [];
        for (const req of assembled) {
            if (BuiltinModules.includes(req.requiredModule.replaceAll('"', "")))
                continue;
            let replacedRequire = req.requiredModule.replaceAll('"', "");
            if (!replacedRequire.startsWith("/"))
                replacedRequire = `/${replacedRequire}`;
            const modifiedString = `require("${replacedRequire}")`;
            modifiedRequires.push({
                original: req.fullString,
                replacement: modifiedString
            });
        }
        for (const modified of modifiedRequires) {
            newContent = newContent.replace(modified.original, modified.replacement);
        }
        if (this.minify)
            newContent = luamin.minify(newContent);
        return newContent;
    }
    splitStringIntoChunks(str, chunkSize) {
        const encoder = new TextEncoder();
        const encoded = encoder.encode(str);
        const chunks = [];
        for (let i = 0; i < encoded.length; i += chunkSize) {
            const chunk = encoded.slice(i, i + chunkSize);
            const decodedChunk = new TextDecoder().decode(chunk);
            chunks.push(decodedChunk);
        }
        return chunks;
    }
    processFiles(channel) {
        const data = [];
        for (const file of channel.files ?? []) {
            const fdata = fs.readFileSync(path.join(process.cwd(), this.project.rootDir, file), 'utf8');
            const processed = this.preprocess(fdata);
            const chunks = this.splitStringIntoChunks(processed, 50 * 1000);
            data.push({
                type: channel.type,
                fileData: chunks[0],
                filePath: file
            });
            if (chunks.length > 1) {
                for (let i = 1; i < chunks.length; i++)
                    data.push({
                        type: "chunk",
                        fileData: chunks[i],
                        filePath: file
                    });
            }
            /*data.push({
              type: channel.type,
              fileData: processed,
              filePath: file
            })*/
        }
        const realFiles = [];
        for (const directory of channel.directories ?? []) {
            const dirpath = path.join(process.cwd(), this.project.rootDir, directory);
            const files = fs.readdirSync(dirpath, { recursive: true, encoding: "utf8" });
            for (const file of files) {
                const filepath = path.join(dirpath, file);
                const stat = fs.statSync(filepath);
                if (!stat.isFile())
                    continue;
                realFiles.push(path.join(directory, file));
                const fdata = fs.readFileSync(filepath, 'utf8');
                const processed = this.preprocess(fdata);
                const chunks = this.splitStringIntoChunks(processed, 25 * 1000);
                data.push({
                    type: channel.type,
                    fileData: chunks[0],
                    filePath: path.join(directory, file)
                });
                if (chunks.length > 1) {
                    for (let i = 1; i < chunks.length; i++)
                        data.push({
                            type: "chunk",
                            fileData: chunks[i],
                            filePath: path.join(directory, file)
                        });
                }
                /*data.push({
                  type: channel.type,
                  fileData: processed,
                  filePath: path.join(directory, file)
                })*/
            }
        }
        this.fileBuffered.set(channel, realFiles);
        const removed = (this.files.get(channel) ?? []).filter((v) => !realFiles.includes(v));
        if (removed.length > 0)
            data.push({
                type: "deletion",
                files: removed
            });
        return data;
    }
    updateFiles() {
        this.fileBuffered.forEach((v, k) => this.files.set(k, v));
    }
    processLibrary(channel) {
        const pchannel = this.project.project.find((v) => v.channelName === channel);
        if (!pchannel)
            throw `Channel ${channel} does not exist!`;
        if (pchannel.type === "script")
            throw `Script channel ${channel} should not be getting processed in processLibrary!`;
        const channelRequests = [];
        if (pchannel.requiredChannels)
            for (const required of pchannel.requiredChannels) {
                const processed = this.processLibrary(required);
                channelRequests.push(...processed);
            }
        const files = this.processFiles(pchannel);
        channelRequests.push(...files);
        return channelRequests;
    }
    processChannel(channel) {
        const pchannel = this.project.project.find((v) => v.channelName === channel);
        if (!pchannel)
            throw `Channel ${channel} does not exist!`;
        if (pchannel.type === "library")
            throw `Library channel ${channel} should not be getting processed in processChannel!`;
        const channelRequests = [];
        if (pchannel.requiredChannels)
            for (const required of pchannel.requiredChannels) {
                const processed = this.runProcess(required);
                channelRequests.push(...processed);
            }
        const files = this.processFiles(pchannel);
        channelRequests.push(...files);
        return channelRequests;
    }
    runProcess(channel) {
        const ch = this.project.project.find((v) => v.channelName === channel);
        if (!ch)
            throw `Channel ${channel} does not exist!`;
        if (ch.type === "library")
            return this.processLibrary(channel);
        return this.processChannel(channel);
    }
    getRequestsForChannel(channel) {
        const pchannel = this.project.project.find((v) => v.channelName === channel);
        if (!pchannel)
            throw `Channel ${channel} does not exist!`;
        const requests = this.runProcess(channel);
        return requests;
    }
    async UpdateHashes() {
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
            await this.sendForChanged();
    }
    async sendForChanged() {
        const data = new Map();
        for (const channel of this.channelsChanged) {
            const requests = this.getRequestsForChannel(channel);
            data.set(channel, requests);
        }
        const promises = [];
        this.subscribed.forEach((channels, ws) => {
            promises.push(new Promise(async (resolve) => {
                for (const channel of channels) {
                    if (!data.has(channel))
                        continue;
                    const requests = data.get(channel);
                    for (const request of requests) {
                        const requestCount = this.requestCount.get(ws);
                        await this.waitForVariableToBe(`request${requestCount + 1}`, () => this.latestMessage.get(ws), 1);
                        this.requestCount.set(ws, requestCount + 1);
                        ws.send(msgpack.encode(request));
                    }
                }
                resolve();
            }));
        });
        await Promise.all(promises);
        this.channelsChanged = [];
        this.updateFiles();
    }
}
