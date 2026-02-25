import { describe, test, expect } from "bun:test";
import { createMcpServer } from "../../src/mcp/server.js";

describe("MCP Server", () => {
  test("createMcpServer returns an McpServer instance", () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });

  test("createMcpServer accepts defaultSourcePath option", () => {
    const server = createMcpServer({ defaultSourcePath: "/some/path" });
    expect(server).toBeDefined();
  });
});
