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
		// The marker alone isn't proof the columns were actually dropped — an
		// implementation that emitted all 47 names AND the marker would also
		// pass the assertion above. Pin that the kept columns (F0-F4) survive
		// and a dropped one (F46) doesn't.
		expect(out?.text).toContain('"F4"');
		expect(out?.text).not.toContain('"F46"');
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

	test('C5: handles the "" escape inside a quoted identifier', () => {
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

	test('C6: fails CLOSED on an unmatched [ or " that swallows clause text, not just by luck', () => {
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
			'SELECT [a FROM dbo."CRONUS$Cust" WHERE "N"=@0 AND [b]',
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

	describe("Fix Round 1b", () => {
		test("I1: UPDATE keeps the WHERE predicate and marks the collapsed SET columns", () => {
			// Before the fix: namedColumns counted the target table AND every
			// WHERE-clause identifier too (UPDATE has no "FROM" to gate the
			// old `seenFrom` flag), so both the tail SET columns AND the WHERE
			// predicate vanished with no "+N more" marker anywhere.
			const out = redactSqlForSink(
				'UPDATE dbo."CRONUS Danmark A_S$Sales Header" SET "C1"=\'a\',"C2"=\'b\',"C3"=\'c\',"C4"=\'d\',"C5"=\'e\',"C6"=\'f\',"C7"=\'g\',"C8"=\'SECRET\' WHERE "No_"=\'X\'',
			);
			expect(out?.table).toBe("Sales Header");
			expect(out?.columnCount).toBe(8); // C1-C8, NOT the target table
			expect(out?.text).toContain("…+3 more");
			expect(out?.text).toContain('WHERE "No_"=\'?\'');
			expect(out?.text).not.toContain("SECRET");
			expect(out?.text).not.toContain("CRONUS");
		});

		test("I1: INSERT marks the collapsed column list instead of silently dropping it", () => {
			// Before the fix: the marker-insertion regex only ever matched a
			// bare "FROM" keyword, which an INSERT statement doesn't have —
			// so columns past MAX_NAMED_COLUMNS vanished with no marker, and
			// the VALUES list (including a literal) was untouched.
			const out = redactSqlForSink(
				'INSERT INTO dbo."CRONUS$Sales Line" ("a","b","c","d","e","f","g","h") VALUES (1,2,3,4,5,6,7,\'ACME\')',
			);
			expect(out?.table).toBe("Sales Line");
			expect(out?.columnCount).toBe(8); // a-h, NOT the target table
			expect(out?.text).toContain("…+3 more");
			expect(out?.text).not.toContain("ACME");
			expect(out?.text).not.toContain("CRONUS");
		});

		test("I1: does not splice the marker inside a redacted identifier's own text", () => {
			// The pre-fix marker was `out.replace(/\bFROM\b/i, ...)` run over
			// the FINISHED string — matching the first "FROM" anywhere,
			// including one that landed inside an already-emitted identifier
			// (e.g. a column literally containing the word "from"). The fix
			// splices a sentinel live, during the tokenizer loop, at the
			// point the real FROM keyword is scanned — so it can only ever
			// land at the real clause boundary.
			const cols = ["NumFrom1", "F1", "F2", "F3", "F4", "F5"]
				.map((c) => `"${c}"`)
				.join(",");
			const out = redactSqlForSink(`SELECT ${cols} FROM dbo."CRONUS$Cust"`);
			expect(out?.text).toContain('"NumFrom1"');
			expect(out?.text).toContain("…+1 more FROM");
			// The marker must precede the REAL "FROM", not sit mid-identifier.
			expect(out?.text?.indexOf("…+1 more")).toBeLessThan(
				out?.text?.indexOf("FROM") ?? -1,
			);
		});

		test("I2: preserves digits inside a retained identifier's own name", () => {
			// Before the fix, the numeric-blanking pass ran as a blind
			// text-level sweep over the WHOLE reassembled string, so a
			// perfectly ordinary BC column name containing a digit came out
			// mangled: "Shortcut Dimension 1 Code" -> "Shortcut Dimension ?
			// Code".
			const out = redactSqlForSink(
				'SELECT "Shortcut Dimension 1 Code","Amount 2" FROM dbo."CRONUS$Cust"',
			);
			expect(out?.text).toContain('"Shortcut Dimension 1 Code"');
			expect(out?.text).toContain('"Amount 2"');
		});

		test("I2: still blanks a bare numeric literal or hex value outside any identifier", () => {
			const out = redactSqlForSink(
				'SELECT "No_" FROM dbo."CRONUS$Cust" WHERE "Qty">5 AND "B"=0xDEADBEEF',
			);
			expect(out?.text).toContain('"Qty">?');
			expect(out?.text).not.toContain("DEADBEEF");
			expect(out?.text).toContain('"B"=?');
		});

		test("I2: no longer mangles a purely-numeric table alias (real RT0005 shape)", () => {
			// Companion fix to the identifier-digit case above: a numeric
			// alias IS emitted from an ident token too, so the same rule
			// (blank `other`-token text only) now leaves it intact. This is
			// a fidelity improvement, not a new leak -- a positional alias
			// carries no customer data.
			const out = redactSqlForSink(
				'SELECT TOP (1) "50102"."timestamp","50102"."Store No_" FROM dbo."CRONUS$Sample Table$aa11bb22-cc33-dd44-ee55-ff6677889900" "50102" WITH(READUNCOMMITTED)',
			);
			expect(out?.text).toContain('"50102"');
			expect(out?.text).toContain("TOP (?)"); // the LITERAL "1" is still blanked
		});

		test("I3: sql.length hitting the platform's 8192-char cap flags truncation even at a clean token boundary", () => {
			// No unterminated literal/comment here for tokenize()'s own signal
			// to catch -- the cut lands right after a bare "1" digit. Length
			// hitting BC's own documented emission cap is independent
			// evidence the platform cut this short, which tokenize() alone
			// can't see.
			const prefix = 'SELECT "No_" FROM dbo."CRONUS$Cust" WHERE ';
			let sql = prefix;
			while (sql.length < 8192) sql += "AND 1=1 ";
			sql = sql.slice(0, 8192);
			expect(sql.length).toBe(8192);
			expect(redactSqlForSink(sql)?.truncated).toBe(true);
		});

		test("I3: does not flag an ordinary short statement as truncated just because it ends after WHERE", () => {
			const out = redactSqlForSink('SELECT * FROM dbo."CRONUS$Cust" WHERE');
			expect(out?.truncated).toBe(false);
		});

		test("I3: 8191 chars (one under the cap) is not flagged; 8192 is", () => {
			const prefix = 'SELECT "No_" FROM dbo."CRONUS$Cust" WHERE ';
			const build = (len: number) => {
				let sql = prefix;
				while (sql.length < len) sql += "AND 1=1 ";
				return sql.slice(0, len);
			};
			expect(redactSqlForSink(build(8191))?.truncated).toBe(false);
			expect(redactSqlForSink(build(8192))?.truncated).toBe(true);
		});

		test("corpus gap: UPDATE without a collapsed column list", () => {
			const out = redactSqlForSink(
				'UPDATE dbo."CRONUS$Cust" SET "Name"=\'Acme Ltd\' WHERE "No_"=\'X\'',
			);
			expect(out?.operation).toBe("UPDATE");
			expect(out?.table).toBe("Cust");
			expect(out?.columnCount).toBeNull();
			expect(out?.text).toBe('UPDATE dbo."Cust" SET "Name"=\'?\' WHERE "No_"=\'?\'');
		});

		test("corpus gap: INSERT without a collapsed column list", () => {
			const out = redactSqlForSink(
				'INSERT INTO dbo."CRONUS$Cust" ("No_","Name") VALUES (\'X\',\'Acme Ltd\')',
			);
			expect(out?.operation).toBe("INSERT");
			expect(out?.table).toBe("Cust");
			expect(out?.columnCount).toBeNull();
			expect(out?.text).toBe(
				'INSERT INTO dbo."Cust" ("No_","Name") VALUES (\'?\',\'?\')',
			);
		});

		test("corpus gap: DELETE strips the company and keeps the WHERE predicate", () => {
			const out = redactSqlForSink(
				'DELETE FROM dbo."CRONUS$Cust" WHERE "Name"=\'Acme Ltd\'',
			);
			expect(out?.operation).toBe("DELETE");
			expect(out?.table).toBe("Cust");
			expect(out?.columnCount).toBeNull();
			expect(out?.text).toBe('DELETE FROM dbo."Cust" WHERE "Name"=\'?\'');
		});

		test("corpus gap: MERGE is not a classified operation — fails closed", () => {
			// classifySqlOperation (src/core/sql-node.ts) has no MERGE case in
			// its switch; SQL_PREFIX_RE matches the keyword but the switch's
			// default bucket is "OTHER", which redactSqlForSink already
			// treats as unclassifiable. Pinning this so a future widening of
			// classifySqlOperation doesn't silently start emitting redacted
			// MERGE text without a corresponding test here.
			const out = redactSqlForSink(
				'MERGE INTO dbo."CRONUS$Cust" AS t USING dbo."CRONUS$Staging" AS s ON t."No_"=s."No_" WHEN MATCHED THEN UPDATE SET t."Name"=s."Name";',
			);
			expect(out).toBeNull();
		});
	});
});
