import { describe, expect, it } from "bun:test";
import { computeDiagnostics } from "../../src/explain/diagnostics.js";
import type { ProcessedNode, ProcessedProfile } from "../../src/types/processed.js";
import type { AnalysisResult } from "../../src/output/types.js";

function makeNode(overrides: Partial<ProcessedNode> & {
  functionName?: string;
  objectType?: string;
  objectName?: string;
  objectId?: number;
} = {}): ProcessedNode {
  const {
    functionName = "SomeMethod",
    objectType = "CodeUnit",
    objectName = "SomeObject",
    objectId = 1,
    ...rest
  } = overrides;
  return {
    id: 1,
    callFrame: { functionName, scriptId: "0", url: "", lineNumber: 0, columnNumber: 0 },
    applicationDefinition: { objectType, objectName, objectId },
    hitCount: 1,
    children: [],
    depth: 0,
    selfTime: 0,
    totalTime: 0,
    selfTimePercent: 0,
    totalTimePercent: 0,
    ...rest,
  } as ProcessedNode;
}

function makeProfile(overrides: Partial<ProcessedProfile> = {}): ProcessedProfile {
  return {
    type: "instrumentation",
    roots: [],
    allNodes: [],
    nodeMap: new Map(),
    totalDuration: 1000,
    totalSelfTime: 1000,
    activeSelfTime: 800,
    idleSelfTime: 200,
    maxDepth: 5,
    samplingInterval: undefined,
    nodeCount: 10,
    startTime: 0,
    endTime: 1000,
    ...overrides,
  };
}

function makeResult(overrides: Partial<AnalysisResult["summary"]> = {}): AnalysisResult {
  return {
    meta: {
      profilePath: "test.alcpuprofile",
      profileType: "instrumentation",
      totalDuration: 1000,
      totalSelfTime: 1000,
      idleSelfTime: 200,
      totalNodes: 10,
      maxDepth: 5,
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
      oneLiner: "test",
      topApp: null,
      topMethod: null,
      patternCount: { critical: 0, warning: 0, info: 0 },
      healthScore: 80,
      ...overrides,
    },
    criticalPath: [],
    hotspots: [],
    patterns: [],
    appBreakdown: [],
    objectBreakdown: [],
  };
}

describe("computeDiagnostics", () => {
  describe("cold cache detection", () => {
    it("detects cold cache when metadata nodes dominate (>50% selfTime)", () => {
      const metadataNode = makeNode({
        objectType: "Table",
        objectName: "Application Object Metadata",
        selfTime: 600,
      });
      const normalNode = makeNode({
        id: 2,
        objectType: "CodeUnit",
        objectName: "Sales Management",
        selfTime: 400,
      });
      const profile = makeProfile({
        allNodes: [metadataNode, normalNode],
        totalSelfTime: 1000,
      });

      const diag = computeDiagnostics(profile, makeResult());
      expect(diag.coldCacheScore).toBeCloseTo(0.6, 1);
      expect(diag.coldCacheWarning).toBe(true);
    });

    it("returns low cold cache score for normal profiles", () => {
      const normalNode1 = makeNode({
        objectType: "CodeUnit",
        objectName: "Sales Management",
        selfTime: 800,
      });
      const normalNode2 = makeNode({
        id: 2,
        objectType: "Table",
        objectName: "Sales Header",
        selfTime: 200,
      });
      const profile = makeProfile({
        allNodes: [normalNode1, normalNode2],
        totalSelfTime: 1000,
      });

      const diag = computeDiagnostics(profile, makeResult());
      expect(diag.coldCacheScore).toBeLessThan(0.4);
      expect(diag.coldCacheWarning).toBe(false);
    });
  });

  describe("wall-clock gap ratio", () => {
    it("computes wall-clock gap ratio for instrumentation profiles", () => {
      const profile = makeProfile({
        type: "instrumentation",
        totalDuration: 1000,
        activeSelfTime: 400,
      });

      const diag = computeDiagnostics(profile, makeResult());
      // gap = (1000 - 400) / 1000 = 0.6
      expect(diag.wallClockGapRatio).toBeCloseTo(0.6, 2);
      expect(diag.wallClockGapNote).not.toBeNull();
      expect(diag.wallClockGapNote).toContain("SQL");
    });

    it("returns null wallClockGapRatio for sampling profiles", () => {
      const profile = makeProfile({
        type: "sampling",
        totalDuration: 1000,
        activeSelfTime: 400,
      });

      const diag = computeDiagnostics(profile, makeResult());
      expect(diag.wallClockGapRatio).toBeNull();
      expect(diag.wallClockGapNote).toBeNull();
    });
  });

  describe("transaction count", () => {
    it("computes transaction count from BeginTransaction hitCounts", () => {
      const txNode1 = makeNode({
        functionName: "BeginTransaction",
        hitCount: 3,
      });
      const txNode2 = makeNode({
        id: 2,
        functionName: "BeginTransaction",
        hitCount: 5,
      });
      const normalNode = makeNode({
        id: 3,
        functionName: "SomeMethod",
        hitCount: 10,
      });
      const profile = makeProfile({
        allNodes: [txNode1, txNode2, normalNode],
      });

      const diag = computeDiagnostics(profile, makeResult());
      expect(diag.transactionCount).toBe(8);
    });
  });

  describe("table access map", () => {
    it("builds table access map with multi-caller tables only", () => {
      const caller1 = makeNode({
        id: 10,
        functionName: "PostSalesOrder",
        objectType: "CodeUnit",
        objectId: 80,
      });
      const caller2 = makeNode({
        id: 20,
        functionName: "ValidateSalesLine",
        objectType: "CodeUnit",
        objectId: 81,
      });
      const tableNode1 = makeNode({
        id: 1,
        objectType: "Table",
        objectName: "Sales Line",
        selfTime: 100,
        hitCount: 5,
        parent: caller1,
      });
      const tableNode2 = makeNode({
        id: 2,
        objectType: "Table",
        objectName: "Sales Line",
        selfTime: 50,
        hitCount: 3,
        parent: caller2,
      });
      // Single-caller table — should be excluded
      const singleCallerTable = makeNode({
        id: 3,
        objectType: "Table",
        objectName: "Purchase Header",
        selfTime: 200,
        hitCount: 10,
        parent: caller1,
      });
      // Metadata table — should be excluded
      const metadataTable = makeNode({
        id: 4,
        objectType: "Table",
        objectName: "Permission Set",
        selfTime: 300,
        hitCount: 20,
        parent: caller1,
      });
      const metadataTable2 = makeNode({
        id: 5,
        objectType: "Table",
        objectName: "Permission Set",
        selfTime: 100,
        hitCount: 10,
        parent: caller2,
      });

      const profile = makeProfile({
        allNodes: [tableNode1, tableNode2, singleCallerTable, metadataTable, metadataTable2],
      });

      const diag = computeDiagnostics(profile, makeResult());
      // Only "Sales Line" should appear (multi-caller, non-metadata)
      expect(diag.tableAccessMap).toHaveLength(1);
      expect(diag.tableAccessMap[0].table).toBe("Sales Line");
      expect(diag.tableAccessMap[0].totalHitCount).toBe(8);
      expect(diag.tableAccessMap[0].totalSelfTime).toBe(150);
      expect(diag.tableAccessMap[0].accessedBy).toHaveLength(2);
      // Sorted by hitCount descending
      expect(diag.tableAccessMap[0].accessedBy[0].hitCount).toBe(5);
      expect(diag.tableAccessMap[0].accessedBy[1].hitCount).toBe(3);
    });
  });

  describe("health score note", () => {
    it("detects health score inflation from high pattern count", () => {
      const result = makeResult({
        healthScore: 25,
        patternCount: { critical: 5, warning: 10, info: 10 },
      });

      const diag = computeDiagnostics(makeProfile(), result);
      expect(diag.healthScoreNote).not.toBeNull();
      expect(diag.healthScoreNote).toContain("pattern count");
      expect(diag.healthScoreNote).toContain("misleading");
    });

    it("returns null health score note for normal scores", () => {
      const result = makeResult({
        healthScore: 70,
        patternCount: { critical: 1, warning: 2, info: 3 },
      });

      const diag = computeDiagnostics(makeProfile(), result);
      expect(diag.healthScoreNote).toBeNull();
    });
  });
});
