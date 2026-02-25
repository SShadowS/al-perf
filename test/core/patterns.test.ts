import { describe, test, expect } from "bun:test";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import { runDetectors, detectSingleMethodDominance, detectHighHitCount, detectDeepCallStack } from "../../src/core/patterns.js";

const FIXTURES = "test/fixtures";

describe("detectSingleMethodDominance", () => {
  test("flags method with >50% of total selfTime", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const patterns = detectSingleMethodDominance(processed);

    // ProcessLine has 20/35 = 57.1% of total selfTime
    expect(patterns).toHaveLength(1);
    expect(patterns[0].id).toBe("single-method-dominance");
    expect(patterns[0].severity).toBe("critical");
    expect(patterns[0].involvedMethods[0]).toContain("ProcessLine");
    expect(patterns[0].suggestion).toBeDefined();
    expect(typeof patterns[0].suggestion).toBe("string");
  });
});

describe("detectHighHitCount", () => {
  test("flags child with hitCount much higher than parent", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const patterns = detectHighHitCount(processed);

    // Node 2 (hitCount=20) is child of Node 1 (hitCount=5): ratio 4x
    // Threshold is 10x, so this should NOT flag
    expect(patterns).toHaveLength(0);
  });
});

describe("detectDeepCallStack", () => {
  test("does not flag shallow profiles", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const patterns = detectDeepCallStack(processed);

    expect(patterns).toHaveLength(0);
  });
});

describe("runDetectors", () => {
  test("returns patterns sorted by impact descending", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const patterns = runDetectors(processed);

    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i - 1].impact).toBeGreaterThanOrEqual(patterns[i].impact);
    }
  });

  test("works on real Session6 profile", async () => {
    const parsed = await parseProfile("exampledata/PerformanceProfile_Session6.alcpuprofile");
    const processed = processProfile(parsed);
    const patterns = runDetectors(processed);

    // Should detect at least idle-time dominance
    expect(patterns.length).toBeGreaterThanOrEqual(1);

    // All returned patterns should have a suggestion
    for (const pattern of patterns) {
      expect(pattern.suggestion).toBeDefined();
      expect(typeof pattern.suggestion).toBe("string");
    }
  });
});
