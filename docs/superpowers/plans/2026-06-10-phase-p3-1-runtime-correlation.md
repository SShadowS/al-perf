# Phase P3.1: Runtime-correlation corroboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Populate the P2-reserved `corroboratingPatterns` slot by matching al-perf's OWN runtime pattern detectors to al-sem findings of the same phenomenon, badged "runtime-correlated" — al-perf-only, zero engine work.

**Architecture:** A curated, provenance-keyed mapping table (`corroboration-map.ts`) declares which al-perf runtime-shape patterns correspond to which al-sem detectors. A pure `corroborate.ts` enriches matched attributions: for each `status:"matched"` routine carrying both an al-sem finding and an anchored runtime pattern of the mapped kind, record the pattern id. Surfaced as a "⚡ runtime-correlated" badge across CLI/MCP/web. Additive + opt-in; byte-unchanged when fusion off.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome. Branch `feat/alsem-fusion` (LOCAL — do not push).

**Governing spec:** `docs/superpowers/specs/2026-06-10-phase-p3-causal-drilldown-design.md` — implement P3.1 per **Revision 2** clauses R3-5 (provenance split), R3-6 (runtime-correlated, not confirmed), R3-7 (anchor + matched-only gate), R3-9 (P3.1 stage). P3a/P3b are NOT in this plan (they await the engine fix-then-freeze).

**Commands:** `bun test <file>`, `bun test`, `bunx tsc --noEmit`, `bun run format` BEFORE `bun run lint`.

---

## Established facts (verified, do not re-investigate)
- al-perf `DetectedPattern` (`src/types/patterns.ts`): `{ id, severity, title, description, impact, involvedMethods: string[], evidence, suggestion?, estimatedSavings? }`. `involvedMethods` entries are display strings `"FunctionName (ObjectType ObjectId)"`.
- al-perf detector PROVENANCE (which file/runner produces each id):
  - **runtime** (`src/core/patterns.ts`, `runDetectors`): `single-method-dominance`, `high-hit-count`, `deep-call-stack`, `repeated-siblings`, `event-subscriber-hotspot`, `recursive-call`, `event-chain`.
  - **source-static** (`src/source/source-patterns.ts`): `calcfields-in-loop`, `modify-in-loop`, `record-op-in-loop`, `missing-setloadfields`, `incomplete-setloadfields`.
  - **source-only** (`src/source/source-only-patterns.ts`): `nested-loops`, `unfiltered-findset`, `event-subscriber-with-loop-ops`, `event-subscriber-with-loops`, `dangerous-call-in-loop`, `unindexed-filter`.
- al-sem finding `detector` values (full ids, verified): `d1-db-op-in-loop`, `d4-repeated-lookup-in-loop`, `d48-io-in-loop`, `d7-recursive-event-expansion`, etc. (`FindingSummary.detector` carries the full string.)
- `SemanticAttribution.corroboratingPatterns?: string[]` already exists (reserved, P2). `HotspotAnnotation.corroboratingPatterns?: string[]` already exists and is carried verbatim by `annotateHotspots`.
- `correlate(methods, engine) → FusedModel`; `fuseProfile(methods, workspaceDir, opts?)` calls correlate. `methodAttrKey(m)` = `${functionName}_${objectType}_${objectId}` (exported).
- `AnalysisResult.patterns: DetectedPattern[]` is always populated by `analyzeProfile`; available at all three fusion call sites (`analyze.ts`, `mcp/server.ts`, `web/server.ts`).

---

## Task 1: The provenance-keyed corroboration map

**Files:**
- Create: `src/semantic/corroboration-map.ts`
- Test: `test/semantic/corroboration-map.test.ts`

Satisfies R3-5 (provenance split; only runtime-shape maps to a badge).

- [ ] **Step 1: Write failing tests**

`test/semantic/corroboration-map.test.ts`:
```typescript
import { describe, expect, it } from "bun:test";
import { CORROBORATION_MAP, corroboratesDetector } from "../../src/semantic/corroboration-map.js";

describe("corroboration map", () => {
	it("maps only runtime-shape patterns", () => {
		for (const [, entry] of Object.entries(CORROBORATION_MAP)) {
			expect(entry.provenance).toBe("runtime"); // the map ONLY contains runtime-provenance entries
		}
	});
	it("repeated-siblings corroborates db-op/repeated-lookup/io in loop, anchored to the parent", () => {
		const e = CORROBORATION_MAP["repeated-siblings"];
		expect(e.anchorIndex).toBe(0); // involvedMethods[0] is the parent (loop owner)
		expect(corroboratesDetector("repeated-siblings", "d1-db-op-in-loop")).toBe(true);
		expect(corroboratesDetector("repeated-siblings", "d4-repeated-lookup-in-loop")).toBe(true);
		expect(corroboratesDetector("repeated-siblings", "d48-io-in-loop")).toBe(true);
	});
	it("high-hit-count anchors to the parent (involvedMethods[1])", () => {
		expect(CORROBORATION_MAP["high-hit-count"].anchorIndex).toBe(1);
		expect(corroboratesDetector("high-hit-count", "d1-db-op-in-loop")).toBe(true);
	});
	it("recursive-call corroborates recursive-event-expansion", () => {
		expect(corroboratesDetector("recursive-call", "d7-recursive-event-expansion")).toBe(true);
	});
	it("never corroborates source-static / source-only patterns (category error)", () => {
		expect(CORROBORATION_MAP["modify-in-loop"]).toBeUndefined();      // source-static
		expect(CORROBORATION_MAP["dangerous-call-in-loop"]).toBeUndefined(); // source-only
		expect(corroboratesDetector("modify-in-loop", "d1-db-op-in-loop")).toBe(false);
	});
	it("hard-excludes event-subscriber-hotspot (no single routine)", () => {
		expect(CORROBORATION_MAP["event-subscriber-hotspot"]).toBeUndefined();
	});
	it("does not corroborate an unmapped detector", () => {
		expect(corroboratesDetector("repeated-siblings", "d14-dead-routine")).toBe(false);
	});
});
```

- [ ] **Step 2: Run, verify fail** — `bun test test/semantic/corroboration-map.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/semantic/corroboration-map.ts`**
```typescript
/**
 * Cross-signal corroboration map (P3.1, spec Revision-2 R3-5/R3-6/R3-7).
 *
 * SOUNDNESS: ONLY al-perf RUNTIME-shape detectors (src/core/patterns.ts) may corroborate an al-sem
 * finding — they are real measured runtime evidence. al-perf's source-static (source-patterns.ts) and
 * source-only (source-only-patterns.ts) detectors are al-perf's OWN static scans; an agreement between
 * two static analyses is NOT runtime evidence and must NEVER earn the "runtime-correlated" badge. This
 * map therefore contains ONLY runtime-provenance entries; any pattern id absent from it is not
 * corroborating. Co-occurrence on the same routine is CORRELATION, not causation (R3-6) — the badge is
 * "runtime-correlated", never "runtime-confirmed".
 */
export interface CorroborationEntry {
	/** Always "runtime" — the map only holds runtime-provenance patterns (the soundness invariant). */
	provenance: "runtime";
	/** al-sem detector ids this runtime pattern describes the SAME phenomenon as. */
	alSemDetectors: string[];
	/** Which involvedMethods[] entry is the loop/recursion-OWNING routine the finding sits on. */
	anchorIndex: number;
}

export const CORROBORATION_MAP: Record<string, CorroborationEntry> = {
	// ≥50 sibling calls to the same child under one parent — the parent owns the loop.
	"repeated-siblings": {
		provenance: "runtime",
		alSemDetectors: ["d1-db-op-in-loop", "d4-repeated-lookup-in-loop", "d48-io-in-loop"],
		anchorIndex: 0, // involvedMethods = [parent, representativeChild]; parent owns the loop
	},
	// child fires ≫ parent — the PARENT (involvedMethods[1]) contains the loop/fan-out.
	"high-hit-count": {
		provenance: "runtime",
		alSemDetectors: ["d1-db-op-in-loop", "d4-repeated-lookup-in-loop", "d48-io-in-loop"],
		anchorIndex: 1, // involvedMethods = [child, parent]; parent is the loop owner
	},
	// method observed as its own ancestor at runtime.
	"recursive-call": {
		provenance: "runtime",
		alSemDetectors: ["d7-recursive-event-expansion"],
		anchorIndex: 0,
	},
};

/** True iff this runtime pattern corroborates this al-sem detector (same phenomenon). */
export function corroboratesDetector(patternId: string, alSemDetector: string): boolean {
	const entry = CORROBORATION_MAP[patternId];
	return entry !== undefined && entry.alSemDetectors.includes(alSemDetector);
}
```

- [ ] **Step 4: Run, verify pass.** `bun test test/semantic/corroboration-map.test.ts`.

- [ ] **Step 5: Add a drift-guard test** asserting every key of `CORROBORATION_MAP` is a known al-perf runtime detector id (hard-code the 7 runtime ids from the Established-facts list; assert each map key is in that set). This pins the soundness invariant against future detector additions.

- [ ] **Step 6: format/lint/typecheck + commit.**
```bash
bun run format && bun run lint && bunx tsc --noEmit
git add src/semantic/corroboration-map.ts test/semantic/corroboration-map.test.ts
git commit -m "feat(p3.1): provenance-keyed corroboration map (runtime-shape only)"
```

---

## Task 2: The corroboration pass (pure)

**Files:**
- Create: `src/semantic/corroborate.ts`
- Test: `test/semantic/corroborate.test.ts`

Satisfies R3-7 (anchor-method match via methodAttrKey, matched-only gate, no string re-parse).

- [ ] **Step 1: Write failing tests** covering: a matched routine with a `repeated-siblings` pattern anchored to it (involvedMethods[0]) + a `d1-db-op-in-loop` finding → that finding gets the pattern id in its corroboration; a finding whose detector is unmapped (d14) → no corroboration; a pattern anchored to a DIFFERENT routine → no corroboration; an `ambiguous` attribution (field collision) → NO corroboration (matched-only gate); a `high-hit-count` pattern where the parent (involvedMethods[1]) is the routine → corroborates, but if only the child (involvedMethods[0]) matches → does NOT (anchor correctness); determinism (sorted pattern ids). Build fixtures with the real `DetectedPattern` shape + a `FusedModel` from `correlate` (reuse the `makeMethod`/`makeFinding`/`makeEngine` factories from `test/semantic/views.test.ts`).

```typescript
// shape of the unit under test:
import { corroborate } from "../../src/semantic/corroborate.js";
// corroborate(fused: FusedModel, methods: MethodBreakdown[], patterns: DetectedPattern[]): void
//   — mutates fused.attributions in place, setting SemanticAttribution.corroboratingPatterns
//     (sorted, deduped) for matched attributions whose findings' detectors are corroborated by a
//     runtime pattern anchored to that routine. Pure w.r.t. inputs otherwise.
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `src/semantic/corroborate.ts`**

Logic:
1. Build a lookup from `methodAttrKey` → set of corroborating runtime pattern ids: for each `DetectedPattern` whose `id` is in `CORROBORATION_MAP`, take its anchor method = `involvedMethods[entry.anchorIndex]` (guard: index in range), parse that ONE display string to its method ref. **Do NOT hand-roll the parse** — match it against the live `methods[]` by comparing each method's `formatMethodRef(m)` (import the same formatter the detectors use; if not exported, replicate `${functionName} (${objectType} ${objectId})` and add a TODO to share it) to the anchor string; the matched method gives the `methodAttrKey`. Record `(methodAttrKey → patternId)`.
2. For each `attribution` in `fused.attributions` with `status === "matched"` (R3-7 gate — skip `ambiguous`/`blind-spot`): for each runtime pattern anchored to this routine's `attrKey`, check whether ANY of the attribution's findings has a `detector` that `corroboratesDetector(patternId, detector)`. Collect the pattern ids that corroborate at least one finding. Set `attribution.corroboratingPatterns = sorted-unique` (omit if empty).
3. Pure/deterministic: sort the ids; the lookup is order-independent.

(Per-finding precision is surfaced in Task 4's view layer; the attribution-level set here is the union of patterns corroborating any of its findings.)

- [ ] **Step 4: Run, verify pass. format/lint/typecheck. Commit.**
```bash
git add src/semantic/corroborate.ts test/semantic/corroborate.test.ts
git commit -m "feat(p3.1): pure corroboration pass — matched-only, anchor-correct, deterministic"
```

---

## Task 3: Wire corroboration into fuseProfile + all three call sites

**Files:**
- Modify: `src/semantic/fuse.ts` (fuseProfile gains patterns)
- Modify: `src/cli/commands/analyze.ts`, `src/mcp/server.ts`, `web/server.ts` (pass `result.patterns`)
- Test: extend `test/semantic/fuse.*` or a new `test/semantic/corroborate.integration.test.ts`

- [ ] **Step 1: Write failing test** — `fuseProfile(methods, dir, { patterns })` (or a new positional/opts arg) yields a FusedModel whose matched attributions carry `corroboratingPatterns` when a mapped runtime pattern is anchored there. (Use the stub engine harness if the real engine is needed; else unit-test `correlate`+`corroborate` directly.)

- [ ] **Step 2: Implement** — add `patterns?: DetectedPattern[]` to `FuseOptions` (or a new param) in `fuse.ts`; after `correlate(...)` returns the FusedModel, call `corroborate(fused, methods, opts.patterns ?? [])` before returning. No corroboration when patterns absent (graceful).

- [ ] **Step 3: Thread `result.patterns` at the three call sites** — in `analyze.ts`, `mcp/server.ts` (analyze_profile AND prioritized_findings), and `web/server.ts`, pass `patterns: result.patterns` into `fuseProfile`. (These sites already build `result` before fusing.)

- [ ] **Step 4: Run `bun test`, format/lint/typecheck. Commit.**
```bash
git add src/semantic/fuse.ts src/cli/commands/analyze.ts src/mcp/server.ts web/server.ts test/semantic/
git commit -m "feat(p3.1): thread runtime patterns into fusion corroboration (all 3 surfaces)"
```

---

## Task 4: Surface corroboration on the views + render the badge

**Files:**
- Modify: `src/semantic/views.ts` (PrioritizedFinding gains corroboratingPatterns, computed per-finding)
- Modify: `src/cli/formatters/terminal.ts`, `markdown.ts`, `html.ts`
- Modify: `src/mcp/server.ts` (include on weighted findings)
- Modify: `web/public/app.js`
- Test: extend `test/semantic/views.test.ts`, `test/cli/formatters/*`, `test/mcp/server.test.ts`, `test/web/server.test.ts`

Satisfies R3-6 (badge text "runtime-correlated"), R2-12 (weighted-only, never cold), additivity.

- [ ] **Step 1: views.ts — per-finding corroboration.** Add `corroboratingPatterns?: string[]` to `PrioritizedFinding`. In `prioritizeFindings`, for each weighted finding, set it to the subset of the attribution's `corroboratingPatterns` whose map entry's `alSemDetectors` includes THIS finding's `detector` (precise per-finding, via `corroboratesDetector`). Carry `annotateHotspots`'s existing attribution-level `corroboratingPatterns` unchanged. Test: a finding whose detector is corroborated carries the pattern id; a sibling finding on the same routine with an unmapped detector does NOT. Determinism (sorted). Keep it weighted-only (cold/unweighted never get it — R2-12).

- [ ] **Step 2: CLI renderers (all 3).** In each `renderFusion`/the prioritized row, when a finding has `corroboratingPatterns`, append a badge `⚡ runtime-correlated (<patternIds joined>)`. In the in-place hotspot annotation, when the annotation has attribution-level `corroboratingPatterns`, show the badge. Escape in html. Render nothing when absent (byte-unchanged off). Tests per format: badge present with corroboration, absent without, and NEVER the word "confirmed" (assert `not.toContain("runtime-confirmed")`).

- [ ] **Step 3: MCP.** Include `corroboratingPatterns` on each weighted prioritized finding in `analyze_profile`'s fusion block + `prioritized_findings`. Test asserts presence on a corroborated finding (stub-engine findings mode + a synthesized pattern, or unit-level). Never on cold bucket.

- [ ] **Step 4: web app.js.** In `renderFusion`, render the badge per finding (textContent or escaped); in the in-place hotspot annotation, show it. Gated on presence. Add the section/string presence to the web test.

- [ ] **Step 5: `bun test` full, format/lint/typecheck. Commit.**
```bash
git add src/semantic/views.ts src/cli/formatters/ src/mcp/server.ts web/public/app.js test/
git commit -m "feat(p3.1): render 'runtime-correlated' badge across CLI/MCP/web (per-finding)"
```

---

## Task 5: Full suite + honesty/additivity verification

- [ ] **Step 1:** `bun run format && bun run lint && bunx tsc --noEmit && bun test` — all green.
- [ ] **Step 2:** Grep the renderers + tests to confirm the string "runtime-confirmed" appears NOWHERE (only "runtime-correlated") — the R3-6 honesty guard.
- [ ] **Step 3:** Confirm fusion-off output byte-unchanged (existing P2 off-path tests still pass) and corroboration never appears on cold/unweighted findings.
- [ ] **Step 4:** Final commit if any churn:
```bash
git add -u -- src test web   # ONLY these dirs; never the owner's stray working-tree files
git commit -m "chore(p3.1): full suite green; honesty + additivity verified"
```
(Note: stage explicit paths only — the al-perf working tree carries large pre-existing autocrlf/owner churn that must NOT be swept in.)

---

## Self-Review
- **Spec coverage:** R3-5 (Task 1 provenance map), R3-6 (Task 4 "runtime-correlated" + no "confirmed"), R3-7 (Task 2 anchor + matched-only gate + no string re-parse), R3-9 P3.1 stage (al-perf-only, zero engine work — confirmed: no alch-engine changes in any task). P3a/P3b deferred to the engine-freeze + P3.2 (NOT in this plan).
- **Honesty:** only runtime-provenance patterns badge; co-occurrence labeled "correlated" not "confirmed"; matched-only (no field-collision ambiguity); per-finding precision in the view.
- **Additivity:** every field optional, badge gated, fusion-off byte-unchanged, weighted-only (R2-12).
- **Type consistency:** `methodAttrKey`/`corroboratesDetector`/`CORROBORATION_MAP` used identically; `DetectedPattern.involvedMethods` matched via the live method set, not re-parsed.
- **Known limitation (documented, deferred to P3.2):** within-routine false correlation (a runtime pattern on loop A + a static finding on loop B of the same routine) is possible at routine granularity; the loopId/line positional join that would tighten it needs the engine `--with-evidence` evidencePath (P3.2). The "correlated" (not "confirmed") wording is honest about this.
