import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { analyzeBatch, aggregateResults, isSelfReferentialProfile } from "../../src/core/batch-analyzer.js";
import type { ProfileMetadata } from "../../src/types/batch.js";
import type { AnalysisResult } from "../../src/output/types.js";

const BATCH_DIR = resolve(import.meta.dir, "../fixtures/batch");

describe("analyzeBatch", () => {
  it("analyzes multiple profiles and produces aggregate result", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    expect(result.meta.profileCount).toBe(2);
    expect(result.profiles).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.summary.oneLiner).toBeTruthy();
    expect(result.summary.overallHealthScore).toBeGreaterThanOrEqual(0);
    expect(result.summary.overallHealthScore).toBeLessThanOrEqual(100);
    expect(result.activityBreakdown).toHaveLength(2);
    expect(result.cumulativeHotspots.length).toBeGreaterThan(0);
    expect(result.appBreakdown.length).toBeGreaterThan(0);
  });

  it("includes metadata when manifest is provided", async () => {
    const manifest: ProfileMetadata[] = JSON.parse(
      await Bun.file(resolve(BATCH_DIR, "manifest.json")).text()
    );

    const result = await analyzeBatch(
      [
        resolve(BATCH_DIR, "profile-1.alcpuprofile"),
        resolve(BATCH_DIR, "profile-2.alcpuprofile"),
      ],
      { metadata: manifest }
    );

    expect(result.activityBreakdown[0].metadata).toBeDefined();
    expect(result.meta.activityTypes["WebClient"]).toBe(1);
    expect(result.meta.activityTypes["Background"]).toBe(1);
    expect(result.meta.timeRange).not.toBeNull();
  });

  it("handles partial failures gracefully", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "nonexistent.alcpuprofile"),
    ]);

    expect(result.meta.profileCount).toBe(1);
    expect(result.profiles).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].profilePath).toContain("nonexistent");
  });

  it("fails entirely when zero profiles succeed", async () => {
    await expect(
      analyzeBatch([resolve(BATCH_DIR, "nonexistent.alcpuprofile")])
    ).rejects.toThrow();
  });

  it("handles single-profile batch", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
    ]);

    expect(result.meta.profileCount).toBe(1);
    expect(result.profiles).toHaveLength(1);
    expect(result.cumulativeHotspots.length).toBeGreaterThan(0);
  });
});

function makeStubResult(hotspots: Array<{ functionName: string; objectName: string }>): AnalysisResult {
  return {
    meta: {
      profilePath: "stub.alcpuprofile",
      profileType: "sampling",
      totalDuration: 1000,
      totalSelfTime: 1000,
      idleSelfTime: 0,
      totalNodes: 10,
      maxDepth: 3,
      sourceAvailable: false,
      confidenceScore: 80,
      confidenceFactors: {
        sampleCount: { value: 100, score: 80 },
        duration: { value: 1000, score: 80 },
        incompleteMeasurements: { value: 0, score: 100 },
      },
      analyzedAt: new Date().toISOString(),
    },
    summary: {
      oneLiner: "stub",
      topApp: null,
      topMethod: null,
      patternCount: { critical: 0, warning: 0, info: 0 },
      healthScore: 80,
    },
    criticalPath: [],
    hotspots: hotspots.map((h) => ({
      functionName: h.functionName,
      objectType: "Codeunit",
      objectName: h.objectName,
      objectId: 1,
      appName: "Test App",
      selfTime: 500,
      selfTimePercent: 50,
      totalTime: 500,
      totalTimePercent: 50,
      hitCount: 10,
      calledBy: [],
      calls: [],
    })),
    patterns: [],
    appBreakdown: [],
    objectBreakdown: [],
  };
}

describe("isSelfReferentialProfile", () => {
  it("detects profiles with 'al perf' in objectName", () => {
    const result = makeStubResult([
      { functionName: "SomeMethod", objectName: "AL Perf Analyzer" },
    ]);
    expect(isSelfReferentialProfile(result)).toBe(true);
  });

  it("detects profiles with 'analyzebatch' in functionName", () => {
    const result = makeStubResult([
      { functionName: "AnalyzeBatch", objectName: "SomeCodeunit" },
    ]);
    expect(isSelfReferentialProfile(result)).toBe(true);
  });

  it("detects profiles with 'analyzeprofile' in functionName", () => {
    const result = makeStubResult([
      { functionName: "RunAnalyzeProfile", objectName: "SomeCodeunit" },
    ]);
    expect(isSelfReferentialProfile(result)).toBe(true);
  });

  it("returns false for normal profiles", () => {
    const result = makeStubResult([
      { functionName: "PostSalesOrder", objectName: "Sales-Post" },
      { functionName: "FindSet", objectName: "Item Ledger Entry" },
    ]);
    expect(isSelfReferentialProfile(result)).toBe(false);
  });

  it("returns false for profiles with no hotspots", () => {
    const result = makeStubResult([]);
    expect(isSelfReferentialProfile(result)).toBe(false);
  });
});

describe("buildActivityBreakdown selfReferential flag", () => {
  it("sets selfReferential on profiles containing analyzer hotspots", () => {
    const normal = makeStubResult([
      { functionName: "PostSalesOrder", objectName: "Sales-Post" },
    ]);
    const selfRef = makeStubResult([
      { functionName: "AnalyzeBatch", objectName: "BatchRunner" },
    ]);
    selfRef.meta.profilePath = "selfref.alcpuprofile";

    const batch = aggregateResults([normal, selfRef]);

    const selfRefActivity = batch.activityBreakdown.find(
      (a) => a.profilePath === "selfref.alcpuprofile",
    );
    const normalActivity = batch.activityBreakdown.find(
      (a) => a.profilePath === "stub.alcpuprofile",
    );

    expect(selfRefActivity?.selfReferential).toBe(true);
    expect(normalActivity?.selfReferential).toBeUndefined();
  });
});
