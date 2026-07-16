# SQL Evidence Layer v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach the issuing SQL statements (sampled cost + sampled hit count + separate `sqlRank`) to each relevant finding, and surface the batch manifest's measured per-activity SQL beside the sampled-attributed cost.

**Architecture:** A pure post-detection enrichment pass (`src/semantic/sql-evidence.ts`) walks the processed call tree once, maps each SQL node to its owning AL routine (nearest-AL-ancestor resolves the routine name; the SQL node's own `applicationDefinition` supplies the object when valid), then unions that SQL across each finding's `involvedMethods` with a per-detector op-type filter. Activity-level measured SQL comes from `ProfileMetadata` threaded through `AnalyzeOptions.metadata`. Shared SQL-text helpers move to `src/core/sql-node.ts` (also fixing the first-`$` table-name bug in the `--deep` payload).

**Tech Stack:** Bun + TypeScript, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-16-sql-evidence-layer-design.md` — read it if a requirement here seems ambiguous; the spec governs.

## Global Constraints

- All per-finding SQL is a **sampled estimate**: field names say `sampled*`, provenance literal is `"sampled-estimate"`, display marker says *sampled*. NEVER the words "exact", "measured", "confirmed", or "ran N times" for profile-derived SQL.
- NEVER mutate `DetectedPattern.impact`, `fingerprint`, `id`, `involvedMethods`, `severity` in the enrichment pass. Only `sqlEvidence` and `sqlRank` may be set.
- `totalSampledCostUs` / `totalSampledHitCount` / `sqlRank` computed from the FULL filtered statement set; only `statements` is truncated (top-5 by `sampledCostUs`) for display.
- No `unaccountedMs`, no subtraction across manifest duration fields (they overlap — proven: `67350−63803−218−63489 = −60160`).
- Enrichment is a no-op unless the profile is sampling (`processed.type === "sampling"`, `sourceFormat !== "ir-json"`) AND at least one SQL node exists.
- Formatter parity: the new `sqlActivity` section must be added to `AnalysisSectionType`/`SECTION_ORDER` and `BatchSectionType`/`BATCH_SECTION_ORDER`; TypeScript then forces every formatter to implement it.
- Method-label format is `"FunctionName (ObjectType ObjectId)"` and the routine key format is `` `${functionName}_${objectType}_${objectId}` `` (must match `aggregateByMethod`, `src/core/aggregator.ts:63`).
- Repo runs on Bun: tests `bun test <file>`, typecheck `bunx tsc --noEmit`. Commit after every task.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/core/sql-node.ts` | **create** | Shared SQL-text helpers: predicate, op classifier, table parser (correct `$` semantics), shape normalizer |
| `src/explain/payloads/sql-patterns.ts` | modify | Consume `sql-node.ts`; drops its buggy local `extractTableName` |
| `src/types/patterns.ts` | modify | `SqlStatementEvidence`, `SqlEvidence`, `sqlEvidence?`/`sqlRank?` on `DetectedPattern` |
| `src/output/types.ts` | modify | `SqlActivityCorroboration`, `sqlActivity?` on `AnalysisResult` |
| `src/semantic/identity.ts` | modify | Extract node-compatible `isAlRoutineFrameParts` |
| `src/semantic/sql-evidence.ts` | **create** | `buildSqlByRoutine`, `attachSqlEvidence`, `buildSqlActivityCorroboration`, `SQL_EVIDENCE_OPS` |
| `src/core/analyzer.ts` | modify | Pipeline hook + `AnalyzeOptions.metadata` |
| `src/core/batch-analyzer.ts` | modify | Thread `metadata[i]` into each `analyzeProfile` by original index |
| `src/output/sections.ts`, `src/output/batch-sections.ts` | modify | New `sqlActivity` section type + order |
| `src/cli/formatters/{terminal,json,markdown,html}.ts` | modify | `sqlActivity` renderer + per-finding `sqlEvidence` in patterns renderer |
| `src/cli/formatters/{batch-terminal,batch-markdown,batch-html}.ts` | modify | Batch `sqlActivity` renderer |
| `src/cli/commands/analyze.ts`, `src/mcp/server.ts` | modify | `--sort sql` flag / `sort` param |
| `test/core/sql-node.test.ts`, `test/semantic/sql-evidence.test.ts` | **create** | Unit tests |

Real fixture with SQL: `test/fixtures/batch-recorded/profile-1.alcpuprofile` (181 SQL nodes of 488) + `test/fixtures/batch-recorded/manifest.json` (entry 0: `sqlCallCount: 1381, sqlCallDuration: 382`).

---

### Task 1: Shared SQL-node helpers (`src/core/sql-node.ts`)

**Files:**
- Create: `src/core/sql-node.ts`
- Test: `test/core/sql-node.test.ts`

**Interfaces:**
- Consumes: nothing (pure string functions + `ProcessedNode` type).
- Produces (later tasks import these exact names):
  - `SQL_PREFIX_RE: RegExp`
  - `isSqlFunctionName(name: string): boolean`
  - `isSqlNode(node: ProcessedNode): boolean`
  - `classifySqlOperation(sql: string): "SELECT" | "COUNT" | "INSERT" | "UPDATE" | "DELETE" | "OTHER"`
  - `hasReadUncommitted(sql: string): boolean`
  - `hasAggregate(sql: string): boolean`
  - `normalizeSqlShape(sql: string): string`
  - `parseSqlTable(sql: string): { table: string | null; extensionAppId: string | null }`

- [ ] **Step 1: Write the failing test**

Create `test/core/sql-node.test.ts`:

```typescript
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
		expect(isSqlFunctionName('SELECT COUNT(*) FROM dbo."X" WHERE a=@0')).toBe(true);
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
		expect(classifySqlOperation('SELECT TOP (1) "A" FROM dbo."T"')).toBe("SELECT");
		expect(classifySqlOperation('SELECT COUNT(*) FROM dbo."T"')).toBe("COUNT");
		expect(classifySqlOperation('INSERT INTO dbo."T" (A) VALUES (@0)')).toBe("INSERT");
		expect(classifySqlOperation('UPDATE dbo."T" SET A=@0')).toBe("UPDATE");
		expect(classifySqlOperation('DELETE FROM dbo."T" WHERE A=@0')).toBe("DELETE");
		expect(classifySqlOperation('MERGE INTO dbo."T" USING ...')).toBe("OTHER");
	});
});

describe("hasReadUncommitted / hasAggregate", () => {
	test("detects hints and aggregates", () => {
		expect(hasReadUncommitted('SELECT * FROM dbo."T" WITH(READUNCOMMITTED)')).toBe(true);
		expect(hasReadUncommitted('SELECT * FROM dbo."T"')).toBe(false);
		expect(hasAggregate('SELECT SUM("Amount") FROM dbo."T"')).toBe(true);
		expect(hasAggregate('SELECT COUNT(*) FROM dbo."T"')).toBe(true);
		expect(hasAggregate('SELECT "Amount" FROM dbo."T"')).toBe(false);
	});
});

describe("normalizeSqlShape", () => {
	test("blanks string and numeric literals, keeps @params", () => {
		expect(normalizeSqlShape(`SELECT * FROM t WHERE "No."='C10' AND x=42`)).toBe(
			`SELECT * FROM t WHERE "No."='?' AND x=?`,
		);
		expect(normalizeSqlShape(`WHERE a=@0 AND b=@1`)).toBe(`WHERE a=@0 AND b=@1`);
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
			parseSqlTable(`DELETE FROM dbo."CRONUS Danmark A_S$Cash Flow Entry$${GUID}"`),
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
			parseSqlTable(`SELECT [Metadata] FROM dbo.[Application Object Metadata] WHERE x=@0`),
		).toEqual({ table: "Application Object Metadata", extensionAppId: null });
	});
	test("plain name without company", () => {
		expect(parseSqlTable(`SELECT * FROM dbo."Sales Line"`)).toEqual({
			table: "Sales Line",
			extensionAppId: null,
		});
	});
	test("UPDATE / INSERT INTO forms", () => {
		expect(parseSqlTable(`UPDATE dbo."C$Sales Header" SET "Status"=@0`)).toEqual({
			table: "Sales Header",
			extensionAppId: null,
		});
		expect(parseSqlTable(`INSERT INTO dbo."C$Sales Line" (A) VALUES (@0)`)).toEqual({
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
		expect(parseSqlTable(`SELECT @@SPID`)).toEqual({ table: null, extensionAppId: null });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/core/sql-node.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/sql-node.js'`

- [ ] **Step 3: Write the implementation**

Create `src/core/sql-node.ts`:

```typescript
import type { ProcessedNode } from "../types/processed.js";

/**
 * Shared SQL-node helpers. A BC sampling profile embeds SQL statements as
 * call-tree nodes whose callFrame.functionName IS the statement text. These
 * helpers are the single source of truth for recognizing and parsing them —
 * consumed by the --deep AI payload (explain/payloads/sql-patterns.ts) and
 * the SQL evidence layer (semantic/sql-evidence.ts).
 */

/** Statement prefixes that mark a functionName as embedded SQL. */
export const SQL_PREFIX_RE = /^(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i;

export function isSqlFunctionName(name: string): boolean {
	return SQL_PREFIX_RE.test(name);
}

export function isSqlNode(node: ProcessedNode): boolean {
	return isSqlFunctionName(node.callFrame.functionName);
}

export type SqlOperation = "SELECT" | "COUNT" | "INSERT" | "UPDATE" | "DELETE" | "OTHER";

/** SELECT COUNT(...) is its own class (Count/IsEmpty anti-pattern signal). */
export function classifySqlOperation(sql: string): SqlOperation {
	if (/^SELECT\s+COUNT\s*\(/i.test(sql)) return "COUNT";
	const m = SQL_PREFIX_RE.exec(sql);
	switch (m?.[1]?.toUpperCase()) {
		case "SELECT":
			return "SELECT";
		case "INSERT":
			return "INSERT";
		case "UPDATE":
			return "UPDATE";
		case "DELETE":
			return "DELETE";
		default:
			return "OTHER"; // MERGE and anything unrecognized
	}
}

export function hasReadUncommitted(sql: string): boolean {
	return /WITH\s*\(\s*READUNCOMMITTED\s*\)/i.test(sql);
}

/** Aggregate function present (CalcFields-style query signal). */
export function hasAggregate(sql: string): boolean {
	return /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(sql);
}

/**
 * Conservative literal-blanking for query-SHAPE grouping: string literals
 * (with '' escapes) and bare numbers become `?`. `@N` bind parameters are
 * already placeholders and stay untouched. This groups by shape only — on a
 * sampling profile the grouped hit count is a SAMPLED total, never proof a
 * query executed N times.
 */
export function normalizeSqlShape(sql: string): string {
	return sql
		.replace(/'(?:[^']|'')*'/g, "'?'")
		.replace(/(?<![@\w])\d+(?:\.\d+)?\b/g, "?");
}

const GUID_RE =
	/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/**
 * Parse the target table of a SQL statement into logical parts.
 *
 * BC physical names: `Company$Table`, `Company$Table$AppGuid`, `Table$AppGuid`
 * (DataPerCompany=false), bracket-quoted `[System Table]` (never $-split),
 * or a bare name. Splits on EVERY `$` — the predecessor in sql-patterns.ts
 * split at the FIRST `$` and returned the company name.
 *
 * Unparseable (>3 segments, non-GUID 3rd segment, 128-char truncation
 * artifacts) -> { table: null } — callers keep the raw SQL text instead.
 */
export function parseSqlTable(sql: string): {
	table: string | null;
	extensionAppId: string | null;
} {
	let match: RegExpMatchArray | null;
	if (/^INSERT\b/i.test(sql)) {
		match = sql.match(/\bINTO\s+(?:dbo\.)?(?:"([^"]+)"|\[([^\]]+)\]|(\S+))/i);
	} else if (/^UPDATE\b/i.test(sql)) {
		match = sql.match(/^UPDATE\s+(?:dbo\.)?(?:"([^"]+)"|\[([^\]]+)\]|(\S+))/i);
	} else if (/^MERGE\b/i.test(sql)) {
		match = sql.match(/\bMERGE\s+(?:INTO\s+)?(?:dbo\.)?(?:"([^"]+)"|\[([^\]]+)\]|(\S+))/i);
	} else {
		match = sql.match(/\bFROM\s+(?:dbo\.)?(?:"([^"]+)"|\[([^\]]+)\]|(\S+))/i);
	}
	if (!match) return { table: null, extensionAppId: null };

	const bracket = match[2];
	if (bracket) return { table: bracket, extensionAppId: null }; // system table — no $ semantics

	const raw = match[1] || match[3];
	if (!raw) return { table: null, extensionAppId: null };

	const parts = raw.split("$");
	if (parts.length === 1) return { table: parts[0], extensionAppId: null };
	if (parts.length === 2) {
		return GUID_RE.test(parts[1])
			? { table: parts[0], extensionAppId: parts[1] } // Table$guid
			: { table: parts[1], extensionAppId: null }; // Company$Table
	}
	if (parts.length === 3 && GUID_RE.test(parts[2])) {
		return { table: parts[1], extensionAppId: parts[2] }; // Company$Table$guid
	}
	return { table: null, extensionAppId: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/core/sql-node.test.ts`
Expected: PASS (all describe blocks)

- [ ] **Step 5: Typecheck and commit**

```bash
bunx tsc --noEmit
git add src/core/sql-node.ts test/core/sql-node.test.ts
git commit -m "feat(core): shared SQL-node helpers with correct \$-split table parser"
```

---

### Task 2: Point `sql-patterns.ts` at the shared helpers

**Files:**
- Modify: `src/explain/payloads/sql-patterns.ts`
- Test: `test/explain/payloads/sql-patterns.test.ts` (existing — update expectations)

**Interfaces:**
- Consumes: `isSqlNode`, `parseSqlTable` from `src/core/sql-node.ts` (Task 1).
- Produces: `extractSqlPatterns` unchanged in signature; its `table` grouping now uses the CORRECT table name (`Sales Header`, not `CRONUS Danmark A_S`).

**Note:** this deliberately changes `--deep` payload grouping for `Company$Table` names — that is the bug fix, not a regression. Existing tests that pinned the company-name behavior must be updated to expect the table name.

- [ ] **Step 1: Update the existing test expectations**

Open `test/explain/payloads/sql-patterns.test.ts`. Find any assertion that expects a table value equal to a *company* segment (text before the first `$`) and change it to the table segment. Add one new pin:

```typescript
test("groups Company$Table by TABLE name, not company (regression pin)", () => {
	const node = makeSqlNode(
		'SELECT COUNT(*) FROM dbo."CRONUS Danmark A_S$Sales Header" WITH(READUNCOMMITTED) WHERE ("Document Type"=@0)',
	);
	const groups = extractSqlPatterns([node]);
	expect(groups[0]?.table).toBe("Sales Header");
});
```

(`makeSqlNode` — reuse the file's existing node factory; if none exists, build the minimal `ProcessedNode` object literal the file's other tests use.)

- [ ] **Step 2: Run to verify the new pin fails**

Run: `bun test test/explain/payloads/sql-patterns.test.ts`
Expected: FAIL — the new pin gets `"CRONUS Danmark A_S"`.

- [ ] **Step 3: Refactor the implementation**

In `src/explain/payloads/sql-patterns.ts`:
1. Delete the local `SQL_PREFIX_RE`, `extractTableName`, and `isSqlNode` (lines 14-60).
2. Add the import and a thin adapter:

```typescript
import { isSqlNode, parseSqlTable } from "../../core/sql-node.js";
```

3. In `extractSqlPatterns`, replace `const table = extractTableName(fnName);` with:

```typescript
		const table = parseSqlTable(fnName).table;
```

Everything else in the file stays as-is.

- [ ] **Step 4: Run tests**

Run: `bun test test/explain/payloads/sql-patterns.test.ts && bunx tsc --noEmit`
Expected: PASS. Also run `bun test test/explain/` — deep-analyzer/prompt tests that embed table names may need the same company→table expectation update; fix any that assert the old value.

- [ ] **Step 5: Commit**

```bash
git add src/explain/payloads/sql-patterns.ts test/explain/
git commit -m "fix(explain): --deep SQL grouping uses real table name (was company segment)"
```

---

### Task 3: Evidence types + node-compatible AL-frame predicate + `buildSqlByRoutine`

**Files:**
- Modify: `src/types/patterns.ts` (evidence types + 2 fields on `DetectedPattern`)
- Modify: `src/semantic/identity.ts` (extract `isAlRoutineFrameParts`)
- Create: `src/semantic/sql-evidence.ts` (`buildSqlByRoutine` only in this task)
- Test: `test/semantic/sql-evidence.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `ProcessedProfile`/`ProcessedNode`; `isAlRoutineFrameParts` (new, below).
- Produces (Tasks 4-7 rely on these EXACT shapes):

```typescript
// types/patterns.ts
export interface SqlStatementEvidence {
	text: string; // first-seen normalized shape, truncated to 200 chars
	operation: "SELECT" | "COUNT" | "INSERT" | "UPDATE" | "DELETE" | "OTHER";
	table: string | null;
	extensionAppId: string | null;
	readUncommitted: boolean;
	sampledHitCount: number; // Σ hitCount — SAMPLED, not executions
	sampledCostUs: number; // Σ node.selfTime — SAMPLED estimate
	attribution: "object-method" | "ancestor-fallback";
}
export interface SqlEvidence {
	statements: SqlStatementEvidence[]; // top-5 by sampledCostUs (display only)
	totalSampledCostUs: number; // full-set total
	totalSampledHitCount: number; // full-set total
	provenance: "sampled-estimate";
	attribution: "object-method" | "ancestor-fallback" | "mixed";
}
// on DetectedPattern (additive, optional):
sqlEvidence?: SqlEvidence;
sqlRank?: number;

// semantic/identity.ts
export function isAlRoutineFrameParts(frame: { functionName: string; isBuiltin: boolean }): boolean;

// semantic/sql-evidence.ts
export const UNATTRIBUTED_KEY = "";
export function buildSqlByRoutine(profile: ProcessedProfile): Map<string, SqlStatementEvidence[]>;
```

- [ ] **Step 1: Add the types**

In `src/types/patterns.ts`, above `DetectedPattern`, add `SqlStatementEvidence` and `SqlEvidence` exactly as in the Interfaces block above (with doc comments noting SAMPLED semantics). Inside `DetectedPattern`, after `fingerprint?: string;`, add:

```typescript
	/**
	 * SQL statements correlated to this finding's routines (SAMPLED estimates —
	 * a sampling profile's hitCount is a sample count, not an invocation count).
	 * Descriptive metadata only: never identity, never impact. Absent when the
	 * profile carries no SQL (ir-json, instrumentation) or nothing matched.
	 */
	sqlEvidence?: SqlEvidence;
	/** = sqlEvidence.totalSampledCostUs. Separate rank signal; impact is untouched. */
	sqlRank?: number;
```

- [ ] **Step 2: Extract the node-compatible predicate**

In `src/semantic/identity.ts`, replace the body of `isAlRoutineFrame` (lines 322-331) with a delegation and add the parts version right above it:

```typescript
/**
 * Shape-independent core of isAlRoutineFrame: works for MethodBreakdown
 * (m.functionName/m.isBuiltin) AND ProcessedNode
 * ({ functionName: node.callFrame.functionName, isBuiltin: node.isBuiltinCodeUnitCall === true }).
 */
export function isAlRoutineFrameParts(frame: {
	functionName: string;
	isBuiltin: boolean;
}): boolean {
	if (frame.isBuiltin) return false;
	const lower = frame.functionName.toLowerCase().trimStart();
	for (const prefix of SQL_PREFIXES) {
		if (lower.startsWith(prefix)) return false;
	}
	return true;
}

export function isAlRoutineFrame(m: MethodBreakdown): boolean {
	return isAlRoutineFrameParts({
		functionName: m.functionName,
		isBuiltin: m.isBuiltin === true,
	});
}
```

(Keep the existing doc comment on `isAlRoutineFrame`.)

- [ ] **Step 3: Write the failing tests**

Create `test/semantic/sql-evidence.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { analyzeProfile } from "../../src/core/analyzer.js"; // used in later tasks' tests
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import {
	UNATTRIBUTED_KEY,
	buildSqlByRoutine,
} from "../../src/semantic/sql-evidence.js";
import type { ProcessedNode, ProcessedProfile } from "../../src/types/processed.js";

/** Minimal synthetic node factory. */
let nextId = 1;
function makeNode(
	functionName: string,
	opts: {
		objectType?: string;
		objectId?: number;
		objectName?: string;
		hitCount?: number;
		selfTime?: number;
		isBuiltin?: boolean;
	} = {},
): ProcessedNode {
	return {
		id: nextId++,
		callFrame: { functionName, scriptId: "", url: "", lineNumber: 0, columnNumber: 0 },
		applicationDefinition: {
			objectType: opts.objectType ?? "CodeUnit",
			objectId: opts.objectId ?? 414,
			objectName: opts.objectName ?? "Release Sales Document",
		},
		hitCount: opts.hitCount ?? 1,
		children: [],
		depth: 0,
		selfTime: opts.selfTime ?? 100,
		totalTime: opts.selfTime ?? 100,
		selfTimePercent: 0,
		totalTimePercent: 0,
		isBuiltinCodeUnitCall: opts.isBuiltin,
	};
}

function link(parent: ProcessedNode, child: ProcessedNode): void {
	child.parent = parent;
	child.depth = parent.depth + 1;
	parent.children.push(child);
}

function makeProfile(roots: ProcessedNode[]): ProcessedProfile {
	const all: ProcessedNode[] = [];
	const walk = (n: ProcessedNode) => {
		all.push(n);
		n.children.forEach(walk);
	};
	roots.forEach(walk);
	return {
		type: "sampling",
		roots,
		allNodes: all,
		nodeMap: new Map(all.map((n) => [n.id, n])),
		totalDuration: 1000,
		totalSelfTime: 1000,
		activeSelfTime: 1000,
		idleSelfTime: 0,
		maxDepth: 3,
		samplingInterval: 100,
		nodeCount: all.length,
		startTime: 0,
		endTime: 1000,
	};
}

const SQL_A = `SELECT TOP (1) "No_" FROM dbo."CRONUS$Sales Header" WITH(READUNCOMMITTED) WHERE ("No_"='C10')`;
const SQL_A2 = `SELECT TOP (1) "No_" FROM dbo."CRONUS$Sales Header" WITH(READUNCOMMITTED) WHERE ("No_"='C20')`;
const SQL_UPD = `UPDATE dbo."CRONUS$Sales Header" SET "Status"=@0`;

describe("buildSqlByRoutine", () => {
	test("SQL under an AL routine is keyed by that routine; shapes group; sums accumulate", () => {
		const routine = makeNode("PostDocument", { objectType: "CodeUnit", objectId: 80 });
		const sql1 = makeNode(SQL_A, { hitCount: 3, selfTime: 300, objectType: "CodeUnit", objectId: 80 });
		const sql2 = makeNode(SQL_A2, { hitCount: 2, selfTime: 200, objectType: "CodeUnit", objectId: 80 });
		link(routine, sql1);
		link(routine, sql2);
		const map = buildSqlByRoutine(makeProfile([routine]));
		const items = map.get("PostDocument_CodeUnit_80");
		expect(items).toBeDefined();
		expect(items!.length).toBe(1); // same shape after literal blanking
		expect(items![0].sampledHitCount).toBe(5);
		expect(items![0].sampledCostUs).toBe(500);
		expect(items![0].operation).toBe("SELECT");
		expect(items![0].table).toBe("Sales Header");
		expect(items![0].readUncommitted).toBe(true);
		expect(items![0].attribution).toBe("object-method"); // SQL node carries a valid appDef object
	});

	test("SQL under a builtin wrapper attributes to the nearest AL ANCESTOR, not the wrapper", () => {
		const routine = makeNode("PostDocument", { objectType: "CodeUnit", objectId: 80 });
		const wrapper = makeNode("Microsoft.Dynamics.Nav.NavRecord.Find", { isBuiltin: true });
		const sql = makeNode(SQL_UPD, {
			hitCount: 1,
			selfTime: 50,
			objectType: "",
			objectId: -1,
			objectName: "",
		});
		link(routine, wrapper);
		link(wrapper, sql);
		const map = buildSqlByRoutine(makeProfile([routine]));
		const items = map.get("PostDocument_CodeUnit_80");
		expect(items).toBeDefined();
		expect(items![0].operation).toBe("UPDATE");
		expect(items![0].attribution).toBe("ancestor-fallback"); // appDef invalid -> ancestor object
	});

	test("SQL with NO AL ancestor lands in the unattributed bucket, not dropped", () => {
		const builtinRoot = makeNode("SystemRoot", { isBuiltin: true, objectType: "", objectId: -1 });
		const sql = makeNode(SQL_A, { hitCount: 1, selfTime: 10, objectType: "", objectId: -1, objectName: "" });
		link(builtinRoot, sql);
		const map = buildSqlByRoutine(makeProfile([builtinRoot]));
		expect(map.get(UNATTRIBUTED_KEY)?.length).toBe(1);
	});

	test("callee isolation: SQL under a CHILD routine belongs to the child, not the parent", () => {
		const parent = makeNode("Caller", { objectType: "CodeUnit", objectId: 1 });
		const child = makeNode("Callee", { objectType: "CodeUnit", objectId: 2 });
		const sql = makeNode(SQL_A, { hitCount: 1, selfTime: 10, objectType: "CodeUnit", objectId: 2 });
		link(parent, child);
		link(child, sql);
		const map = buildSqlByRoutine(makeProfile([parent]));
		expect(map.get("Callee_CodeUnit_2")).toBeDefined();
		expect(map.get("Caller_CodeUnit_1")).toBeUndefined();
	});

	test("real BC28 capture: profile-1 yields SQL evidence for real routines", async () => {
		const parsed = await parseProfile("test/fixtures/batch-recorded/profile-1.alcpuprofile");
		const processed = processProfile(parsed);
		const map = buildSqlByRoutine(processed);
		let total = 0;
		for (const items of map.values()) for (const it of items) total += it.sampledHitCount;
		expect(map.size).toBeGreaterThan(0);
		expect(total).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 4: Run to verify failure**

Run: `bun test test/semantic/sql-evidence.test.ts`
Expected: FAIL — `Cannot find module '../../src/semantic/sql-evidence.js'`

- [ ] **Step 5: Implement `buildSqlByRoutine`**

Create `src/semantic/sql-evidence.ts`:

```typescript
import {
	classifySqlOperation,
	hasReadUncommitted,
	isSqlNode,
	normalizeSqlShape,
	parseSqlTable,
} from "../core/sql-node.js";
import type { SqlStatementEvidence } from "../types/patterns.js";
import type { ProcessedNode, ProcessedProfile } from "../types/processed.js";
import { isAlRoutineFrameParts } from "./identity.js";

/** Bucket key for SQL with no resolvable owning routine. Never silently dropped. */
export const UNATTRIBUTED_KEY = "";

const TEXT_LIMIT = 200;

function isAlRoutineNode(node: ProcessedNode): boolean {
	return isAlRoutineFrameParts({
		functionName: node.callFrame.functionName,
		isBuiltin: node.isBuiltinCodeUnitCall === true,
	});
}

/** A SQL node's applicationDefinition self-identifies its issuer when populated. */
function hasValidObject(node: ProcessedNode): boolean {
	const { objectType, objectId, objectName } = node.applicationDefinition;
	return objectId >= 0 && objectType !== "" && objectName !== "";
}

/**
 * Map routine key (`${functionName}_${objectType}_${objectId}`, matching
 * aggregateByMethod in core/aggregator.ts) -> SQL that routine issued.
 *
 * Owning routine of a SQL node:
 *  - functionName ALWAYS comes from the nearest AL-routine ancestor (a SQL
 *    node carries no routine name of its own — its functionName IS the SQL).
 *  - object part: the SQL node's own applicationDefinition when valid
 *    (self-identification, attribution "object-method"), else the ancestor's
 *    object (attribution "ancestor-fallback").
 *  - no AL ancestor at all -> UNATTRIBUTED_KEY bucket.
 *
 * All counts/costs are SAMPLED (hitCount is a sample count on sampling
 * profiles) — identical normalized shapes merge, sums accumulate.
 */
export function buildSqlByRoutine(
	profile: ProcessedProfile,
): Map<string, SqlStatementEvidence[]> {
	// key -> shape -> evidence
	const byRoutine = new Map<string, Map<string, SqlStatementEvidence>>();

	for (const node of profile.allNodes) {
		if (!isSqlNode(node)) continue;

		// Nearest AL-routine ancestor supplies the routine name.
		let ancestor: ProcessedNode | undefined = node.parent;
		while (ancestor && !isAlRoutineNode(ancestor)) ancestor = ancestor.parent;

		let key: string;
		let attribution: SqlStatementEvidence["attribution"];
		if (!ancestor) {
			key = UNATTRIBUTED_KEY;
			attribution = "ancestor-fallback";
		} else if (hasValidObject(node)) {
			const { objectType, objectId } = node.applicationDefinition;
			key = `${ancestor.callFrame.functionName}_${objectType}_${objectId}`;
			attribution = "object-method";
		} else {
			const { objectType, objectId } = ancestor.applicationDefinition;
			key = `${ancestor.callFrame.functionName}_${objectType}_${objectId}`;
			attribution = "ancestor-fallback";
		}

		const sql = node.callFrame.functionName;
		const shape = normalizeSqlShape(sql);
		let shapes = byRoutine.get(key);
		if (!shapes) {
			shapes = new Map();
			byRoutine.set(key, shapes);
		}
		const existing = shapes.get(shape);
		if (existing) {
			existing.sampledHitCount += node.hitCount;
			existing.sampledCostUs += node.selfTime;
		} else {
			const parsedTable = parseSqlTable(sql);
			shapes.set(shape, {
				text: shape.length > TEXT_LIMIT ? shape.slice(0, TEXT_LIMIT) : shape,
				operation: classifySqlOperation(sql),
				table: parsedTable.table,
				extensionAppId: parsedTable.extensionAppId,
				readUncommitted: hasReadUncommitted(sql),
				sampledHitCount: node.hitCount,
				sampledCostUs: node.selfTime,
				attribution,
			});
		}
	}

	const result = new Map<string, SqlStatementEvidence[]>();
	for (const [key, shapes] of byRoutine) {
		result.set(
			key,
			Array.from(shapes.values()).sort((a, b) => b.sampledCostUs - a.sampledCostUs),
		);
	}
	return result;
}
```

- [ ] **Step 6: Run tests**

Run: `bun test test/semantic/sql-evidence.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types/patterns.ts src/semantic/identity.ts src/semantic/sql-evidence.ts test/semantic/sql-evidence.test.ts
git commit -m "feat(semantic): buildSqlByRoutine — SQL-node->routine attribution with sampled provenance"
```

---

### Task 4: `attachSqlEvidence` — union across involvedMethods + op-type filter + rank

**Files:**
- Modify: `src/semantic/sql-evidence.ts`
- Test: `test/semantic/sql-evidence.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's `buildSqlByRoutine` output; `DetectedPattern` from `types/patterns.ts`.
- Produces:

```typescript
export const SQL_EVIDENCE_OPS: Record<string, (s: SqlStatementEvidence) => boolean>;
export function attachSqlEvidence(
	patterns: DetectedPattern[],
	sqlByRoutine: Map<string, SqlStatementEvidence[]>,
): void; // mutates ONLY pattern.sqlEvidence and pattern.sqlRank
```

- [ ] **Step 1: Write the failing tests**

Append to `test/semantic/sql-evidence.test.ts`:

```typescript
import { attachSqlEvidence } from "../../src/semantic/sql-evidence.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

function makePattern(id: string, involvedMethods: string[]): DetectedPattern {
	return {
		id,
		severity: "warning",
		title: id,
		description: "",
		impact: 12345,
		involvedMethods,
		evidence: "",
	};
}

describe("attachSqlEvidence", () => {
	function mapWith(key: string, items: Partial<SqlStatementEvidence>[]): Map<string, SqlStatementEvidence[]> {
		const full = items.map(
			(p, i): SqlStatementEvidence => ({
				text: p.text ?? `SELECT ?${i}`,
				operation: p.operation ?? "SELECT",
				table: p.table ?? "Sales Header",
				extensionAppId: null,
				readUncommitted: false,
				sampledHitCount: p.sampledHitCount ?? 1,
				sampledCostUs: p.sampledCostUs ?? 10,
				attribution: p.attribution ?? "object-method",
			}),
		);
		return new Map([[key, full]]);
	}

	test("attaches matching op-type SQL; impact untouched; sqlRank set", () => {
		const p = makePattern("missing-setloadfields", ["PostDocument (CodeUnit 80)"]);
		attachSqlEvidence([p], mapWith("PostDocument_CodeUnit_80", [
			{ operation: "SELECT", sampledCostUs: 400, sampledHitCount: 4 },
			{ operation: "UPDATE", sampledCostUs: 999 }, // filtered out for this pattern id
		]));
		expect(p.sqlEvidence).toBeDefined();
		expect(p.sqlEvidence!.statements.length).toBe(1);
		expect(p.sqlEvidence!.totalSampledCostUs).toBe(400);
		expect(p.sqlEvidence!.totalSampledHitCount).toBe(4);
		expect(p.sqlEvidence!.provenance).toBe("sampled-estimate");
		expect(p.sqlRank).toBe(400);
		expect(p.impact).toBe(12345); // NEVER mutated
	});

	test("unions across ALL involvedMethods entries and skips SQL-frame labels", () => {
		const p = makePattern("repeated-siblings", [
			"Caller (CodeUnit 1)",
			'SELECT TOP (?) "No_" FROM x (TableData 36)', // SQL frame label -> skipped
		]);
		const map = mapWith("Caller_CodeUnit_1", [{ operation: "SELECT", sampledCostUs: 70 }]);
		attachSqlEvidence([p], map);
		expect(p.sqlEvidence!.totalSampledCostUs).toBe(70);
	});

	test("union across parent AND child routine entries", () => {
		const p = makePattern("repeated-siblings", [
			"Caller (CodeUnit 1)",
			"Callee (CodeUnit 2)",
		]);
		const map = new Map([
			...mapWith("Caller_CodeUnit_1", [{ sampledCostUs: 30 }]),
			...mapWith("Callee_CodeUnit_2", [{ sampledCostUs: 50 }]),
		]);
		attachSqlEvidence([p], map);
		expect(p.sqlEvidence!.totalSampledCostUs).toBe(80);
	});

	test("op-type filters: modify-in-loop takes UPDATE only; calcfields needs aggregate", () => {
		const upd = makePattern("modify-in-loop", ["M (CodeUnit 9)"]);
		attachSqlEvidence([upd], mapWith("M_CodeUnit_9", [
			{ operation: "UPDATE", sampledCostUs: 5 },
			{ operation: "SELECT", sampledCostUs: 500 },
		]));
		expect(upd.sqlEvidence!.statements[0].operation).toBe("UPDATE");
		expect(upd.sqlEvidence!.totalSampledCostUs).toBe(5);

		const calc = makePattern("calcfields-in-loop", ["M (CodeUnit 9)"]);
		attachSqlEvidence([calc], mapWith("M_CodeUnit_9", [
			{ operation: "SELECT", text: "SELECT SUM(?) FROM t", sampledCostUs: 8 },
			{ operation: "SELECT", text: "SELECT a FROM t", sampledCostUs: 9 },
			{ operation: "COUNT", text: "SELECT COUNT(*) FROM t", sampledCostUs: 3 },
		]));
		expect(calc.sqlEvidence!.totalSampledCostUs).toBe(11); // SUM + COUNT rows only
	});

	test("unknown pattern id -> no evidence (not in the map = no signal)", () => {
		const p = makePattern("deep-call-stack", ["M (CodeUnit 9)"]);
		attachSqlEvidence([p], mapWith("M_CodeUnit_9", [{ sampledCostUs: 100 }]));
		expect(p.sqlEvidence).toBeUndefined();
		expect(p.sqlRank).toBeUndefined();
	});

	test("no matching SQL -> silent (fields absent)", () => {
		const p = makePattern("missing-setloadfields", ["Other (CodeUnit 7)"]);
		attachSqlEvidence([p], mapWith("M_CodeUnit_9", [{ sampledCostUs: 100 }]));
		expect(p.sqlEvidence).toBeUndefined();
	});

	test("rank-inversion pin: totals from FULL set, statements truncated to top-5", () => {
		const p = makePattern("missing-setloadfields", ["M (CodeUnit 9)"]);
		const six = Array.from({ length: 6 }, (_, i) => ({
			operation: "SELECT" as const,
			text: `SELECT col${i} FROM t${i}`,
			sampledCostUs: 10,
			sampledHitCount: 1,
		}));
		attachSqlEvidence([p], mapWith("M_CodeUnit_9", six));
		expect(p.sqlEvidence!.statements.length).toBe(5); // display truncation
		expect(p.sqlEvidence!.totalSampledCostUs).toBe(60); // FULL set — 6x10, not 5x10
		expect(p.sqlRank).toBe(60);
	});

	test("attribution derives: all object-method -> object-method; mixed -> mixed", () => {
		const p = makePattern("missing-setloadfields", ["M (CodeUnit 9)"]);
		attachSqlEvidence([p], mapWith("M_CodeUnit_9", [
			{ attribution: "object-method", sampledCostUs: 10, text: "SELECT a FROM t" },
			{ attribution: "ancestor-fallback", sampledCostUs: 5, text: "SELECT b FROM u" },
		]));
		expect(p.sqlEvidence!.attribution).toBe("mixed");
	});

	test("mutation guard: only sqlEvidence/sqlRank change", () => {
		const p = makePattern("missing-setloadfields", ["M (CodeUnit 9)"]);
		const before = structuredClone(p);
		attachSqlEvidence([p], mapWith("M_CodeUnit_9", [{ sampledCostUs: 10 }]));
		const after = structuredClone(p);
		delete (after as Record<string, unknown>).sqlEvidence;
		delete (after as Record<string, unknown>).sqlRank;
		expect(after).toEqual(before);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/semantic/sql-evidence.test.ts`
Expected: FAIL — `attachSqlEvidence` not exported.

- [ ] **Step 3: Implement**

Append to `src/semantic/sql-evidence.ts`:

```typescript
import type { DetectedPattern } from "../types/patterns.js"; // merge into existing import block
import { hasAggregate, isSqlFunctionName } from "../core/sql-node.js"; // merge into existing import

/**
 * Parse a detector display label `"FunctionName (ObjectType ObjectId)"` back
 * into a routine key. Same grammar as LABEL_RE in lifecycle/wire.ts (greedy
 * first group — only the LAST " (" starts the object suffix). Duplicated here
 * (one line) rather than importing lifecycle into semantic.
 */
const LABEL_RE = /^(.+) \((\S+) (\d+)\)$/;

function routineKeyFromLabel(label: string): string | null {
	const m = LABEL_RE.exec(label);
	if (!m) return null;
	if (isSqlFunctionName(m[1])) return null; // SQL frame label — not a routine
	return `${m[1]}_${m[2]}_${m[3]}`;
}

const isDml = (s: SqlStatementEvidence): boolean =>
	s.operation === "INSERT" || s.operation === "UPDATE" || s.operation === "DELETE";

/**
 * Which statements count as evidence per pattern id. Absent id = no signal
 * (same discipline as CORROBORATION_MAP). NOTE: unlike CORROBORATION_MAP's
 * anchorIndex (which names the LOOP OWNER), evidence needs the SQL ISSUER —
 * we union across all routine entries instead of picking an index.
 */
export const SQL_EVIDENCE_OPS: Record<string, (s: SqlStatementEvidence) => boolean> = {
	"missing-setloadfields": (s) => s.operation === "SELECT",
	"incomplete-setloadfields": (s) => s.operation === "SELECT",
	"unfiltered-findset": (s) => s.operation === "SELECT",
	"unindexed-filter": (s) => s.operation === "SELECT",
	"calcfields-in-loop": (s) =>
		(s.operation === "SELECT" || s.operation === "COUNT") && hasAggregate(s.text),
	"modify-in-loop": (s) => s.operation === "UPDATE",
	"insert-in-loop": (s) => s.operation === "INSERT",
	"delete-in-loop": (s) => s.operation === "DELETE",
	"record-op-in-loop": isDml,
	"high-hit-count": () => true,
	"repeated-siblings": () => true,
};

const DISPLAY_LIMIT = 5;

/**
 * Attach SQL evidence + sqlRank to each finding. Mutates ONLY sqlEvidence and
 * sqlRank — never impact, fingerprint, or any identity field. Silent when
 * nothing matches.
 */
export function attachSqlEvidence(
	patterns: DetectedPattern[],
	sqlByRoutine: Map<string, SqlStatementEvidence[]>,
): void {
	for (const pattern of patterns) {
		const filter = SQL_EVIDENCE_OPS[pattern.id];
		if (!filter) continue;

		// Union across every involvedMethods entry that is a real routine.
		const seen = new Set<string>();
		const matched: SqlStatementEvidence[] = [];
		for (const label of pattern.involvedMethods) {
			const key = routineKeyFromLabel(label);
			if (key === null || seen.has(key)) continue;
			seen.add(key);
			for (const item of sqlByRoutine.get(key) ?? []) {
				if (filter(item)) matched.push(item);
			}
		}
		if (matched.length === 0) continue;

		// Totals from the FULL set; truncate only the display list.
		let totalCost = 0;
		let totalHits = 0;
		const attributions = new Set<string>();
		for (const s of matched) {
			totalCost += s.sampledCostUs;
			totalHits += s.sampledHitCount;
			attributions.add(s.attribution);
		}
		const sorted = [...matched].sort((a, b) => b.sampledCostUs - a.sampledCostUs);

		pattern.sqlEvidence = {
			statements: sorted.slice(0, DISPLAY_LIMIT),
			totalSampledCostUs: totalCost,
			totalSampledHitCount: totalHits,
			provenance: "sampled-estimate",
			attribution:
				attributions.size > 1
					? "mixed"
					: (attributions.values().next().value as "object-method" | "ancestor-fallback"),
		};
		pattern.sqlRank = totalCost;
	}
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/semantic/sql-evidence.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/semantic/sql-evidence.ts test/semantic/sql-evidence.test.ts
git commit -m "feat(semantic): attachSqlEvidence — union attribution, op-type filter, full-set rank"
```

---

### Task 5: Activity corroboration + metadata threading

**Files:**
- Modify: `src/output/types.ts` (type + field)
- Modify: `src/semantic/sql-evidence.ts` (`buildSqlActivityCorroboration`)
- Modify: `src/core/analyzer.ts` (`AnalyzeOptions.metadata` — declaration only; the hook is Task 6)
- Modify: `src/core/batch-analyzer.ts` (pass `metadata[i]` by original index)
- Test: `test/semantic/sql-evidence.test.ts` (extend)

**Interfaces:**
- Consumes: `ProfileMetadata` (`src/types/batch.ts` — fields `sqlCallCount: number`, `sqlCallDuration: number`, `activityDuration: number`, `alExecutionDuration: number`).
- Produces:

```typescript
// output/types.ts
export interface SqlActivityCorroboration {
	measuredSqlCount: number;
	measuredSqlDurationMs: number;
	sampledAttributedCostUs: number;
	activityDurationMs?: number;
	alExecutionDurationMs?: number;
}
// on AnalysisResult: sqlActivity?: SqlActivityCorroboration;

// semantic/sql-evidence.ts
export function buildSqlActivityCorroboration(
	sqlByRoutine: Map<string, SqlStatementEvidence[]>,
	metadata: ProfileMetadata,
): SqlActivityCorroboration;
```

- [ ] **Step 1: Add the type**

In `src/output/types.ts`, add above `AnalysisResult`:

```typescript
/**
 * Activity-level SQL corroboration (batch path only). measuredSqlCount /
 * measuredSqlDurationMs come from BC's own Performance Profiles manifest and
 * are MEASURED; sampledAttributedCostUs is the profile's sampled SQL total.
 * Shown side-by-side, NEVER subtracted: the manifest's duration fields
 * overlap (alExecutionDuration includes HTTP wait — proven on real data),
 * so no unaccounted-time arithmetic exists here by design.
 */
export interface SqlActivityCorroboration {
	measuredSqlCount: number;
	measuredSqlDurationMs: number;
	sampledAttributedCostUs: number;
	activityDurationMs?: number;
	alExecutionDurationMs?: number;
}
```

and inside `AnalysisResult` after `tableBreakdown?: TableBreakdown[];`:

```typescript
	/** Present ONLY when a batch manifest entry was supplied (batch path). */
	sqlActivity?: SqlActivityCorroboration;
```

- [ ] **Step 2: Write the failing test**

Append to `test/semantic/sql-evidence.test.ts`:

```typescript
import { buildSqlActivityCorroboration } from "../../src/semantic/sql-evidence.js";
import type { ProfileMetadata } from "../../src/types/batch.js";

describe("buildSqlActivityCorroboration", () => {
	const meta: ProfileMetadata = {
		activityId: "x",
		activityType: "WebClient",
		activityDescription: "test",
		startTime: "2026-03-05T13:21:41.453Z",
		activityDuration: 11945,
		alExecutionDuration: 7023,
		sqlCallDuration: 382,
		sqlCallCount: 1381,
		httpCallDuration: 0,
		httpCallCount: 0,
		userName: "T",
		clientSessionId: "{id}",
		scheduleDescription: "s",
	};

	test("measured beside sampled; each SQL shape summed once; NO residual field", () => {
		const map = new Map([
			["A_CodeUnit_1", [{ sampledCostUs: 300 } as never]],
			["B_CodeUnit_2", [{ sampledCostUs: 200 } as never]],
			["", [{ sampledCostUs: 50 } as never]], // unattributed still counts in the total
		]);
		const c = buildSqlActivityCorroboration(map as never, meta);
		expect(c.measuredSqlCount).toBe(1381);
		expect(c.measuredSqlDurationMs).toBe(382);
		expect(c.sampledAttributedCostUs).toBe(550);
		expect(c.activityDurationMs).toBe(11945);
		expect("unaccountedMs" in c).toBe(false); // fields overlap — no subtraction, ever
	});
});
```

(If `ProfileMetadata` marks some of these fields optional, drop the missing ones from the literal — match `src/types/batch.ts` exactly.)

- [ ] **Step 3: Run to verify failure, then implement**

Run: `bun test test/semantic/sql-evidence.test.ts` → FAIL (not exported).

Append to `src/semantic/sql-evidence.ts`:

```typescript
import type { ProfileMetadata } from "../types/batch.js"; // merge into imports
import type { SqlActivityCorroboration } from "../output/types.js"; // merge into imports

/**
 * Activity-level corroboration: the manifest's MEASURED SQL count/duration
 * beside the profile's SAMPLED SQL total. No subtraction across manifest
 * duration fields — they overlap (alExecutionDuration includes HTTP wait).
 */
export function buildSqlActivityCorroboration(
	sqlByRoutine: Map<string, SqlStatementEvidence[]>,
	metadata: ProfileMetadata,
): SqlActivityCorroboration {
	let sampled = 0;
	for (const items of sqlByRoutine.values()) {
		for (const item of items) sampled += item.sampledCostUs;
	}
	return {
		measuredSqlCount: metadata.sqlCallCount,
		measuredSqlDurationMs: metadata.sqlCallDuration,
		sampledAttributedCostUs: sampled,
		activityDurationMs: metadata.activityDuration,
		alExecutionDurationMs: metadata.alExecutionDuration,
	};
}
```

(Each SQL *node* is folded into exactly one shape in exactly one routine bucket by `buildSqlByRoutine`, so summing all buckets counts every node once — the double-count guard is structural.)

- [ ] **Step 4: Thread metadata**

In `src/core/analyzer.ts` add to `AnalyzeOptions` (after `onAllMethods`):

```typescript
	/**
	 * This profile's batch-manifest entry (BC Performance Profiles sidecar).
	 * Enables the activity-level SQL corroboration section. Batch-analyzer
	 * associates it by ORIGINAL profile index before concurrency starts.
	 */
	metadata?: ProfileMetadata;
```

with `import type { ProfileMetadata } from "../types/batch.js";`.

In `src/core/batch-analyzer.ts`, change `runWithConcurrency`'s worker signature to pass the index, and use it:

```typescript
async function runWithConcurrency<T, R>(
	items: T[],
	fn: (item: T, index: number) => Promise<R>,
	limit: number,
): Promise<PromiseSettledResult<R>[]> {
	// ... body unchanged except:
	results[i] = { status: "fulfilled", value: await fn(items[i], i) };
```

and at the call site (`batch-analyzer.ts:53-63`):

```typescript
	const settled = await runWithConcurrency(
		profilePaths,
		async (path, i) =>
			analyzeProfile(path, {
				top,
				includePatterns: true,
				appFilter: options?.appFilter?.map((s) => s.trim()),
				sourceIndex,
				metadata: options?.metadata?.[i], // original-index association
			}),
		concurrency,
	);
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test test/semantic/sql-evidence.test.ts test/core/batch-analyzer.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/output/types.ts src/semantic/sql-evidence.ts src/core/analyzer.ts src/core/batch-analyzer.ts test/semantic/sql-evidence.test.ts
git commit -m "feat(semantic): activity-level measured-SQL corroboration + manifest threading"
```

---

### Task 6: Pipeline hook in `analyzeProfile` + identity pin

**Files:**
- Modify: `src/core/analyzer.ts` (~line 244, after source patterns, before `annotateEstimatedSavings`/`sortPatterns` usage)
- Test: `test/core/analyzer.test.ts` (extend)

**Interfaces:**
- Consumes: `buildSqlByRoutine`, `attachSqlEvidence`, `buildSqlActivityCorroboration` (Tasks 3-5).
- Produces: `analyzeProfile` results carry `patterns[].sqlEvidence`/`sqlRank` and `sqlActivity` when applicable. No other observable change.

- [ ] **Step 1: Write the failing tests**

Append to `test/core/analyzer.test.ts`:

```typescript
import { readdirSync } from "node:fs";
import metadata from "../fixtures/batch-recorded/manifest.json";

describe("SQL evidence enrichment (v1)", () => {
	const PROFILE = "test/fixtures/batch-recorded/profile-1.alcpuprofile";

	test("sampling profile with SQL gets evidence on at least one finding", async () => {
		const result = await analyzeProfile(PROFILE);
		const withEvidence = result.patterns.filter((p) => p.sqlEvidence);
		for (const p of withEvidence) {
			expect(p.sqlEvidence!.provenance).toBe("sampled-estimate");
			expect(p.sqlRank).toBe(p.sqlEvidence!.totalSampledCostUs);
			expect(p.sqlEvidence!.statements.length).toBeLessThanOrEqual(5);
		}
		// profile-1 has 181 SQL nodes and known high-hit-count/repeated-siblings findings:
		expect(withEvidence.length).toBeGreaterThan(0);
	});

	test("identity pin: fingerprints identical with evidence stripped and re-minted", async () => {
		const result = await analyzeProfile(PROFILE);
		const stripped = structuredClone(result.patterns);
		for (const p of stripped) {
			delete (p as Record<string, unknown>).sqlEvidence;
			delete (p as Record<string, unknown>).sqlRank;
			delete (p as Record<string, unknown>).fingerprint;
		}
		const { fingerprintPatterns, buildMethodLabelMap } = await import(
			"../../src/lifecycle/wire.js"
		);
		const { aggregateByMethod } = await import("../../src/core/aggregator.js");
		const { parseProfile } = await import("../../src/core/parser.js");
		const { processProfile } = await import("../../src/core/processor.js");
		const methods = aggregateByMethod(processProfile(await parseProfile(PROFILE)));
		fingerprintPatterns(stripped, buildMethodLabelMap(methods));
		expect(stripped.map((p) => p.fingerprint)).toEqual(
			result.patterns.map((p) => p.fingerprint),
		);
	});

	test("metadata option attaches sqlActivity; absent without it", async () => {
		const withMeta = await analyzeProfile(PROFILE, { metadata: metadata[0] });
		expect(withMeta.sqlActivity).toBeDefined();
		expect(withMeta.sqlActivity!.measuredSqlCount).toBe(1381);
		expect(withMeta.sqlActivity!.sampledAttributedCostUs).toBeGreaterThan(0);
		expect("unaccountedMs" in withMeta.sqlActivity!).toBe(false);

		const without = await analyzeProfile(PROFILE);
		expect(without.sqlActivity).toBeUndefined();
	});

	test("ir-json profile: no SQL evidence anywhere (negative)", async () => {
		const result = await analyzeProfile("test/fixtures/irjson-minimal.ir.json");
		expect(result.patterns.every((p) => p.sqlEvidence === undefined)).toBe(true);
		expect(result.sqlActivity).toBeUndefined();
	});
});
```

(Adjust the `fingerprintPatterns` call signature to the actual one in `wire.ts` — check its exported signature when implementing; it may also take an attributions argument that should be omitted/undefined here, mirroring the analyzeProfile call site.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/core/analyzer.test.ts -t "SQL evidence"`
Expected: FAIL — no `sqlEvidence` on any pattern, `sqlActivity` undefined.

- [ ] **Step 3: Implement the hook**

In `src/core/analyzer.ts`, after the source-pattern merge block (line ~242) and BEFORE `annotateEstimatedSavings(patterns);`, insert:

```typescript
	// SQL evidence enrichment (v1): sampling profiles only — ir-json and
	// instrumentation captures carry no SQL nodes. Sets ONLY sqlEvidence and
	// sqlRank on findings (never impact/identity), plus the activity-level
	// corroboration when a batch-manifest entry was threaded in.
	let sqlActivity: SqlActivityCorroboration | undefined;
	if (processed.type === "sampling" && processed.sourceFormat !== "ir-json") {
		const sqlByRoutine = buildSqlByRoutine(processed);
		if (sqlByRoutine.size > 0) {
			attachSqlEvidence(patterns, sqlByRoutine);
			if (options?.metadata) {
				sqlActivity = buildSqlActivityCorroboration(sqlByRoutine, options.metadata);
			}
		}
	}
```

with imports:

```typescript
import {
	attachSqlEvidence,
	buildSqlActivityCorroboration,
	buildSqlByRoutine,
} from "../semantic/sql-evidence.js";
import type { SqlActivityCorroboration } from "../output/types.js";
```

Then find where the `AnalysisResult` object literal is assembled (search `tableBreakdown` in the return construction) and add:

```typescript
		sqlActivity,
```

- [ ] **Step 4: Run the full core suite**

Run: `bun test test/core/ && bunx tsc --noEmit`
Expected: PASS — including every pre-existing analyzer test (no finding appears/disappears; the enrichment only adds fields).

- [ ] **Step 5: Commit**

```bash
git add src/core/analyzer.ts test/core/analyzer.test.ts
git commit -m "feat(core): wire SQL evidence enrichment into analyzeProfile (sampling-only guard)"
```

---

### Task 7: Output sections + formatter parity

**Files:**
- Modify: `src/output/sections.ts` (add `"sqlActivity"`)
- Modify: `src/output/batch-sections.ts` (add `"sqlActivity"`)
- Modify: `src/cli/formatters/terminal.ts`, `json.ts`, `markdown.ts`, `html.ts` (section renderer + per-finding evidence in the patterns renderer)
- Modify: `src/cli/formatters/batch-terminal.ts`, `batch-markdown.ts`, `batch-html.ts` (batch section renderer)
- Test: `test/cli/formatters/terminal.test.ts`, `json.test.ts`, `markdown.test.ts`, `html.test.ts` (extend)

**Interfaces:**
- Consumes: `result.sqlActivity` and `result.patterns[].sqlEvidence` (Tasks 5-6); `BatchAnalysisResult.profiles[].sqlActivity` + `activityBreakdown[].metadata`.
- Produces: every formatter compiles against the widened `SectionRenderers` / `BatchSectionRenderers` and renders both surfaces.

- [ ] **Step 1: Widen the section types**

`src/output/sections.ts` — add `| "sqlActivity"` to `AnalysisSectionType` and insert `"sqlActivity"` in `SECTION_ORDER` right after `"tableBreakdown"`.

`src/output/batch-sections.ts` — add `| "sqlActivity"` to `BatchSectionType` and insert `"sqlActivity"` in `BATCH_SECTION_ORDER` right after `"activityBreakdown"`.

Run: `bunx tsc --noEmit` — expected: **compile errors in every formatter** (missing renderer). That IS the parity mechanism working; the rest of this task fixes them.

- [ ] **Step 2: Write failing formatter tests**

Follow the repo's formatter-test pattern (parse fixture → format → assert strings). Add to each of the four single-profile formatter test files a test along these lines (adapt the assertion form each file already uses):

```typescript
test("renders sqlActivity section when present", async () => {
	const result = await analyzeProfile("test/fixtures/batch-recorded/profile-1.alcpuprofile", {
		metadata: manifestEntry0, // import from ../fixtures/batch-recorded/manifest.json
	});
	const out = formatTerminal(result); // formatJson/formatMarkdown/formatHtml respectively
	expect(out).toContain("SQL Activity"); // json: expect parsed.sqlActivity.measuredSqlCount === 1381
	expect(out).toContain("1381"); // measured count
	expect(out).toContain("sampled"); // provenance marker
});

test("renders per-finding SQL evidence with sampled marker", async () => {
	const result = await analyzeProfile("test/fixtures/batch-recorded/profile-1.alcpuprofile");
	const p = result.patterns.find((p) => p.sqlEvidence);
	if (!p) return; // fixture-dependent guard; profile-1 is known to produce evidence
	const out = formatTerminal(result);
	expect(out).toContain("sampled"); // never rendered as measured/exact
});
```

Run to verify they fail (compile errors from Step 1 count as failing).

- [ ] **Step 3: Implement renderers**

Style note: match each formatter's existing helpers (`formatTime` from `core/analyzer.js`, chalk in terminal, table helpers in html). Substance requirements — identical across formatters:

**Section `sqlActivity`** (skip/empty when `result.sqlActivity` undefined):
- Title: `SQL Activity (measured vs sampled)`.
- Lines: `Measured SQL: <measuredSqlCount> calls, <measuredSqlDurationMs>ms (from BC activity manifest)`, `Sampled SQL cost in profile: <formatTime(sampledAttributedCostUs)> (sampled estimate)`, and when present `Activity: <activityDurationMs>ms · AL execution: <alExecutionDurationMs>ms (overlapping measures — not additive)`.

Terminal example:

```typescript
function renderSqlActivity(result: AnalysisResult): string {
	const a = result.sqlActivity;
	if (!a) return "";
	const lines: string[] = [chalk.bold("SQL Activity (measured vs sampled)")];
	lines.push(
		`  Measured SQL: ${a.measuredSqlCount} calls, ${a.measuredSqlDurationMs}ms (from BC activity manifest)`,
	);
	lines.push(
		`  Sampled SQL cost in profile: ${formatTime(a.sampledAttributedCostUs)} (sampled estimate)`,
	);
	if (a.activityDurationMs !== undefined && a.alExecutionDurationMs !== undefined) {
		lines.push(
			`  Activity: ${a.activityDurationMs}ms · AL execution: ${a.alExecutionDurationMs}ms (overlapping measures — not additive)`,
		);
	}
	return lines.join("\n");
}
```

Register in each formatter's `SectionRenderers` record (`sqlActivity: renderSqlActivity`). For `json.ts`, follow whatever that file's renderer convention is (its sections typically project fields into the output object; `sqlActivity` passes `result.sqlActivity` through). For `html.ts` and `markdown.ts`, mirror the terminal content in their markup idiom.

**Per-finding evidence** — in each formatter's existing `patterns` renderer, after the finding's evidence/suggestion output, when `p.sqlEvidence` present:

```
  SQL (sampled estimate): total <formatTime(totalSampledCostUs)> across <totalSampledHitCount> sampled hits
    <operation> <table ?? "(unparsed)"> — <formatTime(sampledCostUs)> · ×<sampledHitCount> sampled — <text truncated to 120 chars>
    (one line per statements[] entry, max 5)
```

**Batch renderers** — one table row per `activityBreakdown` entry that has a matching profile with `sqlActivity`: activity description (from metadata), measured SQL calls, measured ms, sampled cost. Empty string when no profile carries `sqlActivity`. (`BatchAnalysisResult.profiles[i]` aligns with `activityBreakdown[i]` — both are built from the same `results` array order in `aggregateResults`.)

- [ ] **Step 4: Run all formatter tests + full typecheck**

Run: `bun test test/cli/formatters/ && bunx tsc --noEmit`
Expected: PASS, zero compile errors — parity restored with the new section everywhere.

- [ ] **Step 5: Commit**

```bash
git add src/output/sections.ts src/output/batch-sections.ts src/cli/formatters/ test/cli/formatters/
git commit -m "feat(output): sqlActivity section + per-finding SQL evidence across all formatters"
```

---

### Task 8: Ranking surface (`--sort sql` + MCP `sort`) and final verification

**Files:**
- Modify: `src/cli/commands/analyze.ts` (new option + reorder before format)
- Modify: `src/mcp/server.ts` (optional `sort` param on `analyze_profile`)
- Test: `test/cli/commands/analyze.test.ts` or `test/e2e/cli.test.ts` (whichever holds analyze-command tests), `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `patterns[].sqlRank` (Task 4).
- Produces: presentation-level reorder only — analysis output stays canonical impact-sorted; the flag reorders `result.patterns` in place immediately before formatting.

- [ ] **Step 1: Write the failing test**

In the file that tests the analyze command (look at how existing option tests there invoke the command action), add:

```typescript
test("--sort sql orders findings by sqlRank descending (undefined ranks last)", async () => {
	// invoke analyze on profile-1 with { sort: "sql", format: "json" } via the
	// command's action (mirror the file's existing invocation helper), parse the
	// JSON output, then:
	const ranks = parsed.patterns.map((p) => p.sqlRank ?? -1);
	const sorted = [...ranks].sort((a, b) => b - a);
	expect(ranks).toEqual(sorted);
});
```

And in `test/mcp/tools.test.ts`, mirror it for `analyze_profile` with `{ sort: "sql" }`.

- [ ] **Step 2: Run to verify failure, then implement**

In `src/cli/commands/analyze.ts`:

```typescript
		.option("--sort <key>", "Finding order: impact (default) or sql (by sampled SQL cost)", "impact")
```

and in the action, after `analyzeProfile` returns and before the formatter call:

```typescript
	if (opts.sort === "sql") {
		result.patterns = [...result.patterns].sort(
			(a, b) => (b.sqlRank ?? -1) - (a.sqlRank ?? -1),
		);
	}
```

In `src/mcp/server.ts`, add to the `analyze_profile` tool input schema:

```typescript
		sort: z.enum(["impact", "sql"]).optional().describe(
			"Finding order: impact (default) or sql (by sampled SQL cost, sqlRank)",
		),
```

and apply the same reorder to the result before serialization when `sort === "sql"`.

- [ ] **Step 3: Full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: entire repo green.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/analyze.ts src/mcp/server.ts test/
git commit -m "feat(cli,mcp): --sort sql ranking surface over sqlRank"
```

---

## Self-review notes (already applied)

- **Spec coverage:** primitive (T3), per-finding evidence + rank (T4), activity corroboration + threading (T5), pipeline + guards + identity pin + ir-json negative (T6), formatter parity both surfaces (T7), ranking surface (T8), corrected table parser + shared helpers + `--deep` bug fix (T1-T2). Non-goals (refutation, confirmed tier, unaccountedMs, RT0005) have no tasks — by design.
- **Fixture note:** plan relies on the real `batch-recorded` fixtures rather than hand-built SQL-bearing profile JSON for integration tests, plus synthetic `ProcessedNode` trees for unit-level attribution cases — both are cheaper and more honest than crafting fake `.alcpuprofile` files.
- **Type consistency check:** `SqlStatementEvidence`/`SqlEvidence`/`SqlActivityCorroboration` field names match across T3/T4/T5/T6/T7. Routine key format `${functionName}_${objectType}_${objectId}` used identically in T3 (`buildSqlByRoutine`) and T4 (`routineKeyFromLabel`).
- **Known judgment calls for implementers:** exact placement of section title strings/colors follows each formatter's local idiom; the substance (labels "measured"/"sampled", the 1381 pin, no subtraction) is binding.
