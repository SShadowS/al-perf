import { describe, test, expect } from "bun:test";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import { runDetectors, detectSingleMethodDominance, detectHighHitCount, detectDeepCallStack, detectRecursion, detectEventChains } from "../../src/core/patterns.js";

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

describe("detectRecursion", () => {
  test("detects recursive calls", async () => {
    const parsed = await parseProfile(`${FIXTURES}/recursive-profile.alcpuprofile`);
    const processed = processProfile(parsed);
    const patterns = detectRecursion(processed);

    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].id).toBe("recursive-call");
    expect(patterns[0].severity).toBe("warning");
    expect(patterns[0].involvedMethods[0]).toContain("ProcessRecursive");
  });

  test("does not flag non-recursive profiles", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const patterns = detectRecursion(processed);

    expect(patterns).toHaveLength(0);
  });
});

describe("detectEventChains", () => {
  test("does not flag profiles without event chains", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const patterns = detectEventChains(processed);
    expect(patterns).toHaveLength(0);
  });

  test("detects event chains in profile with nested event subscribers", async () => {
    const parsed = await parseProfile(`${FIXTURES}/event-chain.alcpuprofile`);
    const processed = processProfile(parsed);
    const patterns = detectEventChains(processed);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].id).toBe("event-chain");
    expect(patterns[0].severity).toBe("warning");
    expect(patterns[0].involvedMethods.length).toBeGreaterThanOrEqual(2);
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

  test("does not produce false positives from IdleTime", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const patterns = runDetectors(processed);

    // IdleTime dominance is gone — only legitimate patterns remain
    const idlePatterns = patterns.filter(p => p.involvedMethods.some(m => m.includes("IdleTime")));
    expect(idlePatterns.length).toBe(0);

    // All returned patterns should have a suggestion
    for (const pattern of patterns) {
      expect(pattern.suggestion).toBeDefined();
      expect(typeof pattern.suggestion).toBe("string");
    }
  });
});
