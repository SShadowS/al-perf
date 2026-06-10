# Phase P4: Regression fusion — runtime regressions × static capability/effect deltas — Design

> **Context:** P1–P3.2 fused a SINGLE runtime snapshot × a single static snapshot. P4 is the TEMPORAL
> complement: correlate RUNTIME REGRESSIONS (between a before/after profile pair, via al-perf's existing
> `compareProfiles`) with STATIC DELTAS (between the before/after AL source versions, via `alsem diff`).
> The payoff: "method X regressed +30% self-time, AND between these two versions it GAINED a Commit /
> DB-write / HTTP capability" — the behavioral change that likely explains the slowdown. Built on
> `feat/alsem-fusion`. Additive + opt-in — al-perf's comparison output is byte-unchanged without sources.

## Goal
Turn a before/after comparison into a regression-cause view: each runtime regression annotated with the
per-routine STATIC change (capability gained/lost, ABI signature change, event delta) that `alsem diff`
reports for that routine between the two versions. Honest: a coincident static change is CORRELATED with
the regression (it MAY explain it), never asserted as proven cause.

## What the two sides give us (verified)
- **al-perf `compareProfiles(beforeProfile, afterProfile) → ComparisonResult`** (`core/analyzer.ts:335`):
  `regressions: MethodDelta[]` / `improvements` / `newMethods` / `removedMethods` / `patternDeltas`.
  `MethodDelta` = `{ functionName, objectType, objectName, objectId, appName, beforeSelfTime,
  afterSelfTime, deltaSelfTime, deltaPercent, beforeHitCount, afterHitCount }` — identity is the SAME
  `${functionName}_${objectType}_${objectId}` the P1–P3 fusion joins on. Today `compareProfiles` takes
  ZERO source paths; `ComparisonResult` has no fusion field, no section system, no web view.
- **`alsem diff <old> <new>`** → `diff-report` schema 1.0.0 (byte-parity-stable; `cli_b_diff_differential`):
  `payload.findings[]`, each `{ id, category: abi|schema|events|capabilities|permissions, kind, severity,
  subject: { normalizedStableId, oldOriginalStableId?, newStableId?, displayName }, comparisonCone,
  details: {kind, ...}, coverageState:{old,new} }`. The CAPABILITIES category is per-ROUTINE effect
  deltas keyed by routine stableId: `capability-gained-{write,read,commit,http,telemetry,
  isolated-storage,file,dynamic-dispatch,event-publish}` (details: `{resourceKind, resourceId?, op}`),
  `capability-lost`/`-lost-under-coverage`; ABI: `procedure-signature-changed`/`-removed`/`-added`/…;
  Events: publisher/subscriber/contract deltas. NO analyzer-finding-appeared delta — P4 correlates
  CAPABILITY/ABI/EVENT changes, not finding deltas.

## The 4-input model (the key design decision)
A regression investigation has FOUR inputs: `beforeProfile`, `afterProfile` (al-perf has these) +
`beforeWorkspace`, `afterWorkspace` (the old & new AL source — `alsem diff` needs these). In practice
a regression investigation (an upgrade, a code change) HAS both source versions. So:
```
compare before.alcpuprofile after.alcpuprofile --before-source <oldWs> --after-source <newWs>
```
al-perf runs `alsem diff <oldWs> <newWs>` (the static delta) + `alsem fingerprint --inventory-only
<newWs>` (the routine universe of the AFTER version, for the stableId→method join). Both sources are
OPTIONAL — without them, comparison output is byte-unchanged (no regression fusion). Degrades gracefully
when the engine is absent (like P1).

## Components (staged P4.0 → P4.2)

### P4.0 — diff-runner + regression correlation (the substrate; pure + deterministic)
- `src/semantic/diff-runner.ts` (extend `engine-runner`): a `runEngineDiff(beforeWs, afterWs, opts) →
  DiffAnalysis | EngineDisabled`. Invokes `alsem diff <beforeWs> <afterWs> --format json --deterministic`
  + `alsem fingerprint --inventory-only <afterWs> --deterministic`. Parses the diff-report
  `payload.findings[]` into typed `DiffDelta[]` (category/kind/severity/subject/details) + the after-WS
  inventory into `RoutineIdentity[]`. Schema-pinned (`EXPECTED_DIFF_SCHEMA_VERSION = "1.0.0"`,
  majorMatches). Never throws → `{disabled, reason}`.
- `src/semantic/regression-correlate.ts`: `correlateRegressions(comparison, diff, afterInventory) →
  RegressionFusion`. For each `MethodDelta` in `regressions` (and optionally improvements), resolve its
  static deltas: map the routine to its after-WS inventory `stableRoutineId` (via the SHARED canonical
  key — `makeMethodJoinKey`/`normalizeTriggerName`/`canonicalObjectType` from correlate, reused exactly
  as P3.2's drilldown join), then find the `DiffDelta`s whose `subject` (newStableId ?? normalizedStableId,
  `:`-form) matches that stableRoutineId. Attach the matched deltas. Honest statuses: a regression with a
  coincident capability/ABI/event delta = `correlated` (the change MAY explain it); a regression with NO
  static delta = `unexplained-static` (regressed but no behavioral change in THIS routine — the cause is
  elsewhere/runtime-only); a static delta on a NON-regressed routine = surfaced separately
  (`static-only-change`). Renamed routines: honor the diff's `oldOriginalStableId`/`newStableId`.
- `RegressionFusion` (JSON-safe, the P2/R2-1 lesson): `{ annotatedRegressions: AnnotatedRegression[],
  staticOnlyChanges: DiffDeltaSummary[], correlationSummary }` where `AnnotatedRegression = { method:
  MethodDelta, staticDeltas: DiffDeltaSummary[], status: "correlated"|"unexplained-static" }` and
  `DiffDeltaSummary = { category, kind, severity, displayName, resourceKind?, resourceId?, op? }`. Plain
  arrays/objects — no Map.

### P4.1 — comparison surface (CLI + MCP)
`ComparisonResult` gains an OPTIONAL `regressionFusion?: RegressionFusion` (absent when no sources →
byte-unchanged). Render in the comparison formatters (`formatComparison` → terminal/markdown/json; html
reuses markdown today — so terminal + markdown + json cover all CLI surfaces). Under each regression: the
correlated static change inline — `[category] kind (severity) — e.g. "gained Commit on table X"`;
`unexplained-static` regressions noted honestly ("no static change in this routine — cause is runtime/
elsewhere"); a `staticOnlyChanges` summary section. MCP `compare_profiles`: accept optional
`beforeSource`/`afterSource`; include the `regressionFusion` block (bounded — weighted by deltaPercent;
the diff finding set is naturally per-routine-bounded). `compareProfiles` + the CLI `compare` command +
the MCP tool gain optional `beforeSource`/`afterSource` (CompareOptions extension).

### P4.2 — wiring + verify
`compareProfiles` (or the compare command) runs `runEngineDiff` + `correlateRegressions` when both
sources are present, attaches `regressionFusion`. Full gate + a real-binary smoke (run `alsem diff` on
two engine corpus fixtures, confirm al-perf parses the real diff-report + correlates). Web comparison
does NOT exist today (no web compare view) → OUT OF SCOPE (documented; a future phase if web compare is
built).

## Data flow
`compare(beforeProfile, afterProfile, beforeWs, afterWs)` → `compareProfiles` (runtime regressions) +
`runEngineDiff(beforeWs, afterWs)` (`alsem diff` deltas + after-WS inventory) → `correlateRegressions`
(join diff deltas ↔ MethodDelta by the canonical routine key) → `ComparisonResult.regressionFusion` →
rendered by the comparison formatters / MCP.

## Honesty / non-invasiveness
- CORRELATION not causation: a coincident capability/ABI/event delta is surfaced as "regressed AND
  gained X" — never "the regression was CAUSED by X." (Same discipline as P3.1's "runtime-correlated.")
- The diff is CAPABILITY/structural, NOT finding-appeared — surface "gained a Commit/DB-write/HTTP
  capability" / "signature changed", never "a new bug appeared."
- `unexplained-static` regressions are honest (regressed with no behavioral change in this routine — do
  not invent a cause).
- Additive + opt-in: no sources → no `regressionFusion` → comparison output byte-unchanged. Engine
  absent → graceful disabled. Old engine (diff schema < 1.0.0 major) → majorMatches/degrade.

## Testing (bun:test)
- P4.0: `runEngineDiff` parses a stubbed diff-report (extend the alsem-stub for a `diff` mode) +
  after-WS inventory; `correlateRegressions` joins a capability-gained delta to a regressed MethodDelta
  by the canonical key (incl. a field-trigger regression via normalizeTriggerName), the
  unexplained-static case (regression, no delta), the static-only case (delta, no regression), a renamed
  routine (oldOriginalStableId/newStableId). Determinism. Weighted/bounded.
- P4.1: the comparison formatters render the regression-fusion annotations (terminal/markdown/json) +
  byte-unchanged when `regressionFusion` absent. MCP compare_profiles with/without sources.
- P4.2: real-binary smoke (`alsem diff` on two corpus fixtures → al-perf parses + correlates).
- Full `bun test` green; fusion-off comparison byte-unchanged.

## Risks for the external (adversarial) review to stress
1. **The 4-input/workspace model:** is `--before-source`/`--after-source` the right UX? Is requiring TWO
   workspace versions realistic for a regression investigation, or should P4 degrade to a SINGLE
   (after) workspace + the single-snapshot fusion (P1-P3) when only one is available? What if the user
   has only profiles (no source)? Confirm the graceful-degradation tiers.
2. **The stableId↔MethodDelta join (soundness):** `alsem diff` subjects are `:`-form stableIds WITH a
   signature hash; the after-WS inventory has stableRoutineIds. Which diff id to join on —
   `newStableId` (the after side, matching the after-WS inventory + after profile) vs `normalizedStableId`?
   For a capability delta on an unchanged-signature routine they coincide; for an ABI-signature-changed
   routine the ids differ — does the join still land on the right after-profile method? Where can it
   mis-resolve (a routine in the diff but not the after-inventory; a field-trigger collapsing per RE-11;
   a renamed routine)? Must degrade to "no static delta" honestly, never a wrong attribution.
3. **The no-finding-delta reality:** `alsem diff` gives CAPABILITY/ABI/EVENT deltas, NOT analyzer-finding
   deltas. Is "regressed AND gained a Commit/DB-write capability" a SOUND causal-correlation signal, or
   are there capability gains that are runtime-neutral (a gained `telemetry`/`event-publish` capability
   that wouldn't explain a CPU regression)? Should P4 RANK/filter which capability kinds are
   perf-relevant (DB-write/read/commit/http = perf-relevant; telemetry/isolated-storage = weak)? The
   honesty of the correlation badge depends on this.
4. **Additivity:** `ComparisonResult.regressionFusion?` optional; comparison output (terminal/markdown/
   json) byte-unchanged when absent; the JSON path serializes `result` — confirm no Map (R2-1 lesson),
   no leak when off.
5. **Determinism + bounding:** the diff finding set + the join are deterministic; the annotated-
   regression list driven off the ordered `regressions[]`; MCP payload bounded.
6. **Parity/contract:** `alsem diff` is byte-parity-stable (1.0.0) — al-perf pins it. Confirm the diff
   schema/subject shapes consumed match exactly (a real-binary smoke).

## Non-goals (P4)
Web comparison (doesn't exist today). Analyzer-finding-appeared deltas (`alsem diff` doesn't emit them).
Changing al-perf's compareProfiles delta computation or `alsem diff` itself. The single-snapshot fusion
(P1–P3.2 — already shipped).

## Self-review notes
- **Reuses** the P3.2 stableId↔method resolution (the shared canonical key) + the engine-runner invoke/
  parse/cache/schema-gate pattern + the per-surface render discipline. The substrate (P4.0) is pure +
  deterministic; P4.1 is thin presentation over it.
- **Honesty propagates:** correlated-not-caused; capability/structural-not-finding; unexplained-static
  surfaced honestly. No surface upgrades a correlation to a cause.
- **Additive:** opt-in sources; byte-unchanged comparison when off; graceful engine/old-schema fallback.
- **The capability-perf-relevance ranking (risk #3)** is the key honesty knob — surface the
  perf-relevant capability gains (DB/http/commit) prominently, the weak ones (telemetry) muted or
  omitted, so the correlation signal is meaningful.
