import { describe, test, expect } from "bun:test";
import { trimResultForPrompt, SYSTEM_PROMPT } from "../../src/explain/explainer.js";
import type { AnalysisResult } from "../../src/output/types.js";

function makeResult(overrides?: Partial<AnalysisResult>): AnalysisResult {
  return {
    meta: {
      profilePath: "test.alcpuprofile",
      profileType: "sampling",
      totalDuration: 10000000,
      totalSelfTime: 10000000,
      totalNodes: 100,
      maxDepth: 10,
      sourceAvailable: false,
      analyzedAt: "2026-01-01T00:00:00Z",
    },
    summary: {
      oneLiner: "10.0s profile, 50.0% in TestMethod",
      topApp: { name: "Test App", percent: 50 },
      topMethod: { name: "TestMethod", object: "CodeUnit 50100", percent: 50 },
      patternCount: { critical: 1, warning: 2, info: 0 },
    },
    hotspots: [],
    patterns: [],
    appBreakdown: [],
    objectBreakdown: [],
    ...overrides,
  };
}

describe("trimResultForPrompt", () => {
  test("includes meta and summary", () => {
    const result = makeResult();
    const trimmed = trimResultForPrompt(result);
    expect(trimmed.meta).toEqual(result.meta);
    expect(trimmed.summary).toEqual(result.summary);
  });

  test("limits hotspots to 10", () => {
    const hotspots = Array.from({ length: 20 }, (_, i) => ({
      functionName: `Method${i}`,
      objectType: "CodeUnit",
      objectName: `Test ${i}`,
      objectId: 50100 + i,
      appName: "Test App",
      selfTime: 1000 - i * 10,
      selfTimePercent: 5,
      totalTime: 2000,
      totalTimePercent: 10,
      hitCount: 1,
      calledBy: [],
      calls: [],
    }));
    const result = makeResult({ hotspots });
    const trimmed = trimResultForPrompt(result);
    expect(trimmed.hotspots.length).toBe(10);
    expect(trimmed.totalHotspots).toBe(20);
  });

  test("limits patterns to 15", () => {
    const patterns = Array.from({ length: 30 }, (_, i) => ({
      id: `pattern-${i}`,
      severity: "critical" as const,
      title: `Pattern ${i}`,
      description: `Description ${i}`,
      impact: 1000 - i * 10,
      involvedMethods: [],
      evidence: `Evidence ${i}`,
      suggestion: `Fix ${i}`,
    }));
    const result = makeResult({ patterns });
    const trimmed = trimResultForPrompt(result);
    expect(trimmed.patterns.length).toBe(15);
    expect(trimmed.totalPatterns).toBe(30);
  });

  test("includes all app breakdown entries", () => {
    const appBreakdown = [
      { appName: "App A", appPublisher: "P", selfTime: 5000, selfTimePercent: 50, totalTime: 8000, nodeCount: 10, methods: [] },
      { appName: "App B", appPublisher: "P", selfTime: 3000, selfTimePercent: 30, totalTime: 5000, nodeCount: 5, methods: [] },
    ];
    const result = makeResult({ appBreakdown });
    const trimmed = trimResultForPrompt(result);
    expect(trimmed.appBreakdown.length).toBe(2);
  });

  test("excludes objectBreakdown", () => {
    const result = makeResult();
    const trimmed = trimResultForPrompt(result);
    expect((trimmed as any).objectBreakdown).toBeUndefined();
  });
});

describe("SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  test("mentions Business Central", () => {
    expect(SYSTEM_PROMPT).toContain("Business Central");
  });
});
