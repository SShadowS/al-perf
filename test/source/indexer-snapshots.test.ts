import { describe, it, expect } from "bun:test";
import { indexALFile, buildSourceIndex } from "../../src/source/indexer.js";
import { resolve } from "path";

const fixturesDir = resolve(import.meta.dir, "../fixtures/source");

/**
 * Snapshot tests for the source indexer.
 * These capture the exact output of indexALFile/buildSourceIndex
 * for every fixture, independent of grammar version.
 * If these pass after a grammar upgrade, the migration is correct.
 */

describe("Indexer output snapshots", () => {
  // --- CodeUnit50100: basic codeunit with OnRun, loops, record ops ---
  describe("CodeUnit50100", () => {
    it("should produce correct object metadata", async () => {
      const r = await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir);
      expect(r).not.toBeNull();
      expect(r!.objectType).toBe("Codeunit");
      expect(r!.objectId).toBe(50100);
      expect(r!.objectName).toBe("Test Codeunit");
    });

    it("should find 2 procedures and 1 trigger", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir))!;
      expect(r.procedures.map(p => p.name).sort()).toEqual(["ProcessRecords", "SimpleMethod"]);
      expect(r.triggers.map(t => t.name)).toEqual(["OnRun"]);
    });

    it("ProcessRecords: loop with record ops", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "ProcessRecords")!;
      expect(proc.features.loops).toHaveLength(1);
      expect(proc.features.loops[0].type).toBe("repeat");
      expect(proc.features.recordOps.map(o => o.type).sort()).toEqual(
        ["CalcFields", "FindSet", "Modify", "Next", "SetRange"].sort()
      );
      expect(proc.features.recordOpsInLoops.length).toBeGreaterThan(0);
      // Variables
      const salesLine = proc.features.variables.find(v => v.name === "SalesLine");
      expect(salesLine).toBeDefined();
      expect(salesLine!.isRecord).toBe(true);
      expect(salesLine!.tableName).toBe("Sales Line");
      expect(salesLine!.isTemporary).toBe(false);
    });

    it("SimpleMethod: no loops, no record ops", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "SimpleMethod")!;
      expect(proc.features.loops).toHaveLength(0);
      expect(proc.features.recordOps).toHaveLength(0);
    });
  });

  // --- CodeUnit50400: temporary record variables ---
  describe("CodeUnit50400", () => {
    it("should detect temporary record variable", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50400.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "ProcessWithTempTable")!;
      const tempVar = proc.features.variables.find(v => v.name === "TempBuffer");
      expect(tempVar).toBeDefined();
      expect(tempVar!.isRecord).toBe(true);
      expect(tempVar!.isTemporary).toBe(true);
      expect(tempVar!.tableName).toBe("Sales Line");
    });

    it("should detect non-temporary record variable", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50400.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "ProcessWithRealTable")!;
      const realVar = proc.features.variables.find(v => v.name === "SalesLine");
      expect(realVar).toBeDefined();
      expect(realVar!.isRecord).toBe(true);
      expect(realVar!.isTemporary).toBe(false);
    });
  });

  // --- CodeUnit50500: OnRun trigger in codeunit ---
  describe("CodeUnit50500", () => {
    it("should find OnRun trigger", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50500.al"), fixturesDir))!;
      expect(r.triggers.map(t => t.name)).toEqual(["OnRun"]);
    });
  });

  // --- CodeUnit50200: nested loops, event subscribers ---
  describe("CodeUnit50200", () => {
    it("should have 5 procedures, 0 triggers", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50200.al"), fixturesDir))!;
      expect(r.procedures).toHaveLength(5);
      expect(r.triggers).toHaveLength(0);
    });

    it("OnBeforePostSalesDoc is event subscriber", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50200.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "OnBeforePostSalesDoc")!;
      expect(proc.isEventSubscriber).toBe(true);
    });

    it("ProcessNestedLoops is NOT event subscriber", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50200.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "ProcessNestedLoops")!;
      expect(proc.isEventSubscriber).toBe(false);
    });
  });

  // --- CodeUnit50700: field accesses and SetLoadFields ---
  describe("CodeUnit50700", () => {
    it("GoodSetLoadFields: correct field accesses", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50700.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "GoodSetLoadFields")!;
      const fieldNames = proc.features.fieldAccesses.map(a => a.fieldName);
      expect(fieldNames).toContain("Document No.");
      expect(fieldNames).toContain("Amount");
      // Method calls should NOT appear as field accesses
      const lower = fieldNames.map(f => f.toLowerCase());
      expect(lower).not.toContain("setloadfields");
      expect(lower).not.toContain("findset");
    });

    it("GoodSetLoadFields: allFieldArguments on SetLoadFields", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50700.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "GoodSetLoadFields")!;
      const op = proc.features.recordOps.find(o => o.type === "SetLoadFields")!;
      expect(op.allFieldArguments).toHaveLength(2);
      expect(op.allFieldArguments).toContain("Document No.");
      expect(op.allFieldArguments).toContain("Amount");
    });
  });

  // --- Table50100: triggers in tables ---
  describe("Table50100", () => {
    it("should find 2 triggers and 1 procedure", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50100.al"), fixturesDir))!;
      expect(r.objectType).toBe("Table");
      expect(r.objectId).toBe(50100);
      expect(r.triggers.map(t => t.name).sort()).toEqual(["OnInsert", "OnModify"]);
      expect(r.procedures.map(p => p.name)).toEqual(["LookupRecords"]);
    });

    it("LookupRecords: for loop with record ops", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50100.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "LookupRecords")!;
      expect(proc.features.loops).toHaveLength(1);
      expect(proc.features.loops[0].type).toBe("for");
      expect(proc.features.recordOpsInLoops.length).toBeGreaterThan(0);
    });
  });

  // --- Table50200: CalcFormula fields ---
  describe("Table50200", () => {
    it("should extract CalcFormula types", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50200.al"), fixturesDir))!;
      expect(r.fields).toHaveLength(5);

      const totalAmount = r.fields.find(f => f.name === "Total Amount")!;
      expect(totalAmount.calcFormulaType).toBe("Sum");
      expect(totalAmount.calcFormulaTable).toBe("Sales Line");

      const custName = r.fields.find(f => f.name === "Customer Name")!;
      expect(custName.calcFormulaType).toBe("Lookup");

      const lineCount = r.fields.find(f => f.name === "Line Count")!;
      expect(lineCount.calcFormulaType).toBe("Count");

      const noField = r.fields.find(f => f.name === "No.")!;
      expect(noField.calcFormulaType).toBeUndefined();
    });
  });

  // --- Table50400: keys and TableRelation ---
  describe("Table50400", () => {
    it("should extract keys with clustered flag", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50400.al"), fixturesDir))!;
      expect(r.keys).toHaveLength(3);

      const pk = r.keys.find(k => k.name === "PK")!;
      expect(pk.fields).toEqual(["No."]);
      expect(pk.clustered).toBe(true);

      const sk = r.keys.find(k => k.name === "CustomerDate")!;
      expect(sk.fields).toEqual(["Customer No.", "Posting Date"]);
      expect(sk.clustered).toBe(false);
    });

    it("should extract TableRelation target", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50400.al"), fixturesDir))!;
      const custField = r.fields.find(f => f.name === "Customer No.")!;
      expect(custField.tableRelationTarget).toBe("Customer");

      const noField = r.fields.find(f => f.name === "No.")!;
      expect(noField.tableRelationTarget).toBeUndefined();
    });
  });

  // --- buildSourceIndex aggregate ---
  describe("buildSourceIndex", () => {
    it("should index all 11 fixture files", async () => {
      const index = await buildSourceIndex(fixturesDir);
      expect(index.files).toHaveLength(11);
      expect(index.objects.size).toBe(11);
    });

    it("should build event catalog", async () => {
      const index = await buildSourceIndex(fixturesDir);
      expect(index.eventCatalog.subscribers.length).toBeGreaterThanOrEqual(2);
      expect(index.eventCatalog.publishers.length).toBeGreaterThanOrEqual(2);

      const salesPostSub = index.eventCatalog.subscribers.find(
        s => s.procedureName === "OnBeforePostSalesDoc"
      );
      expect(salesPostSub).toBeDefined();
      expect(salesPostSub!.targetObjectType).toBe("Codeunit");
      expect(salesPostSub!.targetObjectId).toBe("Sales-Post");
      expect(salesPostSub!.targetEventName).toBe("OnBeforePostSalesDoc");
    });
  });
});
