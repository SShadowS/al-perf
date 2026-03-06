import { describe, it, expect } from "bun:test";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import { buildDeepPayload } from "../../src/explain/deep-analyzer.js";
import type { AnalysisResult } from "../../src/output/types.js";
import type { ProcessedProfile } from "../../src/types/processed.js";

const FIXTURE = "test/fixtures/sampling-minimal.alcpuprofile";

async function loadProfile(): Promise<ProcessedProfile> {
  const parsed = await parseProfile(FIXTURE);
  return processProfile(parsed);
}

function makeResult(overrides?: Partial<AnalysisResult>): AnalysisResult {
  return {
    meta: {
      profilePath: "test.alcpuprofile",
      profileType: "sampling",
      totalDuration: 10000000,
      totalSelfTime: 10000000,
      idleSelfTime: 0,
      totalNodes: 100,
      maxDepth: 10,
      sourceAvailable: false,
      confidenceScore: 80,
      confidenceFactors: {
        sampleCount: { value: 100, score: 100 },
        duration: { value: 10, score: 80 },
        incompleteMeasurements: { value: 0, score: 100 },
      },
      analyzedAt: "2026-01-01T00:00:00Z",
    },
    summary: {
      oneLiner: "10.0s profile",
      topApp: null,
      topMethod: null,
      patternCount: { critical: 0, warning: 0, info: 0 },
      healthScore: 100,
    },
    criticalPath: [],
    hotspots: [],
    patterns: [],
    appBreakdown: [],
    objectBreakdown: [],
    ...overrides,
  };
}

describe("buildDeepPayload", () => {
  it("includes analysis and callTree, strategy is recorded", async () => {
    const profile = await loadProfile();
    const result = makeResult();

    const payload = buildDeepPayload(result, profile, "adjacency");

    expect(payload.analysis).toBeDefined();
    expect(payload.analysis.meta).toEqual(result.meta);
    expect(payload.callTree).toBeDefined();
    expect(payload.callTreeStrategy).toBe("adjacency");
  });

  it("includes source snippets when hotspots have them", async () => {
    const profile = await loadProfile();
    const result = makeResult({
      hotspots: [
        {
          functionName: "PostSalesLine",
          objectType: "CodeUnit",
          objectName: "Sales-Post",
          objectId: 80,
          appName: "Base Application",
          selfTime: 5000000,
          selfTimePercent: 50,
          totalTime: 8000000,
          totalTimePercent: 80,
          hitCount: 100,
          calledBy: [],
          calls: [],
          costPerHit: 50000,
          efficiencyScore: 0.625,
          sourceLocation: {
            filePath: "src/codeunit/SalesPost.al",
            lineStart: 10,
            lineEnd: 50,
          },
          sourceSnippet: "procedure PostSalesLine()\nbegin\n  // code\nend;",
        },
      ],
    });

    const payload = buildDeepPayload(result, profile, "pruned");

    expect(payload.sourceSnippets).toBeDefined();
    expect(payload.sourceSnippets).toHaveLength(1);
    expect(payload.sourceSnippets![0].method).toBe("PostSalesLine");
    expect(payload.sourceSnippets![0].file).toBe("src/codeunit/SalesPost.al");
    expect(payload.sourceSnippets![0].lineStart).toBe(10);
    expect(payload.sourceSnippets![0].lineEnd).toBe(50);
    expect(payload.sourceSnippets![0].source).toContain("PostSalesLine");
    expect(payload.callTreeStrategy).toBe("pruned");
  });

  it("omits source snippets when no hotspots have them", async () => {
    const profile = await loadProfile();
    const result = makeResult({
      hotspots: [
        {
          functionName: "SomeMethod",
          objectType: "CodeUnit",
          objectName: "MyUnit",
          objectId: 50000,
          appName: "My App",
          selfTime: 1000000,
          selfTimePercent: 10,
          totalTime: 2000000,
          totalTimePercent: 20,
          hitCount: 50,
          calledBy: [],
          calls: [],
          costPerHit: 20000,
          efficiencyScore: 0.5,
          // No sourceLocation or sourceSnippet
        },
      ],
    });

    const payload = buildDeepPayload(result, profile, "chains");

    expect(payload.sourceSnippets).toBeUndefined();
    expect(payload.callTreeStrategy).toBe("chains");
  });
});
