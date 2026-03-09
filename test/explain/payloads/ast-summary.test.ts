import { describe, it, expect } from "bun:test";
import { extractAstSummaries } from "../../../src/explain/payloads/ast-summary.js";
import type { MethodBreakdown } from "../../../src/types/aggregated.js";
import type { SourceIndex } from "../../../src/types/source-index.js";

function makeHotspot(
  functionName: string,
  objectType: string,
  objectId: number,
  selfTime = 1000,
): MethodBreakdown {
  return {
    functionName,
    objectType,
    objectName: "TestObject",
    objectId,
    appName: "TestApp",
    selfTime,
    selfTimePercent: 10,
    totalTime: selfTime * 2,
    totalTimePercent: 20,
    hitCount: 1,
    calledBy: [],
    calls: [],
    costPerHit: selfTime,
    efficiencyScore: 0.5,
  };
}

function makeSourceIndex(
  objectType: string,
  objectId: number,
  procName: string,
  features: any,
): SourceIndex {
  const objects = new Map();
  objects.set(`${objectType}_${objectId}`, {
    procedures: [{ name: procName, objectType, objectId, features }],
    triggers: [],
  });
  return { objects } as unknown as SourceIndex;
}

describe("extractAstSummaries", () => {
  it("returns empty array when sourceIndex is undefined", () => {
    const hotspots = [makeHotspot("DoSomething", "Codeunit", 50100)];
    expect(extractAstSummaries(hotspots, undefined)).toEqual([]);
  });

  it("returns empty array when no hotspots match source index", () => {
    const hotspots = [makeHotspot("DoSomething", "Codeunit", 99999)];
    const si = makeSourceIndex("Codeunit", 50100, "OtherProc", {
      loops: [],
      recordOps: [],
      recordOpsInLoops: [],
      dangerousCallsInLoops: [],
      variables: [],
      fieldAccesses: [],
      nestingDepth: 0,
    });
    expect(extractAstSummaries(hotspots, si)).toEqual([]);
  });

  it("extracts features from a matching procedure", () => {
    const hotspots = [makeHotspot("ProcessLines", "Codeunit", 50100)];
    const si = makeSourceIndex("Codeunit", 50100, "ProcessLines", {
      loops: [
        { type: "repeat", lineStart: 10, lineEnd: 20 },
        { type: "for", lineStart: 12, lineEnd: 18 },
      ],
      recordOps: [
        { type: "FindSet", line: 11, column: 1, insideLoop: true, recordVariable: "SalesLine" },
        { type: "Modify", line: 15, column: 1, insideLoop: true, recordVariable: "SalesLine" },
        { type: "Get", line: 5, column: 1, insideLoop: false, recordVariable: "Customer" },
      ],
      recordOpsInLoops: [
        { type: "FindSet", line: 11, column: 1, insideLoop: true, recordVariable: "SalesLine" },
        { type: "Modify", line: 15, column: 1, insideLoop: true, recordVariable: "SalesLine" },
      ],
      dangerousCallsInLoops: [
        { type: "Commit", line: 16, column: 1, insideLoop: true },
      ],
      variables: [
        { name: "SalesLine", typeStr: 'Record "Sales Line"', isRecord: true, isTemporary: false, line: 3 },
        { name: "Customer", typeStr: 'Record "Customer"', isRecord: true, isTemporary: false, line: 4 },
        { name: "i", typeStr: "Integer", isRecord: false, isTemporary: false, line: 5 },
      ],
      fieldAccesses: [],
      nestingDepth: 2,
    });

    const result = extractAstSummaries(hotspots, si);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      method: "ProcessLines",
      objectType: "Codeunit",
      objectId: 50100,
      loops: 2,
      recordOps: 3,
      recordOpsInLoops: 2,
      nestingDepth: 2,
      variables: 3,
      dangerousCallsInLoops: 1,
      recordOpTypes: ["FindSet", "Modify", "Get"],
    });
  });

  it("matches procedure name case-insensitively", () => {
    const hotspots = [makeHotspot("processlines", "Codeunit", 50100)];
    const si = makeSourceIndex("Codeunit", 50100, "ProcessLines", {
      loops: [],
      recordOps: [],
      recordOpsInLoops: [],
      dangerousCallsInLoops: [],
      variables: [],
      fieldAccesses: [],
      nestingDepth: 0,
    });

    const result = extractAstSummaries(hotspots, si);
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe("processlines");
  });

  it("finds triggers when procedure is not found", () => {
    const objects = new Map();
    objects.set("Table_50100", {
      procedures: [],
      triggers: [
        {
          name: "OnInsert",
          objectType: "Table",
          objectId: 50100,
          features: {
            loops: [{ type: "repeat", lineStart: 5, lineEnd: 10 }],
            recordOps: [{ type: "Insert", line: 6, column: 1, insideLoop: true, recordVariable: "Rec" }],
            recordOpsInLoops: [{ type: "Insert", line: 6, column: 1, insideLoop: true, recordVariable: "Rec" }],
            dangerousCallsInLoops: [],
            variables: [],
            fieldAccesses: [],
            nestingDepth: 1,
          },
        },
      ],
    });
    const si = { objects } as unknown as SourceIndex;
    const hotspots = [makeHotspot("OnInsert", "Table", 50100)];

    const result = extractAstSummaries(hotspots, si);
    expect(result).toHaveLength(1);
    expect(result[0].loops).toBe(1);
    expect(result[0].recordOpsInLoops).toBe(1);
  });

  it("caps at 15 hotspots", () => {
    const objects = new Map();
    const hotspots: MethodBreakdown[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `Proc${i}`;
      hotspots.push(makeHotspot(name, "Codeunit", 50100));
      // Add all procs to the same object
    }
    objects.set("Codeunit_50100", {
      procedures: hotspots.map((h) => ({
        name: h.functionName,
        objectType: "Codeunit",
        objectId: 50100,
        features: {
          loops: [],
          recordOps: [],
          recordOpsInLoops: [],
          dangerousCallsInLoops: [],
          variables: [],
          fieldAccesses: [],
          nestingDepth: 0,
        },
      })),
      triggers: [],
    });
    const si = { objects } as unknown as SourceIndex;

    const result = extractAstSummaries(hotspots, si);
    expect(result).toHaveLength(15);
  });

  it("handles missing features gracefully", () => {
    const hotspots = [makeHotspot("SparseProc", "Codeunit", 50100)];
    const si = makeSourceIndex("Codeunit", 50100, "SparseProc", {
      // Minimal features object — some fields missing
      nestingDepth: 0,
    });

    const result = extractAstSummaries(hotspots, si);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      method: "SparseProc",
      objectType: "Codeunit",
      objectId: 50100,
      loops: 0,
      recordOps: 0,
      recordOpsInLoops: 0,
      nestingDepth: 0,
      variables: 0,
      dangerousCallsInLoops: 0,
      recordOpTypes: [],
    });
  });

  it("falls back to filtering recordOps by insideLoop when recordOpsInLoops is missing", () => {
    const hotspots = [makeHotspot("FallbackProc", "Codeunit", 50100)];
    const si = makeSourceIndex("Codeunit", 50100, "FallbackProc", {
      loops: [{ type: "repeat", lineStart: 5, lineEnd: 15 }],
      recordOps: [
        { type: "FindSet", line: 6, column: 1, insideLoop: true, recordVariable: "Rec" },
        { type: "Get", line: 3, column: 1, insideLoop: false, recordVariable: "Cust" },
        { type: "Modify", line: 8, column: 1, insideLoop: true, recordVariable: "Rec" },
      ],
      // recordOpsInLoops intentionally omitted
      dangerousCallsInLoops: [],
      variables: [],
      fieldAccesses: [],
      nestingDepth: 1,
    });

    const result = extractAstSummaries(hotspots, si);
    expect(result).toHaveLength(1);
    expect(result[0].recordOpsInLoops).toBe(2);
  });
});
