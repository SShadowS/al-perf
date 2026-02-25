import { describe, it, expect } from "bun:test";
import { matchToSource, matchAllHotspots } from "../../src/source/locator.js";
import type { SourceIndex, ProcedureInfo, TriggerInfo } from "../../src/types/source-index.js";

function makeProcedure(overrides: Partial<ProcedureInfo>): ProcedureInfo {
  return {
    name: "TestProc",
    objectType: "Codeunit",
    objectName: "Test",
    objectId: 50100,
    file: "CodeUnit50100.al",
    lineStart: 10,
    lineEnd: 20,
    features: { loops: [], recordOps: [], recordOpsInLoops: [], nestingDepth: 0 },
    ...overrides,
  };
}

function makeIndex(procs: ProcedureInfo[], trigs: TriggerInfo[] = []): SourceIndex {
  const procedures = new Map<string, ProcedureInfo[]>();
  for (const p of procs) {
    const key = p.name.toLowerCase();
    const list = procedures.get(key) ?? [];
    list.push(p);
    procedures.set(key, list);
  }
  const triggers = new Map<string, TriggerInfo[]>();
  for (const t of trigs) {
    const key = t.name.toLowerCase();
    const list = triggers.get(key) ?? [];
    list.push(t);
    triggers.set(key, list);
  }
  return { files: [], procedures, triggers, objects: new Map() };
}

describe("matchToSource", () => {
  it("should match by functionName + objectId", () => {
    const proc = makeProcedure({ name: "DoWork", objectId: 80 });
    const index = makeIndex([proc]);
    const result = matchToSource("DoWork", "Codeunit", 80, index);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("DoWork");
    expect(result!.objectId).toBe(80);
  });

  it("should match by name only when single candidate", () => {
    const proc = makeProcedure({ name: "UniqueProc", objectId: 50100 });
    const index = makeIndex([proc]);
    const result = matchToSource("UniqueProc", "Codeunit", 99999, index);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("UniqueProc");
  });

  it("should return null when no match found", () => {
    const index = makeIndex([]);
    const result = matchToSource("NonExistent", "Codeunit", 80, index);
    expect(result).toBeNull();
  });

  it("should disambiguate by objectType when multiple candidates", () => {
    const proc1 = makeProcedure({ name: "Init", objectType: "Codeunit", objectId: 1 });
    const proc2 = makeProcedure({ name: "Init", objectType: "Table", objectId: 2 });
    const index = makeIndex([proc1, proc2]);
    const result = matchToSource("Init", "Table", 2, index);
    expect(result).not.toBeNull();
    expect(result!.objectType).toBe("Table");
    expect(result!.objectId).toBe(2);
  });

  it("should match triggers (OnRun, OnInsert, etc.)", () => {
    const trigger: TriggerInfo = {
      name: "OnRun",
      objectType: "Codeunit",
      objectName: "Test",
      objectId: 80,
      file: "CodeUnit80.al",
      lineStart: 5,
      lineEnd: 15,
      features: { loops: [], recordOps: [], recordOpsInLoops: [], nestingDepth: 0 },
    };
    const index = makeIndex([], [trigger]);
    const result = matchToSource("OnRun", "Codeunit", 80, index);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("OnRun");
  });

  it("should be case-insensitive", () => {
    const proc = makeProcedure({ name: "DoWork", objectId: 80 });
    const index = makeIndex([proc]);
    const result = matchToSource("dowork", "Codeunit", 80, index);
    expect(result).not.toBeNull();
  });
});
