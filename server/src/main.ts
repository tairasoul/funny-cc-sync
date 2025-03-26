import express from "express";
import expressWs from "express-ws";
import path from "path";
import fs from "fs";
import chokidar from "chokidar"
import WebSocket from "ws";
import * as lua from "luamin";

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

const channels = JSON.parse(fs.readFileSync(fileJsonPath, { encoding: "utf8" })) as ProjectJsonDes;

const channelClients: { [channel: string]: WebSocket[] } = {};

type sendingData = {
  event: "change";
  filePath: string;
  data: string;
} | {
  event: "remove";
  filePath: string;
}

function sendFileData(filePath: string, channel: string, file: string) {
  const f = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  const resolved = path.resolve(cwd, "build", f);
  const data = luamin.minify(fs.readFileSync(resolved, "utf8").trim()) as string;
  const sending = {
    event: "change",
    filePath: filePath.startsWith(file) ? filePath : `${file}/${filePath}`,
    data: data
  }
  const clients = channelClients[channel];
  for (const client of clients)
    client.send(JSON.stringify(sending));
}

function fileRemoval(filePath: string, channel: string, file: string) {
  const sending = {
    event: "remove",
    filePath: filePath.startsWith(file) ? filePath : `${file}/${filePath}`
  }
  const clients = channelClients[channel];
  for (const client of clients)
    client.send(JSON.stringify(sending));
}

const channelInitialConnects: { [channel: string]: (() => sendingData[])[] } = {};

for (const channel in channels) {
  channelClients[channel] = [];
  channelInitialConnects[channel] = [];
  const ch = channels[channel];
  for (const file of ch) {
    const resolved = path.resolve(cwd, "build", file.startsWith("/") ? file.slice(1) : file);
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      channelInitialConnects[channel].push(() => {
        const f = file.startsWith("/") ? file.slice(1) : file;
        const resolved = path.resolve(cwd, "build", f);
        const data = fs.readFileSync(resolved, "utf8").trim();
        const sending: sendingData = {
          event: "change",
          filePath: `${f}`,
          data: luamin.minify(data) as string
        }
        return [sending];
      })
      chokidar.watch(resolved).on("change", (pth) => {
        const toRemove = path.resolve(cwd, "build", file);
        const removed = pth.replace(toRemove, "");
        sendFileData(removed, channel, file);
      }).on("unlink", (pth) => {
        const toRemove = path.resolve(cwd, "build", file);
        const removed = pth.replace(toRemove, "");
        fileRemoval(removed, channel, file);
      })
    }
    else if (stat.isDirectory()) {
      channelInitialConnects[channel].push(() =>  {
        const toRemove = path.resolve(cwd, "build");
        const children = fs.readdirSync(resolved, { recursive: true, encoding: "utf8" }).filter((v) => fs.statSync(path.resolve(toRemove, file.startsWith("/") ? file.slice(1) : file, v)).isFile()).map((v) => v.replace(toRemove, ""));
        const ret: sendingData[] = []
        for (const child of children) {
          const f = child.startsWith("/") ? child.slice(1) : child;
          const resolved = path.resolve(cwd, "build", file.startsWith("/") ? file.slice(1) : file, f);
          const data = fs.readFileSync(resolved, "utf8").trim();
          const sending: sendingData = {
            event: "change",
            filePath: `${file}/${f}`,
            data: luamin.minify(data) as string
          }
          ret.push(sending);
        }
        return ret;
      })
      chokidar.watch(resolved).on("add", (pth) => {
        const toRemove = path.resolve(cwd, "build");
        const removed = pth.replace(toRemove, "");
        sendFileData(removed, channel, file);
      }).on("change", (pth) => {
        const toRemove = path.resolve(cwd, "build");
        const removed = pth.replace(toRemove, "");
        sendFileData(removed, channel, file);
      }).on("unlink", (pth) => {
        const toRemove = path.resolve(cwd, "build");
        const removed = pth.replace(toRemove, "");
        fileRemoval(removed, channel, file);
      })
    }
  }
}

const app = express() as Express.Application as expressWs.Application;
const exWs = expressWs(app);

app.get("/channels", (req, res) => {
  res.send(Object.keys(channels).join(","));
})

for (const channel in channels) {
  app.ws(`/channels/${channel}`, (socket) => {
    console.log(`new connection on channel ${channel}`);
    const data: sendingData[] = [];
    console.log("setting up bulk data send");
    for (const initialConnect of channelInitialConnects[channel])
      data.push(...initialConnect());
    setTimeout(() => {
      socket.send(JSON.stringify(
        {
          event: "bulk",
          data
        }
      ))
    }, 1000)
    channelClients[channel].push(socket as WebSocket);
  })
}

app.listen(10234, () => {
  console.log("listening on port 10234")
})
