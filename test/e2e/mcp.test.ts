import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";

type TextContent = Array<{ type: string; text: string }>;

describe("MCP E2E", () => {
  test("server lists all 8 tools", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "e2e-test", version: "1.0.0" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("analyze_profile");
    expect(toolNames).toContain("get_hotspots");
    expect(toolNames).toContain("compare_profiles");
    expect(toolNames).toContain("explain_method");
    expect(toolNames).toContain("analyze_source");
    expect(toolNames).toContain("gate_check");
    expect(toolNames).toContain("drilldown_method");
    expect(toolNames).toContain("visualize_flamegraph");
    expect(toolNames).toHaveLength(8);
  });

  test("server lists 2 resources", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "e2e-test", version: "1.0.0" });
    await client.connect(clientTransport);

    const resources = await client.listResources();
    expect(resources.resources.length).toBe(2);
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain("resource://al-profiler/pattern-docs");
    expect(uris).toContain("resource://al-profiler/last-analysis");
  });

  test("full workflow: analyze then explain a hotspot", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "e2e-test", version: "1.0.0" });
    await client.connect(clientTransport);

    // 1. Analyze
    const analyzeResult = await client.callTool({
      name: "analyze_profile",
      arguments: {
        profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
        top: 3,
      },
    });

    const analysisText = (analyzeResult.content as TextContent)[0].text;
    const analysis = JSON.parse(analysisText);
    expect(analysis.hotspots.length).toBeGreaterThan(0);

    // 2. Explain the top hotspot
    const topMethod = analysis.hotspots[0].functionName;
    const explainResult = await client.callTool({
      name: "explain_method",
      arguments: {
        profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
        method: topMethod,
      },
    });

    const explainText = (explainResult.content as TextContent)[0].text;
    const explanation = JSON.parse(explainText);
    expect(explanation.method.functionName).toBe(topMethod);

    // 3. Check last-analysis resource was updated
    const lastResult = await client.readResource({
      uri: "resource://al-profiler/last-analysis",
    });
    const lastText = lastResult.contents[0].text as string;
    const lastAnalysis = JSON.parse(lastText);
    expect(lastAnalysis).not.toBeNull();
    expect(lastAnalysis.meta.profileType).toBe("sampling");
  });

  test("analyze with defaultSourcePath option", async () => {
    const server = createMcpServer({ defaultSourcePath: "test/fixtures/source" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "e2e-test", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "analyze_profile",
      arguments: {
        profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
      },
    });

    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.meta.sourceAvailable).toBe(true);
  });
});
