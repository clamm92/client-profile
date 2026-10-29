// Verifies tool discovery over real MCP stdio and that stdout carries only protocol messages.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "server.js")], cwd: root, stderr: "pipe" });

// Count raw stdout lines that are not JSON-RPC, by tapping the transport's message stream.
let stderrBytes = 0;
transport.stderr?.on("data", (d) => (stderrBytes += d.length));
let badLines = 0;
const origOnError = transport.onerror;
transport.onerror = (e) => {
  badLines++;
  console.error("Non-protocol stdout detected:", e.message);
  origOnError?.(e);
};

const client = new Client({ name: "list-tools", version: "0.1.0" });
await client.connect(transport);
const { tools } = await client.listTools();
for (const t of tools) {
  const d = t.description || "";
  const ok = ["WHAT:", "WHEN TO USE:", "PARAMETERS:", "RETURNS:"].every((k) => d.includes(k));
  console.log(`${ok ? "OK " : "BAD"} ${t.name}`);
}
console.log(`\n${tools.length} tools discovered over MCP stdio.`);
console.log(`stdout non-protocol lines: ${badLines}; server log bytes on stderr: ${stderrBytes}`);
await client.close();
process.exit(badLines === 0 && tools.length > 0 ? 0 : 1);
