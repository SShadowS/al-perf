# Phase P4: Regression fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Correlate runtime regressions (al-perf `compareProfiles`) with static deltas (`alsem diff`), matrixed by perf basis (I/O capability gains → total-time; CPU/structural deltas → self-time), with new/removed-method×procedure-added as the headline, a version-correspondence guard, and honest correlated/weakly-correlated/unexplained statuses.

**Architecture:** A pure diff-runner (invoke `alsem diff` + after-WS `fingerprint --inventory-only`) + `classifyDelta` (basis+strength) + `correlateRegressions` (exact-stableId join with union-on-collision, version guard) → `ComparisonResult.regressionFusion`, rendered in the comparison formatters + MCP. Additive + opt-in.

**Tech Stack:** TypeScript, Bun, Biome (validate with `bunx biome check`, NOT `bun run lint`). Branch `feat/alsem-fusion` (LOCAL — do not push). al-perf shells out to `U:\Git\alch-engine\target\release\alsem.exe` (frozen, has `diff` + inventory 1.1.0).

**Governing spec:** `docs/superpowers/specs/2026-06-10-phase-p4-regression-fusion-design.md` — implement to **Revision 2** (PR2-1..PR2-8). The frozen `alsem diff` contract: `diff-report` schema 1.0.0, `payload.findings[]` = `{ id, category, kind, severity, subject:{normalizedStableId, oldOriginalStableId?, newStableId?, displayName}, details:{kind, resourceKind?, resourceId?, op?}, coverageState }`.

**Reuses (established):** the engine-runner invoke/parse/cache/schema-gate pattern (P3.2); the shared canonical join `makeMethodJoinKey`/`makeRoutineJoinKey`/`normalizeTriggerName`/`canonicalObjectType` + the stableId↔method resolution (P3.2 `buildStableIdToMethodMap`); the alsem-stub harness; the per-surface render discipline.

---

## Task 1 (P4.0a): Add `deltaTotalTime` to MethodDelta + compareProfiles

**Files:** `src/output/types.ts` (MethodDelta), `src/core/analyzer.ts` (compareProfiles), comparison formatter snapshots/tests.

Satisfies PR2-1 (the total-time basis foundation).

- [ ] **Step 1: Read** `MethodDelta` (`output/types.ts:146-158`), `compareProfiles` delta computation (`analyzer.ts:372-401`, where `deltaSelfTime`/`deltaPercent` are computed from `afterMethod.selfTime - beforeMethod.selfTime`), and how `regressions[]` is filtered (`analyzer.ts:397` `deltaSelfTime > 0`) + sorted (`:418`).
- [ ] **Step 2:** Add `beforeTotalTime: number; afterTotalTime: number; deltaTotalTime: number; deltaTotalPercent: number` to `MethodDelta`. Compute them in `compareProfiles` from `before/afterMethod.totalTime` (additive, alongside the self-time delta). Build the regression candidate set so a method qualifies if `deltaSelfTime > 0 OR deltaTotalTime > 0` (was self-only) — keep the existing self-time sort as primary order; total-time is additional context.
- [ ] **Step 3: Tests + snapshots.** Update the comparison formatter tests/snapshots that pin MethodDelta shape (the new fields appear in comparison JSON always — this is a deliberate base enhancement). Add a test: a method whose TOTAL time regressed but self-time is flat (a new DB call in a child frame) now appears in the regression candidate set with `deltaTotalTime > 0, deltaSelfTime ≈ 0`.
- [ ] **Step 4:** `bun test`, `bun run format && bunx biome check src/output/types.ts src/core/analyzer.ts test/` (exit 0), `bunx tsc --noEmit`. Commit: `git add src/output/types.ts src/core/analyzer.ts test/ && git commit -m "feat(p4.0a): add deltaTotalTime to MethodDelta/compareProfiles (I/O-regression basis)"`

---

## Task 2 (P4.0b): diff-runner + classifyDelta + correlateRegressions

**Files:** Create `src/semantic/diff-runner.ts`, `src/semantic/regression-correlate.ts`; extend `test/fixtures/fusion/alsem-stub.ts` (a `diff` mode); tests.

Satisfies PR2-1/2/3/4/5/7/8.

- [ ] **Step 1: Read** `engine-runner.ts` (the invoke/parse/cache/schema-gate + the inventory parse from P3.2), `correlate.ts` (`makeMethodJoinKey`/`makeRoutineJoinKey`, the ambiguous-union pattern ~504-525), `views.ts` `buildStableIdToMethodMap`, `contracts.ts` (`RoutineIdentity`, the inventory parse), `aggregated.ts` (`MethodBreakdown`), `output/types.ts` (`MethodDelta`/`ComparisonResult`). The real `alsem diff` JSON shape (run `target/release/alsem.exe diff <wsA> <wsB> --format json --deterministic` on two corpus fixtures to see it).
- [ ] **Step 2: `diff-runner.ts`** — `runEngineDiff(beforeWs, afterWs, opts) → DiffAnalysis | EngineDisabled`. Invokes `alsem diff <beforeWs> <afterWs> --format json --deterministic` + `alsem fingerprint --inventory-only <afterWs> --deterministic`. Parses `payload.findings[]` into `DiffDelta[] = { id, category, kind, severity, subject:{normalizedStableId, oldOriginalStableId?, newStableId?, displayName}, resourceKind?, resourceId?, op? }` (preserve engine order) + the after-WS inventory into `RoutineIdentity[]`. Schema-pinned (`EXPECTED_DIFF_SCHEMA_VERSION="1.0.0"`, majorMatches). Also parse the workspace `app.json` version (both before+after) for PR2-4. Never throws → `{disabled, reason}`.
- [ ] **Step 3: `classifyDelta`** (PR2-2) — pure `classifyDelta(category, kind) → { basis: "self"|"total"|"none"; strength: "strong"|"moderate"|"weak" }`. Table: `capability-gained-{commit,write,read}`→{total,strong}; `capability-gained-{http,file}`→{total,moderate}; `procedure-signature-changed`,`capability-gained-dynamic-dispatch`→{self,moderate}; `procedure-added`→{self,strong}; `capability-gained-{telemetry,isolated-storage}`→{self,weak}; `capability-gained-event-publish`+event deltas→{none(cross-boundary),weak}; others→{self,weak} default. A drift-guard test pins the table.
- [ ] **Step 4: `regression-correlate.ts`** — `correlateRegressions(comparison, diff, afterInventory, profileVersions) → RegressionFusion`.
  - Build the stableId→after-inventory-routine SET map (a method's canonical join key → all inventory `stableRoutineId`s under it — for union-on-collision, PR2-3).
  - For each regression candidate (`regressions[]` + the total-time candidates): resolve its canonical join key → the set of after-inventory stableRoutineIds → the `DiffDelta`s whose `newStableId ?? normalizedStableId` is in that set (FILTER the ordered `diff.findings[]` — PR2-8, no Map-order leak). On a multi-routine key (overload/field-trigger) attach the UNION with an `ambiguous` marker (PR2-3).
  - For each matched delta, `classifyDelta` it. A delta annotates the regression ONLY when the regression exists on the delta's BASIS (a `{total}` delta needs `deltaTotalTime>0`; a `{self}` delta needs `deltaSelfTime>0`) — PR2-1 matrix. Status: `correlated` (≥1 strong/moderate matching-basis delta), `weakly-correlated` (only weak), `unexplained-static` (regressed, no matching-basis delta).
  - New/removed correlation (PR2-5, headline): match `newMethods`/`removedMethods` (`MethodBreakdown[]`) to `procedure-added`/`-removed` diff deltas by the same key → `newMethodCorrelations`/`removedMethodCorrelations`.
  - Version guard (PR2-4): compare `profileVersions.before/after` (from the profile `declaringApplication.appVersion`) to the workspace app.json versions; set `correlationSummary.versionMismatch` when they differ.
  - Event-publish deltas → `staticOnlyChanges` tagged `cross-boundary` (PR2-7), not local correlations.
  - `RegressionFusion = { annotatedRegressions: AnnotatedRegression[], newMethodCorrelations, removedMethodCorrelations, staticOnlyChanges: DiffDeltaSummary[], correlationSummary: { correlated, weaklyCorrelated, unexplained, versionMismatch? } }` — plain arrays/objects, no Map (PR2-8). `AnnotatedRegression = { method: MethodDelta, staticDeltas: DiffDeltaSummary[], status }`. `DiffDeltaSummary = { category, kind, severity, displayName, basis, strength, resourceKind?, resourceId?, op?, ambiguous? }`.
- [ ] **Step 5: Stub `diff` mode** — extend alsem-stub to emit a `diff-report` (1.0.0) with a capability-gained-write (total/strong) on a routine + a procedure-added, and inventory rows, on `ALSEM_STUB_MODE=diff`.
- [ ] **Step 6: Tests** (`test/semantic/regression-correlate.test.ts`): a total-time regression + capability-gained-write on it → `correlated` (basis total); a self-flat/total-flat case; a capability-gained-telemetry-only → `weakly-correlated`; a regression with no delta → `unexplained-static`; an event-publish delta → `staticOnlyChanges` cross-boundary (not a local correlation); a new hot method + procedure-added → newMethodCorrelations; overload/field-trigger key collision → union with ambiguous marker; version mismatch → versionMismatch set; determinism (filter ordered findings, run-twice stable). `classifyDelta` drift-guard.
- [ ] **Step 7:** gates green. Commit: `git add src/semantic/diff-runner.ts src/semantic/regression-correlate.ts test/fixtures/fusion/alsem-stub.ts test/semantic/ && git commit -m "feat(p4.0b): diff-runner + classifyDelta + correlateRegressions (matrix basis, union join, version guard)"`

---

## Task 3 (P4.1): Comparison surface (CLI + MCP)

**Files:** `src/output/types.ts` (ComparisonResult.regressionFusion?), `src/cli/commands/compare.ts` + `src/core/analyzer.ts` (CompareOptions sources), `src/cli/formatters/{terminal,markdown,json}.ts` (the comparison formatters), `src/mcp/server.ts` (compare_profiles), tests.

Satisfies PR2-1/2/8 surface, the tiered render + version warning.

- [ ] **Step 1:** Add optional `regressionFusion?: RegressionFusion` to `ComparisonResult` (absent when no sources → byte-unchanged). Add `beforeSource?`/`afterSource?` to `CompareOptions` + the `compare` CLI command (`--before-source`/`--after-source`) + the MCP `compare_profiles` inputs.
- [ ] **Step 2: Render** in the comparison formatters (terminal/markdown/json; html reuses markdown). Under each annotated regression: the matching static delta(s) inline — `correlated` → prominent `[category] kind (strength) on resourceId`; `weakly-correlated` → muted "(runtime-neutral capability — unlikely to explain the +X% regression)"; `unexplained-static` → "no static change in this routine — cause is runtime/data/config or a callee; al-sem cannot explain it" (PR2-2 honest wording). A headline `newMethodCorrelations` section ("new hot method X — confirmed a new procedure"). A `staticOnlyChanges` summary (incl. cross-boundary event deltas). The version-mismatch warning rendered PROMINENTLY at the top when set (PR2-4). Render nothing when `regressionFusion` absent (byte-unchanged).
- [ ] **Step 3: MCP** `compare_profiles`: accept `beforeSource`/`afterSource`; include the `regressionFusion` block (bounded — top-N by deltaPercent). Never throw (degrade to plain comparison).
- [ ] **Step 4: Tests** per formatter: the tiered render (correlated/weakly/unexplained), the new-method headline, the version warning, and byte-unchanged when `regressionFusion` absent (gate against a PRE-P4 comparison golden — PR2-8). MCP with/without sources.
- [ ] **Step 5:** gates green. Commit: `git add src/output/types.ts src/cli/commands/compare.ts src/core/analyzer.ts src/cli/formatters/ src/mcp/server.ts test/ && git commit -m "feat(p4.1): regression-fusion comparison surface (CLI/MCP) — tiered render + version guard"`

---

## Task 4 (P4.2): One-workspace fallback + wiring + full gate + real-binary smoke

**Files:** `src/core/analyzer.ts` / `src/cli/commands/compare.ts` (the fallback + wiring), tests.

Satisfies PR2-6 (fallback), PR2-8 (verify).

- [ ] **Step 1: Wire** `compareProfiles`/the compare command: when both sources present → `runEngineDiff` + `correlateRegressions` → attach `regressionFusion`. When ONLY `afterSource` present → fall back to the existing single-snapshot P1-P3 fusion (`fuseProfile`/`annotateHotspots`/`prioritizeFindings`) on the AFTER profile, attaching it as a single-snapshot fusion view on the comparison (PR2-6, document the tier). When neither → plain comparison (byte-unchanged).
- [ ] **Step 2: Tests** for each tier (both/after-only/neither). The after-only fallback produces single-snapshot fusion on the after side.
- [ ] **Step 3: Real-binary smoke** (gated on `alsem.exe`): run `alsem diff` on two alch-engine corpus fixtures (a before/after pair — pick two versions or two similar fixtures), confirm al-perf's `runEngineDiff` parses the REAL `diff-report` + `correlateRegressions` produces a RegressionFusion. Document.
- [ ] **Step 4: Full gate.** `bun run format && bunx biome check src test` (your files exit 0; pre-existing owner churn not yours), `bunx tsc --noEmit`, `bun test`. Confirm fusion-off comparison byte-unchanged; "caused by"/false-causation wording absent (correlated-not-caused); determinism.
- [ ] **Step 5:** Commit: `git add src/core/analyzer.ts src/cli/commands/compare.ts test/ && git commit -m "feat(p4.2): one-workspace fallback + wiring; real-binary smoke; P4 full suite green"`

---

## Self-Review
- **Spec coverage:** PR2-1 (Task 1 deltaTotalTime + Task 2 matrix), PR2-2 (Task 2 classifyDelta + Task 3 tiers), PR2-3 (Task 2 union join), PR2-4 (Task 2 version guard + Task 3 warning), PR2-5 (Task 2 new/removed headline + Task 3 section), PR2-6 (Task 4 fallback), PR2-7 (Task 2 event cross-boundary), PR2-8 (determinism + additivity throughout).
- **Honesty:** matrixed basis (I/O→total, CPU→self) so no routine is falsely missed/blamed; correlated/weakly/unexplained tiers; version guard prevents comparing-wrong-things; event-publish cross-boundary out-of-scope; correlated-not-caused.
- **Additivity:** regressionFusion undefined-not-{} when off; deltaTotalTime is a deliberate base enhancement (snapshots updated); sources optional; graceful engine/old-schema/one-workspace fallback.
- **Reuse:** the canonical join + engine-runner + stub + per-surface render — no new key derivation, no new render system.
