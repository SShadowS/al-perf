import { describe, test, expect } from "bun:test";
import { buildSourceIndex } from "../../src/source/indexer.js";
import {
  detectNestedLoops,
  detectUnfilteredFindSet,
  runSourceOnlyDetectors,
} from "../../src/source/source-only-patterns.js";

describe("detectNestedLoops", () => {
  test("detects nested loops in ProcessNestedLoops", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectNestedLoops(index);

    const nested = patterns.filter((p) => p.id === "nested-loops");
    expect(nested.length).toBeGreaterThanOrEqual(1);

    const match = nested.find((p) => p.involvedMethods.some((m) => m.includes("ProcessNestedLoops")));
    expect(match).toBeDefined();
    expect(match!.severity).toBe("warning");
    expect(match!.suggestion).toBeDefined();
  });

  test("does not flag single-level loops", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectNestedLoops(index);

    const falsePositive = patterns.find((p) =>
      p.involvedMethods.some((m) => m.includes("ProcessRecords") && m.includes("50100")),
    );
    expect(falsePositive).toBeUndefined();
  });
});

describe("detectUnfilteredFindSet", () => {
  test("detects FindSet without SetRange/SetFilter", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectUnfilteredFindSet(index);

    // CodeUnit50200 UnfilteredQuery has Customer.FindSet() without SetRange/SetFilter
    const match = patterns.find((p) =>
      p.involvedMethods.some((m) => m.includes("UnfilteredQuery")),
    );
    expect(match).toBeDefined();
    expect(match!.id).toBe("unfiltered-findset");
    expect(match!.severity).toBe("warning");
    expect(match!.suggestion).toBeDefined();
  });

  test("does not flag FindSet with preceding SetRange", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectUnfilteredFindSet(index);

    // CodeUnit50200 FilteredQuery has SetRange before FindSet — should NOT appear
    const falsePositive = patterns.find((p) =>
      p.involvedMethods.some((m) => m.includes("FilteredQuery")),
    );
    expect(falsePositive).toBeUndefined();
  });

  test("does not flag FindSet with preceding SetFilter", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectUnfilteredFindSet(index);

    // CodeUnit50100 ProcessRecords has SetRange before FindSet — should NOT appear
    const falsePositive = patterns.find((p) =>
      p.involvedMethods.some((m) => m.includes("ProcessRecords") && m.includes("50100")),
    );
    expect(falsePositive).toBeUndefined();
  });
});

describe("runSourceOnlyDetectors", () => {
  test("returns patterns sorted by impact descending", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = runSourceOnlyDetectors(index);
    expect(patterns.length).toBeGreaterThan(0);

    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i].impact).toBeLessThanOrEqual(patterns[i - 1].impact);
    }
  });
});
