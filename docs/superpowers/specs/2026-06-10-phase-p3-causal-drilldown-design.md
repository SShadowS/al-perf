# Phase P3: Causal drilldown — attribution precision + call-graph/effect evidence + sound cross-signal corroboration — Design

> **Context:** P1 (fusion substrate) + P2 (fusion UX across CLI/MCP/web) shipped on `feat/alsem-fusion`.
> The fusion joins runtime hotspots ↔ static al-sem findings at the routine level (`correlate.ts`),
> renders honest 6-status attributions + two derived views (`views.ts`). P3 deepens the *causality*:
> from "this hot routine has finding X" to "this hot routine is hot BECAUSE its callee Y does a
> table write in a loop, and al-perf's own runtime detector independently flags the same pattern."
> Built on `feat/alsem-fusion`. Additive + opt-in — al-perf byte-unchanged when fusion is off.

## Goal
Three bounded, sequenced components (user chose "Full P3, decomposed"):

- **P3a — attribution precision:** eliminate the field/control-trigger ambiguity. Today two fields'
  `OnValidate` collide on the bare join key `(Table, 50100, OnValidate)` → `ambiguous` (the union of
  both fields' findings, attributable to neither). Fix: carry the enclosing member so the join is
  precise → those become `matched`.
- **P3b — causal call-graph / effect evidence:** surface the *evidence path* each al-sem finding
  already carries (`analyze`'s `evidencePath` — the call chain to the issue, with operation/callsite/
  loop anchors), joined to the runtime cost of each step. Answers "where in the call chain does the
  cost/effect actually land."
- **P3c — sound cross-signal corroboration:** populate the P2-reserved `corroboratingPatterns` slot
  by matching al-perf's OWN runtime pattern detectors (N+1, repeated-siblings, modify-in-loop, …) to
  al-sem findings — but only when the pattern *kind* and the finding *kind* describe the SAME
  phenomenon (a curated mapping), never a naive same-routine intersection (the R2-13 false-causality
  trap).

Each component is independently shippable and independently valuable; they share the fusion substrate
(`correlate.ts` / `views.ts` / `fused.ts`) and are sequenced P3a → P3b → P3c (precision first so the
drilldown and corroboration attach to precise, non-ambiguous routines).

---

## P3a — Attribution precision (field/control-trigger disambiguation)

### The defect (today)
`correlate.ts` joins on `JoinKey = (canonicalObjectType, objectNumber, normalizeTriggerName(name))`.
`normalizeTriggerName("Sell-to Customer No. - OnValidate")` → `"OnValidate"`. al-sem's
`routine-inventory` stores field/control triggers under the **bare** trigger name, so every field's
`OnValidate` on Table 50100 maps to the SAME inventory key. When ≥2 inventory routines share a key,
`correlate` emits `status: "ambiguous"` with the UNION of all those fields' findings — correct-but-
imprecise (P1's honest fallback). On a wide table this is the COMMON case, not an edge.

### The fix — and its crux (engine dependency)
The profile DOES carry the discriminator (`"Sell-to Customer No. - OnValidate"`); al-perf throws it
away because the inventory has nothing to match the qualified form against. So the inventory must
expose the **enclosing member** (the field/control/action name) per trigger routine.

**Engine change (alch-engine `routine-inventory` projection):** add an optional
`enclosingMember?: string` to each `routineInventory[]` entry — the field/control/action name for a
member-trigger routine, absent for ordinary procedures and object-level triggers (OnRun, OnOpenPage).
Bump `INVENTORY_SCHEMA_VERSION` 1.0.0 → **1.1.0** (minor — additive optional field; al-perf's
`majorMatches()` accepts it, and an engine that predates it simply omits the field → al-perf falls
back to today's ambiguous behavior, so the change is backward/forward compatible both ways).

**THE CRUX — byte-parity scope — RESOLVED: Option (B), Rust-only.** Investigated before review:
the `routine-inventory` projection (`fingerprint --inventory-only`, `kind: "routine-inventory"`,
schemaVersion 1.0.0) is **Rust-only**. The al-sem TS oracle never emitted it (zero references to
`routine-inventory`/`inventory-only`/`routineInventory`/`INVENTORY_SCHEMA` in U:\Git\al-sem; no
inventory goldens). The alch-engine parity harness (`tests/cli_b_fingerprint_differential.rs`) runs
ALL fingerprint fixtures with `inventory_only: false`; `--inventory-only` is exercised only by the
Rust-internal `tests/cli_p1_inventory.rs` (no al-sem goldens, no KNOWN_DIVERGENCES coupling).
Therefore adding `enclosingMember` to `routineInventory[]` (alch-engine
`src/engine/l5/snapshot_full.rs:1068-1076`, `INVENTORY_SCHEMA_VERSION` at :1036) is a clean
single-repo Rust change: NO al-sem TS edit, NO golden rebaseline, NO KNOWN_DIVERGENCES impact, just
the Rust projection + its internal test. **Residual #1 review item (downgraded from the parity
question):** does the alch-engine MODEL actually carry the enclosing field/control/action name for a
member-trigger routine (so the projection CAN populate `enclosingMember`)? The L2/L3 indexer must
know which member a trigger belongs to — verify the data exists before relying on it; if it doesn't,
P3a needs an L2/L3 model addition (heavier), which the review must surface.

### al-perf side (P3a)
1. `contracts.ts`: add `enclosingMember?: string` to `RoutineIdentity`; bump
   `EXPECTED_INVENTORY_SCHEMA_VERSION` to `"1.1.0"` (keep `majorMatches` so a 1.0.0 engine still works
   → graceful degradation to ambiguous).
2. `engine-runner.ts`: parse `enclosingMember` from the inventory payload into `RoutineIdentity`.
3. `identity.ts` / `correlate.ts`: when the profile function name is a qualified member trigger
   (`"<member> - <trigger>"` where `<trigger>` is a known AL trigger keyword), extract `<member>` and
   build a PRECISE key `(objectType, objectNumber, member, trigger)`; match against inventory routines
   whose `(routineName == trigger AND enclosingMember == member)`. Fall back to the bare key ONLY when
   the inventory lacks `enclosingMember` (old engine) or the profile name is unqualified. A precise
   match → `status: "matched"` (no longer ambiguous). Determinism + the existing key for unqualified
   routines unchanged.
4. Honesty: if `enclosingMember` is present on the inventory but a profile member trigger STILL maps
   to >1 routine (genuine overloads, not field collisions), keep `ambiguous` — the fix removes the
   field-collision class, not true overload ambiguity.

### P3a tests
- A two-field-`OnValidate` fixture: with `enclosingMember` present → two distinct `matched`
  attributions (each field's finding attributed to that field), NOT one ambiguous union.
- Old-engine simulation (inventory without `enclosingMember`) → still `ambiguous` (graceful fallback).
- Unqualified routine (a plain procedure) → unaffected (same key, same match).
- A genuine overload (same name+member, two signatures) → still `ambiguous` (not over-claimed).

---

## P3b — Causal call-graph / effect evidence

### The opportunity (data already emitted, currently dropped)
`alsem analyze --format json` already emits, per finding, an `evidencePath: StableEvidenceStep[]` —
the call chain from the finding's anchor to the issue, each step carrying `routineId`, `sourceAnchor`,
a human `note` ("enters commitment", "calls", …), and optional `operationId` / `callsiteId` / `loopId`.
al-perf's `FindingSummary` contract today parses only `primaryLocation` / `terminalLocation` /
`affectedTables` / `pathCount` — **the evidence path is discarded.** P3b surfaces it and joins each
step to the runtime cost of the routine that step sits in.

### al-perf side (P3b)
1. `contracts.ts`: add `evidencePath?: EvidenceStep[]` to `FindingSummary`, where
   `EvidenceStep = { routineId: string; file: string; line: number; note: string; operationId?: string;
   loopId?: string }`. Parse it in `engine-runner.ts` from the analyze output (it's already in the
   JSON — purely additive parsing).
2. `views.ts`: a new derived structure on the finding's rendered form —
   `CausalStep = { note: string; routineName?: string; objectType?: string; objectId?: number;
   file: string; line: number; selfTimePercent?: number; totalTimePercent?: number; isHot: boolean }`.
   For each `EvidenceStep`, resolve its `routineId` (`:`-form) to a method in the profile (via the
   inventory's stableRoutineId↔(objectType,objectNumber,routineName) mapping the fusion already
   builds, then to the `MethodBreakdown`), and attach that method's `selfTimePercent`/`totalTimePercent`.
   `isHot = the step's routine is among the runtime hotspots`. Steps with no runtime sample carry no
   percentages (honest — "static-only step"). This produces, for a prioritized finding, a *causal
   chain annotated with where the time actually is* — e.g. "OnValidate (5% self) → CalcTotals (2%)
   → ReadLedger (loopId L1, **41% self**) ← the cost lands here."
3. Attach `causalSteps?: CausalStep[]` to `PrioritizedFinding` (P2's view). Bounded: only computed for
   the prioritized (weighted, selfTime>0) findings, not the cold bucket (R2-12 context-discipline).
4. **Optional richer source (documented, NOT built in P3b MVP):** `alsem digest` emits per-routine
   effect classification (COMMIT / WRITE_TABLE / UI / HTTP / EXTERNAL_CALL / LOOP) with witness
   via-paths, keyed by StableRoutineId. P3b MVP uses the finding's own `evidencePath` (no new
   subprocess, no new invocation). Adding a `digest` invocation for effect-typed drilldown is a
   documented P3b+ enhancement, deferred unless the evidencePath proves insufficient — it adds a
   subprocess, needs root selection, and widens the engine-runner contract.

### Rendering (P3b) — additive, all surfaces
- CLI: under a prioritized finding (the `fusion` section), an indented causal chain — each step
  `note @ routine (self%/total%)`, the hot step marked. Render nothing when `causalSteps` absent.
- MCP: include `causalSteps` on each `prioritized_findings` / `analyze_profile` weighted finding
  (bounded list — it's the high-value "why is this hot" payload; still excludes the cold bucket).
- Web: a collapsible causal chain under each prioritized finding row in `renderFusion`
  (`app.js`); `textContent` sink for raw strings (the P2 safety convention).

### P3b tests
- A finding with a multi-step evidencePath where the cost lands on a deep callee → `causalSteps` has
  the steps in order, the deep step carries the high `selfTimePercent` and `isHot: true`, the shallow
  steps carry their (lower) percentages.
- A step whose routine has no runtime sample → that step has no percentages, `isHot: false` (honest).
- Finding with no evidencePath (old engine / detector without a path) → `causalSteps` undefined,
  renderers emit nothing.

---

## P3c — Sound cross-signal corroboration

### The principle (R2-13, made sound)
al-perf runs its OWN runtime+source pattern detectors (`patterns.ts` / `source-patterns.ts` /
`source-only-patterns.ts` — 17 detectors: `repeated-siblings`, `high-hit-count`, `modify-in-loop`,
`record-op-in-loop`, `calcfields-in-loop`, `nested-loops`, `dangerous-call-in-loop`, …). al-sem emits
static findings (detectors d1…dN). When BOTH independently flag the SAME phenomenon on the SAME
routine, that is the highest-confidence cross-signal — "statically predicted AND runtime-observed."

**Soundness gate (the R2-13 trap):** a naive "routine has some al-perf pattern AND some al-sem finding
→ corroborated" is UNSOUND — an N+1 finding does not corroborate an unrelated `deep-call-stack`
pattern that merely shares a routine, and an inclusive-time orchestrator pattern does not corroborate a
lexical leaf finding. Corroboration is asserted ONLY when:
  1. the al-perf pattern *kind* and the al-sem finding *kind* describe the same phenomenon, per a
     **curated mapping table** (e.g. al-perf `repeated-siblings`/`high-hit-count` ↔ al-sem N+1/query-in-
     loop detectors; al-perf `modify-in-loop` ↔ al-sem write-in-loop; al-perf `calcfields-in-loop` ↔
     al-sem calcfields detector; al-perf `dangerous-call-in-loop` (Commit/Error in loop) ↔ al-sem
     commit-in-loop), AND
  2. they are on the SAME routine (the precise key — post-P3a), AND
  3. (where the pattern is inclusive-time, e.g. orchestrator-dominated) the routine is a leaf /
     `efficiencyScore > 0.8`, per R2-13's leaf-gate, so inclusive ≈ exclusive and the cross-link is
     about the same code, not a subtree.
The mapping is conservative: an unmapped (pattern, finding) pair is NOT corroborated (no false
positive). The mapping lives in one table (`corroboration-map.ts`), reviewed for soundness.

### al-perf side (P3c)
1. `fuse.ts` / a new `corroborate.ts`: `fuseProfile` already has the `methods` + runs `analyze`. P3c
   needs the al-perf `DetectedPattern[]` (already computed in `analyzeProfile` → `result.patterns`).
   Thread `result.patterns` into the fusion (a new optional arg to `fuseProfile`/`correlate`, or a
   post-correlate enrichment step). For each matched attribution, look up al-perf patterns on that
   routine (via `DetectedPattern.involvedMethods` parsed to (functionName, objectType, objectId)),
   apply the soundness gate (kind-mapping + leaf-gate), and record the corroborating pattern IDs.
2. Populate `SemanticAttribution.corroboratingPatterns` (the reserved field) with the matched pattern
   IDs; carry it through `annotateHotspots` (already plumbed) and onto `PrioritizedFinding`.
3. Determinism: sort the corroborating pattern IDs; the mapping lookup is pure.

### Rendering (P3c)
- All surfaces: when a finding/annotation has `corroboratingPatterns`, render a "⚡ runtime-confirmed
  (repeated-siblings)" badge — a distinct, earned signal. NEVER shown for an unmapped coincidence.
- MCP: include `corroboratingPatterns` on weighted findings (a strong LLM signal: "this static
  finding is independently confirmed by runtime patterns").

### P3c tests
- A routine with al-perf `repeated-siblings` + al-sem N+1 finding → corroborated (mapping hit + same
  routine). The finding's `corroboratingPatterns` contains the pattern id.
- A routine with al-perf `deep-call-stack` + al-sem N+1 finding → NOT corroborated (no kind mapping) —
  the soundness gate's key negative test.
- An orchestrator (low efficiencyScore) with an inclusive-time pattern + a leaf finding → NOT
  corroborated (leaf-gate). 
- Determinism: corroboratingPatterns sorted, byte-stable.

---

## Data flow (P3 overall)
`fuseProfile(methods, patterns, workspaceDir)` → `runEngine` (now also parses `enclosingMember` +
`evidencePath` from the existing inventory/analyze outputs) → `correlate` (precise keys, P3a) →
post-correlate enrichment: causal steps (P3b, join evidencePath ↔ methods) + corroboration (P3c, gated
pattern match) → `FusedModel` (attributions carry `corroboratingPatterns`; findings carry
`evidencePath`) → `views.ts` derives `causalSteps` + `corroboratingPatterns` onto `PrioritizedFinding`
/`HotspotAnnotation` → rendered additively on every surface.

## Error handling / non-invasiveness
Every P3 addition is OPTIONAL and gated: an old engine (no `enclosingMember`/`evidencePath`) →
graceful fallback (P3a stays ambiguous, P3b/P3c emit nothing); no `result.patterns` → no corroboration;
fusion off → al-perf byte-unchanged. The engine schema bump is minor (additive), so a newer engine
with an older al-perf, or vice versa, both degrade cleanly. The views stay pure + deterministic.

## Sequencing & decomposition
P3a → P3b → P3c, each its own spec-section → plan-section → subagent-driven task batch, each
two-stage-reviewed. P3a is the foundation (precise routines) but carries the engine/parity crux —
if the review finds the parity rebaseline too heavy for one phase, P3a MAY be split further or its
engine change executed as a separate fix-then-freeze step in the alch-engine repo first.

## Risks for the external (adversarial) review to stress
1. **The byte-parity crux (P3a):** is the `routine-inventory` projection under al-sem↔alch-engine
   byte-parity? If yes, the engine change is cross-repo + golden rebaseline (and KNOWN_DIVERGENCES
   must stay []); if no, Rust-only. Getting this wrong silently breaks the migration's parity contract.
   What's the right execution shape, and should the engine change be a separate freeze step?
2. **enclosingMember sufficiency:** does the field/control name fully disambiguate, or are there AL
   constructs (control add-ins, repeater sub-controls, page extensions adding triggers to the same
   field, table extensions) where (objectType, objectNumber, member, trigger) STILL collides? Is
   there a residual ambiguity class P3a misses (and must keep honest)?
3. **evidencePath↔method join soundness (P3b):** the evidencePath uses `:`-form StableRoutineId; the
   profile methods key on (objectType, objectNumber, routineName). The resolution must go
   StableRoutineId → inventory entry → (objectType,objectNumber,routineName) → MethodBreakdown. Where
   can this join silently mis-resolve (a routineId not in the inventory, an inlined/builtin step, an
   event-dispatch hop)? Must mis-resolution degrade to "no percentage" (honest), never a wrong cost.
4. **Corroboration mapping soundness (P3c):** is the kind-mapping table actually sound — does each
   mapped pair describe the SAME phenomenon, or are any pairs (e.g. al-perf `event-subscriber-hotspot`
   ↔ some al-sem finding) a category error? Does the leaf-gate correctly cover the inclusive-time
   patterns? What's the failure mode of a WRONG "runtime-confirmed" badge (false confidence) vs. a
   missed corroboration (merely a lost signal) — and is the table conservative in the safe direction?
5. **Determinism + additivity across all three:** any nondeterminism (pattern ordering, map
   iteration), any byte-unchanged-when-off violation, any `result.hotspots[i]` mutation, any
   unbounded LLM payload (causalSteps/corroboration on the cold bucket — must stay weighted-only).
6. **Scope/sequencing:** is bundling three components in one phase right, or should P3a (with its
   engine dependency) ship and freeze before P3b/P3c? Is the additive `FindingSummary.evidencePath`
   parse safe against the existing analyze contract version?

## Non-goals (P3)
P4 (regression fusion via `alsem diff`). The `digest`-based effect-typed drilldown (P3b uses the
finding's own evidencePath; digest is a documented future enhancement). Changing al-sem's detectors or
al-perf's pattern detectors (P3c only CORRELATES existing signals). Full call-graph visualization
(P3b surfaces the per-finding evidence chain, not the whole graph).

## Self-review notes
- **P3a is the foundation** (precise attribution) but the highest-risk (engine + parity); P3b/P3c are
  al-perf-only enrichments over data already emitted (evidencePath) or already computed (patterns).
- **Honesty propagates** (the P1/P2 spine): precise-or-ambiguous (never falsely precise), cost-where-
  observed (never inferred), runtime-confirmed only when earned (the sound mapping). No surface
  upgrades a claim.
- **Additivity is preserved:** every field optional, every render gated, engine bump minor/compatible,
  fusion-off byte-unchanged.
- **Reuses** the P1/P2 substrate (correlate/views/fused, the stableRoutineId↔method resolution, the
  per-surface render pattern, the `corroboratingPatterns` slot reserved in P2).

---

## Revision 2 — folded from the three-reviewer adversarial pass (2× opus + gemini-3.1-pro)

The original design above is SUPERSEDED where it conflicts with this block. Three independent reviewers
converged on findings that invalidate two of the spec's core premises (P3b's data source; P3a's
finding-split) and a category error in P3c's corroboration. All findings were verified against actual
alch-engine/al-perf code (including empirical `alsem` CLI runs). Implement P3 to THIS revision.

### R3-1 — P3b's premise is FALSE: `evidencePath` is NOT emitted by `analyze` (MUST) [opus×2]
`alsem analyze --format json` emits only scalar `pathCount` — NOT `evidencePath`. Verified in
`alch-engine/src/engine/gate/format_json.rs` (the emitted key set) + `gate/projection.rs` (the gate
`FindingSummary` has `path_count`, no `evidence_path`); the al-sem TS oracle agrees
(`finding-summary.ts`: `pathCount?` only). The full `evidencePath` (routineId/operationId/loopId)
exists ONLY on `StableFinding` (snapshot / R4 test projection / SARIF), and SARIF's threadFlow drops
`routineId`. So P3b is NOT "additive parsing of already-emitted data" — it requires an ENGINE change to
add `evidencePath` to the analyze report.

### R3-2 — The parity-migration bomb: `analyze` IS under byte-parity (MUST) [gemini; opus missed]
Unlike `routine-inventory` (Rust-only — safe), `analyze` is a CORE command under TS↔Rust byte-parity in
the migration. Adding `evidencePath` to the Rust `analyze` output breaks the parity harness instantly
(the TS oracle lacks it; KNOWN_DIVERGENCES must stay []). Therefore the P3b engine change MUST be a
NEW OPT-IN flag — `alsem analyze --format json --with-evidence` — that the parity harness explicitly
does NOT exercise (the default `analyze` output stays byte-identical to the TS oracle). al-perf's
fusion runner opts in. (Alternative — add evidencePath to BOTH al-sem TS + Rust and rebaseline — is
heavier and pointless given al-sem TS is slated for deprecation; the opt-in flag is the path.)

### R3-3 — P3a cannot split FINDINGS; the signature hash collapses field triggers (MUST) [opus×2, gemini]
Both field `OnValidate` triggers collapse to ONE `stableRoutineId` AND one internal `routineId` —
`canonical_routine_signature` (`alch-engine/src/engine/ids.rs:130-147`) hashes only
`name(params):ret`, ignoring the enclosing member and source position (verified empirically: a
two-field fixture emits two inventory rows with byte-identical stableRoutineId, and analyze findings
from both field bodies carry the same routineId, distinguished only by source `line`). Consequences:
- Adding `enclosingMember` to the inventory splits the METHOD-side universe map (P3a's method
  attribution works), BUT `project_finding` (`gate/projection.rs`) still gives both fields' findings
  the same bare `routineName`/`routineId` → the FINDINGS remain field-ambiguous. P3a as originally
  specified would flip the method to `matched` while the findings under it stay unsplit — a QUIETER
  honesty regression than today's explicit `ambiguous`. **Unacceptable.**
- **Do NOT fix this by changing the `StableRoutineId` signature hash** — that would change every
  routine id in every parity golden (analyze/fingerprint/digest/snapshot) → a migration-wide
  rebaseline AND a TS-oracle change. Instead the engine emits an ADDITIVE finding-side discriminator:
  a `enclosingMember?` (and `originatingObject?`, see R3-6) field on the finding's primaryLocation in
  the `--with-evidence` analyze projection (R3-2), leaving stableRoutineId untouched and parity intact.
- `digest` does NOT sidestep this (gemini): it keys via-paths by the same stableRoutineId → it rolls
  both fields' effects into one bucket. digest inherits the collision. So digest is not a P3b shortcut.

### R3-4 — `enclosingMember` is an L3 MODEL addition, not a projection read (MUST→cost) [opus-1, gemini]
The enclosing field/control name is recoverable from the syntax tree (`trigger_declaration`'s parent
`field_declaration`/`page_field`/`action`) BUT is NOT on `L3Routine` today — L3 assembly
(`alch-engine/src/engine/l3/l3_workspace.rs`) reads only `child_by_field_name("name")` (the bare
trigger) and never `routine.parent()`. So P3a's engine side = capture `routine.parent()`'s member
identifier during L3 assembly → new `L3Routine` field → surfaced in BOTH the inventory projection AND
the `--with-evidence` finding discriminator. Single-repo Rust + golden-safe (L3Routine is not
golden-serialized; inventory is Rust-only; analyze change is behind the opt-in flag), but budget it as
L3 model work, not a one-line projection tweak. **Verify the L2 indexer preserves enough parent context
at L3-assembly time before committing** (the residual #1, now confirmed real).

### R3-5 — Corroboration is a CATEGORY ERROR; split by detector PROVENANCE (MUST) [opus-2, gemini]
al-perf's 17 detectors are THREE shapes, and only one is runtime evidence:
- **(A) runtime call-tree** (`patterns.ts`): `repeated-siblings`, `high-hit-count`, `deep-call-stack`,
  `recursive-call`, `event-subscriber-hotspot`, `event-chain`, `single-method-dominance` — real
  measured time.
- **(B) source-correlated/lexical** (`source-patterns.ts`, impact BORROWED from method.selfTime):
  `modify-in-loop`, `record-op-in-loop`, `calcfields-in-loop`, `missing/incomplete-setloadfields`.
- **(C) source-only** (`source-only-patterns.ts`, `impact: 0`, NO runtime input): `nested-loops`,
  `unfiltered-findset`, `dangerous-call-in-loop`, `unindexed-filter`, `event-subscriber-with-*`.
The original spec's named corroboration pairs are MOSTLY B/C — al-perf's OWN static scans. Badging a
B/C agreement "runtime-confirmed" is a false-confidence LIE (two static analyses concurring is not
runtime evidence). **Only A-shape patterns may earn a runtime badge.** The map MUST be keyed by
detector PROVENANCE (`runtime` | `source-static` | `source-only`) — provenance is derived from which
detector array produced the pattern (`runDetectors` vs `runSourceDetectors` vs `runSourceOnlyDetectors`),
NOT recoverable from `DetectedPattern.id` alone, so `corroboration-map.ts` cannot be keyed on the id
string as the original spec implied. Conservative default: unmapped or non-runtime = NOT corroborated.
- **SAFE to map (runtime, same phenomenon):** `repeated-siblings` ↔ al-sem N+1 (d1/d4);
  `high-hit-count` ↔ al-sem N+1 (with the parent-anchor fix, R3-7); `recursive-call` ↔ d7
  (recursive-event-expansion) — a genuinely-safe pair the original spec OMITTED.
- **NEVER map:** all B/C pairs (`modify/record-op/calcfields/setloadfields-in-loop`,
  `dangerous-call-in-loop`, `nested-loops`, `unfiltered-findset`, `unindexed-filter`); and the
  runtime-shape-but-no-correspondence patterns (`deep-call-stack`, `single-method-dominance`,
  `event-chain`). **Hard-exclude `event-subscriber-hotspot`** — it is inclusive aggregate time across
  ALL subscribers, keyed to no single routine, so it can never be leaf-gated.
- B/C agreements MAY be surfaced as a separate, honestly-weaker "also statically flagged by al-perf"
  signal — NOT the runtime badge. (Optional; default is to omit them.)

### R3-6 — "runtime-confirmed" → "runtime-CORRELATED"; routine-level co-occurrence ≠ causation (MUST) [gemini; deeper than opus]
Even for the SAFE A-shape pairs, same-routine co-occurrence is CORRELATION, not causal confirmation: a
routine with Loop A (runtime `repeated-siblings`) and Loop B (static N+1 about a DIFFERENT loop) would
be falsely "confirmed" — a within-routine false positive the leaf-gate does NOT catch. Therefore:
- Rename the badge/concept "runtime-confirmed" → **"runtime-correlated"** (honest: co-occurring, not
  proven-same). No surface may claim runtime PROOF of a static finding without a positional join.
- STRONGER (where data permits): join on `loopId`/source line — al-sem findings carry a `loopId`/anchor
  (in the `--with-evidence` projection) and al-perf's runtime patterns carry the parent node + line;
  when both resolve to the SAME loop/line, THEN a stronger "runtime-confirmed" is earned. Absent the
  positional match, it stays "runtime-correlated."

### R3-7 — Corroboration join: provenance + anchor-method + P3a-key reconciliation (MUST) [opus-2]
- `DetectedPattern.involvedMethods` entries are display strings `"FunctionName (ObjectType ObjectId)"`.
  Do NOT round-trip-parse them; match against the live `MethodBreakdown` set using the SAME
  `formatMethodRef`/`methodAttrKey` the detectors used to produce them.
- Multi-method patterns need an explicit ANCHOR (which involved method carries the finding): the
  loop-owning PARENT — `involvedMethods[0]` for `repeated-siblings`, `involvedMethods[1]` for
  `high-hit-count` (the parent is the second entry there). A flat-membership match is unsound (would
  corroborate a finding on the callee).
- P3c's join key MUST reconcile with P3a's field-qualified precise key (R3-3): patterns carry only the
  bare profile `functionName`; reuse P3a's member-extraction so a field-trigger finding corroborates
  the RIGHT field. Until P3a's finding-split lands, P3c MUST REFUSE to corroborate field/control-
  trigger routines (only object-level/procedure routines, which don't collide) — else the badge can
  attach to the wrong field.

### R3-8 — `enclosingMember` insufficient for multi-extension triggers; add `originatingObject` (SHOULD) [gemini]
Two extensions (`Ext1`, `Ext2`) adding a trigger to the SAME base field collide on
`(Table, 50100, FieldA, OnValidate)`. The inventory/finding discriminator needs `originatingObject`
(the app/extension object that declares the trigger), not just `enclosingMember`, to be genuinely
precise. Add it alongside `enclosingMember` in R3-3/R3-4. (Residual ambiguity beyond this — genuine
overloads — stays honestly `ambiguous`.)

### R3-9 — RESHAPED DECOMPOSITION & SEQUENCING (MUST) [all three]
The original "one phase, P3a→P3b→P3c" bundles three components atop an engine that emits NEITHER
`enclosingMember` NOR `evidencePath` today. Re-sequence into three shippable stages:

- **P3.1 — al-perf-only, ZERO engine work, ship FIRST.** Runtime-correlation corroboration: the
  provenance-split map (R3-5), A-shape runtime pairs ONLY, "runtime-correlated" badge (R3-6),
  parent-anchor (R3-7), on the EXISTING (possibly-ambiguous) join keys — gated to object-level/
  procedure routines and to ambiguous-cluster matches that are honest at today's precision (R3-7). No
  engine dependency, immediate value, fully additive. This is the MVP.
- **Engine fix-then-freeze — alch-engine, ONE parity-aware change set, separate step.**
  (i) L3 model: capture trigger enclosing member + originating object (R3-4, R3-8);
  (ii) inventory projection: emit `enclosingMember?`/`originatingObject?` (Rust-only, safe);
  (iii) analyze: add `--with-evidence` opt-in flag emitting `evidencePath` + the finding-side
  member/object discriminator (R3-1, R3-2, R3-3) — parity harness skips it, default output unchanged;
  (iv) prove + freeze. NO `StableRoutineId` hash change. One schema bump on the opt-in projection only.
- **P3.2 — al-perf, AFTER the engine freeze.** P3a (precise method AND finding attribution, using the
  new discriminator) + P3b (surface `evidencePath` from `--with-evidence`, join to cost, honest
  degradation) + extend P3.1 corroboration to field-trigger routines (now precise) + optional
  loopId/line positional join for the stronger "runtime-confirmed" (R3-6).

### R3 — testing additions
- P3.1: provenance-split (a B/C pattern agreement → NOT badged; an A pattern same-phenomenon → badged
  "runtime-correlated"); parent-anchor (finding on callee → not corroborated); event-subscriber-hotspot
  hard-excluded; determinism (sorted, byte-stable); fusion-off byte-unchanged.
- Engine step: `analyze` default output byte-identical (parity), `--with-evidence` carries evidencePath
  + member/object discriminator; inventory carries enclosingMember/originatingObject; the two-field
  fixture now splits both method AND finding sides.
- P3.2: field-trigger finding attributed to the correct field; causal chain steps with honest
  no-percentage degradation on unresolved/builtin/cross-app steps; within-routine loop join (if built).
