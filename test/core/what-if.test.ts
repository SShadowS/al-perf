import { describe, test, expect } from "bun:test";
import { analyzeProfile } from "../../src/core/analyzer.js";

const FIXTURES = "test/fixtures";

describe("What If estimator", () => {
  test("estimates savings for single-method-dominance pattern", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const dominance = result.patterns.find(p => p.id === "single-method-dominance");
    expect(dominance).toBeDefined();
    expect(dominance!.estimatedSavings).toBeDefined();
    expect(dominance!.estimatedSavings).toBeGreaterThan(0);
    expect(dominance!.savingsExplanation).toBeTruthy();
  });

  test("estimates savings for high-hit-count pattern", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const highHit = result.patterns.find(p => p.id === "high-hit-count");
    if (highHit) {
      expect(highHit.estimatedSavings).toBeDefined();
      expect(highHit.estimatedSavings).toBeGreaterThan(0);
      expect(highHit.savingsExplanation).toBeTruthy();
    }
  });

  test("estimates savings for recursive-call pattern", async () => {
    const result = await analyzeProfile(`${FIXTURES}/recursive-profile.alcpuprofile`);
    const recursive = result.patterns.find(p => p.id === "recursive-call");
    expect(recursive).toBeDefined();
    expect(recursive!.estimatedSavings).toBeDefined();
    expect(recursive!.estimatedSavings).toBeGreaterThan(0);
  });

  test("does not add savings to patterns without a model", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    // deep-call-stack has no savings model
    const deep = result.patterns.find(p => p.id === "deep-call-stack");
    if (deep) {
      expect(deep.estimatedSavings).toBeUndefined();
    }
  });
});
