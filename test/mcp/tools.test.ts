import { describe, test, expect, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { HistoryStore } from "../../src/history/store.js";
import { analyzeProfile } from "../../src/core/analyzer.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

async function createTestClient(options?: { defaultSourcePath?: string; historyDir?: string }) {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

type TextContent = Array<{ type: string; text: string }>;

describe("MCP Tool: analyze_profile", () => {
  test("analyzes a sampling profile and returns JSON result", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "analyze_profile",
      arguments: { profilePath: "test/fixtures/sampling-minimal.alcpuprofile" },
    }, undefined, { timeout: 120000 });
    expect(result.content).toBeDefined();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.meta.profileType).toBe("sampling");
    expect(parsed.hotspots).toBeDefined();
    expect(parsed.patterns).toBeDefined();
  }, 120000);

  test("respects top parameter", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "analyze_profile",
      arguments: { profilePath: "test/fixtures/sampling-minimal.alcpuprofile", top: 2 },
    }, undefined, { timeout: 120000 });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.hotspots.length).toBeLessThanOrEqual(2);
  }, 120000);

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

describe("MCP Tool: get_hotspots", () => {
  test("returns limited hotspot list without patterns", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "get_hotspots",
      arguments: {
        profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
        top: 3,
      },
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.hotspots.length).toBeLessThanOrEqual(3);
    expect(parsed.patterns).toHaveLength(0);
  });
});

describe("MCP Tool: compare_profiles", () => {
  test("compares two profiles and returns deltas", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "compare_profiles",
      arguments: {
        beforePath: "test/fixtures/sampling-minimal.alcpuprofile",
        afterPath: "test/fixtures/sampling-minimal.alcpuprofile",
      },
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.meta.beforePath).toContain("sampling-minimal");
    expect(parsed.meta.afterPath).toContain("sampling-minimal");
    expect(parsed.summary.deltaTime).toBe(0);
  });
});

describe("MCP Tool: explain_method", () => {
  test("returns method details from a profile", async () => {
    const { client } = await createTestClient();

    // First get a valid method name
    const hotspotsResult = await client.callTool({
      name: "get_hotspots",
      arguments: { profilePath: "test/fixtures/sampling-minimal.alcpuprofile", top: 1 },
    });
    const hotspotsText = (hotspotsResult.content as TextContent)[0].text;
    const hotspots = JSON.parse(hotspotsText);
    const methodName = hotspots.hotspots[0].functionName;

    const result = await client.callTool({
      name: "explain_method",
      arguments: {
        profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
        method: methodName,
      },
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.method.functionName).toBe(methodName);
    expect(parsed.profileStats).toBeDefined();
    expect(parsed.calledBy).toBeDefined();
    expect(parsed.calls).toBeDefined();
  });

  test("returns error for unknown method", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "explain_method",
      arguments: {
        profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
        method: "NonExistentMethodXYZ",
      },
    });
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("not found");
    expect(result.isError).toBe(true);
  });
});

describe("MCP Tool: analyze_source", () => {
  test("indexes AL source files and returns summary", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "analyze_source",
      arguments: { sourcePath: "test/fixtures/source" },
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.files).toBeGreaterThan(0);
    expect(parsed.objects.length).toBeGreaterThan(0);
  });

  test("includes detected patterns from source-only detectors", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "analyze_source",
      arguments: { sourcePath: "test/fixtures/source" },
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.detectedPatterns).toBeDefined();
    expect(parsed.detectedPatterns.length).toBeGreaterThan(0);
  });

  test("reports structural findings for source", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "analyze_source",
      arguments: { sourcePath: "test/fixtures/source" },
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.findings.length).toBeGreaterThan(0);
  });
});

describe("MCP Tool: gate_check", () => {
  test("returns pass verdict for profile within thresholds", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "gate_check",
      arguments: {
        profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
        maxCritical: 100,
      },
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.verdict).toBe("pass");
    expect(parsed.counts).toBeDefined();
  });
});

describe("MCP Resources", () => {
  test("pattern-docs resource returns pattern documentation", async () => {
    const { client } = await createTestClient();
    const result = await client.readResource({
      uri: "resource://al-profiler/pattern-docs",
    });
    expect(result.contents).toBeDefined();
    expect(result.contents.length).toBe(1);
    const text = result.contents[0].text as string;
    expect(text).toContain("Single Method Dominance");
    expect(text).toContain("CalcFields in Loop");
  });

  test("last-analysis resource returns null when no analysis done", async () => {
    const { client } = await createTestClient();
    const result = await client.readResource({
      uri: "resource://al-profiler/last-analysis",
    });
    expect(result.contents).toBeDefined();
    const text = result.contents[0].text as string;
    const parsed = JSON.parse(text);
    expect(parsed).toBeNull();
  });

  test("last-analysis resource returns result after analyze_profile", async () => {
    const { client } = await createTestClient();

    await client.callTool({
      name: "analyze_profile",
      arguments: { profilePath: "test/fixtures/sampling-minimal.alcpuprofile" },
    }, undefined, { timeout: 120000 });

    const result = await client.readResource({
      uri: "resource://al-profiler/last-analysis",
    });
    const text = result.contents[0].text as string;
    const parsed = JSON.parse(text);
    expect(parsed).not.toBeNull();
    expect(parsed.meta.profileType).toBe("sampling");
  }, 120000);
});

describe("MCP Tool: visualize_flamegraph", () => {
  test("returns error when flamegraph service is unavailable", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "visualize_flamegraph",
      arguments: {
        profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
        serviceUrl: "http://localhost:99999",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as TextContent)[0].text;
    expect(text).toContain("Failed to connect");
  });
});

describe("MCP Tool: history_list", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true }); } catch {}
    }
  });

  test("returns empty list when no history exists", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
    const historyDir = join(tempDir, "history");
    const { client } = await createTestClient({ historyDir });
    const result = await client.callTool({
      name: "history_list",
      arguments: {},
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });

  test("returns entries when history exists", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
    const historyDir = join(tempDir, "history");

    // Pre-populate history
    const store = new HistoryStore(historyDir);
    const analysis = await analyzeProfile("test/fixtures/sampling-minimal.alcpuprofile", {
      includePatterns: true,
    });
    store.save(analysis, { label: "test-run" });

    const { client } = await createTestClient({ historyDir });
    const result = await client.callTool({
      name: "history_list",
      arguments: {},
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed[0].label).toBe("test-run");
  });

  test("filters by label", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
    const historyDir = join(tempDir, "history");

    const store = new HistoryStore(historyDir);
    const analysis = await analyzeProfile("test/fixtures/sampling-minimal.alcpuprofile", {
      includePatterns: true,
    });
    store.save(analysis, { label: "baseline" });
    store.save(analysis, { label: "optimized" });

    const { client } = await createTestClient({ historyDir });
    const result = await client.callTool({
      name: "history_list",
      arguments: { label: "baseline" },
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("baseline");
  });
});

describe("MCP Tool: history_trend", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true }); } catch {}
    }
  });

  test("returns message when less than 2 entries", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
    const historyDir = join(tempDir, "history");
    const { client } = await createTestClient({ historyDir });
    const result = await client.callTool({
      name: "history_trend",
      arguments: {},
    });
    expect(result.isError).toBeUndefined();
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.message).toContain("at least 2");
  });

  test("computes trend deltas with 2+ entries", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
    const historyDir = join(tempDir, "history");

    const store = new HistoryStore(historyDir);
    const analysis = await analyzeProfile("test/fixtures/sampling-minimal.alcpuprofile", {
      includePatterns: true,
    });
    store.save(analysis, { label: "run-1" });
    store.save(analysis, { label: "run-2" });

    const { client } = await createTestClient({ historyDir });
    const result = await client.callTool({
      name: "history_trend",
      arguments: {},
    });
    const text = (result.content as TextContent)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.entries).toBe(2);
    expect(parsed.oldest).toBeDefined();
    expect(parsed.newest).toBeDefined();
    expect(parsed.deltas).toBeDefined();
    expect(parsed.deltas.totalSelfTime).toBeDefined();
    expect(parsed.deltas.healthScore).toBeDefined();
    expect(parsed.deltas.patternCount).toBeDefined();
    expect(parsed.series).toBeDefined();
    expect(parsed.series).toHaveLength(2);
  });
});
