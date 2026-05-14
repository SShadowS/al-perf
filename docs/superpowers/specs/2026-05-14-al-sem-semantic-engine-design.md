# Design — `al-sem` Semantic Engine (Sub-project A)

**Date:** 2026-05-14
**Status:** Approved design (revised after gpt-5.5 review) — ready for implementation planning
**Working name:** `al-sem` (final project + npm package name TBD before publish)

## Context

`al-perf` today is a profile analyzer with 18 pattern detectors. Most source-correlated
detectors work within a single method body / single file. The current `SourceIndex` is a
per-procedure feature bag — no call graph, no routine summaries, no cross-file resolution.

The goal: build the **best performance tool for AL code**, not the simplest. A consultation
with gpt-5.5 reframed the target — the category-defining tool is a *BC workload root-cause
engine*, not an AL syntax-smell detector. It fuses five evidence sources (tree-sitter syntax,
compiler-grade symbol resolution, CPU profiles, App Insights telemetry, BC metadata) into one
evidence graph.

That full vision decomposes into independent sub-projects:

- **Sub-project A** — Semantic foundation + interprocedural detectors *(this spec)*
- **Sub-project B** — Profile fusion (overlay `.alcpuprofile` onto the semantic model)
- **Sub-project C** — Telemetry fusion (App Insights ingestion)
- **Sub-project D** — Regression/CI + fix planner

Each gets its own spec → plan → implementation cycle.

## Scope of this spec — Sub-project A

A new **standalone project, `al-sem`** — pure static AL semantic analysis. It owns the
workspace/symbol index, call graph, event graph, routine summaries, the static evidence
graph, and interprocedural detectors. It has **zero knowledge of profiles**.

Dependency direction is one-way: **`al-perf → al-sem`**. al-perf stays the profile analyzer
and the web backend for al-perf-bc; it gains a dependency on al-sem and (in sub-project B)
does the fusion — overlaying profile call trees onto al-sem's `SemanticModel` to upgrade
"likely" findings to "confirmed". al-sem is independently valuable: a CI lint tool and an
MCP server for AL developers who never run a profile.

### Locked decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Project structure | New standalone `al-sem`; `al-perf → al-sem` one-way dep | Different domain (static analysis vs profile crunching); clean dependency direction; independently valuable |
| Call graph resolution | **Native resolver** — al-sem builds its own call graph from tree-sitter + parses `.app` symbol packages itself | Preserves the self-contained property; works in Docker/CI with zero external deps; no hard dependency on the Go LSP wrapper or VS Code AL extension. AL is statically typed enough to make this tractable. Every edge carries resolver provenance + quality so an LSP-backed resolver can be compared in tests later without becoming a runtime dependency |
| Symbol ingestion | Workspace `.al` source + `.app` symbol packages (source-aware: packages come with or without embedded source) + a pluggable `ExternalSourceProvider` seam | `.app` symbols unlock base-app event fanout and cross-app call resolution. The external-source seam lets Microsoft AL source (e.g. StefanMaron's MSDyn365BC.Code.History) be fed in later — **the downloader is NOT built now**, only the seam |
| MVP detector set | Foundation + 3 proof-of-model detectors; full catalog is a sequenced fast-follow within sub-project A | Each detector exercises a different engine part; keeps the spec focused; proves the model before building ~15 detectors |
| D3 scope | Keep interprocedural `SetLoadFields`, with an explicit included/excluded contract (Section 4) | Proves parameterized field-effect summaries — machinery nothing else in the MVP exercises. The contract caps the complexity |
| Engine architecture | **Approach 3** — routine summaries for effects + bounded path-walk for evidence chains | Scales like pure summary-dataflow, builds incrementally, produces real evidence chains, fusion-ready. Pure summary-dataflow loses the evidence path and over-engineers symbolic detail everywhere |
| Runtime | TypeScript / Bun | Reuse `tree-sitter-al.wasm`; types shareable with al-perf |
| Methodology | TDD, SOLID, DRY — pragmatically | Every layer has a well-defined interface; behavior specifiable before implementation |

## Section 1 — Architecture & Components

Layered pipeline. Each layer is its own unit with one job and a well-defined interface,
independently testable. Lower layers know nothing of upper layers.

```
┌─ Surfaces ────────────────────────────────────────────┐
│  library API   │   CLI (al-sem analyze)  │  MCP server │
└───────────────────────────┬───────────────────────────┘
                            │  consumes SemanticModel + Findings
┌─ L5  Detectors ───────────┴───────────────────────────┐
│  3 interprocedural detectors = queries over L4        │
│  prune via summaries → bounded path walk → Finding[]  │
└───────────────────────────┬───────────────────────────┘
┌─ L4  Interprocedural engine ──────────────────────────┐
│  routine summaries (fixed-point, SCC-collapsed)       │
│  + bounded path-walker for evidence chains            │
└───────────────────────────┬───────────────────────────┘
┌─ L3  Call graph + event graph ────────────────────────┐
│  native resolver: callsite → routine id (+ provenance)│
│  event catalog: publisher ↔ subscriber edges          │
│  implicit edges: table triggers, known Codeunit.Run   │
└───────────────────────────┬───────────────────────────┘
┌─ L2  Semantic index ──────────────────────────────────┐
│  objects, routines, tables/fields/keys, record-vars   │
│  intraprocedural extraction: loops, operations, calls │
└───────────────────────────┬───────────────────────────┘
┌─ L1  Source providers ────────────────────────────────┐
│  workspace .al  │  .app symbol pkg (source-aware)     │
│  ExternalSourceProvider seam (MS source — later)      │
└───────────────────────────┬───────────────────────────┘
┌─ L0  Parsing ─────────────────────────────────────────┐
│  tree-sitter-al.wasm  │  SymbolReference.json reader   │
└───────────────────────────────────────────────────────┘
```

### Components

| Unit | Job | Depends on |
|------|-----|------------|
| `parser` | `.al` text → tree-sitter AST | tree-sitter wasm |
| `symbol-reader` | `.app` zip → `SymbolReference.json` → symbol records | — |
| `source-provider` | abstracts where AL comes from: `WorkspaceProvider`, `AppPackageProvider`, `ExternalSourceProvider` (stub) | parser, symbol-reader |
| `indexer` | build L2 semantic index — objects, routines, tables, intraprocedural features, operation sites | source-provider, parser |
| `resolver` | callsite → routine id; build call graph with edge kinds + resolution quality; implicit-trigger + known-`Codeunit.Run` edges | indexer |
| `event-graph` | publisher/subscriber catalog → dispatch edges | indexer, symbol-reader |
| `summary-engine` | routine summaries, fixed-point over SCCs of the combined graph | resolver, event-graph |
| `path-walker` | bounded walk → evidence chain (reconstructs witness paths from compact summary facts) | resolver, event-graph |
| `detectors/*` | one file per detector, pure query over L4 | summary-engine, path-walker |
| `model` | the serializable `SemanticModel` + `Finding` types + serde — shared vocabulary | — (pure types) |
| surfaces (`cli`, `mcp`, `lib`) | thin wrappers | detectors, model |

**Boundary rule:** L0–L4 produce a serializable `SemanticModel`. al-perf (sub-project B)
imports al-sem, gets that model, overlays profile data. Detectors (L5) are also just
consumers — al-perf could run its own fused detectors against the same model later.

## Section 2 — Core Data Model

Everything serializes to a `SemanticModel` (JSON), which al-perf consumes later. The model is
designed so sub-projects B (profile fusion) and C (telemetry fusion) layer on **without a
schema break** — that is why identity, operation sites, tri-state effects, parameterized
summaries, and table-extension ownership are all day-one concerns.

### Two-level identity

Identity is split: a **canonical key** stable across app version bumps (so regression
comparison and "same logical method across versions" work), and a **model-instance ID**
scoped to one analysis run (so profile-vs-source exactness can be checked).

```ts
// Stable across version bumps when the symbol is semantically the same.
interface CanonicalRoutineKey {
  appGuid: string;            // from app.json / symbol package — NOT publisher.name
  objectType: string;
  objectNumber: number;
  routineKind: "procedure" | "trigger" | "event-publisher" | "event-subscriber";
  routineName: string;
  normalizedSignatureHash: string;
}

// Version/model-scoped concrete identity.
type RoutineId = string;   // encodes { canonical, modelInstanceId }
type ObjectId  = string;   // "{appGuid}/{objectType}/{objectNumber}"
type TableId   = string;   // "{appGuid}/table/{number}"  (physical table)
type FieldId   = string;   // "{tableId}/{fieldNumber}"
type KeyId     = string;
type EventId   = string;
type CallsiteId   = string;  // "{routineId}/cs{index}"  — compact internal ref
type LoopId       = string;  // "{routineId}/loop{index}"
type OperationId  = string;  // "{routineId}/op{index}"
type RecordVariableId = string;
```

Index-based `cs{n}` / `loop{n}` / `op{n}` IDs stay as compact internal references, but every
operation/callsite/loop also carries a `SourceAnchor` (below) so diff/profile/telemetry
correlation does not depend on fragile indices.

### `ModelIdentity` — top-level version identity

```ts
interface ModelIdentity {
  schemaVersion: string;        // bump = serialized model shape changed
  analyzerVersion: string;      // al-sem version
  grammarVersion: string;       // tree-sitter-al grammar version/hash
  symbolReaderVersion: string;
  createdAt: string;

  workspace?: { rootHash?: string; appJsonHash?: string };
  primaryApp?: AppIdentity;
  apps: AppIdentity[];
  dependencyGraphHash: string;
  runtime?: { platform?: string; application?: string; runtime?: string };
}

interface AppIdentity {
  appGuid: string;
  publisher: string;
  name: string;
  version: string;
  packageHash?: string;
  symbolReferenceHash?: string;
  sourceAggregateHash?: string;
  sourceKind: "workspace" | "app-source" | "symbol-only" | "external-source";
}
```

`al-sem` knows nothing of profiles or telemetry — it just emits enough identity for al-perf
to correlate safely later. `schemaVersion` + `analyzerVersion` + `grammarVersion` also key
the cache, so stale-cache bugs are detectable.

### `SourceAnchor` — stable location reference

```ts
interface SourceAnchor {
  sourceUnitId: string;
  range: SourceRange;
  enclosingRoutineId: RoutineId;
  syntaxKind: string;
  // Fingerprint fields — SEAM ONLY in MVP; computation deferred to sub-project D.
  normalizedTextHash?: string;
  leadingContextHash?: string;
  trailingContextHash?: string;
}
```

The struct exists day one (no retrofit); the hashes are populated later when regression diff
needs them.

### Entities (L2 index)

`App`, `Object` (table/page/report/codeunit/...), `Routine`, `Table`, `Field`, `Key`,
`RecordVariable`, plus first-class `OperationSite`.

**Routine kinds** include `procedure`, `trigger`, `event-publisher`, `event-subscriber` —
and triggers for tables, pages, and reports are indexed as routines **now** (retrofitting
routine kinds later would break snapshots, profile mapping, and the public API).

```ts
interface Routine {
  id: RoutineId;
  canonical: CanonicalRoutineKey;
  objectId: ObjectId;
  kind: "procedure" | "trigger" | "event-publisher" | "event-subscriber";
  parameters: ParameterSymbol[];
  bodyAvailable: boolean;       // false = opaque .app symbol
  parseIncomplete: boolean;
  sourceHash: string;
  sourceAnchor: SourceAnchor;
  features: IntraproceduralFeatures;   // loops, operations, calls, field accesses, record-vars
  summary: RoutineSummary;             // computed in L4
}
```

**Table-extension ownership** — physical table vs declaring object/app must both be modeled,
because telemetry maps SQL to the *physical* table but fix ownership follows the *declaring*
object (which may be a `tableextension` in another app):

```ts
interface Field {
  id: FieldId;
  physicalTableId: TableId;
  declaringObjectId: ObjectId;   // table OR tableextension
  declaringAppId: string;        // appGuid
  fieldNumber: number;
  name: string;
  fieldClass: "Normal" | "FlowField" | "FlowFilter";
  isBlobLike: boolean;
}

interface Key {
  id: KeyId;
  physicalTableId: TableId;
  declaringObjectId: ObjectId;
  fields: FieldId[];
  sumIndexFields?: FieldId[];
  isEnabled?: boolean | "unknown";
}
```

### `OperationSite` — first-class operation IDs

A direct `FindSet`/`Modify`/`CalcFields`/`Validate`/`LockTable`/`Commit` is **not** a
callsite. It gets its own identity so evidence paths end at the real operation source
location, not merely at an inheriting callsite.

```ts
interface OperationSite {
  id: OperationId;
  routineId: RoutineId;
  kind: "record-op" | "call" | "event-publish" | "commit" | "lock"
      | "external-call" | "dynamic-dispatch";
  sourceAnchor: SourceAnchor;
  loopStack: LoopId[];           // loops in THIS routine enclosing the site
  provenance: Evidence[];
}

interface RecordOperation {       // OperationSite with kind "record-op"
  id: OperationId;
  routineId: RoutineId;
  op: RecordOpType;
  recordVarId: RecordVariableId;
  tableId: TableId | "unknown";
  tempState: TempState;
  filters?: FilterState;          // populated where analyzable
  currentKey?: KeyState;
  loadFields?: LoadFieldState;    // required for D3 at FindSet/FindFirst sites
  autoCalcFields?: FieldId[];
  loopStack: LoopId[];
  sourceAnchor: SourceAnchor;
  provenance: Evidence[];
}

// Temp-ness can be caller-dependent when a record is a by-var/value parameter.
type TempState =
  | { kind: "known"; value: boolean }
  | { kind: "unknown" }
  | { kind: "parameter-dependent"; parameterIndex: number };
```

### Call graph — edges with kind + resolution quality

The model never stores a naked call graph. Every edge records how it was resolved and how
confident that resolution is — this is what keeps the native resolver honest.

```ts
interface CallEdge {
  from: RoutineId;
  to?: RoutineId;                 // absent when unresolved
  callsiteId: CallsiteId;
  operationId: OperationId;
  dispatchKind: "direct" | "method" | "interface" | "codeunit-run"
              | "report-run" | "page-run" | "event-dispatch"
              | "implicit-trigger" | "dynamic" | "unresolved";
  resolution: "resolved" | "maybe" | "unknown" | "opaque";
  provenance: Evidence[];
  uncertainty?: Uncertainty;
}
```

### Event model

```ts
interface EventSymbol {
  id: EventId;
  publisherObjectId: ObjectId;
  publisherRoutineId?: RoutineId;
  eventName: string;
  eventKind: "integration" | "business" | "trigger" | "internal" | "unknown";
  elementName?: string;           // important for trigger events
  signatureHash: string;
  parameters: ParameterSymbol[];
  provenance: Evidence[];
}

interface EventEdge {
  eventId: EventId;
  subscriberRoutineId: RoutineId;
  subscriberAppId: string;
  skipOnMissingLicense?: boolean;
  skipOnMissingPermission?: boolean;
  resolution: "resolved" | "maybe" | "unknown";
  provenance: Evidence[];
}
```

### `RoutineSummary` — the interprocedural unlock (L4)

Effects are **tri-state** (`yes`/`no`/`unknown`) — not boolean. `unknown` and "unresolved
call" are related but distinct, and the model keeps the distinction because they imply
different confidence and different remediation messages.

Summaries store **compact facts only** — never full evidence paths (that would explode
memory in recursive SCCs). The path-walker reconstructs witness paths later from these facts.

```ts
type EffectPresence = "yes" | "no" | "unknown";

interface RoutineSummary {
  routineId: RoutineId;
  touchesDb: EffectPresence;
  commits: EffectPresence;
  writesTables: TableId[] | "unknown";
  dbEffects: DbEffect[];               // compact — keyed, de-duped, no paths
  publishesEvents: EventId[];
  inRecursiveCycle: boolean;           // SCC member
  hasUnresolvedCalls: boolean;
  uncertainties: Uncertainty[];        // typed reasons (see below)
  parameterEffects: ParameterEffectSummary[];   // for D3 and fast-follow
  fieldEffects?: FieldEffectSet;       // optional — lazy, only for detectors that need it
}

interface DbEffect {
  effectKey: string;          // op + table + operationSite + paramDependency + uncertaintyKind
  operationId: OperationId;   // the real op site (direct) — or the inheriting callsite ref
  op: RecordOpType;
  tableId: TableId | "unknown";
  recordVarId?: RecordVariableId;
  tempState: TempState;
  via: "direct" | "inherited" | "implicit-trigger" | "event-subscriber" | "dynamic";
  // NOTE: no loopDepthAtSite here — effective loop nesting is caller-dependent and is
  // computed by the path-walker, combining the callee's local loopStack with the
  // caller's inherited loop context.
}

// Field effects relative to parameters — flat routine-level field effects cannot
// support D3 reliably.
interface ParameterEffectSummary {
  parameterIndex: number;
  tableId: TableId | "unknown";
  readsFields: FieldId[];
  writesFields: FieldId[];
  mayResetFilters: boolean;
  mayChangeLoadFields: boolean;
  mayAssignRecord: boolean;
  mayUseRecordRef: boolean;
}

type Uncertainty =
  | { kind: "unresolved-call"; callsiteId: CallsiteId }
  | { kind: "opaque-callee"; callsiteId: CallsiteId }
  | { kind: "dynamic-dispatch"; operationId: OperationId }
  | { kind: "recordref-or-variant"; operationId: OperationId }
  | { kind: "interface-dispatch"; callsiteId: CallsiteId }
  | { kind: "parse-incomplete"; routineId: RoutineId };
```

`fieldEffects` stays optional — Approach 3's "symbolic detail only where a detector needs
it." D3 triggers its computation; D1 never pays for it.

### `Finding` — structured, evidence-backed

```ts
interface Finding {
  id: string;                 // instance id
  rootCauseKey: string;       // stable dedupe key — sub-project B attaches many
                              // profile frames / telemetry observations to one root cause
  detector: string;
  title: string;
  rootCause: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: FindingConfidence;
  primaryLocation: SourceAnchor;
  evidencePath: EvidenceStep[];    // loop → call → call → DB op (ends at real op site)
  affectedObjects: ObjectId[];
  affectedTables: TableId[];
  fixOptions: FixOption[];         // ranked, each with a safety label
  provenance: Evidence[];
}

interface FindingConfidence {
  level: "confirmed" | "likely" | "possible";   // static-only ceiling = "likely"
  cappedBy?: ("unresolved-call" | "opaque-callee" | "dynamic-dispatch"
            | "parse-incomplete" | "version-mismatch")[];
  evidence: Evidence[];
}

interface EvidenceStep {
  routineId: RoutineId;
  operationId?: OperationId;
  callsiteId?: CallsiteId;
  loopId?: LoopId;
  sourceAnchor: SourceAnchor;
  note: string;
}
```

**Static-only confidence ceiling = "likely".** "confirmed" is reserved for sub-project B,
when a profile backs the finding. Any `Uncertainty` on the evidence path caps the finding at
"possible" and is recorded in `cappedBy` — users see *why* it is only possible.

### `AnalysisCoverage` — "no silent clean", first-class

```ts
interface AnalysisCoverage {
  sourceUnitsTotal: number;
  sourceUnitsParsed: number;
  routinesTotal: number;
  routinesBodyAvailable: number;
  routinesParseIncomplete: RoutineId[];
  opaqueApps: string[];                 // appGuids
  unresolvedCallsites: CallsiteId[];
  dynamicDispatchSites: OperationId[];
}
```

### `SemanticModel` — the serialized output

```ts
interface SemanticModel {
  identity: ModelIdentity;
  apps: App[];
  objects: Object[];
  routines: Routine[];          // each with summary
  tables: Table[];              // with fields, keys
  callGraph: CallEdge[];
  eventGraph: { events: EventSymbol[]; edges: EventEdge[] };
  coverage: AnalysisCoverage;
}
```

In-memory form uses `Map`/`Set`; the serialized form uses arrays/records. One `model` unit
owns both representations and the conversion (serde).

## Section 3 — Data Flow (the pass pipeline)

Six passes, strictly ordered. Each pass is a pure function over the previous pass's output,
testable in isolation.

```
1. DISCOVER & LOAD     source-provider enumerates workspace *.al
                       + .alpackages/*.app  →  detects source-bearing apps
                       builds ModelIdentity / AppIdentity (guids, hashes)
                       output: SourceUnit[]  (path, kind, hasBody)

2. PARSE & INDEX       each .al → tree-sitter AST → semantic index
   (L0–L2)             each .app → SymbolReference.json → symbol records
                       intraprocedural extraction per routine:
                         loops, operation sites, calls, field accesses, record-vars
                       table/field/key indexing with table-extension ownership
                       output: SemanticIndex

3. RESOLVE GRAPH       each callsite → CallEdge (RoutineId + dispatchKind + resolution)
   (L3)                event catalog → EventSymbol[] + EventEdge[]
                       implicit-trigger edges (Validate / *(true) on known tables)
                       known Codeunit.Run edges
                       unresolved / dynamic / opaque → flagged, not dropped
                       output: CallGraph + EventGraph

4. COMPUTE SUMMARIES   condense the COMBINED graph into SCCs (Tarjan) — combined =
   (L4)                  direct calls + event-dispatch + implicit-trigger + known
                          Codeunit.Run + interface may-call edges
                        topological order; bottom-up compose summaries
                        within an SCC: fixed-point iteration with widening
                          (monotonic booleans/sets → converges fast)
                        summaries store compact de-duped facts (effectKey) — NO paths
                        field-effects + parameterEffects: lazy where a detector needs them
                        output: RoutineSummary per routine  →  SemanticModel complete

5. RUN DETECTORS       each detector:  prune via summaries
   (L5)                  → bounded path-walk down interesting branches only
                          → reconstruct witness path, compute effective loop nesting
                            (caller inherited loops + callee local loopStack)
                          → build EvidenceStep[] chain  →  Finding[]
                       output: Finding[]

6. EMIT                SemanticModel + Finding[] + Diagnostic[]  →  surface
                       (JSON for lib/al-perf · terminal for CLI · MCP response)
```

### Correctness guardrails (called out so the plan bakes them in)

- **SCC over the combined graph, not just direct calls.** Event-dispatch and
  implicit-trigger edges participate in SCC detection — otherwise event recursion and
  trigger recursion are invisible.
- **Summaries store compact facts, never paths.** `dbEffects` entries are keyed by
  `effectKey` and de-duped. During SCC fixed-point iteration, facts merge by key; path
  segments are never appended. The path-walker (pass 5) reconstructs a bounded witness path
  on demand.
- **Loop nesting is path-dependent.** A callee's DB op may sit at loop depth 0 *locally* but
  the callsite may be inside a caller loop. There is no `loopDepthAtSite` in the summary —
  the path-walker computes effective nesting by combining the caller's inherited loop
  context with the callee's local `loopStack`.
- **Opaque callees** get a summary of `touchesDb: "unknown"`, `hasUnresolvedCalls: true`,
  plus an `opaque-callee` uncertainty. It propagates upward as confidence-lowering, never as
  a false "clean."
- **Recursion**: SCC members all get `inRecursiveCycle = true`; the fixed-point converges
  because the lattice (tri-state presence, table sets) is monotonic under widening.

**Caching:** hash-invalidated. Cache keys include `schemaVersion`, `analyzerVersion`,
`grammarVersion`, `symbolReaderVersion`, and `dependencyGraphHash`. Per-file parse cache
(keyed on `sourceHash`); summary cache (keyed on combined-graph hash). A basic implementation
ships in the MVP.

**Non-goal (seam only):** incremental re-index on single-file change. Batch re-run is fine
for CI/MCP. Pass boundaries are clean enough to add incrementality later — it is not built
now.

## Section 4 — The 3 Proof Detectors

Each detector is one file, a pure query over `SemanticModel`. Each exercises a different
engine part — that is the point of the selection.

### D1 — Interprocedural DB-op-in-loop
- **Trigger:** a `Loop` in a body-available routine.
- **Prune:** for each callsite inside the loop, check callee `summary.touchesDb`. (Direct
  in-loop DB ops are caught too — but the new power is detection *via calls*, including via
  implicit-trigger edges.)
- **Walk:** loop → bounded walk down call edges where `summary.touchesDb !== "no"` → until
  the `RecordOperation` site. Build the `EvidenceStep[]` chain, ending at the real op site.
  Compute effective loop nesting from inherited + local loop context.
- **Finding:** severity by op (`FindSet`/`CalcFields`/`Modify` worst); effective loop
  nesting raises it. `tempState` known-`true` → drop to info (temp ≠ SQL round-trip);
  `parameter-dependent` or `unknown` → keep but note uncertainty. Any path `Uncertainty` →
  cap at "possible", record in `cappedBy`.
- **Proves:** call graph + summary composition + loop-multiplier (path-dependent) + bounded
  walk.

### D2 — Event fanout in loop
- **Trigger:** an event-publish `OperationSite` inside a `Loop`.
- **Prune:** resolve publisher → subscribers via `EventEdge[]`; check each subscriber's
  `summary.touchesDb` / `writesTables` / `commits`.
- **Walk:** loop → publish site → each DB-touching subscriber → its effect. Subscribers may
  live in other apps (resolved via `.app` symbols).
- **Finding:** one per hot event. Evidence lists subscribers + effects + **owning app**
  (`subscriberAppId` — extension attribution). An opaque subscriber, or an `EventEdge` with
  `resolution !== "resolved"`, drops confidence to "possible".
- **Proves:** event graph + cross-app resolution + symbol-package ingestion.

### D3 — Interprocedural missing/incomplete SetLoadFields

Kept, with an **explicit MVP contract** so it cannot consume the project.

**Included:**
- Trigger ops: `FindSet`, `FindFirst`, `FindLast` (and `Get` only if `loadFields` state is
  analyzable at the site).
- Same-routine field access after retrieval.
- Field access in **directly-resolved** callees, where the record is passed by `var` or by
  value — mapped via `ParameterEffectSummary` (caller argument binding → callee parameter
  field reads).
- Distinguishes *missing* `SetLoadFields` vs *incomplete* (loaded set ⊊ accessed set).

**Excluded from MVP (deferred to fast-follow):**
- Field reads inside event subscribers reading the partial record.
- Field reads from table triggers reached via `Validate`.
- Field reads in base-app / opaque symbol-only helpers.
- Alias analysis beyond direct argument binding.
- Complex record assignment flows; global record variables mutated across calls.

**Conservative bailouts (→ `possible` + uncertainty, never a false "clean"):**
- `RecordRef` / `FieldRef` / `Variant` / `Any` touching the record.
- Interface dispatch or unresolved calls in the dataflow.
- Invalidation ops: `Reset`, `Copy`, record assignment, `TransferFields`, or a callee with
  `mayResetFilters` / `mayChangeLoadFields` / `mayAssignRecord` / `mayUseRecordRef`.

**Finding behavior:** emit only when a missing/incomplete access is proven by a *complete*
path. If any dynamic construct or unresolved mutation/read path appears, downgrade to
"possible" or emit a diagnostic — **never** claim "complete SetLoadFields" when unresolved
paths exist.

- **Proves:** parameterized field-effect summaries (`ParameterEffectSummary`) + record-var
  dataflow across the call boundary. The hardest of the three; the contract caps the cost.

**Shared:** all three emit the same `Finding` shape; all are capped at "likely" confidence
(static-only); all produce a real `evidencePath`. A detector that cannot build a full path
does not emit — no path means no trust.

## Section 5 — Native Resolver Scope (MVP must-handle vs defer)

The native resolver is not compiler-perfect, and the spec is explicit about what it must do
in the MVP versus what it defers. The rule: **nothing resolves silently to "clean."**
Unhandled constructs become typed `Uncertainty`, not absence.

### Must handle in the MVP (at least conservatively)

| Construct | MVP behavior |
|-----------|--------------|
| Table triggers from `Validate`, `Insert(true)`, `Modify(true)`, `Delete(true)`, `Rename` | If table known + trigger body available → add `implicit-trigger` edge. If table known but body unavailable → opaque implicit edge. `RunTrigger = false` → no edge. Dynamic `RunTrigger` arg → `resolution: "maybe"` |
| Event publisher/subscriber resolution | Full `EventSymbol` + `EventEdge` incl. cross-app symbol subscribers and `subscriberAppId`. D2 depends on it |
| `Codeunit.Run` with a statically known codeunit | `codeunit-run` edge, `resolution: "resolved"`. Dynamic codeunit id → `dynamic` / `unknown` |
| `RecordRef` / `FieldRef` / `Variant` / `Any` | Detected and marked with `recordref-or-variant` uncertainty — never silently dropped |
| Interface calls | `dispatchKind: "interface"`. Known implementation set if cheaply available (`resolution: "maybe"` with multiple `to`); otherwise `resolution: "unknown"`. Callsite never looks clean |
| Page / report / table triggers | Indexed as routines now (kinds in the model). Full lifecycle semantics deferred — but the routine kinds must exist day one |

### Deferred (model keeps the seam)

- Report dataitem trigger **execution order** — represent dataitems + triggers structurally,
  defer ordering.
- Page lifecycle / FactBox / API-page scenario semantics — keep object/routine metadata
  rich, defer behavior.
- Full interface implementation **narrowing** (dataflow-based) — defer, but keep the
  callsite kind.
- Dynamic `Report.Run` / `Page.Run` target resolution — mark `dynamic` / `unknown`.
- External-source downloader — only the `ExternalSourceProvider` seam.

## Section 6 — Error Handling & Degradation

Core principle (inherited from al-perf): **produce a partial model, never crash.** Every
degradation is recorded so consumers know confidence dropped.

| Failure | Behavior |
|---------|----------|
| Unparseable `.al` (tree-sitter error nodes) | index what parses; mark routine `parseIncomplete`; exclude from detection; `parse-incomplete` uncertainty; do not crash |
| Corrupt / missing `.app` | skip package, emit diagnostic, continue — that dependency becomes fully opaque |
| No `.alpackages/` at all | workspace-source-only mode; still runs; external calls all opaque |
| Unresolved callsite | **not an error** — it is data → `CallEdge` with `resolution: "unknown"`, `hasUnresolvedCalls`, typed uncertainty |
| Cyclic call/event/trigger graph | not an error — SCC handles it |
| Detector throws | isolated — one detector failing does not kill the run; emit diagnostic, other detectors still produce findings |
| Symbol-vs-source mismatch | prefer source when `bodyAvailable`; the symbol package is fallback only |

**Diagnostics channel:** output is `{ model, findings, diagnostics }`. `Diagnostic[]` carries
`{ severity, stage, message, sourceRef? }` — parse failures, skipped packages, detector
crashes. Surfaces show a summary line ("3 files partially parsed, 1 package skipped");
`--verbose` / MCP get the full list. `AnalysisCoverage` on the model carries the structured
version of the same truth.

**No silent "clean":** an opaque or partially-parsed region never reports as "no issues
found" — it reports as "not analyzed", via `AnalysisCoverage` and typed `Uncertainty`.
Absence of a finding ≠ absence of a problem, and the model records which regions were not
analyzed.

## Section 7 — Testing Strategy (TDD)

TDD is mandatory — every layer has a well-defined interface, so behavior is specifiable
before implementation. Test pyramid bottom-up, matching the pass pipeline.

### Fixtures
- `test/fixtures/al/` — hand-written `.al` files, each isolating one construct (a loop
  calling a helper that does `FindSet`; a publisher-in-loop; a partial record passed to a
  callee; `Validate` triggering a table trigger; a recursive cycle through an event; etc.).
- `test/fixtures/app/` — small synthetic `.app` packages, both source-bearing and
  symbol-only, for resolver + ingestion tests.
- `test/fixtures/expected/` — serialized `SemanticModel` + `Finding[]` snapshots for
  end-to-end golden tests.

### Layer-by-layer (each written test-first)

| Layer | Unit tests assert |
|-------|-------------------|
| L0 parser | known `.al` → expected AST shape; malformed → error nodes, no throw |
| L0 symbol-reader | `.app` zip → expected symbol records; corrupt zip → diagnostic |
| L1 source-provider | discovers workspace + packages; `hasBody` detection correct; `AppIdentity` hashes populated; `ExternalSourceProvider` stub returns empty cleanly |
| L2 indexer | per-routine intraprocedural extraction — loops/operation-sites/calls/field-accesses match; routine kinds correct (incl. triggers); table-extension ownership correct; canonical keys deterministic |
| L3 resolver | callsite → correct `CallEdge` with right `dispatchKind` + `resolution`; implicit-trigger edges added for `Validate`/`*(true)`; known `Codeunit.Run` resolved; `RecordRef`/interface/dynamic → typed uncertainty; event catalog edges + `subscriberAppId` correct |
| L4 summary-engine | composition correct; tri-state effects correct; SCC over combined graph; fixed-point converges (recursive-via-event fixture); opaque callee → `touchesDb: "unknown"` + uncertainty; `parameterEffects` correct; lazy `fieldEffects` only computed when asked; summaries contain no path data |
| L5 detectors | each detector: known-positive emits, known-negative emits nothing, evidence path complete and ends at the real op site, effective loop nesting correct |

### Detector tests — the discipline (mirrors al-perf's convention)

Every detector needs known-positive + known-negative fixtures, plus negative-control cases
targeting false positives: temp record in loop (D1 → info, not critical);
`parameter-dependent` temp state (D1 keeps but notes uncertainty); event with zero
DB-touching subscribers (D2 silent); complete `SetLoadFields` (D3 silent); `RecordRef`
access (D3 → "possible", not crash or false "clean"); `Reset` between `FindSet` and field
access (D3 bails).

### End-to-end golden tests

Full pipeline on a multi-file fixture project → assert serialized `SemanticModel` +
`Finding[]` against a snapshot. Catches cross-layer regressions.

### Determinism

Canonical keys are content-hashed and passes are pure functions → identical input must yield
byte-identical serialized output. A determinism test runs the pipeline twice and diffs the
JSON.

## Section 8 — Project Structure & Surfaces

New repo, TS/Bun, mirrors al-perf conventions.

```
al-sem/
  src/
    parser/      L0 — tree-sitter init, AST helpers
    symbols/     L0 — .app zip reader, SymbolReference.json parser
    providers/   L1 — WorkspaceProvider, AppPackageProvider, ExternalSourceProvider (stub)
    index/       L2 — indexer, intraprocedural extraction, operation sites
    graph/       L3 — resolver (call graph + edge kinds), event-graph, implicit edges
    engine/      L4 — summary-engine, path-walker, SCC (Tarjan over combined graph)
    detectors/   L5 — one file per detector + registry
    model/       SemanticModel + Finding types + serde (in-memory <-> JSON)
    cli/         CLI surface (commander)
    mcp/         MCP server surface (stdio)
    index.ts     library API exports
  test/fixtures/{al,app,expected}/
  tree-sitter-al.wasm
```

### Three surfaces — all thin wrappers over the library

**Library API** (`src/index.ts`) — the contract al-perf imports:
```ts
analyzeWorkspace(opts): {
  model: SemanticModel;
  findings: Finding[];
  diagnostics: Diagnostic[];
}
// + SemanticModel, Finding, Diagnostic, ModelIdentity type exports
```

**CLI** — `al-sem analyze <path>` · `--format json|terminal` · `--alpackages <dir>` ·
`--verbose`. Nonzero exit when findings exceed a threshold (CI gate behavior, like al-perf's
`gate`). A dedicated `gate` subcommand is post-MVP.

**MCP server** — stdio, mirrors al-perf's pattern. MVP tools: `analyze_workspace`,
`explain_finding`. Thin wrappers over the library API.

### Wiring & naming
- al-perf adds `al-sem` as a dependency; during development use a local path / workspace
  link.
- `al-sem` is a working name — the real project + npm package name is chosen before publish.
  Not a blocker for the spec.
- al-sem's `SemanticModel` is deliberately designed as the structure al-perf's source
  correlation migrates onto later — but that migration is sub-project B, out of scope here.

## Out of scope (this spec)

- Profile fusion / overlaying `.alcpuprofile` data (sub-project B). **But** the
  fusion-enabling schema — `ModelIdentity`, canonical keys, source anchors, source hashes,
  dependency-graph identity — is in the model day one. No profile parser in al-sem.
- Telemetry / App Insights ingestion (sub-project C). **But** physical-table identity,
  table-extension ownership, and field/key declaring-app are in the model day one. No App
  Insights ingestion in al-sem.
- Regression comparison, perf budgets, fix planner, AI remediation (sub-project D). **But**
  `rootCauseKey`, `SourceAnchor` (struct), and two-level identity are in the model day one;
  only the `SourceAnchor` fingerprint *hashes* are deferred.
- The full interprocedural detector catalog beyond the 3 proof detectors (sequenced
  fast-follow within sub-project A, separate plan).
- The Microsoft AL source downloader (only the `ExternalSourceProvider` seam is built).
- Incremental re-index on single-file change (only the seam — clean pass boundaries).
- VS Code / editor integration.
- LSP-client resolution path (native resolver only — but `CallEdge` provenance/quality lets
  an LSP resolver be compared in tests later without a runtime dependency).

## Next step

Invoke the `writing-plans` skill to produce a detailed, phased implementation plan for
`al-sem`.
