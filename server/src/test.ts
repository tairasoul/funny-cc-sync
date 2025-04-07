import { SyncServer } from "./classes/server.js";

const server = new SyncServer(10234, "project.json", "/home/eva/development/computercraft/sync/ingame-client/");

server.setup();
