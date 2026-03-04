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

test("extracts tableRelationTarget from field declarations", async () => {
  const result = await indexALFile(resolve(fixturesDir, "Table50400.al"), fixturesDir);
  expect(result).toBeDefined();
  const custField = result!.fields.find(f => f.name === "Customer No.")!;
  expect(custField.tableRelationTarget).toBe("Customer");
});

test("fields without TableRelation have no tableRelationTarget", async () => {
  const result = await indexALFile(resolve(fixturesDir, "Table50400.al"), fixturesDir);
  expect(result).toBeDefined();
  const noField = result!.fields.find(f => f.name === "No.")!;
  expect(noField.tableRelationTarget).toBeUndefined();
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

test("extracts table keys from table declaration", async () => {
  const result = await indexALFile(resolve(fixturesDir, "Table50400.al"), fixturesDir);
  expect(result).toBeDefined();
  expect(result!.keys).toBeDefined();
  expect(result!.keys).toHaveLength(3);

  const pk = result!.keys.find(k => k.name === "PK")!;
  expect(pk).toBeDefined();
  expect(pk.fields).toEqual(["No."]);
  expect(pk.clustered).toBe(true);

  const sk = result!.keys.find(k => k.name === "CustomerDate")!;
  expect(sk).toBeDefined();
  expect(sk.fields).toEqual(["Customer No.", "Posting Date"]);
  expect(sk.clustered).toBe(false);

  const amountIdx = result!.keys.find(k => k.name === "AmountIdx")!;
  expect(amountIdx.fields).toEqual(["Amount"]);
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

test("extracts field accesses from procedures", async () => {
  const result = await indexALFile(resolve(fixturesDir, "CodeUnit50700.al"), fixturesDir);
  expect(result).toBeDefined();

  const goodProc = result!.procedures.find(p => p.name === "GoodSetLoadFields")!;
  expect(goodProc).toBeDefined();
  expect(goodProc.features.fieldAccesses.length).toBeGreaterThan(0);
  const fieldNames = goodProc.features.fieldAccesses.map(a => a.fieldName);
  expect(fieldNames).toContain("Document No.");
  expect(fieldNames).toContain("Amount");

  const badProc = result!.procedures.find(p => p.name === "BadSetLoadFields")!;
  expect(badProc).toBeDefined();
  const badFieldNames = badProc.features.fieldAccesses.map(a => a.fieldName);
  expect(badFieldNames).toContain("Document No.");
  expect(badFieldNames).toContain("Amount");

  const noProc = result!.procedures.find(p => p.name === "NoSetLoadFields")!;
  expect(noProc).toBeDefined();
  const noFieldNames = noProc.features.fieldAccesses.map(a => a.fieldName);
  expect(noFieldNames).toContain("Amount");
});

test("extracts allFieldArguments for SetLoadFields calls", async () => {
  const result = await indexALFile(resolve(fixturesDir, "CodeUnit50700.al"), fixturesDir);
  expect(result).toBeDefined();

  const goodProc = result!.procedures.find(p => p.name === "GoodSetLoadFields")!;
  const setLoadFieldsOp = goodProc.features.recordOps.find(op => op.type === "SetLoadFields");
  expect(setLoadFieldsOp).toBeDefined();
  expect(setLoadFieldsOp!.allFieldArguments).toBeDefined();
  expect(setLoadFieldsOp!.allFieldArguments!.length).toBe(2);
  expect(setLoadFieldsOp!.allFieldArguments).toContain("Document No.");
  expect(setLoadFieldsOp!.allFieldArguments).toContain("Amount");

  const badProc = result!.procedures.find(p => p.name === "BadSetLoadFields")!;
  const badSetLoadFieldsOp = badProc.features.recordOps.find(op => op.type === "SetLoadFields");
  expect(badSetLoadFieldsOp).toBeDefined();
  expect(badSetLoadFieldsOp!.allFieldArguments).toBeDefined();
  expect(badSetLoadFieldsOp!.allFieldArguments!.length).toBe(1);
  expect(badSetLoadFieldsOp!.allFieldArguments).toContain("Document No.");
});

test("does not count method calls as field accesses", async () => {
  const result = await indexALFile(resolve(fixturesDir, "CodeUnit50700.al"), fixturesDir);
  expect(result).toBeDefined();

  const goodProc = result!.procedures.find(p => p.name === "GoodSetLoadFields")!;
  // Method calls like SetLoadFields, SetRange, FindSet, Next, Message should NOT appear as field accesses
  const fieldNames = goodProc.features.fieldAccesses.map(a => a.fieldName.toLowerCase());
  expect(fieldNames).not.toContain("setloadfields");
  expect(fieldNames).not.toContain("setrange");
  expect(fieldNames).not.toContain("findset");
  expect(fieldNames).not.toContain("next");
});

describe("buildSourceIndex", () => {
  it("should build an index from a directory of AL files", async () => {
    const index = await buildSourceIndex(fixturesDir);
    expect(index.files.length).toBe(11);
    expect(index.objects.size).toBe(11);

    const procList = index.procedures.get("processrecords");
    expect(procList).toBeDefined();
    expect(procList!.length).toBe(1);
    expect(procList![0].objectId).toBe(50100);
  });
});
