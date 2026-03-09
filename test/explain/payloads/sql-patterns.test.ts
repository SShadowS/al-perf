import { describe, test, expect } from "bun:test";
import { extractSqlPatterns, type SqlPatternGroup } from "../../../src/explain/payloads/sql-patterns.js";
import type { ProcessedNode } from "../../../src/types/processed.js";

function makeNode(functionName: string, hitCount: number, selfTime: number): ProcessedNode {
  return {
    id: 0,
    callFrame: { functionName, scriptId: "0", url: "", lineNumber: 0, columnNumber: 0 },
    applicationDefinition: { objectType: "TableData", objectName: "", objectId: 0 },
    hitCount,
    children: [],
    depth: 0,
    selfTime,
    totalTime: selfTime,
    selfTimePercent: 0,
    totalTimePercent: 0,
  };
}

describe("extractSqlPatterns", () => {
  test("returns empty array for empty input", () => {
    expect(extractSqlPatterns([])).toEqual([]);
  });

  test("ignores non-SQL function names", () => {
    const nodes = [
      makeNode("OnValidate - Sales Header (CodeUnit 80)", 10, 500),
      makeNode("CalcFields - Customer", 5, 200),
      makeNode("FindSet", 3, 100),
    ];
    expect(extractSqlPatterns(nodes)).toEqual([]);
  });

  test("extracts table from SELECT with quoted name", () => {
    const nodes = [
      makeNode('SELECT "No_","Description" FROM "Sales Line" WHERE "Document Type"=@p1', 10, 500),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("Sales Line");
    expect(result[0].totalHits).toBe(10);
    expect(result[0].totalSelfTime).toBe(500);
    expect(result[0].patterns).toHaveLength(1);
  });

  test("strips GUID suffix from table names", () => {
    const nodes = [
      makeNode('SELECT TOP 1 "Entry No_" FROM dbo."Item Ledger Entry$437dbf0e-84ff-417a-965d-ed2bb9650972" WHERE "Item No_"=@p1', 5, 300),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("Item Ledger Entry");
  });

  test("handles dbo. prefix", () => {
    const nodes = [
      makeNode('SELECT "No_" FROM dbo."G/L Entry" WHERE "Entry No_">@p1', 8, 400),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("G/L Entry");
  });

  test("handles INSERT INTO", () => {
    const nodes = [
      makeNode('INSERT INTO "Change Log Entry" ("Entry No_","Date and Time") VALUES (@p1,@p2)', 3, 150),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("Change Log Entry");
  });

  test("handles UPDATE", () => {
    const nodes = [
      makeNode('UPDATE "Sales Header" SET "Status"=@p1 WHERE "No_"=@p2', 2, 100),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("Sales Header");
  });

  test("handles DELETE with FROM", () => {
    const nodes = [
      makeNode('DELETE FROM "Temp Buffer" WHERE "Entry No_"=@p1', 1, 50),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("Temp Buffer");
  });

  test("handles bracket-quoted table names", () => {
    const nodes = [
      makeNode('SELECT [No_] FROM [Sales Line] WHERE [Document Type]=@p1', 4, 200),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("Sales Line");
  });

  test("groups multiple queries for the same table", () => {
    const nodes = [
      makeNode('SELECT "No_" FROM "Sales Line" WHERE "Document Type"=@p1', 10, 500),
      makeNode('SELECT "Amount" FROM "Sales Line" WHERE "No_"=@p2', 5, 250),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("Sales Line");
    expect(result[0].totalHits).toBe(15);
    expect(result[0].totalSelfTime).toBe(750);
    expect(result[0].patterns).toHaveLength(2);
  });

  test("deduplicates identical truncated queries", () => {
    const nodes = [
      makeNode('SELECT "No_" FROM "Sales Line" WHERE "Type"=@p1', 10, 500),
      makeNode('SELECT "No_" FROM "Sales Line" WHERE "Type"=@p1', 3, 150),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].patterns).toHaveLength(1);
    expect(result[0].patterns[0].hitCount).toBe(13);
    expect(result[0].patterns[0].selfTime).toBe(650);
  });

  test("sorts tables by totalHits descending", () => {
    const nodes = [
      makeNode('SELECT "No_" FROM "Table A" WHERE 1=1', 2, 100),
      makeNode('SELECT "No_" FROM "Table C" WHERE 1=1', 20, 1000),
      makeNode('SELECT "No_" FROM "Table B" WHERE 1=1', 10, 500),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(3);
    expect(result[0].table).toBe("Table C");
    expect(result[1].table).toBe("Table B");
    expect(result[2].table).toBe("Table A");
  });

  test("caps at 15 table groups", () => {
    const nodes: ProcessedNode[] = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(makeNode(`SELECT "No_" FROM "Table ${i}" WHERE 1=1`, 20 - i, 100));
    }
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(15);
  });

  test("truncates query strings to 200 chars", () => {
    const longWhere = "x".repeat(250);
    const longQuery = `SELECT "No_" FROM "Sales Line" WHERE "${longWhere}"=@p1`;
    const nodes = [makeNode(longQuery, 1, 50)];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].patterns[0].query.length).toBe(200);
  });

  test("handles MERGE statement", () => {
    const nodes = [
      makeNode('MERGE "Sales Line" USING @source ON 1=1', 2, 100),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("Sales Line");
  });

  test("mixed SQL and non-SQL nodes", () => {
    const nodes = [
      makeNode("OnValidate - Sales Header (CodeUnit 80)", 10, 500),
      makeNode('SELECT "No_" FROM "Sales Line" WHERE 1=1', 5, 250),
      makeNode("FindSet", 3, 100),
      makeNode('INSERT INTO "Change Log Entry" ("No_") VALUES (@p1)', 2, 100),
    ];
    const result = extractSqlPatterns(nodes);
    expect(result).toHaveLength(2);
    // All non-SQL nodes should be filtered out
    const tables = result.map(r => r.table);
    expect(tables).toContain("Sales Line");
    expect(tables).toContain("Change Log Entry");
  });
});
