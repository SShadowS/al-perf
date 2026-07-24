import { describe, expect, test } from "bun:test";
import {
	classifySqlOperation,
	hasAggregate,
	hasReadUncommitted,
	isSqlFunctionName,
	normalizeSqlShape,
	parseSqlTable,
} from "../../src/core/sql-node.js";

describe("isSqlFunctionName", () => {
	test("matches SQL statements", () => {
		expect(isSqlFunctionName('SELECT COUNT(*) FROM dbo."X" WHERE a=@0')).toBe(
			true,
		);
		expect(isSqlFunctionName('UPDATE dbo."X" SET "Status"=@0')).toBe(true);
		expect(isSqlFunctionName("insert into t values (1)")).toBe(true);
	});
	test("rejects AL routine names", () => {
		expect(isSqlFunctionName("ReleaseSalesDocument")).toBe(false);
		expect(isSqlFunctionName("OnRun")).toBe(false);
		expect(isSqlFunctionName("SelectLatestVersion")).toBe(false); // no word-boundary false positive
	});
});

describe("classifySqlOperation", () => {
	test("classifies each op", () => {
		expect(classifySqlOperation('SELECT TOP (1) "A" FROM dbo."T"')).toBe(
			"SELECT",
		);
		expect(classifySqlOperation('SELECT COUNT(*) FROM dbo."T"')).toBe("COUNT");
		expect(classifySqlOperation('INSERT INTO dbo."T" (A) VALUES (@0)')).toBe(
			"INSERT",
		);
		expect(classifySqlOperation('UPDATE dbo."T" SET A=@0')).toBe("UPDATE");
		expect(classifySqlOperation('DELETE FROM dbo."T" WHERE A=@0')).toBe(
			"DELETE",
		);
		expect(classifySqlOperation('MERGE INTO dbo."T" USING ...')).toBe("OTHER");
	});
});

describe("hasReadUncommitted / hasAggregate", () => {
	test("detects hints and aggregates", () => {
		expect(
			hasReadUncommitted('SELECT * FROM dbo."T" WITH(READUNCOMMITTED)'),
		).toBe(true);
		expect(hasReadUncommitted('SELECT * FROM dbo."T"')).toBe(false);
		expect(hasAggregate('SELECT SUM("Amount") FROM dbo."T"')).toBe(true);
		expect(hasAggregate('SELECT COUNT(*) FROM dbo."T"')).toBe(true);
		expect(hasAggregate('SELECT "Amount" FROM dbo."T"')).toBe(false);
	});
});

describe("normalizeSqlShape", () => {
	test("blanks string and numeric literals, keeps @params", () => {
		expect(
			normalizeSqlShape(`SELECT * FROM t WHERE "No."='C10' AND x=42`),
		).toBe(`SELECT * FROM t WHERE "No."='?' AND x=?`);
		expect(normalizeSqlShape(`WHERE a=@0 AND b=@1`)).toBe(
			`WHERE a=@0 AND b=@1`,
		);
	});
	test("identical shapes with different literals collapse", () => {
		const a = normalizeSqlShape(`SELECT * FROM t WHERE "No."='C10'`);
		const b = normalizeSqlShape(`SELECT * FROM t WHERE "No."='C20'`);
		expect(a).toBe(b);
	});
	test("escaped quotes inside strings", () => {
		expect(normalizeSqlShape(`WHERE name='O''Brien'`)).toBe(`WHERE name='?'`);
	});
});

describe("parseSqlTable", () => {
	const GUID = "437dbf0e-84ff-417a-965d-ed2bb9650972";
	test("Company$Table (the bug the old parser had)", () => {
		expect(
			parseSqlTable(
				`SELECT COUNT(*) FROM dbo."CRONUS Danmark A_S$Sales Header" WITH(READUNCOMMITTED)`,
			),
		).toEqual({ table: "Sales Header", extensionAppId: null });
	});
	test("Company$Table$guid extension table", () => {
		expect(
			parseSqlTable(
				`DELETE FROM dbo."CRONUS Danmark A_S$Cash Flow Entry$${GUID}"`,
			),
		).toEqual({ table: "Cash Flow Entry", extensionAppId: GUID });
	});
	test("Table$guid without company (DataPerCompany=false)", () => {
		expect(parseSqlTable(`SELECT * FROM dbo."Tenant Media$${GUID}"`)).toEqual({
			table: "Tenant Media",
			extensionAppId: GUID,
		});
	});
	test("bracket-quoted system table, no split", () => {
		expect(
			parseSqlTable(
				`SELECT [Metadata] FROM dbo.[Application Object Metadata] WHERE x=@0`,
			),
		).toEqual({ table: "Application Object Metadata", extensionAppId: null });
	});
	test("plain name without company", () => {
		expect(parseSqlTable(`SELECT * FROM dbo."Sales Line"`)).toEqual({
			table: "Sales Line",
			extensionAppId: null,
		});
	});
	test("UPDATE / INSERT INTO forms", () => {
		expect(
			parseSqlTable(`UPDATE dbo."C$Sales Header" SET "Status"=@0`),
		).toEqual({
			table: "Sales Header",
			extensionAppId: null,
		});
		expect(
			parseSqlTable(`INSERT INTO dbo."C$Sales Line" (A) VALUES (@0)`),
		).toEqual({
			table: "Sales Line",
			extensionAppId: null,
		});
	});
	test("malformed / >3 segments -> null (unparseable fallback)", () => {
		expect(parseSqlTable(`SELECT * FROM dbo."a$b$c$d"`)).toEqual({
			table: null,
			extensionAppId: null,
		});
		expect(parseSqlTable(`SELECT * FROM dbo."a$b$not-a-guid"`)).toEqual({
			table: null,
			extensionAppId: null,
		});
	});
	test("no FROM target -> null", () => {
		expect(parseSqlTable(`SELECT @@SPID`)).toEqual({
			table: null,
			extensionAppId: null,
		});
	});
	test("parses a 3-part database-qualified name", () => {
		const sql =
			'SELECT "No_" FROM "SQLDATABASE".dbo."CRONUS Danmark A_S$Sales Header" WITH(READUNCOMMITTED)';
		expect(parseSqlTable(sql)).toEqual({
			table: "Sales Header",
			extensionAppId: null,
		});
	});
	test("parses a 3-part name carrying an extension guid", () => {
		const sql =
			'SELECT "No_" FROM "SQLDATABASE".dbo."CRONUS$My Table$aa11bb22-cc33-dd44-ee55-ff6677889900"';
		expect(parseSqlTable(sql)).toEqual({
			table: "My Table",
			extensionAppId: "aa11bb22-cc33-dd44-ee55-ff6677889900",
		});
	});
	test("still parses the plain 2-part form", () => {
		const sql = 'SELECT "No_" FROM dbo."CRONUS Danmark A_S$Sales Header"';
		expect(parseSqlTable(sql)).toEqual({
			table: "Sales Header",
			extensionAppId: null,
		});
	});
});
