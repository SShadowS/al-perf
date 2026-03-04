import { describe, it, expect, test } from "bun:test";
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

test("extracts variable declarations with Record types", async () => {
  const result = await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir);
  const processRecords = result!.procedures.find(p => p.name === "ProcessRecords")!;
  expect(processRecords.features.variables).toBeDefined();
  expect(processRecords.features.variables.length).toBeGreaterThan(0);
  const salesLine = processRecords.features.variables.find(v => v.name === "SalesLine");
  expect(salesLine).toBeDefined();
  expect(salesLine!.isRecord).toBe(true);
  expect(salesLine!.tableName).toBe("Sales Line");
  expect(salesLine!.isTemporary).toBe(false);
});

test("detects EventSubscriber attribute on procedures", async () => {
  const index = await buildSourceIndex(fixturesDir);
  const obj = index.objects.get("Codeunit_50200");
  expect(obj).toBeDefined();

  const eventSub = obj!.procedures.find((p) => p.name === "OnBeforePostSalesDoc");
  expect(eventSub).toBeDefined();
  expect(eventSub!.isEventSubscriber).toBe(true);

  const normal = obj!.procedures.find((p) => p.name === "ProcessNestedLoops");
  expect(normal).toBeDefined();
  expect(normal!.isEventSubscriber).toBe(false);
});

test("extracts CalcFormula fields from table declarations", async () => {
  const result = await indexALFile(resolve(fixturesDir, "Table50200.al"), fixturesDir);
  expect(result).toBeDefined();
  expect(result!.fields).toBeDefined();
  expect(result!.fields.length).toBe(5);

  const totalAmount = result!.fields.find(f => f.name === "Total Amount");
  expect(totalAmount).toBeDefined();
  expect(totalAmount!.calcFormulaType).toBe("Sum");

  const customerName = result!.fields.find(f => f.name === "Customer Name");
  expect(customerName).toBeDefined();
  expect(customerName!.calcFormulaType).toBe("Lookup");

  const lineCount = result!.fields.find(f => f.name === "Line Count");
  expect(lineCount).toBeDefined();
  expect(lineCount!.calcFormulaType).toBe("Count");

  const noField = result!.fields.find(f => f.name === "No.");
  expect(noField!.calcFormulaType).toBeUndefined();
});

test("builds event catalog from source attributes", async () => {
  const index = await buildSourceIndex(fixturesDir);
  expect(index.eventCatalog).toBeDefined();

  // CodeUnit50200 has two [EventSubscriber] procedures
  expect(index.eventCatalog.subscribers.length).toBeGreaterThanOrEqual(2);
  const salesPostSub = index.eventCatalog.subscribers.find(
    s => s.procedureName === "OnBeforePostSalesDoc"
  );
  expect(salesPostSub).toBeDefined();
  expect(salesPostSub!.targetObjectType).toBe("Codeunit");
  expect(salesPostSub!.targetObjectId).toBe("Sales-Post");
  expect(salesPostSub!.targetEventName).toBe("OnBeforePostSalesDoc");

  // CodeUnit50500 has two publishers: IntegrationEvent + BusinessEvent
  expect(index.eventCatalog.publishers.length).toBeGreaterThanOrEqual(2);
  const integrationPub = index.eventCatalog.publishers.find(
    p => p.procedureName === "OnBeforeProcessCalcFields"
  );
  expect(integrationPub).toBeDefined();
  expect(integrationPub!.eventType).toBe("IntegrationEvent");

  const businessPub = index.eventCatalog.publishers.find(
    p => p.procedureName === "OnAfterProcessCalcFields"
  );
  expect(businessPub).toBeDefined();
  expect(businessPub!.eventType).toBe("BusinessEvent");
});

describe("buildSourceIndex", () => {
  it("should build an index from a directory of AL files", async () => {
    const index = await buildSourceIndex(fixturesDir);
    expect(index.files.length).toBe(8);
    expect(index.objects.size).toBe(8);

    const procList = index.procedures.get("processrecords");
    expect(procList).toBeDefined();
    expect(procList!.length).toBe(1);
    expect(procList![0].objectId).toBe(50100);
  });
});
