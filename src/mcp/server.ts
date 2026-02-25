import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface McpServerOptions {
  defaultSourcePath?: string;
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const server = new McpServer({
    name: "al-profiler",
    version: "0.1.0",
  });
  // Tools and resources will be registered in subsequent tasks
  return server;
}
