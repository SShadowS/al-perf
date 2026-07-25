# Telemetry SQL Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach measured SQL evidence from Business Central telemetry (RT0005 slow statements, RT0018 SQL counts) to the lifecycle findings al-perf already mints from that telemetry.

**Architecture:** The App Insights adapter (`src/lifecycle/appinsights.ts`) runs a second KQL query for statement rows, then calls a new pure module (`src/lifecycle/telemetry-sql.ts`) to parse the AL stack, build a routine key, redact each statement, and attach the result to the matching wire signals — per split group, never globally. The parser copies that evidence onto `DetectedPattern.sqlEvidence` (in-memory, for formatters/MCP) and also formats it into `DetectedPattern.evidence` (the string that survives the database round-trip and reaches GitHub/Azure DevOps issues). A signal that failed to fetch marks the run incomplete so the absence pass cannot resolve findings on evidence that was never retrieved.

**Spec:** `docs/superpowers/specs/2026-07-25-telemetry-sql-evidence-design.md` (revision 3). Read it before starting; this plan implements it and does not repeat its reasoning.

**Tech Stack:** TypeScript on Bun, `bun:test`, Biome (tabs, double quotes), SQLite via `bun:sqlite`, plain `fetch` against the App Insights REST API v1.

## Global Constraints

- **Gate 0 blocks everything.** Task 1 must complete and its findings be recorded before Tasks 2-11 start. If Gate 0 contradicts a field assumption below, stop and revise the spec rather than coding around it.
- **Evidence is never identity, impact, or severity.** No task may write `impact`, `severity`, or any fingerprint input from a SQL field.
- **Raw statement text is never persisted or logged.** Only `redactSqlForSink` output leaves the adapter.
- **Profile-side behavior is unchanged.** `ProfileSqlEvidence` keeps every field required; no profile fingerprint moves.
- **`TELEMETRY_BATCH_SCHEMA_VERSION` stays `1`.** Every wire addition is optional and additive.
- **`FINGERPRINT_ALGO_VERSION` is not bumped.**
- **`sqlRank` is microseconds everywhere.** Telemetry sets `totalMeasuredMs * 1000`.
- **The persisted evidence string is plain text.** No markdown, no code fences (GitHub fences it, Azure DevOps escapes it into `<pre>`).
- **RT0018 `sqlExecutes`/`sqlRowsRead` exist from BC v22.0.** Absent means unknown, never zero.
- Style: tabs, double quotes, `.js` extensions on relative imports, `bun run check` before each commit.
- Every commit message ends with the session trailer line used by this repo's history.

## File Structure

| File | Responsibility |
|---|---|
| `src/lifecycle/telemetry-sql.ts` (new) | Pure logic: `parseAlStackFrame`, `telemetryRoutineKey`, `redactSqlForSink`, `groupStatementRows`, `attachEvidenceToSignals`. No I/O, no KQL. |
| `src/lifecycle/appinsights.ts` (modify) | Adds the statement query, the RT0005 stack grouping, the `sqlExecutes`/`sqlRowsRead` extends, per-signal failure capture, and the per-group join call. Stays the only KQL-aware module. |
| `src/core/sql-node.ts` (modify) | `parseSqlTable` handles 3-part database-qualified names. |
| `src/types/patterns.ts` (modify) | `SqlEvidence` becomes a discriminated union; adds `TelemetrySqlEvidence`, `isTelemetrySqlEvidence`. |
| `src/types/telemetry.ts` (modify) | `TelemetrySignal` gains `sqlEvidence`/`sqlExecutes`/`sqlRowsRead`; `TelemetryBatchDocument` gains `signalAvailability`. |
| `src/core/telemetry-parser.ts` (modify) | Validates the new fields, copies evidence onto patterns, formats the evidence string, merges evidence, and sets `meta.incompleteInvocations` when a signal failed. |
| `src/cli/formatters/*.ts` (modify) | Narrow on `provenance` before rendering. |
| `test/lifecycle/telemetry-sql.test.ts` (new) | Unit tests for the pure module, including the redaction corpus. |
| `test/lifecycle/appinsights.test.ts` (modify) | KQL snapshots (re-baselined), failure-capture and join tests. |
| `test/core/telemetry-parser.test.ts`, `test/core/telemetry-contract.test.ts` (modify) | Evidence copy, string format, merge, incomplete-run gating; golden re-baselined. |

---

### Task 1: Gate 0 — probe live telemetry

**Files:**
- Create: `test/fixtures/telemetry/rt0005-probe.json` (redacted probe output)
- Modify: `docs/superpowers/research/2026-07-16-bc-sql-evidence-sources.md` (append the field table)

**Interfaces:**
- Consumes: nothing.
- Produces: verified field names for every later task. If a field this plan names does not exist, later tasks change.

- [ ] **Step 1: Run the probe query**

Against the App Insights resource that carries BC telemetry, run:

```kql
traces
| where timestamp > ago(24h)
| where customDimensions.eventId in ("RT0005", "RT0018")
| extend eventId = tostring(customDimensions.eventId)
| summarize
    rows = count(),
    dimensionKeys = make_set(bag_keys(customDimensions), 200),
    distinctStacks = dcount(tostring(customDimensions.alStackTrace)),
    sampleStack = any(tostring(customDimensions.alStackTrace)),
    sampleStatement = any(tostring(customDimensions.sqlStatement))
  by eventId
```

- [ ] **Step 2: Record the answers**

Append a table to the research doc answering, per event id: does `alMethod` exist; does `sqlStatement` exist; is `executionTimeInMs` present or only `executionTime`; is `longRunningThreshold` per-row; are `sqlExecutes`/`sqlRowsRead` present; what `distinctStacks` is relative to `rows`; and the verbatim `alStackTrace` header/frame grammar.

- [ ] **Step 3: Commit the redacted fixture**

Hand-redact `sampleStatement` and `sampleStack` (replace company/database names and any literal values) and save as `test/fixtures/telemetry/rt0005-probe.json`:

```json
{
	"rt0005": {
		"dimensionKeys": ["eventId", "alObjectId", "alObjectType", "alObjectName", "alStackTrace", "sqlStatement", "executionTime", "longRunningThreshold", "clientType", "extensionId"],
		"sampleStack": "AppObjectType: CodeUnit\r\nAppObjectId: 80\r\nAL CallStack: \"Sales-Post\"(CodeUnit 80).PostLines line 42 - Base Application by Microsoft",
		"sampleStatement": "SELECT TOP (1) \"Document Type\",\"No_\" FROM dbo.\"COMPANY$Sales Header\" WITH(READUNCOMMITTED) WHERE (\"Document Type\"=@0)"
	},
	"rt0018": {
		"dimensionKeys": ["eventId", "alObjectId", "alObjectType", "alMethod", "alStackTrace", "executionTime", "sqlExecutes", "sqlRowsRead", "clientType", "extensionId"]
	}
}
```

```bash
git add test/fixtures/telemetry/rt0005-probe.json docs/superpowers/research/2026-07-16-bc-sql-evidence-sources.md
git commit -m "docs(research): Gate 0 — verified RT0005/RT0018 customDimensions field set"
```

- [ ] **Step 4: Decide go/no-go**

If `alStackTrace` has no parseable frame grammar, or `distinctStacks` is close to `rows` (every row a unique stack), STOP: the spec's §14 risks have fired. Revise the spec before continuing.

---

### Task 2: `parseAlStackFrame`

**Files:**
- Create: `src/lifecycle/telemetry-sql.ts`
- Test: `test/lifecycle/telemetry-sql.test.ts`

**Interfaces:**
- Consumes: the stack grammar recorded in Task 1.
- Produces: `parseAlStackFrame(stack: string): string | null` — the AL method name from the first `AL CallStack:` frame, or `null` when nothing parses.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { parseAlStackFrame } from "../../src/lifecycle/telemetry-sql.js";

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
		expect(parseAlStackFrame("AppObjectType: Report\r\nAppObjectId: 840")).toBeNull();
	});

	test("returns null for empty input", () => {
		expect(parseAlStackFrame("")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/lifecycle/telemetry-sql.test.ts`
Expected: FAIL — `Cannot find module '../../src/lifecycle/telemetry-sql.js'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * telemetry-sql.ts — pure logic for the telemetry SQL evidence layer: AL stack
 * parsing, the routine join key, statement redaction, and the statement→signal
 * join. No I/O and no KQL; `appinsights.ts` calls into this module so SQL-shape
 * knowledge stays out of the adapter and every rule here is unit-testable
 * without a fetch mock.
 */

/**
 * The AL frame grammar, verified against real RT0005 rows in Gate 0:
 *   "<Object Name>"(<ObjectType> <ObjectId>).<Method> line <N> - <app info>
 * Header lines (`AppObjectType:`, `AppObjectId:`) precede `AL CallStack:` and
 * are NOT frames — taking line 0 (the pre-fix behavior) yields a header string,
 * never a method.
 */
const AL_FRAME_RE = /"[^"]*"\([A-Za-z]+\s+\d+\)\.([A-Za-z_][\w]*)/;

const CALLSTACK_MARKER = "AL CallStack:";

export function parseAlStackFrame(stack: string): string | null {
	if (!stack) return null;
	// Anchor to the marker before matching. Unanchored, the first frame-shaped
	// text ANYWHERE wins — a header value carrying a quote and parens would be
	// picked over the real frame. Today's headers are plain `Key: Value`, so
	// this is defense against a grammar that changes, not a live bug.
	const idx = stack.indexOf(CALLSTACK_MARKER);
	if (idx === -1) return null;
	const match = AL_FRAME_RE.exec(stack.slice(idx));
	return match ? match[1] : null;
}
```

Pin the anchoring, and the four shapes that would otherwise ride on the regex
untested:

```ts
	test("ignores frame-shaped text before the AL CallStack marker", () => {
		const stack =
			'AppObjectType: Table\r\n  AppObjectId: 50100\r\n  SomeHeader: "Fake Name"(Table 1).NotTheRealMethod\r\n  AL CallStack: "Sample Job"(Table 50100).Run line 60 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("Run");
	});

	test("handles object types beyond Table and CodeUnit", () => {
		expect(
			parseAlStackFrame('AL CallStack: "Sales Report"(Report 50200).OnPreReport line 3'),
		).toBe("OnPreReport");
	});

	test("handles a method name with digits and underscores", () => {
		expect(
			parseAlStackFrame('AL CallStack: "Poster"(CodeUnit 50210).Post_Line2 line 9'),
		).toBe("Post_Line2");
	});

	test("handles an object name containing a dot and parentheses", () => {
		expect(
			parseAlStackFrame('AL CallStack: "CTS-SYS Send (Daily) Tel."(CodeUnit 50300).Emit line 1'),
		).toBe("Emit");
	});

	test("finds a frame on a later line when the marker line carries none", () => {
		const stack = 'AL CallStack: \r\n"Sample Mgt."(CodeUnit 50101).RunJobs line 8 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("RunJobs");
	});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/lifecycle/telemetry-sql.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
bun run check && bunx tsc --noEmit
git add src/lifecycle/telemetry-sql.ts test/lifecycle/telemetry-sql.test.ts
git commit -m "feat(telemetry): parseAlStackFrame — real AL frame parsing, not stack line 0"
```

---

### Task 3: `telemetryRoutineKey`

**Files:**
- Modify: `src/lifecycle/telemetry-sql.ts`
- Test: `test/lifecycle/telemetry-sql.test.ts`

**Interfaces:**
- Consumes: `parseAlStackFrame` (Task 2); `normalizeAppGuid`, `canonicalObjectType`, `normalizeTriggerName` from `src/semantic/identity.ts`.
- Produces: `telemetryRoutineKey(appId: string, objectType: string, objectId: number, methodName: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { telemetryRoutineKey } from "../../src/lifecycle/telemetry-sql.js";

describe("telemetryRoutineKey", () => {
	test("is stable across object-type casing and trigger spelling", () => {
		// appId is a plain dashed GUID in real telemetry (verified: 25,441 rows,
		// none braced) and normalizeAppGuid strips dashes + lowercases — it does
		// NOT strip braces, so do not pass a braced form here.
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/lifecycle/telemetry-sql.test.ts`
Expected: FAIL — `telemetryRoutineKey is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/lifecycle/telemetry-sql.ts`:

```ts
import {
	canonicalObjectType,
	normalizeAppGuid,
	normalizeTriggerName,
} from "../semantic/identity.js";

/**
 * The join key evidence attaches on. Uses the SAME normalizers as
 * `computeTelemetryFingerprint` (fingerprint.ts) so the key and the identity
 * can never disagree on casing or trigger spelling.
 *
 * `signalId` is DELIBERATELY omitted: finding identity includes it, so a key
 * that carried it could only ever reach RT0005 findings — and the whole point
 * is that RT0005 statements must also annotate the RT0018 finding for the same
 * routine.
 */
export function telemetryRoutineKey(
	appId: string,
	objectType: string,
	objectId: number,
	methodName: string,
): string {
	return [
		normalizeAppGuid(appId),
		canonicalObjectType(objectType),
		String(objectId),
		normalizeTriggerName(methodName).toLowerCase(),
	].join(KEY_SEP);
}
```

with the separator matching the one identity already uses:

```ts
/**
 * ASCII unit separator — the same separator `fingerprint.ts:237` uses, and for
 * the same reason: it cannot occur in AL identifiers, GUIDs or paths. A
 * printable separator like "|" lets a pipe inside objectType or methodName
 * shift the field boundary and collide two genuinely different routines onto
 * one key. Inlined rather than imported so this pure module does not pull in
 * fingerprint.ts's crypto dependency.
 */
const KEY_SEP = "\u001f";
```

and a test pinning that the collision is actually prevented:

```ts
	test("a separator inside a field cannot collide two different routines", () => {
		// Both object types are unrecognized by canonicalObjectType (so neither
		// gets case-canonicalized) and both appIds are already lowercase (so
		// normalizeAppGuid is a no-op) — otherwise those normalizers mask the
		// collision and the test passes against a "|" join too, proving nothing.
		const a = telemetryRoutineKey("abc", "x|customtype", 80, "OnRun");
		const b = telemetryRoutineKey("abc|x", "customtype", 80, "OnRun");
		expect(a).not.toBe(b);
	});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/lifecycle/telemetry-sql.test.ts`
Expected: PASS (9 tests total)

- [ ] **Step 5: Commit**

```bash
bun run check && bunx tsc --noEmit
git add src/lifecycle/telemetry-sql.ts test/lifecycle/telemetry-sql.test.ts
git commit -m "feat(telemetry): telemetryRoutineKey — signalId-free join key"
```

---

### Task 4: `parseSqlTable` handles 3-part names

**Files:**
- Modify: `src/core/sql-node.ts:88-121`
- Test: `test/core/sql-node.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseSqlTable` returns the logical table for `"DB".dbo."Company$Table"`, unchanged behavior for every existing form.

- [ ] **Step 1: Write the failing test**

Append to `test/core/sql-node.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/core/sql-node.test.ts`
Expected: FAIL — first test returns `{ table: "SQLDATABASE", extensionAppId: null }`

- [ ] **Step 3: Write the implementation**

In `src/core/sql-node.ts`, replace the four `sql.match(...)` regexes so the optional database prefix is consumed before the identifier. Each currently reads `(?:dbo\.)?`; change to the shared prefix below:

```ts
/**
 * Optional leading qualifiers: `dbo.` (case-insensitive), or a 3-part
 * `"DB".dbo.` / `[DB].dbo.` form. BC's RT0005 telemetry emits fully-qualified
 * names; the profile's SQL nodes emit the 2-part form. Both must resolve to
 * the TABLE, never to the database (the pre-fix regex captured the first
 * quoted segment, i.e. the DB).
 *
 * Only `dbo` is recognized as a BARE schema name. A permissive `\w+` here
 * would silently reinterpret `FROM public.Customer` as table `Customer`,
 * changing behavior on the unquoted branch for no benefit — BC always quotes
 * its identifiers and always uses dbo.
 */
const QUALIFIER = `(?:(?:"[^"]+"|\\[[^\\]]+\\]|dbo)\\s*\\.\\s*)*`;
```

Hoist all four matchers to module constants — `parseSqlTable` runs once per
distinct SQL shape while scanning profile nodes (`src/semantic/sql-evidence.ts:103`),
thousands of calls on a large profile, so building them per call recompiles
four patterns each time:

```ts
const INSERT_MATCHER = new RegExp(
	`\\bINTO\\s+${QUALIFIER}(?:"([^"]+)"|\\[([^\\]]+)\\]|(\\S+))`,
	"i",
);
const UPDATE_MATCHER = new RegExp(
	`^UPDATE\\s+${QUALIFIER}(?:"([^"]+)"|\\[([^\\]]+)\\]|(\\S+))`,
	"i",
);
const MERGE_MATCHER = new RegExp(
	`\\bMERGE\\s+(?:INTO\\s+)?${QUALIFIER}(?:"([^"]+)"|\\[([^\\]]+)\\]|(\\S+))`,
	"i",
);
const FROM_MATCHER = new RegExp(
	`\\bFROM\\s+${QUALIFIER}(?:"([^"]+)"|\\[([^\\]]+)\\]|(\\S+))`,
	"i",
);
```

and use them in the existing branch chain (`sql.match(INSERT_MATCHER)` etc.).
The `$`-splitting tail below the match is unchanged.

Add two tests pinning the bare branch, so the narrowing cannot regress:

```ts
test("does not treat a non-dbo bare schema as a qualifier", () => {
	expect(parseSqlTable("SELECT * FROM public.Customer")).toEqual({
		table: "public.Customer",
		extensionAppId: null,
	});
});

test("strips a bare dbo qualifier case-insensitively", () => {
	expect(parseSqlTable('SELECT * FROM DBO."Sales Header"')).toEqual({
		table: "Sales Header",
		extensionAppId: null,
	});
});
```

- [ ] **Step 4: Run the whole SQL suite**

Run: `bun test test/core/sql-node.test.ts test/semantic/sql-evidence.test.ts`
Expected: PASS — including every pre-existing profile-side case.

- [ ] **Step 5: Commit**

```bash
bun run check && bunx tsc --noEmit
git add src/core/sql-node.ts test/core/sql-node.test.ts
git commit -m "fix(core): parseSqlTable resolves 3-part database-qualified names"
```

---

### Task 5: `redactSqlForSink`

**Files:**
- Modify: `src/lifecycle/telemetry-sql.ts`
- Test: `test/lifecycle/telemetry-sql.test.ts`

**Interfaces:**
- Consumes: `parseSqlTable`, `classifySqlOperation` from `src/core/sql-node.js` (Task 4).
- Produces:
  ```ts
  interface RedactedStatement {
  	text: string;          // redacted, company/database stripped, literals blanked
  	operation: SqlOperation;
  	table: string | null;  // logical table
  	extensionAppId: string | null;
  	columnCount: number | null;
  	truncated: boolean;
  }
  redactSqlForSink(sql: string): RedactedStatement | null  // null = drop (fail closed)
  ```

- [ ] **Step 1: Write the failing tests (the corpus)**

```ts
import { redactSqlForSink } from "../../src/lifecycle/telemetry-sql.js";

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
			"SELECT * FROM dbo.\"CRONUS$Cust\" WHERE \"Name\"='Acme Ltd' AND \"X\"=N'Ünïcode' AND \"B\"=0xDEADBEEF",
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
			"SELECT * FROM dbo.\"CRONUS$Cust\" WHERE \"Name\"='Acme Lt",
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
		const out = redactSqlForSink('SELECT [Metadata] FROM dbo.[Application Object Metadata]');
		expect(out?.table).toBe("Application Object Metadata");
	});

	test("fails CLOSED on input the tokenizer cannot parse", () => {
		expect(redactSqlForSink('SELECT "unterminated identifier FROM x')).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/lifecycle/telemetry-sql.test.ts`
Expected: FAIL — `redactSqlForSink is not a function`

- [ ] **Step 3: Implement**

Append to `src/lifecycle/telemetry-sql.ts`:

```ts
import {
	classifySqlOperation,
	parseSqlTable,
	type SqlOperation,
} from "../core/sql-node.js";

export interface RedactedStatement {
	text: string;
	operation: SqlOperation;
	table: string | null;
	extensionAppId: string | null;
	columnCount: number | null;
	truncated: boolean;
}

const MAX_NAMED_COLUMNS = 5;

type Token =
	| { kind: "ident"; value: string; quote: '"' | "[" }
	| { kind: "literal" }
	| { kind: "other"; value: string };

/**
 * Scanner, not a regex sweep: rule 1 of the spec's §6 requires stripping the
 * company/database prefix from EVERY table reference, and identifiers can
 * contain `$`, spaces, dots and escaped quotes. Anything it cannot tokenize
 * fails CLOSED — the statement is dropped rather than emitted half-redacted,
 * because this output reaches an external issue tracker.
 */
function tokenize(sql: string): Token[] | null {
	const tokens: Token[] = [];
	let i = 0;
	while (i < sql.length) {
		const c = sql[i];
		if (c === '"') {
			const end = sql.indexOf('"', i + 1);
			if (end === -1) return null; // unterminated identifier
			tokens.push({ kind: "ident", value: sql.slice(i + 1, end), quote: '"' });
			i = end + 1;
		} else if (c === "[") {
			let j = i + 1;
			let value = "";
			for (;;) {
				const close = sql.indexOf("]", j);
				if (close === -1) return null;
				if (sql[close + 1] === "]") {
					value += `${sql.slice(j, close)}]`;
					j = close + 2;
					continue;
				}
				value += sql.slice(j, close);
				j = close + 1;
				break;
			}
			tokens.push({ kind: "ident", value, quote: "[" });
			i = j;
		} else if (c === "'" || (c === "N" && sql[i + 1] === "'")) {
			let j = c === "N" ? i + 2 : i + 1;
			for (;;) {
				const close = sql.indexOf("'", j);
				// Unterminated literal: the caller already trimmed a truncated
				// tail, so reaching here means genuinely malformed input.
				if (close === -1) return null;
				if (sql[close + 1] === "'") {
					j = close + 2;
					continue;
				}
				j = close + 1;
				break;
			}
			tokens.push({ kind: "literal" });
			i = j;
		} else if (c === "/" && sql[i + 1] === "*") {
			const end = sql.indexOf("*/", i + 2);
			i = end === -1 ? sql.length : end + 2;
		} else if (c === "-" && sql[i + 1] === "-") {
			const end = sql.indexOf("\n", i);
			i = end === -1 ? sql.length : end + 1;
		} else {
			tokens.push({ kind: "other", value: c });
			i++;
		}
	}
	return tokens;
}

/** `Company$Table`, `Company$Table$guid`, `Table$guid` -> the logical table. */
function logicalIdentifier(raw: string): string {
	const parts = raw.split("$");
	if (parts.length === 1) return parts[0];
	if (parts.length === 2) return parts[1];
	if (parts.length === 3) return parts[1];
	return raw;
}

export function redactSqlForSink(sql: string): RedactedStatement | null {
	// Truncation: a cut inside a literal leaves an unclosed quote, which defeats
	// literal blanking. Drop everything after the last complete token first.
	const quotes = (sql.match(/'/g) ?? []).length;
	const truncated = quotes % 2 === 1;
	const body = truncated ? sql.slice(0, sql.lastIndexOf("'")) : sql;

	const tokens = tokenize(body);
	if (!tokens) return null;

	const operation = classifySqlOperation(body);
	const { table, extensionAppId } = parseSqlTable(body);

	let out = "";
	let columnCount: number | null = null;
	let namedColumns = 0;
	let seenFrom = false;
	for (const t of tokens) {
		if (t.kind === "literal") {
			out += "'?'";
			continue;
		}
		if (t.kind === "ident") {
			const logical = logicalIdentifier(t.value);
			if (!seenFrom) {
				namedColumns++;
				if (namedColumns > MAX_NAMED_COLUMNS) continue;
			}
			out += t.quote === "[" ? `[${logical}]` : `"${logical}"`;
			continue;
		}
		out += t.value;
		if (/\bFROM\b\s*$/i.test(out)) seenFrom = true;
	}

	if (namedColumns > MAX_NAMED_COLUMNS) {
		columnCount = namedColumns;
		out = out.replace(/\bFROM\b/i, `…+${namedColumns - MAX_NAMED_COLUMNS} more FROM`);
	}

	// Bare numbers and hex literals — the profile-side normalizer misses hex.
	out = out.replace(/\b0x[0-9a-f]+\b/gi, "?").replace(/(?<![@\w])\d+(?:\.\d+)?\b/g, "?");

	return {
		text: out.replace(/\s+/g, " ").trim(),
		operation,
		table,
		extensionAppId,
		columnCount,
		truncated,
	};
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/lifecycle/telemetry-sql.test.ts`
Expected: PASS (18 tests). If the column-collapse assertion fails on exact wording, adjust the assertion to the produced string — the requirement is "count reported, names past five dropped", not one phrasing.

- [ ] **Step 5: Commit**

```bash
bun run check && bunx tsc --noEmit
git add src/lifecycle/telemetry-sql.ts test/lifecycle/telemetry-sql.test.ts
git commit -m "feat(telemetry): redactSqlForSink — tokenizing redactor that fails closed"
```

---

### Task 6: `SqlEvidence` becomes a discriminated union

**Files:**
- Modify: `src/types/patterns.ts:8-29`
- Modify: `src/cli/formatters/terminal.ts:400-416`
- Test: `test/cli/formatters/terminal.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  type SqlEvidence = ProfileSqlEvidence | TelemetrySqlEvidence;
  function isTelemetrySqlEvidence(e: SqlEvidence): e is TelemetrySqlEvidence;
  ```

- [ ] **Step 1: Write the failing test**

```ts
test("renders a telemetry evidence block as measured, never as sampled", () => {
	const result = makeResultWithPattern({
		sqlEvidence: {
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
			statements: [
				{
					text: 'SELECT "No_" FROM "Sales Header"',
					operation: "SELECT",
					table: "Sales Header",
					extensionAppId: null,
					occurrences: 12,
					measuredTotalMs: 4200,
					truncated: false,
				},
			],
			totalMeasuredMs: 4200,
			totalOccurrences: 12,
			threshold: { minMs: 750, maxMs: 750 },
		},
		sqlRank: 4_200_000,
	});
	const out = formatTerminal(result);
	expect(out).toContain("measured");
	expect(out).not.toContain("sampled");
	expect(out).toContain("750ms");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/cli/formatters/terminal.test.ts`
Expected: FAIL — type error on the literal, then a runtime `undefined` in the sampled renderer.

- [ ] **Step 3: Implement the types**

In `src/types/patterns.ts`, rename the existing interfaces and add the telemetry variant:

```ts
export interface ProfileSqlStatementEvidence {
	text: string;
	operation: "SELECT" | "COUNT" | "INSERT" | "UPDATE" | "DELETE" | "OTHER";
	table: string | null;
	extensionAppId: string | null;
	readUncommitted: boolean;
	sampledHitCount: number;
	sampledCostUs: number;
	attribution: "object-method" | "ancestor-fallback";
}

export interface ProfileSqlEvidence {
	statements: ProfileSqlStatementEvidence[];
	totalSampledCostUs: number;
	totalSampledHitCount: number;
	provenance: "sampled-estimate";
	attribution: "object-method" | "ancestor-fallback" | "mixed";
}

export interface TelemetrySqlStatementEvidence {
	text: string;
	operation: "SELECT" | "COUNT" | "INSERT" | "UPDATE" | "DELETE" | "OTHER";
	table: string | null;
	extensionAppId: string | null;
	occurrences: number;
	measuredTotalMs: number;
	truncated: boolean;
}

export interface TelemetrySqlEvidence {
	statements: TelemetrySqlStatementEvidence[];
	totalMeasuredMs: number;
	totalOccurrences: number;
	provenance: "measured-threshold-gated";
	attribution: "telemetry-stack";
	/** From RT0005's per-row longRunningThreshold; absent -> config default. */
	threshold?: { minMs: number; maxMs: number };
}

export type SqlEvidence = ProfileSqlEvidence | TelemetrySqlEvidence;

/** Narrowing helper — the stringify surfaces (json, MCP) get no compiler help. */
export function isTelemetrySqlEvidence(
	e: SqlEvidence,
): e is TelemetrySqlEvidence {
	return e.provenance === "measured-threshold-gated";
}
```

Keep `SqlStatementEvidence` as a deprecated alias of `ProfileSqlStatementEvidence` so `src/index.ts` and `src/semantic/sql-evidence.ts` keep compiling:

```ts
/** @deprecated Use ProfileSqlStatementEvidence. Kept for the public export surface. */
export type SqlStatementEvidence = ProfileSqlStatementEvidence;
```

- [ ] **Step 4: Repair the terminal renderer**

```ts
function renderSqlEvidence(evidence: SqlEvidence): string {
	if (isTelemetrySqlEvidence(evidence)) {
		const t = evidence.threshold;
		const gate = t
			? t.minMs === t.maxMs
				? `above ${t.minMs}ms`
				: `above ${t.minMs}-${t.maxMs}ms`
			: "above the configured threshold";
		const lines: string[] = [
			chalk.gray(
				`    SQL (measured, ${gate} only): total ${evidence.totalMeasuredMs}ms across ${evidence.totalOccurrences} occurrence(s)`,
			),
		];
		for (const s of evidence.statements.slice(0, 5)) {
			const table = s.table ?? "(unparsed)";
			const text = s.text.length > 120 ? `${s.text.slice(0, 120)}…` : s.text;
			lines.push(
				chalk.gray(
					`      ${s.operation} ${table} — ${s.measuredTotalMs}ms · ×${s.occurrences}${s.truncated ? " (truncated)" : ""} — ${text}`,
				),
			);
		}
		return lines.join("\n");
	}

	const lines: string[] = [
		chalk.gray(
			`    SQL (sampled estimate): total ${formatTime(evidence.totalSampledCostUs)} across ${evidence.totalSampledHitCount} sampled hits`,
		),
	];
	for (const s of evidence.statements.slice(0, 5)) {
		const table = s.table ?? "(unparsed)";
		const text = s.text.length > 120 ? `${s.text.slice(0, 120)}…` : s.text;
		lines.push(
			chalk.gray(
				`      ${s.operation} ${table} — ${formatTime(s.sampledCostUs)} · ×${s.sampledHitCount} sampled — ${text}`,
			),
		);
	}
	return lines.join("\n");
}
```

- [ ] **Step 5: Typecheck the whole repo and fix every narrowing site**

Run: `bunx tsc --noEmit`
Expected: errors ONLY where a consumer reads sampled fields unnarrowed. Fix each with `isTelemetrySqlEvidence`. `markdown.ts` and `html.ts` need the same treatment as terminal; `json.ts` needs none (it stringifies).

- [ ] **Step 6: Run the formatter suite and commit**

```bash
bun test test/cli/formatters/ && bun run check && bunx tsc --noEmit
git add src/types/patterns.ts src/cli/formatters/ test/cli/formatters/terminal.test.ts
git commit -m "feat(types): SqlEvidence becomes a discriminated union with a telemetry variant"
```

---

### Task 7: Wire contract and parser validation

**Files:**
- Modify: `src/types/telemetry.ts:13-46`
- Modify: `src/core/telemetry-parser.ts:184-196`
- Test: `test/core/telemetry-contract.test.ts`

**Interfaces:**
- Consumes: `TelemetrySqlEvidence` (Task 6).
- Produces: `TelemetrySignal.sqlEvidence?`, `.sqlExecutes?`, `.sqlRowsRead?`; `TelemetryBatchDocument.signalAvailability?`; `validateSignal` carries them through or rejects.

- [ ] **Step 1: Write the failing tests**

```ts
test("carries sqlExecutes/sqlRowsRead through the parser", () => {
	const batch = makeBatch([{ ...baseSignal, sqlExecutes: 12, sqlRowsRead: 3400 }]);
	const parsed = parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG);
	expect(parsed.result.patterns[0].evidence).toContain("12 SQL statement(s)");
	expect(parsed.result.patterns[0].evidence).toContain("3400 row(s) read");
});

test("schemaVersion stays 1 with the new fields present", () => {
	expect(TELEMETRY_BATCH_SCHEMA_VERSION).toBe(1);
});

test("rejects a negative sqlExecutes fail-closed", () => {
	const batch = makeBatch([{ ...baseSignal, sqlExecutes: -1 }]);
	expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
		/sqlExecutes/,
	);
});

test("rejects an unknown evidence provenance", () => {
	const batch = makeBatch([
		{ ...baseSignal, sqlEvidence: { provenance: "made-up", statements: [] } },
	]);
	expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
		/provenance/,
	);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/core/telemetry-contract.test.ts`
Expected: FAIL — fields dropped by `validateSignal`, no throw on bad input.

- [ ] **Step 3: Extend the wire types**

In `src/types/telemetry.ts`, add to `TelemetrySignal`:

```ts
	/** Measured SQL statement count for this routine (RT0018, BC v22.0+). Absent = unknown, NOT zero. */
	sqlExecutes?: number;
	/** Measured rows read for this routine (RT0018, BC v22.0+). Absent = unknown, NOT zero. */
	sqlRowsRead?: number;
	/** Redacted statement evidence attached by the adapter (RT0005). */
	sqlEvidence?: TelemetrySqlEvidence;
```

and to `TelemetryBatchDocument`:

```ts
	/**
	 * Per-signal outcome for the pull that produced this batch. Absent on
	 * producers that do not report it. Without this, "no evidence" cannot be
	 * distinguished from "not queried" / "query failed" / "truncated".
	 */
	signalAvailability?: Array<{
		signalId: string;
		queried: boolean;
		rows: number;
		truncated?: boolean;
		error?: string;
	}>;
```

- [ ] **Step 4: Extend `validateSignal`**

```ts
	return {
		signalId: requireNonEmptyString(obj, "signalId", context),
		appId: requireNonEmptyString(obj, "appId", context),
		appName: optionalString(obj, "appName", context),
		objectType: requireNonEmptyString(obj, "objectType", context),
		objectId: requireInteger(obj, "objectId", context),
		objectName: optionalString(obj, "objectName", context),
		methodName: requireNonEmptyString(obj, "methodName", context),
		count: requireNonNegativeNumber(obj, "count", context),
		maxDurationMs: requireNonNegativeNumber(obj, "maxDurationMs", context),
		avgDurationMs: optionalNonNegativeNumber(obj, "avgDurationMs", context),
		clientType: optionalClientType(obj, "clientType", context),
		sqlExecutes: optionalNonNegativeInteger(obj, "sqlExecutes", context),
		sqlRowsRead: optionalNonNegativeInteger(obj, "sqlRowsRead", context),
		sqlEvidence: optionalTelemetrySqlEvidence(obj, "sqlEvidence", context),
	};
```

with the two new validators beside the existing ones:

```ts
function optionalNonNegativeInteger(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): number | undefined {
	const v = obj[field];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new Error(
			`telemetry-batch ${context}: invalid field '${field}' (expected a non-negative integer)`,
		);
	}
	return v;
}

/**
 * Fail-closed shape check. An unknown `provenance` is REJECTED rather than
 * passed through: the discriminant is what every renderer narrows on, so an
 * unrecognized value would render measured data under sampled labels.
 */
function optionalTelemetrySqlEvidence(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): TelemetrySqlEvidence | undefined {
	const v = obj[field];
	if (v === undefined) return undefined;
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		throw new Error(`telemetry-batch ${context}: invalid field '${field}'`);
	}
	const e = v as Record<string, unknown>;
	if (e.provenance !== "measured-threshold-gated") {
		throw new Error(
			`telemetry-batch ${context}: invalid field '${field}.provenance' (expected "measured-threshold-gated")`,
		);
	}
	if (!Array.isArray(e.statements)) {
		throw new Error(`telemetry-batch ${context}: invalid field '${field}.statements'`);
	}
	return v as TelemetrySqlEvidence;
}
```

- [ ] **Step 5: Run tests and commit**

Run: `bun test test/core/`
Expected: PASS. The byte-identical golden still passes — no signal in it carries the new fields.

```bash
bun run check && bunx tsc --noEmit
git add src/types/telemetry.ts src/core/telemetry-parser.ts test/core/telemetry-contract.test.ts
git commit -m "feat(telemetry): wire contract for SQL evidence, counts and signal availability"
```

---

### Task 8: RT0005 signal query groups by stack

**Files:**
- Modify: `src/lifecycle/appinsights.ts:178-217`
- Test: `test/lifecycle/appinsights.test.ts`

**Interfaces:**
- Consumes: `parseAlStackFrame` (Task 2).
- Produces: RT0005 rows arriving one per (routine, stack) instead of one per object; `sqlExecutes`/`sqlRowsRead` on RT0018 rows.

- [ ] **Step 1: Write the failing test**

```ts
test("RT0005 groups by alStackTrace instead of collapsing with any()", () => {
	const kql = buildKqlQuery("RT0005", "2026-07-25T00:00:00.000Z", undefined, false);
	expect(kql).not.toContain("stackTrace = any(stackTrace)");
	expect(kql).toContain("by appId, appName, objectType, objectId, objectName, methodName, stackTrace, clientType");
});

test("RT0018 keeps its existing grouping and gains SQL counters", () => {
	const kql = buildKqlQuery("RT0018", "2026-07-25T00:00:00.000Z", undefined, false);
	expect(kql).toContain("stackTrace = any(stackTrace)");
	// Guarded, not a plain sum(): KQL folds over the empty set, so an all-absent
	// column sums to 0 and "unknown" would silently become "confirmed zero".
	expect(kql).toContain("countif(isnotnull(customDimensions.sqlExecutes)) == 0");
	expect(kql).toContain("countif(isnotnull(customDimensions.sqlRowsRead)) == 0");
});

test("a header-only stack no longer becomes the method name", () => {
	const table = {
		columns: [
			{ name: "appId" }, { name: "objectType" }, { name: "objectId" },
			{ name: "methodName" }, { name: "stackTrace" }, { name: "count" },
			{ name: "maxDurationMs" },
		],
		rows: [["app", "CodeUnit", 80, "", "AppObjectType: CodeUnit\r\nAppObjectId: 80", 1, 900]],
	};
	const { signals, skipped } = normalizeTable(table, "RT0005");
	expect(signals).toHaveLength(0);
	expect(skipped).toBe(1);
});
```

Export `buildKqlQuery` and `normalizeTable` for the test if they are module-private.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/lifecycle/appinsights.test.ts`
Expected: FAIL on all three, plus the existing snapshot test.

- [ ] **Step 3a: Fix the duration extraction (BOTH signals) — Gate 0 found this broken**

Gate 0 measured `customDimensions.executionTimeInMs` as non-null on **0 of 17,045** RT0018 rows and
**6 of 15,957** RT0005 rows. `buildKqlQuery` reads exactly that column
(`src/lifecycle/appinsights.ts:197-198`), so `max(ms)` is null and `asDurationMs` throws — the
shipped puller cannot work against real telemetry. Replace the `ms` extend for every signal:

```ts
	// executionTime is a .NET timespan ("00:11:06.3140000"); ticks/10000 = ms.
	// The executionTimeInMs alias is absent on effectively every real row
	// (Gate 0: 0/17,045 RT0018, 6/15,957 RT0005), which is why the shipped
	// query returned nulls and asDurationMs threw.
	"         ms = toreal(totimespan(customDimensions.executionTime)) / 10000,",
```

Add a test pinning it, since this is the failure that made the whole path unusable:

```ts
test("derives ms from the executionTime timespan, not the absent executionTimeInMs alias", () => {
	for (const signalId of ["RT0005", "RT0018"]) {
		const kql = buildKqlQuery(signalId, "2026-07-25T00:00:00.000Z", undefined, false);
		expect(kql).toContain("totimespan(customDimensions.executionTime)");
		expect(kql).not.toContain("executionTimeInMs");
	}
});
```

- [ ] **Step 3b: Implement the grouping change**

In `buildKqlQuery`, make the RT0005 shape distinct:

```ts
	const isSqlSignal = signalId === "RT0005";
	lines.push(
		isSqlSignal
			? "| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms)"
			: // KQL aggregates fold over the EMPTY SET: sum() of all-nulls is 0, not
			// null — the opposite of SQL. Verified on live telemetry (RT0005 groups
			// of 28/20/352 rows with the column absent returned 0). Without the
			// countif guard, "absent" silently becomes a confirmed zero. todouble()
			// is required or KQL rejects the iff on real-vs-long branches.
			"| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms), stackTrace = any(stackTrace), sqlExecutes = iff(countif(isnotnull(customDimensions.sqlExecutes)) == 0, real(null), todouble(sum(toint(customDimensions.sqlExecutes)))), sqlRowsRead = iff(countif(isnotnull(customDimensions.sqlRowsRead)) == 0, real(null), todouble(sum(toint(customDimensions.sqlRowsRead))))",
		isSqlSignal
			? split
				? "    by appId, appName, objectType, objectId, objectName, methodName, stackTrace, clientType, aadTenantId, environmentName"
				: "    by appId, appName, objectType, objectId, objectName, methodName, stackTrace, clientType"
			: split
				? "    by appId, appName, objectType, objectId, objectName, methodName, clientType, aadTenantId, environmentName"
				: "    by appId, appName, objectType, objectId, objectName, methodName, clientType",
	);
```

In `buildSignalFromRow`, replace the stack-head fallback:

```ts
	const rawMethodName = asDisplayString(cell(row, "methodName"));
	const stackTrace = asDisplayString(cell(row, "stackTrace"));
	// RT0005 carries no alMethod, so the method comes from the AL frame. The
	// pre-fix fallback took stack line 0, which is the `AppObjectType:` header
	// — a non-method string that then became the finding's routine identity.
	const methodName =
		rawMethodName.trim() !== "" ? rawMethodName : (parseAlStackFrame(stackTrace) ?? "");
```

and carry the counters into the signal:

```ts
		sqlExecutes: asOptionalCount(cell(row, "sqlExecutes")),
		sqlRowsRead: asOptionalCount(cell(row, "sqlRowsRead")),
```

```ts
/** null/undefined => unknown (BC < v22.0 does not emit these), never 0. */
function asOptionalCount(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
```

- [ ] **Step 4: Re-baseline the KQL snapshot deliberately**

Run: `bun test test/lifecycle/appinsights.test.ts`
Read the snapshot diff line by line and confirm each change is intended (RT0005 grouping, the two new RT0018 aggregates) before updating the expected strings in the test.

- [ ] **Step 5: Commit**

```bash
bun run check && bunx tsc --noEmit && bun test test/lifecycle/
git add src/lifecycle/appinsights.ts test/lifecycle/appinsights.test.ts
git commit -m "feat(telemetry): RT0005 groups by stack; RT0018 carries sqlExecutes/sqlRowsRead"
```

---

### Task 9: Statement query, per-group join, and per-signal failure capture

**Files:**
- Modify: `src/lifecycle/appinsights.ts` (`fetchSignalTable`, `pullTelemetry`, `pullTelemetrySplit`)
- Modify: `src/lifecycle/telemetry-sql.ts` (`groupStatementRows`, `attachEvidenceToSignals`)
- Test: `test/lifecycle/appinsights.test.ts`, `test/lifecycle/telemetry-sql.test.ts`

**Interfaces:**
- Consumes: `redactSqlForSink`, `telemetryRoutineKey`, `parseAlStackFrame`.
- Produces:
  ```ts
  attachEvidenceToSignals(
  	signals: TelemetrySignal[],
  	statementRows: StatementRow[],
  ): void  // mutates signals in place, attaching sqlEvidence by routine key
  ```
  and `signalAvailability` on both pull results.

- [ ] **Step 1: Write the failing tests**

```ts
test("attaches statements to every signal on the routine, across signal ids", () => {
	const signals = [
		{ signalId: "RT0018", appId: "a", objectType: "CodeUnit", objectId: 80, methodName: "PostLines", count: 1, maxDurationMs: 900 },
		{ signalId: "RT0005", appId: "a", objectType: "CodeUnit", objectId: 80, methodName: "PostLines", count: 1, maxDurationMs: 900 },
	] as TelemetrySignal[];
	attachEvidenceToSignals(signals, [
		{ appId: "a", objectType: "CodeUnit", objectId: 80, stackTrace: '"X"(CodeUnit 80).PostLines line 1', sqlStatement: 'SELECT "No_" FROM dbo."CRONUS$Sales Header"', occurrences: 3, measuredTotalMs: 2400, thresholdMs: 750 },
	]);
	expect(signals[0].sqlEvidence?.statements).toHaveLength(1);
	expect(signals[1].sqlEvidence?.statements).toHaveLength(1);
	expect(signals[0].sqlEvidence?.provenance).toBe("measured-threshold-gated");
});

test("does not attach across tenants — join runs per group", async () => {
	// Two groups whose findings share app/object/method; each must see only its
	// own statement rows.
	const result = await pullTelemetrySplit(optsWithTwoTenants, fetchMock);
	const a = result.groups.find((g) => g.tenant === "tenant-a");
	const b = result.groups.find((g) => g.tenant === "tenant-b");
	expect(a?.batch.signals[0].sqlEvidence?.statements[0].table).toBe("Sales Header");
	expect(b?.batch.signals[0].sqlEvidence?.statements[0].table).toBe("Item Ledger Entry");
});

test("a failing signal records availability instead of aborting the pull", async () => {
	const batch = await pullTelemetry(opts, fetchMockWhereRt0005Returns500);
	expect(batch.signals.length).toBeGreaterThan(0); // RT0018 rows survived
	const avail = batch.signalAvailability?.find((a) => a.signalId === "RT0005");
	expect(avail?.error).toContain("500");
});

test("all signals failing still throws", async () => {
	await expect(pullTelemetry(opts, fetchMockWhereEverythingFails)).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/lifecycle/`
Expected: FAIL — `attachEvidenceToSignals` undefined; the pull still throws on one bad signal.

- [ ] **Step 3: Implement the statement query**

```ts
/**
 * Statement-level RT0005 query. Grouped by the stack (not `any()`) plus the
 * statement, so a routine's statements survive to TypeScript. In split mode the
 * tenant dimensions ride along, because the join must happen inside a group —
 * a global join would attach one tenant's SQL to another tenant's finding.
 */
function buildStatementKqlQuery(sinceIso: string, split: boolean): string {
	const by = split
		? "extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement, aadTenantId, environmentName"
		: "extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement";
	return [
		"traces",
		`| where timestamp > datetime(${sinceIso})`,
		'| where customDimensions.eventId == "RT0005"',
		"| extend extensionId = tostring(customDimensions.extensionId),",
		"         alObjectType = tostring(customDimensions.alObjectType),",
		"         alObjectId = toint(customDimensions.alObjectId),",
		"         alStackTrace = tostring(customDimensions.alStackTrace),",
		"         sqlStatement = tostring(customDimensions.sqlStatement),",
		// Both are .NET timespans; the *InMs aliases are absent on real rows
		// (Gate 0). RT0005's threshold measured a uniform 750ms.
		"         thresholdMs = toreal(totimespan(customDimensions.longRunningThreshold)) / 10000,",
		"         ms = toreal(totimespan(customDimensions.executionTime)) / 10000,",
		split
			? "         aadTenantId = tostring(customDimensions.aadTenantId),\n         environmentName = tostring(customDimensions.environmentName)"
			: "",
		`| summarize occurrences = count(), measuredTotalMs = sum(ms), thresholdMs = min(thresholdMs) by ${by}`,
		"| top-nested 5 of extensionId by max(measuredTotalMs), top-nested 5 of sqlStatement by max(measuredTotalMs)",
	]
		.filter((l) => l !== "")
		.join("\n");
}
```

- [ ] **Step 4: Implement the join**

Append to `src/lifecycle/telemetry-sql.ts`:

```ts
export interface StatementRow {
	appId: string;
	objectType: string;
	objectId: number;
	stackTrace: string;
	sqlStatement: string;
	occurrences: number;
	measuredTotalMs: number;
	thresholdMs?: number;
}

/**
 * Attach redacted statements to every signal sharing the routine key — RT0018
 * and RT0005 alike, since the key omits signalId by design. Call this ONCE PER
 * SPLIT GROUP, never over a fleet-wide row set.
 */
export function attachEvidenceToSignals(
	signals: TelemetrySignal[],
	rows: readonly StatementRow[],
): void {
	const byRoutine = new Map<string, TelemetrySqlStatementEvidence[]>();
	const thresholds = new Map<string, { minMs: number; maxMs: number }>();

	for (const row of rows) {
		const method = parseAlStackFrame(row.stackTrace);
		if (!method) continue;
		const redacted = redactSqlForSink(row.sqlStatement);
		if (!redacted) continue; // fail closed — never emit half-redacted text

		const key = telemetryRoutineKey(row.appId, row.objectType, row.objectId, method);
		const list = byRoutine.get(key) ?? [];
		list.push({
			text: redacted.text,
			operation: redacted.operation,
			table: redacted.table,
			extensionAppId: redacted.extensionAppId,
			occurrences: row.occurrences,
			measuredTotalMs: row.measuredTotalMs,
			truncated: redacted.truncated,
		});
		byRoutine.set(key, list);

		if (row.thresholdMs !== undefined) {
			const t = thresholds.get(key);
			thresholds.set(key, {
				minMs: t ? Math.min(t.minMs, row.thresholdMs) : row.thresholdMs,
				maxMs: t ? Math.max(t.maxMs, row.thresholdMs) : row.thresholdMs,
			});
		}
	}

	for (const signal of signals) {
		const key = telemetryRoutineKey(
			signal.appId,
			signal.objectType,
			signal.objectId,
			signal.methodName,
		);
		const statements = byRoutine.get(key);
		if (!statements || statements.length === 0) continue;
		statements.sort((a, b) => b.measuredTotalMs - a.measuredTotalMs);
		signal.sqlEvidence = {
			statements: statements.slice(0, 5),
			totalMeasuredMs: statements.reduce((n, s) => n + s.measuredTotalMs, 0),
			totalOccurrences: statements.reduce((n, s) => n + s.occurrences, 0),
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
			threshold: thresholds.get(key),
		};
	}
}
```

- [ ] **Step 5: Implement per-signal failure capture**

In `pullTelemetry` and `pullTelemetrySplit`, wrap each signal's fetch+normalize:

```ts
	const availability: NonNullable<TelemetryBatchDocument["signalAvailability"]> = [];
	let succeeded = 0;
	for (const signalId of signalIds) {
		try {
			const table = await fetchSignalTable(/* … */);
			const { signals, skipped } = normalizeTable(table, signalId);
			allSignals.push(...signals);
			skippedTotal += skipped;
			availability.push({ signalId, queried: true, rows: signals.length });
			succeeded++;
		} catch (err) {
			// Per-signal capture covers normalization throws (asDurationMs) too,
			// not just HTTP — a bad row must degrade one signal, not the pull.
			availability.push({
				signalId,
				queried: true,
				rows: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (succeeded === 0) {
		throw new Error(
			`pull-telemetry: every signal query failed (${availability.map((a) => a.signalId).join(", ")}) — check --app-id and the API key`,
		);
	}
```

Then, after grouping in `pullTelemetrySplit`, call `attachEvidenceToSignals(acc.signals, rowsForThisGroup)` **inside the per-group loop**, and put `signalAvailability: availability` on every emitted batch.

- [ ] **Step 6: Run tests and commit**

Run: `bun test test/lifecycle/`
Expected: PASS

```bash
bun run check && bunx tsc --noEmit
git add src/lifecycle/appinsights.ts src/lifecycle/telemetry-sql.ts test/lifecycle/
git commit -m "feat(telemetry): statement query, per-group evidence join, per-signal failure capture"
```

---

### Task 10: Parser — evidence onto patterns, the evidence string, merge, incomplete gating

**Files:**
- Modify: `src/core/telemetry-parser.ts:303-381` (`buildSinglePattern`, `buildMergedPattern`), `:432-508` (`parseTelemetryBatch`)
- Test: `test/core/telemetry-parser.test.ts`

**Interfaces:**
- Consumes: the wire fields from Task 7.
- Produces: `DetectedPattern.sqlEvidence`, `.sqlRank`, an evidence string carrying the redacted statements, and `meta.incompleteInvocations > 0` when a signal failed.

- [ ] **Step 1: Write the failing tests**

```ts
test("copies evidence onto the pattern and sets sqlRank in microseconds", () => {
	const parsed = parseTelemetryBatch(batchWithEvidence, DEFAULT_LIFECYCLE_CONFIG);
	const p = parsed.result.patterns[0];
	expect(p.sqlEvidence?.provenance).toBe("measured-threshold-gated");
	expect(p.sqlRank).toBe(4200 * 1000);
});

test("never touches impact or severity", () => {
	const withEvidence = parseTelemetryBatch(batchWithEvidence, DEFAULT_LIFECYCLE_CONFIG);
	const without = parseTelemetryBatch(batchWithoutEvidence, DEFAULT_LIFECYCLE_CONFIG);
	expect(withEvidence.result.patterns[0].impact).toBe(without.result.patterns[0].impact);
	expect(withEvidence.result.patterns[0].severity).toBe(without.result.patterns[0].severity);
	expect(withEvidence.result.patterns[0].fingerprint).toBe(without.result.patterns[0].fingerprint);
});

test("formats up to three statements into the persisted evidence string, plain text", () => {
	const p = parseTelemetryBatch(batchWithFourStatements, DEFAULT_LIFECYCLE_CONFIG)
		.result.patterns[0];
	expect(p.evidence).toContain("SQL (measured");
	expect(p.evidence.match(/SELECT/g)?.length).toBe(3);
	expect(p.evidence).not.toContain("```");
	expect(p.evidence).not.toContain("CRONUS");
});

test("a failed signal marks the run incomplete so absence cannot accrue", () => {
	const parsed = parseTelemetryBatch(
		{ ...batch, signalAvailability: [{ signalId: "RT0005", queried: true, rows: 0, error: "500" }] },
		DEFAULT_LIFECYCLE_CONFIG,
	);
	expect(parsed.result.meta.incompleteInvocations).toBeGreaterThan(0);
});

test("healthy availability leaves the run complete", () => {
	const parsed = parseTelemetryBatch(
		{ ...batch, signalAvailability: [{ signalId: "RT0005", queried: true, rows: 4 }] },
		DEFAULT_LIFECYCLE_CONFIG,
	);
	expect(parsed.result.meta.incompleteInvocations ?? 0).toBe(0);
});

test("merges evidence across clientType constituents without double-counting", () => {
	const p = parseTelemetryBatch(batchWithTwoClientTypes, DEFAULT_LIFECYCLE_CONFIG)
		.result.patterns[0];
	expect(p.sqlEvidence?.statements).toHaveLength(1); // same text unioned
	expect(p.sqlEvidence?.totalOccurrences).toBe(5); // 2 + 3
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/core/telemetry-parser.test.ts`
Expected: FAIL on all six.

- [ ] **Step 3: Implement the evidence string helper**

```ts
/**
 * The block appended to `DetectedPattern.evidence`. That string is the ONLY
 * thing that survives to the lifecycle store (evaluate.ts collectFindings) and
 * therefore to a GitHub/Azure DevOps issue body. PLAIN TEXT ONLY: GitHub fences
 * the string and Azure DevOps escapes it into <pre>, so markdown would render
 * literally in one of the two.
 */
function renderEvidenceSqlBlock(
	e: TelemetrySqlEvidence,
	availabilityNote: string | null,
): string {
	const gate = e.threshold
		? e.threshold.minMs === e.threshold.maxMs
			? `above ${e.threshold.minMs}ms`
			: `above ${e.threshold.minMs}-${e.threshold.maxMs}ms`
		: "above the configured threshold";
	const lines = [
		`SQL (measured, ${gate} only): ${e.totalMeasuredMs}ms across ${e.totalOccurrences} occurrence(s)`,
	];
	for (const s of e.statements.slice(0, 3)) {
		const text = s.text.length > 200 ? `${s.text.slice(0, 200)}…` : s.text;
		lines.push(
			`  ${s.operation} ${s.table ?? "(unparsed)"} — ${s.measuredTotalMs}ms x${s.occurrences}${s.truncated ? " (truncated)" : ""}: ${text}`,
		);
	}
	if (availabilityNote) lines.push(availabilityNote);
	return lines.join("\n");
}

function renderCountsLine(s: TelemetrySignal): string | null {
	if (s.sqlExecutes === undefined && s.sqlRowsRead === undefined) return null;
	const parts: string[] = [];
	if (s.sqlExecutes !== undefined) parts.push(`${s.sqlExecutes} SQL statement(s)`);
	if (s.sqlRowsRead !== undefined) parts.push(`${s.sqlRowsRead} row(s) read`);
	return `Measured: ${parts.join(", ")}`;
}
```

- [ ] **Step 4: Wire it into both pattern builders**

In `buildSinglePattern`, after the existing `evidence` line:

```ts
	const extras: string[] = [];
	const counts = renderCountsLine(s);
	if (counts) extras.push(counts);
	if (s.sqlEvidence) extras.push(renderEvidenceSqlBlock(s.sqlEvidence, availabilityNote));

	return {
		/* …existing fields, impact and severity untouched… */
		evidence: [baseEvidence, ...extras].join("\n"),
		sqlEvidence: s.sqlEvidence,
		sqlRank: s.sqlEvidence ? s.sqlEvidence.totalMeasuredMs * 1000 : undefined,
		fingerprint,
	};
```

In `buildMergedPattern`, union the constituents first:

```ts
/** Union by redacted text; sum occurrences and ms; widen the threshold range. */
function mergeEvidence(
	group: readonly SignalSeverity[],
): TelemetrySqlEvidence | undefined {
	const byText = new Map<string, TelemetrySqlStatementEvidence>();
	let threshold: { minMs: number; maxMs: number } | undefined;
	for (const { signal } of group) {
		const e = signal.sqlEvidence;
		if (!e) continue;
		for (const s of e.statements) {
			const prev = byText.get(s.text);
			byText.set(
				s.text,
				prev
					? {
							...prev,
							occurrences: prev.occurrences + s.occurrences,
							measuredTotalMs: prev.measuredTotalMs + s.measuredTotalMs,
							truncated: prev.truncated || s.truncated,
						}
					: { ...s },
			);
		}
		if (e.threshold) {
			threshold = threshold
				? {
						minMs: Math.min(threshold.minMs, e.threshold.minMs),
						maxMs: Math.max(threshold.maxMs, e.threshold.maxMs),
					}
				: e.threshold;
		}
	}
	if (byText.size === 0) return undefined;
	const statements = Array.from(byText.values()).sort(
		(a, b) => b.measuredTotalMs - a.measuredTotalMs || a.text.localeCompare(b.text),
	);
	return {
		statements: statements.slice(0, 5),
		totalMeasuredMs: statements.reduce((n, s) => n + s.measuredTotalMs, 0),
		totalOccurrences: statements.reduce((n, s) => n + s.occurrences, 0),
		provenance: "measured-threshold-gated",
		attribution: "telemetry-stack",
		threshold,
	};
}
```

- [ ] **Step 5: Gate absence on availability**

In `parseTelemetryBatch`, after validating signals:

```ts
	const availability = validateAvailability(raw.signalAvailability);
	const failedSignals = availability.filter((a) => a.error !== undefined);
	const availabilityNote =
		failedSignals.length > 0
			? `Signal(s) unavailable this window: ${failedSignals.map((a) => `${a.signalId} (${a.error})`).join("; ")} — absence not counted.`
			: null;
```

and in the `meta` block:

```ts
			// A window in which a signal failed is an INCOMPLETE run: evaluateRun
			// reads meta.incompleteInvocations (evaluate.ts:353) and skips the
			// absence pass entirely (evaluate.ts:610-611). Without this, an
			// RT0018-only batch would accrue absence against every RT0005 finding
			// of the same app and eventually resolve them.
			incompleteInvocations: failedSignals.length,
```

- [ ] **Step 6: Re-baseline the byte-identical golden deliberately**

Run: `bun test test/core/`
The pre-clientType golden in `test/core/telemetry-contract.test.ts` now differs for signals carrying SQL fields. Confirm the diff shows ONLY the appended evidence lines for those signals, and that a signal with no SQL fields is still byte-identical, then update the golden.

- [ ] **Step 7: Commit**

```bash
bun run check && bunx tsc --noEmit && bun test
git add src/core/telemetry-parser.ts test/core/
git commit -m "feat(telemetry): SQL evidence on patterns, in the persisted string, and absence gating"
```

---

### Task 11: Remaining renderers, ranking surface, and docs

**Files:**
- Modify: `src/cli/formatters/markdown.ts`, `src/cli/formatters/html.ts`
- Modify: `src/lifecycle/digest.ts`
- Modify: `docs/telemetry-recipe.md`, `CHANGELOG.md`
- Test: `test/cli/formatters/markdown.test.ts`, `test/cli/formatters/json.test.ts`, `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: no new API.

- [ ] **Step 1: Write the failing tests**

Note: the markdown and html telemetry-branch tests already exist — Task 6's
review round added them (`test/cli/formatters/markdown.test.ts`,
`test/cli/formatters/html.test.ts`, both pinned non-vacuous by inverting the
branch). Do not duplicate them; this task adds only the json and MCP coverage
below.

```ts
// json.test.ts — the compiler cannot help here; the test must
test("json output for telemetry evidence carries no sampled fields", () => {
	const parsed = JSON.parse(formatJson(resultWithTelemetryEvidence));
	const e = parsed.patterns[0].sqlEvidence;
	expect(e.provenance).toBe("measured-threshold-gated");
	expect(e.totalSampledCostUs).toBeUndefined();
	expect(e.statements[0].sampledHitCount).toBeUndefined();
});

// tools.test.ts
test("MCP sort:\"sql\" orders telemetry and profile findings by one unit", () => {
	// telemetry rank = ms * 1000, profile rank = sampled µs — both microseconds
	const sorted = [profileFinding, telemetryFinding].sort(bySqlRankDesc);
	expect(sorted[0]).toBe(telemetryFinding);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/cli/formatters/ test/mcp/`
Expected: FAIL on the markdown and json assertions.

- [ ] **Step 3: Implement the remaining renderers**

Apply the same `isTelemetrySqlEvidence` narrowing used in Task 6's terminal renderer to `markdown.ts` and `html.ts`, printing `measured, above Nms only` and `Xms · ×N` instead of the sampled wording. In `digest.ts`, add one line per tenant when any signal was unavailable:

```ts
	if (unavailable.length > 0) {
		lines.push(
			`> Signals unavailable this window: ${unavailable.map((s) => s.signalId).join(", ")} — absence not counted for them.`,
		);
	}
```

- [ ] **Step 4: Document**

Add a section to `docs/telemetry-recipe.md` covering: what RT0005 evidence looks like on a finding; that it is threshold-gated so absence of evidence is not evidence of absence; that statement text is redacted before storage and the logical table is retained deliberately; and that a failed signal makes the window incomplete.

Add to `CHANGELOG.md` under Unreleased:

```markdown
### Added
- **Telemetry SQL evidence.** RT0005 slow-statement rows attach to telemetry findings as measured, threshold-gated evidence, and RT0018's `sqlExecutes`/`sqlRowsRead` ride along on the same findings. Statement text is redacted at ingest — company and database names never leave the adapter.
- **Per-signal availability.** A failed signal query no longer aborts the pull; it is recorded, reported in the digest, and marks the window incomplete so findings for that signal cannot resolve on data that was never fetched.

### Fixed
- **RT0005 findings carried a stack header as their method name.** The fallback took the first line of `alStackTrace`, which is `AppObjectType: …`, not a method. RT0005 findings now parse the real AL frame. Existing RT0005 findings, if any, re-file once under corrected identities.
```

- [ ] **Step 5: Full verify and commit**

Run: `bun run verify`
Expected: biome clean, `tsc --noEmit` clean, all tests pass.

```bash
git add src/cli/formatters/ src/lifecycle/digest.ts docs/telemetry-recipe.md CHANGELOG.md test/
git commit -m "feat(telemetry): render measured SQL evidence across formatters, digest and docs"
```

---

## Self-review notes (already applied)

- **Spec coverage.** §1→Task 1; §4.1→Task 3; §4.2→Tasks 2, 8; §4.3→no task by design (nothing to migrate) plus the changelog line in Task 11; §5→Task 6; §6→Tasks 4, 5; §7→Task 7; §8→Task 10; §9→Tasks 9, 10; §10→Tasks 8, 9; §11→Task 7 (`asOptionalCount` keeps absent as `undefined`); §12→tests distributed across every task.
- **Naming consistency.** `redactSqlForSink` returns `RedactedStatement`; `attachEvidenceToSignals` consumes `StatementRow[]`; the evidence variant is `TelemetrySqlEvidence` with statements typed `TelemetrySqlStatementEvidence` — the same names in Tasks 5, 6, 9 and 10.
- **Two re-baselined pins are called out explicitly** (Task 8's KQL snapshot, Task 10's byte-identical golden) with an instruction to read the diff rather than accept it.
- **Known soft spot:** Task 5's tokenizer is the security boundary and the corpus is the only thing guarding it. Grow the corpus with every real payload seen; a statement the tokenizer cannot parse must stay dropped rather than "best effort".
