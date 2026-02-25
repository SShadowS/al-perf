#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

// Parse --source/-s flag from argv
function parseArgs(): { defaultSourcePath?: string } {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--source" || args[i] === "-s") && i + 1 < args.length) {
      return { defaultSourcePath: args[i + 1] };
    }
  }
  return {};
}

const opts = parseArgs();
const server = createMcpServer(opts);
const transport = new StdioServerTransport();
await server.connect(transport);
