# Phase P3.2: Precise field-trigger attribution + causal-chain drilldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Consume the now-FROZEN engine schema (inventory 1.1.0 `enclosingMember`/`originatingObject`; `analyze --with-evidence` evidencePath + per-finding member discriminator) to (P3a) make field-trigger attribution PRECISE (ambiguous→matched), (P3b) surface the per-finding causal chain joined to runtime cost, and (P3c) extend P3.1 runtime-correlation to the now-precise field triggers.

**Architecture:** al-perf shells out to the rebuilt `alsem` (passing `--with-evidence`), parses the new inventory + finding fields, builds field-qualified join keys (case-insensitive; strip `&` for actions), and derives a causal chain on each prioritized finding. Additive + opt-in; fusion-off byte-unchanged.

**Tech Stack:** TypeScript, Bun, Biome (validate with `bunx biome check`, NOT `bun run lint`). Branch `feat/alsem-fusion` (LOCAL — do not push). al-perf shells out to `U:\Git\alch-engine\target\release\alsem.exe` (rebuilt from engine HEAD `f91ff12`).

**Governing spec:** `docs/superpowers/specs/2026-06-10-phase-p3-causal-drilldown-design.md` — P3.2 stage of Revision 2 (R3-9) + RE-1/RE-2/RE-3/RE-4. **Frozen engine schema:** `U:\Git\alch-engine\docs\engine-migration.md` "FROZEN" section.

**Frozen engine contract (consume exactly this):**
- `fingerprint --inventory-only` → schema **1.1.0**; each `routineInventory[]` entry MAY carry `enclosingMember` + `originatingObject` (present only for member triggers).
- `analyze --with-evidence --format json` → envelope `schemaVersion "1.1.0"`; each finding MAY carry `evidencePath: [{routineId(:-form), sourceAnchor, note, operationId?, callsiteId?, loopId?}]` and, on `primaryLocation`, `enclosingMember?`/`originatingObject?` (position-derived).
- **Join contract:** profile frames are `"<member> - <Trigger>"` (unquoted display name). Join member CASE-INSENSITIVELY. Strip `&` accelerators for action frames (`"Re&lease - OnAction"`). `originatingObject` joinable via the frame's scriptId+appId. RE-11: a field-collision routine may carry ONE finding (deduped) — attribute it precisely; the sibling field legitimately has no finding.

---

## Task 1 (P3a): Engine-runner contract — parse the new fields + invoke `--with-evidence`

**Files:**
- Modify: `src/semantic/contracts.ts` (`RoutineIdentity` + `FindingSummary` + the EXPECTED schema consts)
- Modify: `src/semantic/engine-runner.ts` (the analyze invocation + parse)
- Test: `test/semantic/engine-runner.test.ts` (or the existing contract/parse tests)

- [ ] **Step 1: Read & verify** the real shapes: `contracts.ts` `RoutineIdentity` (~42-47), `FindingSummary` (~144-161) + `FindingLocation`, `EXPECTED_INVENTORY_SCHEMA_VERSION`/`EXPECTED_ANALYZE_SCHEMA_VERSION` (~17-20) + `majorMatches`. `engine-runner.ts` the `invCmd`/`anaCmd` (~553-576), the inventory + analyze parse into `EngineAnalysis`, the schema-version gate.

- [ ] **Step 2: Extend contracts (additive).**
  - `RoutineIdentity`: add `enclosingMember?: string`, `originatingObject?: string`.
  - `FindingSummary.primaryLocation` (FindingLocation): add `enclosingMember?: string`, `originatingObject?: string`. `FindingSummary`: add `evidencePath?: EvidenceStep[]` where `EvidenceStep = { routineId: string; file: string; line: number; note: string; operationId?: string; loopId?: string }`.
  - Bump `EXPECTED_INVENTORY_SCHEMA_VERSION` → `"1.1.0"`, `EXPECTED_ANALYZE_SCHEMA_VERSION` → `"1.1.0"`. Keep `majorMatches` so an older 1.0.0 engine still works (the new fields simply absent → graceful fallback to today's behavior).

- [ ] **Step 3: Invoke `--with-evidence`.** In `engine-runner.ts` `anaCmd`, add `"--with-evidence"` to the analyze args. Parse `enclosingMember`/`originatingObject` from each inventory routine into `RoutineIdentity`, and `evidencePath` + the per-finding `primaryLocation.enclosingMember`/`originatingObject` into `FindingSummary`. (The inventory cache key already includes the schema versions — confirm the cacheKey reflects the bump so stale caches don't mask the new fields.)

- [ ] **Step 4: Tests.** Update the stub `test/fixtures/fusion/alsem-stub.ts`: its `findings` mode now emits inventory rows with `enclosingMember` (for a field trigger) + analyze findings with `evidencePath` + `primaryLocation.enclosingMember`, at schema 1.1.0. Assert engine-runner parses them into `EngineAnalysis.routines[].enclosingMember` + `findings[].evidencePath`/`primaryLocation.enclosingMember`. Assert an old-engine stub (1.0.0, no new fields) still parses (graceful).

- [ ] **Step 5:** `bun test test/semantic/`, `bun run format && bunx biome check src test` (your files exit 0), `bunx tsc --noEmit`. Full `bun test` green.

- [ ] **Step 6: Commit.** `git add src/semantic/contracts.ts src/semantic/engine-runner.ts test/ && git commit -m "feat(p3.2a): parse inventory/finding enclosingMember + evidencePath; invoke analyze --with-evidence"`

---

## Task 2 (P3a): Precise field-qualified correlation

**Files:**
- Modify: `src/semantic/identity.ts` (member extraction from the profile name) + `src/semantic/correlate.ts` (the join)
- Test: `test/semantic/correlate.test.ts`

Satisfies R3-9 P3a, RE-4 (case-insensitive + strip `&`), RE-11 (precise single-finding attribution).

- [ ] **Step 1: Read** `identity.ts` `normalizeTriggerName` (~203-211, the `" - "` split + AL_TRIGGER_KEYWORDS), `correlate.ts` `makeJoinKey`/`makeMethodJoinKey`/`makeRoutineJoinKey` (~59-77) + the ambiguous branch (~366-388).

- [ ] **Step 2: Member-aware key.** Add `extractMemberTrigger(functionName) → { member: string, trigger: string } | null` in identity.ts: when the name is `"<member> - <trigger>"` and `<trigger>` is a recognized AL trigger keyword, return `{ member, trigger }` (member with `&` stripped — RE-4 action caveat). Build a PRECISE join key `(canonicalObjectType, objectNumber, member.toLowerCase(), trigger)` when the method is a member trigger AND ≥1 inventory routine for the bare key carries `enclosingMember`; match against inventory routines whose `(routineName == trigger AND enclosingMember.toLowerCase() == member.toLowerCase())`. Case-insensitive on the member.

- [ ] **Step 3: Precise resolution in correlate.** When the bare join key has multiple universe routines (today → ambiguous), if they carry `enclosingMember`, re-resolve by the precise member key: a unique match → `status: "matched"` attributed to that field (no longer ambiguous). Fall back to `ambiguous` ONLY when enclosingMember is absent (old engine) OR the precise key still has >1 (genuine overload). Per RE-11, a precise routine may carry one finding (the deduped survivor) — attribute it; a sibling field whose key resolves to a routine with no findings → `matched` with no findings (honest, not ambiguous).

- [ ] **Step 4: Tests.** Two-field-OnValidate fixture (inventory rows carry distinct enclosingMember): the two profile frames `"Sell-to Customer No. - OnValidate"` + `"Bill-to Customer No. - OnValidate"` → TWO distinct `matched` attributions (each to its field), NOT one ambiguous union. Case-insensitivity (`"sell-to customer no. - OnValidate"` still matches). Action frame `"Re&lease - OnAction"` → `&` stripped, matches inventory `Release`. Old-engine (no enclosingMember) → still ambiguous (graceful). Genuine overload (same member+trigger, two sigs) → still ambiguous.

- [ ] **Step 5:** gates green (`bunx biome check`, tsc, `bun test`).

- [ ] **Step 6: Commit.** `git add src/semantic/identity.ts src/semantic/correlate.ts test/ && git commit -m "feat(p3.2a): precise field-qualified attribution via enclosingMember (case-insensitive, strip &)"`

---

## Task 3 (P3b): Causal-chain view + render

**Files:**
- Modify: `src/semantic/views.ts` (CausalStep on PrioritizedFinding)
- Modify: `src/cli/formatters/{terminal,markdown,html}.ts`, `src/mcp/server.ts`, `web/public/app.js`
- Test: `test/semantic/views.test.ts` + the formatter/mcp/web tests

Satisfies R3-9 P3b, RE-2 (evidence join), R2-12 (weighted-only).

- [ ] **Step 1: views.ts.** Add `causalSteps?: CausalStep[]` to `PrioritizedFinding`, where `CausalStep = { note: string; routineName?: string; objectType?: string; objectId?: number; file: string; line: number; selfTimePercent?: number; totalTimePercent?: number; isHot: boolean }`. For each WEIGHTED finding with an `evidencePath`, resolve each step's `:`-form `routineId` → the inventory routine → its `(objectType, objectNumber, routineName)` → the `MethodBreakdown` (reuse the existing stableRoutineId↔method resolution the fusion already builds; if none, leave percentages undefined + `isHot:false` — honest). Attach the ordered `causalSteps`. WEIGHTED-only (cold/unweighted never get it — R2-12). Deterministic (evidencePath order).

- [ ] **Step 2: Render (all surfaces).** Under each prioritized finding: an indented causal chain — each step `note @ routineName (self%/total%)`, the hot step marked. CLI (terminal/markdown/html — html escape), MCP (include `causalSteps` on weighted findings; bounded), web app.js (collapsible chain; textContent/escaped). Render nothing when `causalSteps` absent (byte-unchanged off). MCP: cap chain length to avoid context blowout (head + hot step + tail if long).

- [ ] **Step 3: Tests.** A finding with a multi-step evidencePath where the cost lands on a deep callee → causalSteps ordered, the deep step carries the high selfTime% + isHot:true, shallow steps lower. A step whose routine has no runtime sample → no percentages, isHot:false. No evidencePath → causalSteps undefined, renderers emit nothing. Per format + MCP + web.

- [ ] **Step 4:** gates green.

- [ ] **Step 5: Commit.** `git add src/semantic/views.ts src/cli/formatters/ src/mcp/server.ts web/public/app.js test/ && git commit -m "feat(p3.2b): causal-chain drilldown (evidencePath joined to runtime cost) across CLI/MCP/web"`

---

## Task 4 (P3c + verify): Extend corroboration to precise field triggers + full suite

**Files:**
- Verify/modify: `src/semantic/corroborate.ts` (the matched-only gate now naturally includes precise field triggers)
- Test: `test/semantic/corroborate*.test.ts`; full suite

- [ ] **Step 1: Verify corroboration extends.** P3.1 gated corroboration to `status==="matched"` (excluding the then-ambiguous field collisions). Now field triggers resolve to `matched` (Task 2), so corroboration auto-extends. Confirm the corroboration anchor join (al-perf pattern `involvedMethods` profile functionName ↔ the matched attribution) aligns for a field-trigger routine (both use the profile's `"<member> - OnValidate"` functionName → same methodAttrKey). Add a test: a field-trigger routine that is now `matched` + carries a runtime `repeated-siblings` pattern + a d1 finding → corroboratingPatterns set (previously it was ambiguous → no corroboration).

- [ ] **Step 2: Real-binary validation (once).** With the rebuilt `alsem.exe`, run al-perf fusion against a real workspace + profile from `exampledata/` (or a fixture) to confirm the end-to-end precise attribution + causal chain works against the REAL engine (not just the stub). Document the result. (If a matching AL workspace for the profile isn't available, assert the stub-based path + note the real-binary smoke as best-effort.)

- [ ] **Step 3: Full gate.** `bun run format && bunx biome check src test` (your files exit 0; pre-existing owner churn in unrelated files is not yours), `bunx tsc --noEmit`, `bun test` — all green. Confirm fusion-off byte-unchanged; "runtime-confirmed" still appears nowhere (R3-6).

- [ ] **Step 4: Commit.** `git add src/semantic/corroborate.ts test/ && git commit -m "feat(p3.2c): extend runtime-correlation to precise field triggers; P3.2 full suite green"`

---

## Self-Review
- **Spec coverage:** P3a (Tasks 1-2: parse + precise field-qualified join, RE-4 case-insensitive/strip-&, RE-11 honest single-finding), P3b (Task 3: causal chain, RE-2), P3c (Task 4: corroboration extends to precise field triggers).
- **Frozen-schema fidelity:** consumes inventory 1.1.0 enclosingMember/originatingObject + analyze --with-evidence evidencePath/discriminator exactly as documented in the engine freeze note; majorMatches keeps old-engine graceful.
- **Honesty:** ambiguous→matched ONLY when enclosingMember disambiguates uniquely; genuine overloads stay ambiguous; a sibling field with no finding is honest matched-no-finding (RE-11); causal steps with no runtime sample carry no fabricated percentages.
- **Additivity:** every field optional, every render gated, fusion-off byte-unchanged, weighted-only (R2-12), case-insensitive join + `&`-strip per the empirical contract.
- **Prereq:** the rebuilt `alsem.exe` (engine HEAD f91ff12) must be in place; the stub is updated to the 1.1.0 schema for CI tests.
