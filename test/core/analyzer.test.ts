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

  test("works on real instrumentation profile", async () => {
    const result = await analyzeProfile(
      "exampledata/cedf4512-490d-4252-b9f6-943dd571888f.alcpuprofile"
    );
    expect(result.meta.profileType).toBe("instrumentation");
    expect(result.meta.totalNodes).toBeGreaterThan(2000);
    expect(result.hotspots.length).toBeGreaterThan(0);
  });
});

describe("compareProfiles", () => {
  test("returns comparison between two sampling profiles", async () => {
    const result = await compareProfiles(
      "exampledata/PerformanceProfile_Session6.alcpuprofile",
      "exampledata/PerformanceProfile_Session15.alcpuprofile",
    );
    expect(result.meta.beforeType).toBe("sampling");
    expect(result.meta.afterType).toBe("sampling");
    expect(result.summary.oneLiner).toBeTruthy();
    expect(result.summary.deltaTime).toBeDefined();
  });

  test("identifies methods that appear in one profile but not the other", async () => {
    const result = await compareProfiles(
      "exampledata/PerformanceProfile_Session6.alcpuprofile",
      "exampledata/PerformanceProfile_Session15.alcpuprofile",
    );
    // Session6 is Customer Card, Session15 is Item Card — almost no overlap
    expect(result.newMethods.length + result.removedMethods.length).toBeGreaterThan(0);
  });
});
