import { describe, test, expect } from "bun:test";
import { isSqlStatement, truncateFunctionName } from "../../src/core/display-utils.js";

describe("isSqlStatement", () => {
  test("detects SELECT statements", () => {
    expect(isSqlStatement("SELECT L.Text FROM [CRONUS].[dbo].[$ndo$textlookup] L WHERE L.TextHash = @0")).toBe(true);
  });
  test("detects UPDATE statements", () => {
    expect(isSqlStatement('UPDATE dbo."Table" SET "Field"=@0')).toBe(true);
  });
  test("detects IF EXISTS(SELECT", () => {
    expect(isSqlStatement("IF EXISTS(SELECT TOP 1 NULL FROM dbo.\"Table\")")).toBe(true);
  });
  test("detects INSERT statements", () => {
    expect(isSqlStatement("INSERT INTO dbo.\"Table\" (\"Field\") VALUES (@0)")).toBe(true);
  });
  test("detects DELETE statements", () => {
    expect(isSqlStatement("DELETE FROM dbo.\"Table\" WHERE \"Field\"=@0")).toBe(true);
  });
  test("detects EXEC statements", () => {
    expect(isSqlStatement("EXEC sp_rename @objname, @newname")).toBe(true);
  });
  test("detects BEGIN statements", () => {
    expect(isSqlStatement("BEGIN TRANSACTION")).toBe(true);
  });
  test("rejects AL function names", () => {
    expect(isSqlStatement("AnalyzeBatch")).toBe(false);
    expect(isSqlStatement("OnBeforeReleaseSalesDoc")).toBe(false);
  });
});

describe("truncateFunctionName", () => {
  test("truncates long SQL", () => {
    const sql = "SELECT " + "A".repeat(200);
    const result = truncateFunctionName(sql, 120);
    expect(result.length).toBe(121); // 120 + ellipsis char
    expect(result.endsWith("\u2026")).toBe(true);
  });
  test("leaves short strings alone", () => {
    expect(truncateFunctionName("AnalyzeBatch")).toBe("AnalyzeBatch");
  });
  test("leaves non-SQL long strings alone", () => {
    const longName = "A".repeat(200);
    expect(truncateFunctionName(longName)).toBe(longName);
  });
  test("leaves short SQL alone", () => {
    expect(truncateFunctionName("SELECT * FROM Table")).toBe("SELECT * FROM Table");
  });
  test("respects custom maxLen", () => {
    const sql = "SELECT " + "B".repeat(100);
    const result = truncateFunctionName(sql, 50);
    expect(result.length).toBe(51);
    expect(result.endsWith("\u2026")).toBe(true);
  });
});
