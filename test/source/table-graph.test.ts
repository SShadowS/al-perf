import { describe, test, expect, beforeAll } from "bun:test";
import { resolve } from "path";
import { buildSourceIndex } from "../../src/source/indexer.js";
import { buildTableRelationGraph, tableConnectivityStats } from "../../src/source/table-graph.js";
import type { SourceIndex } from "../../src/types/source-index.js";

const fixturesDir = resolve(import.meta.dir, "../fixtures/source");

let sourceIndex: SourceIndex;

beforeAll(async () => {
  sourceIndex = await buildSourceIndex(fixturesDir);
});

describe("buildTableRelationGraph", () => {
  test("extracts CalcFormula relations from tables", () => {
    const relations = buildTableRelationGraph(sourceIndex);
    // Table50200 has CalcFormula = Sum("Sales Line"...) and Lookup(Customer...)
    const salesLineRel = relations.find(
      r => r.fromTable === "CalcField Test Table" && r.toTable === "Sales Line"
    );
    expect(salesLineRel).toBeDefined();
    expect(salesLineRel!.relationType).toBe("CalcFormula");
  });

  test("extracts TableRelation references", () => {
    const relations = buildTableRelationGraph(sourceIndex);
    // Table50400 has TableRelation = Customer."No." on Customer No. field
    const custRel = relations.find(
      r => r.fromTable === "Key Test Table" && r.toTable === "Customer"
    );
    expect(custRel).toBeDefined();
    expect(custRel!.relationType).toBe("TableRelation");
  });

  test("includes fromField and line info", () => {
    const relations = buildTableRelationGraph(sourceIndex);
    const custRel = relations.find(
      r => r.fromTable === "Key Test Table" && r.toTable === "Customer" && r.relationType === "TableRelation"
    );
    expect(custRel).toBeDefined();
    expect(custRel!.fromField).toBe("Customer No.");
    expect(custRel!.fromTableId).toBe(50400);
    expect(custRel!.line).toBeGreaterThan(0);
  });

  test("includes both TableRelation and CalcFormula types", () => {
    const relations = buildTableRelationGraph(sourceIndex);
    const types = new Set(relations.map(r => r.relationType));
    expect(types.has("TableRelation")).toBe(true);
    expect(types.has("CalcFormula")).toBe(true);
  });
});

describe("tableConnectivityStats", () => {
  test("returns tables sorted by connectivity", () => {
    const relations = buildTableRelationGraph(sourceIndex);
    const stats = tableConnectivityStats(relations);
    expect(stats.length).toBeGreaterThan(0);
    // Most connected table should be first
    for (let i = 1; i < stats.length; i++) {
      expect(stats[i].total).toBeLessThanOrEqual(stats[i - 1].total);
    }
  });

  test("counts inbound and outbound correctly", () => {
    const relations = buildTableRelationGraph(sourceIndex);
    const stats = tableConnectivityStats(relations);

    // Customer is referenced by both Table50400 (TableRelation) and Table50200 (CalcFormula Lookup)
    const customerStats = stats.find(s => s.tableName === "Customer");
    expect(customerStats).toBeDefined();
    expect(customerStats!.inbound).toBeGreaterThanOrEqual(2);
    expect(customerStats!.outbound).toBe(0); // Customer table is not in our fixtures as a source
  });

  test("tracks outbound relations for source tables", () => {
    const relations = buildTableRelationGraph(sourceIndex);
    const stats = tableConnectivityStats(relations);

    // CalcField Test Table (Table50200) has CalcFormula refs to Sales Line and Customer
    const calcFieldStats = stats.find(s => s.tableName === "CalcField Test Table");
    expect(calcFieldStats).toBeDefined();
    expect(calcFieldStats!.outbound).toBeGreaterThanOrEqual(2);
  });
});
