/*import { readFileSync } from "fs";
import luaparse from "luaparse";
import util from "util";

const ast = luaparse.parse(readFileSync("/home/eva/development/computercraft/sync/ingame-client/sync.lua", 'utf8'))
console.log(util.inspect(ast, false, 20));*/ 
import msgpack from "@msgpack/msgpack";

let str = "hello yes hi"

for (let i = 0; i < 2000; i++) {
  str += `hello${i}yes${i}hi`;
}

const a = msgpack.encode(str);
console.log(a);
console.log(msgpack.decode(a));
