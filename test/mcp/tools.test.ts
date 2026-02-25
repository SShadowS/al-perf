import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";

async function createTestClient(options?: { defaultSourcePath?: string }) {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("MCP Tool: analyze_profile", () => {
  test("analyzes a sampling profile and returns JSON result", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "analyze_profile",
      arguments: { profilePath: "test/fixtures/sampling-minimal.alcpuprofile" },
    });
    expect(result.content).toBeDefined();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.meta.profileType).toBe("sampling");
    expect(parsed.hotspots).toBeDefined();
    expect(parsed.patterns).toBeDefined();
  });

  test("respects top parameter", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "analyze_profile",
      arguments: { profilePath: "test/fixtures/sampling-minimal.alcpuprofile", top: 2 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.hotspots.length).toBeLessThanOrEqual(2);
  });

  test("returns error for non-existent file", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "analyze_profile",
      arguments: { profilePath: "non-existent.alcpuprofile" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Error");
    expect(result.isError).toBe(true);
  });
});
