# Design — `al-sem` Semantic Engine (Sub-project A)

**Date:** 2026-05-14
**Status:** Approved design — ready for implementation planning
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
| Call graph resolution | **Native resolver** — al-sem builds its own call graph from tree-sitter + parses `.app` symbol packages itself | Preserves the self-contained property; works in Docker/CI with zero external deps; no hard dependency on the Go LSP wrapper or VS Code AL extension. AL is statically typed enough to make this tractable |
| Symbol ingestion | Workspace `.al` source + `.app` symbol packages (source-aware: packages come with or without embedded source) + a pluggable `ExternalSourceProvider` seam | `.app` symbols unlock base-app event fanout and cross-app call resolution. The external-source seam lets Microsoft AL source (e.g. StefanMaron's MSDyn365BC.Code.History) be fed in later — **the downloader is NOT built now**, only the seam |
| MVP detector set | Foundation + 3 proof-of-model detectors; full catalog is a sequenced fast-follow within sub-project A | Each detector exercises a different engine part; keeps the spec focused; proves the model before building ~15 detectors |
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
│  native resolver: callsite → routine id               │
│  event catalog: publisher ↔ subscriber edges          │
└───────────────────────────┬───────────────────────────┘
┌─ L2  Semantic index ──────────────────────────────────┐
│  objects, routines, tables/fields/keys, record-vars   │
│  intraprocedural extraction: loops, record ops, calls │
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
| `indexer` | build L2 semantic index — objects, routines, tables, intraprocedural features | source-provider, parser |
| `resolver` | callsite → routine id; build call graph | indexer |
| `event-graph` | publisher/subscriber catalog → dispatch edges | indexer, symbol-reader |
| `summary-engine` | routine summaries, fixed-point over SCCs | resolver, event-graph |
| `path-walker` | bounded walk → evidence chain | resolver, event-graph |
| `detectors/*` | one file per detector, pure query over L4 | summary-engine, path-walker |
| `model` | the serializable `SemanticModel` + `Finding` types — shared vocabulary | — (pure types) |
| surfaces (`cli`, `mcp`, `lib`) | thin wrappers | detectors, model |

**Boundary rule:** L0–L4 produce a serializable `SemanticModel`. al-perf (sub-project B)
imports al-sem, gets that model, overlays profile data. Detectors (L5) are also just
consumers — al-perf could run its own fused detectors against the same model later.

## Section 2 — Core Data Model

Everything serializes to a `SemanticModel` (JSON), which al-perf consumes later.

### Stable IDs — structured strings, content-hashed

```
AppId       = "{publisher}.{name}.{version}"
ObjectId    = "{appId}/{objectType}/{objectNumber}"
RoutineId   = "{objectId}/{kind}/{name}/{signatureHash}"
TableId     = "{appId}/table/{number}"
FieldId     = "{tableId}/{fieldNumber}"
CallsiteId  = "{routineId}/cs{index}"
LoopId      = "{routineId}/loop{index}"
```

Every `Object` and `Routine` also carries `sourceHash` (content hash). **Reason:**
sub-project B (profile fusion) must detect profile-vs-source version mismatch — a profile
from v1.2.3 analyzed against v1.3.0-dev source produces convincing nonsense. The matching
logic is not built now, but the hash must be in the model from day one.

### Entities (L2 index)

`App`, `Object` (table/page/report/codeunit/...), `Routine` (procedure/trigger/event-pub/
event-sub), `Table`, `Field` (FieldClass, calc formula, blob/media flag), `Key` (fields,
SIFT/SumIndexFields), `RecordVariable` (tableId, isTemporary).

`Routine` carries: intraprocedural features (loops, record ops, calls, field accesses —
evolved from al-perf's current `ProcedureFeatures`), `bodyAvailable: boolean` (false = opaque
`.app` symbol), and the computed `summary`.

### RoutineSummary — the interprocedural unlock (L4)

```ts
interface RoutineSummary {
  routineId: RoutineId;
  touchesDb: boolean;              // transitive
  dbEffects: DbEffect[];           // direct + inherited, with provenance
  writesTables: TableId[];
  publishesEvents: EventId[];
  commits: boolean;
  inRecursiveCycle: boolean;       // SCC member
  hasUnresolvedCalls: boolean;     // dynamic dispatch / missing symbol → lowers confidence
  fieldEffects?: FieldEffectSet;   // optional, only computed for detectors that need it
}

interface DbEffect {
  op: RecordOpType;
  tableId: TableId;
  recordVarIsTemporary: boolean | "unknown";   // temp records ≠ SQL round-trip
  loopDepthAtSite: number;
  callsiteId: CallsiteId;
  via: "direct" | "inherited";
}
```

`fieldEffects` is optional on purpose — Approach 3's "symbolic detail only where a detector
needs it." The `SetLoadFields` detector triggers its computation; `db-op-in-loop` never pays
for it.

### Finding — structured, evidence-backed

```ts
interface Finding {
  id: string;
  detector: string;
  title: string;
  rootCause: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: "confirmed" | "likely" | "possible";   // static-only ceiling = "likely"
  evidencePath: EvidenceStep[];    // loop → call → call → DB op
  affectedObjects: ObjectId[];
  affectedTables: TableId[];
  fixOptions: FixOption[];         // ranked, each with a safety label
  provenance: Evidence[];          // tree-sitter | symbol-pkg | external-source
}

interface EvidenceStep {
  routineId: RoutineId;
  callsiteId?: CallsiteId;
  loopId?: LoopId;
  sourceRange: SourceRange;
  note: string;
}
```

**Static-only confidence ceiling = "likely".** "confirmed" is reserved for sub-project B,
when a profile backs the finding. `hasUnresolvedCalls` on any step in the path caps the
finding at "possible".

`SemanticModel = { apps, objects, routines (with summaries), tables, callGraph, eventGraph }`.
In-memory form uses `Map`/`Set`; serialized form uses arrays/records. One `model` unit owns
both representations and the conversion (serde).

## Section 3 — Data Flow (the pass pipeline)

Six passes, strictly ordered. Each pass is a pure function over the previous pass's output,
testable in isolation.

```
1. DISCOVER & LOAD     source-provider enumerates workspace *.al
                       + .alpackages/*.app  →  detects source-bearing apps
                       output: SourceUnit[]  (path, kind, hasBody)

2. PARSE & INDEX       each .al → tree-sitter AST → semantic index
   (L0–L2)             each .app → SymbolReference.json → symbol records
                       intraprocedural extraction per routine:
                         loops, record ops, calls, field accesses, record-vars
                       output: SemanticIndex  (objects, routines, tables/fields/keys)

3. RESOLVE GRAPH       each callsite → RoutineId  (native resolver)
   (L3)                event catalog → publisher↔subscriber dispatch edges
                       unresolved (dynamic dispatch / missing symbol) → flagged
                       output: CallGraph + EventGraph

4. COMPUTE SUMMARIES   condense call graph into SCCs (Tarjan)
   (L4)                topological order; bottom-up compose summaries
                       within an SCC: fixed-point iteration with widening
                       field-effects: lazy — only for routines a detector asks about
                       output: RoutineSummary per routine  →  SemanticModel complete

5. RUN DETECTORS       each detector:  prune via summaries
   (L5)                  → bounded path-walk down interesting branches only
                          → build EvidenceStep[] chain  →  Finding[]
                       output: Finding[]

6. EMIT                SemanticModel + Finding[]  →  surface
                       (JSON for lib/al-perf · terminal for CLI · MCP response)
```

**Recursion** (pass 4): SCC-collapse turns a recursive cycle into one node. Fixed-point
iteration *within* the SCC with widening — `touchesDb` and friends are monotonic
booleans/sets, so it converges quickly. `inRecursiveCycle = true` on every member.

**Opaque callees** (pass 4): an `.app` symbol with no body gets a summary of
`{ hasUnresolvedCalls: true, touchesDb: "unknown" }`. It propagates upward as
confidence-lowering, never as a false "clean."

**Caching:** hash-invalidated, like al-perf's existing source cache. Per-file parse cache
(keyed on `sourceHash`); summary cache (keyed on call-graph hash). The seam is designed now;
a basic implementation ships in the MVP.

**Non-goal (seam only):** incremental re-index on single-file change. Batch re-run is fine
for CI/MCP. Pass boundaries are clean enough to add incrementality later — it is not built
now.

## Section 4 — The 3 Proof Detectors

Each detector is one file, a pure query over `SemanticModel`. Each exercises a different
engine part — that is the point of the selection.

### D1 — Interprocedural DB-op-in-loop
- **Trigger:** a `Loop` in a body-available routine.
- **Prune:** for each callsite inside the loop, check callee `summary.touchesDb`. (Direct
  in-loop DB ops are caught too — but the new power is detection *via calls*.)
- **Walk:** loop → bounded walk down call edges where `summary.touchesDb` is true → until the
  `DbEffect` site. Build the `EvidenceStep[]` chain.
- **Finding:** severity by op (`FindSet`/`CalcFields`/`Modify` worst); `loopDepthAtSite`
  raises it. `recordVarIsTemporary === true` → drop to info (temp ≠ SQL round-trip).
  `hasUnresolvedCalls` on the path → cap at "possible".
- **Proves:** call graph + summary composition + loop-multiplier + bounded walk.

### D2 — Event fanout in loop
- **Trigger:** an event-publish callsite inside a `Loop`.
- **Prune:** resolve publisher → subscribers via `EventGraph`; check each subscriber's
  `summary.touchesDb` / `writesTables` / `commits`.
- **Walk:** loop → publish site → each DB-touching subscriber → its effect. Subscribers may
  live in other apps (resolved via `.app` symbols).
- **Finding:** one per hot event. Evidence lists subscribers + effects + **owning app**
  (extension attribution). An opaque subscriber drops confidence to "possible".
- **Proves:** event graph + cross-app resolution + symbol-package ingestion.

### D3 — Interprocedural missing/incomplete SetLoadFields
- **Trigger:** `FindSet`/`FindFirst` on a record var, with `SetLoadFields(subset)` or none.
- **Needs:** `fieldEffects` summary detail — lazy-computed here only. `FieldEffectSet` = the
  fields read per record var, including fields read in callees the var is passed into.
- **Walk:** from the find site → track that record var → into directly-resolved callees it is
  passed to (by `var` or value) → collect field accesses → diff against the loaded set.
- **Finding:** "partial record — field `X` accessed in callee `Y` → JIT load." Distinguishes
  *missing* vs *incomplete*. Bails to "possible" on `RecordRef`/`Variant`/unresolved.
- **Proves:** lazy field-effect summaries + record-var dataflow across the call boundary.
  This is the hardest of the three — record-var tracking is scoped to by-`var`/value passing
  into resolved callees only.

**Shared:** all three emit the same `Finding` shape; all are capped at "likely" confidence
(static-only); all produce a real `evidencePath`. A detector that cannot build a full path
does not emit — no path means no trust.

## Section 5 — Error Handling & Degradation

Core principle (inherited from al-perf): **produce a partial model, never crash.** Every
degradation is recorded so consumers know confidence dropped.

| Failure | Behavior |
|---------|----------|
| Unparseable `.al` (tree-sitter error nodes) | index what parses; mark routine `parseIncomplete`; exclude from detection; do not crash |
| Corrupt / missing `.app` | skip package, emit diagnostic, continue — that dependency becomes fully opaque |
| No `.alpackages/` at all | workspace-source-only mode; still runs; external calls all opaque |
| Unresolved callsite | **not an error** — it is data → `hasUnresolvedCalls`, lowers confidence |
| Cyclic call graph | not an error — SCC handles it |
| Detector throws | isolated — one detector failing does not kill the run; emit diagnostic, other detectors still produce findings |
| Symbol-vs-source mismatch | prefer source when `bodyAvailable`; the symbol package is fallback only |

**Diagnostics channel:** output is `{ model, findings, diagnostics }`. `Diagnostic[]` carries
`{ severity, stage, message, sourceRef? }` — parse failures, skipped packages, detector
crashes. Surfaces show a summary line ("3 files partially parsed, 1 package skipped");
`--verbose` / MCP get the full list.

**No silent "clean":** an opaque or partially-parsed region never reports as "no issues
found" — it reports as "not analyzed." Absence of a finding ≠ absence of a problem, and the
model records which regions were not analyzed.

## Section 6 — Testing Strategy (TDD)

TDD is mandatory — every layer has a well-defined interface, so behavior is specifiable
before implementation. Test pyramid bottom-up, matching the pass pipeline.

### Fixtures
- `test/fixtures/al/` — hand-written `.al` files, each isolating one construct (a loop
  calling a helper that does `FindSet`; a publisher-in-loop; a partial record passed to a
  callee; etc.).
- `test/fixtures/app/` — small synthetic `.app` packages, both source-bearing and
  symbol-only, for resolver + ingestion tests.
- `test/fixtures/expected/` — serialized `SemanticModel` + `Finding[]` snapshots for
  end-to-end golden tests.

### Layer-by-layer (each written test-first)

| Layer | Unit tests assert |
|-------|-------------------|
| L0 parser | known `.al` → expected AST shape; malformed → error nodes, no throw |
| L0 symbol-reader | `.app` zip → expected symbol records; corrupt zip → diagnostic |
| L1 source-provider | discovers workspace + packages; `hasBody` detection correct; `ExternalSourceProvider` stub returns empty cleanly |
| L2 indexer | per-routine intraprocedural extraction — loops/ops/calls/field-accesses match; stable IDs deterministic |
| L3 resolver | callsite → correct `RoutineId`; dynamic dispatch → flagged unresolved; event catalog edges correct |
| L4 summary-engine | composition correct; SCC fixed-point converges (recursive fixture); opaque callee → `hasUnresolvedCalls`; lazy field-effects only computed when asked |
| L5 detectors | each detector: known-positive fixture emits finding, known-negative emits nothing, evidence path complete and correct |

### Detector tests — the discipline (mirrors al-perf's convention)

Every detector needs known-positive + known-negative fixtures, plus negative-control cases
that specifically target false positives: temp record in loop (D1 must stay silent); event
with zero DB-touching subscribers (D2 silent); complete `SetLoadFields` (D3 silent);
`RecordRef` access (D3 → "possible", not crash or false "clean").

### End-to-end golden tests

Full pipeline on a multi-file fixture project → assert serialized `SemanticModel` +
`Finding[]` against a snapshot. Catches cross-layer regressions.

### Determinism

IDs are content-hashed and passes are pure functions → identical input must yield
byte-identical serialized output. A determinism test runs the pipeline twice and diffs the
JSON.

## Section 7 — Project Structure & Surfaces

New repo, TS/Bun, mirrors al-perf conventions.

```
al-sem/
  src/
    parser/      L0 — tree-sitter init, AST helpers
    symbols/     L0 — .app zip reader, SymbolReference.json parser
    providers/   L1 — WorkspaceProvider, AppPackageProvider, ExternalSourceProvider (stub)
    index/       L2 — indexer, intraprocedural extraction
    graph/       L3 — resolver (call graph), event-graph
    engine/      L4 — summary-engine, path-walker, SCC (Tarjan)
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
// + SemanticModel, Finding, Diagnostic type exports
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

- Profile fusion / overlaying `.alcpuprofile` data (sub-project B).
- Telemetry / App Insights ingestion (sub-project C).
- Regression comparison, perf budgets, fix planner, AI remediation (sub-project D).
- The full interprocedural detector catalog beyond the 3 proof detectors (sequenced
  fast-follow within sub-project A, separate plan).
- The Microsoft AL source downloader (only the `ExternalSourceProvider` seam is built).
- Incremental re-index on single-file change (only the seam — clean pass boundaries).
- VS Code / editor integration.
- LSP-client resolution path (native resolver only).

## Next step

Invoke the `writing-plans` skill to produce a detailed, phased implementation plan for
`al-sem`.
