import { describe, expect, test } from "bun:test";
import {
	isSqlStatement,
	truncateFunctionName,
} from "../../src/core/display-utils.js";

describe("isSqlStatement", () => {
	test("detects SELECT statements", () => {
		expect(
			isSqlStatement(
				"SELECT L.Text FROM [CRONUS].[dbo].[$ndo$textlookup] L WHERE L.TextHash = @0",
			),
		).toBe(true);
	});
	test("detects UPDATE statements", () => {
		expect(isSqlStatement('UPDATE dbo."Table" SET "Field"=@0')).toBe(true);
	});
	test("detects IF EXISTS(SELECT", () => {
		expect(
			isSqlStatement('IF EXISTS(SELECT TOP 1 NULL FROM dbo."Table")'),
		).toBe(true);
	});
	test("detects INSERT statements", () => {
		expect(
			isSqlStatement('INSERT INTO dbo."Table" ("Field") VALUES (@0)'),
		).toBe(true);
	});
	test("detects DELETE statements", () => {
		expect(isSqlStatement('DELETE FROM dbo."Table" WHERE "Field"=@0')).toBe(
			true,
		);
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
		expect(truncateFunctionName("SELECT * FROM Table")).toBe(
			"SELECT * FROM Table",
		);
	});
	test("respects custom maxLen", () => {
		const sql = "SELECT " + "B".repeat(100);
		const result = truncateFunctionName(sql, 50);
		expect(result.length).toBe(51);
		expect(result.endsWith("\u2026")).toBe(true);
	});
});

describe("isSqlStatement — BC's own elided form", () => {
	test("recognizes a statement BC has already elided", () => {
		// BC emits `SELECT...WHERE (...)` — keyword, then punctuation, no space.
		// Requiring a space after the keyword missed every one of these, so no
		// formatter truncated them.
		expect(
			isSqlStatement('SELECT...WHERE ("Sales Line$0"."Document Type"=@0)'),
		).toBe(true);
		expect(
			truncateFunctionName("SELECT...WHERE (x)".repeat(20), 60).length,
		).toBe(61);
	});

	test("still recognizes the ordinary spaced forms", () => {
		expect(isSqlStatement("SELECT [a] FROM dbo.[T]")).toBe(true);
		expect(isSqlStatement("INSERT INTO dbo.[T] VALUES (1)")).toBe(true);
		expect(isSqlStatement("IF EXISTS(SELECT TOP 1 NULL FROM x)")).toBe(true);
	});

	test("does not mistake an AL method for SQL", () => {
		// A method named Select/Update/Deleted must not be truncated as SQL.
		expect(isSqlStatement("ProcessLine")).toBe(false);
		expect(isSqlStatement("Selected")).toBe(false);
		expect(isSqlStatement("UpdateAmounts")).toBe(false);
		expect(isSqlStatement("DeleteAll")).toBe(false);
	});
});
