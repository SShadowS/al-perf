import { describe, test, expect } from "bun:test";
import { buildSourceIndex } from "../../src/source/indexer.js";
import {
  detectNestedLoops,
  detectUnfilteredFindSet,
  detectEventSubscriberIssues,
  detectDangerousCallsInLoop,
  detectUnindexedFilters,
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

describe("detectEventSubscriberIssues", () => {
  test("detects event subscriber with loops", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectEventSubscriberIssues(index);

    const match = patterns.find((p) =>
      p.involvedMethods.some((m) => m.includes("OnBeforePostSalesDoc")),
    );
    expect(match).toBeDefined();
    expect(match!.suggestion).toBeDefined();
  });

  test("detects event subscriber with record ops in loops as warning", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectEventSubscriberIssues(index);

    const match = patterns.find((p) => p.id === "event-subscriber-with-loop-ops");
    expect(match).toBeDefined();
    expect(match!.severity).toBe("warning");
  });

  test("does not flag non-subscriber procedures", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectEventSubscriberIssues(index);

    const falsePositive = patterns.find((p) =>
      p.involvedMethods.some((m) => m.includes("ProcessRecords")),
    );
    expect(falsePositive).toBeUndefined();
  });
});

describe("detectDangerousCallsInLoop", () => {
  test("detects Commit inside loop", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectDangerousCallsInLoop(index);
    const commitInLoop = patterns.find(p =>
      p.id === "dangerous-call-in-loop" && p.title.includes("Commit") && p.title.includes("CommitInLoop")
    );
    expect(commitInLoop).toBeDefined();
    expect(commitInLoop!.severity).toBe("critical");
  });

  test("detects Error inside loop", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectDangerousCallsInLoop(index);
    const errorInLoop = patterns.find(p =>
      p.id === "dangerous-call-in-loop" && p.title.includes("Error") && p.title.includes("ErrorInLoop")
    );
    expect(errorInLoop).toBeDefined();
  });

  test("does not flag Commit outside loop", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectDangerousCallsInLoop(index);
    const safeCommit = patterns.find(p =>
      p.title.includes("SafeCommit")
    );
    expect(safeCommit).toBeUndefined();
  });
});

describe("detectUnindexedFilters", () => {
  test("flags SetRange on field with no supporting key", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectUnindexedFilters(index);
    // FilterWithoutIndex does SetRange(Description, ...) on Key Test Table
    // Key Test Table has keys: PK(No.), CustomerDate(Customer No., Posting Date), AmountIdx(Amount)
    // Description is not the first field of any key => should be flagged
    const descriptionFilter = patterns.find(p =>
      p.involvedMethods.some(m => m.includes("FilterWithoutIndex"))
    );
    expect(descriptionFilter).toBeDefined();
    expect(descriptionFilter!.id).toBe("unindexed-filter");
    expect(descriptionFilter!.severity).toBe("warning");
  });

  test("does not flag SetRange on field covered by a key", async () => {
    const index = await buildSourceIndex("test/fixtures/source");
    const patterns = detectUnindexedFilters(index);
    // FilterWithIndex does SetRange("No.", ...) — covered by PK
    // FilterOnSecondaryKey does SetRange("Customer No.", ...) — covered by CustomerDate key
    const indexedFilter = patterns.find(p =>
      p.involvedMethods.some(m => m.includes("FilterWithIndex"))
    );
    expect(indexedFilter).toBeUndefined();

    const secondaryFilter = patterns.find(p =>
      p.involvedMethods.some(m => m.includes("FilterOnSecondaryKey"))
    );
    expect(secondaryFilter).toBeUndefined();
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
