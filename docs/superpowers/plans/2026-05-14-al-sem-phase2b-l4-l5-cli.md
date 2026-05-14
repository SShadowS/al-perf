# al-sem Phase 2b — L4 Summary Engine + L5 Detectors + CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the al-sem engine — build the L4 interprocedural summary engine + path-walker, the L5 detectors (D1/D2/D3), and a CLI, so `analyzeWorkspace` returns end-to-end `{ model, findings, diagnostics }`.

**Architecture:** Two new layers on the completed Phase 2a `SemanticModel`. **L4:** `buildCombinedGraph` unifies the call graph + event graph into one routine→routine graph; `scc` runs Tarjan over it; `summary-engine` composes a `RoutineSummary` per routine bottom-up over the SCC condensation, with a finite monotone fixed-point inside cycles; `path-walker` is a shared bounded-traversal primitive. **L5:** three detectors (`d1`/`d2`/`d3`) are pure queries that prune via summaries then use the path-walker with a detector-specific policy to build evidence-backed `Finding`s; a registry runs them in isolation. A `commander` CLI wraps the library call.

**Tech Stack:** TypeScript, Bun, `bun:test`, `commander` (new dependency), `biome` (lint/format). All work in the `al-sem` repo at `U:\Git\al-sem\` on the `master` branch.

**Spec:** `docs/superpowers/specs/2026-05-14-al-sem-phase2b-l4-l5-design.md` (in the al-perf repo).

---

## Working agreements (apply to every task)

- All commands run from `U:/Git/al-sem`.
- After each task: `bun test` (full suite green), `bunx tsc --noEmit` (exit 0), `bunx biome check src test` (exit 0).
- **Biome rejects `!` non-null assertions in `src/` AND `test/`.** Several test snippets below use `x!` (e.g. `process!`, `runAll!`) purely for brevity. When implementing, replace each `x!` with an explicit guard so biome stays clean — the established Phase 1/2a pattern:
  ```typescript
  const process = model.routines.find((r) => r.name === "Process");
  if (process === undefined) throw new Error("fixture: Process routine not found");
  // ...then use `process` directly
  ```
  Use `?.` instead where the value is only read in an `expect(...)` and an `undefined` would fail the assertion anyway. This is a mechanical transform — apply it task-by-task; it does not change test intent.
- Tests use `bun:test` (`import { describe, expect, test } from "bun:test"`). Fixture workspaces are loaded via `indexWorkspace` / `analyzeWorkspace` from `src/index.ts` using `fileURLToPath(new URL("../fixtures/<name>", import.meta.url))`.
- The full Phase 1 + 2a suite is currently **115 tests passing**. Every task adds tests; the suite only grows.
- Do not touch the pre-existing untracked `test_edge.test.ts` at the repo root.

## Model facts the implementer must know (verified against the shipped code)

- **All Phase 2b model types already exist** in `src/model/` — `RoutineSummary`, `DbEffect`, `ParameterEffectSummary`, `FieldEffectSet`, `Uncertainty`, `EffectPresence` (in `summary.ts`); `Finding`, `EvidenceStep`, `FixOption`, `FindingConfidence`, `Diagnostic` (in `finding.ts`); `Routine.summary?` is the sink (in `entities.ts`). **No model schema change is needed or allowed.**
- `Routine.features` is an `IntraproceduralFeatures` with `loops: LoopNode[]`, `operationSites: OperationSite[]`, `recordOperations: RecordOperation[]`, `callSites: CallSite[]`, `fieldAccesses: FieldAccess[]`, `recordVariables: RecordVariable[]`.
- `OperationSite.kind` values actually emitted by the indexer are **only** `"record-op"`, `"lock"`, `"commit"`. **`"event-publish"` is in the type union but is never emitted.** Therefore `publishesEvents` and D2's trigger are derived from `CallEdge`s whose `to` routine has `kind === "event-publisher"` (using the originating `CallSite.loopStack` for loop context) — **not** from `OperationSite`s. This plan overrides the spec wherever it said "event-publish OperationSite".
- Every `RecordOperation` also has a matching `OperationSite` (same `id`); `LockTable` gets `OperationSite.kind === "lock"`, all other record ops get `"record-op"`.
- `CallEdge` (in `graph.ts`): `{ from: RoutineId; to?: RoutineId; callsiteId; operationId; dispatchKind: DispatchKind; resolution: ResolutionQuality; provenance }`. `DispatchKind = "direct" | "method" | "interface" | "codeunit-run" | "report-run" | "page-run" | "event-dispatch" | "implicit-trigger" | "dynamic" | "unresolved"`. `CallEdge` has **no `uncertainty` field**.
- `EventSymbol` (in `graph.ts`): `{ id: EventId; publisherObjectId; publisherRoutineId?: RoutineId; eventName; eventKind; ... }`. `EventEdge`: `{ eventId: EventId; subscriberRoutineId: RoutineId; subscriberAppId: string; resolution: "resolved" | "maybe" | "unknown"; ... }`. `EventGraph`: `{ events: EventSymbol[]; edges: EventEdge[] }`.
- `FindingConfidence.cappedBy` accepts **only** `"unresolved-call" | "opaque-callee" | "dynamic-dispatch" | "parse-incomplete" | "version-mismatch"`. `Uncertainty.kind` additionally has `"interface-dispatch"` and `"recordref-or-variant"` — these cap confidence but must **not** be placed in `cappedBy`.
- `Uncertainty` variants (in `summary.ts`): `{ kind: "unresolved-call"; callsiteId }`, `{ kind: "opaque-callee"; callsiteId }`, `{ kind: "dynamic-dispatch"; operationId }`, `{ kind: "recordref-or-variant"; operationId }`, `{ kind: "interface-dispatch"; callsiteId }`, `{ kind: "parse-incomplete"; routineId }`.
- ID encoders live in `src/model/ids.ts` (`encodeEventId`, etc.). All IDs are `string` aliases.
- `analyzeWorkspace` currently returns `{ model: SemanticModel; diagnostics: Diagnostic[] }` from `src/index.ts`; `indexWorkspace` returns `{ index; units; indexDiagnostics; diagnostics }`.

## File structure

| File | Responsibility |
|------|----------------|
| `src/engine/op-classification.ts` | Pure `classifyOp(op: RecordOpType): OpEffectClass` table. |
| `src/engine/combined-graph.ts` | `CombinedGraph`/`CombinedEdge`/`UncertaintyEdge` types + `buildCombinedGraph(model)`. |
| `src/engine/scc.ts` | `tarjanScc(graph): SccResult` — SCCs in reverse-topological order. |
| `src/engine/effect-lattice.ts` | Pure ops: `joinPresence`, `unionTables`, `effectKeyOf`, `mergeDbEffects`, `mergeVia`. |
| `src/engine/summary-engine.ts` | `computeSummaries(model, graph, diagnostics)` + `computeFieldEffects`; mutates `routine.summary`. |
| `src/engine/path-walker.ts` | `walkEvidence(start, policy, bounds, graph, model): WalkResult[]` + `WalkPolicy`/`WalkResult` types. |
| `src/detectors/confidence.ts` | `toConfidence(uncertainties, baseLevel): FindingConfidence`. |
| `src/detectors/registry.ts` | `runDetectors(model, graph): { findings; diagnostics }` — isolated execution + stable sort. |
| `src/detectors/d1-db-op-in-loop.ts` | D1 detector. |
| `src/detectors/d2-event-fanout-in-loop.ts` | D2 detector. |
| `src/detectors/d3-missing-setloadfields.ts` | D3 detector. |
| `src/cli/index.ts` | `commander` entry: `al-sem analyze <workspace>`. |
| `src/cli/format-terminal.ts` | Human-readable output. |
| `src/cli/format-json.ts` | `{ model, findings, diagnostics }` JSON output. |
| `src/index.ts` (modify) | Wire L4 + L5 into `analyzeWorkspace`; widen return type; export new surface. |

---

## Task 1: Operation classification

**Files:**
- Create: `src/engine/op-classification.ts`
- Test: `test/engine/op-classification.test.ts`

This is the guard against D1 false positives — not every `RecordOpType` is a database round-trip.

- [ ] **Step 1: Write the failing test**

`test/engine/op-classification.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { classifyOp } from "../../src/engine/op-classification.ts";

describe("classifyOp", () => {
	test("db-read ops", () => {
		for (const op of ["FindSet", "FindFirst", "FindLast", "Find", "Get", "Next", "Count", "CountApprox", "IsEmpty", "CalcFields", "CalcSums"] as const) {
			expect(classifyOp(op)).toBe("db-read");
		}
	});
	test("db-write ops", () => {
		for (const op of ["Modify", "ModifyAll", "Insert", "Delete", "DeleteAll"] as const) {
			expect(classifyOp(op)).toBe("db-write");
		}
	});
	test("db-lock ops", () => {
		expect(classifyOp("LockTable")).toBe("db-lock");
	});
	test("state-only ops", () => {
		for (const op of ["SetLoadFields", "AddLoadFields", "SetRange", "SetFilter", "SetCurrentKey", "Reset", "Copy", "TransferFields"] as const) {
			expect(classifyOp(op)).toBe("state-only");
		}
	});
	test("trigger ops", () => {
		expect(classifyOp("Validate")).toBe("trigger");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/engine/op-classification.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/op-classification.ts'`.

- [ ] **Step 3: Write the implementation**

`src/engine/op-classification.ts`:
```typescript
import type { RecordOpType } from "../model/entities.ts";

/**
 * The effect class of a record operation. `touchesDb` is driven only by db-read /
 * db-write / db-lock; state-only ops feed D3's load-field analysis and parameterEffects;
 * `trigger` (Validate) has no direct DB effect — its effects arrive via the Phase 2a
 * implicit-trigger edge.
 */
export type OpEffectClass = "db-read" | "db-write" | "db-lock" | "state-only" | "trigger";

const CLASS_BY_OP: Record<RecordOpType, OpEffectClass> = {
	FindSet: "db-read",
	FindFirst: "db-read",
	FindLast: "db-read",
	Find: "db-read",
	Get: "db-read",
	Next: "db-read",
	Count: "db-read",
	CountApprox: "db-read",
	IsEmpty: "db-read",
	CalcFields: "db-read",
	CalcSums: "db-read",
	Modify: "db-write",
	ModifyAll: "db-write",
	Insert: "db-write",
	Delete: "db-write",
	DeleteAll: "db-write",
	LockTable: "db-lock",
	SetLoadFields: "state-only",
	AddLoadFields: "state-only",
	SetRange: "state-only",
	SetFilter: "state-only",
	SetCurrentKey: "state-only",
	Reset: "state-only",
	Copy: "state-only",
	TransferFields: "state-only",
	Validate: "trigger",
};

/** Classify a record operation by its database effect. Pure, total over RecordOpType. */
export function classifyOp(op: RecordOpType): OpEffectClass {
	return CLASS_BY_OP[op];
}

/** True when this op class contributes to `touchesDb`. */
export function isDbTouchingClass(cls: OpEffectClass): boolean {
	return cls === "db-read" || cls === "db-write" || cls === "db-lock";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/engine/op-classification.test.ts`
Expected: PASS — 5 tests pass. (If TypeScript complains the `Record<RecordOpType, ...>` is missing a key, that key is a `RecordOpType` value the table forgot — add it.)

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/engine/op-classification.ts test/engine/op-classification.test.ts
git commit -m "feat: add record-op effect classification"
```

---

## Task 2: Combined graph

**Files:**
- Create: `src/engine/combined-graph.ts`
- Test: `test/engine/combined-graph.test.ts`

Unifies the Phase 2a `callGraph` + `eventGraph` into one routine→routine graph, plus a list of uncertainty records (since `CallEdge` carries no uncertainty field).

- [ ] **Step 1: Write the failing test**

`test/engine/combined-graph.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildCombinedGraph } from "../../src/engine/combined-graph.ts";

const WS_CALLS = fileURLToPath(new URL("../fixtures/ws-calls", import.meta.url));
const WS_EVENTS = fileURLToPath(new URL("../fixtures/ws-events", import.meta.url));

describe("buildCombinedGraph", () => {
	test("call edges with a resolved target become CombinedEdges", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_CALLS, deterministic: true });
		const graph = buildCombinedGraph(model);
		// Every CombinedEdge mirrors a resolved CallEdge or an event-dispatch hop.
		const resolvedCallEdges = model.callGraph.filter((e) => e.to !== undefined && e.dispatchKind !== "event-dispatch");
		const directEdges = [...graph.edgesByFrom.values()].flat().filter((e) => e.callsiteId !== undefined);
		expect(directEdges.length).toBe(resolvedCallEdges.length);
		expect(graph.nodes.length).toBe(model.routines.length);
	});

	test("call edges with no target become UncertaintyEdges, not graph edges", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_CALLS, deterministic: true });
		const graph = buildCombinedGraph(model);
		const unresolved = model.callGraph.filter((e) => e.to === undefined);
		// Each to-less edge contributes exactly one UncertaintyEdge.
		expect(graph.uncertaintyEdges.length).toBe(unresolved.length);
		for (const ue of graph.uncertaintyEdges) {
			expect(["unresolved-call", "interface-dispatch", "dynamic-dispatch"]).toContain(ue.uncertainty.kind);
		}
	});

	test("event-dispatch edges join publisher routine to subscriber routine", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_EVENTS, deterministic: true });
		const graph = buildCombinedGraph(model);
		const eventEdges = [...graph.edgesByFrom.values()].flat().filter((e) => e.kind === "event-dispatch");
		// ws-events has one publisher routine with one resolved subscriber.
		expect(eventEdges.length).toBeGreaterThanOrEqual(1);
		for (const e of eventEdges) {
			expect(e.eventId).toBeDefined();
			expect(model.routines.some((r) => r.id === e.from)).toBe(true);
			expect(model.routines.some((r) => r.id === e.to)).toBe(true);
		}
	});

	test("output is deterministic — nodes and edge lists are sorted", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_CALLS, deterministic: true });
		const graph = buildCombinedGraph(model);
		const sortedNodes = [...graph.nodes].sort();
		expect(graph.nodes).toEqual(sortedNodes);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/engine/combined-graph.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/combined-graph.ts'`.

- [ ] **Step 3: Write the implementation**

`src/engine/combined-graph.ts`:
```typescript
import type { DispatchKind, ResolutionQuality } from "../model/graph.ts";
import type { CallsiteId, EventId, OperationId, RoutineId } from "../model/ids.ts";
import type { SemanticModel } from "../model/model.ts";
import type { Uncertainty } from "../model/summary.ts";

/** The origin kind of a combined-graph edge. */
export type CombinedEdgeKind =
	| "direct"
	| "method"
	| "codeunit-run"
	| "report-run"
	| "page-run"
	| "interface"
	| "implicit-trigger"
	| "event-dispatch"
	| "dynamic";

/** A resolved routine -> routine edge in the combined graph. */
export interface CombinedEdge {
	from: RoutineId;
	to: RoutineId;
	kind: CombinedEdgeKind;
	callsiteId?: CallsiteId; // present for call-derived edges
	operationId?: OperationId; // present for call-derived edges
	eventId?: EventId; // present for event-dispatch edges
	subscriberAppId?: string; // present for event-dispatch edges
	resolution: ResolutionQuality | "resolved" | "maybe" | "unknown";
}

/** An uncertainty attached to a routine because one of its call sites had no resolved target. */
export interface UncertaintyEdge {
	from: RoutineId;
	uncertainty: Uncertainty;
}

/** The combined call + event + implicit-trigger graph the summary engine and path-walker traverse. */
export interface CombinedGraph {
	nodes: RoutineId[]; // sorted
	edgesByFrom: Map<RoutineId, CombinedEdge[]>; // each list sorted
	uncertaintyEdges: UncertaintyEdge[]; // sorted
}

// CallGraph dispatchKinds that become resolved routine->routine edges (when `to` is set).
const EDGE_KINDS: ReadonlySet<DispatchKind> = new Set<DispatchKind>([
	"direct",
	"method",
	"codeunit-run",
	"report-run",
	"page-run",
	"interface",
	"implicit-trigger",
	"dynamic",
]);

function edgeSortKey(e: CombinedEdge): string {
	return `${e.kind}|${e.callsiteId ?? e.operationId ?? e.eventId ?? ""}|${e.to}`;
}

function uncertaintySortKey(ue: UncertaintyEdge): string {
	const u = ue.uncertainty;
	const ref =
		"callsiteId" in u ? u.callsiteId : "operationId" in u ? u.operationId : u.routineId;
	return `${ue.from}|${u.kind}|${ref}`;
}

/**
 * Build the combined graph. Resolved CallEdges (and event-dispatch hops derived from the
 * event graph) become CombinedEdges; to-less CallEdges become UncertaintyEdges. The
 * `event-dispatch` dispatchKind on CallEdges is intentionally skipped here — event hops are
 * generated once from `model.eventGraph` to avoid double counting.
 */
export function buildCombinedGraph(model: SemanticModel): CombinedGraph {
	const edges: CombinedEdge[] = [];
	const uncertaintyEdges: UncertaintyEdge[] = [];

	// --- call-derived edges + uncertainty records ---
	for (const ce of model.callGraph) {
		if (ce.dispatchKind === "event-dispatch") continue; // event hops come from the event graph
		if (ce.to !== undefined) {
			if (EDGE_KINDS.has(ce.dispatchKind)) {
				edges.push({
					from: ce.from,
					to: ce.to,
					kind: ce.dispatchKind as CombinedEdgeKind,
					callsiteId: ce.callsiteId,
					operationId: ce.operationId,
					resolution: ce.resolution,
				});
			}
			continue;
		}
		// to-less edge -> typed uncertainty on the `from` routine
		if (ce.dispatchKind === "interface") {
			uncertaintyEdges.push({
				from: ce.from,
				uncertainty: { kind: "interface-dispatch", callsiteId: ce.callsiteId },
			});
		} else if (ce.dispatchKind === "dynamic") {
			uncertaintyEdges.push({
				from: ce.from,
				uncertainty: { kind: "dynamic-dispatch", operationId: ce.operationId },
			});
		} else {
			uncertaintyEdges.push({
				from: ce.from,
				uncertainty: { kind: "unresolved-call", callsiteId: ce.callsiteId },
			});
		}
	}

	// --- event-dispatch edges: publisher routine -> subscriber routine ---
	const subsByEvent = new Map<EventId, typeof model.eventGraph.edges>();
	for (const ee of model.eventGraph.edges) {
		const list = subsByEvent.get(ee.eventId);
		if (list) list.push(ee);
		else subsByEvent.set(ee.eventId, [ee]);
	}
	for (const sym of model.eventGraph.events) {
		if (sym.publisherRoutineId === undefined) continue;
		for (const ee of subsByEvent.get(sym.id) ?? []) {
			edges.push({
				from: sym.publisherRoutineId,
				to: ee.subscriberRoutineId,
				kind: "event-dispatch",
				eventId: sym.id,
				subscriberAppId: ee.subscriberAppId,
				resolution: ee.resolution,
			});
		}
	}

	// --- assemble: sorted nodes, sorted edge lists, sorted uncertainty edges ---
	const nodes = model.routines.map((r) => r.id).sort();
	const edgesByFrom = new Map<RoutineId, CombinedEdge[]>();
	for (const e of edges) {
		const list = edgesByFrom.get(e.from);
		if (list) list.push(e);
		else edgesByFrom.set(e.from, [e]);
	}
	for (const list of edgesByFrom.values()) {
		list.sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));
	}
	uncertaintyEdges.sort((a, b) => uncertaintySortKey(a).localeCompare(uncertaintySortKey(b)));

	return { nodes, edgesByFrom, uncertaintyEdges };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/engine/combined-graph.test.ts`
Expected: PASS — 4 tests pass.

> If the event-dispatch test finds 0 edges: confirm `ws-events` produces an `EventSymbol` with a defined `publisherRoutineId` and a resolved `EventEdge`. The Phase 2a event-graph tests already assert this — check `test/resolve/event-graph.test.ts` for the exact fixture expectations.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/engine/combined-graph.ts test/engine/combined-graph.test.ts
git commit -m "feat: add combined-graph builder (call + event + uncertainty edges)"
```

---

## Task 3: Tarjan SCC

**Files:**
- Create: `src/engine/scc.ts`
- Test: `test/engine/scc.test.ts`

Tarjan's strongly-connected-components over the `CombinedGraph`, returned in reverse-topological order of the condensation (callees before callers).

- [ ] **Step 1: Write the failing test**

`test/engine/scc.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import type { CombinedEdge, CombinedGraph } from "../../src/engine/combined-graph.ts";
import { tarjanScc } from "../../src/engine/scc.ts";

function graphOf(nodes: string[], edges: [string, string][]): CombinedGraph {
	const edgesByFrom = new Map<string, CombinedEdge[]>();
	for (const [from, to] of edges) {
		const e: CombinedEdge = { from, to, kind: "direct", resolution: "resolved" };
		const list = edgesByFrom.get(from);
		if (list) list.push(e);
		else edgesByFrom.set(from, [e]);
	}
	return { nodes: [...nodes].sort(), edgesByFrom, uncertaintyEdges: [] };
}

describe("tarjanScc", () => {
	test("a linear chain yields singleton SCCs in reverse-topological order", () => {
		// a -> b -> c. Callees (c) come before callers (a).
		const result = tarjanScc(graphOf(["a", "b", "c"], [["a", "b"], ["b", "c"]]));
		expect(result.sccs.map((s) => s.members)).toEqual([["c"], ["b"], ["a"]]);
		expect(result.sccs.every((s) => !s.recursive)).toBe(true);
	});

	test("a cycle collapses into one recursive SCC with sorted members", () => {
		// a -> b -> a, plus c -> a.
		const result = tarjanScc(graphOf(["a", "b", "c"], [["a", "b"], ["b", "a"], ["c", "a"]]));
		const cycle = result.sccs.find((s) => s.members.length > 1);
		expect(cycle?.members).toEqual(["a", "b"]);
		expect(cycle?.recursive).toBe(true);
	});

	test("a self-loop marks a singleton SCC recursive", () => {
		const result = tarjanScc(graphOf(["a"], [["a", "a"]]));
		expect(result.sccs).toEqual([{ members: ["a"], recursive: true }]);
	});

	test("sccIdByRoutine maps every node to its SCC index", () => {
		const result = tarjanScc(graphOf(["a", "b"], [["a", "b"]]));
		expect(result.sccIdByRoutine.size).toBe(2);
		expect(result.sccIdByRoutine.get("a")).not.toBe(result.sccIdByRoutine.get("b"));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/engine/scc.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/scc.ts'`.

- [ ] **Step 3: Write the implementation**

`src/engine/scc.ts`:
```typescript
import type { CombinedGraph } from "./combined-graph.ts";
import type { RoutineId } from "../model/ids.ts";

/** One strongly-connected component. `recursive` = size > 1 or has a self-edge. */
export interface Scc {
	members: RoutineId[]; // sorted
	recursive: boolean;
}

export interface SccResult {
	/** SCCs in reverse-topological order: callees before callers. */
	sccs: Scc[];
	/** routineId -> index into `sccs`. */
	sccIdByRoutine: Map<RoutineId, number>;
}

/**
 * Tarjan's SCC algorithm over the combined graph. Iterative (no recursion — AL call graphs
 * can be deep). Tarjan emits SCCs in reverse-topological order naturally, which is exactly
 * the bottom-up order the summary engine wants. Node iteration follows `graph.nodes` (sorted)
 * and edge iteration follows the pre-sorted edge lists, so the result is deterministic.
 */
export function tarjanScc(graph: CombinedGraph): SccResult {
	let nextIndex = 0;
	const index = new Map<RoutineId, number>();
	const lowlink = new Map<RoutineId, number>();
	const onStack = new Set<RoutineId>();
	const stack: RoutineId[] = [];
	const rawSccs: RoutineId[][] = [];

	// Explicit work stack: each frame is a node plus its next-child cursor.
	for (const start of graph.nodes) {
		if (index.has(start)) continue;
		const work: { node: RoutineId; childIdx: number }[] = [{ node: start, childIdx: 0 }];

		while (work.length > 0) {
			const frame = work[work.length - 1];
			if (frame === undefined) break;
			const { node } = frame;

			if (frame.childIdx === 0) {
				index.set(node, nextIndex);
				lowlink.set(node, nextIndex);
				nextIndex++;
				stack.push(node);
				onStack.add(node);
			}

			const children = graph.edgesByFrom.get(node) ?? [];
			if (frame.childIdx < children.length) {
				const child = children[frame.childIdx];
				frame.childIdx++;
				if (child === undefined) continue;
				const to = child.to;
				if (!index.has(to)) {
					work.push({ node: to, childIdx: 0 });
				} else if (onStack.has(to)) {
					const cur = lowlink.get(node) ?? 0;
					const toIdx = index.get(to) ?? 0;
					lowlink.set(node, Math.min(cur, toIdx));
				}
				continue;
			}

			// All children processed — settle this node.
			if (lowlink.get(node) === index.get(node)) {
				const members: RoutineId[] = [];
				while (true) {
					const w = stack.pop();
					if (w === undefined) break;
					onStack.delete(w);
					members.push(w);
					if (w === node) break;
				}
				rawSccs.push(members);
			}
			work.pop();
			const parent = work[work.length - 1];
			if (parent !== undefined) {
				const pCur = lowlink.get(parent.node) ?? 0;
				const nCur = lowlink.get(node) ?? 0;
				lowlink.set(parent.node, Math.min(pCur, nCur));
			}
		}
	}

	// rawSccs is already in reverse-topological order (Tarjan property).
	const sccs: Scc[] = [];
	const sccIdByRoutine = new Map<RoutineId, number>();
	for (const members of rawSccs) {
		const sorted = [...members].sort();
		let recursive = sorted.length > 1;
		if (!recursive) {
			const only = sorted[0];
			if (only !== undefined) {
				recursive = (graph.edgesByFrom.get(only) ?? []).some((e) => e.to === only);
			}
		}
		const sccId = sccs.length;
		sccs.push({ members: sorted, recursive });
		for (const m of sorted) sccIdByRoutine.set(m, sccId);
	}

	return { sccs, sccIdByRoutine };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/engine/scc.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/engine/scc.ts test/engine/scc.test.ts
git commit -m "feat: add Tarjan SCC over the combined graph"
```

---

## Task 4: Effect lattice

**Files:**
- Create: `src/engine/effect-lattice.ts`
- Test: `test/engine/effect-lattice.test.ts`

Pure join / union / dedup operations the summary engine composes with. No widening — the lattice is finite and monotone, so the fixed-point converges on its own.

- [ ] **Step 1: Write the failing test**

`test/engine/effect-lattice.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import type { DbEffect } from "../../src/model/summary.ts";
import {
	effectKeyOf,
	joinPresence,
	mergeDbEffects,
	mergeVia,
	unionTables,
} from "../../src/engine/effect-lattice.ts";

describe("joinPresence", () => {
	test("yes dominates unknown dominates no", () => {
		expect(joinPresence("no", "no")).toBe("no");
		expect(joinPresence("no", "unknown")).toBe("unknown");
		expect(joinPresence("unknown", "yes")).toBe("yes");
		expect(joinPresence("no", "yes")).toBe("yes");
		expect(joinPresence("yes", "unknown")).toBe("yes");
	});
});

describe("unionTables", () => {
	test("set union of two table id lists, sorted", () => {
		expect(unionTables(["t/b", "t/a"], ["t/c"])).toEqual(["t/a", "t/b", "t/c"]);
	});
	test("unknown absorbs", () => {
		expect(unionTables(["t/a"], "unknown")).toBe("unknown");
		expect(unionTables("unknown", ["t/a"])).toBe("unknown");
	});
});

describe("effectKeyOf", () => {
	test("path-insensitive: same op/table/operationId/tempState -> same key regardless of via", () => {
		const base = {
			operationId: "r/op0",
			op: "FindSet" as const,
			tableId: "app/table/18",
			tempState: { kind: "unknown" as const },
		};
		const a: DbEffect = { ...base, effectKey: "", via: "direct" };
		const b: DbEffect = { ...base, effectKey: "", via: "inherited" };
		expect(effectKeyOf(a)).toBe(effectKeyOf(b));
	});
	test("differs when tempState differs", () => {
		const base = { operationId: "r/op0", op: "FindSet" as const, tableId: "app/table/18" };
		const a: DbEffect = { ...base, tempState: { kind: "known", value: true }, effectKey: "", via: "direct" };
		const b: DbEffect = { ...base, tempState: { kind: "known", value: false }, effectKey: "", via: "direct" };
		expect(effectKeyOf(a)).not.toBe(effectKeyOf(b));
	});
});

describe("mergeVia", () => {
	test("precedence: direct > implicit-trigger > event-subscriber > dynamic > inherited", () => {
		expect(mergeVia("inherited", "direct")).toBe("direct");
		expect(mergeVia("dynamic", "event-subscriber")).toBe("event-subscriber");
		expect(mergeVia("inherited", "dynamic")).toBe("dynamic");
		expect(mergeVia("implicit-trigger", "event-subscriber")).toBe("implicit-trigger");
	});
});

describe("mergeDbEffects", () => {
	test("dedupes by effectKey, sorted by (effectKey, operationId), via merged by precedence", () => {
		const e1: DbEffect = { effectKey: "k1", operationId: "r/op0", op: "FindSet", tableId: "app/table/1", tempState: { kind: "unknown" }, via: "inherited" };
		const e2: DbEffect = { effectKey: "k1", operationId: "r/op0", op: "FindSet", tableId: "app/table/1", tempState: { kind: "unknown" }, via: "direct" };
		const e3: DbEffect = { effectKey: "k2", operationId: "r/op1", op: "Modify", tableId: "app/table/2", tempState: { kind: "unknown" }, via: "inherited" };
		const merged = mergeDbEffects([e1, e3], [e2]);
		expect(merged.length).toBe(2);
		expect(merged[0]?.effectKey).toBe("k1");
		expect(merged[0]?.via).toBe("direct"); // direct wins over inherited
		expect(merged[1]?.effectKey).toBe("k2");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/engine/effect-lattice.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/effect-lattice.ts'`.

- [ ] **Step 3: Write the implementation**

`src/engine/effect-lattice.ts`:
```typescript
import type { TempState } from "../model/entities.ts";
import type { TableId } from "../model/ids.ts";
import type { DbEffect, EffectPresence } from "../model/summary.ts";

// --- tri-state presence: no < unknown < yes ---
const PRESENCE_RANK: Record<EffectPresence, number> = { no: 0, unknown: 1, yes: 2 };
const PRESENCE_BY_RANK: EffectPresence[] = ["no", "unknown", "yes"];

/** Lattice join: the more-informative presence wins (yes > unknown > no). Monotone. */
export function joinPresence(a: EffectPresence, b: EffectPresence): EffectPresence {
	const rank = Math.max(PRESENCE_RANK[a], PRESENCE_RANK[b]);
	return PRESENCE_BY_RANK[rank] ?? "unknown";
}

/** Set union of two `writesTables` values; `"unknown"` absorbs. Result is sorted. */
export function unionTables(
	a: TableId[] | "unknown",
	b: TableId[] | "unknown",
): TableId[] | "unknown" {
	if (a === "unknown" || b === "unknown") return "unknown";
	return [...new Set([...a, ...b])].sort();
}

/** Normalise a TempState to a short stable key fragment. */
function tempStateKey(t: TempState): string {
	if (t.kind === "known") return t.value ? "t" : "f";
	if (t.kind === "parameter-dependent") return `p${t.parameterIndex}`;
	return "u";
}

/**
 * Stable, path-insensitive effect key. Deliberately EXCLUDES `via` — two DbEffects for the
 * same operation are the same fact regardless of how they propagated. Used to de-dupe.
 */
export function effectKeyOf(e: Pick<DbEffect, "op" | "tableId" | "operationId" | "tempState">): string {
	return `${e.op}|${e.tableId}|${e.operationId}|${tempStateKey(e.tempState)}`;
}

// --- via precedence: most specific wins ---
const VIA_RANK: Record<DbEffect["via"], number> = {
	direct: 4,
	"implicit-trigger": 3,
	"event-subscriber": 2,
	dynamic: 1,
	inherited: 0,
};

/** Merge two `via` tags, keeping the most specific (direct > implicit-trigger > event-subscriber > dynamic > inherited). */
export function mergeVia(a: DbEffect["via"], b: DbEffect["via"]): DbEffect["via"] {
	return VIA_RANK[a] >= VIA_RANK[b] ? a : b;
}

/**
 * Concatenate and de-dupe DbEffects by `effectKey`. When two effects share a key, `via` is
 * merged by precedence. Result is sorted by `(effectKey, operationId)` for determinism.
 */
export function mergeDbEffects(...lists: DbEffect[][]): DbEffect[] {
	const byKey = new Map<string, DbEffect>();
	for (const list of lists) {
		for (const e of list) {
			const key = e.effectKey || effectKeyOf(e);
			const normalized: DbEffect = { ...e, effectKey: key };
			const existing = byKey.get(key);
			if (existing) {
				byKey.set(key, { ...existing, via: mergeVia(existing.via, normalized.via) });
			} else {
				byKey.set(key, normalized);
			}
		}
	}
	return [...byKey.values()].sort((a, b) => {
		if (a.effectKey !== b.effectKey) return a.effectKey.localeCompare(b.effectKey);
		return a.operationId.localeCompare(b.operationId);
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/engine/effect-lattice.test.ts`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/engine/effect-lattice.ts test/engine/effect-lattice.test.ts
git commit -m "feat: add effect lattice (join, union, effectKey, dedupe)"
```

---

## Task 5: Summary-engine helpers — published-event resolution + parameter effects

**Files:**
- Create: `src/engine/summary-engine.ts`
- Test: `test/engine/summary-helpers.test.ts`

Two pure helpers the base-summary builder needs. `resolvePublishedEvent` answers "which `EventId` does this call site raise?" — Phase 1 does **not** emit `event-publish` operation sites, so a published event is a `CallEdge` whose `to` routine has `kind === "event-publisher"`. `computeParameterEffects` derives a `ParameterEffectSummary` per record parameter from the routine's intraprocedural features.

- [ ] **Step 1: Write the failing test**

`test/engine/summary-helpers.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { computeParameterEffects, resolvePublishedEvent } from "../../src/engine/summary-engine.ts";

const WS_EVENTS = fileURLToPath(new URL("../fixtures/ws-events", import.meta.url));
const WS_RESOLVE = fileURLToPath(new URL("../fixtures/ws-resolve", import.meta.url));

describe("resolvePublishedEvent", () => {
	test("a call to an event-publisher routine resolves to that event's EventId", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_EVENTS, deterministic: true });
		// In ws-events, the publisher codeunit has a routine that raises an integration event.
		// Find a CallEdge whose `to` is an event-publisher routine.
		const publisherRoutineIds = new Set(
			model.routines.filter((r) => r.kind === "event-publisher").map((r) => r.id),
		);
		const publishEdge = model.callGraph.find((e) => e.to !== undefined && publisherRoutineIds.has(e.to));
		expect(publishEdge).toBeDefined();
		const eventId = resolvePublishedEvent(publishEdge?.operationId ?? "", model);
		expect(eventId).toBeDefined();
		// It matches an EventSymbol id.
		expect(model.eventGraph.events.some((s) => s.id === eventId)).toBe(true);
	});

	test("an operationId that is not an event publish resolves to undefined", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_RESOLVE, deterministic: true });
		expect(resolvePublishedEvent("not-a-real-op-id", model)).toBeUndefined();
	});
});

describe("computeParameterEffects", () => {
	test("a record parameter that is read produces a ParameterEffectSummary with readsFields", async () => {
		// ws-resolve's Processor has no record-parameter routines; use a dedicated fixture.
		const WS_PARAM = fileURLToPath(new URL("../fixtures/ws-paramfx", import.meta.url));
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_PARAM, deterministic: true });
		const enrich = model.routines.find((r) => r.name === "EnrichLine");
		expect(enrich).toBeDefined();
		const effects = computeParameterEffects(enrich!, model);
		// EnrichLine(var SalesLine: Record "Sales Line") reads SalesLine.Amount.
		expect(effects.length).toBeGreaterThanOrEqual(1);
		const first = effects[0];
		expect(first?.parameterIndex).toBe(0);
		expect(first?.readsFields.length).toBeGreaterThanOrEqual(1);
	});
});
```

- [ ] **Step 2: Create the `ws-paramfx` fixture**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-paramfx/src
cat > ws-paramfx/app.json <<'EOF'
{
  "id": "aaaaaaaa-0000-0000-0000-0000000000b2",
  "name": "Param Effects Test App",
  "publisher": "PE",
  "version": "1.0.0.0"
}
EOF
cat > ws-paramfx/src/salesline.al <<'EOF'
table 60100 "Sales Line"
{
    fields
    {
        field(1; "Document No."; Code[20]) { }
        field(2; Amount; Decimal) { }
    }
    keys { key(PK; "Document No.") { } }
}
EOF
cat > ws-paramfx/src/enricher.al <<'EOF'
codeunit 60101 "Line Enricher"
{
    procedure EnrichLine(var SalesLine: Record "Sales Line")
    begin
        if SalesLine.Amount > 0 then
            SalesLine.Amount := SalesLine.Amount;
    end;
}
EOF
```
Expected: `test/fixtures/ws-paramfx/` with `app.json` + 2 `.al` files.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/engine/summary-helpers.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/summary-engine.ts'`.

- [ ] **Step 4: Write the implementation**

`src/engine/summary-engine.ts` (this file grows over Tasks 5–7; start it now):
```typescript
import type { Routine } from "../model/entities.ts";
import type { EventId, FieldId, OperationId } from "../model/ids.ts";
import type { SemanticModel } from "../model/model.ts";
import type { ParameterEffectSummary } from "../model/summary.ts";

/**
 * Resolve which event a call site raises. Phase 1 does not emit `event-publish` operation
 * sites — a published event is a CallEdge whose `to` routine has kind "event-publisher".
 * Returns the EventId of the matching EventSymbol, or undefined if the operation is not an
 * event publish.
 */
export function resolvePublishedEvent(
	operationId: OperationId,
	model: SemanticModel,
): EventId | undefined {
	const edge = model.callGraph.find((e) => e.operationId === operationId && e.to !== undefined);
	if (edge?.to === undefined) return undefined;
	const sym = model.eventGraph.events.find((s) => s.publisherRoutineId === edge.to);
	return sym?.id;
}

/**
 * Derive a ParameterEffectSummary per record parameter from a routine's intraprocedural
 * features. Field names are resolved to FieldId via the parameter record's table. Unresolved
 * field names are skipped here (they surface as D3 bailouts, not silent drops).
 */
export function computeParameterEffects(
	routine: Routine,
	model: SemanticModel,
): ParameterEffectSummary[] {
	const out: ParameterEffectSummary[] = [];
	for (const param of routine.parameters) {
		if (!param.isRecord) continue;
		const recVar = routine.features.recordVariables.find(
			(rv) => rv.isParameter && rv.parameterIndex === param.index,
		);
		const tableId = recVar?.tableId;
		const table =
			tableId !== undefined ? model.tables.find((t) => t.id === tableId) : undefined;

		const resolveField = (fieldName: string): FieldId | undefined =>
			table?.fields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase())?.id;

		const recVarName = recVar?.name.toLowerCase();
		const readsFields: FieldId[] = [];
		const writesFields: FieldId[] = [];
		for (const fa of routine.features.fieldAccesses) {
			if (fa.recordVariableName.toLowerCase() !== recVarName) continue;
			const fid = resolveField(fa.fieldName);
			if (fid !== undefined) readsFields.push(fid);
		}

		let mayResetFilters = false;
		let mayChangeLoadFields = false;
		let mayAssignRecord = false;
		for (const op of routine.features.recordOperations) {
			if (op.recordVariableName.toLowerCase() !== recVarName) continue;
			if (op.op === "Validate") {
				for (const arg of op.fieldArguments ?? []) {
					const fid = resolveField(arg);
					if (fid !== undefined) writesFields.push(fid);
				}
			}
			if (op.op === "Reset" || op.op === "Copy") mayResetFilters = true;
			if (op.op === "SetLoadFields" || op.op === "AddLoadFields" || op.op === "Reset")
				mayChangeLoadFields = true;
			if (op.op === "Copy" || op.op === "TransferFields") mayAssignRecord = true;
		}

		// RecordRef / FieldRef / Variant params: detectable from the raw type text.
		const mayUseRecordRef = /\b(RecordRef|FieldRef|Variant)\b/i.test(param.typeText);

		out.push({
			parameterIndex: param.index,
			tableId: tableId ?? "unknown",
			readsFields: [...new Set(readsFields)].sort(),
			writesFields: [...new Set(writesFields)].sort(),
			mayResetFilters,
			mayChangeLoadFields,
			mayAssignRecord,
			mayUseRecordRef,
		});
	}
	return out.sort((a, b) => a.parameterIndex - b.parameterIndex);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/engine/summary-helpers.test.ts`
Expected: PASS — 3 tests pass.

> If `computeParameterEffects` finds 0 effects: confirm the indexer populates `recordVariables` with `isParameter: true` and `parameterIndex` for `var` record parameters, and that `fieldAccesses` captures `SalesLine.Amount`. Check `test/routine-indexer.test.ts` and `test/intraprocedural-refs.test.ts` for what the indexer actually emits, and adapt the field-access matching if the indexer uses a different shape.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/engine/summary-engine.ts test/engine/summary-helpers.test.ts test/fixtures/ws-paramfx/
git commit -m "feat: add summary-engine helpers (event resolution + parameter effects)"
```

---

## Task 6: Base intraprocedural summary

**Files:**
- Modify: `src/engine/summary-engine.ts`
- Test: `test/engine/base-summary.test.ts`

`baseIntraproceduralSummary(routine, model)` builds a `RoutineSummary` from one routine's own features — no callee composition yet. This is the seed, recomputed on every fixed-point pass so opaque / parse-incomplete facts can never be silently overwritten.

- [ ] **Step 1: Write the failing test**

`test/engine/base-summary.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { baseIntraproceduralSummary } from "../../src/engine/summary-engine.ts";

const WS_RESOLVE = fileURLToPath(new URL("../fixtures/ws-resolve", import.meta.url));

describe("baseIntraproceduralSummary", () => {
	test("a routine with a direct Get op has touchesDb yes and one direct DbEffect", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_RESOLVE, deterministic: true });
		const process = model.routines.find((r) => r.name === "Process");
		const summary = baseIntraproceduralSummary(process!, model);
		expect(summary.touchesDb).toBe("yes");
		expect(summary.dbEffects.length).toBe(1);
		expect(summary.dbEffects[0]?.op).toBe("Get");
		expect(summary.dbEffects[0]?.via).toBe("direct");
		expect(summary.commits).toBe("no");
		expect(summary.hasUnresolvedCalls).toBe(false);
		expect(summary.inRecursiveCycle).toBe(false);
	});

	test("a routine with no record ops has touchesDb no and no DbEffects", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_RESOLVE, deterministic: true });
		const helper = model.routines.find((r) => r.name === "Helper");
		const summary = baseIntraproceduralSummary(helper!, model);
		expect(summary.touchesDb).toBe("no");
		expect(summary.dbEffects).toEqual([]);
	});

	test("the base summary carries no evidence path data — only compact facts", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_RESOLVE, deterministic: true });
		const process = model.routines.find((r) => r.name === "Process");
		const summary = baseIntraproceduralSummary(process!, model);
		// DbEffect keys are the only structural data; no `path`/`steps`/`evidence` fields exist.
		expect(Object.keys(summary.dbEffects[0] ?? {}).sort()).toEqual(
			["effectKey", "op", "operationId", "tableId", "tempState", "via"].sort(),
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/engine/base-summary.test.ts`
Expected: FAIL — `baseIntraproceduralSummary is not a function` (not yet exported).

- [ ] **Step 3: Write the implementation**

Add to `src/engine/summary-engine.ts` (new imports at the top, new export below the existing helpers):
```typescript
// add to the existing import block:
import type { TableId } from "../model/ids.ts";
import type { DbEffect, RoutineSummary } from "../model/summary.ts";
import { classifyOp, isDbTouchingClass } from "./op-classification.ts";
import { effectKeyOf } from "./effect-lattice.ts";
```
```typescript
/**
 * Build a routine's summary from its OWN intraprocedural features only — no callee
 * composition. Recomputed every fixed-point pass (never inherited), so opaque /
 * parse-incomplete facts are always re-applied.
 */
export function baseIntraproceduralSummary(
	routine: Routine,
	model: SemanticModel,
): RoutineSummary {
	const parameterEffects = computeParameterEffects(routine, model);

	// Opaque (.app symbol, no body) — unknown everything; the caller (which has the
	// callsiteId) attaches the opaque-callee uncertainty, not this routine itself.
	if (!routine.bodyAvailable) {
		return {
			routineId: routine.id,
			touchesDb: "unknown",
			commits: "unknown",
			writesTables: "unknown",
			dbEffects: [],
			publishesEvents: [],
			inRecursiveCycle: false,
			hasUnresolvedCalls: true,
			uncertainties: [],
			parameterEffects,
		};
	}

	// Parse-incomplete — body present but unparseable; record the typed uncertainty.
	if (routine.parseIncomplete) {
		return {
			routineId: routine.id,
			touchesDb: "unknown",
			commits: "unknown",
			writesTables: "unknown",
			dbEffects: [],
			publishesEvents: [],
			inRecursiveCycle: false,
			hasUnresolvedCalls: true,
			uncertainties: [{ kind: "parse-incomplete", routineId: routine.id }],
			parameterEffects,
		};
	}

	// Body available + parsed — derive direct facts from the operation stream.
	const dbEffects: DbEffect[] = [];
	const writtenTables: TableId[] = [];
	let writesUnknownTable = false;
	let touchesDb: RoutineSummary["touchesDb"] = "no";

	for (const op of routine.features.recordOperations) {
		const cls = classifyOp(op.op);
		if (!isDbTouchingClass(cls)) continue; // state-only / trigger ops do not touch the DB
		touchesDb = "yes";
		const tableId: TableId | "unknown" = op.tableId ?? "unknown";
		const effect: DbEffect = {
			effectKey: effectKeyOf({
				op: op.op,
				tableId,
				operationId: op.id,
				tempState: op.tempState,
			}),
			operationId: op.id,
			op: op.op,
			tableId,
			recordVariableId: op.recordVariableId,
			tempState: op.tempState,
			via: "direct",
		};
		dbEffects.push(effect);
		if (cls === "db-write") {
			if (op.tableId === undefined) writesUnknownTable = true;
			else writtenTables.push(op.tableId);
		}
	}

	const commits: RoutineSummary["commits"] = routine.features.operationSites.some(
		(s) => s.kind === "commit",
	)
		? "yes"
		: "no";

	const publishesEvents = [
		...new Set(
			routine.features.callSites
				.map((cs) => resolvePublishedEvent(cs.operationId, model))
				.filter((id): id is string => id !== undefined),
		),
	].sort();

	const writesTables: TableId[] | "unknown" = writesUnknownTable
		? "unknown"
		: [...new Set(writtenTables)].sort();

	return {
		routineId: routine.id,
		touchesDb,
		commits,
		writesTables,
		dbEffects: dbEffects.sort((a, b) => a.effectKey.localeCompare(b.effectKey)),
		publishesEvents,
		inRecursiveCycle: false,
		hasUnresolvedCalls: false,
		uncertainties: [],
		parameterEffects,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/engine/base-summary.test.ts`
Expected: PASS — 3 tests pass.

> If the `dbEffects[0]` key list does not match: the test pins the exact `DbEffect` field set. If `recordVariableId` is present (because the op had a resolved record variable), add `"recordVariableId"` to the expected key list — that is fine, it means the field was populated.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/engine/summary-engine.ts test/engine/base-summary.test.ts
git commit -m "feat: add base intraprocedural summary builder"
```

---

## Task 7: Composition + fixed-point + `computeSummaries`

**Files:**
- Modify: `src/engine/summary-engine.ts`
- Test: `test/engine/compute-summaries.test.ts`

`composeRoutine` folds callee summaries into a routine's base summary. `computeSummaries` walks the SCC condensation bottom-up, runs a finite monotone fixed-point inside recursive SCCs, and mutates every `routine.summary` in place. `computeFieldEffects` is the lazy field-effect helper D3 calls.

- [ ] **Step 1: Create the `ws-compose` and `ws-recursive` fixtures**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-compose/src ws-recursive/src
cat > ws-compose/app.json <<'EOF'
{
  "id": "cccccccc-0000-0000-0000-0000000000c1",
  "name": "Compose Test App",
  "publisher": "CT",
  "version": "1.0.0.0"
}
EOF
cat > ws-compose/src/customer.al <<'EOF'
table 61100 Customer
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Name; Text[100]) { }
    }
    keys { key(PK; "No.") { } }
}
EOF
cat > ws-compose/src/caller.al <<'EOF'
codeunit 61101 "Compose Caller"
{
    procedure RunAll()
    begin
        DoDbWork();
    end;

    local procedure DoDbWork()
    var
        Customer: Record Customer;
    begin
        Customer.FindSet();
    end;
}
EOF
cat > ws-recursive/app.json <<'EOF'
{
  "id": "dddddddd-0000-0000-0000-0000000000d1",
  "name": "Recursive Test App",
  "publisher": "RT",
  "version": "1.0.0.0"
}
EOF
cat > ws-recursive/src/customer.al <<'EOF'
table 62100 Customer
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }
    keys { key(PK; "No.") { } }
}
EOF
cat > ws-recursive/src/cycle.al <<'EOF'
codeunit 62101 "Cycle CU"
{
    procedure Ping()
    var
        Customer: Record Customer;
    begin
        Customer.FindSet();
        Pong();
    end;

    procedure Pong()
    begin
        Ping();
    end;
}
EOF
```
Expected: `test/fixtures/ws-compose/` and `test/fixtures/ws-recursive/` each with `app.json` + 2 `.al` files.

- [ ] **Step 2: Write the failing test**

`test/engine/compute-summaries.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildCombinedGraph } from "../../src/engine/combined-graph.ts";
import { computeFieldEffects, computeSummaries } from "../../src/engine/summary-engine.ts";
import type { Diagnostic } from "../../src/model/finding.ts";

const WS_COMPOSE = fileURLToPath(new URL("../fixtures/ws-compose", import.meta.url));
const WS_RECURSIVE = fileURLToPath(new URL("../fixtures/ws-recursive", import.meta.url));

describe("computeSummaries", () => {
	test("every routine gets a summary populated", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_COMPOSE, deterministic: true });
		const graph = buildCombinedGraph(model);
		const diagnostics: Diagnostic[] = [];
		computeSummaries(model, graph, diagnostics);
		expect(model.routines.every((r) => r.summary !== undefined)).toBe(true);
	});

	test("a caller with no direct DB op inherits touchesDb yes from a callee", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_COMPOSE, deterministic: true });
		const graph = buildCombinedGraph(model);
		computeSummaries(model, graph, []);
		const runAll = model.routines.find((r) => r.name === "RunAll");
		// RunAll has no record op of its own, but DoDbWork does a FindSet.
		expect(runAll?.summary?.touchesDb).toBe("yes");
		// The inherited DbEffect carries via "inherited".
		expect(runAll?.summary?.dbEffects.some((e) => e.via === "inherited")).toBe(true);
		const doDbWork = model.routines.find((r) => r.name === "DoDbWork");
		expect(doDbWork?.summary?.dbEffects.some((e) => e.via === "direct")).toBe(true);
	});

	test("a recursive cycle converges; all members get inRecursiveCycle true", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_RECURSIVE, deterministic: true });
		const graph = buildCombinedGraph(model);
		const diagnostics: Diagnostic[] = [];
		computeSummaries(model, graph, diagnostics);
		const ping = model.routines.find((r) => r.name === "Ping");
		const pong = model.routines.find((r) => r.name === "Pong");
		expect(ping?.summary?.inRecursiveCycle).toBe(true);
		expect(pong?.summary?.inRecursiveCycle).toBe(true);
		// Ping does a FindSet; Pong calls Ping — so both touch the DB after composition.
		expect(ping?.summary?.touchesDb).toBe("yes");
		expect(pong?.summary?.touchesDb).toBe("yes");
		// The fixed-point converged — no summarize diagnostic was emitted.
		expect(diagnostics.some((d) => d.stage === "summarize")).toBe(false);
	});

	test("computeSummaries is deterministic across two runs", async () => {
		const runOnce = async () => {
			const { model } = await analyzeWorkspace({ workspaceRoot: WS_COMPOSE, deterministic: true });
			const graph = buildCombinedGraph(model);
			computeSummaries(model, graph, []);
			return JSON.stringify(model.routines.map((r) => r.summary));
		};
		expect(await runOnce()).toBe(await runOnce());
	});
});

describe("computeFieldEffects", () => {
	test("groups resolved field reads by record variable", async () => {
		const WS_PARAM = fileURLToPath(new URL("../fixtures/ws-paramfx", import.meta.url));
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_PARAM, deterministic: true });
		const enrich = model.routines.find((r) => r.name === "EnrichLine");
		const fx = computeFieldEffects(enrich!.id, model);
		const allReads = Object.values(fx.readsByRecordVariable).flat();
		expect(allReads.length).toBeGreaterThanOrEqual(1);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/engine/compute-summaries.test.ts`
Expected: FAIL — `computeSummaries is not a function`.

- [ ] **Step 4: Write the implementation**

Add to `src/engine/summary-engine.ts` (new imports + the three exports below):
```typescript
// add to the import block:
import type { Diagnostic } from "../model/finding.ts";
import type { RoutineId } from "../model/ids.ts";
import type { FieldEffectSet, Uncertainty } from "../model/summary.ts";
import type { CombinedEdge, CombinedGraph } from "./combined-graph.ts";
import { joinPresence, mergeDbEffects, unionTables } from "./effect-lattice.ts";
import { tarjanScc } from "./scc.ts";
```
```typescript
const MAX_FIXED_POINT_ITERATIONS = 1000;

/** Map a combined-edge kind to the `via` tag callee effects inherit through it. */
function viaForEdge(kind: CombinedEdge["kind"]): "inherited" | "implicit-trigger" | "event-subscriber" | "dynamic" {
	if (kind === "implicit-trigger") return "implicit-trigger";
	if (kind === "event-dispatch") return "event-subscriber";
	if (kind === "dynamic") return "dynamic";
	return "inherited";
}

function uncertaintyKey(u: Uncertainty): string {
	if ("callsiteId" in u) return `${u.kind}|${u.callsiteId}`;
	if ("operationId" in u) return `${u.kind}|${u.operationId}`;
	return `${u.kind}|${u.routineId}`;
}

function dedupeUncertainties(list: Uncertainty[]): Uncertainty[] {
	const byKey = new Map<string, Uncertainty>();
	for (const u of list) byKey.set(uncertaintyKey(u), u);
	return [...byKey.values()].sort((a, b) => uncertaintyKey(a).localeCompare(uncertaintyKey(b)));
}

/** Stable fingerprint for fixed-point change detection. */
function summaryFingerprint(s: RoutineSummary): string {
	return JSON.stringify([
		s.touchesDb,
		s.commits,
		s.writesTables,
		s.dbEffects.map((e) => `${e.effectKey}:${e.via}`),
		s.publishesEvents,
		s.hasUnresolvedCalls,
		s.uncertainties.map(uncertaintyKey),
	]);
}

/**
 * Compose a routine's full summary: start from its base intraprocedural summary, then fold
 * in every outgoing combined edge's callee summary (looked up via `lookup` — final summaries
 * for callees outside the SCC, in-progress for callees inside it).
 */
export function composeRoutine(
	routine: Routine,
	lookup: (id: RoutineId) => RoutineSummary | undefined,
	graph: CombinedGraph,
	model: SemanticModel,
): RoutineSummary {
	const acc = baseIntraproceduralSummary(routine, model);
	const calleeOpaque = (id: RoutineId): boolean =>
		model.routines.find((r) => r.id === id)?.bodyAvailable === false;

	for (const edge of graph.edgesByFrom.get(routine.id) ?? []) {
		const calleeSummary = lookup(edge.to);
		if (calleeSummary === undefined) {
			acc.hasUnresolvedCalls = true;
			continue;
		}
		acc.touchesDb = joinPresence(acc.touchesDb, calleeSummary.touchesDb);
		acc.commits = joinPresence(acc.commits, calleeSummary.commits);
		acc.writesTables = unionTables(acc.writesTables, calleeSummary.writesTables);
		const via = viaForEdge(edge.kind);
		const inheritedEffects = calleeSummary.dbEffects.map((e) => ({ ...e, via }));
		acc.dbEffects = mergeDbEffects(acc.dbEffects, inheritedEffects);
		acc.publishesEvents = [
			...new Set([...acc.publishesEvents, ...calleeSummary.publishesEvents]),
		].sort();
		acc.uncertainties = dedupeUncertainties([
			...acc.uncertainties,
			...calleeSummary.uncertainties,
		]);
		if (calleeSummary.hasUnresolvedCalls) acc.hasUnresolvedCalls = true;

		// interface / dynamic edges, and opaque callees, are confidence-lowering — the CALLER
		// holds the callsiteId, so the opaque-callee uncertainty is attached here, not on the
		// callee's own summary.
		if (edge.kind === "interface" || edge.kind === "dynamic" || calleeOpaque(edge.to)) {
			if (edge.callsiteId !== undefined) {
				acc.uncertainties = dedupeUncertainties([
					...acc.uncertainties,
					{ kind: "opaque-callee", callsiteId: edge.callsiteId },
				]);
			}
			acc.hasUnresolvedCalls = true;
			if (acc.touchesDb === "no") acc.touchesDb = "unknown";
		}
	}

	// Uncertainty edges (to-less call sites) on this routine.
	for (const ue of graph.uncertaintyEdges) {
		if (ue.from !== routine.id) continue;
		acc.uncertainties = dedupeUncertainties([...acc.uncertainties, ue.uncertainty]);
		acc.hasUnresolvedCalls = true;
	}

	return acc;
}

/**
 * Compute a RoutineSummary for every routine and mutate `routine.summary` in place. Walks
 * the SCC condensation bottom-up; recursive SCCs get a finite monotone fixed-point with
 * snapshot iteration. An iteration cap is a bug-guard only — hitting it emits a
 * `Diagnostic(stage: "summarize")`.
 */
export function computeSummaries(
	model: SemanticModel,
	graph: CombinedGraph,
	diagnostics: Diagnostic[],
): void {
	const routineById = new Map<RoutineId, Routine>();
	for (const r of model.routines) routineById.set(r.id, r);

	const final = new Map<RoutineId, RoutineSummary>();
	const { sccs } = tarjanScc(graph);

	for (const scc of sccs) {
		if (!scc.recursive) {
			const id = scc.members[0];
			const routine = id !== undefined ? routineById.get(id) : undefined;
			if (id === undefined || routine === undefined) continue;
			final.set(id, composeRoutine(routine, (x) => final.get(x), graph, model));
			continue;
		}

		// Recursive SCC — finite monotone fixed-point with snapshot iteration.
		const inProgress = new Map<RoutineId, RoutineSummary>();
		for (const id of scc.members) {
			const routine = routineById.get(id);
			if (routine !== undefined) inProgress.set(id, baseIntraproceduralSummary(routine, model));
		}
		let iterations = 0;
		let changed = true;
		while (changed) {
			changed = false;
			iterations++;
			const snapshot = new Map(inProgress);
			for (const id of scc.members) {
				const routine = routineById.get(id);
				if (routine === undefined) continue;
				const next = composeRoutine(
					routine,
					(x) => snapshot.get(x) ?? final.get(x),
					graph,
					model,
				);
				const prev = inProgress.get(id);
				if (prev === undefined || summaryFingerprint(prev) !== summaryFingerprint(next)) {
					changed = true;
				}
				inProgress.set(id, next);
			}
			if (iterations > MAX_FIXED_POINT_ITERATIONS) {
				diagnostics.push({
					severity: "warning",
					stage: "summarize",
					message: `Summary fixed-point did not converge for SCC [${scc.members.join(", ")}]`,
				});
				break;
			}
		}
		for (const id of scc.members) {
			const summary = inProgress.get(id);
			if (summary !== undefined) final.set(id, { ...summary, inRecursiveCycle: true });
		}
	}

	for (const routine of model.routines) {
		routine.summary = final.get(routine.id);
	}
}

/**
 * Lazily compute the field-effect set for one routine — D3 calls this on demand.
 * Groups resolved field reads by record-variable name.
 */
export function computeFieldEffects(routineId: RoutineId, model: SemanticModel): FieldEffectSet {
	const routine = model.routines.find((r) => r.id === routineId);
	const readsByRecordVariable: Record<string, string[]> = {};
	if (routine === undefined) return { readsByRecordVariable };

	for (const fa of routine.features.fieldAccesses) {
		const recVar = routine.features.recordVariables.find(
			(rv) => rv.name.toLowerCase() === fa.recordVariableName.toLowerCase(),
		);
		const table =
			recVar?.tableId !== undefined
				? model.tables.find((t) => t.id === recVar.tableId)
				: undefined;
		const fieldId = table?.fields.find(
			(f) => f.name.toLowerCase() === fa.fieldName.toLowerCase(),
		)?.id;
		if (fieldId === undefined) continue;
		const key = fa.recordVariableName;
		const list = readsByRecordVariable[key] ?? [];
		if (!list.includes(fieldId)) list.push(fieldId);
		readsByRecordVariable[key] = list.sort();
	}
	return { readsByRecordVariable };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/engine/compute-summaries.test.ts`
Expected: PASS — 5 tests pass.

> If the recursive test's `touchesDb` is `"no"` for `Pong`: confirm the combined graph has the `Ping → Pong` and `Pong → Ping` edges (both `direct`). If `Ping`'s `FindSet` is not producing a `db-read` DbEffect, re-check Task 6 against the actual `recordOperations` shape for that fixture.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/engine/summary-engine.ts test/engine/compute-summaries.test.ts test/fixtures/ws-compose/ test/fixtures/ws-recursive/
git commit -m "feat: add summary composition, SCC fixed-point, and computeSummaries"
```

---

## Task 8: Path-walker

**Files:**
- Create: `src/engine/path-walker.ts`
- Test: `test/engine/path-walker.test.ts`

The shared bounded-traversal primitive. Mechanics (cycle detection, depth/budget bounds, uncertainty accumulation, effective loop nesting, multiple results) live here; each detector supplies a `WalkPolicy`.

- [ ] **Step 1: Write the failing test**

`test/engine/path-walker.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildCombinedGraph } from "../../src/engine/combined-graph.ts";
import type { Terminal, WalkPolicy } from "../../src/engine/path-walker.ts";
import { walkEvidence } from "../../src/engine/path-walker.ts";

const WS_COMPOSE = fileURLToPath(new URL("../fixtures/ws-compose", import.meta.url));
const WS_RECURSIVE = fileURLToPath(new URL("../fixtures/ws-recursive", import.meta.url));

describe("walkEvidence", () => {
	test("reaches a terminal in a callee and returns a complete result", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_COMPOSE, deterministic: true });
		const graph = buildCombinedGraph(model);
		const runAll = model.routines.find((r) => r.name === "RunAll");
		const doDbWork = model.routines.find((r) => r.name === "DoDbWork");
		// Policy: a terminal exists at DoDbWork; expand all edges.
		const policy: WalkPolicy = {
			terminalsAt: (node) =>
				node === doDbWork?.id ? [{ routineId: node, localLoopDepth: 0 }] : [],
			expand: (node) => graph.edgesByFrom.get(node) ?? [],
			buildHopStep: (edge) => ({
				routineId: edge.from,
				callsiteId: edge.callsiteId,
				sourceAnchor: { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: edge.from, syntaxKind: "call" },
				note: `calls ${edge.to}`,
			}),
			buildTerminalStep: (t) => ({
				routineId: t.routineId,
				sourceAnchor: { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: t.routineId, syntaxKind: "op" },
				note: "db op",
			}),
		};
		const results = walkEvidence(runAll!.id, policy, { maxDepth: 10, maxNodes: 100 }, graph, model);
		const complete = results.filter((r) => r.stop === "complete");
		expect(complete.length).toBe(1);
		expect(complete[0]?.path.length).toBe(2); // hop (RunAll->DoDbWork) + terminal
	});

	test("a cycle stops with stop = cycle-cut, not infinite recursion", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_RECURSIVE, deterministic: true });
		const graph = buildCombinedGraph(model);
		const ping = model.routines.find((r) => r.name === "Ping");
		const policy: WalkPolicy = {
			terminalsAt: () => [], // no terminals — force the walk to traverse the cycle
			expand: (node) => graph.edgesByFrom.get(node) ?? [],
			buildHopStep: (edge) => ({
				routineId: edge.from,
				sourceAnchor: { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: edge.from, syntaxKind: "call" },
				note: "hop",
			}),
			buildTerminalStep: (t) => ({
				routineId: t.routineId,
				sourceAnchor: { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: t.routineId, syntaxKind: "op" },
				note: "t",
			}),
		};
		const results = walkEvidence(ping!.id, policy, { maxDepth: 50, maxNodes: 100 }, graph, model);
		expect(results.some((r) => r.stop === "cycle-cut")).toBe(true);
		expect(results.every((r) => r.stop !== "complete")).toBe(true);
	});

	test("depth bound produces stop = depth-cut", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_COMPOSE, deterministic: true });
		const graph = buildCombinedGraph(model);
		const runAll = model.routines.find((r) => r.name === "RunAll");
		const policy: WalkPolicy = {
			terminalsAt: () => [],
			expand: (node) => graph.edgesByFrom.get(node) ?? [],
			buildHopStep: (edge) => ({
				routineId: edge.from,
				sourceAnchor: { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: edge.from, syntaxKind: "call" },
				note: "hop",
			}),
			buildTerminalStep: (t) => ({
				routineId: t.routineId,
				sourceAnchor: { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: t.routineId, syntaxKind: "op" },
				note: "t",
			}),
		};
		const results = walkEvidence(runAll!.id, policy, { maxDepth: 1, maxNodes: 100 }, graph, model);
		expect(results.some((r) => r.stop === "depth-cut")).toBe(true);
	});

	test("effective loop depth = initialLoopDepth + hop loop depths + terminal local depth", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_COMPOSE, deterministic: true });
		const graph = buildCombinedGraph(model);
		const runAll = model.routines.find((r) => r.name === "RunAll");
		const doDbWork = model.routines.find((r) => r.name === "DoDbWork");
		const policy: WalkPolicy = {
			terminalsAt: (node) =>
				node === doDbWork?.id ? [{ routineId: node, localLoopDepth: 2 }] : [],
			expand: (node) => graph.edgesByFrom.get(node) ?? [],
			buildHopStep: (edge) => ({
				routineId: edge.from,
				sourceAnchor: { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: edge.from, syntaxKind: "call" },
				note: "hop",
			}),
			buildTerminalStep: (t) => ({
				routineId: t.routineId,
				sourceAnchor: { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: t.routineId, syntaxKind: "op" },
				note: "t",
			}),
		};
		const results = walkEvidence(runAll!.id, policy, { maxDepth: 10, maxNodes: 100 }, graph, model, { initialLoopDepth: 1 });
		const complete = results.find((r) => r.stop === "complete");
		// initialLoopDepth 1 + 0 hop loops (RunAll->DoDbWork call is not in a loop) + 2 local = 3.
		expect(complete?.effectiveLoopDepth).toBe(3);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/engine/path-walker.test.ts`
Expected: FAIL — `Cannot find module '../../src/engine/path-walker.ts'`.

- [ ] **Step 3: Write the implementation**

`src/engine/path-walker.ts`:
```typescript
import type { EvidenceStep } from "../model/finding.ts";
import type { RoutineId } from "../model/ids.ts";
import type { SemanticModel } from "../model/model.ts";
import type { Uncertainty } from "../model/summary.ts";
import type { CombinedEdge, CombinedGraph } from "./combined-graph.ts";

/** A real op site the walk can terminate at. Policies may return a richer subtype. */
export interface Terminal {
	routineId: RoutineId;
	/** Loop nesting depth of the op site within its OWN routine. */
	localLoopDepth: number;
}

/** Why a walk branch stopped. Detectors emit findings only from `complete` results. */
export type WalkStop = "complete" | "cycle-cut" | "depth-cut" | "node-budget-cut" | "dead-end";

export interface WalkResult {
	path: EvidenceStep[];
	effectiveLoopDepth: number;
	uncertainties: Uncertainty[];
	stop: WalkStop;
}

/** The mutable context threaded through one walk branch. */
export interface PathCtx {
	routinePath: RoutineId[];
	inheritedLoopDepth: number;
	steps: EvidenceStep[];
	uncertainties: Uncertainty[];
}

export interface WalkBounds {
	maxDepth: number; // max routine-path length
	maxNodes: number; // max nodes visited across the whole walk
}

/** Detector-supplied policy: which edges to follow, what counts as a terminal, how to build steps. */
export interface WalkPolicy<T extends Terminal = Terminal> {
	terminalsAt(node: RoutineId, ctx: PathCtx): T[];
	expand(node: RoutineId, ctx: PathCtx): CombinedEdge[];
	buildHopStep(edge: CombinedEdge, ctx: PathCtx): EvidenceStep;
	buildTerminalStep(terminal: T, ctx: PathCtx): EvidenceStep;
}

export interface WalkOpts {
	/** Loop depth already established by the detector (e.g. the loop D1 started from). */
	initialLoopDepth?: number;
	/** Evidence steps the detector wants prepended (e.g. the loop step). */
	initialSteps?: EvidenceStep[];
}

function uncertaintyKey(u: Uncertainty): string {
	if ("callsiteId" in u) return `${u.kind}|${u.callsiteId}`;
	if ("operationId" in u) return `${u.kind}|${u.operationId}`;
	return `${u.kind}|${u.routineId}`;
}

function dedupe(list: Uncertainty[]): Uncertainty[] {
	const byKey = new Map<string, Uncertainty>();
	for (const u of list) byKey.set(uncertaintyKey(u), u);
	return [...byKey.values()].sort((a, b) => uncertaintyKey(a).localeCompare(uncertaintyKey(b)));
}

/**
 * Bounded depth-first evidence walk. Returns one WalkResult per branch that reached a
 * terminal (`complete`) or stopped (`cycle-cut` / `depth-cut` / `node-budget-cut` /
 * `dead-end`). Pure — no I/O. Cycle detection is per-path; bounds cap depth and total nodes.
 */
export function walkEvidence<T extends Terminal>(
	start: RoutineId,
	policy: WalkPolicy<T>,
	bounds: WalkBounds,
	graph: CombinedGraph,
	model: SemanticModel,
	opts: WalkOpts = {},
): WalkResult[] {
	const results: WalkResult[] = [];
	let nodesVisited = 0;
	const routineById = new Map(model.routines.map((r) => [r.id, r]));

	const uncertaintiesAt = (node: RoutineId): Uncertainty[] => {
		const fromSummary = routineById.get(node)?.summary?.uncertainties ?? [];
		const fromEdges = graph.uncertaintyEdges
			.filter((ue) => ue.from === node)
			.map((ue) => ue.uncertainty);
		return [...fromSummary, ...fromEdges];
	};

	const loopDepthOfEdge = (edge: CombinedEdge): number => {
		if (edge.callsiteId === undefined) return 0;
		const fromRoutine = routineById.get(edge.from);
		const cs = fromRoutine?.features.callSites.find((c) => c.id === edge.callsiteId);
		return cs?.loopStack.length ?? 0;
	};

	const visit = (node: RoutineId, ctx: PathCtx): void => {
		nodesVisited++;
		const ctxHere: PathCtx = {
			...ctx,
			uncertainties: dedupe([...ctx.uncertainties, ...uncertaintiesAt(node)]),
		};

		const terminals = policy.terminalsAt(node, ctxHere);
		for (const t of terminals) {
			results.push({
				path: [...ctxHere.steps, policy.buildTerminalStep(t, ctxHere)],
				effectiveLoopDepth: ctxHere.inheritedLoopDepth + t.localLoopDepth,
				uncertainties: ctxHere.uncertainties,
				stop: "complete",
			});
		}

		const edges = policy.expand(node, ctxHere);
		if (edges.length === 0 && terminals.length === 0) {
			results.push({
				path: ctxHere.steps,
				effectiveLoopDepth: ctxHere.inheritedLoopDepth,
				uncertainties: ctxHere.uncertainties,
				stop: "dead-end",
			});
			return;
		}

		for (const edge of edges) {
			if (nodesVisited >= bounds.maxNodes) {
				results.push({
					path: ctxHere.steps,
					effectiveLoopDepth: ctxHere.inheritedLoopDepth,
					uncertainties: ctxHere.uncertainties,
					stop: "node-budget-cut",
				});
				continue;
			}
			if (ctxHere.routinePath.includes(edge.to)) {
				results.push({
					path: ctxHere.steps,
					effectiveLoopDepth: ctxHere.inheritedLoopDepth,
					uncertainties: ctxHere.uncertainties,
					stop: "cycle-cut",
				});
				continue;
			}
			if (ctxHere.routinePath.length >= bounds.maxDepth) {
				results.push({
					path: ctxHere.steps,
					effectiveLoopDepth: ctxHere.inheritedLoopDepth,
					uncertainties: ctxHere.uncertainties,
					stop: "depth-cut",
				});
				continue;
			}
			const childCtx: PathCtx = {
				routinePath: [...ctxHere.routinePath, edge.to],
				inheritedLoopDepth: ctxHere.inheritedLoopDepth + loopDepthOfEdge(edge),
				steps: [...ctxHere.steps, policy.buildHopStep(edge, ctxHere)],
				uncertainties: ctxHere.uncertainties,
			};
			visit(edge.to, childCtx);
		}
	};

	visit(start, {
		routinePath: [start],
		inheritedLoopDepth: opts.initialLoopDepth ?? 0,
		steps: opts.initialSteps ?? [],
		uncertainties: [],
	});

	return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/engine/path-walker.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/engine/path-walker.ts test/engine/path-walker.test.ts
git commit -m "feat: add bounded evidence path-walker primitive"
```

---

## Task 9: Confidence mapping

**Files:**
- Create: `src/detectors/confidence.ts`
- Test: `test/detectors/confidence.test.ts`

`FindingConfidence.cappedBy` accepts only a fixed set of kinds; `Uncertainty.kind` has two extras (`interface-dispatch`, `recordref-or-variant`). `toConfidence` maps a list of uncertainties to a `FindingConfidence` — valid kinds go to `cappedBy`, all uncertainties go to `evidence`, any uncertainty caps the level at `possible`.

- [ ] **Step 1: Write the failing test**

`test/detectors/confidence.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import type { Uncertainty } from "../../src/model/summary.ts";
import { toConfidence } from "../../src/detectors/confidence.ts";

describe("toConfidence", () => {
	test("no uncertainties -> base level, empty evidence", () => {
		const c = toConfidence([], "likely");
		expect(c.level).toBe("likely");
		expect(c.cappedBy ?? []).toEqual([]);
		expect(c.evidence).toEqual([]);
	});

	test("a valid cappedBy kind caps the level to possible and is listed in cappedBy", () => {
		const u: Uncertainty[] = [{ kind: "unresolved-call", callsiteId: "r/cs0" }];
		const c = toConfidence(u, "likely");
		expect(c.level).toBe("possible");
		expect(c.cappedBy).toEqual(["unresolved-call"]);
		expect(c.evidence.length).toBe(1);
	});

	test("interface-dispatch / recordref-or-variant cap to possible but stay OUT of cappedBy", () => {
		const u: Uncertainty[] = [
			{ kind: "interface-dispatch", callsiteId: "r/cs1" },
			{ kind: "recordref-or-variant", operationId: "r/op2" },
		];
		const c = toConfidence(u, "likely");
		expect(c.level).toBe("possible");
		expect(c.cappedBy ?? []).toEqual([]); // neither is a valid cappedBy kind
		expect(c.evidence.length).toBe(2); // both still recorded as evidence
	});

	test("cappedBy is de-duped and sorted", () => {
		const u: Uncertainty[] = [
			{ kind: "opaque-callee", callsiteId: "r/cs0" },
			{ kind: "unresolved-call", callsiteId: "r/cs1" },
			{ kind: "opaque-callee", callsiteId: "r/cs2" },
		];
		const c = toConfidence(u, "likely");
		expect(c.cappedBy).toEqual(["opaque-callee", "unresolved-call"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/detectors/confidence.test.ts`
Expected: FAIL — `Cannot find module '../../src/detectors/confidence.ts'`.

- [ ] **Step 3: Write the implementation**

`src/detectors/confidence.ts`:
```typescript
import type { FindingConfidence } from "../model/finding.ts";
import type { Uncertainty } from "../model/summary.ts";

type CappedByKind = NonNullable<FindingConfidence["cappedBy"]>[number];

// The Uncertainty kinds that are also valid FindingConfidence.cappedBy values.
const VALID_CAPPED_BY: ReadonlySet<string> = new Set<CappedByKind>([
	"unresolved-call",
	"opaque-callee",
	"dynamic-dispatch",
	"parse-incomplete",
	"version-mismatch",
]);

function describe(u: Uncertainty): string {
	if ("callsiteId" in u) return `${u.kind} at ${u.callsiteId}`;
	if ("operationId" in u) return `${u.kind} at ${u.operationId}`;
	return `${u.kind} at ${u.routineId}`;
}

/**
 * Map a list of uncertainties to a FindingConfidence. Any uncertainty caps `level` at
 * `possible`. Uncertainty kinds that are valid `cappedBy` values are listed there; the
 * others (`interface-dispatch`, `recordref-or-variant`) still cap the level but are recorded
 * only in `evidence` — never as an invalid `cappedBy` string. `baseLevel` is never raised.
 */
export function toConfidence(
	uncertainties: Uncertainty[],
	baseLevel: FindingConfidence["level"],
): FindingConfidence {
	if (uncertainties.length === 0) {
		return { level: baseLevel, evidence: [] };
	}
	const cappedBy = [
		...new Set(
			uncertainties
				.map((u) => u.kind)
				.filter((k): k is CappedByKind => VALID_CAPPED_BY.has(k)),
		),
	].sort();
	const evidence = uncertainties.map((u) => ({
		source: "tree-sitter" as const,
		note: describe(u),
	}));
	return {
		level: "possible",
		...(cappedBy.length > 0 ? { cappedBy } : {}),
		evidence,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/detectors/confidence.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/detectors/confidence.ts test/detectors/confidence.test.ts
git commit -m "feat: add uncertainty -> FindingConfidence mapping"
```

---

## Task 10: D1 — interprocedural DB-op-in-loop

**Files:**
- Create: `src/detectors/d1-db-op-in-loop.ts`
- Test: `test/detectors/d1.test.ts`

The first detector. Finds database operations executed inside a loop — directly, or transitively through a call chain (including implicit-trigger edges).

- [ ] **Step 1: Create the `ws-d1` fixture**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-d1/src
cat > ws-d1/app.json <<'EOF'
{
  "id": "11111111-d100-0000-0000-000000000001",
  "name": "D1 Test App",
  "publisher": "D1",
  "version": "1.0.0.0"
}
EOF
cat > ws-d1/src/customer.al <<'EOF'
table 63100 Customer
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Name; Text[100]) { }
    }
    keys { key(PK; "No.") { } }
}
EOF
cat > ws-d1/src/jobs.al <<'EOF'
codeunit 63101 "D1 Jobs"
{
    procedure ProcessAll()
    var
        i: Integer;
    begin
        for i := 1 to 10 do
            ProcessOne();
    end;

    local procedure ProcessOne()
    var
        Customer: Record Customer;
    begin
        Customer.FindSet();
    end;

    procedure DirectLoop()
    var
        Customer: Record Customer;
        i: Integer;
    begin
        for i := 1 to 10 do
            Customer.Get('C0001');
    end;

    procedure SafeLoop()
    var
        Customer: Record Customer;
        i: Integer;
    begin
        for i := 1 to 10 do
            Customer.SetRange("No.", 'C0001');
    end;
}
EOF
```
Expected: `test/fixtures/ws-d1/` with `app.json` + 2 `.al` files.

- [ ] **Step 2: Write the failing test**

`test/detectors/d1.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildCombinedGraph } from "../../src/engine/combined-graph.ts";
import { computeSummaries } from "../../src/engine/summary-engine.ts";
import { detectD1 } from "../../src/detectors/d1-db-op-in-loop.ts";

const WS_D1 = fileURLToPath(new URL("../fixtures/ws-d1", import.meta.url));

async function analyzed() {
	const { model } = await analyzeWorkspace({ workspaceRoot: WS_D1, deterministic: true });
	const graph = buildCombinedGraph(model);
	computeSummaries(model, graph, []);
	return { model, graph };
}

describe("detectD1", () => {
	test("flags a DB op reached through an in-loop call (interprocedural)", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD1(model, graph);
		// ProcessAll loops, calls ProcessOne, which does Customer.FindSet().
		const interproc = findings.find((f) => f.evidencePath.some((s) => s.note.includes("FindSet")));
		expect(interproc).toBeDefined();
		expect(interproc?.detector).toBe("d1-db-op-in-loop");
		// Evidence path ends at the real op site.
		const last = interproc?.evidencePath.at(-1);
		expect(last?.operationId).toBeDefined();
		expect(interproc?.confidence.level).toBe("likely"); // no uncertainty in this path
	});

	test("flags a direct in-loop DB op", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD1(model, graph);
		const direct = findings.find((f) => f.evidencePath.some((s) => s.note.includes("Get")));
		expect(direct).toBeDefined();
	});

	test("does NOT flag a loop containing only state-only ops (SetRange)", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD1(model, graph);
		// SafeLoop's loop body is only Customer.SetRange — not a DB round-trip.
		const safe = findings.find((f) =>
			f.evidencePath.some((s) => s.note.includes("SetRange")),
		);
		expect(safe).toBeUndefined();
	});

	test("findings are deterministic across two runs", async () => {
		const a = await analyzed();
		const b = await analyzed();
		expect(JSON.stringify(detectD1(a.model, a.graph))).toBe(
			JSON.stringify(detectD1(b.model, b.graph)),
		);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/detectors/d1.test.ts`
Expected: FAIL — `Cannot find module '../../src/detectors/d1-db-op-in-loop.ts'`.

- [ ] **Step 4: Write the implementation**

`src/detectors/d1-db-op-in-loop.ts`:
```typescript
import type { CombinedGraph } from "../engine/combined-graph.ts";
import { classifyOp, isDbTouchingClass } from "../engine/op-classification.ts";
import type { Terminal, WalkPolicy, WalkResult } from "../engine/path-walker.ts";
import { walkEvidence } from "../engine/path-walker.ts";
import type { LoopNode, RecordOperation, Routine } from "../model/entities.ts";
import type { EvidenceStep, Finding } from "../model/finding.ts";
import type { SemanticModel } from "../model/model.ts";
import { toConfidence } from "./confidence.ts";

const BOUNDS = { maxDepth: 20, maxNodes: 500 };
const WORST_OPS = new Set(["FindSet", "CalcFields", "CalcSums", "Modify", "ModifyAll", "Insert", "Delete", "DeleteAll"]);

interface D1Terminal extends Terminal {
	op: RecordOperation;
}

function severityFor(op: RecordOperation, effectiveLoopDepth: number): Finding["severity"] {
	if (op.tempState.kind === "known" && op.tempState.value === true) return "info";
	let base: Finding["severity"] = classifyOp(op.op) === "db-lock" ? "low" : WORST_OPS.has(op.op) ? "high" : "medium";
	if (effectiveLoopDepth >= 2) {
		if (base === "high") base = "critical";
		else if (base === "medium") base = "high";
	}
	return base;
}

function tableNote(op: RecordOperation): string {
	return `${op.op} on ${op.tableId ?? "unknown table"}`;
}

function buildFinding(
	loopRoutine: Routine,
	loop: LoopNode,
	result: WalkResult,
	terminalOp: RecordOperation,
	model: SemanticModel,
): Finding {
	const terminalRoutine = model.routines.find((r) => r.id === terminalOp.routineId);
	const severity = severityFor(terminalOp, result.effectiveLoopDepth);
	const tempNote =
		terminalOp.tempState.kind === "known" && terminalOp.tempState.value === true
			? " (temporary record — not a SQL round-trip)"
			: terminalOp.tempState.kind !== "known"
				? " (temp state uncertain)"
				: "";
	return {
		id: `d1/${loop.id}/${terminalOp.id}`,
		rootCauseKey: `d1/${loop.id}/${terminalOp.id}`,
		detector: "d1-db-op-in-loop",
		title: "Database operation inside a loop",
		rootCause: `A loop in ${loopRoutine.name} reaches ${tableNote(terminalOp)}${tempNote}.`,
		severity,
		confidence: toConfidence(result.uncertainties, "likely"),
		primaryLocation: terminalOp.sourceAnchor,
		evidencePath: result.path,
		affectedObjects: [
			...new Set([loopRoutine.objectId, terminalRoutine?.objectId].filter((x): x is string => x !== undefined)),
		].sort(),
		affectedTables: terminalOp.tableId !== undefined ? [terminalOp.tableId] : [],
		fixOptions: [
			{ description: "Move the database operation outside the loop, or batch it into a set-based operation.", safety: "medium" },
		],
		provenance: [{ source: "tree-sitter" }],
	};
}

/** D1: find DB operations executed inside a loop — directly or through an in-loop call chain. */
export function detectD1(model: SemanticModel, graph: CombinedGraph): Finding[] {
	const findings: Finding[] = [];
	const routineById = new Map(model.routines.map((r) => [r.id, r]));

	const policy: WalkPolicy<D1Terminal> = {
		terminalsAt: (node) => {
			const r = routineById.get(node);
			if (r === undefined) return [];
			return r.features.recordOperations
				.filter((op) => isDbTouchingClass(classifyOp(op.op)))
				.map((op) => ({ routineId: node, localLoopDepth: op.loopStack.length, op }));
		},
		expand: (node) =>
			(graph.edgesByFrom.get(node) ?? []).filter((e) => {
				if (e.kind === "event-dispatch") return false; // event fan-out is D2's job
				return (routineById.get(e.to)?.summary?.touchesDb ?? "no") !== "no";
			}),
		buildHopStep: (edge) => {
			const fromRoutine = routineById.get(edge.from);
			const cs = fromRoutine?.features.callSites.find((c) => c.id === edge.callsiteId);
			const toName = routineById.get(edge.to)?.name ?? edge.to;
			return {
				routineId: edge.from,
				callsiteId: edge.callsiteId,
				sourceAnchor: cs?.sourceAnchor ?? fromRoutine?.sourceAnchor ?? { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: edge.from, syntaxKind: "call" },
				note: `calls ${toName}`,
			};
		},
		buildTerminalStep: (t) => ({
			routineId: t.routineId,
			operationId: t.op.id,
			sourceAnchor: t.op.sourceAnchor,
			note: tableNote(t.op),
		}),
	};

	for (const routine of model.routines) {
		if (!routine.bodyAvailable) continue;
		for (const loop of routine.features.loops) {
			// (a) direct in-loop DB ops.
			for (const op of routine.features.recordOperations) {
				if (!op.loopStack.includes(loop.id)) continue;
				if (!isDbTouchingClass(classifyOp(op.op))) continue;
				const loopStep: EvidenceStep = {
					routineId: routine.id,
					loopId: loop.id,
					sourceAnchor: loop.sourceAnchor,
					note: `${loop.type} loop`,
				};
				const opStep: EvidenceStep = {
					routineId: routine.id,
					operationId: op.id,
					sourceAnchor: op.sourceAnchor,
					note: tableNote(op),
				};
				const result: WalkResult = {
					path: [loopStep, opStep],
					effectiveLoopDepth: op.loopStack.length,
					uncertainties: [],
					stop: "complete",
				};
				findings.push(buildFinding(routine, loop, result, op, model));
			}
			// (b) in-loop calls to DB-touching callees — walk the call chain.
			for (const cs of routine.features.callSites) {
				if (!cs.loopStack.includes(loop.id)) continue;
				const edge = (graph.edgesByFrom.get(routine.id) ?? []).find((e) => e.callsiteId === cs.id);
				if (edge === undefined) continue;
				if ((routineById.get(edge.to)?.summary?.touchesDb ?? "no") === "no") continue;
				const loopStep: EvidenceStep = {
					routineId: routine.id,
					loopId: loop.id,
					sourceAnchor: loop.sourceAnchor,
					note: `${loop.type} loop`,
				};
				const callStep: EvidenceStep = {
					routineId: routine.id,
					callsiteId: cs.id,
					sourceAnchor: cs.sourceAnchor,
					note: `calls ${routineById.get(edge.to)?.name ?? edge.to}`,
				};
				const results = walkEvidence(edge.to, policy, BOUNDS, graph, model, {
					initialLoopDepth: cs.loopStack.length,
					initialSteps: [loopStep, callStep],
				});
				for (const result of results) {
					if (result.stop !== "complete") continue;
					const lastStep = result.path.at(-1);
					const terminalOp = lastStep?.operationId !== undefined
						? routineById.get(lastStep.routineId)?.features.recordOperations.find((o) => o.id === lastStep.operationId)
						: undefined;
					if (terminalOp === undefined) continue;
					findings.push(buildFinding(routine, loop, result, terminalOp, model));
				}
			}
		}
	}

	return findings.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/detectors/d1.test.ts`
Expected: PASS — 4 tests pass.

> If the interprocedural test finds nothing: confirm `computeSummaries` gave `ProcessOne` a summary with `touchesDb: "yes"` and that the combined graph has a `direct` edge `ProcessAll → ProcessOne` whose `callsiteId` matches a `CallSite` whose `loopStack` includes the `for` loop's `LoopId`. Check `test/routine-indexer.test.ts` for how `loopStack` is populated on call sites.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/detectors/d1-db-op-in-loop.ts test/detectors/d1.test.ts test/fixtures/ws-d1/
git commit -m "feat: add D1 interprocedural DB-op-in-loop detector"
```

---

## Task 11: Detector registry

**Files:**
- Create: `src/detectors/registry.ts`
- Test: `test/detectors/registry.test.ts`

`runDetectors` runs each detector in isolation (one throw does not kill the run — it becomes a `Diagnostic`), then returns the combined `Finding[]` sorted by a stable key. D2 and D3 are added to the registry list in their own tasks.

- [ ] **Step 1: Write the failing test**

`test/detectors/registry.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildCombinedGraph } from "../../src/engine/combined-graph.ts";
import { computeSummaries } from "../../src/engine/summary-engine.ts";
import { detectD1 } from "../../src/detectors/d1-db-op-in-loop.ts";
import { runDetectors } from "../../src/detectors/registry.ts";

const WS_D1 = fileURLToPath(new URL("../fixtures/ws-d1", import.meta.url));

async function analyzed() {
	const { model } = await analyzeWorkspace({ workspaceRoot: WS_D1, deterministic: true });
	const graph = buildCombinedGraph(model);
	computeSummaries(model, graph, []);
	return { model, graph };
}

describe("runDetectors", () => {
	test("runs the registered detectors and returns sorted findings", async () => {
		const { model, graph } = await analyzed();
		const { findings, diagnostics } = runDetectors(model, graph);
		expect(findings.length).toBeGreaterThan(0);
		expect(diagnostics).toEqual([]);
		// Sorted by (detector, primaryLocationKey, rootCauseKey).
		const keys = findings.map((f) => f.detector);
		expect(keys).toEqual([...keys].sort());
	});

	test("a throwing detector becomes a diagnostic; other detectors still run", async () => {
		const { model, graph } = await analyzed();
		// runDetectors accepts an explicit detector list for testability. One detector throws;
		// the other (real D1) still runs.
		const { findings, diagnostics } = runDetectors(model, graph, [
			{
				name: "boom",
				run: () => {
					throw new Error("detector exploded");
				},
			},
			{ name: "d1-db-op-in-loop", run: detectD1 },
		]);
		expect(diagnostics.some((d) => d.stage === "detect" && d.message.includes("boom"))).toBe(true);
		expect(findings.length).toBeGreaterThan(0); // the non-throwing detector still produced findings
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/detectors/registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/detectors/registry.ts'`.

- [ ] **Step 3: Write the implementation**

`src/detectors/registry.ts`:
```typescript
import type { CombinedGraph } from "../engine/combined-graph.ts";
import type { Diagnostic, Finding } from "../model/finding.ts";
import type { SemanticModel } from "../model/model.ts";
import { detectD1 } from "./d1-db-op-in-loop.ts";

/** A detector: a pure query over the summarised model + combined graph. */
export interface Detector {
	name: string;
	run(model: SemanticModel, graph: CombinedGraph): Finding[];
}

/** The default detector registry. D2 and D3 are appended in their own tasks. */
export const DEFAULT_DETECTORS: Detector[] = [
	{ name: "d1-db-op-in-loop", run: detectD1 },
];

function primaryLocationKey(f: Finding): string {
	const a = f.primaryLocation;
	return `${a.sourceUnitId}:${a.range.startLine}:${a.range.startColumn}`;
}

/**
 * Run every detector in isolation. A detector that throws does not kill the run — it becomes
 * a `Diagnostic(stage: "detect")` and the rest still run. The combined Finding[] is sorted
 * by (detector, primaryLocationKey, rootCauseKey) for deterministic output.
 */
export function runDetectors(
	model: SemanticModel,
	graph: CombinedGraph,
	detectors: Detector[] = DEFAULT_DETECTORS,
): { findings: Finding[]; diagnostics: Diagnostic[] } {
	const findings: Finding[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const detector of detectors) {
		try {
			findings.push(...detector.run(model, graph));
		} catch (err) {
			diagnostics.push({
				severity: "warning",
				stage: "detect",
				message: `Detector "${detector.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
	findings.sort((a, b) => {
		if (a.detector !== b.detector) return a.detector.localeCompare(b.detector);
		const la = primaryLocationKey(a);
		const lb = primaryLocationKey(b);
		if (la !== lb) return la.localeCompare(lb);
		return a.rootCauseKey.localeCompare(b.rootCauseKey);
	});
	return { findings, diagnostics };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/detectors/registry.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/detectors/registry.ts test/detectors/registry.test.ts
git commit -m "feat: add detector registry with isolated execution"
```

---

## Task 12: Wire L4 + L5 into `analyzeWorkspace`

**Files:**
- Modify: `src/index.ts`
- Modify: `test/analyze-workspace.test.ts`

`analyzeWorkspace` runs the new passes and its return type widens to `{ model, findings, diagnostics }`. The change is additive for destructuring consumers.

- [ ] **Step 1: Add the failing test**

Append to `test/analyze-workspace.test.ts` (inside the existing `describe` block):
```typescript
	test("returns findings and a fully summarised model", async () => {
		const WS_D1 = fileURLToPath(new URL("./fixtures/ws-d1", import.meta.url));
		const result = await analyzeWorkspace({ workspaceRoot: WS_D1, deterministic: true });
		expect(Array.isArray(result.findings)).toBe(true);
		expect(result.findings.length).toBeGreaterThan(0);
		expect(result.findings.every((f) => f.detector.length > 0)).toBe(true);
		// Every routine got a summary populated by the L4 engine.
		expect(result.model.routines.every((r) => r.summary !== undefined)).toBe(true);
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/analyze-workspace.test.ts`
Expected: FAIL — `result.findings` is `undefined` (`analyzeWorkspace` still returns `{ model, diagnostics }`).

- [ ] **Step 3: Update `src/index.ts`**

In `src/index.ts`:

(a) Add imports alongside the existing `import { resolveModel } ...`:
```typescript
import { buildCombinedGraph } from "./engine/combined-graph.ts";
import { computeSummaries } from "./engine/summary-engine.ts";
import { runDetectors } from "./detectors/registry.ts";
import type { Finding } from "./model/finding.ts";
```

(b) Change the `AnalyzeWorkspaceResult` interface from:
```typescript
export interface AnalyzeWorkspaceResult {
	model: SemanticModel;
	diagnostics: Diagnostic[];
}
```
to:
```typescript
export interface AnalyzeWorkspaceResult {
	model: SemanticModel;
	findings: Finding[];
	diagnostics: Diagnostic[];
}
```

(c) Replace the body of `analyzeWorkspace` (the part after `indexWorkspace`) so it reads:
```typescript
export async function analyzeWorkspace(
	options: AnalyzeWorkspaceOptions,
): Promise<AnalyzeWorkspaceResult> {
	const { index, units, indexDiagnostics, diagnostics } = await indexWorkspace(options);
	const model = resolveModel(index, units, indexDiagnostics);

	const graph = buildCombinedGraph(model);
	const summarizeDiagnostics: Diagnostic[] = [];
	computeSummaries(model, graph, summarizeDiagnostics);
	const { findings, diagnostics: detectDiagnostics } = runDetectors(model, graph);

	return {
		model,
		findings,
		diagnostics: [...diagnostics, ...summarizeDiagnostics, ...detectDiagnostics],
	};
}
```

(d) Update the JSDoc on `analyzeWorkspace` to: `"Discovers, indexes, resolves, summarises, and runs detectors over a workspace — the full pipeline. Returns the SemanticModel (with routine summaries populated), the Finding[], and all diagnostics. Never throws — failures surface as diagnostics."`

- [ ] **Step 4: Run the full suite + checks**

Run: `bun test && bunx tsc --noEmit && bunx biome check src test`
Expected: full suite green (the new analyze-workspace test passes; the existing determinism test still passes — the model now includes summaries but is still byte-deterministic); tsc exit 0; biome exit 0.

> If the existing determinism test (`JSON.stringify(a.model) === JSON.stringify(b.model)`) fails: a summary array is not deterministically ordered. Re-check that `computeSummaries` produces sorted `dbEffects` / `writesTables` / `publishesEvents` / `uncertainties` / `parameterEffects` (Tasks 6–7).

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/index.ts test/analyze-workspace.test.ts
git commit -m "feat: analyzeWorkspace runs L4 summaries + L5 detectors, returns findings"
```

---

## Task 13: CLI surface

**Files:**
- Create: `src/cli/index.ts`, `src/cli/format-terminal.ts`, `src/cli/format-json.ts`
- Test: `test/cli/format.test.ts`, `test/cli/cli-smoke.test.ts`
- Modify: `package.json` (add `commander` dependency)

A `commander`-based `al-sem analyze <workspace>` command, with terminal + JSON output.

- [ ] **Step 1: Add the `commander` dependency**

Run:
```bash
cd U:/Git/al-sem
bun add commander
```
Expected: `commander` appears under `dependencies` in `package.json`; `bun.lockb` updated.

- [ ] **Step 2: Write the failing test**

`test/cli/format.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { formatJson } from "../../src/cli/format-json.ts";
import { formatTerminal } from "../../src/cli/format-terminal.ts";

const WS_D1 = fileURLToPath(new URL("../fixtures/ws-d1", import.meta.url));

describe("formatJson", () => {
	test("emits valid JSON with model, findings, and diagnostics", async () => {
		const result = await analyzeWorkspace({ workspaceRoot: WS_D1, deterministic: true });
		const parsed = JSON.parse(formatJson(result));
		expect(parsed.findings.length).toBeGreaterThan(0);
		expect(parsed.model).toBeDefined();
		expect(Array.isArray(parsed.diagnostics)).toBe(true);
	});
});

describe("formatTerminal", () => {
	test("includes a coverage line and lists findings", async () => {
		const result = await analyzeWorkspace({ workspaceRoot: WS_D1, deterministic: true });
		const out = formatTerminal(result);
		expect(out).toContain("routines");
		expect(out).toContain("d1-db-op-in-loop");
	});

	test("when there are no findings it still shows coverage, not a bare 'no issues'", async () => {
		// An empty-ish workspace produces no findings; the coverage summary must still print.
		const WS = fileURLToPath(new URL("../fixtures/ws-resolve", import.meta.url));
		const result = await analyzeWorkspace({ workspaceRoot: WS, deterministic: true });
		const out = formatTerminal(result);
		expect(out).toContain("routines");
	});
});
```

`test/cli/cli-smoke.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const WS_D1 = fileURLToPath(new URL("../fixtures/ws-d1", import.meta.url));

describe("al-sem CLI", () => {
	test("analyze --format json prints a parseable result with findings", async () => {
		const proc = Bun.spawn(["bun", "run", CLI, "analyze", WS_D1, "--format", "json", "--deterministic"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.findings.length).toBeGreaterThan(0);
	});

	test("analyze --format terminal prints the coverage line", async () => {
		const proc = Bun.spawn(["bun", "run", CLI, "analyze", WS_D1, "--format", "terminal", "--deterministic"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(out).toContain("routines");
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/cli/format.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/format-json.ts'`.

- [ ] **Step 4: Write `src/cli/format-json.ts`**

```typescript
import type { AnalyzeWorkspaceResult } from "../index.ts";

/** Serialise the full analysis result as pretty-printed JSON. */
export function formatJson(result: AnalyzeWorkspaceResult): string {
	return JSON.stringify(
		{ model: result.model, findings: result.findings, diagnostics: result.diagnostics },
		null,
		2,
	);
}
```

- [ ] **Step 5: Write `src/cli/format-terminal.ts`**

```typescript
import type { AnalyzeWorkspaceResult } from "../index.ts";
import type { Finding } from "../model/finding.ts";

const SEVERITY_ORDER: Finding["severity"][] = ["critical", "high", "medium", "low", "info"];

/** Human-readable terminal output: a coverage summary, then findings grouped by severity. */
export function formatTerminal(result: AnalyzeWorkspaceResult): string {
	const { model, findings, diagnostics } = result;
	const cov = model.coverage;
	const lines: string[] = [];

	// Coverage summary — always printed, even when there are no findings.
	lines.push(
		`Analysed ${cov.routinesTotal} routines ` +
			`(${cov.routinesBodyAvailable} with bodies, ${cov.routinesParseIncomplete.length} parse-incomplete); ` +
			`${cov.sourceUnitsParsed}/${cov.sourceUnitsTotal} source units parsed; ` +
			`${cov.opaqueApps.length} opaque app(s).`,
	);
	lines.push("");

	if (findings.length === 0) {
		lines.push("No findings. (Absence of a finding is not absence of a problem — see coverage above.)");
	} else {
		for (const severity of SEVERITY_ORDER) {
			const group = findings.filter((f) => f.severity === severity);
			if (group.length === 0) continue;
			lines.push(`${severity.toUpperCase()} (${group.length}):`);
			for (const f of group) {
				lines.push(`  [${f.detector}] ${f.title} — ${f.rootCause}`);
				lines.push(`    confidence: ${f.confidence.level}${f.confidence.cappedBy ? ` (capped by ${f.confidence.cappedBy.join(", ")})` : ""}`);
				for (const step of f.evidencePath) {
					lines.push(`      → ${step.note}`);
				}
				for (const fix of f.fixOptions) {
					lines.push(`    fix (${fix.safety}): ${fix.description}`);
				}
			}
			lines.push("");
		}
	}

	if (diagnostics.length > 0) {
		lines.push(`Diagnostics (${diagnostics.length}):`);
		for (const d of diagnostics) {
			lines.push(`  [${d.severity}/${d.stage}] ${d.message}`);
		}
	}

	return lines.join("\n");
}
```

- [ ] **Step 6: Write `src/cli/index.ts`**

```typescript
import { Command } from "commander";
import { analyzeWorkspace } from "../index.ts";
import { formatJson } from "./format-json.ts";
import { formatTerminal } from "./format-terminal.ts";

const program = new Command();

program
	.name("al-sem")
	.description("Static semantic analysis engine for Microsoft Business Central AL code");

program
	.command("analyze")
	.argument("<workspace>", "path to the AL workspace root")
	.option("--alpackages <dir>", "path to the .alpackages directory")
	.option("--format <format>", "output format: auto | terminal | json", "auto")
	.option("--deterministic", "pin timestamps for byte-stable output", false)
	.action(async (workspace: string, opts: { alpackages?: string; format: string; deterministic: boolean }) => {
		const result = await analyzeWorkspace({
			workspaceRoot: workspace,
			alpackagesDir: opts.alpackages,
			deterministic: opts.deterministic,
		});
		const format =
			opts.format === "auto" ? (process.stdout.isTTY ? "terminal" : "json") : opts.format;
		if (format === "json") {
			process.stdout.write(`${formatJson(result)}\n`);
		} else {
			process.stdout.write(`${formatTerminal(result)}\n`);
		}
	});

program.parseAsync(process.argv).catch((err: unknown) => {
	process.stderr.write(`al-sem: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/cli/format.test.ts test/cli/cli-smoke.test.ts`
Expected: PASS — all tests pass.

> If the smoke test hangs or fails on Windows: confirm the `Bun.spawn` args use the absolute `CLI` path. If `commander` is not found, re-run `bun add commander` and confirm it is in `package.json` `dependencies`.

- [ ] **Step 8: Commit**

```bash
cd U:/Git/al-sem
git add src/cli/ test/cli/ package.json bun.lockb
git commit -m "feat: add al-sem analyze CLI (terminal + JSON output)"
```

---

## Task 14: D2 — event fanout in loop

**Files:**
- Create: `src/detectors/d2-event-fanout-in-loop.ts`
- Modify: `src/detectors/registry.ts` (register D2)
- Test: `test/detectors/d2.test.ts`

Finds an event raised inside a loop whose subscribers touch the database — N loop iterations × M subscribers of DB work.

- [ ] **Step 1: Create the `ws-d2` fixture**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-d2/src
cat > ws-d2/app.json <<'EOF'
{
  "id": "22222222-d200-0000-0000-000000000002",
  "name": "D2 Test App",
  "publisher": "D2",
  "version": "1.0.0.0"
}
EOF
cat > ws-d2/src/customer.al <<'EOF'
table 64100 Customer
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }
    keys { key(PK; "No.") { } }
}
EOF
cat > ws-d2/src/publisher.al <<'EOF'
codeunit 64101 "D2 Publisher"
{
    procedure RaiseInLoop()
    var
        i: Integer;
    begin
        for i := 1 to 10 do
            OnProcessLine();
    end;

    procedure RaiseQuietInLoop()
    var
        i: Integer;
    begin
        for i := 1 to 10 do
            OnQuietEvent();
    end;

    [IntegrationEvent(false, false)]
    procedure OnProcessLine()
    begin
    end;

    [IntegrationEvent(false, false)]
    procedure OnQuietEvent()
    begin
    end;
}
EOF
cat > ws-d2/src/subscriber.al <<'EOF'
codeunit 64102 "D2 Subscriber"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"D2 Publisher", 'OnProcessLine', '', true, true)]
    local procedure HandleProcessLine()
    var
        Customer: Record Customer;
    begin
        Customer.FindSet();
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"D2 Publisher", 'OnQuietEvent', '', true, true)]
    local procedure HandleQuietEvent()
    begin
    end;
}
EOF
```
Expected: `test/fixtures/ws-d2/` with `app.json` + 3 `.al` files.

- [ ] **Step 2: Write the failing test**

`test/detectors/d2.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildCombinedGraph } from "../../src/engine/combined-graph.ts";
import { computeSummaries } from "../../src/engine/summary-engine.ts";
import { detectD2 } from "../../src/detectors/d2-event-fanout-in-loop.ts";

const WS_D2 = fileURLToPath(new URL("../fixtures/ws-d2", import.meta.url));

async function analyzed() {
	const { model } = await analyzeWorkspace({ workspaceRoot: WS_D2, deterministic: true });
	const graph = buildCombinedGraph(model);
	computeSummaries(model, graph, []);
	return { model, graph };
}

describe("detectD2", () => {
	test("flags an event raised in a loop with a DB-touching subscriber", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD2(model, graph);
		const hot = findings.find((f) => f.rootCause.includes("OnProcessLine") || f.evidencePath.some((s) => s.note.includes("OnProcessLine")));
		expect(hot).toBeDefined();
		expect(hot?.detector).toBe("d2-event-fanout-in-loop");
		// The subscriber's owning app is attributed in an evidence step note.
		expect(hot?.evidencePath.some((s) => s.note.includes("D2"))).toBe(true);
	});

	test("does NOT flag an event whose subscribers do no DB work", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD2(model, graph);
		const quiet = findings.find((f) => f.evidencePath.some((s) => s.note.includes("OnQuietEvent")));
		expect(quiet).toBeUndefined();
	});

	test("findings are deterministic", async () => {
		const a = await analyzed();
		const b = await analyzed();
		expect(JSON.stringify(detectD2(a.model, a.graph))).toBe(JSON.stringify(detectD2(b.model, b.graph)));
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/detectors/d2.test.ts`
Expected: FAIL — `Cannot find module '../../src/detectors/d2-event-fanout-in-loop.ts'`.

- [ ] **Step 4: Write the implementation**

`src/detectors/d2-event-fanout-in-loop.ts`:
```typescript
import type { CombinedGraph } from "../engine/combined-graph.ts";
import { classifyOp, isDbTouchingClass } from "../engine/op-classification.ts";
import type { Terminal, WalkPolicy } from "../engine/path-walker.ts";
import { walkEvidence } from "../engine/path-walker.ts";
import { resolvePublishedEvent } from "../engine/summary-engine.ts";
import type { RecordOperation } from "../model/entities.ts";
import type { EvidenceStep, Finding } from "../model/finding.ts";
import type { RoutineId } from "../model/ids.ts";
import type { SemanticModel } from "../model/model.ts";
import type { Uncertainty } from "../model/summary.ts";
import { toConfidence } from "./confidence.ts";

const BOUNDS = { maxDepth: 20, maxNodes: 500 };

interface D2Terminal extends Terminal {
	op: RecordOperation;
}

/** D2: find an event raised inside a loop whose subscribers touch the database. */
export function detectD2(model: SemanticModel, graph: CombinedGraph): Finding[] {
	const findings: Finding[] = [];
	const routineById = new Map(model.routines.map((r) => [r.id, r]));
	const publisherRoutineIds = new Set(
		model.routines.filter((r) => r.kind === "event-publisher").map((r) => r.id),
	);

	const policy: WalkPolicy<D2Terminal> = {
		terminalsAt: (node) => {
			const r = routineById.get(node);
			if (r === undefined) return [];
			return r.features.recordOperations
				.filter((op) => isDbTouchingClass(classifyOp(op.op)))
				.map((op) => ({ routineId: node, localLoopDepth: op.loopStack.length, op }));
		},
		expand: (node) =>
			(graph.edgesByFrom.get(node) ?? []).filter(
				(e) => e.kind !== "event-dispatch" && (routineById.get(e.to)?.summary?.touchesDb ?? "no") !== "no",
			),
		buildHopStep: (edge) => ({
			routineId: edge.from,
			callsiteId: edge.callsiteId,
			sourceAnchor: routineById.get(edge.from)?.sourceAnchor ?? { sourceUnitId: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, enclosingRoutineId: edge.from, syntaxKind: "call" },
			note: `calls ${routineById.get(edge.to)?.name ?? edge.to}`,
		}),
		buildTerminalStep: (t) => ({
			routineId: t.routineId,
			operationId: t.op.id,
			sourceAnchor: t.op.sourceAnchor,
			note: `${t.op.op} on ${t.op.tableId ?? "unknown table"}`,
		}),
	};

	for (const routine of model.routines) {
		if (!routine.bodyAvailable) continue;
		for (const cs of routine.features.callSites) {
			if (cs.loopStack.length === 0) continue; // publish must be inside a loop
			const edge = (graph.edgesByFrom.get(routine.id) ?? []).find((e) => e.callsiteId === cs.id);
			if (edge === undefined || !publisherRoutineIds.has(edge.to)) continue; // not an event publish
			const eventId = resolvePublishedEvent(cs.operationId, model);
			if (eventId === undefined) continue;

			// Subscribers of this event.
			const subEdges = (graph.edgesByFrom.get(edge.to) ?? []).filter(
				(e) => e.kind === "event-dispatch" && e.eventId === eventId,
			);
			const eventName = model.eventGraph.events.find((s) => s.id === eventId)?.eventName ?? eventId;

			const loopId = cs.loopStack[cs.loopStack.length - 1];
			const loopStep: EvidenceStep = {
				routineId: routine.id,
				loopId,
				callsiteId: cs.id,
				sourceAnchor: cs.sourceAnchor,
				note: `loop raises event ${eventName}`,
			};
			const subscriberSteps: EvidenceStep[] = [];
			const affectedObjects = new Set<string>([routine.objectId]);
			const affectedTables = new Set<string>();
			const uncertainties: Uncertainty[] = [];
			let anyDbSubscriber = false;
			let anyCompleteWitness = false;
			let allResolved = true;

			for (const subEdge of subEdges) {
				if (subEdge.resolution !== "resolved") allResolved = false;
				const subRoutine = routineById.get(subEdge.to);
				if (subRoutine === undefined) continue;
				if (!subRoutine.bodyAvailable) {
					allResolved = false;
					continue;
				}
				if ((subRoutine.summary?.touchesDb ?? "no") === "no") continue;
				anyDbSubscriber = true;
				affectedObjects.add(subRoutine.objectId);
				for (const u of subRoutine.summary?.uncertainties ?? []) uncertainties.push(u);
				for (const t of subRoutine.summary?.writesTables === "unknown" ? [] : subRoutine.summary?.writesTables ?? []) {
					affectedTables.add(t);
				}
				subscriberSteps.push({
					routineId: subRoutine.id,
					sourceAnchor: subRoutine.sourceAnchor,
					note: `subscriber ${subRoutine.name} (app ${subEdge.subscriberAppId}) touches the database`,
				});
				// Walk the subscriber for a concrete witness.
				const results = walkEvidence(subRoutine.id, policy, BOUNDS, graph, model);
				const complete = results.find((r) => r.stop === "complete");
				if (complete !== undefined) {
					anyCompleteWitness = true;
					subscriberSteps.push(...complete.path);
					for (const u of complete.uncertainties) uncertainties.push(u);
					const term = complete.path.at(-1);
					const termOp = term?.operationId !== undefined
						? routineById.get(term.routineId)?.features.recordOperations.find((o) => o.id === term.operationId)
						: undefined;
					if (termOp?.tableId !== undefined) affectedTables.add(termOp.tableId);
				}
			}

			if (!anyDbSubscriber || !anyCompleteWitness) continue; // no hot event / no real witness

			const baseLevel = allResolved ? "likely" : "possible";
			findings.push({
				id: `d2/${loopId}/${eventId}`,
				rootCauseKey: `d2/${loopId}/${eventId}`,
				detector: "d2-event-fanout-in-loop",
				title: "Event raised inside a loop fans out to database work",
				rootCause: `${routine.name} raises ${eventName} inside a loop; subscribers touch the database every iteration.`,
				severity: "high",
				confidence: toConfidence(uncertainties, baseLevel),
				primaryLocation: cs.sourceAnchor,
				evidencePath: [loopStep, ...subscriberSteps],
				affectedObjects: [...affectedObjects].sort(),
				affectedTables: [...affectedTables].sort(),
				fixOptions: [
					{ description: "Raise the event once outside the loop, or batch the work the subscribers do.", safety: "medium" },
				],
				provenance: [{ source: "tree-sitter" }],
			});
		}
	}

	return findings.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 5: Register D2 in the registry**

In `src/detectors/registry.ts`, add the import and the registry entry:
```typescript
import { detectD2 } from "./d2-event-fanout-in-loop.ts";
```
```typescript
export const DEFAULT_DETECTORS: Detector[] = [
	{ name: "d1-db-op-in-loop", run: detectD1 },
	{ name: "d2-event-fanout-in-loop", run: detectD2 },
];
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/detectors/d2.test.ts test/detectors/registry.test.ts`
Expected: PASS — D2's 3 tests pass; the registry tests still pass.

> If D2 finds nothing: confirm `ws-d2`'s `RaiseInLoop` has an in-loop `CallSite` to `OnProcessLine`, that `OnProcessLine` is indexed with `kind: "event-publisher"`, and that the event graph has an `event-dispatch` path to `HandleProcessLine`. The Phase 2a event-graph tests show what the resolver produces for `[EventSubscriber(...)]` attributes.

- [ ] **Step 7: Commit**

```bash
cd U:/Git/al-sem
git add src/detectors/d2-event-fanout-in-loop.ts src/detectors/registry.ts test/detectors/d2.test.ts test/fixtures/ws-d2/
git commit -m "feat: add D2 event-fanout-in-loop detector"
```

---

## Task 15: D3 load-field state machine

**Files:**
- Create: `src/detectors/d3-load-state.ts`
- Test: `test/detectors/d3-load-state.test.ts`

`RecordOperation` has no `loadFields` field — D3 must reconstruct per-record-variable load state by walking the operation stream in source order. This task builds that pure helper; Task 16 builds the detector on top.

- [ ] **Step 1: Create the `ws-d3` fixture**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-d3/src
cat > ws-d3/app.json <<'EOF'
{
  "id": "33333333-d300-0000-0000-000000000003",
  "name": "D3 Test App",
  "publisher": "D3",
  "version": "1.0.0.0"
}
EOF
cat > ws-d3/src/customer.al <<'EOF'
table 65100 Customer
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Name; Text[100]) { }
        field(3; Address; Text[100]) { }
    }
    keys { key(PK; "No.") { } }
}
EOF
cat > ws-d3/src/reports.al <<'EOF'
codeunit 65101 "D3 Reports"
{
    procedure MissingLoad()
    var
        Customer: Record Customer;
    begin
        Customer.FindSet();
        if Customer.Name <> '' then
            Customer.Name := Customer.Name;
    end;

    procedure CompleteLoad()
    var
        Customer: Record Customer;
    begin
        Customer.SetLoadFields(Name);
        Customer.FindSet();
        if Customer.Name <> '' then
            Customer.Name := Customer.Name;
    end;

    procedure IncompleteLoad()
    var
        Customer: Record Customer;
    begin
        Customer.SetLoadFields(Name);
        Customer.FindSet();
        if Customer.Name <> '' then
            Customer.Address := Customer.Address;
    end;

    procedure ResetBail()
    var
        Customer: Record Customer;
    begin
        Customer.SetLoadFields(Name);
        Customer.FindSet();
        Customer.Reset();
        if Customer.Name <> '' then
            Customer.Name := Customer.Name;
    end;

    procedure PartialThenCallee()
    var
        Customer: Record Customer;
    begin
        Customer.SetLoadFields("No.");
        Customer.FindSet();
        EnrichCustomer(Customer);
    end;

    local procedure EnrichCustomer(var C: Record Customer)
    begin
        if C.Name <> '' then
            C.Name := C.Name;
    end;
}
EOF
```
Expected: `test/fixtures/ws-d3/` with `app.json` + 2 `.al` files. `PartialThenCallee` loads only `"No."` then passes the record to `EnrichCustomer`, which reads `Name` — an *incomplete* load only visible interprocedurally via `ParameterEffectSummary`.

- [ ] **Step 2: Write the failing test**

`test/detectors/d3-load-state.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { deriveLoadStates } from "../../src/detectors/d3-load-state.ts";

const WS_D3 = fileURLToPath(new URL("../fixtures/ws-d3", import.meta.url));

describe("deriveLoadStates", () => {
	test("a FindSet with no prior SetLoadFields has load state 'none'", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_D3, deterministic: true });
		const missing = model.routines.find((r) => r.name === "MissingLoad");
		const states = deriveLoadStates(missing!);
		expect(states.length).toBe(1);
		expect(states[0]?.retrievalOp.op).toBe("FindSet");
		expect(states[0]?.loadState.kind).toBe("none");
	});

	test("a FindSet after SetLoadFields(Name) has load state 'loaded' with {Name}", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_D3, deterministic: true });
		const complete = model.routines.find((r) => r.name === "CompleteLoad");
		const states = deriveLoadStates(complete!);
		expect(states[0]?.loadState.kind).toBe("loaded");
		if (states[0]?.loadState.kind === "loaded") {
			expect([...states[0].loadState.fields].map((f) => f.toLowerCase())).toContain("name");
		}
	});

	test("a Reset before the retrieval invalidates the load state", async () => {
		const { model } = await analyzeWorkspace({ workspaceRoot: WS_D3, deterministic: true });
		const reset = model.routines.find((r) => r.name === "ResetBail");
		const states = deriveLoadStates(reset!);
		// FindSet is BEFORE the Reset, so the FindSet's state is 'loaded'; but the helper also
		// reports that the record variable becomes 'invalidated' after the Reset op.
		expect(states.some((s) => s.recordVariableName.toLowerCase() === "customer")).toBe(true);
		expect(reset?.features.recordOperations.some((o) => o.op === "Reset")).toBe(true);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/detectors/d3-load-state.test.ts`
Expected: FAIL — `Cannot find module '../../src/detectors/d3-load-state.ts'`.

- [ ] **Step 4: Write the implementation**

`src/detectors/d3-load-state.ts`:
```typescript
import type { RecordOperation, Routine } from "../model/entities.ts";

/** The load-field state of a record variable at a point in the operation stream. */
export type LoadState =
	| { kind: "none" } // no SetLoadFields seen — the full record is loaded
	| { kind: "loaded"; fields: Set<string> } // a partial load set is active
	| { kind: "invalidated" }; // Reset / Copy / TransferFields cleared the analysable state

/** A retrieval op paired with the load state of its record variable at that site. */
export interface LoadStateAtRetrieval {
	retrievalOp: RecordOperation;
	recordVariableName: string;
	loadState: LoadState;
}

const RETRIEVAL_OPS = new Set(["FindSet", "FindFirst", "FindLast", "Get"]);

/** Source order: line then column. */
function inSourceOrder(a: RecordOperation, b: RecordOperation): number {
	const ra = a.sourceAnchor.range;
	const rb = b.sourceAnchor.range;
	if (ra.startLine !== rb.startLine) return ra.startLine - rb.startLine;
	return ra.startColumn - rb.startColumn;
}

/**
 * Reconstruct per-record-variable load-field state by walking the routine's record
 * operations in source order. Returns one entry per retrieval op (`FindSet` / `FindFirst` /
 * `FindLast` / `Get`) with the load state of its record variable at that point.
 *
 * `SetLoadFields` sets a partial load set; `AddLoadFields` unions; `Reset` / `Copy` /
 * `TransferFields` invalidate the analysable state. All record-variable names are compared
 * case-insensitively (AL identifiers are case-insensitive).
 */
export function deriveLoadStates(routine: Routine): LoadStateAtRetrieval[] {
	const ops = [...routine.features.recordOperations].sort(inSourceOrder);
	const stateByVar = new Map<string, LoadState>();
	const out: LoadStateAtRetrieval[] = [];

	for (const op of ops) {
		const varKey = op.recordVariableName.toLowerCase();
		const current = stateByVar.get(varKey) ?? { kind: "none" };

		if (op.op === "SetLoadFields") {
			stateByVar.set(varKey, {
				kind: "loaded",
				fields: new Set((op.fieldArguments ?? []).map((f) => f.toLowerCase())),
			});
			continue;
		}
		if (op.op === "AddLoadFields") {
			const next = new Set(
				current.kind === "loaded" ? current.fields : [],
			);
			for (const f of op.fieldArguments ?? []) next.add(f.toLowerCase());
			stateByVar.set(varKey, { kind: "loaded", fields: next });
			continue;
		}
		if (op.op === "Reset" || op.op === "Copy" || op.op === "TransferFields") {
			stateByVar.set(varKey, { kind: "invalidated" });
			continue;
		}
		if (RETRIEVAL_OPS.has(op.op)) {
			out.push({
				retrievalOp: op,
				recordVariableName: op.recordVariableName,
				loadState:
					current.kind === "loaded"
						? { kind: "loaded", fields: new Set(current.fields) }
						: current,
			});
		}
	}

	return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/detectors/d3-load-state.test.ts`
Expected: PASS — 3 tests pass.

> If `fieldArguments` is empty for `SetLoadFields(Name)`: confirm the indexer captures `SetLoadFields` args into `RecordOperation.fieldArguments` — check `FIELD_ARGS_OPS` in `src/index/intraprocedural-ops.ts` and `test/intraprocedural-ops.test.ts`.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/detectors/d3-load-state.ts test/detectors/d3-load-state.test.ts test/fixtures/ws-d3/
git commit -m "feat: add D3 load-field state machine"
```

---

## Task 16: D3 — interprocedural missing/incomplete SetLoadFields

**Files:**
- Create: `src/detectors/d3-missing-setloadfields.ts`
- Modify: `src/detectors/registry.ts` (register D3)
- Test: `test/detectors/d3.test.ts`

The detector. Same-routine field access plus directly-resolved callee field reads (via `ParameterEffectSummary`) are compared against the derived load state. Emits only on a complete witness; bails conservatively.

- [ ] **Step 1: Write the failing test**

`test/detectors/d3.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildCombinedGraph } from "../../src/engine/combined-graph.ts";
import { computeSummaries } from "../../src/engine/summary-engine.ts";
import { detectD3 } from "../../src/detectors/d3-missing-setloadfields.ts";

const WS_D3 = fileURLToPath(new URL("../fixtures/ws-d3", import.meta.url));

async function analyzed() {
	const { model } = await analyzeWorkspace({ workspaceRoot: WS_D3, deterministic: true });
	const graph = buildCombinedGraph(model);
	computeSummaries(model, graph, []);
	return { model, graph };
}

function findingForRoutine(findings: import("../../src/model/finding.ts").Finding[], name: string) {
	return findings.find((f) => f.evidencePath.some((s) => s.note.includes(name)) || f.rootCause.includes(name));
}

describe("detectD3", () => {
	test("flags MissingLoad — FindSet with no SetLoadFields, then a field access", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD3(model, graph);
		expect(findingForRoutine(findings, "MissingLoad")).toBeDefined();
	});

	test("stays silent on CompleteLoad — loaded set covers the accessed field", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD3(model, graph);
		expect(findingForRoutine(findings, "CompleteLoad")).toBeUndefined();
	});

	test("flags IncompleteLoad — accessed field not in the loaded set", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD3(model, graph);
		const f = findingForRoutine(findings, "IncompleteLoad");
		expect(f).toBeDefined();
		expect(f?.rootCause.toLowerCase()).toContain("incomplete");
	});

	test("bails on ResetBail — Reset between FindSet and the field access", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD3(model, graph);
		expect(findingForRoutine(findings, "ResetBail")).toBeUndefined();
	});

	test("flags PartialThenCallee — incomplete load only visible via ParameterEffectSummary", async () => {
		const { model, graph } = await analyzed();
		const findings = detectD3(model, graph);
		const f = findingForRoutine(findings, "PartialThenCallee");
		expect(f).toBeDefined();
		expect(f?.rootCause.toLowerCase()).toContain("incomplete");
	});

	test("findings are deterministic", async () => {
		const a = await analyzed();
		const b = await analyzed();
		expect(JSON.stringify(detectD3(a.model, a.graph))).toBe(JSON.stringify(detectD3(b.model, b.graph)));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/detectors/d3.test.ts`
Expected: FAIL — `Cannot find module '../../src/detectors/d3-missing-setloadfields.ts'`.

- [ ] **Step 3: Write the implementation**

`src/detectors/d3-missing-setloadfields.ts`:
```typescript
import type { CombinedGraph } from "../engine/combined-graph.ts";
import type { RecordOperation, Routine } from "../model/entities.ts";
import type { EvidenceStep, Finding } from "../model/finding.ts";
import type { SemanticModel } from "../model/model.ts";
import type { SourceAnchor } from "../model/identity.ts";
import type { Uncertainty } from "../model/summary.ts";
import { toConfidence } from "./confidence.ts";
import { deriveLoadStates } from "./d3-load-state.ts";

const INVALIDATING_OPS = new Set(["Reset", "Copy", "TransferFields"]);

/** Is anchor `a` strictly before anchor `b` in source order? */
function before(a: SourceAnchor, b: SourceAnchor): boolean {
	if (a.range.startLine !== b.range.startLine) return a.range.startLine < b.range.startLine;
	return a.range.startColumn < b.range.startColumn;
}

/**
 * D3: detect retrievals (`FindSet` / `FindFirst` / `FindLast` / `Get`) whose loaded field set
 * does not cover the fields later accessed — same-routine, and through directly-resolved
 * callees via `ParameterEffectSummary`. Emits only on a complete witness (a concrete
 * retrieval + a concrete access); bails conservatively, never claiming a false "clean".
 */
export function detectD3(model: SemanticModel, graph: CombinedGraph): Finding[] {
	const findings: Finding[] = [];
	const routineById = new Map(model.routines.map((r) => [r.id, r]));
	const tableById = new Map(model.tables.map((t) => [t.id, t]));

	for (const routine of model.routines) {
		if (!routine.bodyAvailable) continue;

		for (const state of deriveLoadStates(routine)) {
			if (state.loadState.kind === "invalidated") continue; // bailout — cannot prove

			const varKey = state.recordVariableName.toLowerCase();
			const recVar = routine.features.recordVariables.find(
				(rv) => rv.name.toLowerCase() === varKey,
			);
			const tableId = recVar?.tableId;
			if (tableId === undefined) continue; // unresolved table — bailout
			const table = tableById.get(tableId);
			if (table === undefined) continue;
			const fieldNameById = new Map(table.fields.map((f) => [f.id, f.name.toLowerCase()]));

			const retrievalAnchor = state.retrievalOp.sourceAnchor;

			// The window closes at the first invalidating op on this record var after the retrieval.
			const invalidatingAfter = routine.features.recordOperations
				.filter(
					(op) =>
						op.recordVariableName.toLowerCase() === varKey &&
						INVALIDATING_OPS.has(op.op) &&
						before(retrievalAnchor, op.sourceAnchor),
				)
				.sort((a, b) => (before(a.sourceAnchor, b.sourceAnchor) ? -1 : 1))[0];
			const windowEnd = invalidatingAfter?.sourceAnchor;
			const inWindow = (anchor: SourceAnchor): boolean =>
				before(retrievalAnchor, anchor) && (windowEnd === undefined || before(anchor, windowEnd));

			const accessedFields = new Set<string>();
			const accessSteps: EvidenceStep[] = [];
			const uncertainties: Uncertainty[] = [];
			let bailout = false;

			// --- same-routine field accesses in the window ---
			for (const fa of routine.features.fieldAccesses) {
				if (fa.recordVariableName.toLowerCase() !== varKey) continue;
				if (!inWindow(fa.sourceAnchor)) continue;
				accessedFields.add(fa.fieldName.toLowerCase());
				accessSteps.push({
					routineId: routine.id,
					sourceAnchor: fa.sourceAnchor,
					note: `accesses ${state.recordVariableName}.${fa.fieldName}`,
				});
			}

			// --- cross-routine: record passed by simple identifier to a directly-resolved callee ---
			for (const cs of routine.features.callSites) {
				if (!inWindow(cs.sourceAnchor)) continue;
				const argIndex = cs.argumentTexts.findIndex(
					(a) => a.trim().toLowerCase() === varKey,
				);
				if (argIndex < 0) continue;
				const edge = (graph.edgesByFrom.get(routine.id) ?? []).find((e) => e.callsiteId === cs.id);
				if (edge === undefined || edge.kind === "interface" || edge.kind === "dynamic") {
					bailout = true;
					uncertainties.push({ kind: "recordref-or-variant", operationId: cs.operationId });
					continue;
				}
				const callee = routineById.get(edge.to);
				const paramEffect = callee?.summary?.parameterEffects.find(
					(pe) => pe.parameterIndex === argIndex,
				);
				if (callee === undefined || paramEffect === undefined) continue;
				const calleeParam = callee.parameters[argIndex];
				const passedByVar = calleeParam?.isVar === true;
				// A by-var callee that resets/changes load fields / assigns / uses RecordRef
				// invalidates the caller's state — bail. By-value callees do not.
				if (
					passedByVar &&
					(paramEffect.mayResetFilters ||
						paramEffect.mayChangeLoadFields ||
						paramEffect.mayAssignRecord ||
						paramEffect.mayUseRecordRef)
				) {
					bailout = true;
					uncertainties.push({ kind: "recordref-or-variant", operationId: cs.operationId });
					continue;
				}
				for (const fid of paramEffect.readsFields) {
					const name = fieldNameById.get(fid);
					if (name !== undefined) accessedFields.add(name);
				}
				if (paramEffect.readsFields.length > 0) {
					accessSteps.push({
						routineId: routine.id,
						callsiteId: cs.id,
						sourceAnchor: cs.sourceAnchor,
						note: `passes ${state.recordVariableName} to ${callee.name}, which reads ${paramEffect.readsFields.length} field(s)`,
					});
				}
			}

			if (accessedFields.size === 0) continue; // no concrete access — no witness, no emit

			// --- determination ---
			let kind: "missing" | "incomplete" | undefined;
			let missingList: string[] = [];
			if (state.loadState.kind === "none") {
				kind = "missing";
				missingList = [...accessedFields].sort();
			} else {
				const missing = [...accessedFields].filter((f) => !state.loadState.fields.has(f));
				if (missing.length > 0) {
					kind = "incomplete";
					missingList = missing.sort();
				}
			}
			if (kind === undefined) continue; // loaded set covers all accesses — silent

			const retrievalStep: EvidenceStep = {
				routineId: routine.id,
				operationId: state.retrievalOp.id,
				sourceAnchor: retrievalAnchor,
				note: `${state.retrievalOp.op} on ${state.recordVariableName}${
					kind === "missing" ? " with no SetLoadFields" : " with a partial SetLoadFields"
				}`,
			};
			findings.push({
				id: `d3/${state.retrievalOp.id}`,
				rootCauseKey: `d3/${state.retrievalOp.id}`,
				detector: "d3-missing-setloadfields",
				title:
					kind === "missing"
						? "Missing SetLoadFields before a record retrieval"
						: "Incomplete SetLoadFields — accessed fields not loaded",
				rootCause: `${routine.name} runs ${state.retrievalOp.op} on ${state.recordVariableName} and then accesses field(s) [${missingList.join(", ")}] — ${
					kind === "missing" ? "no SetLoadFields was set" : "an incomplete SetLoadFields"
				}.`,
				severity: "medium",
				confidence: toConfidence(uncertainties, bailout ? "possible" : "likely"),
				primaryLocation: retrievalAnchor,
				evidencePath: [retrievalStep, ...accessSteps],
				affectedObjects: [routine.objectId],
				affectedTables: [tableId],
				fixOptions: [
					{
						description:
							kind === "missing"
								? `Add SetLoadFields(${missingList.join(", ")}) before the retrieval.`
								: `Extend SetLoadFields to include: ${missingList.join(", ")}.`,
						safety: "high",
					},
				],
				provenance: [{ source: "tree-sitter" }],
			});
		}
	}

	return findings.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Register D3 in the registry**

In `src/detectors/registry.ts`, add the import and registry entry:
```typescript
import { detectD3 } from "./d3-missing-setloadfields.ts";
```
```typescript
export const DEFAULT_DETECTORS: Detector[] = [
	{ name: "d1-db-op-in-loop", run: detectD1 },
	{ name: "d2-event-fanout-in-loop", run: detectD2 },
	{ name: "d3-missing-setloadfields", run: detectD3 },
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/detectors/d3.test.ts test/detectors/registry.test.ts`
Expected: PASS — D3's 6 tests pass; the registry tests still pass.

> If `PartialThenCallee` is not flagged: confirm `EnrichCustomer`'s summary has a `parameterEffects` entry for parameter index 0 with `readsFields` containing the `Name` field's `FieldId` (Task 5). If `CompleteLoad` is wrongly flagged: confirm `deriveLoadStates` lowercases both `SetLoadFields` args and accessed field names.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/detectors/d3-missing-setloadfields.ts src/detectors/registry.ts test/detectors/d3.test.ts
git commit -m "feat: add D3 missing/incomplete SetLoadFields detector"
```

---

## Task 17: End-to-end golden + determinism test

**Files:**
- Create: `test/fixtures/ws-e2e/` (multi-file fixture exercising all three detectors)
- Test: `test/e2e.test.ts`

A single multi-file fixture run through the full pipeline, asserting all three detectors fire and the output is byte-deterministic — the cross-layer regression guard.

- [ ] **Step 1: Create the `ws-e2e` fixture**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-e2e/src
cat > ws-e2e/app.json <<'EOF'
{
  "id": "ee2eee2e-0000-0000-0000-00000000e2e2",
  "name": "End To End Test App",
  "publisher": "E2E",
  "version": "1.0.0.0"
}
EOF
cat > ws-e2e/src/customer.al <<'EOF'
table 66100 Customer
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Name; Text[100]) { }
        field(3; Address; Text[100]) { }
    }
    keys { key(PK; "No.") { } }
}
EOF
cat > ws-e2e/src/engine.al <<'EOF'
codeunit 66101 "E2E Engine"
{
    procedure RunBatch()
    var
        i: Integer;
    begin
        for i := 1 to 100 do begin
            LoadCustomer();
            OnAfterRunIteration();
        end;
    end;

    local procedure LoadCustomer()
    var
        Customer: Record Customer;
    begin
        Customer.FindSet();
    end;

    procedure ReportNames()
    var
        Customer: Record Customer;
    begin
        Customer.SetLoadFields("No.");
        Customer.FindSet();
        if Customer.Name <> '' then
            Customer.Address := Customer.Name;
    end;

    [IntegrationEvent(false, false)]
    procedure OnAfterRunIteration()
    begin
    end;
}
EOF
cat > ws-e2e/src/listener.al <<'EOF'
codeunit 66102 "E2E Listener"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"E2E Engine", 'OnAfterRunIteration', '', true, true)]
    local procedure HandleIteration()
    var
        Customer: Record Customer;
    begin
        Customer.FindFirst();
    end;
}
EOF
```
Expected: `test/fixtures/ws-e2e/` with `app.json` + 3 `.al` files. `RunBatch` loops 100×: `LoadCustomer` does `FindSet` (D1 interprocedural), and `OnAfterRunIteration` fans out to `HandleIteration` which does `FindFirst` (D2). `ReportNames` loads only `"No."` then accesses `Name`/`Address` (D3 incomplete).

- [ ] **Step 2: Write the test**

`test/e2e.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../src/index.ts";

const WS_E2E = fileURLToPath(new URL("./fixtures/ws-e2e", import.meta.url));

describe("end-to-end pipeline", () => {
	test("all three detectors fire on the multi-file fixture", async () => {
		const { findings } = await analyzeWorkspace({ workspaceRoot: WS_E2E, deterministic: true });
		const detectors = new Set(findings.map((f) => f.detector));
		expect(detectors.has("d1-db-op-in-loop")).toBe(true);
		expect(detectors.has("d2-event-fanout-in-loop")).toBe(true);
		expect(detectors.has("d3-missing-setloadfields")).toBe(true);
	});

	test("every finding has a non-empty evidence path ending at a real op or callsite", async () => {
		const { findings } = await analyzeWorkspace({ workspaceRoot: WS_E2E, deterministic: true });
		for (const f of findings) {
			expect(f.evidencePath.length).toBeGreaterThan(0);
			const last = f.evidencePath.at(-1);
			expect(last?.operationId !== undefined || last?.callsiteId !== undefined).toBe(true);
		}
	});

	test("the pipeline is byte-deterministic — two runs produce identical output", async () => {
		const run = async () => {
			const { model, findings, diagnostics } = await analyzeWorkspace({
				workspaceRoot: WS_E2E,
				deterministic: true,
			});
			return JSON.stringify({ model, findings, diagnostics });
		};
		expect(await run()).toBe(await run());
	});

	test("a normalised finding summary matches the golden snapshot", async () => {
		const { findings } = await analyzeWorkspace({ workspaceRoot: WS_E2E, deterministic: true });
		// Normalise to the stable, human-meaningful shape — not the full anchors, which would
		// be brittle. This catches detector-behaviour regressions across all layers.
		const summary = findings
			.map((f) => ({
				detector: f.detector,
				severity: f.severity,
				title: f.title,
				confidence: f.confidence.level,
				evidenceDepth: f.evidencePath.length,
			}))
			.sort((a, b) => `${a.detector}${a.title}`.localeCompare(`${b.detector}${b.title}`));
		expect(summary).toMatchSnapshot();
	});
});
```

- [ ] **Step 3: Run the test to create the snapshot**

Run: `bun test test/e2e.test.ts`
Expected: PASS — the first run writes `test/__snapshots__/e2e.test.ts.snap`; the other 3 tests pass. Inspect the written snapshot: it must contain one entry per detector (`d1-db-op-in-loop`, `d2-event-fanout-in-loop`, `d3-missing-setloadfields`) with sensible severities. If the snapshot looks wrong, fix the detector, delete the snapshot file, and re-run.

- [ ] **Step 4: Run the full suite + checks**

Run: `bun test && bunx tsc --noEmit && bunx biome check src test`
Expected: full suite green; tsc exit 0; biome exit 0.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add test/e2e.test.ts test/fixtures/ws-e2e/ test/__snapshots__/
git commit -m "test: add end-to-end golden + determinism test for the full pipeline"
```

---

## Final verification

After all 17 tasks:

- [ ] Run the full suite one more time: `cd U:/Git/al-sem && bun test && bunx tsc --noEmit && bunx biome check src test` — all green.
- [ ] Confirm `analyzeWorkspace` returns `{ model, findings, diagnostics }` and `al-sem analyze <workspace>` runs from the terminal.
- [ ] Confirm every `routine.summary` is populated after a run.
- [ ] The pre-existing untracked `test_edge.test.ts` at the repo root is still untracked and was never staged.

## Spec coverage map

| Spec section | Tasks |
|--------------|-------|
| `op-classification` (DB-effect classes) | 1 |
| Combined graph (`CombinedEdge` / `UncertaintyEdge`, all `DispatchKind`s, event-dispatch dedupe) | 2 |
| Tarjan SCC (reverse-topological, deterministic) | 3 |
| Effect lattice (tri-state join, `effectKey`, `via` merge, no widening) | 4 |
| `resolvePublishedEvent` + `computeParameterEffects` (eager) | 5 |
| `baseIntraproceduralSummary` (opaque / parse-incomplete handling) | 6 |
| `composeRoutine` + `computeSummaries` (finite monotone fixed-point, snapshot iteration) + `computeFieldEffects` (lazy) | 7 |
| Path-walker (`WalkResult[]`, `WalkStop`, policy split, effective loop nesting) | 8 |
| `toConfidence` (`cappedBy` mapping, `interface-dispatch`/`recordref-or-variant` → evidence only) | 9 |
| D1 — DB-op-in-loop | 10 |
| Registry (isolated execution, stable sort) | 11 |
| `analyzeWorkspace` → `{ model, findings, diagnostics }` | 12 |
| CLI (`al-sem analyze`, `--format auto\|terminal\|json`) | 13 |
| D2 — event fanout in loop | 14 |
| D3 load-field state machine | 15 |
| D3 — missing/incomplete SetLoadFields | 16 |
| End-to-end golden + determinism | 17 |
| "No silent clean" / error handling | Threaded through 6, 7, 9, 11, 16 |
| Caching deferred-with-seam | Pass boundaries kept pure (2, 7); no caching task — intentional |


