#!/usr/bin/env node
// stdout is the MCP protocol channel. Nothing in this process may write to stdout except the transport.
import "./lib/config.js"; // loads .env with dotenv quiet:true
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { tools } from "./tools/index.js";
import { toToolResult, fromException } from "./lib/envelope.js";
import { log } from "./lib/log.js";

const server = new McpServer({ name: "prep-bob-client-profile", version: "0.1.0" });

for (const t of tools) {
  server.registerTool(
    t.definition.name,
    { description: t.definition.description, inputSchema: t.definition.inputSchema },
    async (args) => {
      try {
        return toToolResult(await t.handler(args ?? {}));
      } catch (e) {
        log.error("tool failed", { tool: t.definition.name, error: e instanceof Error ? e.message : String(e) });
        return toToolResult(fromException(e));
      }
    }
  );
}

process.on("unhandledRejection", (e) => log.error("unhandled rejection", { error: e instanceof Error ? e.message : String(e) }));

const transport = new StdioServerTransport();
await server.connect(transport);
log.info("prep-bob-client-profile MCP server running on stdio", { tools: tools.length });
