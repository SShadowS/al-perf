# Phase P1: al-perf × al-sem Fusion Substrate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh
> implementer per task; after each task a two-stage review (spec-compliance + code-quality, opus);
> the cross-repo + correlation tasks get a THREE-reviewer pass (2 opus + gemini-3.1-pro). al-perf:
> `bun run` conventions, `bun:test`, biome (format before lint). Engine task: Rust, `rustfmt <files>`
> (NOT `cargo fmt`), commit LOCAL on the `engine` branch (NEVER push), NEVER touch LSP code. al-perf
> work is on the `feat/alsem-fusion` branch (local; do NOT push without explicit ask). Design:
> `docs/superpowers/specs/2026-06-10-phase-p1-alsem-fusion-substrate-design.md` — read it, **especially
> Revision 2 (R2-A…R2-G, the binding contract)**.

**Goal:** given a `.alcpuprofile` + the AL `--source` workspace, produce a fused SIDE-MAP joining each
al-perf hotspot to its correlated al-sem static findings (via the `alsem` CLI), with honest
matched/ambiguous/matched-clean/blind-spot/cold/unkeyable statuses. The substrate for P2–P4.

**Architecture:** OPT-IN, additive, sidecar. al-perf shells out to `alsem fingerprint --inventory-only`
(the routine UNIVERSE + identities + apps) + `alsem analyze --format json` (findings), correlates by
normalized `(objectType, objectNumber, routineName)` reusing al-perf's `src/source/locator.ts`, and emits
a `Map<methodKey, SemanticAttribution>` — al-perf's existing behavior is byte-unchanged when fusion is off.

**Tech Stack:** al-perf (TS/Bun, commander, bun:test, biome); the engine (Rust `alsem` CLI). Boundary =
subprocess + JSON; no al-sem TS import (the versioned envelope is the contract).

---

## Binding rules (Revision 2)
- **Substrate (R2-A):** TWO calls — `alsem fingerprint <ws> --inventory-only --format json` (the lean
  routine universe: `apps`, per-routine `(objectType,objectNumber,routineName)` + StableRoutineId,
  `coverage`, `rootClassifications`) + `alsem analyze <ws> --format json` (findings). Both deterministic,
  cached, version-pinned to the document `schemaVersion`, behind a subprocess TIMEOUT.
- **Reuse (R2-B):** the al-sem workspace = al-perf's existing `--source` dir (no new `--workspace`);
  key off al-perf's canonical method key `${functionName}_${objectType}_${objectId}`; refactor
  `matchToSource` → `SourceMatch[]` (expose overloads).
- **Identity (R2-C):** objectId split on `/` (3 segments); the objectType normalization table
  (`CodeUnit`↔`Codeunit`, `XMLPort`↔`XMLport`, `TableData`→`Table`, the `*Extension` kinds) + unify
  al-perf's own `object-types.ts`-vs-`indexer.ts` divergence; trigger-name normalization
  (`"<member> - OnX"`→`OnX`); FILTER non-AL frames (SQL-statement `functionName`, `isBuiltin`) before
  blind-spot.
- **Attribution (R2-D/E):** ambiguous (overloads) → UNION + `attributionConfidence:"ambiguous"` (never
  "caused by X"); NO line-disambiguation in P1; null-routineName findings → an `unkeyable` bucket (not
  `cold`); SIDE-MAP model (not a `MethodBreakdown` intersection); persist the matched StableRoutineId +
  reserve a `corroboratingPatterns?` slot; re-sort unioned findings by `(fingerprint,id)` for determinism.
- **Runner (R2-F):** timeout (~60s) → degrade; exit-code map (1 only w/ `--fail-on`, 4 only w/
  `--require-dependencies`; coverage-degraded from `opaqueApps`/diagnostics); mismatch = identity-
  intersection + `apps[].name/publisher` vs the profile's `declaringApplication`; cache key off
  `schemaVersion` + a `(relpath,size,mtime)` workspace hash.
- **Scope (R2-G):** per-profile only (batch = per-profile fusion). The engine never throws; al-perf never
  crashes — every failure degrades to profile-only + a surfaced reason.

---

## Task E1 (ENGINE, alch-engine `engine` branch): `fingerprint --inventory-only` lean projection

**Files (alch-engine):** Modify `src/bin/alsem.rs` (add `--inventory-only` to the fingerprint
subcommand), `src/engine/gate/fingerprint.rs` (the projection); Test: `tests/cli_p1_inventory.rs`.

This is a NEW al-perf-facing output (al-sem TS has no equivalent) — NOT a byte-parity-with-TS port. It
is a PROJECTION of the already-byte-parity capability-snapshot: emit the snapshot envelope (or a lean
`routine-inventory` doc) containing ONLY `apps`, `identities` (the StableRoutineId table), the per-routine
inventory (`contractFacts`-derived `objectType`/`objectNumber`/`routineName` + StableRoutineId), `coverage`,
`rootClassifications` — OMITTING the heavy consumed-core (`capabilityFacts`, `typedEdges`, `operationIndex`,
`callsiteIndex`, `callsiteResolutions`, `analysisGaps`). It carries its own `schemaVersion`.

- [ ] **E1.1 — Write the failing test** (`tests/cli_p1_inventory.rs`): for a fixture workspace, run the
  full `fingerprint --format json` (capability-snapshot) AND `fingerprint --inventory-only --format json`;
  assert the inventory doc's `apps`/`identities`/`coverage`/`rootClassifications` are byte-IDENTICAL to the
  full snapshot's corresponding keys (a projection-subset self-consistency check), the heavy keys are
  ABSENT, and the per-routine inventory lists every routine with its `(objectType,objectNumber,routineName)`
  + StableRoutineId. Run: `cargo test --test cli_p1_inventory` → FAIL (flag unknown).
- [ ] **E1.2 — Implement:** add `--inventory-only` (bool) to the fingerprint clap args; in the dispatch,
  when set, build the lean projection (reuse the snapshot derivers for `apps`/`identities`/`coverage`/
  `rootClassifications` + the per-routine identity list from the same source the snapshot uses; do NOT
  compute the consumed-core). Serialize via the existing canonical serializer (sorted keys / the
  insertion-order envelope as the full snapshot uses). Deterministic. Reject `--inventory-only` combined
  with a query flag / `cbor` if those don't apply (match the existing combo-validation style).
- [ ] **E1.3 — Run the test → PASS;** `rustfmt src/bin/alsem.rs src/engine/gate/fingerprint.rs`; full
  `cargo test` green (all A/B/C + gate differentials UNCHANGED — this is purely additive, a new flag).
  `KNOWN_DIVERGENCES.json` `[]`.
- [ ] **E1.4 — Commit (engine, LOCAL):** `feat(p1): fingerprint --inventory-only lean projection for al-perf fusion`. **Two-stage review** (the projection-subset correctness + no-regression).

## Task P1a (al-perf): the engine-runner (CLI boundary)

**Files (al-perf):** Create `src/semantic/engine-runner.ts`, `src/semantic/contracts.ts` (the local TS
mirror of the analyze-report + inventory envelopes, pinned to schemaVersion); Test:
`test/semantic/engine-runner.test.ts`.

- [ ] **P1a.1 — Write `contracts.ts`:** the local TS types mirroring the two envelopes — `InventoryDoc`
  (`{ schemaVersion, alsemVersion, apps: AppIdentity[], routines: RoutineIdentity[], coverage, ... }`,
  `RoutineIdentity = { stableRoutineId, objectType, objectNumber, routineName, objectName }`) and
  `AnalyzeReport` (`{ schemaVersion, alsemVersion, findings: FindingSummary[], summary, diagnostics }`,
  `FindingSummary`/`FindingLocation` mirrored from al-sem `src/projection/finding-summary.ts`). Pin
  `EXPECTED_*_SCHEMA_VERSION` consts.
- [ ] **P1a.2 — Write the failing tests** (`engine-runner.test.ts`): (a) binary-absent → `{disabled,
  reason}`; (b) a committed-golden run (fixture workspace) → parses both envelopes into `EngineAnalysis`;
  (c) exit 2/3 → degraded + reason; (d) schemaVersion mismatch → degraded; (e) timeout → degraded; (f) the
  cache hit (second call doesn't re-spawn). Run: `bun test test/semantic/engine-runner.test.ts` → FAIL.
- [ ] **P1a.3 — Implement `engine-runner.ts`:** `runEngine(workspaceDir, opts) → EngineAnalysis |
  {disabled, reason}`. Locate the binary (`opts.engine` → `AL_SEM_BIN` → `alsem` on PATH; absent →
  disabled). Spawn (Bun.spawn) BOTH `fingerprint <ws> --inventory-only --format json --deterministic`
  AND `analyze <ws> --format json --deterministic`, each under a `Promise.race` timeout (default 60s,
  `opts.timeoutMs`) → on timeout kill + degrade. Map exit codes (0/1 → parse; 2/3 → degrade + stderr
  reason; coverage-degraded surfaced from `summary.opaqueApps`/diagnostics, NOT exit 4). Version-check
  the document `schemaVersion` (unknown major → degrade). Cache the parsed result per
  `(workspaceContentHash, schemaVersion, args)` where `workspaceContentHash` = sha of sorted
  `(relpath,size,mtime)` over `*.al`+`app.json`+`.alpackages` manifests. NEVER throw — all failures →
  `{disabled, reason}`.
- [ ] **P1a.4 — Run tests → PASS;** `bun run format && bun run lint && bun run typecheck`.
- [ ] **P1a.5 — Commit (al-perf, feat branch, LOCAL):** `feat(p1): al-sem engine-runner (fingerprint+analyze CLI boundary)`. **Two-stage review** (no-throw + the exit/version/timeout/cache contract).

## Task P1b (al-perf): the correlation layer

**Files (al-perf):** Create `src/semantic/correlate.ts`, `src/semantic/identity.ts` (normalization);
Modify `src/source/locator.ts` (`matchToSource` → `matchAllToSource(): SourceMatch[]`, keep the old as a
`.find()`-of-the-new for back-compat); Test: `test/semantic/correlate.test.ts`,
`test/semantic/identity.test.ts`.

- [ ] **P1b.1 — `identity.ts` + tests:** `parseObjectId(id) → {appGuid, objectType, objectNumber}`
  (split on `/`, 3 segments); `canonicalObjectType(s)` (the bidirectional table: CodeUnit/Codeunit,
  XMLPort/XMLport, TableData→Table, Page/Report/Query/Enum/Interface/PageExtension/TableExtension);
  `normalizeTriggerName(functionName) → routineName` (strip the `<member> - ` prefix); `isAlRoutineFrame
  (method) → bool` (exclude SQL-statement functionNames + `isBuiltin`). Tests for each (incl.
  `"Sell-to Customer No. - OnValidate"→"OnValidate"`, `XMLPort↔XMLport`, a SQL frame → excluded).
- [ ] **P1b.2 — Refactor `matchToSource`** → expose `matchAllToSource(method, index): SourceMatch[]`
  (the multi-candidate set, for overload detection); reimplement the existing `matchToSource` as
  `matchAllToSource(...)[0] ?? null` so current callers are unchanged. Test: an overloaded
  `(functionName,objectType,objectId)` → `matchAllToSource` returns ≥2; `matchToSource` still returns one.
- [ ] **P1b.3 — Write the failing `correlate.test.ts`:** unit tests over a hand-built (MethodBreakdown[],
  EngineAnalysis) for each status — matched (exact, one universe routine, with + without findings →
  matched/matched-clean), ambiguous (2 universe routines same key → union + `attributionConfidence:
  ambiguous`), blind-spot (method not in universe → reason builtin/dep/SQL/unanalyzed), cold (universe
  routine, no method) , unkeyable (a finding with no routineName). + the determinism sort + the
  StableRoutineId persisted. Run → FAIL.
- [ ] **P1b.4 — Implement `correlate.ts`:** `correlate(methods, engine) → FusedModel` (PURE, no I/O).
  Build the universe multimap from `engine.routines` keyed by `(canonicalObjectType, objectNumber,
  routineName)`; build the findings multimap keyed the same (off each finding's `primaryLocation`); for
  each AL method (filtered by `isAlRoutineFrame`), normalize its key (canonicalObjectType +
  normalizeTriggerName), look up the universe → status; attach findings (union if ambiguous) re-sorted by
  `(fingerprint,id)` + `attributionConfidence` + the StableRoutineId; collect cold (universe routines with
  no method) + unkeyable findings. Compute the correlationSummary + the mismatch flag (zero intersection →
  warn; `apps[].name/publisher` vs the profile's declaringApplication).
- [ ] **P1b.5 — Run tests → PASS;** `bun run format && bun run lint && bun run typecheck`.
- [ ] **P1b.6 — Commit (al-perf, LOCAL):** `feat(p1): al-sem correlation layer (identity + 6-status join)`. **THREE-reviewer pass** (the correlation is the integrity core — false-attribution, the statuses, determinism, the identity table).

## Task P1c (al-perf): the fused model + wiring + end-to-end fixture

**Files (al-perf):** Create `src/types/fused.ts` (the `SemanticAttribution` + `FusedModel` side-map types),
`src/semantic/fuse.ts` (the `fuseProfile` library entry); Modify `src/index.ts` (export `fuseProfile`),
the relevant CLI command (`src/cli/commands/analyze.ts` — wire `--source` as the al-sem workspace + a
`--engine`/`--no-fusion` opt-in + a one-line "N correlated, M blind-spots" summary); Test:
`test/semantic/fuse.e2e.test.ts` + fixtures under `test/fixtures/fusion/` (a small `.alcpuprofile` + the
matching AL workspace + committed `alsem` inventory + analyze JSON goldens).

- [ ] **P1c.1 — `fused.ts`:** `SemanticAttribution = { status, findings: FindingSummary[],
  attributionConfidence, stableRoutineId?, reason?, corroboratingPatterns?: string[] }`; `FusedModel = {
  attributions: Map<string, SemanticAttribution>, coldFindings, unkeyableFindings, coverage,
  correlationSummary: {matched, matchedClean, ambiguous, blindSpot, coldCount, unkeyableCount}, mismatch?:
  {reason}, engine: {alsemVersion, primaryApp, diagnostics} } | {disabled, reason}`.
- [ ] **P1c.2 — `fuse.ts`:** `fuseProfile(methods: MethodBreakdown[], workspaceDir, opts) → FusedModel` =
  `runEngine` → (disabled? return) → `correlate`. Export from `src/index.ts`.
- [ ] **P1c.3 — Author the fixture:** `test/fixtures/fusion/` — a small AL workspace (a codeunit with a
  db-op-in-loop + an overload + a clean routine), the matching tiny `.alcpuprofile` (hand-authored or
  captured), and committed `inventory.json` + `analyze.json` goldens (dumped from a real `alsem` if
  `AL_SEM_BIN` is set, else hand-authored to the contract). Document how they were produced.
- [ ] **P1c.4 — Write `fuse.e2e.test.ts`:** (a) the committed-golden path → `fuseProfile` produces the
  expected FusedModel (matched-with-finding on the hot db-op routine, matched-clean, ambiguous on the
  overload, blind-spot on a builtin) — byte-stable; (b) fusion-off / binary-absent → `{disabled}` + the
  profile-only output is unchanged; (c) a GATED test invoking a real `alsem` (when `AL_SEM_BIN` set) that
  re-verifies the goldens are current. Run → FAIL → implement the wiring → PASS.
- [ ] **P1c.5 — CLI wiring:** in `analyze.ts`, when `--source` is a directory with `app.json` and fusion
  isn't disabled (`--no-fusion`/binary absent), call `fuseProfile` + print the one-line summary
  (`al-sem fusion: N hotspots correlated (M findings), K blind-spots, J ambiguous`); the fused model is
  available via the library API (the rich CLI/MCP/web surfacing is P2). al-perf's existing output is
  unchanged when fusion is off.
- [ ] **P1c.6 — `bun run format && bun run lint && bun run typecheck && bun test`** (al-perf's full suite
  green; the fusion is additive + opt-in). **Commit (al-perf, LOCAL):** `feat(p1): fused model + fuseProfile + --source fusion wiring + e2e fixture`. **THREE-reviewer pass.**

## Exit
- [ ] `fuseProfile(profile, --source workspace)` produces an honest fused side-map (6 statuses) by
  invoking `alsem fingerprint --inventory-only` + `analyze`; al-perf works profile-only when fusion is
  off/absent; al-perf's existing suites + the engine's full `cargo test` (KNOWN_DIVERGENCES []) green.
- [ ] Update both repos' docs (al-perf README "al-sem fusion (experimental)"; the engine migration doc
  notes the `--inventory-only` projection) + memory. NEXT: P2 (hotspot↔finding fusion UX + runtime-
  prioritized findings), then P3 (call-graph/effect drilldown via the StableRoutineId + fingerprint/
  digest), then P4 (regression fusion via `alsem diff`).

## Self-review notes
- **Spec coverage:** E1↔R2-A (the inventory projection); P1a↔R2-A/F (runner, two calls, timeout, exit,
  cache, version); P1b↔R2-B/C/D/E (reuse-source/locator, identity normalization, the 6-status join,
  attribution, determinism); P1c↔R2-E/G (side-map model, --source wiring, per-profile, the e2e fixture).
  Every Revision-2 rule maps to a task.
- **No placeholders:** each task names exact files, the test, the contract, the binding rule. The correlate
  + fused-model types are defined in P1b.1/P1c.1 and used consistently downstream.
- **Isolation:** runner (impure I/O) / correlate (pure) / fused types (contract) / fuse (compose) are
  separate units; the fusion is a strictly-additive sidecar, off by default.
