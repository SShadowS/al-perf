import { describe, it, expect } from "bun:test";
import { indexALFile, buildSourceIndex } from "../../src/source/indexer.js";
import { resolve } from "path";

const fixturesDir = resolve(import.meta.dir, "../fixtures/source");

describe("indexALFile", () => {
  it("should index a codeunit file", async () => {
    const result = await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir);
    expect(result).toBeDefined();
    expect(result!.objectType).toBe("Codeunit");
    expect(result!.objectId).toBe(50100);
    expect(result!.objectName).toBe("Test Codeunit");
    expect(result!.procedures.length).toBe(2);
    expect(result!.triggers.length).toBe(1); // OnRun

    const processRecords = result!.procedures.find(p => p.name === "ProcessRecords");
    expect(processRecords).toBeDefined();
    expect(processRecords!.features.loops.length).toBe(1);
    expect(processRecords!.features.loops[0].type).toBe("repeat");
    expect(processRecords!.features.recordOpsInLoops.length).toBeGreaterThan(0);

    const simpleMethod = result!.procedures.find(p => p.name === "SimpleMethod");
    expect(simpleMethod).toBeDefined();
    expect(simpleMethod!.features.loops.length).toBe(0);
    expect(simpleMethod!.features.recordOpsInLoops.length).toBe(0);
  });

  it("should index a table file", async () => {
    const result = await indexALFile(resolve(fixturesDir, "Table50100.al"), fixturesDir);
    expect(result).toBeDefined();
    expect(result!.objectType).toBe("Table");
    expect(result!.objectId).toBe(50100);
    expect(result!.triggers.length).toBe(2); // OnInsert, OnModify

    const lookupRecords = result!.procedures.find(p => p.name === "LookupRecords");
    expect(lookupRecords).toBeDefined();
    expect(lookupRecords!.features.loops.length).toBe(1);
    expect(lookupRecords!.features.loops[0].type).toBe("for");
    expect(lookupRecords!.features.recordOpsInLoops.length).toBeGreaterThan(0);
  });
});

describe("buildSourceIndex", () => {
  it("should build an index from a directory of AL files", async () => {
    const index = await buildSourceIndex(fixturesDir);
    expect(index.files.length).toBe(3);
    expect(index.objects.size).toBe(3);

    const procList = index.procedures.get("processrecords");
    expect(procList).toBeDefined();
    expect(procList!.length).toBe(1);
    expect(procList![0].objectId).toBe(50100);
  });
});
