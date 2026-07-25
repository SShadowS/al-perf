import { describe, expect, test } from "bun:test";
import { parseSqlTable } from "../../src/core/sql-node.js";
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
			expect(out?.text).toContain("WHERE \"No_\"='?'");
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

		test("I1: a digit-bearing column survives the collapse, and the marker lands at the real clause boundary", () => {
			// Originally written to pin a hazard the pre-fix marker had: a
			// post-hoc `out.replace(/\bFROM\b/i, ...)` over the FINISHED
			// string could match "FROM" text sitting inside an already
			// company-stripped identifier's value (e.g. a column literally
			// named "Copied From"). Corrected per Fix Round 2 review: that
			// EXACT hazard is now unreachable through this input shape
			// regardless of the marker fix, because C6's
			// sawSwallowedClauseText (see its own doc comment above) already
			// rejects any double-quoted identifier containing a bounded
			// FROM/WHERE/SELECT keyword — same regex family, so any
			// identifier that could fool the old post-hoc regex necessarily
			// trips C6 first and fails tokenize() closed before the marker
			// code is ever reached (`"NumFrom1"` here has no WORD-bounded
			// "From" in it, so it evades C6 and survives to prove the
			// column-collapse machinery itself still works correctly for a
			// digit-bearing name — it does NOT exercise the mid-identifier
			// splice hazard the original comment claimed). The
			// operation-shaped counting window itself (SELECT→FROM,
			// UPDATE→SET/WHERE, INSERT→target-table/")") is what the UPDATE
			// and INSERT tests below actually pin.
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
			// NOT just `.toContain('"50102"')` -- that also matches the
			// trailing STANDALONE alias after the table name, so it would
			// still pass even if the qualifier form `"50102"."Store No_"`
			// (what this test actually means to protect) got corrupted, as
			// it briefly did between Fix Rounds 1b and 2 (NB1: the broadened
			// isDatabaseQualifier ate quoted column qualifiers too). Assert
			// the qualified form explicitly.
			expect(out?.text).toContain('"50102"."timestamp"');
			expect(out?.text).toContain('"50102"."Store No_"');
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

		test('symmetric quote escape: re-escapes a literal " when re-emitting a double-quoted identifier', () => {
			// The `]]` re-escape fixed in Round 1a's minors only covered the
			// bracket delimiter. tokenize() already UN-escapes "" -> " while
			// scanning a `"`-delimited identifier (needed so C5's swallowed-
			// clause-text check sees the real value), so a kept identifier's
			// logical (post-$-split) segment can legitimately carry a bare
			// `"` the same way a bracket identifier carries a bare `]` --
			// e.g. a physical name like `Foo"Bar`, escaped as `Foo""Bar` on
			// the wire. Without re-doubling on the way out, `"Foo"Bar"` closes
			// the identifier one character early: malformed SQL, not a leak,
			// but a corrupted evidence string in the issue tracker either way.
			const out = redactSqlForSink('SELECT "Foo""Bar" FROM dbo."CRONUS$Cust"');
			expect(out?.text).toBe('SELECT "Foo""Bar" FROM dbo."Cust"');
		});

		test("symmetric quote escape: the TABLE reference case fails closed instead (pre-existing C5 cross-check)", () => {
			// Unlike the column case above, an embedded "" in the TABLE
			// reference's segment is already caught: parseSqlTable's own
			// (escape-unaware) capture of the same reference stops at the
			// FIRST "" it sees, disagreeing with our escape-aware scan, and
			// the C5 cross-check (this file's `tableRefLogical !== table`)
			// fails the whole statement closed on that disagreement -- so
			// this shape was never reachable via the table-ref position, only
			// via an ordinary column identifier (covered above).
			const out = redactSqlForSink(
				'SELECT "a" FROM dbo."CRONUS$Sales""Header"',
			);
			expect(out).toBeNull();
		});

		test("corpus gap: UPDATE without a collapsed column list", () => {
			const out = redactSqlForSink(
				'UPDATE dbo."CRONUS$Cust" SET "Name"=\'Acme Ltd\' WHERE "No_"=\'X\'',
			);
			expect(out?.operation).toBe("UPDATE");
			expect(out?.table).toBe("Cust");
			expect(out?.columnCount).toBeNull();
			expect(out?.text).toBe(
				'UPDATE dbo."Cust" SET "Name"=\'?\' WHERE "No_"=\'?\'',
			);
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

		test("corpus gap: MERGE redacts (classifySqlOperation has no MERGE case, but it still isn't dropped)", () => {
			// NB2 (Fix Round 2): classifySqlOperation (src/core/sql-node.ts)
			// has no dedicated MERGE case in its switch, so a MERGE statement
			// classifies as "OTHER" -- but redactSqlForSink's fail-closed
			// gate is keyed on SQL_PREFIX_RE (which DOES recognize MERGE, and
			// sql-node.ts has a dedicated MERGE_MATCHER for its table), not
			// on classifySqlOperation's result, so MERGE is still redacted.
			// Gating on `operation === "OTHER"` here (Round 1b's original
			// take on this test) silently dropped a working statement class
			// with real evidence to redact -- fixed by the team lead's
			// review, not by this task's own author.
			const out = redactSqlForSink(
				'MERGE INTO dbo."CRONUS$Cust" AS t USING dbo."CRONUS$Staging" AS s ON t."No_"=s."No_" WHEN MATCHED THEN UPDATE SET t."Name"=s."Name";',
			);
			expect(out?.operation).toBe("OTHER"); // real, reachable value -- no MERGE case exists in SqlOperation
			expect(out?.table).toBe("Cust");
			expect(out?.text).not.toContain("CRONUS");
			expect(out?.text).toBe(
				'MERGE INTO dbo."Cust" AS t USING dbo."Staging" AS s ON t."No_"=s."No_" WHEN MATCHED THEN UPDATE SET t."Name"=s."Name";',
			);
		});

		test("corpus gap: fails CLOSED on a 4-segment $ identifier (untested since Round 1)", () => {
			// logicalIdentifier's fallback for parts.length >= 4 -- no
			// documented BC physical-name shape has 4 $-segments, so there is
			// no safe guess to make.
			expect(redactSqlForSink('SELECT "No_" FROM dbo."A$B$C$D"')).toBeNull();
		});

		test("corpus gap: local GUID_RE stays in sync with sql-node.ts's copy", () => {
			// telemetry-sql.ts's GUID_RE (used by logicalIdentifier) is a
			// hand-mirrored copy of sql-node.ts's GUID_RE (used by
			// parseSqlTable) -- not imported, per that constant's own doc
			// comment, to keep this module decoupled. Nothing stops the two
			// from drifting apart silently. Neither is exported, so probe
			// both through their public surface (redactSqlForSink here,
			// parseSqlTable directly) with edge cases chosen to trip up a
			// slightly-wrong GUID pattern, and assert they agree on every one
			// about whether the 3rd $-segment counts as a GUID.
			const candidates = [
				"aa11bb22-cc33-dd44-ee55-ff6677889900", // valid, lowercase, dashed
				"AA11BB22-CC33-DD44-EE55-FF6677889900", // valid, uppercase
				"aa11bb22cc33dd44ee55ff6677889900", // valid, undashed (32 hex)
				"aa11bb22-cc33-dd44-ee55-ff667788990", // one char short
				"aa11bb22-cc33-dd44-ee55-ff66778899001", // one char long
				"gg11bb22-cc33-dd44-ee55-ff6677889900", // non-hex char
				"aa11bb22_cc33_dd44_ee55_ff6677889900", // wrong separator
			];
			for (const candidate of candidates) {
				const sql = `SELECT "a" FROM dbo."CRONUS$Table$${candidate}"`;
				const telemetryTreatsAsGuid = redactSqlForSink(sql)?.table === "Table";
				const sqlNodeTreatsAsGuid = parseSqlTable(sql).table === "Table";
				expect(telemetryTreatsAsGuid).toBe(sqlNodeTreatsAsGuid);
			}
		});

		test("probe: strips a -- comment containing quotes without losing the FROM/WHERE clauses", () => {
			const out = redactSqlForSink(
				`SELECT "No_" FROM dbo."CRONUS$Cust" -- customer's "note" with 'quotes'\nWHERE "No_"='X'`,
			);
			expect(out?.table).toBe("Cust");
			expect(out?.text).toBe('SELECT "No_" FROM dbo."Cust" WHERE "No_"=\'?\'');
			expect(out?.text).not.toContain("customer");
			expect(out?.text).not.toContain("note");
		});

		test("probe: strips a -- comment with no trailing newline", () => {
			const out = redactSqlForSink(
				'SELECT "No_" FROM dbo."CRONUS$Cust" -- trailing comment no newline',
			);
			expect(out?.table).toBe("Cust");
			expect(out?.text).toBe('SELECT "No_" FROM dbo."Cust"');
		});

		test("probe: an unterminated /* before the FROM clause truncates before it, safely", () => {
			// The comment swallows everything from its start to end-of-input,
			// including the FROM clause -- table is unresolved, but nothing
			// leaks and truncated is correctly set.
			const out = redactSqlForSink(
				'SELECT "No_" /* comment never closes FROM dbo."CRONUS$Cust"',
			);
			expect(out?.truncated).toBe(true);
			expect(out?.table).toBeNull();
			expect(out?.text).not.toContain("CRONUS");
		});

		test("probe: an unterminated /* after the FROM clause keeps the table, still truncated", () => {
			const out = redactSqlForSink(
				'SELECT "No_" FROM dbo."CRONUS$Cust" /* comment never closes',
			);
			expect(out?.truncated).toBe(true);
			expect(out?.table).toBe("Cust");
			expect(out?.text).toBe('SELECT "No_" FROM dbo."Cust"');
		});

		test("probe: truncation mid-literal is flagged truncated (not a tokenizer failure)", () => {
			const out = redactSqlForSink(
				'SELECT "No_" FROM dbo."CRONUS$Cust" WHERE "Name"=\'Acme Lt',
			);
			expect(out?.truncated).toBe(true);
			expect(out?.text).not.toContain("Acme");
		});

		test("probe: truncation mid-identifier fails CLOSED instead (distinct from mid-literal)", () => {
			// tokenize()'s own doc comment draws this line deliberately: an
			// unterminated quoted/bracketed identifier is "genuinely
			// unparseable" (null), never treated as the truncation-boundary
			// case reserved for an unterminated string literal/block comment.
			const out = redactSqlForSink('SELECT "No_" FROM dbo."CRONUS$Cu');
			expect(out).toBeNull();
		});

		test("probe: an escaped '' inside a literal is fully blanked", () => {
			const out = redactSqlForSink(
				'SELECT "No_" FROM dbo."CRONUS$Cust" WHERE "Name"=\'it\'\'s Acme Ltd\'',
			);
			expect(out?.text).toBe('SELECT "No_" FROM dbo."Cust" WHERE "Name"=\'?\'');
			expect(out?.text).not.toContain("Acme");
		});

		test("probe: a lowercase n'...' string literal is still recognized and blanked", () => {
			// tokenize() only special-cases an uppercase "N" prefix, but a
			// bare `'` alone already starts the SAME literal-scanning branch
			// regardless of what (if anything) precedes it -- the lowercase
			// "n" just passes through as an ordinary character, not a leak,
			// since it carries no customer data on its own.
			const out = redactSqlForSink(
				`SELECT "No_" FROM dbo."CRONUS$Cust" WHERE "Name"=n'Acme'`,
			);
			expect(out?.text).toBe(`SELECT "No_" FROM dbo."Cust" WHERE "Name"=n'?'`);
			expect(out?.text).not.toContain("Acme");
		});

		test("probe: a double-quoted identifier containing a bare ' fails CLOSED by design", () => {
			// C6's sawSwallowedClauseText treats a stray `'` inside a
			// double-quoted identifier as foreign to it (only an embedded `"`
			// via the `""` escape is legitimate there) -- a deliberately
			// conservative fail-closed bias, not a bug, since that shape is
			// indistinguishable from an identifier scan that swallowed past a
			// string literal's boundary.
			const out = redactSqlForSink(`SELECT "O'Brien" FROM dbo."CRONUS$Cust"`);
			expect(out).toBeNull();
		});

		test("probe: a subquery FROM fails CLOSED (table-resolution mismatch, not a crash)", () => {
			// Our tokenizer's own table-ref tracking latches onto the FIRST
			// ident following any FROM/INTO/UPDATE/MERGE keyword, including
			// one inside a subquery's SELECT list -- parseSqlTable's own
			// regex-based capture resolves a DIFFERENT (garbage) value for
			// the same statement, and the existing tableRefLogical-vs-table
			// cross-check fails the whole statement closed on that
			// disagreement. No leak, no crash -- subqueries are simply not a
			// shape this redactor resolves correctly, so it declines to
			// guess.
			const out = redactSqlForSink(
				'SELECT "a" FROM (SELECT "b" FROM dbo."CRONUS$T") x',
			);
			expect(out).toBeNull();
		});

		test("probe: a CTE (WITH ...) fails the SQL_PREFIX_RE gate — fails closed", () => {
			// SQL_PREFIX_RE (src/core/sql-node.ts) only recognizes a
			// statement starting with SELECT/INSERT/UPDATE/DELETE/MERGE; a
			// CTE's leading "WITH" doesn't match. redactSqlForSink's own
			// fail-closed gate is keyed directly on that same regex as of
			// Fix Round 2 (NB2) -- not on classifySqlOperation's result,
			// which would ALSO bucket this as "OTHER" but for the wrong
			// reason (no dedicated WITH/CTE case, same as its missing MERGE
			// case) -- gating on that alone would be right here by accident,
			// the same "false confidence" pattern flagged elsewhere in this
			// file for other checks.
			const out = redactSqlForSink(
				'WITH cte AS (SELECT "a" FROM dbo."CRONUS$T") SELECT "a" FROM cte',
			);
			expect(out).toBeNull();
		});
	});

	describe("Fix Round 2", () => {
		test("NB1: the real RT0005 canonical shape redacts cleanly — quoted alias qualifiers survive intact", () => {
			// Exact string from test/fixtures/telemetry/rt0005-probe.json:36
			// (the live shape Gate 0 found). Before NB1, the broadened
			// isDatabaseQualifier (Fix Round 1b, C1) treated ANY ident
			// immediately followed by ".ident" as a database/server
			// qualifier to drop -- indistinguishable, by shape alone, from a
			// table ALIAS qualifying a column. Every "50102" alias
			// qualifier here was dropped, leaving stray dots
			// (`,."Store No_"`, `(."Store No_"`) that the OLD whitespace-only
			// cleanup regex couldn't clean up either, since a comma or open
			// paren -- not whitespace -- preceded them.
			const canonical =
				'SELECT  TOP (1) "50102"."timestamp","50102"."Store No_","50102"."Terminal No_" FROM dbo."COMPANY$Sample Table$aa11bb22-cc33-dd44-ee55-ff6677889900" "50102" WITH(READUNCOMMITTED) WHERE ("50102"."Store No_"=@0)';
			const out = redactSqlForSink(canonical);
			expect(out?.table).toBe("Sample Table");
			expect(out?.extensionAppId).toBe("aa11bb22-cc33-dd44-ee55-ff6677889900");
			expect(out?.text).not.toContain("COMPANY");
			expect(out?.text).not.toContain(",.");
			expect(out?.text).not.toContain("(.");
			expect(out?.text).toBe(
				'SELECT TOP (?) "50102"."timestamp","50102"."Store No_","50102"."Terminal No_" FROM dbo."Sample Table" "50102" WITH(READUNCOMMITTED) WHERE ("50102"."Store No_"=@0)',
			);
			// The 3 projected columns are alias.column PAIRS, not 6 separate
			// idents -- an alias prefix and the column it qualifies are ONE
			// logical named column (see the pair-counting test below), so
			// this well-under-MAX_NAMED_COLUMNS statement never collapses.
			expect(out?.columnCount).toBeNull();
		});

		test("NB1: a JOIN with QUOTED aliases on both sides of the ON clause keeps both qualifiers", () => {
			// The bare-alias JOIN test earlier in this file ("strips the
			// company from EVERY reference...") never exercised NB1's bug,
			// because unquoted aliases aren't ident tokens at all --
			// isDatabaseQualifier never even runs on them. Quoting the alias
			// (a real, if less common, RT0005 shape) is what triggers it.
			const out = redactSqlForSink(
				'SELECT "a"."No_" FROM dbo."CRONUS$Sales Header" "a" JOIN dbo."CRONUS$Sales Line" "b" ON "a"."No_"="b"."Document No_"',
			);
			expect(out?.text).toBe(
				'SELECT "a"."No_" FROM dbo."Sales Header" "a" JOIN dbo."Sales Line" "b" ON "a"."No_"="b"."Document No_"',
			);
		});

		test("NB1: an alias.column pair that overflows MAX_NAMED_COLUMNS drops BOTH halves together, cleanly", () => {
			// Regression on the fix itself: counting each alias-qualified
			// column as ONE (not two) still has to decide, per PAIR, whether
			// it survives the column-collapse threshold -- and if not, drop
			// the alias prefix, its joiner "." AND its column together, or a
			// dangling "50102"., or a lone "." with nothing on either side,
			// leaks through as a formatting artifact (a weaker version of
			// the exact bug NB1 fixes).
			const cols = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]
				.map((c) => `"50102"."${c}"`)
				.join(",");
			const out = redactSqlForSink(
				`SELECT ${cols} FROM dbo."CRONUS$Cust" "50102"`,
			);
			expect(out?.columnCount).toBe(7); // 7 pairs = 7 named columns, not 14
			expect(out?.text).toContain('"50102"."c5"'); // last kept pair, intact
			expect(out?.text).toContain("…+2 more");
			expect(out?.text).not.toContain("c6");
			expect(out?.text).not.toContain("c7");
			expect(out?.text).not.toContain(",.");
			expect(out?.text).not.toContain(". ");
			expect(out?.text).not.toMatch(/"\s*,\s*,|,\s*\.\s*,/); // no dangling separators either
		});

		test("NB2: MERGE redacts instead of being dropped (regression on Fix Round 1b's own MERGE test)", () => {
			const out = redactSqlForSink(
				'MERGE INTO dbo."CRONUS$Sales Line" AS t USING dbo."CRONUS$Sales Header" AS s ON t."No_"=s."No_" WHEN MATCHED THEN UPDATE SET t."Qty"=s."Qty";',
			);
			expect(out).not.toBeNull();
			expect(out?.table).toBe("Sales Line");
			expect(out?.text).not.toContain("CRONUS");
			expect(out?.text).toBe(
				'MERGE INTO dbo."Sales Line" AS t USING dbo."Sales Header" AS s ON t."No_"=s."No_" WHEN MATCHED THEN UPDATE SET t."Qty"=s."Qty";',
			);
		});

		test("NB2: an unclassifiable statement (incl. empty input) still fails closed", () => {
			// The gate moved from `operation === "OTHER"` to
			// `!SQL_PREFIX_RE.test(body)` -- confirm the ORIGINAL minor fix
			// this rode in on (empty input -> null, not an all-null
			// RedactedStatement) still holds, plus a garbage verb that
			// matches neither SQL_PREFIX_RE nor any real SQL statement.
			expect(redactSqlForSink("")).toBeNull();
			expect(redactSqlForSink("EXEC sp_who")).toBeNull();
		});
	});

	describe("Fix Round 3", () => {
		// NB1's fix (Round 2) gated the database-qualifier drop to the
		// table-reference-parsing window (right after FROM/INTO/UPDATE/
		// MERGE, before tableRefLogical latches on the statement's FIRST
		// table). That window structurally can't see a JOIN target, a
		// comma-separated FROM item, a MERGE USING clause, or a qualified
		// column in a projection/WHERE -- every one of these leaked the
		// database name verbatim. Fixed by chainSegmentsAfter: shape, not
		// position, decides whether an ident is a qualifier (2+ further
		// chain segments) or the alias/table half of a kept pair (exactly
		// 1). All seven repros below leaked "SQLDATABASE" before this round.

		test("R3-1: a 3-part qualifier in a JOIN target", () => {
			const out = redactSqlForSink(
				'SELECT "a" FROM dbo."CRONUS$A" JOIN "SQLDATABASE".dbo."CRONUS$B" ON "x"="y"',
			);
			expect(out?.text).not.toContain("SQLDATABASE");
			expect(out?.text).toBe('SELECT "a" FROM dbo."A" JOIN dbo."B" ON "x"="y"');
		});

		test("R3-2: a 3-part qualifier in a comma-separated FROM list", () => {
			const out = redactSqlForSink(
				'SELECT "a" FROM dbo."CRONUS$A", "SQLDATABASE".dbo."CRONUS$B"',
			);
			expect(out?.text).not.toContain("SQLDATABASE");
			expect(out?.text).toBe('SELECT "a" FROM dbo."A", dbo."B"');
		});

		test("R3-3: a 3-part qualifier in a MERGE USING clause", () => {
			const out = redactSqlForSink(
				'MERGE INTO dbo."CRONUS$Cust" AS t USING "SQLDATABASE".dbo."CRONUS$Staging" AS s ON t."No_"=s."No_" WHEN MATCHED THEN UPDATE SET t."Name"=s."Name";',
			);
			expect(out?.text).not.toContain("SQLDATABASE");
			expect(out?.text).toBe(
				'MERGE INTO dbo."Cust" AS t USING dbo."Staging" AS s ON t."No_"=s."No_" WHEN MATCHED THEN UPDATE SET t."Name"=s."Name";',
			);
		});

		test("R3-4: a 4-part fully-qualified column in a SELECT projection reduces to table.column", () => {
			// The two shapes the corpus structurally cannot see under the
			// old position gate: a qualified COLUMN position (this test)...
			const out = redactSqlForSink(
				'SELECT "SQLDATABASE"."dbo"."CRONUS$T"."No_" FROM dbo."CRONUS$T"',
			);
			expect(out?.text).not.toContain("SQLDATABASE");
			expect(out?.text).toBe('SELECT "T"."No_" FROM dbo."T"');
		});

		test("R3-5: a 4-part fully-qualified column in a WHERE predicate reduces to table.column", () => {
			const out = redactSqlForSink(
				'SELECT "a" FROM dbo."CRONUS$T" WHERE "SQLDATABASE"."dbo"."CRONUS$U"."No_"=@0',
			);
			expect(out?.text).not.toContain("SQLDATABASE");
			expect(out?.text).toBe('SELECT "a" FROM dbo."T" WHERE "U"."No_"=@0');
		});

		test("R3-6: a 3-part qualifier in an INSERT...SELECT source FROM", () => {
			const out = redactSqlForSink(
				'INSERT INTO dbo."CRONUS$T" ("a") SELECT "b" FROM "SQLDATABASE".dbo."CRONUS$U"',
			);
			expect(out?.text).not.toContain("SQLDATABASE");
			expect(out?.text).toBe(
				'INSERT INTO dbo."T" ("a") SELECT "b" FROM dbo."U"',
			);
		});

		test("R3-7: a 3-part qualifier in an UPDATE...FROM clause", () => {
			// ...and a JOIN target (R3-1) -- this test uses BOTH a JOIN-like
			// second table reference AND stands in for the "not FROM/INTO/
			// UPDATE/MERGE-adjacent" position class generally (T-SQL's
			// UPDATE...FROM syntax): the qualifier sits after a bare "FROM"
			// that is NOT the statement's own table-reference keyword (that
			// was already consumed by "UPDATE dbo.\"T\"").
			const out = redactSqlForSink(
				'UPDATE dbo."CRONUS$T" SET "a"=1 FROM "SQLDATABASE".dbo."CRONUS$U"',
			);
			expect(out?.text).not.toContain("SQLDATABASE");
			expect(out?.text).toBe('UPDATE dbo."T" SET "a"=? FROM dbo."U"');
		});

		test("R3: tableRefLogical still resolves to the chain's FINAL segment, not an intermediate one", () => {
			// Regression on the fix itself, found while implementing it: a
			// 3-part ALL-QUOTED chain used as the statement's OWN table
			// reference (not a JOIN/later one) now keeps "dbo" too (it has
			// exactly 1 following segment, same shape as any kept alias) --
			// but "dbo" is an INTERMEDIATE segment, not the table, and must
			// not be captured as tableRefLogical or it disagrees with
			// parseSqlTable's own "Sales Header" resolution and fails the
			// C5 cross-check on a false mismatch (this was a real, if
			// short-lived, regression during Round 3 development -- caught
			// by the pre-existing C1 test before it ever reached commit).
			const out = redactSqlForSink(
				'SELECT "No_" FROM "SQLDATABASE"."dbo"."CRONUS$Sales Header"',
			);
			expect(out).not.toBeNull();
			expect(out?.table).toBe("Sales Header");
			expect(out?.text).toBe('SELECT "No_" FROM "dbo"."Sales Header"');
		});

		test("R3: the canonical RT0005 fixture and the quoted-alias JOIN still round-trip unchanged", () => {
			// Re-verification per the dispatch: these are also covered by
			// their own exact-text-match tests under "Fix Round 2" above
			// (still green), pinned here again explicitly alongside the
			// seven new leak repros as the requested re-check.
			const canonical =
				'SELECT  TOP (1) "50102"."timestamp","50102"."Store No_","50102"."Terminal No_" FROM dbo."COMPANY$Sample Table$aa11bb22-cc33-dd44-ee55-ff6677889900" "50102" WITH(READUNCOMMITTED) WHERE ("50102"."Store No_"=@0)';
			expect(redactSqlForSink(canonical)?.text).toBe(
				'SELECT TOP (?) "50102"."timestamp","50102"."Store No_","50102"."Terminal No_" FROM dbo."Sample Table" "50102" WITH(READUNCOMMITTED) WHERE ("50102"."Store No_"=@0)',
			);
			const quotedAliasJoin =
				'SELECT "a"."No_" FROM dbo."CRONUS$Sales Header" "a" JOIN dbo."CRONUS$Sales Line" "b" ON "a"."No_"="b"."Document No_"';
			expect(redactSqlForSink(quotedAliasJoin)?.text).toBe(
				'SELECT "a"."No_" FROM dbo."Sales Header" "a" JOIN dbo."Sales Line" "b" ON "a"."No_"="b"."Document No_"',
			);
		});
	});

	describe("Fix Round 4", () => {
		test("CRITICAL: db..table (empty schema slot) drops the database name in a JOIN target", () => {
			// `database..table` is valid T-SQL -- an empty schema slot means
			// "use the default schema". chainSegmentsAfter's joiner
			// regexes recognized "." and ".word." but not "..", so the walk
			// returned 0 and "SQLDATABASE" was kept as if it were an alias;
			// the pre-existing `/\.{2,}/g` collapse (now removed, see below)
			// then made the leak look like an innocuous 2-part name.
			const out = redactSqlForSink(
				'SELECT "a" FROM dbo."CRONUS$A" JOIN "SQLDATABASE".."CRONUS$B" ON "x"="y"',
			);
			expect(out?.text).not.toContain("SQLDATABASE");
			expect(out?.text).toBe('SELECT "a" FROM dbo."A" JOIN "B" ON "x"="y"');
		});

		test("CRITICAL: db..table in first-table-ref position -- the RULE drops it, though the statement still fails closed", () => {
			// Same shape as above, but as the statement's OWN (only) table
			// reference. chainSegmentsAfter now correctly identifies
			// "SQLDATABASE" as a qualifier here too (proven by parseSqlTable
			// disagreeing with a DIFFERENT value than before the fix -- see
			// below) -- but the overall statement still returns null,
			// because parseSqlTable (src/core/sql-node.ts, out of scope)
			// has its OWN, separate inability to parse "db..table": its
			// QUALIFIER regex can't consume a bare ".." hop at all, so it
			// captures raw garbage (a literal embedded '"' character) for
			// this exact shape regardless of anything in THIS file. The C5
			// cross-check (tableRefLogical vs. that garbage) still fires,
			// but now on a DIFFERENT, correctly-understood disagreement
			// ("B" vs the garbage capture) rather than the pre-fix one
			// ("SQLDATABASE" vs the same garbage) -- the rule, not the
			// cross-check, is what now recognizes the qualifier; the
			// cross-check is what still, separately, declines to guess at
			// parseSqlTable's own unrelated limitation.
			const out = redactSqlForSink('SELECT "a" FROM "SQLDATABASE".."CRONUS$B"');
			expect(out).toBeNull();
		});

		test("MINOR: a newline-formatted qualifier chain keeps the separator between kept segments", () => {
			// Before the fix: the post-hoc stray-dot cleanup regex couldn't
			// tell "residue from a dropped qualifier" apart from "a real
			// separator between two KEPT idents that happens to have
			// whitespace before it" (newly possible once Round 3 started
			// keeping intermediate segments like "dbo") -- and stripped the
			// real separator between "dbo" and "T" too, producing
			// `FROM "dbo" "T"` (reads as table + alias, ambiguous). Fixed by
			// suppressing a DROPPED ident's own joiner precisely, inside the
			// loop, rather than guessing post-hoc.
			const out = redactSqlForSink(
				'SELECT "No_" FROM "SQLDATABASE"\n."dbo"\n."CRONUS$T"',
			);
			expect(out?.table).toBe("T");
			// The exact whitespace formatting isn't the point -- the
			// separator dot between "dbo" and "T" must survive, so this
			// can't be misread as two unrelated quoted names.
			expect(out?.text).toContain('"dbo"');
			expect(out?.text).toMatch(/"dbo"\s*\.\s*"T"/);
			expect(out?.text).not.toContain('"dbo" "T"'); // the exact pre-fix (broken) reading
		});

		test("MINOR: a space-surrounded qualifier chain (bare and quoted dbo) redacts cleanly", () => {
			// The pre-existing half of this bug -- spaces around dots, not
			// just newlines -- pinned for both the bare-word and
			// quoted-ident "dbo" spellings.
			const bareWord = redactSqlForSink(
				'SELECT "No_" FROM "SQLDATABASE" . dbo . "CRONUS$T"',
			);
			expect(bareWord?.table).toBe("T");
			expect(bareWord?.text).not.toContain("SQLDATABASE");
			expect(bareWord?.text).toMatch(/dbo\s*\.\s*"T"/);

			const quotedDbo = redactSqlForSink(
				'SELECT "No_" FROM "SQLDATABASE" . "dbo"."CRONUS$T"',
			);
			expect(quotedDbo?.table).toBe("T");
			expect(quotedDbo?.text).not.toContain("SQLDATABASE");
			expect(quotedDbo?.text).toBe('SELECT "No_" FROM "dbo"."T"');
		});

		test("MINOR: a dropped BARE-WORD alias pair no longer leaves a dangling prefix", () => {
			// Round 2's pair logic (expectingPairedColumn) only covers a
			// QUOTED alias-prefix, because it keys off chainSegmentsAfter,
			// which only ever starts a walk FROM an ident token -- a bare
			// (unquoted) alias like `a` in `a."c1"` has no ident to key off
			// of. Before this fix, the column half of the pair could be
			// dropped past MAX_NAMED_COLUMNS while the bare alias prefix
			// (already emitted as plain "other" characters before the
			// drop-decision is even reached) survived, dangling with
			// nothing after it. This is the brief's own test-3 spelling.
			const cols = ["c1", "c2", "c3", "c4", "c5", "c6"]
				.map((c) => `a."${c}"`)
				.join(",");
			const out = redactSqlForSink(`SELECT ${cols} FROM dbo."CRONUS$T" a`);
			expect(out?.columnCount).toBe(6);
			expect(out?.text).toContain('a."c5"');
			expect(out?.text).toContain("…+1 more");
			expect(out?.text).not.toContain("c6");
			// The exact pre-fix (broken) reading: a dangling "a." with
			// nothing after it before the marker.
			expect(out?.text).not.toMatch(/a\.\s*…/);
		});

		test("re-verify: the canonical RT0005 fixture and the quoted-alias JOIN still round-trip unchanged", () => {
			const canonical =
				'SELECT  TOP (1) "50102"."timestamp","50102"."Store No_","50102"."Terminal No_" FROM dbo."COMPANY$Sample Table$aa11bb22-cc33-dd44-ee55-ff6677889900" "50102" WITH(READUNCOMMITTED) WHERE ("50102"."Store No_"=@0)';
			expect(redactSqlForSink(canonical)?.text).toBe(
				'SELECT TOP (?) "50102"."timestamp","50102"."Store No_","50102"."Terminal No_" FROM dbo."Sample Table" "50102" WITH(READUNCOMMITTED) WHERE ("50102"."Store No_"=@0)',
			);
			const quotedAliasJoin =
				'SELECT "a"."No_" FROM dbo."CRONUS$Sales Header" "a" JOIN dbo."CRONUS$Sales Line" "b" ON "a"."No_"="b"."Document No_"';
			expect(redactSqlForSink(quotedAliasJoin)?.text).toBe(
				'SELECT "a"."No_" FROM dbo."Sales Header" "a" JOIN dbo."Sales Line" "b" ON "a"."No_"="b"."Document No_"',
			);
		});

		test("re-verify: the seven Round 3 repros still redact cleanly", () => {
			// Was six entries (MERGE USING missing) -- no coverage gap, since
			// R3-3 pins it separately above, but the test name overstated
			// what THIS array covered. Added the seventh entry rather than
			// just renaming, so the name is accurate again.
			const repros: [string, string][] = [
				[
					'SELECT "a" FROM dbo."CRONUS$A" JOIN "SQLDATABASE".dbo."CRONUS$B" ON "x"="y"',
					'SELECT "a" FROM dbo."A" JOIN dbo."B" ON "x"="y"',
				],
				[
					'SELECT "a" FROM dbo."CRONUS$A", "SQLDATABASE".dbo."CRONUS$B"',
					'SELECT "a" FROM dbo."A", dbo."B"',
				],
				[
					'MERGE INTO dbo."CRONUS$Cust" AS t USING "SQLDATABASE".dbo."CRONUS$Staging" AS s ON t."No_"=s."No_" WHEN MATCHED THEN UPDATE SET t."Name"=s."Name";',
					'MERGE INTO dbo."Cust" AS t USING dbo."Staging" AS s ON t."No_"=s."No_" WHEN MATCHED THEN UPDATE SET t."Name"=s."Name";',
				],
				[
					'SELECT "SQLDATABASE"."dbo"."CRONUS$T"."No_" FROM dbo."CRONUS$T"',
					'SELECT "T"."No_" FROM dbo."T"',
				],
				[
					'SELECT "a" FROM dbo."CRONUS$T" WHERE "SQLDATABASE"."dbo"."CRONUS$U"."No_"=@0',
					'SELECT "a" FROM dbo."T" WHERE "U"."No_"=@0',
				],
				[
					'INSERT INTO dbo."CRONUS$T" ("a") SELECT "b" FROM "SQLDATABASE".dbo."CRONUS$U"',
					'INSERT INTO dbo."T" ("a") SELECT "b" FROM dbo."U"',
				],
				[
					'UPDATE dbo."CRONUS$T" SET "a"=1 FROM "SQLDATABASE".dbo."CRONUS$U"',
					'UPDATE dbo."T" SET "a"=? FROM dbo."U"',
				],
			];
			for (const [sql, expected] of repros) {
				expect(redactSqlForSink(sql)?.text).toBe(expected);
			}
		});
	});

	describe("Fix Round 5", () => {
		// Rounds 3-4 closed this family one enumerated joiner shape at a
		// time (bare dot, dot-word-dot, then "..' in Round 4) -- T-SQL
		// allows omitting ANY number of leading qualifier parts, so two
		// more valid spellings still leaked right up through Round 4:
		// "server...table" (omit database AND schema) and
		// "server..dbo.table" (omit only database). Fixed by replacing the
		// enumeration with one dot-counting rule in nextChainHop (see its
		// doc comment) rather than adding a fourth and fifth case.

		test("server...table (omit database AND schema) no longer leaks the server name", () => {
			const out = redactSqlForSink(
				'SELECT "a" FROM dbo."CRONUS$A" JOIN "SRV"..."CRONUS$B" ON "x"="y"',
			);
			expect(out?.text).not.toContain("SRV");
			expect(out?.text).toBe(
				'SELECT "a" FROM dbo."A" JOIN "B" ON "x"="y"',
			);
		});

		test("server..dbo.table (omit only database) no longer leaks the server name", () => {
			const out = redactSqlForSink(
				'SELECT "a" FROM dbo."CRONUS$A" JOIN "SRV"..dbo."CRONUS$B" ON "x"="y"',
			);
			expect(out?.text).not.toContain("SRV");
			expect(out?.text).toBe(
				'SELECT "a" FROM dbo."A" JOIN dbo."B" ON "x"="y"',
			);
		});

		test("a ..word. joiner in first-table-ref position -- the RULE drops it, though the statement still fails closed", () => {
			// Same "rule vs. cross-check" distinction as Round 4's db..table
			// test: parseSqlTable (out of scope) has the SAME inherent
			// inability to parse a bare ".." hop, regardless of a bare word
			// appearing later in the same joiner -- verified directly
			// before writing this test.
			const sql = 'SELECT "a" FROM "SRV"..dbo."CRONUS$B"';
			expect(parseSqlTable(sql).table).toBe('B"'); // confirms the SAME out-of-scope garbage capture as Round 4's db..table case
			expect(redactSqlForSink(sql)).toBeNull();
		});

		test("re-verify: the canonical RT0005 fixture and the quoted-alias JOIN still round-trip unchanged", () => {
			const canonical =
				'SELECT  TOP (1) "50102"."timestamp","50102"."Store No_","50102"."Terminal No_" FROM dbo."COMPANY$Sample Table$aa11bb22-cc33-dd44-ee55-ff6677889900" "50102" WITH(READUNCOMMITTED) WHERE ("50102"."Store No_"=@0)';
			expect(redactSqlForSink(canonical)?.text).toBe(
				'SELECT TOP (?) "50102"."timestamp","50102"."Store No_","50102"."Terminal No_" FROM dbo."Sample Table" "50102" WITH(READUNCOMMITTED) WHERE ("50102"."Store No_"=@0)',
			);
			const quotedAliasJoin =
				'SELECT "a"."No_" FROM dbo."CRONUS$Sales Header" "a" JOIN dbo."CRONUS$Sales Line" "b" ON "a"."No_"="b"."Document No_"';
			expect(redactSqlForSink(quotedAliasJoin)?.text).toBe(
				'SELECT "a"."No_" FROM dbo."Sales Header" "a" JOIN dbo."Sales Line" "b" ON "a"."No_"="b"."Document No_"',
			);
		});
	});
});
