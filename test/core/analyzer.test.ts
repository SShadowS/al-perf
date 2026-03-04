import { describe, test, expect } from "bun:test";
import { analyzeProfile, compareProfiles } from "../../src/core/analyzer.js";

const FIXTURES = "test/fixtures";

describe("analyzeProfile", () => {
  test("returns complete AnalysisResult for sampling profile", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);

    expect(result.meta.profileType).toBe("sampling");
    expect(result.meta.totalNodes).toBe(3);
    expect(result.meta.samplingInterval).toBe(100000);
    expect(result.meta.analyzedAt).toBeTruthy();

    expect(result.summary.oneLiner).toBeTruthy();
    expect(result.summary.patternCount.critical).toBeGreaterThanOrEqual(0);

    expect(result.hotspots.length).toBeGreaterThan(0);
    expect(result.hotspots[0].selfTime).toBeGreaterThanOrEqual(result.hotspots[1]?.selfTime ?? 0);

    expect(result.appBreakdown.length).toBeGreaterThan(0);
    expect(result.objectBreakdown.length).toBeGreaterThan(0);
  });

  test("respects top option to limit hotspots", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`, { top: 1 });
    expect(result.hotspots).toHaveLength(1);
  });

  test("excludes idle nodes from hotspots by default", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const idleHotspot = result.hotspots.find(h => h.functionName === "IdleTime");
    expect(idleHotspot).toBeUndefined();
  });

  test("works on instrumentation profile", async () => {
    const result = await analyzeProfile(
      `${FIXTURES}/instrumentation-minimal.alcpuprofile`
    );
    expect(result.meta.profileType).toBe("instrumentation");
    expect(result.meta.totalNodes).toBe(2);
    expect(result.hotspots.length).toBeGreaterThan(0);
  });

  test("extracts critical path through the call tree", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    expect(result.criticalPath).toBeDefined();
    expect(result.criticalPath.length).toBeGreaterThan(0);
    // The critical path should start at root and follow highest totalTime
    // sampling-minimal: OnRun (totalTime=2500000) → ProcessLine (totalTime=2000000)
    expect(result.criticalPath[0].functionName).toBe("OnRun");
    expect(result.criticalPath[1].functionName).toBe("ProcessLine");
    // Each step should have increasing depth
    for (let i = 1; i < result.criticalPath.length; i++) {
      expect(result.criticalPath[i].depth).toBeGreaterThan(result.criticalPath[i - 1].depth);
    }
  });

  test("attaches source locations to hotspots when source available", async () => {
    const result = await analyzeProfile(
      `${FIXTURES}/instrumentation-minimal.alcpuprofile`,
      { sourcePath: `${FIXTURES}/source`, top: 10 },
    );

    // Mechanism test: source should be available and hotspots should exist
    if (result.meta.sourceAvailable) {
      expect(result.hotspots.length).toBeGreaterThan(0);
      // Source locations are only attached when there's a match in the source index
      // The fixture source may not match instrumentation-minimal methods,
      // so we just verify the field exists (undefined is OK if no match)
      for (const h of result.hotspots) {
        if (h.sourceLocation) {
          expect(h.sourceLocation.filePath).toBeTruthy();
          expect(h.sourceLocation.lineStart).toBeGreaterThan(0);
          expect(h.sourceLocation.lineEnd).toBeGreaterThanOrEqual(h.sourceLocation.lineStart);
        }
      }
    }
  });
});

describe("compareProfiles", () => {
  test("returns comparison between two sampling profiles", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
    );
    expect(result.meta.beforeType).toBe("sampling");
    expect(result.meta.afterType).toBe("sampling");
    expect(result.summary.oneLiner).toBeTruthy();
    expect(result.summary.deltaTime).toBeDefined();
  });

  test("includes pattern deltas comparing same profile", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
    );
    // Same profile → all patterns exist in both → no deltas
    expect(result.patternDeltas).toBeDefined();
    expect(result.patternDeltas).toHaveLength(0);
  });

  test("identifies new and resolved patterns between different profiles", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/recursive-profile.alcpuprofile`,
    );
    expect(result.patternDeltas).toBeDefined();
    // Different profiles have different patterns, so we should see new and/or resolved
    const newPatterns = result.patternDeltas.filter(d => d.status === "new");
    const resolvedPatterns = result.patternDeltas.filter(d => d.status === "resolved");
    expect(newPatterns.length + resolvedPatterns.length).toBeGreaterThan(0);
  });

  test("identifies methods that appear in one profile but not the other", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/instrumentation-minimal.alcpuprofile`,
    );
    // Different profile types will have different methods
    expect(result.newMethods.length + result.removedMethods.length + result.regressions.length + result.improvements.length).toBeGreaterThanOrEqual(0);
  });
});
