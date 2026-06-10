# Phase P1: al-perf × al-sem Fusion — Correlation Substrate + CLI Boundary + Fused Model — Design

> **Context:** al-perf analyzes `.alcpuprofile` runtime data (where CPU goes); the al-sem Rust engine
> (`alsem` CLI) does static semantic analysis (why — evidence-backed `Finding[]`, call graph, effect
> summaries). This phase builds the FOUNDATION for fusing them: the boundary (al-perf shells out to the
> `alsem` CLI + parses its JSON), the identity-correlation layer, and the fused data model. P1 is the
> substrate; later phases ride on it — **P2** hotspot↔finding fusion + runtime-prioritized findings,
> **P3** call-graph/effect drilldown, **P4** regression fusion. Boundary = **shell-out to the `alsem`
> CLI** (user-confirmed): al-perf stays pure TS/Bun, loosest coupling, the CLI IS the stable versioned
> API. The whole fusion is **OPT-IN and OPTIONAL** — al-perf works profile-only when it's off/absent.

## Goal

Given a `.alcpuprofile` (al-perf's existing analysis) AND the AL workspace it was captured against,
produce a **fused model** that joins each al-perf hotspot/method with its correlated al-sem static
findings — by invoking the `alsem` CLI and correlating on `(objectType, objectNumber, routineName)`.
P1 produces the fused model + the correlation/coverage metadata; the UX/surfacing is P2+.

## Components (3 focused units + config, all under a new `src/semantic/` in al-perf)

### 1. `src/semantic/engine-runner.ts` — the CLI boundary
- **Locate the binary:** `--engine <path>` CLI option → `AL_SEM_BIN` env → `alsem` on `PATH`. If none
  found, the fusion is **disabled gracefully** (al-perf's profile-only output is unchanged; a single
  informational note, never an error). (Binary *distribution*/bundling is a post-final-flip concern;
  P1 invokes a provided binary.)
- **Invoke:** `alsem analyze <workspace> --format json --deterministic` (the analyze-report
  `DocumentEnvelope`: `payload.findings: FindingSummary[]` + `payload.summary` [coverage, detectorStats]
  + envelope `diagnostics`). Capture stdout + stderr + exit code; spawn via Bun's subprocess.
- **Exit-code contract** (mirror the engine's): 0 clean, 1 findings (still parse), 2 analysis-failure,
  3 config-error, 4 preflight/coverage-degraded. al-perf treats 0/1/4 as "result available" (4 surfaces
  a coverage-degraded warning), 2/3 as "fusion unavailable for this run" (degrade to profile-only +
  the stderr reason). **The engine never throws** — failures are in `diagnostics`; surface them, never
  crash al-perf.
- **Version-check** the envelope `schemaVersion`/`alsemVersion`; on an unrecognized major, degrade +
  warn (don't mis-parse). **Cache** the parsed result per `(workspaceContentHash, alsemVersion, args)`
  so repeated al-perf runs over the same workspace don't re-invoke (the engine is deterministic).
- Returns a typed `EngineAnalysis { findings: FindingSummary[], coverage, diagnostics, primaryApp,
  alsemVersion }` or `{ disabled, reason }`.

### 2. `src/semantic/correlate.ts` — the identity-correlation layer
- **Identity normalization:** al-perf method = `(objectType: string, objectId: number, functionName:
  string, appName)`. al-sem finding location = `objectId` (encoded `appGuid:objectType:objectNumber`),
  `objectName`, `routineName`, `file`, `line`. Parse the al-sem `objectId` → `(objectType, objectNumber)`;
  normalize `objectType` (case-fold + canonical BC spelling — `"Codeunit"` etc.); the `appGuid` is the
  analyze run's single primary app (al-sem analyze = one app/run), cross-checked against al-perf's
  `appName`/`primaryApp`.
- **The join:** build a multimap from al-sem findings keyed by `(normObjectType, objectNumber,
  routineName)` → `FindingSummary[]`. For each al-perf `MethodBreakdown`, look up its key.
- **Correlation status (be HONEST about each — this is the integrity of the fusion):**
  - `matched` — exactly one al-sem routine-identity matched; attach its findings (possibly empty =
    matched-but-clean).
  - `ambiguous` — multiple al-sem routines share `(objType, num, name)` (overloads; al-perf has no
    signature to disambiguate) → attach the UNION + mark ambiguous (P2 decides how to weight).
  - `blind-spot` — the hot method has NO al-sem identity: a builtin (`isBuiltin`), a dependency object,
    or one al-sem couldn't analyze (cross-check al-sem `coverage`/uncertainties). Mark the REASON.
  - `cold` (the inverse, surfaced at the workspace level) — al-sem findings whose routine has NO runtime
    sample in this profile (P2 uses this for "statically flagged but not hot").
- Pure function: `correlate(methods: MethodBreakdown[], engine: EngineAnalysis) → FusedModel`. No I/O.

### 3. `src/types/fused.ts` — the fused data model
- `FusedMethod = MethodBreakdown & { semantic: { status: CorrelationStatus, findings: FindingSummary[],
  reason?: string } }` (al-sem's `FindingSummary` type is mirrored as a local TS contract — al-perf
  does NOT import al-sem as a lib; the JSON contract is the interface, pinned to the envelope
  schemaVersion).
- `FusedModel = { methods: FusedMethod[], coldFindings: FindingSummary[], coverage: {…},
  correlationSummary: { matched, ambiguous, blindSpot, coldCount }, engine: { alsemVersion, primaryApp,
  diagnostics } }` (or `{ disabled, reason }`). This is the structure P2–P4 consume.

### Config / wiring
- A new `--workspace <dir>` input (the AL source the profile was captured against) + `--engine <path>`
  (or `AL_SEM_BIN`) on al-perf's relevant commands (commander). Both optional; absent → no fusion.
- P1 EXPOSES the fused model via the library API (a new `fuseProfile(aggregated, workspace, opts)` /
  an addition to the existing analyze path) — the CLI/MCP/web *surfacing* of it is P2+. P1's deliverable
  is the substrate + the model, with a minimal "N hotspots correlated, M blind-spots" summary line to
  prove it end-to-end.

## Data flow
`.alcpuprofile` → al-perf `processProfile`/`aggregateResults` → `MethodBreakdown[]` (existing).
`workspace dir` → `engine-runner` (`alsem analyze --format json`) → `EngineAnalysis` (new).
`(MethodBreakdown[], EngineAnalysis)` → `correlate` → `FusedModel` (new). All deterministic + cached.

## Error handling (al-perf must never regress to a crash)
Every failure mode degrades to profile-only + a surfaced reason: binary not found; workspace not given;
exit 2/3; version mismatch; malformed JSON; a workspace that doesn't match the profile (objectType/num
identities don't intersect → "0 correlated, check the --workspace matches the profiled app"). The
engine's own `diagnostics` (coverage-degraded, opaque deps) are surfaced, not swallowed.

## Testing (bun:test, al-perf conventions under `test/`)
- A committed fixture: a small `.alcpuprofile` + the matching AL workspace (`test/fixtures/...`) + a
  committed `alsem analyze --format json` golden for that workspace (so the correlation is testable
  WITHOUT the `alsem` binary present); PLUS a gated test that invokes a real `alsem` binary when
  `AL_SEM_BIN` is set (verifies the runner end-to-end + that the committed golden is current).
- Unit tests for `correlate` covering each status: matched (with + without findings), ambiguous
  (overload), blind-spot (builtin + dep + unanalyzed), cold. Identity-normalization tests (objectType
  case, objectId parse, appGuid/appName cross-check).
- Runner tests: binary-absent → disabled; exit 2/3 → degraded + reason; version mismatch → degraded;
  the cache hit. Determinism: the fused model is byte-stable for a fixed (profile, workspace, engine).
- al-perf's existing suites stay green (the fusion is additive + opt-in).

## Risks / decisions for the external review to stress
1. **Overload ambiguity** — al-perf keys on `functionName` (no signature); al-sem may have overloads
   (same name, different signature → distinct StableRoutineId). The `ambiguous` status + union is the
   P1 stance; is that right, or should P1 try line-range/sourceLocation disambiguation (al-perf's
   `MethodBreakdown.sourceLocation` vs al-sem's finding `line`)?
2. **The appGuid / multi-app** — al-sem `analyze` is single-app (fail-closed on multi-app); a profile
   can span multiple apps (base app + extensions + the customer app). P1 correlates only the analyzed
   app's methods; everything else is a `blind-spot` (reason: "not in the analyzed workspace"). Is
   single-workspace-per-fusion the right P1 scope (vs running `alsem` per app)?
3. **objectId encoding** — al-sem's `objectId` is `appGuid:objectType:objectNumber` (snapshot/`:`) vs
   internal `/` — confirm which the `analyze --format json` FindingSummary emits + parse robustly.
4. **The JSON contract coupling** — al-perf mirrors `FindingSummary`/the envelope as a local TS type
   pinned to `schemaVersion`. How is drift caught (a contract test against the committed golden + the
   version check)?
5. **Binary provenance** — P1 invokes a user-provided `alsem` (built from the `engine` branch, pre-
   rename). The runner must not assume a published binary; the version string is the engine's.
6. **Correlation when al-sem has a finding but al-perf's method is a different overload** — false-positive
   attribution risk. The `ambiguous` marking + (risk #1) line-range disambiguation bound this.

## Non-goals (P1)
The UX/surfacing (CLI tables, MCP tools, web) of the fused data (P2); runtime-prioritized finding
ranking (P2); call-graph/effect drilldown via `alsem fingerprint`/`digest` (P3); regression fusion via
`alsem diff` (P4); replacing al-perf's own `patterns.ts` (out of scope — the fusion ADDS al-sem
findings alongside); bundling/shipping the `alsem` binary with al-perf (post-final-flip).

## Self-review notes
- **Three isolated units** (runner = I/O + parse; correlate = pure join; fused types = the contract)
  — each testable independently; the runner is the only impure one. The fusion is strictly additive +
  opt-in, so al-perf's existing behavior is untouched when off.
- **Honesty is the design's spine:** matched/ambiguous/blind-spot/cold are first-class, never silently
  dropped — a fusion that over-attributes findings to the wrong overload, or hides what it couldn't
  correlate, is worse than no fusion. The coverage/diagnostics surface the engine's own honesty.
- **The CLI is the API:** no al-sem TS import; the versioned JSON envelope is the contract, pinned +
  drift-tested. This realizes the long-envisioned one-way `al-perf → engine` dependency cleanly.

---

# Revision 2 — folded from external adversarial review (2× opus + gemini-3.1-pro)

The reviewers found a **foundational hole** (the `analyze` JSON alone can't support the design's honesty
spine) plus ~15 concrete contract/correctness errors. The Goal stands; the Components/data-flow are
RESHAPED below. These rules SUPERSEDE the originals.

## R2-A (MUST) — the substrate is `fingerprint`(snapshot) + `analyze`(findings), not `analyze` alone
`alsem analyze --format json` emits ONLY `findings` + scalar `summary` counts — NO routine inventory,
NO primaryApp. So "matched-but-clean" (analyzed, no finding) is INDISTINGUISHABLE from "blind-spot"
(never analyzed), and `cold` / the workspace-mismatch GUID check are uncomputable — 3 of the 4 headline
statuses collapse. **Fix:** the runner makes TWO calls:
1. **`alsem fingerprint <ws> --format json` (NO query flag) → the `capability-snapshot` `DocumentEnvelope`**
   = the ROUTINE UNIVERSE. From `src/snapshot/types.ts`: `apps: AppIdentity[]` (primaryApp: appGuid +
   name/publisher/version — the mismatch check), `identities.stableIds` (the StableRoutineId per routine
   — the P3 call-graph join key), `contractFacts` (every routine/object — the inventory), `coverage`
   + `rootClassifications`. The per-routine `(objectType, objectNumber, routineName)` is decoded from
   the StableObjectId/contractFacts (string-split — see R2-C). This gives the universe → matched-clean
   = in-universe-without-finding; blind-spot = NOT-in-universe; cold = in-universe-with-no-runtime-sample.
2. **`alsem analyze <ws> --format json` → `findings: FindingSummary[]`** = the findings to attach.
Both deterministic + cached. **Snapshot SIZE risk (gemini):** a base-app-scale snapshot is 100MB+
(`operationIndex`/`callsiteIndex`/`typedEdges` dominate — none needed by P1). P1 needs ONLY `apps` +
`identities` + `contractFacts` + `coverage` + `rootClassifications`. Mitigation, in order of preference:
(a) **request a lean engine projection** — a small `alsem fingerprint --inventory-only` (or `--shard
primary-only` already limits to the workspace app) that omits the consumed-core; this is a cheap
pre-release engine addition (track it as a P1 dependency / coordinate with the engine repo). (b) failing
that, al-perf reads only the needed top-level keys (the parse is cached + deterministic; accept the cost).
DECISION: pursue (a) — a `--inventory-only` projection on the engine — as the clean answer; (b) is the
fallback if the engine change slips.

## R2-B (MUST) — REUSE al-perf's `--source` + `src/source/locator.ts`; do NOT invent `--workspace` or re-derive identity
al-perf's `analyze` already takes `-s, --source <path>` (the AL source dir, `cli/commands/analyze.ts:38`)
+ builds a source index + resolves methods→source via `matchToSource` (`src/source/locator.ts`). The
al-sem workspace IS that same AL source. **Fix:** the al-sem workspace = the existing `--source` dir
(when it's a directory with an `app.json`); do NOT add a parallel `--workspace`. Key the correlation off
al-perf's EXISTING canonical method key (`${functionName}_${objectType}_${objectId}`, used in
`aggregator.ts:63` + `locator.ts:58`) so identity normalization happens ONCE.
- **`matchToSource` swallows overloads** (`locator.ts:34` `.find()` returns the first) — REFACTOR it to
  return `SourceMatch[]` so the correlator can detect `candidates.length > 1` → `ambiguous`. (al-perf-side
  change, in scope.)

## R2-C (MUST) — the exact identity contract (delimiter, objectType, triggers, frame filtering)
- **objectId delimiter is `/` NOT `:`** — `analyze`/snapshot emit the internal `ObjectId` =
  `${appGuid}/${objectType}/${objectNumber}` (`al-sem src/model/ids.ts:32`). Parse on `/` into exactly 3
  segments (appGuid is a GUID, no `/`). Drop all `:`/snapshot-form assumptions. Contract-test against the
  committed golden.
- **objectType normalization table** (bidirectional, not just case-fold): al-sem emits AL-keyword case
  `Codeunit`/`XMLport`/`Table`/`Page`/`Report`/`Query`/`PageExtension`/`TableExtension`/`Enum`/`Interface`…;
  al-perf's runtime `normalizeObjectType` (`object-types.ts`) emits `CodeUnit`/`XMLPort`, AND al-perf's own
  `indexer.ts` uses `Codeunit`/`XMLport` (an INTERNAL al-perf divergence to unify). Runtime `TableData` →
  `Table`. Build one canonical table in `correlate.ts` + unify al-perf's two spellings. Test
  `XMLPort/XMLport`, `CodeUnit/Codeunit`, `TableData→Table`, the `*Extension` kinds.
- **Field/page TRIGGER name divergence** — the profile's `functionName` for a field/page trigger is the
  compound `"Sell-to Customer No. - OnValidate"` / `"No. - OnValidate"`; al-sem's `routineName` is the BARE
  AST name (`OnValidate`). Define a normalization (strip the `<member> - ` prefix / match the trigger
  suffix) AND first VERIFY al-sem's actual `routineName`/`routineKind` for field+page triggers (read the
  routine-indexer). Add OnValidate/OnInsert/page-control fixtures. (This is a LARGE class of real hotspots
  — getting it wrong mass-mislabels them blind-spot.)
- **Filter non-AL frames BEFORE computing blind-spot** — the profile contains SQL-statement frames (a whole
  `SELECT …` as `functionName`) + system/builtin frames (`isBuiltin`) that have an `applicationDefinition`
  but are not AL routines. Classify-and-EXCLUDE them from the correlation universe; the blind-spot
  denominator = "AL methods al-sem could plausibly own", not "every profile node".

## R2-D (MUST) — false-attribution: ambiguous = union + a confidence flag; NO line-disambiguation in P1
Overloads (same name) → `ambiguous`. Line-range disambiguation is UNSOUND in P1: al-perf's `sourceLocation`
is NULL exactly for overloads (`matchToSource` returns null on a multi-candidate tie), and al-sem's
`finding.line` is the EVIDENCE ANCHOR (e.g. the db-call callsite), not the routine declaration — no shared
coordinate contract. **Fix:** attach the UNION of the overloads' findings BUT stamp each ambiguous
attachment with `attributionConfidence: "ambiguous"` (vs `"exact"`); the union means "one of these may
apply" and P2/UX must NEVER render "this hotspot is caused by X" for an ambiguous match. Real
disambiguation is deferred to P3 (when al-sem's signature/call-graph can be joined).

## R2-E (MUST) — `matched-clean` / `cold` / `unkeyable` now computable (off R2-A's universe); the model is a SIDE MAP
- With the snapshot universe (R2-A): `matched` (exactly one universe routine; `attributionConfidence:exact`)
  / `ambiguous` (overloads) / `matched-clean` (in-universe, zero findings) / `blind-spot` (NOT in-universe;
  reason: builtin/dep/SQL-frame/unanalyzed-per-coverage) / `cold` (universe routine with no runtime sample).
- `FindingSummary.routineName` is OPTIONAL — a finding whose routine identity didn't resolve has no join
  key → put it in a distinct **`unkeyable`** bucket (reason: missing routine identity), NEVER folded into
  `cold` (which would misrender it as "statically flagged but not hot").
- **The fused model is a SIDE MAP, not a `MethodBreakdown &` intersection** — `Map<methodKey,
  SemanticAttribution>` keyed by al-perf's existing `${functionName}_${objectType}_${objectId}`. Strictly
  additive; al-perf's existing types/output are byte-IDENTICAL when fusion is off (trivially true with a
  sidecar). Also persist the matched routine's **StableRoutineId** on the attribution (even for
  matched-clean) so P3 can join the call graph.
- Reserve a **`corroboratingPatterns?: string[]`** slot on the attribution (al-perf's own `patterns.ts`
  `runDetectors` flags the same routine — the highest-value "static cause + runtime confirmation" signal)
  — unfilled in P1, so P2 isn't blocked.

## R2-F (MUST/SHOULD) — runner robustness + corrected contract
- **Subprocess TIMEOUT** (default ~60s, configurable) → on timeout, kill + degrade to profile-only +
  reason. (The "never crash" promise didn't cover hangs.)
- **Exit-code corrections:** `analyze` exits **1 ONLY with `--fail-on`** (the runner doesn't pass it → a
  findings-bearing clean run exits 0); **4 ONLY with `--require-dependencies`**. So coverage-degraded is
  surfaced via `summary.opaqueApps` + envelope `diagnostics`, NOT exit 4. Correct the runner's mapping:
  0/1 = result available; 2/3 = fusion unavailable + reason; surface degradation from opaqueApps/diagnostics.
- **Cache key** pinned to the document `schemaVersion` (the shape contract — `ANALYZE_CONTRACT_VERSION`/the
  snapshot schemaVersion), NOT `alsemVersion` (changes every release without a shape change). The
  `workspaceContentHash` = hash of the sorted `(relpath, size, mtime)` over `*.al` + `app.json` +
  `.alpackages` manifests (+ schemaVersion + args) — defined, cheap, correct-enough.
- **Mismatch detection** = identity intersection: parse each finding/snapshot `objectId` → appGuid; if the
  snapshot's `apps[].appGuid` / the analyzed app's identities don't intersect the profile's hot methods'
  `(objectType, objectNumber)` AT ALL (over a non-trivial profile), hard-warn "the --source workspace
  doesn't match the profiled app". Additionally cross-check the snapshot's `apps[].name/publisher` against
  the profile's per-node `declaringApplication{appName,appPublisher}` (the profile has app NAMES, no GUID).
- **Determinism:** after the ambiguous union, re-sort each method's attached findings by `(fingerprint,
  id)` (both on `FindingSummary`) so the fused model is byte-stable.

## R2-G (SHOULD) — scope clarifications
- **Batch mode** (`core/batch-analyzer.ts`): P1 fusion is PER-PROFILE only; batch fuses each profile
  against the one `--source` workspace + reports per-profile correlation rates. State it; don't try to
  cross-correlate a multi-profile batch.
- The `EngineAnalysis`/`FusedModel` `coverage` mirror type = the snapshot's actual `coverage` shape +
  `summary` counts (pin the local TS contract to the real fields, not an invented `coverage` object).

## Revised component summary (net)
`engine-runner.ts`: locate binary → invoke BOTH `fingerprint --format json` (universe; ideally
`--inventory-only`) AND `analyze --format json` (findings), with a timeout; parse the two envelopes
(version-pinned to schemaVersion); cache per workspaceContentHash. `correlate.ts`: normalize identity
(objectId `/`-split, the objectType table, trigger-prefix strip, non-AL-frame filter), reuse al-perf's
`matchToSource` (refactored → `SourceMatch[]`) for the method key, join findings onto the snapshot universe
→ the 6 statuses (matched/ambiguous/matched-clean/blind-spot/cold/unkeyable) with `attributionConfidence`,
persist the StableRoutineId, re-sort deterministically. `types/fused.ts`: a SIDE MAP `Map<methodKey,
SemanticAttribution>` (NOT a MethodBreakdown intersection) + the workspace-level coverage/mismatch/engine
metadata, pinned to the real envelope shapes. Reuses `--source` (no new `--workspace`).
