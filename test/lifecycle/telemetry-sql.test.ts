import { describe, expect, test } from "bun:test";
import {
	parseAlStackFrame,
	redactSqlForSink,
	telemetryRoutineKey,
} from "../../src/lifecycle/telemetry-sql.js";

describe("parseAlStackFrame", () => {
	test("extracts the method from the first AL CallStack frame", () => {
		const stack =
			'AppObjectType: CodeUnit\r\nAppObjectId: 80\r\nAL CallStack: "Sales-Post"(CodeUnit 80).PostLines line 42 - Base Application by Microsoft';
		expect(parseAlStackFrame(stack)).toBe("PostLines");
	});

	test("takes the FIRST frame when several are present", () => {
		const stack =
			'AL CallStack: "Sales-Post"(CodeUnit 80).PostLines line 42\r\n"Sales-Post"(CodeUnit 80).OnRun line 7';
		expect(parseAlStackFrame(stack)).toBe("PostLines");
	});

	test("handles a trigger frame", () => {
		const stack =
			'AppObjectType: Table\r\nAL CallStack: "Sales Line"(Table 37).OnValidate line 3 - Base Application';
		expect(parseAlStackFrame(stack)).toBe("OnValidate");
	});

	test("returns null for a header-only stack — the bug this replaces", () => {
		expect(
			parseAlStackFrame("AppObjectType: Report\r\nAppObjectId: 840"),
		).toBeNull();
	});

	test("returns null for empty input", () => {
		expect(parseAlStackFrame("")).toBeNull();
	});

	test("regression: rejects fake frames before AL CallStack marker", () => {
		const stack =
			'AppObjectType: Table\r\n  AppObjectId: 50100\r\n  SomeHeader: "Fake Name"(Table 1).NotTheRealMethod\r\n  AL CallStack: "Sample Job"(Table 50100).Run line 60 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("Run");
	});

	test("regression: handles Report as object type", () => {
		const stack =
			'AL CallStack: "Sales Report"(Report 50200).OnPreReport line 10';
		expect(parseAlStackFrame(stack)).toBe("OnPreReport");
	});

	test("regression: extracts method names with digits and underscores", () => {
		const stack =
			'AL CallStack: "Post Mgmt"(CodeUnit 50400).Post_Line2 line 25 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("Post_Line2");
	});

	test("regression: handles object names with dots and parentheses", () => {
		const stack =
			'AL CallStack: "CTS-SYS Send (Daily) Tel."(CodeUnit 50300).Emit line 15 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("Emit");
	});

	test("regression: takes first frame after marker even if inline frame absent", () => {
		const stack =
			'AppObjectType: Report\r\nAppObjectId: 840\r\nAL CallStack:\r\n"Report Handler"(CodeUnit 50500).ProcessReport line 30 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("ProcessReport");
	});
});

describe("telemetryRoutineKey", () => {
	test("is stable across object-type casing and trigger spelling", () => {
		const a = telemetryRoutineKey("ABC", "CodeUnit", 80, "OnRun");
		const b = telemetryRoutineKey("abc", "codeunit", 80, "onrun");
		expect(a).toBe(b);
	});

	test("distinguishes different routines on the same object", () => {
		expect(telemetryRoutineKey("abc", "CodeUnit", 80, "PostLines")).not.toBe(
			telemetryRoutineKey("abc", "CodeUnit", 80, "PostHeader"),
		);
	});

	test("distinguishes different objects", () => {
		expect(telemetryRoutineKey("abc", "CodeUnit", 80, "OnRun")).not.toBe(
			telemetryRoutineKey("abc", "CodeUnit", 81, "OnRun"),
		);
	});

	test("does NOT include the signal id — RT0005 evidence must reach RT0018 findings", () => {
		// Same routine, different signals => same key by construction: the key
		// takes no signalId parameter at all.
		expect(telemetryRoutineKey.length).toBe(4);
	});

	test("regression: unit separator prevents pipe-based collisions", () => {
		// If the separator were `"|"`, these two genuinely different routines
		// would collide: routine1 has objectType="x|customtype", routine2 has
		// appId="abc|x" and objectType="customtype". Both types are unrecognized
		// by canonicalObjectType, so they pass through unchanged; both appIds
		// are lowercase, so normalizeAppGuid is a no-op. Under `"|"` join, both
		// produce "abc|x|customtype|80|onrun". The unit separator ("\u001f")
		// cannot occur in AL identifiers, GUIDs, or paths, so field boundaries
		// are preserved and they produce different keys.
		const routine1 = telemetryRoutineKey("abc", "x|customtype", 80, "OnRun");
		const routine2 = telemetryRoutineKey("abc|x", "customtype", 80, "OnRun");
		expect(routine1).not.toBe(routine2);
	});
});

describe("redactSqlForSink", () => {
	test("strips the company prefix and keeps the logical table", () => {
		const out = redactSqlForSink(
			'SELECT "No_" FROM dbo."CRONUS Danmark A_S$Sales Header" WHERE "No_"=@0',
		);
		expect(out?.table).toBe("Sales Header");
		expect(out?.text).not.toContain("CRONUS");
	});

	test("strips the database name from a 3-part reference", () => {
		const out = redactSqlForSink(
			'SELECT "No_" FROM "SQLDATABASE".dbo."CRONUS$Sales Header"',
		);
		expect(out?.text).not.toContain("SQLDATABASE");
		expect(out?.text).not.toContain("CRONUS");
	});

	test("strips the company from EVERY reference, not just the first", () => {
		const out = redactSqlForSink(
			'SELECT a."No_" FROM dbo."CRONUS$Sales Header" a JOIN dbo."CRONUS$Sales Line" b ON a."No_"=b."Document No_"',
		);
		expect(out?.text).not.toContain("CRONUS");
		expect(out?.text).toContain("Sales Line");
	});

	test("blanks string, unicode and hex literals", () => {
		const out = redactSqlForSink(
			'SELECT * FROM dbo."CRONUS$Cust" WHERE "Name"=\'Acme Ltd\' AND "X"=N\'Ünïcode\' AND "B"=0xDEADBEEF',
		);
		expect(out?.text).not.toContain("Acme");
		expect(out?.text).not.toContain("nïcode");
		expect(out?.text).not.toContain("DEADBEEF");
	});

	test("collapses a long column list and reports the count", () => {
		const cols = Array.from({ length: 47 }, (_, i) => `"F${i}"`).join(",");
		const out = redactSqlForSink(`SELECT ${cols} FROM dbo."CRONUS$Sales Line"`);
		expect(out?.columnCount).toBe(47);
		expect(out?.text).toContain("+42 more");
	});

	test("strips comments", () => {
		const out = redactSqlForSink(
			'SELECT "No_" /* customer ACME wants this */ FROM dbo."CRONUS$Cust"',
		);
		expect(out?.text).not.toContain("ACME");
	});

	test("drops the trailing partial of a truncated statement and flags it", () => {
		const out = redactSqlForSink(
			'SELECT * FROM dbo."CRONUS$Cust" WHERE "Name"=\'Acme Lt',
		);
		expect(out?.truncated).toBe(true);
		expect(out?.text).not.toContain("Acme");
	});

	test("strips the company from an aliased FROM while keeping alias-qualified columns", () => {
		// The shape Gate 0 found in real RT0005 rows: the company-prefixed
		// physical name is in the FROM clause, and the projection references a
		// numeric table alias.
		const out = redactSqlForSink(
			'SELECT TOP (1) "50102"."timestamp","50102"."Store No_" FROM dbo."CRONUS$Sample Table$aa11bb22-cc33-dd44-ee55-ff6677889900" "50102" WITH(READUNCOMMITTED)',
		);
		expect(out?.text).not.toContain("CRONUS");
		expect(out?.table).toBe("Sample Table");
		expect(out?.extensionAppId).toBe("aa11bb22-cc33-dd44-ee55-ff6677889900");
	});

	test("keeps a system table's bracket name", () => {
		const out = redactSqlForSink(
			"SELECT [Metadata] FROM dbo.[Application Object Metadata]",
		);
		expect(out?.table).toBe("Application Object Metadata");
	});

	test("fails CLOSED on input the tokenizer cannot parse", () => {
		expect(
			redactSqlForSink('SELECT "unterminated identifier FROM x'),
		).toBeNull();
	});

	test("does not miscount a truncation flag when an apostrophe is inside a comment", () => {
		// Regression: a naive quote-parity truncation guess (counting raw `'`
		// characters) sees the odd apostrophe count from "customer's" and
		// wrongly flags this as truncated, then chops the string at that
		// apostrophe -- losing the real FROM clause. A tokenizer-based check
		// skips over the comment entirely and gets this right.
		const out = redactSqlForSink(
			'SELECT "No_" /* it\'s a customer\'s note */ FROM dbo."CRONUS$Cust"',
		);
		expect(out?.truncated).toBe(false);
		expect(out?.table).toBe("Cust");
		expect(out?.text).not.toContain("CRONUS");
	});

	test("resolves a 2-part Table$guid (DataPerCompany=false) to the table, not the guid", () => {
		const out = redactSqlForSink(
			'SELECT "No_" FROM dbo."Sample Table$aa11bb22-cc33-dd44-ee55-ff6677889900"',
		);
		expect(out?.table).toBe("Sample Table");
		expect(out?.text).toContain("Sample Table");
		expect(out?.text).not.toContain("aa11bb22");
	});

	test("C1: strips a quoted/bracketed database or server qualifier regardless of joiner spelling", () => {
		const doubleQuotedDbo = redactSqlForSink(
			'SELECT "No_" FROM "SQLDATABASE"."dbo"."CRONUS$Sales Header"',
		);
		expect(doubleQuotedDbo?.text).not.toContain("SQLDATABASE");
		expect(doubleQuotedDbo?.text).not.toContain("CRONUS");

		const bracketedDbo = redactSqlForSink(
			"SELECT [No_] FROM [SQLDATABASE].[dbo].[CRONUS$Sales Header]",
		);
		expect(bracketedDbo?.text).not.toContain("SQLDATABASE");
		expect(bracketedDbo?.text).not.toContain("CRONUS");

		const serverDbDbo = redactSqlForSink(
			'SELECT "a"  FROM "SRV"."SQLDATABASE".dbo."CRONUS$T"',
		);
		expect(serverDbDbo?.text).not.toContain("SRV");
		expect(serverDbDbo?.text).not.toContain("SQLDATABASE");
		expect(serverDbDbo?.text).not.toContain("CRONUS");

		const insertStatement = redactSqlForSink(
			'INSERT INTO "SQLDATABASE"."dbo"."CRONUS$Sales Line" ("a") VALUES (1)',
		);
		expect(insertStatement?.text).not.toContain("SQLDATABASE");
		expect(insertStatement?.text).not.toContain("CRONUS");

		// A non-"dbo" bare schema: our own scan recognizes ANY bareword between
		// dots as a qualifier joiner and correctly resolves the table to
		// "Sales Header", but parseSqlTable's QUALIFIER only recognizes "dbo"
		// as a bare schema (src/core/sql-node.ts) -- it mis-parses "myschema"
		// into its bare-match fallback and disagrees with our own table name
		// (see the C5 cross-check below). That disagreement is itself a
		// signal parseSqlTable's capture can't be trusted here, so the whole
		// statement fails closed rather than emit a `table` that might be a
		// mis-parsed fragment.
		const nonDboSchema = redactSqlForSink(
			'SELECT "No_" FROM "SQLDATABASE".myschema."CRONUS$Sales Header"',
		);
		expect(nonDboSchema).toBeNull();
	});

	test("C2: $-splits the table field even when the physical name is bracket-quoted", () => {
		const plainDbo = redactSqlForSink(
			"SELECT [a] FROM dbo.[CRONUS Danmark A_S$Sales Header]",
		);
		expect(plainDbo?.table).toBe("Sales Header");
		expect(plainDbo?.table).not.toContain("CRONUS");

		const bracketedDbo = redactSqlForSink(
			"SELECT [a] FROM [dbo].[CRONUS Danmark A_S$Sales Header]",
		);
		expect(bracketedDbo?.table).toBe("Sales Header");
		expect(bracketedDbo?.table).not.toContain("CRONUS");

		const withGuid = redactSqlForSink(
			"SELECT [a] FROM dbo.[CRONUS$Sample Table$aa11bb22-cc33-dd44-ee55-ff6677889900]",
		);
		expect(withGuid?.table).toBe("Sample Table");
		expect(withGuid?.table).not.toContain("CRONUS");
	});

	test("C3: fails CLOSED on a 3-part identifier whose 3rd segment isn't a GUID", () => {
		// "ACME$HOLDING$Sales Header" has no GUID anywhere in it -- parts[1]
		// ("HOLDING") is just as likely a second company-name fragment as a
		// real table, so this must drop the whole statement rather than guess.
		const out = redactSqlForSink(
			'SELECT "No_" FROM dbo."ACME$HOLDING$Sales Header"',
		);
		expect(out).toBeNull();
	});

	test("C4: fails CLOSED on a bare (unquoted) $-prefixed identifier", () => {
		expect(
			redactSqlForSink("SELECT * FROM dbo.CRONUS$Sales_Header WHERE No_=@0"),
		).toBeNull();

		// The FROM reference is quoted and would otherwise redact cleanly, but
		// the bare ORDER BY reference to the same table must still sink the
		// whole statement -- never emit a half-redacted result.
		expect(
			redactSqlForSink(
				'SELECT * FROM dbo."CRONUS$Cust" ORDER BY dbo.CRONUS$Cust.No_',
			),
		).toBeNull();

		expect(
			redactSqlForSink("INSERT INTO dbo.CRONUS$Sales_Line (a) VALUES (1)"),
		).toBeNull();
	});

	test("C5: handles the \"\" escape inside a quoted identifier", () => {
		// Before the fix the "" branch stopped scanning at the FIRST quote
		// character, treating "CRONUS" as a complete (unescaped) identifier
		// and leaking it -- both in `text` and in `table` (parseSqlTable has
		// the same escape blind spot and mis-parses the same way, so its
		// capture disagrees with our own correctly-scanned table name; that
		// disagreement itself fails the whole statement closed rather than
		// emit two different "table names" for the same reference).
		const embeddedX = redactSqlForSink(
			'SELECT "No_" FROM dbo."CRONUS""X$Sales Header" WHERE "Name"=\'Acme Ltd\'',
		);
		expect(embeddedX).toBeNull();

		const embeddedCompany = redactSqlForSink(
			'SELECT "a" FROM dbo."ACME HOLDING""$Sales Header"',
		);
		expect(embeddedCompany).toBeNull();
	});

	test("C6: fails CLOSED on an unmatched [ or \" that swallows clause text, not just by luck", () => {
		// Before the fix, an unmatched `[` or `"` scanned forward to the FIRST
		// unrelated close character it found (here, a `]` or `"` that's really
		// part of a string literal or a later clause) and echoed everything in
		// between as one "identifier" -- literal values included. The
		// pre-existing "fails CLOSED" test at the top of this describe block
		// only happens to pass because its input has no second `"` anywhere;
		// these inputs DO have a second delimiter, so a naive re-check of that
		// same property would wrongly call them safe.
		const bracketSwallowsLiteral = redactSqlForSink(
			`SELECT [a FROM dbo."ACMECORP" WHERE "N"='Secret]'`,
		);
		expect(bracketSwallowsLiteral).toBeNull();

		const bracketSwallowsStatement = redactSqlForSink(
			"SELECT [a FROM dbo.\"CRONUS$Cust\" WHERE \"N\"=@0 AND [b]",
		);
		expect(bracketSwallowsStatement).toBeNull();

		const quoteSwallowsStatement = redactSqlForSink(
			'SELECT "a FROM dbo."CRONUS$Cust" WHERE "Name"=@0',
		);
		expect(quoteSwallowsStatement).toBeNull();
	});

	test("minor: re-escapes a literal ] when re-emitting a bracket identifier", () => {
		// The column list identifier below has no $, so it survives
		// logicalIdentifier unchanged: "a]b" (a physical name legitimately
		// containing a literal "]", escaped as "]]" in the wire text). Without
		// re-doubling it on the way back out, "[a]b]" would close the bracket
		// one character early -- malformed SQL, not just a leak.
		const out = redactSqlForSink("SELECT [a]]b] FROM dbo.[Cust]");
		expect(out?.text).toBe("SELECT [a]]b] FROM dbo.[Cust]");
	});

	test("minor: returns null when no operation classifies, including empty input", () => {
		expect(redactSqlForSink("")).toBeNull();
	});
});
