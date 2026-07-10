# ir-json Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach al-perf to ingest `ir-json` (bc-mdc-converter's lossless per-invocation instrumentation IR) end to end — CLI `analyze`, library API, and `/api/ingest` — with exact self-times and exact invocation counts.

**Architecture:** ir-json is parsed by a new `src/core/irjson-parser.ts` that synthesizes one `RawProfileNode` per invocation (hitCount = 1, temporal tree from `temporalParentIx`) and returns the existing `ParsedProfile` shape plus an `exactSelfTimes` map, so the entire downstream pipeline (`processProfile`, aggregators, detectors, formatters, MCP) is reused unchanged. Format detection lives in `parseProfile` (payload sniffing, not file extension), so every entry point that takes a profile path works on both formats transparently. Two detectors gain exact-count logic/wording on ir-json profiles; `/api/ingest` gains gzip transfer decoding and a size budget.

**Tech Stack:** Bun runtime, TypeScript, bun:test, `Bun.gunzipSync`/`Bun.gzipSync` (built into Bun — no new dependencies).

## Global Constraints

- **Runtime/tests:** Bun only (`bun test`, `bunx tsc --noEmit`). No new npm dependencies.
- **Code style:** tabs for indentation; run `bunx biome check --write <changed files>` before every commit.
- **Format spec (authoritative):** `U:\Git\bc-mdc-converter\docs\superpowers\specs\2026-07-06-ir-json-format-design.md`. Pinned contract: integer `schemaVersion` = **1**; additive fields do NOT bump it; **consumers MUST ignore unknown keys**; nullable fields serialize as explicit `null`.
- **Line numbers:** ir-json wire lines/columns are **0-based raw wire values**; al-perf uses V8 display convention (1-based) everywhere downstream. The +1 shift happens exactly once, in `parseIrJson`.
- **Ticks:** ir-json times are 100 ns ticks (`ticksPerMs = 10000`); al-perf internal times are microseconds. Conversion: `µs = ticks / 10`, applied exactly once, in `parseIrJson`.
- **Trustworthy ends:** per spec §3.5, raw `endTicks` may be pathological on `isIncomplete` rows. Node end times use `clampedEndTicks ?? endTicks` and are only set when `inSweep === true`.
- **Payload budget (umbrella spec §1, measured ~537 bytes/invocation, 12.8x vs .alcpuprofile):** parser rejects documents over `config.irJson.maxInvocations` (500,000); ingest rejects decompressed payloads over `AL_PERF_MAX_PROFILE_BYTES` (default 134,217,728 = 128 MiB). gzip only — **no zstd, no NDJSON streaming** in this phase.
- **Formatter parity:** the `SectionRenderers<T>` mechanism must not break. **No new section types** — every new result field goes on `AnalysisResult.meta` (rendered automatically by the JSON formatter; other formatters ignore unknown meta fields).
- **Incomplete captures:** analyzed and flagged (`meta.incompleteInvocations`), never rejected. (Exclusion from lifecycle run-counting is phase 3, out of scope here.)
- **Out of scope:** lifecycle engine, fusion changes, capture orchestrator, zstd, NDJSON, batch-directory globbing of `.ir.json` files, per-invocation exception analysis (counts are carried; per-row exceptions are not surfaced yet).
- **Existing tests must keep passing after every task** (`bun test` green, `bunx tsc --noEmit` clean).
- **Commits:** conventional (feat/test/chore), one per task, each message ending with the trailer line:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`

**Fixture provenance (pre-verified while writing this plan):** `U:\Git\bc-mdc-converter\target\release\bc-mdc-converter.exe` exists and `--format ir-json` on `fixtures/tiny.mdc.zip` produces a 950,424-byte document with `schemaVersion: 1`, 1,639 invocations, 14 apps, 214 temporal roots, 0 incomplete, 0 exceptions, Σ`selfTicks` = 503,943, max tree depth 28, and method `IsNonInventoriableType` (Table 27) invoked exactly 102 times. Gzipped (`gzip -9`) it is 64,016 bytes. These are the golden numbers used in Tasks 1–3.

---

### Task 1: Fixtures, ir-json wire types, and the schemaVersion contract pin

**Files:**
- Create: `test/fixtures/irjson-minimal.ir.json` (hand-written, 6 invocations, exercises every nullable field)
- Create: `test/fixtures/tiny.ir.json.gz` (generated from bc-mdc-converter's real capture, 64 KB)
- Create: `src/types/irjson.ts`
- Test: `test/core/irjson-contract.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (first task).
- Produces:
  - `IRJSON_SCHEMA_VERSION: 1` (const, `src/types/irjson.ts`)
  - Types `IrJsonDocument`, `IrJsonCapture`, `IrJsonApp`, `IrJsonInvocation`, `IrJsonLineRef`, `IrJsonLineHit`, `IrJsonException`, `IrJsonGenerator` — exact field names per format spec §3.
  - Fixture files used by Tasks 2–5.

- [ ] **Step 1: Generate the real fixture from bc-mdc-converter**

Run (Git Bash):

```bash
mkdir -p /tmp/irjson-fixture
U:/Git/bc-mdc-converter/target/release/bc-mdc-converter.exe U:/Git/bc-mdc-converter/fixtures/tiny.mdc.zip /tmp/irjson-fixture/tiny.ir.json --format ir-json
gzip -9 /tmp/irjson-fixture/tiny.ir.json
cp /tmp/irjson-fixture/tiny.ir.json.gz U:/Git/al-perf/test/fixtures/tiny.ir.json.gz
ls -la U:/Git/al-perf/test/fixtures/tiny.ir.json.gz
```

Expected: file of ~64,016 bytes. (If the release binary is missing, build it first: `cd U:/Git/bc-mdc-converter && cargo build --release`.) `.gitignore` ignores `*.tgz` but not `*.gz` — plain `git add` works.

- [ ] **Step 2: Write the hand-crafted minimal fixture**

Create `test/fixtures/irjson-minimal.ir.json` with EXACTLY this content (designed values: Σ`selfTicks` = 40,000 → 4,000 µs total self time; a temporal tree of depth 2; one incomplete row with a pathological raw end + clamp; one not-in-sweep row with an exception; two apps; `ProcessLine` invoked exactly twice):

```json
{
	"schemaVersion": 1,
	"generator": { "name": "bc-mdc-converter", "version": "0.1.0" },
	"capture": {
		"platformVersion": "26.0.0.0",
		"t0Ticks": "63918782549184796",
		"startTicks": 0,
		"endTicks": 50000,
		"approxWallClockStart": "2026-07-05T10:00:00",
		"ticksPerMs": 10000,
		"invocationCount": 6,
		"incompleteCount": 1,
		"exceptionCount": 1
	},
	"apps": [
		{
			"id": "437dbf0e84ff417a965ded2bb9650972",
			"name": "Base Application",
			"publisher": "Microsoft",
			"version": "26.0.0.0"
		},
		{
			"id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"name": "My ISV App",
			"publisher": "Contoso",
			"version": "1.2.0.0"
		}
	],
	"invocations": [
		{
			"index": 0,
			"objectType": "CodeUnit",
			"objectId": 50100,
			"objectName": "Order Processor",
			"method": "OnRun",
			"appIx": 1,
			"startTicks": 0,
			"endTicks": 50000,
			"clampedEndTicks": null,
			"inSweep": true,
			"selfTicks": 5000,
			"temporalParentIx": null,
			"v8AggregationParentIx": null,
			"isBuiltin": false,
			"isIncomplete": false,
			"calledLine": {
				"objectType": "CodeUnit",
				"objectId": 50100,
				"line": 5,
				"column": 4,
				"toLine": 5,
				"toColumn": 20
			},
			"callerLine": null,
			"lines": [
				{ "line": 5, "column": 4, "toLine": 5, "toColumn": 20, "hits": 1 }
			],
			"exception": null
		},
		{
			"index": 1,
			"objectType": "CodeUnit",
			"objectId": 50100,
			"objectName": "Order Processor",
			"method": "ProcessLine",
			"appIx": 1,
			"startTicks": 1000,
			"endTicks": 20000,
			"clampedEndTicks": null,
			"inSweep": true,
			"selfTicks": 12000,
			"temporalParentIx": 0,
			"v8AggregationParentIx": 0,
			"isBuiltin": false,
			"isIncomplete": false,
			"calledLine": {
				"objectType": "CodeUnit",
				"objectId": 50100,
				"line": 12,
				"column": 4,
				"toLine": 12,
				"toColumn": 30
			},
			"callerLine": {
				"objectType": "CodeUnit",
				"objectId": 50100,
				"line": 7,
				"column": 8,
				"toLine": 7,
				"toColumn": 25
			},
			"lines": [
				{ "line": 12, "column": 4, "toLine": 12, "toColumn": 30, "hits": 1 }
			],
			"exception": null
		},
		{
			"index": 2,
			"objectType": "Table",
			"objectId": 27,
			"objectName": "Item",
			"method": "FindPrice",
			"appIx": 0,
			"startTicks": 2000,
			"endTicks": 8000,
			"clampedEndTicks": null,
			"inSweep": true,
			"selfTicks": 6000,
			"temporalParentIx": 1,
			"v8AggregationParentIx": 1,
			"isBuiltin": false,
			"isIncomplete": false,
			"calledLine": {
				"objectType": "Table",
				"objectId": 27,
				"line": 30,
				"column": 4,
				"toLine": 30,
				"toColumn": 18
			},
			"callerLine": {
				"objectType": "CodeUnit",
				"objectId": 50100,
				"line": 14,
				"column": 8,
				"toLine": 14,
				"toColumn": 22
			},
			"lines": [
				{ "line": 30, "column": 4, "toLine": 30, "toColumn": 18, "hits": 1 }
			],
			"exception": null
		},
		{
			"index": 3,
			"objectType": "CodeUnit",
			"objectId": 50100,
			"objectName": "Order Processor",
			"method": "ProcessLine",
			"appIx": 1,
			"startTicks": 21000,
			"endTicks": 40000,
			"clampedEndTicks": null,
			"inSweep": true,
			"selfTicks": 15000,
			"temporalParentIx": 0,
			"v8AggregationParentIx": 0,
			"isBuiltin": false,
			"isIncomplete": false,
			"calledLine": {
				"objectType": "CodeUnit",
				"objectId": 50100,
				"line": 12,
				"column": 4,
				"toLine": 12,
				"toColumn": 30
			},
			"callerLine": {
				"objectType": "CodeUnit",
				"objectId": 50100,
				"line": 8,
				"column": 8,
				"toLine": 8,
				"toColumn": 25
			},
			"lines": [
				{ "line": 12, "column": 4, "toLine": 12, "toColumn": 30, "hits": 1 }
			],
			"exception": null
		},
		{
			"index": 4,
			"objectType": "CodeUnit",
			"objectId": 80,
			"objectName": "Sales-Post",
			"method": "PostDocument",
			"appIx": 0,
			"startTicks": 41000,
			"endTicks": 99999999999,
			"clampedEndTicks": 50000,
			"inSweep": true,
			"selfTicks": 2000,
			"temporalParentIx": 0,
			"v8AggregationParentIx": 0,
			"isBuiltin": false,
			"isIncomplete": true,
			"calledLine": null,
			"callerLine": null,
			"lines": [],
			"exception": null
		},
		{
			"index": 5,
			"objectType": "CodeUnit",
			"objectId": 50100,
			"objectName": "Order Processor",
			"method": "OrphanMethod",
			"appIx": 1,
			"startTicks": null,
			"endTicks": null,
			"clampedEndTicks": null,
			"inSweep": false,
			"selfTicks": 0,
			"temporalParentIx": null,
			"v8AggregationParentIx": null,
			"isBuiltin": false,
			"isIncomplete": false,
			"calledLine": null,
			"callerLine": null,
			"lines": [],
			"exception": { "message": "Test error", "line": 42 }
		}
	]
}
```

- [ ] **Step 3: Write the failing contract-pin test**

This mirrors the `EXPECTED_*_SCHEMA_VERSION` pattern from `src/semantic/contracts.ts` (which pins the alsem envelopes): the pin lives next to the types, and a test asserts both the pin value and that committed real-producer output matches it — so a converter schema bump fails loudly here, not deep in a parse.

Create `test/core/irjson-contract.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { IRJSON_SCHEMA_VERSION } from "../../src/types/irjson.js";

const FIXTURES = "test/fixtures";

describe("ir-json schemaVersion contract pin", () => {
	test("the pin is schemaVersion 1", () => {
		expect(IRJSON_SCHEMA_VERSION).toBe(1);
	});

	test("committed real bc-mdc-converter output matches the pin", () => {
		const gz = readFileSync(`${FIXTURES}/tiny.ir.json.gz`);
		const doc = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz)));
		expect(doc.schemaVersion).toBe(IRJSON_SCHEMA_VERSION);
		expect(doc.generator.name).toBe("bc-mdc-converter");
		expect(doc.capture.ticksPerMs).toBe(10000);
		expect(doc.capture.invocationCount).toBe(1639);
		expect(doc.invocations).toHaveLength(1639);
	});

	test("committed minimal fixture matches the pin", () => {
		const doc = JSON.parse(
			readFileSync(`${FIXTURES}/irjson-minimal.ir.json`, "utf8"),
		);
		expect(doc.schemaVersion).toBe(IRJSON_SCHEMA_VERSION);
		expect(doc.capture.invocationCount).toBe(6);
		expect(doc.capture.incompleteCount).toBe(1);
		expect(doc.capture.exceptionCount).toBe(1);
	});
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test test/core/irjson-contract.test.ts`
Expected: FAIL — `Cannot find module '../../src/types/irjson.js'`

- [ ] **Step 5: Write the wire types**

Create `src/types/irjson.ts` (field names and nullability copied verbatim from format spec §3; unknown keys are deliberately NOT modeled — per §3.7 consumers ignore them, which structural typing gives us for free):

```typescript
// === ir-json wire format (bc-mdc-converter --format ir-json) ===
//
// Contract source: U:\Git\bc-mdc-converter\docs\superpowers\specs\
// 2026-07-06-ir-json-format-design.md (schemaVersion 1).
//
// Versioning policy (§3.7): integer schemaVersion; breaking changes bump it;
// additive optional fields do NOT. We therefore accept exactly
// IRJSON_SCHEMA_VERSION and ignore unknown keys.
//
// Units: all tick values are 100 ns ticks rebased to capture.t0Ticks
// (ticksPerMs = 10000). Line/column numbers are RAW WIRE VALUES (0-based) —
// the parser applies the +1 display shift, not these types.

/** The ir-json schemaVersion this consumer is pinned to. */
export const IRJSON_SCHEMA_VERSION = 1;

export interface IrJsonGenerator {
	name: string;
	version: string;
}

export interface IrJsonCapture {
	platformVersion: string;
	/** Absolute rebase anchor as a string (exceeds Number.MAX_SAFE_INTEGER). */
	t0Ticks: string;
	startTicks: number;
	endTicks: number;
	approxWallClockStart: string | null;
	ticksPerMs: number;
	invocationCount: number;
	incompleteCount: number;
	exceptionCount: number;
}

export interface IrJsonApp {
	/** May be "" when the declaring app carries no id (dedup fell back to name). */
	id: string;
	name: string;
	publisher: string;
	version: string;
}

export interface IrJsonLineRef {
	objectType: string;
	objectId: number;
	line: number;
	column: number;
	toLine: number;
	toColumn: number;
}

export interface IrJsonLineHit {
	line: number;
	column: number;
	toLine: number;
	toColumn: number;
	hits: number;
}

export interface IrJsonException {
	message: string;
	line: number;
}

export interface IrJsonInvocation {
	index: number;
	objectType: string | null;
	objectId: number | null;
	objectName: string | null;
	method: string | null;
	appIx: number | null;
	startTicks: number | null;
	/** RAW unclamped span end — may be pathological on isIncomplete rows (§3.5). */
	endTicks: number | null;
	/** Post-clamp end, non-null ONLY when the clamp changed the raw end. */
	clampedEndTicks: number | null;
	inSweep: boolean;
	/** Exact self time; 0 when inSweep === false; always >= 0. */
	selfTicks: number;
	/** TRUE temporal parent (this is the call tree); always < index when non-null. */
	temporalParentIx: number | null;
	/** Phase-2 aggregation edge — NOT the call tree; carried for losslessness only. */
	v8AggregationParentIx: number | null;
	isBuiltin: boolean;
	isIncomplete: boolean;
	calledLine: IrJsonLineRef | null;
	callerLine: IrJsonLineRef | null;
	lines: IrJsonLineHit[];
	exception: IrJsonException | null;
}

export interface IrJsonDocument {
	schemaVersion: number;
	generator: IrJsonGenerator;
	capture: IrJsonCapture;
	apps: IrJsonApp[];
	invocations: IrJsonInvocation[];
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/core/irjson-contract.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Type-check, lint, commit**

```bash
bunx tsc --noEmit
bunx biome check --write src/types/irjson.ts test/core/irjson-contract.test.ts
git add src/types/irjson.ts test/core/irjson-contract.test.ts test/fixtures/irjson-minimal.ir.json test/fixtures/tiny.ir.json.gz
git commit -m "feat(irjson): ir-json wire types, schemaVersion contract pin, committed fixtures

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 2: irjson-parser — parse + validate ir-json into a ParsedProfile

**Files:**
- Create: `src/core/irjson-parser.ts`
- Modify: `src/types/profile.ts` (extend `ParsedProfile`; add `ProfileSourceFormat`)
- Modify: `src/core/parser.ts` (`parseProfileFromRaw` stamps `sourceFormat: "alcpuprofile"`)
- Modify: `src/config.ts` (add `irJson.maxInvocations`)
- Test: `test/core/irjson-parser.test.ts`

**Interfaces:**
- Consumes: `IRJSON_SCHEMA_VERSION`, `IrJsonDocument`, `IrJsonInvocation` from Task 1; existing `ParsedProfile`, `RawProfileNode` from `src/types/profile.ts`.
- Produces (used by Tasks 3–6):
  - `isIrJsonDocument(raw: unknown): raw is IrJsonDocument` — payload sniffer.
  - `parseIrJson(doc: IrJsonDocument, options?: { maxInvocations?: number }): ParsedProfile` — throws `Error` on schemaVersion mismatch, index mismatch, invalid `temporalParentIx`, out-of-range `appIx`, or budget breach.
  - `ParsedProfile` gains: `sourceFormat?: ProfileSourceFormat` (`"alcpuprofile" | "ir-json"`), `exactSelfTimes?: Map<number, number>` (node id → µs), `irCapture?: { invocationCount: number; incompleteCount: number; exceptionCount: number }`.
  - Node id convention: **id = invocation index + 1** (1-based, matching V8 profile ids; avoids a falsy id 0).
  - `config.irJson.maxInvocations === 500_000`.

- [ ] **Step 1: Write the failing tests**

Create `test/core/irjson-parser.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
	isIrJsonDocument,
	parseIrJson,
} from "../../src/core/irjson-parser.js";
import type { IrJsonDocument } from "../../src/types/irjson.js";

const FIXTURES = "test/fixtures";

function loadMinimal(): IrJsonDocument {
	return JSON.parse(
		readFileSync(`${FIXTURES}/irjson-minimal.ir.json`, "utf8"),
	) as IrJsonDocument;
}

function loadReal(): IrJsonDocument {
	const gz = readFileSync(`${FIXTURES}/tiny.ir.json.gz`);
	return JSON.parse(
		new TextDecoder().decode(Bun.gunzipSync(gz)),
	) as IrJsonDocument;
}

describe("isIrJsonDocument", () => {
	test("recognizes an ir-json document", () => {
		expect(isIrJsonDocument(loadMinimal())).toBe(true);
	});

	test("rejects an .alcpuprofile raw object (has nodes, no invocations)", () => {
		const raw = JSON.parse(
			readFileSync(`${FIXTURES}/sampling-minimal.alcpuprofile`, "utf8"),
		);
		expect(isIrJsonDocument(raw)).toBe(false);
	});

	test("rejects null, arrays, and junk", () => {
		expect(isIrJsonDocument(null)).toBe(false);
		expect(isIrJsonDocument([])).toBe(false);
		expect(isIrJsonDocument({ schemaVersion: 1 })).toBe(false);
	});
});

describe("parseIrJson — minimal fixture golden", () => {
	const parsed = parseIrJson(loadMinimal());

	test("profile-level fields", () => {
		expect(parsed.type).toBe("instrumentation");
		expect(parsed.sourceFormat).toBe("ir-json");
		expect(parsed.nodes).toHaveLength(6);
		// ticks/10 -> µs: capture 0..50000 ticks = 0..5000 µs
		expect(parsed.startTime).toBe(0);
		expect(parsed.endTime).toBe(5000);
		expect(parsed.totalDuration).toBe(5000);
		expect(parsed.samplingInterval).toBeUndefined();
		expect(parsed.irCapture).toEqual({
			invocationCount: 6,
			incompleteCount: 1,
			exceptionCount: 1,
		});
	});

	test("node ids are index+1 and the temporal tree is wired", () => {
		// index 0 (OnRun) -> id 1; children are indices 1,3,4 -> ids 2,4,5
		expect(parsed.nodeMap.get(1)?.children).toEqual([2, 4, 5]);
		expect(parsed.nodeMap.get(2)?.children).toEqual([3]);
		const rootIds = parsed.rootNodes.map((n) => n.id).sort();
		expect(rootIds).toEqual([1, 6]);
	});

	test("exact self times in µs (selfTicks / 10)", () => {
		expect(parsed.exactSelfTimes?.get(1)).toBe(500);
		expect(parsed.exactSelfTimes?.get(2)).toBe(1200);
		expect(parsed.exactSelfTimes?.get(3)).toBe(600);
		expect(parsed.exactSelfTimes?.get(4)).toBe(1500);
		expect(parsed.exactSelfTimes?.get(5)).toBe(200);
		expect(parsed.exactSelfTimes?.get(6)).toBe(0);
	});

	test("hitCount is 1 per node (one node per invocation = exact counts)", () => {
		for (const node of parsed.nodes) {
			expect(node.hitCount).toBe(1);
		}
	});

	test("wire lines get the +1 display shift", () => {
		// calledLine.line 5 (wire, 0-based) -> lineNumber 6 (display)
		expect(parsed.nodeMap.get(1)?.callFrame.lineNumber).toBe(6);
		expect(parsed.nodeMap.get(1)?.callFrame.columnNumber).toBe(5);
		// null calledLine -> 0
		expect(parsed.nodeMap.get(6)?.callFrame.lineNumber).toBe(0);
	});

	test("declaringApplication mapped from apps[appIx]", () => {
		const onRun = parsed.nodeMap.get(1);
		expect(onRun?.declaringApplication?.appName).toBe("My ISV App");
		expect(onRun?.declaringApplication?.appPublisher).toBe("Contoso");
		expect(onRun?.declaringApplication?.appVersion).toBe("1.2.0.0");
		expect(onRun?.declaringApplication?.appId).toBe(
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		);
		expect(parsed.nodeMap.get(3)?.declaringApplication?.appName).toBe(
			"Base Application",
		);
	});

	test("applicationDefinition mapped from invocation object fields", () => {
		const findPrice = parsed.nodeMap.get(3);
		expect(findPrice?.applicationDefinition.objectType).toBe("Table");
		expect(findPrice?.applicationDefinition.objectId).toBe(27);
		expect(findPrice?.applicationDefinition.objectName).toBe("Item");
		expect(findPrice?.callFrame.functionName).toBe("FindPrice");
	});

	test("incomplete row: isIncompleteMeasurement set, clamped end used", () => {
		const post = parsed.nodeMap.get(5);
		expect(post?.isIncompleteMeasurement).toBe(true);
		expect(post?.startTime).toBe(4100); // 41000 ticks
		// clampedEndTicks 50000 wins over pathological raw endTicks 99999999999
		expect(post?.endTime).toBe(5000);
	});

	test("not-in-sweep row: no span times, selfTime 0, is a root", () => {
		const orphan = parsed.nodeMap.get(6);
		expect(orphan?.startTime).toBeUndefined();
		expect(orphan?.endTime).toBeUndefined();
		expect(parsed.exactSelfTimes?.get(6)).toBe(0);
	});
});

describe("parseIrJson — real converter output golden", () => {
	test("parses the committed real capture", () => {
		const parsed = parseIrJson(loadReal());
		expect(parsed.type).toBe("instrumentation");
		expect(parsed.nodes).toHaveLength(1639);
		expect(parsed.rootNodes).toHaveLength(214);
		expect(parsed.irCapture?.incompleteCount).toBe(0);
	});
});

describe("parseIrJson — validation errors", () => {
	test("rejects a foreign schemaVersion", () => {
		const doc = loadMinimal();
		doc.schemaVersion = 2;
		expect(() => parseIrJson(doc)).toThrow(/schemaVersion 2/);
	});

	test("rejects index/position mismatch", () => {
		const doc = loadMinimal();
		doc.invocations[0].index = 5;
		expect(() => parseIrJson(doc)).toThrow(/index/);
	});

	test("rejects temporalParentIx >= index (contract: always < index)", () => {
		const doc = loadMinimal();
		doc.invocations[1].temporalParentIx = 3;
		expect(() => parseIrJson(doc)).toThrow(/temporalParentIx/);
	});

	test("rejects out-of-range appIx", () => {
		const doc = loadMinimal();
		doc.invocations[0].appIx = 99;
		expect(() => parseIrJson(doc)).toThrow(/appIx/);
	});

	test("enforces the invocation budget", () => {
		const doc = loadMinimal();
		expect(() => parseIrJson(doc, { maxInvocations: 3 })).toThrow(
			/invocation budget/,
		);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/core/irjson-parser.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/irjson-parser.js'`

- [ ] **Step 3: Extend ParsedProfile and config**

In `src/types/profile.ts`, add above `ParsedProfile`:

```typescript
export type ProfileSourceFormat = "alcpuprofile" | "ir-json";
```

and add these fields to the `ParsedProfile` interface (after `samplingInterval`):

```typescript
	/** Wire format this profile was parsed from. Absent = "alcpuprofile" (legacy callers). */
	sourceFormat?: ProfileSourceFormat;
	/**
	 * Exact per-node self time in µs, keyed by node id (ir-json only).
	 * When present it overrides the positionTicks / sample-count computation.
	 */
	exactSelfTimes?: Map<number, number>;
	/** ir-json capture-level counters (ir-json only). */
	irCapture?: {
		invocationCount: number;
		incompleteCount: number;
		exceptionCount: number;
	};
```

In `src/core/parser.ts`, add `sourceFormat: "alcpuprofile",` to the object returned by `parseProfileFromRaw` (directly under `type,`).

In `src/config.ts`, add to the `config` object (after `snippetLimit`):

```typescript
	irJson: {
		/** Reject ir-json documents with more invocations than this (payload budget). */
		maxInvocations: 500_000,
	},
```

- [ ] **Step 4: Write the parser**

Create `src/core/irjson-parser.ts`:

```typescript
import { config } from "../config.js";
import {
	IRJSON_SCHEMA_VERSION,
	type IrJsonDocument,
} from "../types/irjson.js";
import type { ParsedProfile, RawProfileNode } from "../types/profile.js";

/** ir-json ticks are 100 ns; al-perf internal times are µs. */
const TICKS_PER_MICROSECOND = 10;

/**
 * Payload sniffer: an ir-json document has a numeric top-level schemaVersion,
 * a capture object, and an invocations array — and no V8 `nodes` array.
 */
export function isIrJsonDocument(raw: unknown): raw is IrJsonDocument {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return false;
	}
	const doc = raw as Record<string, unknown>;
	return (
		typeof doc.schemaVersion === "number" &&
		Array.isArray(doc.invocations) &&
		typeof doc.capture === "object" &&
		doc.capture !== null &&
		!Array.isArray(doc.nodes)
	);
}

export interface ParseIrJsonOptions {
	/** Override the invocation budget (defaults to config.irJson.maxInvocations). */
	maxInvocations?: number;
}

/**
 * Parse an ir-json document into a ParsedProfile by synthesizing one
 * RawProfileNode per invocation:
 *
 * - node id = invocation index + 1 (1-based, like V8 profile node ids)
 * - hitCount = 1 per node, so aggregateByMethod sums to EXACT invocation counts
 * - children wired from temporalParentIx (the TRUE temporal call tree)
 * - exact self times (selfTicks / 10 µs) returned via exactSelfTimes —
 *   processProfile prefers them over any statistical computation
 * - wire lines/columns are 0-based; the +1 display shift happens HERE and
 *   only here (downstream code always sees V8 display lines)
 * - node span times only when inSweep, using clampedEndTicks ?? endTicks
 *   (raw endTicks is untrustworthy on isIncomplete rows — spec §3.5)
 *
 * Deliberately dropped in this phase: v8AggregationParentIx (not the call
 * tree), per-line hits (no per-line time exists to feed lineHotspots), and
 * per-invocation exceptions (capture-level count is carried in irCapture).
 */
export function parseIrJson(
	doc: IrJsonDocument,
	options?: ParseIrJsonOptions,
): ParsedProfile {
	if (doc.schemaVersion !== IRJSON_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported ir-json schemaVersion ${doc.schemaVersion} (this build expects ${IRJSON_SCHEMA_VERSION})`,
		);
	}
	const maxInvocations =
		options?.maxInvocations ?? config.irJson.maxInvocations;
	if (doc.invocations.length > maxInvocations) {
		throw new Error(
			`ir-json exceeds invocation budget: ${doc.invocations.length} invocations > ${maxInvocations}`,
		);
	}

	const nodes: RawProfileNode[] = [];
	const exactSelfTimes = new Map<number, number>();

	for (let i = 0; i < doc.invocations.length; i++) {
		const inv = doc.invocations[i];
		if (inv.index !== i) {
			throw new Error(
				`ir-json invocation at position ${i} carries index ${inv.index}`,
			);
		}
		if (
			inv.temporalParentIx !== null &&
			(inv.temporalParentIx < 0 || inv.temporalParentIx >= i)
		) {
			throw new Error(
				`ir-json invocation ${i} has invalid temporalParentIx ${inv.temporalParentIx} (must be < index)`,
			);
		}
		const app = inv.appIx !== null ? doc.apps[inv.appIx] : undefined;
		if (inv.appIx !== null && !app) {
			throw new Error(`ir-json invocation ${i} has out-of-range appIx ${inv.appIx}`);
		}

		const id = i + 1;
		const node: RawProfileNode = {
			id,
			callFrame: {
				functionName: inv.method ?? "(unknown)",
				scriptId: "",
				url: "",
				lineNumber: inv.calledLine ? inv.calledLine.line + 1 : 0,
				columnNumber: inv.calledLine ? inv.calledLine.column + 1 : 0,
			},
			hitCount: 1,
			children: [],
			applicationDefinition: {
				objectType: inv.objectType ?? "",
				objectName: inv.objectName ?? "",
				objectId: inv.objectId ?? 0,
			},
			declaringApplication: app
				? {
						appId: app.id || undefined,
						appName: app.name,
						appPublisher: app.publisher,
						appVersion: app.version,
					}
				: undefined,
			frameIdentifier: 0,
			isIncompleteMeasurement: inv.isIncomplete,
			isBuiltinCodeUnitCall: inv.isBuiltin,
		};

		if (inv.inSweep && inv.startTicks !== null) {
			node.startTime = inv.startTicks / TICKS_PER_MICROSECOND;
			const effectiveEnd = inv.clampedEndTicks ?? inv.endTicks;
			if (effectiveEnd !== null) {
				node.endTime = effectiveEnd / TICKS_PER_MICROSECOND;
			}
		}

		if (inv.temporalParentIx !== null) {
			// Parent already exists: temporalParentIx < index is validated above.
			nodes[inv.temporalParentIx].children.push(id);
		}

		exactSelfTimes.set(id, inv.selfTicks / TICKS_PER_MICROSECOND);
		nodes.push(node);
	}

	const nodeMap = new Map<number, RawProfileNode>();
	for (const node of nodes) {
		nodeMap.set(node.id, node);
	}
	const rootNodes = nodes.filter(
		(_, i) => doc.invocations[i].temporalParentIx === null,
	);

	const startTime = doc.capture.startTicks / TICKS_PER_MICROSECOND;
	const endTime = doc.capture.endTicks / TICKS_PER_MICROSECOND;

	return {
		type: "instrumentation",
		sourceFormat: "ir-json",
		nodes,
		nodeMap,
		rootNodes,
		startTime,
		endTime,
		totalDuration: endTime - startTime,
		exactSelfTimes,
		irCapture: {
			invocationCount: doc.capture.invocationCount,
			incompleteCount: doc.capture.incompleteCount,
			exceptionCount: doc.capture.exceptionCount,
		},
	};
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/core/irjson-parser.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Full suite, type-check, lint, commit**

```bash
bun test
bunx tsc --noEmit
bunx biome check --write src/core/irjson-parser.ts src/types/profile.ts src/core/parser.ts src/config.ts test/core/irjson-parser.test.ts
git add src/core/irjson-parser.ts src/types/profile.ts src/core/parser.ts src/config.ts test/core/irjson-parser.test.ts
git commit -m "feat(irjson): parser — ir-json to ParsedProfile with exact self-times and counts

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 3: Transparent format detection + exact self-times through the pipeline + capture meta

**Files:**
- Modify: `src/core/parser.ts` (`parseProfile` sniffs the payload)
- Modify: `src/core/processor.ts` (`calculateSelfTime` prefers `exactSelfTimes`; pass through `sourceFormat`/`irCapture`)
- Modify: `src/types/processed.ts` (`ProcessedProfile` gains `sourceFormat`, `irCapture`)
- Modify: `src/output/types.ts` (`AnalysisResult.meta` gains `captureKind`, `sourceFormat`, `incompleteInvocations`)
- Modify: `src/core/analyzer.ts` (populate the three new meta fields)
- Test: `test/core/irjson-analyze.test.ts`

**Interfaces:**
- Consumes: `isIrJsonDocument`, `parseIrJson` from Task 2.
- Produces (used by Tasks 4–5):
  - `parseProfile(filePath)` returns an ir-json-derived `ParsedProfile` when the file content is ir-json — **every** existing caller (`analyzeProfile`, `compareProfiles`, drilldown, MCP tools, `/api/ingest`) gains ir-json support with no call-site changes.
  - `ProcessedProfile.sourceFormat?: ProfileSourceFormat` and `ProcessedProfile.irCapture?: { invocationCount: number; incompleteCount: number; exceptionCount: number }` — Task 4's detectors branch on `sourceFormat === "ir-json"`.
  - `AnalysisResult.meta.captureKind?: "sampling" | "instrumentation"` (the baseline/lifecycle key per umbrella spec — mirrors `profileType` today), `meta.sourceFormat?: "alcpuprofile" | "ir-json"`, `meta.incompleteInvocations?: number` (ir-json only; the isIncomplete flag carried into meta — nonzero marks an incomplete capture).
  - No formatter changes: new fields live on `meta`, the JSON formatter serializes them automatically, and no new section type is introduced (`SectionRenderers<T>` untouched).

- [ ] **Step 1: Write the failing tests**

Create `test/core/irjson-analyze.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { aggregateByMethod } from "../../src/core/aggregator.js";
import { analyzeProfile } from "../../src/core/analyzer.js";
import { parseIrJson } from "../../src/core/irjson-parser.js";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import type { IrJsonDocument } from "../../src/types/irjson.js";

const FIXTURES = "test/fixtures";
const MINIMAL = `${FIXTURES}/irjson-minimal.ir.json`;

describe("parseProfile format detection", () => {
	test("an .ir.json payload is detected and parsed as ir-json", async () => {
		const parsed = await parseProfile(MINIMAL);
		expect(parsed.type).toBe("instrumentation");
		expect(parsed.sourceFormat).toBe("ir-json");
		expect(parsed.nodes).toHaveLength(6);
	});

	test(".alcpuprofile payloads still parse as before", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(parsed.type).toBe("sampling");
		expect(parsed.sourceFormat).toBe("alcpuprofile");
	});
});

describe("processProfile on ir-json", () => {
	test("uses exact self times, not statistical inference", async () => {
		const processed = processProfile(await parseProfile(MINIMAL));
		expect(processed.sourceFormat).toBe("ir-json");
		expect(processed.nodeMap.get(2)?.selfTime).toBe(1200);
		expect(processed.nodeMap.get(6)?.selfTime).toBe(0);
		// Σ selfTicks 40000 / 10 = 4000 µs; ir-json has no IdleTime nodes
		expect(processed.totalSelfTime).toBe(4000);
		expect(processed.activeSelfTime).toBe(4000);
		expect(processed.idleSelfTime).toBe(0);
		expect(processed.maxDepth).toBe(2);
		// OnRun total = 500 + (1200 + 600) + 1500 + 200 = 4000
		expect(processed.nodeMap.get(1)?.totalTime).toBe(4000);
		expect(processed.irCapture?.incompleteCount).toBe(1);
	});

	test("aggregation yields EXACT invocation counts", async () => {
		const processed = processProfile(await parseProfile(MINIMAL));
		const methods = aggregateByMethod(processed);
		const processLine = methods.find(
			(m) => m.functionName === "ProcessLine" && m.objectId === 50100,
		);
		expect(processLine?.hitCount).toBe(2);
		expect(processLine?.selfTime).toBe(2700);
	});

	test("real capture golden: exact totals and counts", () => {
		const gz = readFileSync(`${FIXTURES}/tiny.ir.json.gz`);
		const doc = JSON.parse(
			new TextDecoder().decode(Bun.gunzipSync(gz)),
		) as IrJsonDocument;
		const processed = processProfile(parseIrJson(doc));
		expect(processed.nodeCount).toBe(1639);
		expect(processed.roots).toHaveLength(214);
		expect(processed.maxDepth).toBe(28);
		// Σ selfTicks = 503943 ticks -> 50394.3 µs
		expect(processed.totalSelfTime).toBeCloseTo(50394.3, 3);
		const methods = aggregateByMethod(processed);
		const m = methods.find(
			(x) => x.functionName === "IsNonInventoriableType" && x.objectId === 27,
		);
		expect(m?.hitCount).toBe(102);
	});
});

describe("analyzeProfile on ir-json", () => {
	test("end to end with capture meta", async () => {
		const result = await analyzeProfile(MINIMAL);
		expect(result.meta.profileType).toBe("instrumentation");
		expect(result.meta.captureKind).toBe("instrumentation");
		expect(result.meta.sourceFormat).toBe("ir-json");
		expect(result.meta.incompleteInvocations).toBe(1);
		expect(result.meta.totalNodes).toBe(6);
		// isIncompleteMeasurement flows into the existing confidence factor
		expect(result.meta.confidenceFactors.incompleteMeasurements.value).toBe(1);
		const processLine = result.hotspots.find(
			(h) => h.functionName === "ProcessLine",
		);
		expect(processLine?.hitCount).toBe(2);
	});

	test(".alcpuprofile results carry captureKind but no incompleteInvocations", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.meta.captureKind).toBe("sampling");
		expect(result.meta.sourceFormat).toBe("alcpuprofile");
		expect(result.meta.incompleteInvocations).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/core/irjson-analyze.test.ts`
Expected: FAIL — first failure is `parsed.sourceFormat` being `"alcpuprofile"`/`undefined` for the `.ir.json` file (parseProfile currently force-feeds ir-json into `parseProfileFromRaw`, which throws `Invalid profile: missing or empty 'nodes' array` — either failure mode is the expected red).

- [ ] **Step 3: Implement — parser sniffing**

In `src/core/parser.ts`, add the import and replace `parseProfile`:

```typescript
import { isIrJsonDocument, parseIrJson } from "./irjson-parser.js";
```

```typescript
export async function parseProfile(filePath: string): Promise<ParsedProfile> {
	const file = Bun.file(filePath);
	const text = await file.text();
	const raw = JSON.parse(text);
	// Content sniffing, not extension: ir-json carries a numeric top-level
	// schemaVersion + invocations[]; .alcpuprofile carries nodes[].
	if (isIrJsonDocument(raw)) {
		return parseIrJson(raw);
	}
	return parseProfileFromRaw(raw as RawProfile);
}
```

- [ ] **Step 4: Implement — processor**

In `src/types/processed.ts`, import the type and extend `ProcessedProfile` (after `samplingInterval`):

```typescript
import type { ProfileSourceFormat } from "./profile.js";
```

```typescript
	/** Wire format the profile came from. Absent = "alcpuprofile". */
	sourceFormat?: ProfileSourceFormat;
	/** ir-json capture-level counters (ir-json only). */
	irCapture?: {
		invocationCount: number;
		incompleteCount: number;
		exceptionCount: number;
	};
```

In `src/core/processor.ts`:

1. In `calculateSelfTime`, add exact-time preference as the first statement:

```typescript
function calculateSelfTime(
	node: ProcessedNode,
	parsed: ParsedProfile,
	sampleAppearances?: Map<number, number>,
): number {
	const exact = parsed.exactSelfTimes?.get(node.id);
	if (exact !== undefined) return exact;
	if (parsed.type === "instrumentation" && node.positionTicks?.length) {
		return node.positionTicks.reduce((sum, pt) => sum + pt.executionTime, 0);
	}
	const interval = parsed.samplingInterval ?? 0;
	const count = sampleAppearances
		? (sampleAppearances.get(node.id) ?? 0)
		: node.hitCount;
	return count * interval;
}
```

2. In the object returned by `processProfile`, add (after `samplingInterval: parsed.samplingInterval,`):

```typescript
		sourceFormat: parsed.sourceFormat ?? "alcpuprofile",
		irCapture: parsed.irCapture,
```

- [ ] **Step 5: Implement — meta enrichment**

In `src/output/types.ts`, add to the `meta` block of `AnalysisResult` (after `samplingInterval?: number;`):

```typescript
		/**
		 * Capture kind for baseline/lifecycle keying (umbrella spec §4): sampling
		 * statistical times and instrumentation exact times are never comparable.
		 * Mirrors profileType today; kept separate because future capture sources
		 * (telemetry) will diverge.
		 */
		captureKind?: "sampling" | "instrumentation";
		/** Wire format the profile was parsed from. */
		sourceFormat?: "alcpuprofile" | "ir-json";
		/**
		 * Count of isIncomplete invocations in an ir-json capture (absent for
		 * .alcpuprofile). Nonzero flags an incomplete capture — analyzed anyway,
		 * to be excluded from lifecycle run-counting in a later phase.
		 */
		incompleteInvocations?: number;
```

In `src/core/analyzer.ts`, in the `meta` object literal of `analyzeProfile` (after `samplingInterval: processed.samplingInterval,`):

```typescript
			captureKind: processed.type,
			sourceFormat: processed.sourceFormat,
			incompleteInvocations: processed.irCapture?.incompleteCount,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/core/irjson-analyze.test.ts`
Expected: PASS (all tests)

- [ ] **Step 7: Full suite, type-check, lint, commit**

```bash
bun test
bunx tsc --noEmit
bunx biome check --write src/core/parser.ts src/core/processor.ts src/types/processed.ts src/output/types.ts src/core/analyzer.ts test/core/irjson-analyze.test.ts
git add src/core/parser.ts src/core/processor.ts src/types/processed.ts src/output/types.ts src/core/analyzer.ts test/core/irjson-analyze.test.ts
git commit -m "feat(irjson): transparent format detection, exact self-times, capture meta

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 4: Detector upgrades — exact counts on ir-json profiles

Background for the implementer: on an ir-json profile every node is ONE invocation (`hitCount === 1`). This has two consequences for the existing detectors:

- `detectRepeatedSiblings` already works and its counts are now **exact** (50 same-method children = exactly 50 invocations under one parent invocation) — it only needs exact-count wording.
- `detectHighHitCount` is **inert** (every hitCount is 1, so `child > parent * 10` never fires). It needs a real upgrade: exact call amplification measured as total child-method invocations per distinct parent-method invocation, aggregated over each (parent method → child method) edge. This mirrors what the aggregated-V8 hitCount ratio approximates, but with exact numbers.

Both detectors keep their existing behavior byte-for-byte on `.alcpuprofile` profiles (`sourceFormat !== "ir-json"`), so all existing tests keep passing.

**Files:**
- Modify: `src/core/patterns.ts` (`detectHighHitCount`, `detectRepeatedSiblings`)
- Test: `test/core/patterns-irjson.test.ts`

**Interfaces:**
- Consumes: `ProcessedProfile.sourceFormat` from Task 3; `parseIrJson` from Task 2; `IrJsonDocument`/`IrJsonInvocation` from Task 1.
- Produces: no new exports — same `PatternDetector` signatures, same pattern ids (`high-hit-count`, `repeated-siblings`). Lifecycle-relevant invariant: pattern **ids do not change** between formats, only wording/evidence.

- [ ] **Step 1: Write the failing tests**

Create `test/core/patterns-irjson.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseIrJson } from "../../src/core/irjson-parser.js";
import {
	detectHighHitCount,
	detectRepeatedSiblings,
} from "../../src/core/patterns.js";
import { processProfile } from "../../src/core/processor.js";
import type {
	IrJsonDocument,
	IrJsonInvocation,
} from "../../src/types/irjson.js";

function makeInvocation(
	index: number,
	method: string,
	objectId: number,
	parentIx: number | null,
	selfTicks = 1000,
): IrJsonInvocation {
	return {
		index,
		objectType: "CodeUnit",
		objectId,
		objectName: `Obj${objectId}`,
		method,
		appIx: 0,
		startTicks: index * 100,
		endTicks: index * 100 + 50,
		clampedEndTicks: null,
		inSweep: true,
		selfTicks,
		temporalParentIx: parentIx,
		v8AggregationParentIx: null,
		isBuiltin: false,
		isIncomplete: false,
		calledLine: null,
		callerLine: null,
		lines: [],
		exception: null,
	};
}

function makeDoc(invocations: IrJsonInvocation[]): IrJsonDocument {
	return {
		schemaVersion: 1,
		generator: { name: "bc-mdc-converter", version: "0.0.0-test" },
		capture: {
			platformVersion: "26.0.0.0",
			t0Ticks: "0",
			startTicks: 0,
			endTicks: invocations.length * 100 + 50,
			approxWallClockStart: null,
			ticksPerMs: 10000,
			invocationCount: invocations.length,
			incompleteCount: 0,
			exceptionCount: 0,
		},
		apps: [
			{ id: "app-1", name: "Test App", publisher: "Test", version: "1.0.0.0" },
		],
		invocations,
	};
}

describe("detectHighHitCount on ir-json (exact fan-out)", () => {
	test("fires when a method averages >10 child invocations per parent invocation", () => {
		// 2 RunBatch roots, 12 GetLine children each: 24 calls / 2 parents = 12x
		const invs: IrJsonInvocation[] = [
			makeInvocation(0, "RunBatch", 50200, null),
			makeInvocation(1, "RunBatch", 50200, null),
		];
		for (let i = 0; i < 12; i++) {
			invs.push(makeInvocation(2 + i, "GetLine", 50201, 0));
		}
		for (let i = 0; i < 12; i++) {
			invs.push(makeInvocation(14 + i, "GetLine", 50201, 1));
		}
		const profile = processProfile(parseIrJson(makeDoc(invs)));
		const patterns = detectHighHitCount(profile);
		expect(patterns).toHaveLength(1);
		expect(patterns[0].id).toBe("high-hit-count");
		expect(patterns[0].severity).toBe("warning");
		expect(patterns[0].description).toContain("exactly 24 times");
		expect(patterns[0].evidence).toContain("exact invocation counts");
		expect(patterns[0].evidence).toContain("12.0x");
		// impact = 24 child invocations x 100 µs exact self time
		expect(patterns[0].impact).toBe(2400);
	});

	test("does not fire at 10x or below", () => {
		const invs: IrJsonInvocation[] = [
			makeInvocation(0, "RunBatch", 50200, null),
			makeInvocation(1, "RunBatch", 50200, null),
		];
		for (let i = 0; i < 10; i++) {
			invs.push(makeInvocation(2 + i, "GetLine", 50201, 0));
		}
		for (let i = 0; i < 10; i++) {
			invs.push(makeInvocation(12 + i, "GetLine", 50201, 1));
		}
		const profile = processProfile(parseIrJson(makeDoc(invs)));
		expect(detectHighHitCount(profile)).toHaveLength(0);
	});
});

describe("detectRepeatedSiblings on ir-json (exact counts)", () => {
	test("fires with exact-count wording at 50+ same-method children", () => {
		const invs: IrJsonInvocation[] = [makeInvocation(0, "Process", 50300, null)];
		for (let i = 0; i < 55; i++) {
			invs.push(makeInvocation(1 + i, "GetItem", 50301, 0));
		}
		const profile = processProfile(parseIrJson(makeDoc(invs)));
		const patterns = detectRepeatedSiblings(profile);
		expect(patterns).toHaveLength(1);
		expect(patterns[0].id).toBe("repeated-siblings");
		expect(patterns[0].title).toContain("55 times");
		expect(patterns[0].evidence).toContain("exact invocation count");
	});

	test("does not fire below 50", () => {
		const invs: IrJsonInvocation[] = [makeInvocation(0, "Process", 50300, null)];
		for (let i = 0; i < 49; i++) {
			invs.push(makeInvocation(1 + i, "GetItem", 50301, 0));
		}
		const profile = processProfile(parseIrJson(makeDoc(invs)));
		expect(detectRepeatedSiblings(profile)).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/core/patterns-irjson.test.ts`
Expected: FAIL — the high-hit-count positives return `[]` (hitCount 1 everywhere never trips `> parent * 10`), and the repeated-siblings wording assertions fail (`evidence` lacks "exact invocation count").

- [ ] **Step 3: Implement the detector upgrades**

In `src/core/patterns.ts`:

1. Replace `detectHighHitCount` with a format branch plus the new exact detector:

```typescript
/**
 * Detect disproportionate call counts.
 *
 * .alcpuprofile: child nodes where hitCount > parent.hitCount * 10 (hitCount
 * is a sample count on sampling profiles — statistical inference).
 *
 * ir-json: every node is ONE invocation (hitCount == 1), so the hitCount
 * heuristic is inert. Instead measure EXACT call amplification: total child
 * invocations per distinct parent invocation, per (parent method -> child
 * method) edge.
 *
 * Severity: warning.
 */
export const detectHighHitCount: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	if (profile.sourceFormat === "ir-json") {
		return detectHighFanOutExact(profile);
	}

	const patterns: DetectedPattern[] = [];

	for (const node of profile.allNodes) {
		if (isIdleNode(node)) continue;
		if (
			node.parent &&
			node.parent.hitCount > 0 &&
			node.hitCount > node.parent.hitCount * 10
		) {
			patterns.push({
				id: "high-hit-count",
				severity: "warning",
				title: `${node.callFrame.functionName} has disproportionate hit count`,
				description: `${formatMethodRef(node)} has ${node.hitCount} hits vs parent ${formatMethodRef(node.parent)} with ${node.parent.hitCount} hits (ratio ${(node.hitCount / node.parent.hitCount).toFixed(1)}x).`,
				impact: node.selfTime,
				involvedMethods: [formatMethodRef(node), formatMethodRef(node.parent)],
				evidence: `hitCount ratio = ${(node.hitCount / node.parent.hitCount).toFixed(1)}x (threshold: 10x)`,
				suggestion:
					"High hit count suggests this method is called very frequently. Check if callers can batch operations or if an event subscriber is firing too often.",
			});
		}
	}

	return patterns;
};

function detectHighFanOutExact(profile: ProcessedProfile): DetectedPattern[] {
	interface FanOutEdge {
		childCount: number;
		parentIds: Set<number>;
		child: ProcessedNode;
		parent: ProcessedNode;
		impact: number;
	}
	const edges = new Map<string, FanOutEdge>();

	for (const node of profile.allNodes) {
		if (isIdleNode(node) || !node.parent) continue;
		const childKey = `${node.callFrame.functionName}:${node.applicationDefinition.objectId}`;
		const parentKey = `${node.parent.callFrame.functionName}:${node.parent.applicationDefinition.objectId}`;
		const key = `${parentKey}=>${childKey}`;
		let edge = edges.get(key);
		if (!edge) {
			edge = {
				childCount: 0,
				parentIds: new Set(),
				child: node,
				parent: node.parent,
				impact: 0,
			};
			edges.set(key, edge);
		}
		edge.childCount++;
		edge.parentIds.add(node.parent.id);
		edge.impact += node.selfTime;
	}

	const patterns: DetectedPattern[] = [];
	for (const edge of edges.values()) {
		const ratio = edge.childCount / edge.parentIds.size;
		if (ratio > 10) {
			patterns.push({
				id: "high-hit-count",
				severity: "warning",
				title: `${edge.child.callFrame.functionName} has disproportionate invocation count`,
				description: `${formatMethodRef(edge.child)} was invoked exactly ${edge.childCount} times across ${edge.parentIds.size} invocation(s) of ${formatMethodRef(edge.parent)} (${ratio.toFixed(1)}x per call).`,
				impact: edge.impact,
				involvedMethods: [
					formatMethodRef(edge.child),
					formatMethodRef(edge.parent),
				],
				evidence: `exact invocation counts: ${edge.childCount} calls / ${edge.parentIds.size} parent invocations = ${ratio.toFixed(1)}x (threshold: 10x)`,
				suggestion:
					"High invocation count suggests this method is called very frequently. Check if callers can batch operations or if an event subscriber is firing too often.",
			});
		}
	}
	return patterns;
}
```

2. In `detectRepeatedSiblings`, replace the `patterns.push({...})` body inside the `if (group.length >= 50)` block so wording reflects exactness on ir-json (logic unchanged — the counts were already correct there):

```typescript
			if (group.length >= 50) {
				const representative = group[0];
				const totalImpact = group.reduce((sum, n) => sum + n.totalTime, 0);
				const exact = profile.sourceFormat === "ir-json";
				patterns.push({
					id: "repeated-siblings",
					severity: "critical",
					title: `${representative.callFrame.functionName} called ${group.length} times under ${node.callFrame.functionName}`,
					description: exact
						? `${formatMethodRef(node)} invoked ${formatMethodRef(representative)} exactly ${group.length} times (exact invocation count from instrumentation capture) — a loop or repeated invocation pattern.`
						: `${formatMethodRef(node)} has ${group.length} child calls to ${formatMethodRef(representative)}, suggesting a loop or repeated invocation pattern.`,
					impact: totalImpact,
					involvedMethods: [
						formatMethodRef(node),
						formatMethodRef(representative),
					],
					evidence: exact
						? `${group.length} sibling invocations with same functionName+objectId (exact invocation count, threshold: 50)`
						: `${group.length} sibling calls with same functionName+objectId (threshold: 50)`,
					suggestion:
						"The same method is called repeatedly at the same call site. Consider batching these calls or caching the result.",
				});
			}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/core/patterns-irjson.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Verify legacy detector behavior is untouched**

Run: `bun test test/core/patterns.test.ts`
Expected: PASS — no existing assertion changed.

- [ ] **Step 6: Full suite, type-check, lint, commit**

```bash
bun test
bunx tsc --noEmit
bunx biome check --write src/core/patterns.ts test/core/patterns-irjson.test.ts
git add src/core/patterns.ts test/core/patterns-irjson.test.ts
git commit -m "feat(patterns): exact-count logic for high-hit-count and repeated-siblings on ir-json

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 5: /api/ingest — gzip transfer decoding, ir-json payloads, captureKind, size budget

Design decisions (per umbrella spec §1 "gzip/zstd transfer encoding mandated" — gzip only this phase):

- **gzip detection is content-based**: magic bytes `0x1f 0x8b` on the uploaded `profile` part. This is the simplest robust option — multipart part headers (`Content-Encoding` per part) are not exposed through `req.formData()`, and whole-request `Content-Encoding: gzip` would gzip the multipart envelope itself, which BC's HttpClient and most tooling cannot produce. Clients simply gzip the profile bytes before appending the part; uncompressed payloads keep working unchanged.
- **Size budget** enforced on the *decompressed* bytes (gzip-bomb guard): `AL_PERF_MAX_PROFILE_BYTES`, default 134,217,728 (128 MiB), read per request so tests can override. The invocation-count budget is enforced downstream by `parseIrJson` (Task 2) via `config.irJson.maxInvocations`.
- **Format detection needs no handler code**: the handler already writes the payload to disk and calls `analyzeProfile(path)`, which sniffs the content (Task 3). At-rest artifacts (encrypted blob) store the **decompressed** bytes.
- **Manifest `captureKind`**: optional, validated to `"sampling" | "instrumentation"` when present, surfaced in `metrics.json` (falls back to the analyzer's `meta.captureKind` when absent).

**Files:**
- Modify: `web/handlers/ingest.ts`
- Test: `test/web/ingest-irjson.test.ts`

**Interfaces:**
- Consumes: `analyzeProfile` sniffing from Task 3 (the handler itself stays format-agnostic).
- Produces:
  - `/api/ingest` accepts a gzipped or plain `profile` part in either format; new error responses: `400 {"error":"invalid_gzip"}`, `400 {"error":"invalid_capture_kind"}`, `413 {"error":"payload_too_large"}`.
  - `metrics.json` gains `captureKind` and `sourceFormat` keys.
  - Env knob `AL_PERF_MAX_PROFILE_BYTES` (bytes, default 134217728).

- [ ] **Step 1: Write the failing tests**

Create `test/web/ingest-irjson.test.ts` (mirrors the server-boot pattern of `test/web/poc-ingest-v1.test.ts`: env is set before the shared-module-cache server import; `dataDir` is read per request from `AL_PERF_DATA_DIR`, so this file's tmpdir applies to its own requests):

```typescript
import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_DATA = mkdtempSync(join(tmpdir(), "alperf-ingest-irjson-"));
process.env.AL_PERF_DATA_DIR = TEST_DATA;
process.env.AL_PERF_POC_SECRET = "test-secret-1234";
// PORT shared with prior poc-* tests (Bun module cache).
process.env.PORT ??= "3999";

const { server } = await import("../../web/server.ts");
const BASE = `http://localhost:${server.port}`;

afterAll(() => {
	rmSync(TEST_DATA, { recursive: true, force: true });
	delete process.env.AL_PERF_MAX_PROFILE_BYTES;
});

const IRJSON_BYTES = readFileSync("test/fixtures/irjson-minimal.ir.json");

async function registerTenant(code: string): Promise<string> {
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
	const publicXml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;
	const res = await fetch(`${BASE}/api/tenants/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			tenantCode: code,
			sharedSecret: "test-secret-1234",
			publicKeyXml: publicXml,
		}),
	});
	expect(res.status).toBe(201);
	const { tenantToken } = (await res.json()) as { tenantToken: string };
	return tenantToken;
}

function postIngest(
	token: string,
	tenant: string,
	idempotencyKey: string,
	profile: Uint8Array,
	manifest: Record<string, unknown>,
): Promise<Response> {
	const fd = new FormData();
	fd.append(
		"manifest",
		new Blob([JSON.stringify(manifest)], { type: "application/json" }),
		"manifest.json",
	);
	fd.append(
		"profile",
		new Blob([profile], { type: "application/octet-stream" }),
		"p.ir.json",
	);
	return fetch(`${BASE}/api/ingest`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"X-Tenant-Id": tenant,
			"X-Idempotency-Key": idempotencyKey,
		},
		body: fd,
	});
}

describe("POST /api/ingest with ir-json", () => {
	it("accepts a gzipped ir-json profile and records captureKind + sourceFormat", async () => {
		const token = await registerTenant("irja");
		const gz = Bun.gzipSync(IRJSON_BYTES);
		const key = "550e8400-e29b-41d4-a716-446655440101";
		const res = await postIngest(token, "irja", key, gz, {
			activityId: key,
			captureKind: "instrumentation",
		});
		expect(res.status).toBe(202);

		const profileDir = join(TEST_DATA, "storage", "irja", "profiles", key);
		expect(existsSync(join(profileDir, "metrics.json"))).toBe(true);
		expect(existsSync(join(profileDir, "profile.bin"))).toBe(false);
		const metrics = JSON.parse(
			readFileSync(join(profileDir, "metrics.json"), "utf8"),
		);
		expect(metrics.captureKind).toBe("instrumentation");
		expect(metrics.sourceFormat).toBe("ir-json");
		// profileSize is the DECOMPRESSED payload size
		expect(metrics.profileSize).toBe(IRJSON_BYTES.byteLength);
	});

	it("accepts a plain (uncompressed) ir-json profile", async () => {
		const token = await registerTenant("irjb");
		const key = "550e8400-e29b-41d4-a716-446655440102";
		const res = await postIngest(token, "irjb", key, IRJSON_BYTES, {
			activityId: key,
		});
		expect(res.status).toBe(202);
		const metrics = JSON.parse(
			readFileSync(
				join(TEST_DATA, "storage", "irjb", "profiles", key, "metrics.json"),
				"utf8",
			),
		);
		// no manifest captureKind -> falls back to the analyzer's meta
		expect(metrics.captureKind).toBe("instrumentation");
	});

	it("rejects corrupt gzip with 400 invalid_gzip", async () => {
		const token = await registerTenant("irjc");
		const key = "550e8400-e29b-41d4-a716-446655440103";
		const corrupt = new Uint8Array([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03]);
		const res = await postIngest(token, "irjc", key, corrupt, {
			activityId: key,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"invalid_gzip",
		);
	});

	it("rejects decompressed payloads over AL_PERF_MAX_PROFILE_BYTES with 413", async () => {
		const token = await registerTenant("irjd");
		const key = "550e8400-e29b-41d4-a716-446655440104";
		process.env.AL_PERF_MAX_PROFILE_BYTES = "1024";
		try {
			const gz = Bun.gzipSync(IRJSON_BYTES); // decompressed ~5 KB > 1024
			const res = await postIngest(token, "irjd", key, gz, {
				activityId: key,
			});
			expect(res.status).toBe(413);
			expect(((await res.json()) as { error: string }).error).toBe(
				"payload_too_large",
			);
		} finally {
			delete process.env.AL_PERF_MAX_PROFILE_BYTES;
		}
	});

	it("rejects an invalid manifest captureKind with 400", async () => {
		const token = await registerTenant("irje");
		const key = "550e8400-e29b-41d4-a716-446655440105";
		const res = await postIngest(token, "irje", key, IRJSON_BYTES, {
			activityId: key,
			captureKind: "bogus",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"invalid_capture_kind",
		);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/web/ingest-irjson.test.ts`
Expected: FAIL — the gzipped upload returns 500 `analyze_failed` (handler feeds gzip bytes to `analyzeProfile`), and metrics assertions fail (`captureKind`/`sourceFormat` missing).

- [ ] **Step 3: Implement the handler changes**

In `web/handlers/ingest.ts`:

1. Add the default budget constant next to `KEY_VERSION_POC`:

```typescript
const DEFAULT_MAX_PROFILE_BYTES = 134_217_728; // 128 MiB decompressed
```

2. Replace the two lines that read the parts' bytes (currently `const manifestBytes = ...` / `const profileBytes = ...`) with:

```typescript
	const manifestBytes = Buffer.from(await manifestPart.arrayBuffer());
	let profileBytes = Buffer.from(await profilePart.arrayBuffer());

	// gzip transfer encoding, detected by content (magic bytes 0x1f 0x8b) —
	// multipart part headers are not visible through req.formData(), so the
	// contract is: gzip the profile bytes themselves before appending the part.
	if (
		profileBytes.length >= 2 &&
		profileBytes[0] === 0x1f &&
		profileBytes[1] === 0x8b
	) {
		try {
			profileBytes = Buffer.from(Bun.gunzipSync(profileBytes));
		} catch {
			return jsonResponse(400, { error: "invalid_gzip" });
		}
	}

	// Size budget on DECOMPRESSED bytes (gzip-bomb guard). Read per request so
	// tests can override; the invocation-count budget lives in the parser.
	const maxProfileBytes = Number(
		process.env.AL_PERF_MAX_PROFILE_BYTES ?? DEFAULT_MAX_PROFILE_BYTES,
	);
	if (profileBytes.length > maxProfileBytes) {
		return jsonResponse(413, { error: "payload_too_large" });
	}
```

3. After the existing `manifest` JSON.parse block (after the `catch` returning `manifest_not_json`), add:

```typescript
	const captureKind = manifest.captureKind;
	if (
		captureKind !== undefined &&
		captureKind !== "sampling" &&
		captureKind !== "instrumentation"
	) {
		return jsonResponse(400, { error: "invalid_capture_kind" });
	}
```

4. In `extractMetrics`, add two keys after `activityType: manifest.activityType,`:

```typescript
		captureKind: manifest.captureKind ?? meta.captureKind ?? null,
		sourceFormat: meta.sourceFormat ?? null,
```

Note: everything downstream (temp `profile.bin`, `analyzeProfile`, `encryptBundle`) now operates on the decompressed bytes — the at-rest encrypted blob stores the decompressed payload, and `profileSize` in metrics is the decompressed size. No other handler changes: format detection happens inside `analyzeProfile` (Task 3).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/web/ingest-irjson.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Verify existing web tests still pass**

Run: `bun test test/web/`
Expected: PASS — the legacy `.alcpuprofile` multipart path is untouched (plain bytes skip the gzip branch).

- [ ] **Step 6: Full suite, type-check, lint, commit**

```bash
bun test
bunx tsc --noEmit
bunx biome check --write web/handlers/ingest.ts test/web/ingest-irjson.test.ts
git add web/handlers/ingest.ts test/web/ingest-irjson.test.ts
git commit -m "feat(ingest): gzip transfer decoding, ir-json payloads, captureKind, size budget

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 6: Library exports, docs, and end-to-end CLI verification

**Files:**
- Modify: `src/index.ts` (public API exports)
- Modify: `CLAUDE.md` (document ir-json ingestion)
- Test: extend `test/core/irjson-contract.test.ts`

**Interfaces:**
- Consumes: `parseIrJson`, `isIrJsonDocument` (Task 2), `IRJSON_SCHEMA_VERSION` + types (Task 1).
- Produces: `al-perf` package exports — `parseIrJson`, `isIrJsonDocument`, `IRJSON_SCHEMA_VERSION`, and types `IrJsonDocument`, `IrJsonInvocation`, `IrJsonCapture`, `IrJsonApp`.

- [ ] **Step 1: Write the failing test**

Append to `test/core/irjson-contract.test.ts`:

```typescript
describe("library API surface", () => {
	test("ir-json parser and pin are exported from the package root", async () => {
		const api = await import("../../src/index.js");
		expect(typeof api.parseIrJson).toBe("function");
		expect(typeof api.isIrJsonDocument).toBe("function");
		expect(api.IRJSON_SCHEMA_VERSION).toBe(1);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/core/irjson-contract.test.ts`
Expected: FAIL — `api.parseIrJson` is `undefined`.

- [ ] **Step 3: Add the exports**

In `src/index.ts`, add alongside the other `./core/` exports (alphabetical neighborhood of the existing `export { analyzeProfile... }` lines):

```typescript
export { isIrJsonDocument, parseIrJson } from "./core/irjson-parser.js";
export { IRJSON_SCHEMA_VERSION } from "./types/irjson.js";
export type {
	IrJsonApp,
	IrJsonCapture,
	IrJsonDocument,
	IrJsonInvocation,
} from "./types/irjson.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/core/irjson-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Document in CLAUDE.md**

In `CLAUDE.md`, in the "Data Flow" section, replace the line
`1. **Parse** \`.alcpuprofile\` → \`RawProfile\``
with:

```markdown
1. **Parse** `.alcpuprofile` → `RawProfile`, or `ir-json` (bc-mdc-converter's lossless per-invocation instrumentation IR) → synthesized per-invocation nodes. Format is sniffed from content, not extension — `analyzeProfile(path)` accepts both.
```

and add a new subsection after "### Pattern Detection":

```markdown
### ir-json Ingestion

`ir-json` is the lossless instrumentation interchange format produced by
`bc-mdc-converter --format ir-json` (spec: that repo's
`docs/superpowers/specs/2026-07-06-ir-json-format-design.md`). Key facts:

- Pinned to integer `schemaVersion` 1 via `IRJSON_SCHEMA_VERSION` in
  `src/types/irjson.ts` (contract test: `test/core/irjson-contract.test.ts`).
  Unknown keys are ignored (additive changes don't bump the version).
- `src/core/irjson-parser.ts` synthesizes one node per invocation
  (hitCount = 1 → aggregated hitCounts are EXACT invocation counts), builds
  the temporal call tree from `temporalParentIx`, converts 100 ns ticks to µs,
  and shifts 0-based wire lines to 1-based display lines — all exactly once.
- `ProcessedProfile.sourceFormat` is `"ir-json"` for these profiles;
  `meta.captureKind`, `meta.sourceFormat`, and `meta.incompleteInvocations`
  surface capture facts. Incomplete captures are analyzed and flagged.
- `repeated-siblings` and `high-hit-count` use exact counts (not statistical
  inference) on ir-json profiles.
- `/api/ingest` accepts gzipped profile parts (magic-byte detection);
  decompressed size budget `AL_PERF_MAX_PROFILE_BYTES` (default 128 MiB),
  invocation budget `config.irJson.maxInvocations` (500,000).
```

- [ ] **Step 6: End-to-end CLI verification (manual smoke)**

```bash
bun -e "await Bun.write('/tmp/tiny.ir.json', Bun.gunzipSync(await Bun.file('test/fixtures/tiny.ir.json.gz').bytes()))"
bun run src/cli/index.ts analyze /tmp/tiny.ir.json
```

Expected: a normal terminal analysis (no crash, exit 0) — profile type `instrumentation`, hotspot table topped by real BC methods (e.g. `IsNonInventoriableType`), hit counts shown as exact invocation counts (`IsNonInventoriableType` = 102).

Also verify JSON meta:

```bash
bun run src/cli/index.ts analyze /tmp/tiny.ir.json -f json | bun -e "const r = await new Response(Bun.stdin.stream()).json(); console.log(r.meta.captureKind, r.meta.sourceFormat, r.meta.incompleteInvocations)"
```

Expected output: `instrumentation ir-json 0`

- [ ] **Step 7: Full suite, type-check, lint, commit**

```bash
bun test
bunx tsc --noEmit
bunx biome check --write src/index.ts test/core/irjson-contract.test.ts
git add src/index.ts CLAUDE.md test/core/irjson-contract.test.ts
git commit -m "chore(irjson): library exports and ir-json ingestion docs

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

## Scope Coverage Map (spec → tasks)

| Scope item | Task |
|---|---|
| 1. `src/types/irjson.ts` typed schema + `IRJSON_SCHEMA_VERSION` pin | Task 1 |
| 2. `src/core/irjson-parser.ts` parse/validate → ProcessedProfile-compatible, exact self-times/counts, `profileType: "instrumentation"`, isIncomplete carried | Tasks 2–3 |
| 3. Format detection in the analyze path (top-level marker sniff) | Task 3 |
| 4. ProcessedProfile enrichment: exact hitCounts; `captureKind` on meta | Tasks 2 (hitCount=1 synthesis) + 3 (meta) |
| 5. Detector upgrades (repeated-siblings, high-hit-count) with both formats green | Task 4 |
| 6. `/api/ingest`: content detection, gzip, manifest `captureKind`, size budget | Task 5 |
| 7. schemaVersion contract-pin test (mirrors `EXPECTED_*_SCHEMA_VERSION`) | Task 1 |
| 8. Committed fixtures + golden parser tests | Tasks 1–3 |

## Known Risks / Notes for the Implementer

- **Golden numbers depend on the committed `tiny.ir.json.gz`.** They were measured against the fixture generated by bc-mdc-converter `0.1.0` from `fixtures/tiny.mdc.zip` on 2026-07-10 (1,639 invocations / 214 roots / Σ selfTicks 503,943 / depth 28 / `IsNonInventoriableType` ×102). If regeneration produces different numbers (converter changed), re-baseline the assertions in Tasks 1–3 against the actual committed file — the point of the goldens is pinning the committed artifact, not those literal values.
- **Batch directory scans still glob `.alcpuprofile` only** (`src/mcp/server.ts`, batch command). Single-file ir-json works everywhere a path is passed. Extending directory globs to `.ir.json` is deliberately out of scope.
- **`lineHotspots` and `instanceStats` are absent for ir-json profiles** (both gate on `positionTicks`, which ir-json nodes don't carry — there is no per-line time in the IR, and per-invocation instance stats are a future enhancement).
- **`capture.endTicks` uses the V8 convention** (last-ordinal invocation's end, not the max). `totalDuration` inherits that convention; the delta on the real fixture is 8 ticks (0.8 µs) — irrelevant, but don't "fix" it to the max without updating goldens.
- **Web tests share one server process** (Bun module cache). The new test file follows the established poc-* pattern: distinct tenant codes, distinct idempotency GUIDs, `AL_PERF_DATA_DIR` read per request.
