# al-sem Phase 2b — L4 Summary Engine + L5 Detectors + CLI — Design

**Date:** 2026-05-14
**Status:** Approved (brainstorming complete)
**Parent spec:** `2026-05-14-al-sem-semantic-engine-design.md` (the overall engine design — this document specifies the Phase 2b sub-project: L4 + L5 + CLI)
**Predecessors:** Phase 1 (`2026-05-14-al-sem-phase1-foundation.md`), Phase 2a (`2026-05-14-al-sem-phase2a-resolver-graphs.md`) — both complete.

---

## Goal

Complete the al-sem static analysis engine: build the **L4 interprocedural summary engine** and **path-walker**, the **L5 detectors** (D1/D2/D3), and a **CLI surface** — so `analyzeWorkspace` returns end-to-end `{ model, findings, diagnostics }` and `al-sem analyze` runs from the terminal.

## Scope

**In scope (Phase 2b):**
- L4 summary engine: combined-graph construction, Tarjan SCC, topological bottom-up composition, in-SCC fixed-point with widening → `RoutineSummary` per routine.
- L4 path-walker: shared bounded-traversal primitive used by all detectors.
- L5 detectors: D1 (DB-op-in-loop), D2 (event-fanout-in-loop), D3 (missing/incomplete SetLoadFields), plus an isolated-execution registry.
- Library API: `analyzeWorkspace` return type widens to `{ model, findings, diagnostics }`.
- CLI: `al-sem analyze <workspace>` with terminal + JSON output.

**Deferred (with seam kept):**
- **Caching** — parse cache + summary cache. Phase 2b recomputes every run; pass boundaries and hash keys (`schemaVersion`, combined-graph hash) are kept available so a cache layer wraps `computeSummaries` / `buildCombinedGraph` later without touching their internals.
- **MCP surface** — Phase 3. The CLI and library API are stable enough that MCP is pure presentation over them.
- **CI gating** — a threshold-driven non-zero exit code on `al-sem analyze` is a deliberate fast-follow, not Phase 2b.
- Everything the parent spec already defers (interface narrowing, report dataitem ordering, external-source downloader, incremental re-index).

## Architecture

Phase 2b adds two layers on top of the completed Phase 2a `SemanticModel`.

### Module structure

```
src/
  engine/
    combined-graph.ts   — unify callGraph + eventGraph + implicit edges → one CombinedGraph
    scc.ts              — Tarjan SCC over the CombinedGraph → SCCs in reverse-topological order
    effect-lattice.ts   — tri-state join, table-set union, effectKey dedupe, widening (pure ops)
    summary-engine.ts   — bottom-up composition + in-SCC fixed-point → RoutineSummary per routine
    path-walker.ts      — shared bounded-traversal primitive (mechanics; policy is detector-supplied)
  detectors/
    registry.ts         — ordered detector list + isolated execution (one throw ≠ dead run)
    d1-db-op-in-loop.ts
    d2-event-fanout-in-loop.ts
    d3-missing-setloadfields.ts
  cli/
    index.ts            — commander entry: `al-sem analyze <workspace>`
    format-terminal.ts  — human output
    format-json.ts      — { model, findings, diagnostics } as JSON
```

**Boundary discipline:** `engine/` depends on `model/` + `graph/` only; `detectors/` depend on `engine/` + `model/`; `cli/` depends on the library API only. Each `engine/` file is one pure function with typed input/output — no I/O, deterministic, independently testable.

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

Builds one `CombinedGraph` (nodes = routines, edges = routine→routine, each tagged with its origin kind) by unifying three sources from the Phase 2a model:

- **Call edges** — `callGraph` `CallEdge`s where `to` is defined: `direct` / `method` / `codeunit-run` / `implicit-trigger`.
- **Event-dispatch edges** — join `EventSymbol.publisherRoutineId` with each `EventEdge.subscriberRoutineId` on `eventId` → a `publisher → subscriber` edge tagged `event-dispatch`. (Raising an event in AL is a direct call to the publisher procedure — already a call edge; the dispatch edge is the publisher-procedure → subscriber hop.)
- **Interface "may-call" edges** — none materialise from current Phase 2a output (interface resolution is deferred), but the build path leaves the seam.

Edges with no `to` (unresolved / dynamic) create **no graph edge**, but are recorded so the `from` routine's summary receives the correct typed `Uncertainty`.

### L4 — Tarjan SCC (`engine/scc.ts`)

Tarjan's algorithm over the `CombinedGraph`. Returns SCCs in **reverse-topological order** of the condensation (callees before callers — exactly what bottom-up composition consumes). A cyclic call/event/trigger graph is normal, not an error. A self-edge marks a singleton SCC as recursive.

### L4 — Effect lattice (`engine/effect-lattice.ts`)

The join / union / dedup / widening operations as pure, separately-tested functions:

- **Tri-state join** for `EffectPresence`: `yes` dominates `unknown` dominates `no`. Monotonic — the fixed-point converges.
- **`writesTables` union**: `TableId[]` set union; `"unknown"` absorbs (`union(x, "unknown") = "unknown"`).
- **`dbEffects` merge**: concatenate, de-dupe by `effectKey`.
- **Widening**: in an SCC fixed-point, the lattice values only ascend (tri-state upward, sets grow); widening guarantees termination even though it is already bounded by the finite lattice.

### L4 — Summary engine (`engine/summary-engine.ts`)

`computeSummaries(model, combinedGraph)` walks SCCs leaves-first and mutates each `routine.summary` in place (same mutation pattern Phase 2a's `resolveRecordTypes` established).

- **Singleton SCC, no self-loop:** compose directly — the routine's own intraprocedural facts + already-computed callee summaries.
- **Real cycle (SCC size > 1, or singleton with self-loop):** initialise all members to bottom (`touchesDb: "no"`, `commits: "no"`, empty sets/arrays), iterate composition until no member's summary changes, applying widening. All members get `inRecursiveCycle: true`.
- **Composition of a routine R:**
  - Seed from R's own `IntraproceduralFeatures`: `recordOperations` → `DbEffect`s with `via: "direct"`; `Commit` operation sites → `commits`; `event-publish` operation sites → `publishesEvents`.
  - For each outgoing combined edge `R → S`: fold in S's summary — `touchesDb`/`commits` joined, `writesTables` unioned, `dbEffects` merged and de-duped by `effectKey` with `via` set from the edge kind (`inherited` / `implicit-trigger` / `event-subscriber` / `dynamic`).
  - Unresolved / opaque / dynamic edges from R: add the matching typed `Uncertainty`, set `hasUnresolvedCalls: true`, push `touchesDb` toward `"unknown"` (never `"no"`).
- **Opaque callees** (`bodyAvailable: false`) are leaves of the combined graph: baseline summary `touchesDb: "unknown"`, `commits: "unknown"`, `hasUnresolvedCalls: true`, an `opaque-callee` `Uncertainty`.
- **Parse-incomplete routines** get a `parse-incomplete` `Uncertainty` and are never reported as silently "clean."

**Eager vs lazy:** `parameterEffects` is computed **eagerly** for every routine — it is intra-routine (bind R's `recordOperations` + `fieldAccesses` on parameter-typed record variables → `ParameterEffectSummary[]`), cheap, and the model field is non-optional. `fieldEffects` stays **lazy**: the summary engine exposes a `computeFieldEffects(routineId): FieldEffectSet` helper that D3 calls on demand; `summary.fieldEffects` is `undefined` otherwise.

**Output invariant:** every `routine.summary` is populated; summaries store **compact de-duped facts only**, never evidence paths.

### L4 — Path-walker (`engine/path-walker.ts`)

The "shared mechanics, detector-specific policy" approach. The walker provides the mechanics; each detector supplies a `WalkPolicy`.

**Shared mechanics:**
- **Bounded traversal** — max depth + max-nodes budget. A recursive cycle or wide fan-out hits the bound rather than running away.
- **Cycle detection** — visited-set on the current path; revisiting a node stops that branch.
- **Uncertainty accumulation** — every `Uncertainty` on edges/summaries along a path is collected, for `FindingConfidence.cappedBy`.
- **Effective loop nesting** — the walker threads an *inherited loop stack* through the path: descending `R → S` via callsite `C` adds `C.loopStack` to the inherited context; at the terminal op site, effective nesting = inherited depth + the op's own `loopStack`. This is the path-dependent loop multiplier the parent spec requires.
- **Completeness flag** — a result is either a *complete* path (ends at a terminal the policy recognised) or *truncated* (bound hit / dead-ended).

**Detector-supplied policy (`WalkPolicy`):**
- `expand(node, pathCtx) → candidate edges` — which edges to follow.
- `isTerminal(node, pathCtx) → boolean` — recognises the real op site.
- `buildStep(hop, pathCtx) → EvidenceStep` — turns a hop into an `EvidenceStep` (loop / call / op, with `sourceAnchor` + `note`).

**Signature:** `walkEvidence(start, policy, bounds, combinedGraph, model) → WalkResult`, where
`WalkResult { path: EvidenceStep[]; effectiveLoopDepth: number; uncertainties: Uncertainty[]; complete: boolean }`.
Pure — no I/O.

### L5 — Detectors

Each detector is one file, a pure query over the summarised `SemanticModel` + `CombinedGraph`, using the path-walker with its own `WalkPolicy`. All three emit the same `Finding` shape, all are capped at `likely` confidence (static-only analysis), and all require a real `evidencePath` — **a detector that cannot build a complete path emits nothing.**

**D1 — interprocedural DB-op-in-loop (`d1-db-op-in-loop.ts`)**
- *Trigger:* a `LoopNode` in a body-available routine.
- *Prune:* for each `CallSite` whose `loopStack` includes that loop, check callee `summary.touchesDb !== "no"`; direct in-loop `RecordOperation`s are caught too.
- *Walk:* down combined-graph call edges where callee `summary.touchesDb !== "no"`, terminal = a `RecordOperation` site. `EvidenceStep[]` = loop → call → … → DB op.
- *Finding:* severity by op type (`FindSet` / `CalcFields` / `Modify` worst), raised by effective loop nesting. `tempState` known-`true` → drop to `info` (temp ≠ SQL round-trip); `parameter-dependent` / `unknown` `tempState` → keep, note the uncertainty. Any path `Uncertainty` → cap confidence at `possible`, record in `cappedBy`.

**D2 — event fanout in loop (`d2-event-fanout-in-loop.ts`)**
- *Trigger:* an `event-publish` `OperationSite` inside a `LoopNode`.
- *Prune:* resolve publisher → subscribers via `EventEdge[]`; check each subscriber's `summary.touchesDb` / `writesTables` / `commits`.
- *Walk:* loop → publish site → each DB-touching subscriber → its effect (cross-app subscribers included, resolved via `.app` symbols).
- *Finding:* one per hot event. Evidence lists subscribers + effects + **owning app** (`subscriberAppId` — extension attribution). An opaque subscriber, or an `EventEdge` with `resolution !== "resolved"`, drops confidence to `possible`.

**D3 — interprocedural missing/incomplete SetLoadFields (`d3-missing-setloadfields.ts`)**
- *Trigger:* `FindSet` / `FindFirst` / `FindLast` (and `Get` only if `loadFields` state is analysable at the site).
- *Analyse:* same-routine field access after retrieval, plus field access in **directly-resolved** callees where the record is passed by `var` or by value — mapped via `ParameterEffectSummary` (caller argument binding → callee parameter field reads). Distinguish *missing* `SetLoadFields` vs *incomplete* (loaded set ⊊ accessed set).
- *Conservative bailouts → `possible` + uncertainty, never a false "clean":* `RecordRef` / `FieldRef` / `Variant` / `Any` touching the record; interface dispatch or unresolved calls in the dataflow; invalidation ops (`Reset`, `Copy`, record assignment, `TransferFields`, or a callee with `mayResetFilters` / `mayChangeLoadFields` / `mayAssignRecord` / `mayUseRecordRef`).
- *MVP-excluded* (per the parent spec's D3 contract): field reads inside event subscribers, field reads from table triggers reached via `Validate`, field reads in base-app / opaque helpers, alias analysis beyond direct argument binding, complex record assignment flows.
- *Finding:* emit only when a missing/incomplete access is proven by a *complete* path; never claim "complete SetLoadFields" when unresolved paths exist.

**Registry (`detectors/registry.ts`)** — an ordered detector list with **isolated execution**: each detector runs inside try/catch; a throw emits a `Diagnostic` (stage `detect`) and the other detectors still run. The combined `Finding[]` is sorted by a stable key (detector name, then `primaryLocation`, then `rootCauseKey`) for deterministic output.

### CLI surface (`src/cli/`)

`commander`-based, mirroring al-perf conventions. One command:

```
al-sem analyze <workspace> [--alpackages <dir>] [--format <terminal|json>] [--deterministic]
```

- `--format` defaults to **auto** — TTY → terminal, pipe → json (mirrors al-perf's `--format auto`).
- `--deterministic` pins `createdAt` for byte-stable output (already an `AnalyzeWorkspaceOptions` flag).
- `format-terminal.ts` — a coverage summary line ("N files, M partially parsed, K packages skipped"), then findings grouped by severity (title, location, evidence path, fix options), then a diagnostics summary.
- `format-json.ts` — the full `{ model, findings, diagnostics }` triple (al-perf consumes the model).
- `analyze` exits 0 whenever analysis *ran* — findings are output, not exit codes. CI gating is a deliberate fast-follow.

## Pipeline integration

`analyzeWorkspace`'s return type widens: `{ model, diagnostics }` → `{ model, findings, diagnostics }` (`findings: Finding[]`). The change is **additive** — existing `{ model }` / `{ diagnostics }` destructures keep working; only the type widens. The new steps (`buildCombinedGraph` → `computeSummaries` → `runDetectors`) slot in after `resolveModel`.

## Error handling & degradation

Extends Phase 2a's "produce a partial model, never crash":

- **Opaque / parse-incomplete routines** never become silently "clean" — `touchesDb: "unknown"` + typed `Uncertainty`.
- **Fixed-point always terminates** — monotonic lattice + widening.
- **Detector isolation** — registry try/catch per detector → `Diagnostic` stage `detect`. Summary-engine failures → stage `summarize`. Both stage values already exist in the `Diagnostic.stage` union.
- **No complete path → no emit** — a detector that cannot build a full witness path emits nothing; that is not an error.
- **No silent "clean"** — absence of a finding ≠ absence of a problem. `AnalysisCoverage` (on the model) and typed `Uncertainty` carry the structured record of which regions were not analysed.

## Testing strategy (TDD)

Test-first, bottom-up, matching the pass pipeline.

**`engine/` unit tests:**
- `combined-graph` — call edges + event-dispatch edges built correctly; unresolved edges produce no graph edge but are recorded.
- `scc` — Tarjan correctness; cyclic graph handled; **recursive-via-event fixture** produces one SCC; reverse-topological order.
- `effect-lattice` — tri-state join, `writesTables` union (incl. `"unknown"` absorption), `dbEffects` dedupe by `effectKey`, widening.
- `summary-engine` — composition correctness; tri-state effects correct; opaque callee → `touchesDb: "unknown"` + `opaque-callee` uncertainty; `parameterEffects` correct; `fieldEffects` computed only when asked; fixed-point converges on the recursive-via-event fixture; **summaries contain no path data**.

**`path-walker` unit tests:** bound enforcement (depth + node budget), cycle stop, uncertainty accumulation, effective-loop-nesting math, complete-vs-truncated result.

**Detector unit tests** — each detector: known-positive emits, known-negative emits nothing, evidence path complete and ends at the real op site, effective loop nesting correct. Plus the parent spec's negative-control false-positive cases:
- temp record in loop → D1 emits `info`, not `critical`.
- `parameter-dependent` temp state → D1 keeps but notes uncertainty.
- event with zero DB-touching subscribers → D2 silent.
- complete `SetLoadFields` → D3 silent.
- `RecordRef` access → D3 → `possible`, not crash or false "clean".
- `Reset` between `FindSet` and field access → D3 bails.

**CLI tests:** `analyze` on a fixture project → terminal output contains expected strings; `--format json` → valid JSON with `findings`.

**End-to-end golden test:** full pipeline on a multi-file fixture project → assert the serialized `{ model, findings, diagnostics }` against a snapshot in `test/fixtures/expected/`.

**Determinism test:** run the pipeline twice on the same input, diff the serialized JSON — must be byte-identical.

**Fixtures** — new `.al` files under `test/fixtures/al/`, each isolating one construct: a loop calling a helper that does `FindSet`; a publisher-in-loop; a partial record passed to a callee; `Validate` triggering a table trigger; a recursive cycle through an event. `.app` fixtures under `test/fixtures/app/` for cross-app D2 subscriber tests.

## Model types — already defined

All Phase 2b model types already exist in `src/model/` from Phase 1 and need no schema change:
- `summary.ts` — `RoutineSummary`, `DbEffect`, `ParameterEffectSummary`, `FieldEffectSet`, `Uncertainty`, `EffectPresence`.
- `finding.ts` — `Finding`, `EvidenceStep`, `FixOption`, `FindingConfidence`, `Diagnostic` (with `summarize` / `detect` stages).
- `entities.ts` — `Routine.summary?: RoutineSummary` is the sink.

New **internal** types introduced by Phase 2b (not in `model/`, local to `engine/`): `CombinedGraph`, `CombinedEdge`, `WalkPolicy`, `WalkResult`, `WalkBounds`.

## Success criteria

- `analyzeWorkspace` returns `{ model, findings, diagnostics }`; every `routine.summary` is populated.
- Tarjan SCC handles cyclic call/event/trigger graphs; the fixed-point converges on the recursive-via-event fixture.
- D1/D2/D3 each emit on their known-positive fixtures, stay silent on known-negatives, and produce complete evidence paths ending at the real op site.
- `al-sem analyze <workspace>` runs from the terminal with terminal + JSON output.
- The determinism test passes — byte-identical serialized output across two runs.
- The full test suite is green; `tsc --noEmit` and `biome check` clean.
