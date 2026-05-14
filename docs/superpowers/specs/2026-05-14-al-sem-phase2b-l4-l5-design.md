# al-sem Phase 2b — L4 Summary Engine + L5 Detectors + CLI — Design

**Date:** 2026-05-14
**Status:** Approved — revised after gpt-5.5 design review (6 Critical + 7 Important issues folded in)
**Parent spec:** `2026-05-14-al-sem-semantic-engine-design.md` (the overall engine design — this document specifies the Phase 2b sub-project: L4 + L5 + CLI)
**Predecessors:** Phase 1 (`2026-05-14-al-sem-phase1-foundation.md`), Phase 2a (`2026-05-14-al-sem-phase2a-resolver-graphs.md`) — both complete.

---

## Goal

Complete the al-sem static analysis engine: build the **L4 interprocedural summary engine** and **path-walker**, the **L5 detectors** (D1/D2/D3), and a **CLI surface** — so `analyzeWorkspace` returns end-to-end `{ model, findings, diagnostics }` and `al-sem analyze` runs from the terminal.

## Scope

**In scope (Phase 2b):**
- L4 summary engine: combined-graph construction, Tarjan SCC, topological bottom-up composition, in-SCC finite monotone fixed-point → `RoutineSummary` per routine.
- L4 path-walker: shared bounded-traversal primitive used by all detectors.
- L5 detectors: D1 (DB-op-in-loop), D2 (event-fanout-in-loop), D3 (missing/incomplete SetLoadFields), plus an isolated-execution registry.
- Library API: `analyzeWorkspace` return type widens to `{ model, findings, diagnostics }`.
- CLI: `al-sem analyze <workspace>` with terminal + JSON output.

**Deferred (with seam kept):**
- **Caching** — parse cache + summary cache. Phase 2b recomputes every run; pass boundaries and hash keys (`schemaVersion`, combined-graph hash) are kept available so a cache layer wraps `computeSummaries` / `buildCombinedGraph` later without touching their internals.
- **MCP surface** — Phase 3. The CLI and library API are stable enough that MCP is pure presentation over them.
- **CI gating** — a threshold-driven non-zero exit code on `al-sem analyze` is a deliberate fast-follow, not Phase 2b.
- Everything the parent spec already defers (interface narrowing, report dataitem ordering, external-source downloader, incremental re-index).

## Implementation ordering

The plan sequences tasks so D3's complexity never blocks the foundation: **(1)** L4 core — `combined-graph`, `scc`, `effect-lattice`, `summary-engine`, `path-walker`; **(2)** D1 + registry + CLI + JSON; **(3)** D2; **(4)** D3. This is one Phase 2b plan, but the task order reflects this gating.

## Architecture

Phase 2b adds two layers on top of the completed Phase 2a `SemanticModel`.

### Module structure

```
src/
  engine/
    combined-graph.ts   — unify callGraph + eventGraph into one CombinedGraph + uncertainty records
    scc.ts              — Tarjan SCC over the CombinedGraph → SCCs in reverse-topological order
    effect-lattice.ts   — tri-state join, table-set union, effectKey + via merge (pure ops)
    summary-engine.ts   — bottom-up composition + in-SCC finite monotone fixed-point
    op-classification.ts — RecordOpType → effect class table (DB-read / DB-write / DB-lock / state-only / trigger)
    path-walker.ts      — shared bounded-traversal primitive (mechanics; policy is detector-supplied)
  detectors/
    registry.ts         — ordered detector list + isolated execution (one throw ≠ dead run)
    confidence.ts       — Uncertainty[] → FindingConfidence (cappedBy mapping + cap reasons)
    d1-db-op-in-loop.ts
    d2-event-fanout-in-loop.ts
    d3-missing-setloadfields.ts
  cli/
    index.ts            — commander entry: `al-sem analyze <workspace>`
    format-terminal.ts  — human output
    format-json.ts      — { model, findings, diagnostics } as JSON
```

**Boundary discipline:** `engine/` depends on `model/` + `graph/` only; `detectors/` depend on `engine/` + `model/`; `cli/` depends on the library API only. `engine/` modules expose pure functions (no I/O, deterministic) and keep helper functions local and testable — a module like `summary-engine.ts` legitimately has several helpers (base summary, composition, fixed-point, field effects).

### Data flow

```
analyzeWorkspace
  → indexWorkspace            (Phase 1 + 2a: SemanticIndex)
  → resolveModel              (Phase 2a: SemanticModel — callGraph, eventGraph, coverage)
  → buildCombinedGraph        (NEW: CombinedGraph)
  → computeSummaries          (NEW: mutates routine.summary in place)
  → runDetectors              (NEW: Finding[])
  → return { model, findings, diagnostics }
```

`indexWorkspace` is untouched. The summary engine + detectors are added to `analyzeWorkspace` only.

## Component design

### L4 — Combined graph (`engine/combined-graph.ts`)

Builds one `CombinedGraph` from the Phase 2a model. Nodes = routines. The graph carries two things: **resolved routine→routine edges** (`CombinedEdge[]`) and **uncertainty records** (because `CallEdge` has no `uncertainty` field — uncertainty lives here, not on the model edge).

```ts
// internal to engine/ — NOT a model/ type
interface CombinedEdge {
  from: RoutineId;
  to: RoutineId;
  kind: "direct" | "method" | "codeunit-run" | "report-run" | "page-run"
      | "interface" | "implicit-trigger" | "event-dispatch" | "dynamic";
  callsiteId?: CallsiteId;     // present for call-derived edges
  operationId?: OperationId;   // present for call-derived edges
  eventId?: EventId;           // present for event-dispatch edges
  subscriberAppId?: string;    // present for event-dispatch edges
  resolution: ResolutionQuality | "resolved" | "maybe" | "unknown"; // from the source edge
}

interface UncertaintyEdge {
  from: RoutineId;
  uncertainty: Uncertainty;    // unresolved-call / interface-dispatch / dynamic-dispatch / recordref-or-variant
}

interface CombinedGraph {
  nodes: RoutineId[];                         // sorted
  edgesByFrom: Map<RoutineId, CombinedEdge[]>; // each list sorted (see Determinism)
  uncertaintyEdges: UncertaintyEdge[];        // sorted
}
```

**Edge sources:**

1. **Call edges** — every `callGraph` `CallEdge` with `to` defined becomes a `CombinedEdge` whose `kind` mirrors `CallEdge.dispatchKind`: `direct`, `method`, `codeunit-run`, `report-run`, `page-run`, `implicit-trigger`, `interface` (when `to` exists — `resolution` carried through, usually `maybe`), `dynamic` (when `to` exists). `CallEdge`s whose `dispatchKind` is `event-dispatch` are **excluded here** — event-dispatch edges are generated once from the event graph (next item) to avoid double-counting if Phase 2a ever emits them in `callGraph`.
2. **Event-dispatch edges** — for each `EventSymbol` with a `publisherRoutineId`, and each `EventEdge` with the matching `eventId`, emit a `CombinedEdge` `publisherRoutineId → subscriberRoutineId`, `kind: "event-dispatch"`, carrying `eventId`, `subscriberAppId`, and the `EventEdge.resolution`. (Raising an event in AL is a direct call to the publisher procedure — already a call edge above; this edge is the publisher-procedure → subscriber hop.)
3. **Interface "may-call" edges** — none materialise from current Phase 2a output (interface resolution deferred); the build path leaves the seam.

**Uncertainty records** — for every `callGraph` `CallEdge` with **no** `to`:
- `dispatchKind: "unresolved"` → `UncertaintyEdge { from, { kind: "unresolved-call", callsiteId } }`
- `dispatchKind: "interface"` → `{ kind: "interface-dispatch", callsiteId }`
- `dispatchKind: "dynamic"` → `{ kind: "dynamic-dispatch", operationId }`
These create **no graph edge**, but the summary engine reads them so the `from` routine's summary gets the correct typed `Uncertainty` and `hasUnresolvedCalls`.

### L4 — Tarjan SCC (`engine/scc.ts`)

Tarjan's algorithm over the `CombinedGraph`. Returns SCCs in **reverse-topological order** of the condensation (callees before callers — what bottom-up composition consumes). A cyclic call/event/trigger graph is normal, not an error. A self-edge marks a singleton SCC as recursive. Traversal visits `nodes` in sorted order and `edgesByFrom` lists are pre-sorted, so the SCC list and member order are deterministic. Within each SCC, members are returned sorted by `RoutineId`.

### L4 — Operation classification (`engine/op-classification.ts`)

A pure `classifyOp(op: RecordOpType): OpEffectClass` table — **the** guard against D1 false-positives. Not every `RecordOpType` is a database round-trip.

| Class | `RecordOpType` values | Drives |
|-------|----------------------|--------|
| `db-read` | `FindSet`, `FindFirst`, `FindLast`, `Find`, `Get`, `Next`, `Count`, `CountApprox`, `IsEmpty`, `CalcFields`, `CalcSums` | `touchesDb`, `DbEffect` |
| `db-write` | `Modify`, `ModifyAll`, `Insert`, `Delete`, `DeleteAll` | `touchesDb`, `writesTables`, `DbEffect` |
| `db-lock` | `LockTable` | `touchesDb`, `DbEffect` (low severity in D1) |
| `state-only` | `SetLoadFields`, `AddLoadFields`, `SetRange`, `SetFilter`, `SetCurrentKey`, `Reset`, `Copy`, `TransferFields` | **not** `touchesDb`; consumed by D3's load-field state machine and by `parameterEffects` |
| `trigger` | `Validate` | **not** a direct `DbEffect` — its effects arrive through the Phase 2a `implicit-trigger` edge |

`touchesDb: "yes"` is driven only by `db-read` ∪ `db-write` ∪ `db-lock` ops (and propagated callee summaries). `commits` comes from `OperationSite.kind === "commit"`, never from `RecordOpType`.

### L4 — Effect lattice (`engine/effect-lattice.ts`)

Pure, separately-tested join / union / dedup operations.

- **Tri-state order** for `EffectPresence`: `no < unknown < yes`. `yes` is the most informative ("a real DB effect is known"). Join takes the max. Monotone.
- **`writesTables` union**: `TableId[]` set union; `"unknown"` absorbs (`union(x, "unknown") = "unknown"`).
- **`effectKey` construction** — stable, path-insensitive, **excludes `via`**: `effectKey = ${op}|${tableId ?? "unknown"}|${operationId}|${tempStateKey(tempState)}`, where `tempStateKey` normalises `TempState` to `"t" | "f" | "u" | "p${index}"`. Two `DbEffect`s with the same `effectKey` are the same fact regardless of how they propagated.
- **`dbEffects` merge**: concatenate, group by `effectKey`, keep one entry per key; `via` is merged by precedence `direct > implicit-trigger > event-subscriber > dynamic > inherited` (most specific wins). `via` is explanatory metadata — no detector's correctness depends on it.
- **No widening.** The lattice is finite (tri-state, table-sets bounded by known tables ∪ `"unknown"`, `dbEffects` bounded by stable `effectKey`, uncertainties bounded by syntactic sites) and all joins are monotone and idempotent, so the fixed-point converges on its own. An iteration cap exists only as a bug-guard — exceeding it emits a `Diagnostic(stage: "summarize")` and stops.

### L4 — Summary engine (`engine/summary-engine.ts`)

`computeSummaries(model, combinedGraph)` walks SCCs leaves-first and mutates each `routine.summary` in place (the mutation pattern Phase 2a's `resolveRecordTypes` established).

**`baseIntraproceduralSummary(routine)`** — the seed, recomputed every composition pass (never inherited from a previous pass, so opaque/parse-incomplete facts can never be silently overwritten):
- `db-read`/`db-write`/`db-lock` `recordOperations` → `DbEffect`s with `via: "direct"`; `touchesDb` set accordingly; `db-write` ops → `writesTables`.
- `OperationSite`s with `kind === "commit"` → `commits: "yes"`.
- `OperationSite`s with `kind === "event-publish"` → `publishesEvents`, resolved via the shared helper `resolvePublishedEvent(operationId, model)`: `operationId` → `CallEdge` with that `operationId` → `CallEdge.to` (publisher routine) → `EventSymbol` with matching `publisherRoutineId` → `EventSymbol.id`.
- `parseIncomplete` routine → `uncertainties += { kind: "parse-incomplete", routineId }`, `touchesDb: "unknown"`, `commits: "unknown"`, `hasUnresolvedCalls: true`.
- Opaque routine (`bodyAvailable: false`) → `touchesDb: "unknown"`, `commits: "unknown"`, `hasUnresolvedCalls: true`. **No `opaque-callee` uncertainty on its own summary** — that uncertainty needs a `callsiteId`, which only the caller has (see composition below).
- `parameterEffects` — computed eagerly (see the dedicated subsection).

**`composeRoutine(routine, lookup)`** — starts from `baseIntraproceduralSummary(routine)`, then folds in every outgoing `CombinedEdge`:
- Look up the callee summary via `lookup` (final summary for callees outside the SCC; the current iteration's in-progress summary for callees inside the SCC, including self-edges).
- `touchesDb`/`commits` joined; `writesTables` unioned; callee `dbEffects` merged in with `via` set from the edge `kind` (`event-dispatch → "event-subscriber"`, `implicit-trigger → "implicit-trigger"`, `dynamic → "dynamic"`, otherwise `"inherited"`); callee `publishesEvents` unioned; callee `uncertainties` unioned.
- If the edge `kind` is `interface` or `dynamic`, or the callee is opaque (`hasUnresolvedCalls` true with no body): add `{ kind: "opaque-callee", callsiteId }` (the caller has the `callsiteId`), set `hasUnresolvedCalls: true`, push `touchesDb` toward `"unknown"` if not already `"yes"`.
- Fold every `UncertaintyEdge` whose `from` is this routine into `uncertainties` and set `hasUnresolvedCalls: true`.

**Per SCC:**
- **Singleton, no self-loop:** one `composeRoutine` call — all callees already final.
- **Real cycle (SCC > 1, or singleton with self-loop):** initialise every member's in-progress summary to `baseIntraproceduralSummary`; iterate — each pass recomputes every member (in sorted order) with `composeRoutine` reading the **previous pass's snapshot** for in-SCC callees (snapshot iteration, deterministic); stop when no member's summary changes. All members get `inRecursiveCycle: true`.

**`parameterEffects` (eager) — derivation table.** For each `ParameterSymbol` that is a record parameter, build a `ParameterEffectSummary`:
| Field | Source |
|-------|--------|
| `tableId` | the parameter's `RecordVariable.tableId` (resolved in Phase 2a); `"unknown"` if unresolved |
| `readsFields` | `FieldAccess` entries whose `recordVariableName` matches the parameter's `RecordVariable.name` (case-insensitive), `fieldName` resolved to `FieldId` via the table's `fields`; unresolved field name → contributes a `recordref-or-variant`-class bailout for D3, not a silent drop |
| `writesFields` | `Validate` `recordOperations` on the parameter record with a resolvable field argument |
| `mayResetFilters` | a `Reset` op (or `Copy`) on the parameter record |
| `mayChangeLoadFields` | a `SetLoadFields` / `AddLoadFields` / `Reset` op on the parameter record |
| `mayAssignRecord` | a `Copy` / `TransferFields` op on the parameter record |
| `mayUseRecordRef` | the parameter (or a variable aliased to it) has `ParameterSymbol.typeText` of `RecordRef` / `FieldRef` / `Variant` — detectable from the existing `typeText` field |

`fieldEffects` stays **lazy**: the engine exports `computeFieldEffects(routineId): FieldEffectSet`; D3 calls it on demand; `summary.fieldEffects` is `undefined` otherwise.

**Output invariant:** every `routine.summary` is populated; summaries store **compact de-duped facts only**, never evidence paths.

### L4 — Path-walker (`engine/path-walker.ts`)

The "shared mechanics, detector-specific policy" approach. The walker provides the mechanics; each detector supplies a `WalkPolicy`.

**Shared mechanics:**
- **Bounded traversal** — max depth + max-nodes budget.
- **Cycle detection** — visited-set on the current path; revisiting a node stops that branch.
- **Uncertainty accumulation** — every `Uncertainty` on summaries and `UncertaintyEdge`s along a path is collected.
- **Effective loop nesting** — the walker threads an *inherited loop stack* through the path: descending `R → S` via a `CombinedEdge` adds the originating `CallSite.loopStack` to the inherited context; at the terminal, effective nesting = inherited depth + the terminal op's own `loopStack` length.
- **Multiple results** — `walkEvidence` returns `WalkResult[]` (one per distinct witness path found, sorted deterministically), not a single result — D1 may reach several DB ops, D2 several subscribers, D3 several field reads.

**Detector-supplied policy (`WalkPolicy`):**
```ts
interface WalkPolicy {
  terminalsAt(node: RoutineId, ctx: PathCtx): Terminal[];     // real op sites at this node
  expand(node: RoutineId, ctx: PathCtx): CombinedEdge[];      // which outgoing edges to follow
  buildHopStep(edge: CombinedEdge, ctx: PathCtx): EvidenceStep;
  buildTerminalStep(t: Terminal, ctx: PathCtx): EvidenceStep;
}
```

**Result:**
```ts
type WalkStop = "complete" | "cycle-cut" | "depth-cut" | "node-budget-cut" | "dead-end";
interface WalkResult {
  path: EvidenceStep[];
  effectiveLoopDepth: number;
  uncertainties: Uncertainty[];
  stop: WalkStop;          // detectors emit only on "complete"
}
```

`walkEvidence(start, policy, bounds, combinedGraph, model) → WalkResult[]`. Pure — no I/O. Detectors emit a `Finding` only from a `WalkResult` with `stop === "complete"` — "no complete path, no trust." A non-`complete` stop is not an error; the uncertainty it accumulated stays inspectable in summaries / `AnalysisCoverage`.

### L5 — Confidence mapping (`detectors/confidence.ts`)

`FindingConfidence.cappedBy` only accepts `"unresolved-call" | "opaque-callee" | "dynamic-dispatch" | "parse-incomplete" | "version-mismatch"`. `Uncertainty` has additional kinds (`interface-dispatch`, `recordref-or-variant`). `toConfidence(uncertainties, baseLevel): FindingConfidence`:
- Any uncertainty → cap `level` at `possible`.
- Uncertainty kinds that *are* valid `cappedBy` values → listed in `cappedBy`.
- Uncertainty kinds that are *not* (`interface-dispatch`, `recordref-or-variant`) → still cap to `possible`, and their reason goes into `confidence.evidence` (and the relevant `EvidenceStep.note`), never as an invalid `cappedBy` string.
- No uncertainty → `level` is the detector's `baseLevel`, never above `likely` (static-only analysis).

### L5 — Detectors

Each detector is one file, a pure query over the summarised `SemanticModel` + `CombinedGraph`, using the path-walker with its own `WalkPolicy`. All emit the same `Finding` shape, all are capped at `likely` (static-only), all require a real `evidencePath` — **a detector that cannot build a complete path emits nothing.**

**D1 — interprocedural DB-op-in-loop (`d1-db-op-in-loop.ts`)**
- *Trigger:* a `LoopNode` in a body-available routine.
- *Prune:* for each `CallSite` whose `loopStack` includes that loop, check callee `summary.touchesDb !== "no"`; direct in-loop `RecordOperation`s of class `db-read`/`db-write`/`db-lock` are caught too (state-only / trigger ops never trigger D1).
- *Walk:* `WalkPolicy.expand` follows `CombinedEdge`s where the callee `summary.touchesDb !== "no"`; `terminalsAt` recognises a `db-read`/`db-write`/`db-lock` `RecordOperation`. `EvidenceStep[]` = loop → call → … → DB op.
- *Finding:* severity by op class (`FindSet` / `CalcFields` / `Modify` worst; `LockTable` low), raised by effective loop nesting. `tempState` known-`true` → drop to `info` (temp ≠ SQL round-trip). `parameter-dependent` / `unknown` `tempState` is **not** an `Uncertainty.kind` — it does not go in `cappedBy`; it is noted in the `EvidenceStep.note` / finding text and keeps the finding. Confidence via `toConfidence(walkResult.uncertainties, "likely")`.

**D2 — event fanout in loop (`d2-event-fanout-in-loop.ts`)**
- *Trigger:* an `OperationSite` with `kind === "event-publish"` inside a `LoopNode`.
- *Resolve the event:* `OperationSite.id` → `resolvePublishedEvent(operationId, model)` → `EventSymbol` → its `event-dispatch` `CombinedEdge`s give the subscribers.
- *Prune:* check each subscriber's `summary.touchesDb` / `writesTables` / `commits`.
- *Walk:* loop → publish site → each DB-touching subscriber → its effect (cross-app subscribers included).
- *Finding:* one per hot event. `subscriberAppId` (extension attribution) goes in the subscriber's `EvidenceStep.note`; subscriber object IDs go in `affectedObjects`; subscriber-touched tables in `affectedTables`. Confidence drops to `possible` when an `EventEdge.resolution !== "resolved"`, a subscriber `Routine.bodyAvailable === false` (opaque), or a subscriber summary carries uncertainty — via `toConfidence`.

**D3 — interprocedural missing/incomplete SetLoadFields (`d3-missing-setloadfields.ts`)**

The highest-risk detector — built against the *actual* model (no `loadFields` field exists on `RecordOperation`), with a deliberately narrow MVP contract.

- *Derived load-field state.* The MVP has no per-site load state; D3 reconstructs it by walking `features.recordOperations` **in source order** (ordered by `SourceAnchor.range.start`) per `recordVariableName`: `SetLoadFields` → loaded set = resolved `fieldArguments`; `AddLoadFields` → union; `Reset` / `Copy` / `TransferFields` / record assignment → state invalidated → **bailout**.
- *Trigger:* `FindSet` / `FindFirst` / `FindLast`. `Get` is included **only** when the derived state machine has a defined loaded set at that site; otherwise `Get` is deferred.
- *Field-access analysis:*
  - *Same-routine:* `FieldAccess` entries on the retrieved record variable after the retrieval (source order), `fieldName` resolved to `FieldId` via the record's `tableId`.
  - *Cross-routine:* only **directly-resolved** callees, and only where the caller argument is a **simple identifier** matching a caller `RecordVariable.name` (no expressions, member chains, globals, aliases). Bind that argument position to the callee's `ParameterEffectSummary` (matching `parameterIndex`); the callee's `readsFields` count as accesses. A by-`var` callee's `mayResetFilters` / `mayChangeLoadFields` / `mayAssignRecord` / `mayUseRecordRef` invalidates the caller's state after the call; for a by-value parameter, callee load-state changes do **not** invalidate the caller.
  - Distinguish *missing* `SetLoadFields` (no loaded set, fields accessed) vs *incomplete* (loaded set ⊊ accessed set).
- *Conservative bailouts — record uncertainty, do not falsely claim "clean":* `RecordRef` / `FieldRef` / `Variant` / `Any` touching the record (detected via `ParameterSymbol.typeText`); interface dispatch or unresolved calls in the dataflow; invalidation ops (`Reset`, `Copy`, record assignment, `TransferFields`, or a callee flagged `mayResetFilters` / `mayChangeLoadFields` / `mayAssignRecord` / `mayUseRecordRef`); unresolved table or field name.
- *Emit contract (resolves the "complete path only" vs "possible" tension):*
  - A finding is emitted **only** when there is a concrete retrieval with a provably *missing or incomplete* loaded set **and** a concrete resolved field access — i.e. a complete witness path.
  - If that complete witness exists **and** a bailout construct also appears elsewhere in the same dataflow, the finding is still emitted but capped at `possible`, and the evidence path ends at the concrete access (the bailout is noted).
  - If a bailout construct *prevents* proving any concrete missing/incomplete access, **no finding is emitted** — the uncertainty is recorded in `summary.uncertainties` and `AnalysisCoverage`, and D3 may emit a `Diagnostic(stage: "detect")`. D3 never claims "complete SetLoadFields" when unresolved paths exist.
- *MVP-excluded* (per the parent spec's D3 contract): field reads inside event subscribers, field reads from table triggers reached via `Validate`, field reads in base-app / opaque helpers, alias analysis beyond direct argument binding, complex record assignment flows.

**Registry (`detectors/registry.ts`)** — an ordered detector list with **isolated execution**: each detector runs inside try/catch; a throw emits a `Diagnostic` (stage `detect`) and the other detectors still run. The combined `Finding[]` is sorted by a stable key — `(detector, primaryLocationKey, rootCauseKey)`, where `primaryLocationKey` serialises `SourceAnchor` to a comparable `sourceUnitId:startLine:startColumn` string.

### CLI surface (`src/cli/`)

`commander`-based, mirroring al-perf conventions. One command:

```
al-sem analyze <workspace> [--alpackages <dir>] [--format <auto|terminal|json>] [--deterministic]
```

- `--format` defaults to **auto** — TTY → terminal, pipe → json (mirrors al-perf's `--format auto`).
- `--deterministic` pins `createdAt` for byte-stable output (already an `AnalyzeWorkspaceOptions` flag).
- `format-terminal.ts` — a coverage summary line ("N files, M partially parsed, K packages skipped"), then findings grouped by severity (title, location, evidence path, fix options), then a diagnostics summary. Never prints "no issues found" without also showing the coverage / uncertainty summary.
- `format-json.ts` — the full `{ model, findings, diagnostics }` triple (al-perf consumes the model).
- `analyze` exits 0 whenever analysis *ran* — findings are output, not exit codes. CI gating is a deliberate fast-follow.

## Pipeline integration

`analyzeWorkspace`'s return type widens: `{ model, diagnostics }` → `{ model, findings, diagnostics }` (`findings: Finding[]`). The change is **additive for destructuring consumers** — existing `{ model }` / `{ diagnostics }` destructures keep working; callers that annotated the old exact return type update their annotation. The new steps (`buildCombinedGraph` → `computeSummaries` → `runDetectors`) slot in after `resolveModel`.

## Error handling & degradation

Extends Phase 2a's "produce a partial model, never crash":

- **Opaque / parse-incomplete routines** never become silently "clean" — `touchesDb: "unknown"` + `hasUnresolvedCalls: true`; parse-incomplete adds a `parse-incomplete` `Uncertainty` to its own summary; opaque-callee `Uncertainty` is added by callers (which hold the `callsiteId`).
- **Fixed-point always terminates** — finite monotone lattice; an iteration cap is a bug-guard that emits `Diagnostic(stage: "summarize")` if hit.
- **Detector isolation** — registry try/catch per detector → `Diagnostic` stage `detect`. Summary-engine failures → stage `summarize`.
- **No complete path → no emit** — a detector that cannot build a full witness path emits nothing; the accumulated uncertainty stays in summaries / `AnalysisCoverage`.
- **No silent "clean"** — absence of a finding ≠ absence of a problem. `AnalysisCoverage` and typed `Uncertainty` carry the structured record of which regions were not analysed.

## Determinism

Identical input must yield byte-identical serialised output. Every derived collection has a canonical order, not just `Finding[]`:
- **CombinedGraph:** `nodes` sorted by `RoutineId`; each `edgesByFrom` list sorted by `(kind, callsiteId ?? operationId ?? eventId, to)`; `uncertaintyEdges` sorted by `(from, kind, callsiteId ?? operationId ?? routineId)`.
- **SCC:** member lists sorted by `RoutineId`; SCC processing order is the deterministic reverse-topological order from Tarjan over the sorted graph.
- **Fixed-point:** snapshot iteration, members composed in sorted order.
- **`RoutineSummary` arrays:** `writesTables` sorted ascending (unless `"unknown"`); `dbEffects` sorted by `(effectKey, operationId)`; `publishesEvents` sorted; `uncertainties` sorted by `(kind, callsiteId ?? operationId ?? routineId)`; `parameterEffects` sorted by `parameterIndex`; `readsFields` / `writesFields` sorted.
- **`Finding[]`:** sorted by `(detector, primaryLocationKey, rootCauseKey)`.

## Testing strategy (TDD)

Test-first, bottom-up, matching the pass pipeline.

**`engine/` unit tests:**
- `op-classification` — every `RecordOpType` maps to the expected class; `state-only` ops do not drive `touchesDb`.
- `combined-graph` — call edges with `to` become `CombinedEdge`s with the right `kind`; `callGraph` `event-dispatch` edges excluded; event-dispatch edges generated once from the event graph with `eventId`/`subscriberAppId`; `to`-less edges become `UncertaintyEdge`s of the right kind; output sorted.
- `scc` — Tarjan correctness; cyclic graph handled; a **recursive-via-event fixture** produces one SCC; reverse-topological order; deterministic member order.
- `effect-lattice` — tri-state join (`no < unknown < yes`), `writesTables` union incl. `"unknown"` absorption, `effectKey` construction (path-insensitive, `via`-excluded), `dbEffects` dedupe + `via` precedence merge.
- `summary-engine` — `baseIntraproceduralSummary` re-seeded each pass; composition correctness; tri-state effects correct; opaque callee → caller's summary gets `opaque-callee` uncertainty *with the callsiteId*, opaque routine's own summary does **not**; `parameterEffects` derivation table correct field-by-field; `fieldEffects` computed only when `computeFieldEffects` is called; fixed-point converges on the recursive-via-event fixture and is deterministic; **summaries contain no path data**.

**`path-walker` unit tests:** bound enforcement (depth + node budget → correct `stop` value), cycle stop (`cycle-cut`), uncertainty accumulation, effective-loop-nesting math, multiple-result enumeration, `complete` vs non-`complete` stop.

**`confidence` unit tests:** valid `cappedBy` kinds pass through; `interface-dispatch` / `recordref-or-variant` cap to `possible` but go to `evidence`, not `cappedBy`; no uncertainty → `baseLevel`.

**Detector unit tests** — each detector: known-positive emits, known-negative emits nothing, evidence path complete and ends at the real op site, effective loop nesting correct. Plus the parent spec's negative-control false-positive cases:
- temp record in loop → D1 emits `info`, not `critical`.
- `parameter-dependent` temp state → D1 keeps the finding, notes it in `EvidenceStep.note`, does **not** put it in `cappedBy`.
- a loop containing only `SetRange` / `SetLoadFields` (state-only ops) → D1 silent.
- event with zero DB-touching subscribers → D2 silent.
- complete `SetLoadFields` → D3 silent.
- `RecordRef` access with no provable concrete missing/incomplete access → D3 emits **no finding**, records uncertainty + a `detect` diagnostic (not a crash, not a false "clean").
- a provable incomplete-load + concrete access *with* a `RecordRef` construct elsewhere → D3 emits a `possible` finding.
- `Reset` between `FindSet` and field access → D3 bails (no finding, uncertainty recorded).

**CLI tests:** `analyze` on a fixture project → terminal output contains expected strings; `--format json` → valid JSON with `findings`; `--format` accepts `auto|terminal|json`.

**End-to-end golden test:** full pipeline on a multi-file fixture project → assert the serialised `{ model, findings, diagnostics }` against a snapshot in `test/fixtures/expected/`.

**Determinism test:** run the pipeline twice on the same input, diff the serialised JSON — must be byte-identical.

**Fixtures** — new `.al` files under `test/fixtures/al/`, each isolating one construct: a loop calling a helper that does `FindSet`; a loop with only state-only ops (D1 negative control); a publisher-in-loop; a partial record passed to a callee; `Validate` triggering a table trigger; a recursive cycle through an event; a `RecordRef` access after a partial `FindSet`. `.app` fixtures under `test/fixtures/app/` for cross-app D2 subscriber tests.

## Model types — already defined

All Phase 2b *model* types already exist in `src/model/` from Phase 1 and need **no schema change**:
- `summary.ts` — `RoutineSummary`, `DbEffect`, `ParameterEffectSummary`, `FieldEffectSet`, `Uncertainty`, `EffectPresence`. (`RoutineSummary.publishesEvents` is `string[]` — `EventId` is a string alias; do not import a stronger field type.)
- `finding.ts` — `Finding`, `EvidenceStep`, `FixOption`, `FindingConfidence` (`cappedBy` accepts `unresolved-call` / `opaque-callee` / `dynamic-dispatch` / `parse-incomplete` / `version-mismatch` only), `Diagnostic` (with `summarize` / `detect` stages).
- `entities.ts` — `Routine.summary?: RoutineSummary` is the sink. `RecordOperation` has `fieldArguments?: string[]` and **no** `loadFields` field — D3 derives load state from the operation stream.

New **internal** types introduced by Phase 2b (local to `engine/` / `detectors/`, not in `model/`): `CombinedGraph`, `CombinedEdge`, `UncertaintyEdge`, `OpEffectClass`, `WalkPolicy`, `WalkResult`, `WalkStop`, `PathCtx`, `Terminal`.

## Success criteria

- `analyzeWorkspace` returns `{ model, findings, diagnostics }`; every `routine.summary` is populated.
- Tarjan SCC handles cyclic call/event/trigger graphs; the finite monotone fixed-point converges deterministically on the recursive-via-event fixture.
- `state-only` ops never drive `touchesDb`; D1 stays silent on a loop of pure `SetRange`/`SetLoadFields`.
- Opaque-callee uncertainty is attached by callers (with `callsiteId`), never on the opaque routine's own summary; `cappedBy` only ever contains valid kinds.
- D1/D2/D3 each emit on their known-positive fixtures, stay silent on known-negatives, and produce complete evidence paths ending at the real op site.
- `al-sem analyze <workspace>` runs from the terminal with terminal + JSON output.
- The determinism test passes — byte-identical serialised output across two runs.
- The full test suite is green; `tsc --noEmit` and `biome check` clean.
