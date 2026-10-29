// Spawns the server, sends initialize + tools/list + one tool call, and verifies every stdout line is JSON-RPC.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = spawn(process.execPath, [path.join(root, "src", "server.js")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
let out = "";
p.stdout.on("data", (d) => (out += d));
const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "0" } } });
setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "feedback", arguments: { action: "read" } } });
}, 500);
setTimeout(() => {
  p.kill();
  const lines = out.split("\n").filter(Boolean);
  const bad = lines.filter((l) => { try { return JSON.parse(l).jsonrpc !== "2.0"; } catch { return true; } });
  console.log(`stdout lines: ${lines.length}; non-JSON-RPC lines: ${bad.length}`);
  process.exit(bad.length === 0 && lines.length >= 3 ? 0 : 1);
}, 2500);
