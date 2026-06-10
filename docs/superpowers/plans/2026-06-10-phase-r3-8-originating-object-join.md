# R3-8: originatingObject join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Use the engine's `originatingObject` (the declaring object's StableObjectId, already parsed but unused) for a defensive app-scope gate in correlation + provenance display ("declared in <extension>"), per the empirically-resolved Option B (no base aggregation re-key — 0 cross-app collisions observed).

**Architecture:** Carry `appId` on `MethodBreakdown` (first-seen, from the frame's `declaringApplication.appId` — P4.2 already threads it onto the node). In `correlate`, when both the method's `appId` and the candidate routine's `originatingObject` are present, require matching normalized app GUIDs (defensive). Surface `originatingObject` provenance in the fusion views. Additive + graceful (fall back to today's app-agnostic match when either identity absent).

**Tech Stack:** TS, Bun, Biome (validate with `bunx biome check`, NOT `bun run lint`). Branch `feat/alsem-fusion` (LOCAL — do not push). Reuses P4.2's `normalizeAppGuid`.

**Governing spec:** `docs/superpowers/specs/2026-06-10-phase-r3-8-originating-object-join-design.md` (Revision 2 — Option B).

---

## Task 1: appId on MethodBreakdown + defensive app-scope gate

**Files:** `src/types/aggregated.ts` (MethodBreakdown), `src/core/aggregator.ts` (aggregateByMethod), `src/semantic/correlate.ts` (the gate + normalizeAppGuid reuse), tests.

- [ ] **Step 1: Read** `src/types/aggregated.ts` (`MethodBreakdown` ~23-52, has `appName` not `appId`), `src/core/aggregator.ts` `aggregateByMethod` (~54-110, the key `${functionName}_${objectType}_${objectId}` + the `appName` read at ~64), where `appId` lives on the node (`RawDeclaringApplication.appId` — P4.2 added it; confirm `node.declaringApplication?.appId`). `src/semantic/correlate.ts` (the match resolution ~378-500, the canonical key, the precise-member branch). Find `normalizeAppGuid` (added by P4.2 in `analyzer.ts` or a util — reuse/export it; if it's local to analyzer.ts, extract it to a shared `src/semantic/identity.ts` or a small util so correlate can import it).
- [ ] **Step 2:** Add `appId?: string` to `MethodBreakdown`. In `aggregateByMethod`, set `entry.appId = node.declaringApplication?.appId` on first creation (first-seen; do NOT change the aggregation KEY — Option B). Additive optional field; existing output gains the field (additive).
- [ ] **Step 3: App-scope gate in correlate.** When resolving a method to a universe routine (the matched + the precise-member paths), add a guard: IF `method.appId` is present AND the candidate `routine.originatingObject` is present, require `normalizeAppGuid(method.appId) === normalizeAppGuid(appGuidOf(routine.originatingObject))` (where `appGuidOf` extracts the app-GUID prefix of the `:`-form StableObjectId `appGuid:Type:Num` — split on `:`, take [0]). When they MISMATCH, treat as NOT a match for that candidate (fall through — e.g. to blind-spot/ambiguous as appropriate). When either identity is ABSENT → today's behavior unchanged (graceful). This only tightens; never invents a match.
- [ ] **Step 4: Tests** (`test/semantic/correlate.test.ts`): a method with `appId` X + a routine with `originatingObject` of app X → matched (gate passes); a method with `appId` Y + the only candidate routine `originatingObject` app X → NOT matched (gate rejects the cross-app false match → blind-spot or no-match, honest); a method with NO `appId` (System frame) → matched as today (graceful); a routine with no `originatingObject` (old engine) → matched as today (graceful). GUID normalization (dash-less method appId vs dashed originatingObject app GUID). An aggregator test: `MethodBreakdown.appId` carried from the node.
- [ ] **Step 5:** `bun test`, `bun run format && bunx biome check <touched files>` (exit 0), `bunx tsc --noEmit`. Full suite green (watch for any test relying on a cross-app match that the gate now correctly rejects — only adjust if the NEW behavior is correct).
- [ ] **Step 6: Commit.** `git add src/types/aggregated.ts src/core/aggregator.ts src/semantic/correlate.ts src/semantic/identity.ts test/ && git commit -m "feat(r3-8): appId on MethodBreakdown + defensive app-scope gate in correlate (graceful)"`

---

## Task 2: originatingObject provenance display + verify

**Files:** `src/semantic/views.ts` (carry originatingObject onto the annotation/finding view), the CLI/MCP/web renderers (the provenance note), tests.

- [ ] **Step 1: Read** `src/semantic/views.ts` (`HotspotAnnotation`/`PrioritizedFinding`; the attribution → view). The matched attribution's `stableRoutineId`/the routine's `originatingObject` — is it reachable in views (via `fused.allRoutines` or the attribution)? Thread the matched routine's `originatingObject` (+ a displayName if available) onto `HotspotAnnotation` (e.g. `originatingObject?: string`).
- [ ] **Step 2:** When a matched member-trigger annotation's `originatingObject` names a DIFFERENT object than the hotspot's own (objectType/objectId), render "(declared in <originatingObject displayName or the :-form>)" — in terminal/markdown/html + MCP + web (the existing fusion annotation render sites). Additive, gated on presence + difference. Escape in html/web.
- [ ] **Step 3: Tests:** an extension-declared member (originatingObject ≠ the hotspot object) → the provenance note renders; a base-object member (originatingObject == hotspot object) → no note; absent originatingObject → no note (graceful). Per surface.
- [ ] **Step 4: Full gate.** `bun run format && bunx biome check src test` (your files exit 0), `bunx tsc --noEmit`, `bun test`. Confirm fusion-off byte-unchanged; graceful old-engine (no originatingObject → no provenance, no app-scope tightening).
- [ ] **Step 5: Commit.** `git add src/semantic/views.ts src/cli/formatters/ src/mcp/server.ts web/public/app.js test/ && git commit -m "feat(r3-8): originatingObject provenance display across surfaces; R3-8 complete"`

---

## Self-Review
- **Spec coverage:** Option B (no base re-key — appId first-seen), the defensive app-scope gate (graceful, tighten-only), the provenance display (the durable value). Residual two-extensions disambiguation dropped per the empirical finding (extensions own their object numbers).
- **Honesty/additivity:** the gate only tightens when both identities present (never invents a match, rejects only a theoretical cross-app false match); provenance is additive + gated; fusion-off byte-unchanged; graceful old-engine/System frames.
- **Reuse:** P4.2's `normalizeAppGuid`, the canonical join, the per-surface fusion render.
