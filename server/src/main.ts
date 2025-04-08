import { readFileSync } from "fs";
import { SyncServer } from "./classes/server.js";
import path from "path";
import ngrok from "ngrok";
import { fileURLToPath } from "url";
const __dirname = path.dirname(decodeURIComponent(fileURLToPath(import.meta.url)));

const cfg = path.join(process.cwd(), "config.json");

type Config = {
  port: number;
  minify: boolean;
  ngrok: boolean;
}

const config: Config = JSON.parse(readFileSync(cfg, 'utf8'));

const server = new SyncServer(config.port, "project.json", path.join(__dirname, "..", "..", "ingame-client"), config.minify);

server.setup();

if (config.ngrok) {
  const url = await ngrok.connect({
    proto: "tcp",
    addr: config.port
  });
  console.log(`ngrok url: ${url.replace("tcp://", "")}`)
}
