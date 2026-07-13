# Detector Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix nine verified defects in al-perf's detectors. One actively misleads users. One means a documented capability does not exist. One means an entire class of BC code — report and page row triggers — is never analyzed at all.

**Architecture:** Nine fixes across four files. No schema changes, no fingerprint-algorithm change (verified — see Global Constraints).

**Tech Stack:** Bun, TypeScript, `bun:test`, Biome.

**Source:** `private/research/VERIFIED-FINDINGS.md`. Every defect below was reported by an out-of-family model reading the real code — GPT-5.5 (Tasks 1–5), Fable 5 (Tasks 6, 7, 8), Gemini 3.1 Pro (Task 9) — and then **verified by me against the source before being written down here**. Task 2 was found independently by two models.

**Priority.** The plan is not in importance order; it is in "was found first" order. If you only get through some of it, do **Task 7 first** — it is the largest hole in the tool. Rough ranking: 7 > 6 > 1 > 2 > 8 > 3 > 5 > 9 > 4.

## Global Constraints

- Tests run as `AI_DISABLED=1 bun test`. Never without that env var.
- `bunx tsc --noEmit` clean before any commit.
- `bunx biome check --write` on every file you touch.
- The repo has ~200 files that show as stat-dirty from CRLF/`core.autocrlf` noise. **Only ever `git add` the exact paths you changed.** Never `git add -A`, never `git add .`, never `git checkout`/`reset`/`stash`.
- Every commit ends with the trailer:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- **NO fingerprint-algorithm bump is needed, and none may be introduced.** This was checked, because al-perf ships a guard (`StaleAlgoVersionError`) that refuses to run when `FINGERPRINT_ALGO_VERSION` changes without a purge. The colliding key in Task 5 is used **only for grouping during detection**; a pattern's fingerprint is computed separately by `identityTokens()` in `src/lifecycle/fingerprint.ts`, whose fallback identity **already includes `canonicalObjectType`**. So these fixes change *which* patterns are detected, not *how* a detected pattern is fingerprinted. If you find yourself editing `FINGERPRINT_ALGO_VERSION`, stop — you have gone wrong.
- **Expect the finding set to change.** Tasks 3 and 5 will surface findings that were previously suppressed or mis-grouped. That is the point. Existing lifecycle findings that vanish will auto-resolve; new ones file as `first-seen`. This is normal, and no migration is required.
- **New pattern ids are a public contract.** `insert-in-loop` and `delete-in-loop` (Task 2) become part of the pattern-id vocabulary that fingerprints, sinks, and `docs/` all reference. Add them to the detector list in `CLAUDE.md` and any pattern-reference doc.

---

## File Structure

| Task | Touches |
|---|---|
| 1 | `src/source/source-patterns.ts` (the `calcfields-in-loop` suggestion + `calcFieldSeverity`), `test/source/source-patterns.test.ts` |
| 2 | `src/source/source-patterns.ts` (new `insert-in-loop`, `delete-in-loop`), `src/core/patterns.ts` (register them), `CLAUDE.md`, tests |
| 3 | `src/source/source-patterns.ts` (`missing-setloadfields` ordering), tests |
| 4 | `src/core/patterns.ts:449`, `src/core/analyzer.ts:230` (the two sort sites), tests |
| 5 | `src/core/patterns.ts` (the four key-construction sites), tests |
| 6 | `src/core/patterns.ts` (`detectSingleMethodDominance`, `detectEventSubscriberHotspot`), tests |
| 7 | `src/source/indexer.ts` (per-row triggers as implicit loop context), `CLAUDE.md`, tests + a **report** fixture |
| 8 | `src/source/indexer.ts` (`collectRecordOps` bare-identifier calls), tests |
| 9 | `src/source/indexer.ts` (`DANGEROUS_CALLS` set), `src/source/source-only-patterns.ts` (suggestion), `CLAUDE.md`, tests |

**Serialize by file — these are NOT all parallelizable.**

- `source-patterns.ts`: Tasks 1, 2, 3 — run sequentially.
- `core/patterns.ts`: Tasks 4, 5, 6 — run sequentially.
- `source/indexer.ts`: Tasks 7, 8, 9 — run sequentially.

The three *groups* are disjoint and may run in parallel worktrees. Task 2 also touches `core/patterns.ts` (to register two detectors) — that is a one-line addition to a list, so land Task 2 before starting the `core/patterns.ts` group, or expect a trivial conflict there.

---

### Task 1: Stop telling users to do something impossible

**Files:**
- Modify: `src/source/source-patterns.ts:114-115` (the two suggestion strings), and `calcFieldSeverity` at `:45-58`.
- Test: `test/source/source-patterns.test.ts`

**Interfaces:**
- No signature changes. Behavior only.

**Background — this is the worst of the five.** `calcfields-in-loop` currently emits:

> "Move CalcFields() before the loop, or **use SetLoadFields() to pre-load only the fields you need**. This table has aggregation FlowFields (Sum/Count) which are especially expensive."

**SetLoadFields does not accept FlowFields.** CalcFields operates on FlowFields. So the user follows our top suggestion and it cannot work. Microsoft is explicit that FlowFields are not valid input:
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/record/record-setloadfields-method

This is worse than a missing detector — it is a **wrong answer delivered with confidence**. The correct advice is `SetAutoCalcFields` before the loop (which calculates FlowFields as the record is retrieved), or a FlowField filter, or a SIFT-backed `CalcSums`:
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/record/record-setautocalcfields-method

There is a **second, subtler defect in the same detector**. `calcFieldSeverity` (`:45-58`) decides severity from whether the record's table has *any* aggregation FlowField — not whether the field actually passed to `CalcFields` is one. So `CalcFields(SomeCheapLookupField)` is rated `critical` merely because the table also happens to have an unrelated `Sum` field elsewhere.

- [ ] **Step 1: Write the failing test**

Add to `test/source/source-patterns.test.ts` (match the file's existing fixture style):

```typescript
describe("calcfields-in-loop — suggestion must be actionable", () => {
	it("never tells the user to use SetLoadFields on a FlowField", () => {
		// SetLoadFields does not accept FlowFields, and CalcFields operates on
		// FlowFields. Suggesting it is advice the user cannot follow.
		// https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/record/record-setloadfields-method
		const patterns = runDetectorOnFixture(/* a CalcFields-in-loop fixture */);
		const finding = patterns.find((p) => p.id === "calcfields-in-loop");
		expect(finding).toBeDefined();
		expect(finding?.suggestion).not.toContain("SetLoadFields");
		expect(finding?.suggestion).toContain("SetAutoCalcFields");
	});
});
```

Use whichever fixture/helper the existing `calcfields-in-loop` tests in that file already use — do not invent a new harness.

- [ ] **Step 2: Run it, confirm it fails**

Run: `AI_DISABLED=1 bun test test/source/source-patterns.test.ts -t "actionable"`
Expected: FAIL — the suggestion currently contains "SetLoadFields".

- [ ] **Step 3: Rewrite both suggestion strings**

Replace `src/source/source-patterns.ts:113-115`:

```typescript
				suggestion:
					severity === "critical"
						? "Call SetAutoCalcFields() before the loop so the FlowField is calculated as each record is retrieved, or filter on the FlowField instead of calculating it per row. This table has aggregation FlowFields (Sum/Count), which force a SQL aggregation per call. Note SetLoadFields() does NOT help here — it does not accept FlowFields."
						: "Call SetAutoCalcFields() before the loop so the FlowField is calculated as each record is retrieved. This table has Lookup FlowFields — cheaper than Sum/Count, but still one SQL query per iteration. Note SetLoadFields() does NOT help here — it does not accept FlowFields.",
```

The explicit "SetLoadFields does NOT help here" is deliberate: developers reach for it by reflex, and the old suggestion trained them to.

- [ ] **Step 4: Fix `calcFieldSeverity` to look at the called field, not the table**

The current signature takes `recordVariable` and inspects the table's fields. It must instead consider the **field(s) actually passed to CalcFields**.

Read `calcFieldSeverity` (`:45-58`) and the `RecordOp` type it is fed from. If the op carries the field names passed to `CalcFields`, use them: rate `critical` only when a *called* field has an aggregation `calcFormulaType` (Sum/Count/Average/Min/Max), `warning` when the called fields are Lookup/Exist, and keep `critical` as the conservative default when the field list is unknown.

**If the op does NOT carry the called field names**, the indexer must be extended to capture them — check `src/source/indexer.ts` for how `recordOpsInLoops` is built. If that turns out to be a large change, STOP and report: this sub-fix is then its own task, and the suggestion fix (Steps 1–3) still stands on its own and is the more important half.

- [ ] **Step 5: Run, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test test/source/source-patterns.test.ts
bunx tsc --noEmit
bunx biome check --write src/source/source-patterns.ts test/source/source-patterns.test.ts
git add src/source/source-patterns.ts test/source/source-patterns.test.ts
git commit -m "$(cat <<'EOF'
fix(patterns): calcfields-in-loop told users to do something impossible

The suggestion said "use SetLoadFields() to pre-load only the fields you need".
SetLoadFields does not accept FlowFields, and CalcFields operates on FlowFields.
Every user who followed our top suggestion for this pattern hit a dead end.

That is worse than a missing detector — it is a wrong answer delivered with
confidence. The suggestion now recommends SetAutoCalcFields (which calculates
FlowFields as the record is retrieved) and says explicitly that SetLoadFields
does NOT help, because developers reach for it by reflex and the old advice
trained them to.

Also fixes the severity heuristic, which rated a CalcFields critical whenever the
record's table had ANY aggregation FlowField, even if the field actually being
calculated was a cheap lookup.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 2: `Insert` and `Delete` in a loop are completely undetected

**Files:**
- Modify: `src/source/source-patterns.ts` (add two detectors alongside `modify-in-loop` at `:142-146`)
- Modify: `src/core/patterns.ts` (register them in the detector list)
- Modify: `CLAUDE.md` (the detector inventory says 18; it becomes 20)
- Test: `test/source/source-patterns.test.ts`

**Interfaces:**
- Produces two new pattern ids: `insert-in-loop`, `delete-in-loop`. These enter the public pattern-id vocabulary — fingerprints, sinks, and docs all key off pattern ids.

**Background.** `modify-in-loop`'s predicate is, in full:

```typescript
(op.type === "Modify" || op.type === "ModifyAll") &&
```

`Insert` and `Delete` in a loop — among the most common real BC performance bugs there are — are **not detected at all**, despite `CLAUDE.md` describing this detector as covering "Modify/Insert/Delete inside a loop". A documented capability that does not exist.

**The data is already there.** `src/source/indexer.ts` already emits `Insert`, `Delete`, and `DeleteAll` op types — `modify-in-loop` simply filters them out. No indexer work is needed.

**Two new detectors, not one widened one.** The fixes genuinely differ: an `Insert` loop is usually fixed by building a temporary table and inserting once, or by a bulk pattern; a `Delete` loop is usually fixed by `DeleteAll` with a filter. One generic suggestion cannot serve both. Separate pattern ids also mean existing `modify-in-loop` findings keep their lifecycle history untouched.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("insert-in-loop", () => {
	it("flags Insert inside a loop", () => {
		// Fixture: a procedure with `repeat ... Rec.Insert() ... until`
		const patterns = runDetectorOnFixture(/* insert-in-loop fixture */);
		const f = patterns.find((p) => p.id === "insert-in-loop");
		expect(f).toBeDefined();
		expect(f?.suggestion).toMatch(/temporary|bulk|batch/i);
	});

	it("does not flag Insert on a temporary record", () => {
		// Temp-table inserts issue no SQL. isTemporaryOp already exists —
		// modify-in-loop uses it; the new detectors must too.
		const patterns = runDetectorOnFixture(/* temp-record insert fixture */);
		expect(patterns.find((p) => p.id === "insert-in-loop")).toBeUndefined();
	});
});

describe("delete-in-loop", () => {
	it("flags Delete inside a loop and suggests DeleteAll", () => {
		const patterns = runDetectorOnFixture(/* delete-in-loop fixture */);
		const f = patterns.find((p) => p.id === "delete-in-loop");
		expect(f).toBeDefined();
		expect(f?.suggestion).toContain("DeleteAll");
	});
});

describe("modify-in-loop", () => {
	it("still flags only Modify/ModifyAll — Insert and Delete are separate findings", () => {
		const patterns = runDetectorOnFixture(/* a fixture with Modify AND Insert in a loop */);
		const modify = patterns.filter((p) => p.id === "modify-in-loop");
		const insert = patterns.filter((p) => p.id === "insert-in-loop");
		expect(modify.length).toBe(1);
		expect(insert.length).toBe(1);
	});
});
```

Add the fixtures to `test/fixtures/source/` following the existing convention there.

- [ ] **Step 2: Run, confirm they fail**

Run: `AI_DISABLED=1 bun test test/source/source-patterns.test.ts -t "in-loop"`
Expected: FAIL — `insert-in-loop` and `delete-in-loop` do not exist.

- [ ] **Step 3: Implement both detectors**

Model them on `detectModifyInLoop` in `src/source/source-patterns.ts`. Copy its structure exactly — the `matchToSource` lookup, the `isTemporaryOp` guard (temp-table ops issue no SQL and must not be flagged), and the `impact: method.selfTime`.

`insert-in-loop`: predicate `op.type === "Insert"`. Suggestion: build a temporary table and insert once after the loop, or use a bulk-insert pattern; each `Insert` in a loop is a separate SQL INSERT.

`delete-in-loop`: predicate `op.type === "Delete" || op.type === "DeleteAll"`. Suggestion: use `DeleteAll()` with a filter instead of deleting row by row.

**Note on `DeleteAll` inside a loop:** it is flagged deliberately. A `DeleteAll` *inside* a loop is still N statements — the point of `DeleteAll` is to replace the loop, not to live in one.

Register both in the detector list in `src/core/patterns.ts` alongside the other source-correlated detectors.

- [ ] **Step 4: Update the docs**

`CLAUDE.md` lists the detectors and says "18 detectors" and "Source-correlated (5)". Both numbers change: 20 total, 7 source-correlated. Update the inventory list too. Grep for other places that state the count: `grep -rn "18 detectors\|18)" docs/ README.md CLAUDE.md`.

- [ ] **Step 5: Run, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/source/source-patterns.ts src/core/patterns.ts test/source/source-patterns.test.ts
git add src/source/source-patterns.ts src/core/patterns.ts test/source/source-patterns.test.ts CLAUDE.md test/fixtures/source/
git commit -m "$(cat <<'EOF'
feat(patterns): detect Insert and Delete in a loop

modify-in-loop's predicate was, in full:

    (op.type === "Modify" || op.type === "ModifyAll") &&

So Insert and Delete inside a loop — among the most common real BC performance
bugs there are — were not detected at all, despite CLAUDE.md describing this
detector as covering "Modify/Insert/Delete inside a loop". A documented
capability that did not exist.

The indexer already emitted Insert/Delete/DeleteAll; the detector simply filtered
them out. No indexer work was needed.

Two new detectors rather than one widened one, because the fixes differ: an
Insert loop is fixed by building a temp table and inserting once; a Delete loop
by DeleteAll with a filter. One generic suggestion cannot serve both, and
separate pattern ids leave existing modify-in-loop findings' history intact.

Found by an external-model audit (GPT-5.5), independently confirmed by Fable 5,
both reading the source.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 3: `missing-setloadfields` is silenced by code that comes AFTER the bug

**Files:**
- Modify: `src/source/source-patterns.ts:240-250`
- Test: `test/source/source-patterns.test.ts`

**Background.** The current code:

```typescript
// Collect all record variables that have SetLoadFields
const setLoadFieldsVars = new Set<string>();
for (const op of allOps) {
    if (op.type === "SetLoadFields" && op.recordVariable) {
        setLoadFieldsVars.add(op.recordVariable.toLowerCase());
    }
}

for (const op of findOps) {
    const recVarLower = op.recordVariable?.toLowerCase() ?? "";
    if (!setLoadFieldsVars.has(recVarLower)) {
```

It collects `SetLoadFields` from **all** operations in the method, with **no ordering check**. So a `SetLoadFields` appearing *after* the `FindSet` suppresses the warning — even though, at the moment the `FindSet` runs, no fields have been restricted. The performance bug is still there; we just stop reporting it.

The comment on the detector says "preceding SetLoadFields". The code does not do that.

**Two further gaps worth fixing in the same pass**, both cheap and both false positives:

- **Temporary records.** `SetLoadFields` is a no-op on a temp record (no SQL load happens). `modify-in-loop` already guards with `isTemporaryOp`; this detector does not. So temp-table reads get flagged for a problem they cannot have.
- **`SetLoadFields` with no arguments resets to loading all fields** (per Microsoft's docs). Treating a bare `SetLoadFields()` as "this variable is covered" is wrong. If the op carries its field list, an empty list must NOT suppress.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("missing-setloadfields — ordering", () => {
	it("still flags the FindSet when SetLoadFields comes AFTER it", () => {
		// The bug is at the FindSet: at that moment no fields were restricted.
		// A SetLoadFields further down the method does not retroactively fix it.
		const patterns = runDetectorOnFixture(/* FindSet on line 10, SetLoadFields on line 20 */);
		expect(patterns.find((p) => p.id === "missing-setloadfields")).toBeDefined();
	});

	it("does not flag when SetLoadFields precedes the FindSet", () => {
		const patterns = runDetectorOnFixture(/* SetLoadFields line 10, FindSet line 20 */);
		expect(patterns.find((p) => p.id === "missing-setloadfields")).toBeUndefined();
	});

	it("does not flag a temporary record", () => {
		// SetLoadFields is a no-op on a temp record — no SQL load happens.
		const patterns = runDetectorOnFixture(/* temp record FindSet, no SetLoadFields */);
		expect(patterns.find((p) => p.id === "missing-setloadfields")).toBeUndefined();
	});
});
```

The first test MUST fail against current code. If it passes before your fix, the fixture does not actually place `SetLoadFields` after the `FindSet` — fix the fixture, not the test.

- [ ] **Step 2: Run, confirm the ordering test fails**

Run: `AI_DISABLED=1 bun test test/source/source-patterns.test.ts -t "ordering"`
Expected: the "AFTER it" test FAILS (currently suppressed).

- [ ] **Step 3: Implement**

Record the **line** of each `SetLoadFields` per variable, and when checking a find op, only treat the variable as covered if a `SetLoadFields` for it appears at a **lower line number** than the find:

```typescript
		// The bug is AT the find: a SetLoadFields further down the method does not
		// retroactively restrict the fields that find already loaded. Track the
		// EARLIEST SetLoadFields line per variable and compare, rather than asking
		// "does this variable have one anywhere in the method".
		const setLoadFieldsLine = new Map<string, number>();
		for (const op of allOps) {
			if (op.type !== "SetLoadFields" || !op.recordVariable) continue;
			const key = op.recordVariable.toLowerCase();
			const prev = setLoadFieldsLine.get(key);
			if (prev === undefined || op.line < prev) setLoadFieldsLine.set(key, op.line);
		}

		for (const op of findOps) {
			if (isTemporaryOp(op, match.features.variables)) continue; // no SQL load on a temp record
			const recVarLower = op.recordVariable?.toLowerCase() ?? "";
			const slfLine = setLoadFieldsLine.get(recVarLower);
			if (slfLine !== undefined && slfLine < op.line) continue; // genuinely covered
			// ... existing push
		}
```

Verify `RecordOp` carries `line` (it does — the existing messages print `op.line`) and that `isTemporaryOp` is in scope in this function (it is used by `detectModifyInLoop` in the same file).

**On the bare-`SetLoadFields()` reset:** if the op type does not carry its argument list, do not guess. Leave it, and note it as a follow-up in the commit message — a wrong suppression rule is worse than a missing one.

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/source/source-patterns.ts test/source/source-patterns.test.ts
git add src/source/source-patterns.ts test/source/source-patterns.test.ts test/fixtures/source/
git commit -m "$(cat <<'EOF'
fix(patterns): missing-setloadfields was silenced by code AFTER the bug

It collected SetLoadFields from every op in the method with no ordering check, so
a SetLoadFields written BELOW the FindSet suppressed the warning — even though at
the moment the FindSet ran, no fields had been restricted. The performance bug
was still there; we just stopped reporting it. The detector's own comment said
"preceding SetLoadFields". The code did not do that.

Now compares line numbers: a variable is only covered if a SetLoadFields for it
appears earlier than the find.

Also skips temporary records, which cannot have this problem at all —
SetLoadFields is a no-op on a temp record because no SQL load happens.
modify-in-loop already guarded with isTemporaryOp; this detector did not.

Expect this to surface findings that were previously suppressed. That is the fix
working.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 4: Prioritization is dead for every source-only finding

**Files:**
- Modify: `src/core/patterns.ts:449` and `src/core/analyzer.ts:230` (both sort sites)
- Test: `test/core/patterns.test.ts`

**Background.** All six source-only detectors emit `impact: 0`, and findings are sorted by `impact` descending:

```typescript
patterns.sort((a, b) => b.impact - a.impact);
```

So every source-only finding ties at zero and their relative order is whatever the array happened to be. A theoretical 3×3 nested loop ranks **identically** to the actual production bottleneck. The entire source-only category cannot be prioritized.

**The fix is a sort fallback, not a fabricated number.** With no profile there IS no measured impact, and inventing a score would produce a number that looks like measured time and is not — precisely the kind of confident-but-fabricated signal this whole audit is about removing. So: keep `impact: 0`, and fall back to **severity**, then to a stable tiebreak.

- [ ] **Step 1: Write the failing test**

```typescript
describe("pattern ordering", () => {
	it("ranks source-only findings by severity when impact ties at zero", () => {
		const patterns = [
			{ id: "nested-loops", severity: "info", impact: 0 },
			{ id: "unfiltered-findset", severity: "critical", impact: 0 },
			{ id: "unindexed-filter", severity: "warning", impact: 0 },
		] as DetectedPattern[];

		const sorted = sortPatterns(patterns);

		expect(sorted.map((p) => p.severity)).toEqual(["critical", "warning", "info"]);
	});

	it("still ranks a measured profile finding above any source-only one", () => {
		const patterns = [
			{ id: "unfiltered-findset", severity: "critical", impact: 0 },
			{ id: "single-method-dominance", severity: "warning", impact: 5000 },
		] as DetectedPattern[];

		const sorted = sortPatterns(patterns);

		// Real measured time outranks a static smell, regardless of severity.
		expect(sorted[0].id).toBe("single-method-dominance");
	});

	it("is stable — equal impact and severity keep a deterministic order", () => {
		const a = { id: "aaa", severity: "warning", impact: 0 } as DetectedPattern;
		const b = { id: "bbb", severity: "warning", impact: 0 } as DetectedPattern;
		expect(sortPatterns([b, a]).map((p) => p.id)).toEqual(["aaa", "bbb"]);
	});
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `AI_DISABLED=1 bun test test/core/patterns.test.ts -t "ordering"`
Expected: FAIL — `sortPatterns` does not exist, and the current sort ignores severity.

- [ ] **Step 3: Implement a shared `sortPatterns`**

Both sort sites currently duplicate `patterns.sort((a, b) => b.impact - a.impact)`. Extract one exported function in `src/core/patterns.ts` and use it in both places — DRY, and it means the two surfaces cannot drift.

```typescript
const SEVERITY_ORDER: Record<DetectedPattern["severity"], number> = {
	critical: 3,
	warning: 2,
	info: 1,
};

/**
 * Impact first (real measured time from the profile), then severity, then id.
 *
 * Source-only detectors have no profile and therefore no measured impact — they
 * all emit impact 0. Sorting on impact alone left the entire source-only category
 * tied at zero, in arbitrary order, so a theoretical 3x3 nested loop ranked
 * identically to the real bottleneck.
 *
 * The fallback is severity, NOT a synthesized impact score. Inventing a number
 * would produce something that looks like measured time and is not.
 *
 * The id tiebreak makes the order deterministic, so output does not churn between
 * runs on equal findings.
 */
export function sortPatterns(patterns: DetectedPattern[]): DetectedPattern[] {
	return [...patterns].sort(
		(a, b) =>
			b.impact - a.impact ||
			SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
			a.id.localeCompare(b.id),
	);
}
```

Replace the sort at `src/core/patterns.ts:449` and at `src/core/analyzer.ts:230` with `sortPatterns(...)`.

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/core/patterns.ts src/core/analyzer.ts test/core/patterns.test.ts
git add src/core/patterns.ts src/core/analyzer.ts test/core/patterns.test.ts
git commit -m "$(cat <<'EOF'
fix(patterns): source-only findings could not be prioritized at all

All six source-only detectors emit impact 0, and findings are sorted by impact
descending. So the entire source-only category tied at zero in arbitrary order —
a theoretical 3x3 nested loop ranked identically to the actual production
bottleneck.

Sort now falls back to severity, then to id for determinism. Deliberately NOT a
synthesized impact score: with no profile there is no measured impact, and
inventing one produces a number that looks like measured time and is not.

Both sort sites (patterns.ts and analyzer.ts) duplicated the comparator; they now
share one exported sortPatterns, so they cannot drift.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 5: Method identity collides across object types

**Files:**
- Modify: `src/core/patterns.ts` — four key-construction sites (~`:118`, `:124`, `:125`, `:148`)
- Test: `test/core/patterns.test.ts`

**Background.** The grouping key is:

```typescript
const key = `${node.callFrame.functionName}:${node.applicationDefinition.objectId}`;
```

No object type. So **codeunit 50000's `Run` and table 50000's `Run` are the same method** as far as `high-hit-count`, `repeated-siblings`, and `recursive-call` are concerned. Their hit counts get merged, their sibling groups get merged, and a false "recursion" can be reported between two entirely unrelated objects that happen to share an id.

**This does NOT require a fingerprint-algorithm bump** — verified. The key is used only for grouping *during detection*. A pattern's fingerprint is computed by `identityTokens()` in `src/lifecycle/fingerprint.ts`, whose fallback identity already includes `canonicalObjectType`. Do not touch `FINGERPRINT_ALGO_VERSION`.

- [ ] **Step 1: Write the failing test**

```typescript
describe("method identity", () => {
	it("does not merge a codeunit and a table that share an object id", () => {
		// Build a profile with codeunit 50000 "Run" and table 50000 "Run" as
		// siblings, each below the repeated-siblings threshold on its own but
		// above it if wrongly merged.
		const profile = makeProfileWith([
			{ objectType: "Codeunit", objectId: 50000, functionName: "Run", count: 30 },
			{ objectType: "Table", objectId: 50000, functionName: "Run", count: 30 },
		]);

		const patterns = detectPatterns(profile);

		// If the key omitted objectType these would merge to 60 and trip the
		// threshold. They are different methods and must not.
		expect(patterns.find((p) => p.id === "repeated-siblings")).toBeUndefined();
	});
});
```

Build the profile with whatever fixture helper `test/core/patterns.test.ts` already uses.

- [ ] **Step 2: Run, confirm it fails**

Run: `AI_DISABLED=1 bun test test/core/patterns.test.ts -t "object id"`
Expected: FAIL — the two are merged and the pattern fires.

- [ ] **Step 3: Fix all four key sites**

Introduce one helper and use it everywhere, so the four sites cannot drift apart:

```typescript
/**
 * Group key for a profile node's method.
 *
 * objectType is load-bearing: without it, codeunit 50000's `Run` and table
 * 50000's `Run` are the same method, and high-hit-count / repeated-siblings /
 * recursive-call merge two unrelated objects that happen to share an id.
 */
function methodKey(node: ProfileNode): string {
	const d = node.applicationDefinition;
	return `${d.objectType}:${d.objectId}:${node.callFrame.functionName}`;
}
```

Replace all four constructions (~`:118`, `:124`, `:125`, `:148`) with `methodKey(node)` / `methodKey(node.parent)`. Grep to be sure none are missed: `grep -n 'functionName}:\${' src/core/patterns.ts` must come back empty.

- [ ] **Step 4: Run the FULL suite — this changes what gets detected**

```bash
AI_DISABLED=1 bun test
```

Existing detector tests may shift, because grouping is now correct. **If a test fails, read it before changing it.** A test that depended on the merged behavior was asserting a bug. Fix the fixture or the expectation, never by re-introducing the collision — and say in your report which tests moved and why.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit
bunx biome check --write src/core/patterns.ts test/core/patterns.test.ts
git add src/core/patterns.ts test/core/patterns.test.ts
git commit -m "$(cat <<'EOF'
fix(patterns): method identity collided across object types

The grouping key was `${functionName}:${objectId}` — no object type. So codeunit
50000's `Run` and table 50000's `Run` were the same method to high-hit-count,
repeated-siblings, and recursive-call. Hit counts merged, sibling groups merged,
and a false "recursion" could be reported between two unrelated objects that
happened to share an id.

All four key sites now go through one methodKey() helper, so they cannot drift.

No fingerprint-algorithm bump: this key is used only for grouping during
detection. A pattern's fingerprint comes from identityTokens(), whose fallback
identity already includes canonicalObjectType.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 6: `single-method-dominance` cannot see a method split across call sites

**Files:**
- Modify: `src/core/patterns.ts` — `detectSingleMethodDominance` (`:18-41`) and `detectEventSubscriberHotspot`
- Test: `test/core/patterns.test.ts`

**Background.** The flagship detector, in full:

```typescript
for (const node of profile.allNodes) {
    if (isIdleNode(node)) continue;
    if (node.selfTimePercent > 50) {
```

It thresholds **per node**, not per method. A profile node is one *call site* — the same method called from three places is three nodes. So a method burning 90% of total self-time across three call sites at 30% each is **never flagged**, and the tool reports no dominant method while one method is eating the entire profile.

Method-level aggregation already exists and is already correct: `aggregateByMethod` in `src/core/aggregator.ts:54`, keyed `` `${functionName}_${objectType}_${objectId}` `` (`:63`). The detector simply does not use it. `src/core/analyzer.ts:209` already calls it for the breakdown table — so the analysis surface and the detector disagree about what a "method" is.

`detectEventSubscriberHotspot` has the identical shape (sums `selfTimePercent` over prefix-matched *nodes*) and gets the same fix.

**Regression risk is low, and provably one-directional.** An aggregate's self-time is the sum of its nodes' self-times, so `aggregate% >= any single node%`. Every method that trips the threshold today still trips it after aggregation. The change can only *add* findings, never remove one. Any existing test that breaks was asserting the blindness.

- [ ] **Step 1: Write the failing test**

```typescript
describe("single-method-dominance — aggregation", () => {
	it("flags a method that dominates via several call sites, not one", () => {
		// 3 call sites x 30% self-time = 90% of the profile in one method.
		// Per-node thresholding sees three 30% nodes and reports nothing.
		const profile = makeProfileWith([
			{ objectType: "Codeunit", objectId: 50000, functionName: "Post", selfTimePercent: 30 },
			{ objectType: "Codeunit", objectId: 50000, functionName: "Post", selfTimePercent: 30 },
			{ objectType: "Codeunit", objectId: 50000, functionName: "Post", selfTimePercent: 30 },
		]);

		const patterns = detectSingleMethodDominance(profile);

		expect(patterns.find((p) => p.id === "single-method-dominance")).toBeDefined();
	});

	it("does not flag three DIFFERENT methods at 30% each", () => {
		// The guard against over-correcting: aggregation must key on the method,
		// not collapse everything.
		const profile = makeProfileWith([
			{ objectType: "Codeunit", objectId: 50000, functionName: "A", selfTimePercent: 30 },
			{ objectType: "Codeunit", objectId: 50000, functionName: "B", selfTimePercent: 30 },
			{ objectType: "Codeunit", objectId: 50000, functionName: "C", selfTimePercent: 30 },
		]);
		expect(detectSingleMethodDominance(profile)).toHaveLength(0);
	});
});
```

Use the profile helper `test/core/patterns.test.ts` already has. If it cannot build multiple nodes for one method, extend it — do not switch to a real fixture file.

- [ ] **Step 2: Run, confirm the first test fails**

Run: `AI_DISABLED=1 bun test test/core/patterns.test.ts -t "aggregation"`
Expected: FAIL — three 30% nodes, nothing reported.

- [ ] **Step 3: Rewrite the detector against `aggregateByMethod`**

Import `aggregateByMethod` from `./aggregator.js` and threshold on the aggregate. The pattern's `impact` becomes the aggregate `selfTime`, and `involvedMethods` the single aggregated method.

Watch two things:
- `formatMethodRef` takes a `ProcessedNode`. `MethodBreakdown` is a different shape (`functionName`, `objectType`, `objectId`). Add a small formatter for it rather than casting.
- `DetectedPattern` may carry a source location taken from the node. An aggregated method has *several* locations. Pick the highest-self-time node as the representative and say so in the evidence string — do not silently drop the others.

The `evidence` string must state the aggregation, e.g.
`selfTimePercent = 90.0% aggregated across 3 call sites (threshold: 50%)`.
A user who greps the profile for a single 90% frame and cannot find one must not conclude the tool is lying.

- [ ] **Step 4: Same fix for `detectEventSubscriberHotspot`**

It sums `selfTimePercent` across prefix-matched nodes. Aggregate first, then threshold.

**Do NOT fix the name-prefix subscriber matching in this task** (`OnBefore|OnAfter|HandleOn`) — a subscriber named `MySubscriber` is invisible and a method coincidentally named `OnAfterFoo` false-positives. That is real, it is unverified, and it is listed in "Not in this plan".

- [ ] **Step 5: Run the FULL suite, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/core/patterns.ts test/core/patterns.test.ts
git add src/core/patterns.ts test/core/patterns.test.ts
git commit -m "$(cat <<'EOF'
fix(patterns): single-method-dominance could not see a split-call-site method

It thresholded per profile NODE, not per method. A node is one call site, so a
method burning 90% of total self-time across three call sites at 30% each was
never flagged — and the tool cheerfully reported no dominant method while one
method ate the entire profile.

Method aggregation already existed and was already correct (aggregateByMethod,
keyed functionName_objectType_objectId) and analyzer.ts already used it for the
breakdown table. Only the detector disagreed about what a method is.

Same fix applied to event-subscriber-hotspot, which had the identical shape.

Can only add findings, never remove one: an aggregate's self-time is the sum of
its nodes', so anything that tripped the threshold before still does.

Found by an external-model audit (Fable 5) reading the source.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 7: Report and page row triggers are not loops, so nothing in them is ever analyzed

**Files:**
- Modify: `src/source/indexer.ts` — `LOOP_NODE_TYPES` (`:86-91`) is *not* the place to fix this; the fix goes in `walkForMembers` (`:886-901`) and `extractFeatures`
- Modify: `CLAUDE.md` (the source-correlated detector description)
- Test: `test/source/*` + a **new report fixture** in `test/fixtures/source/`

**Interfaces:**
- `extractFeatures(codeBlock)` gains an object-context parameter. Tasks 8 and 9 both depend on this, so **Task 7 must land before them.**

**Background — this is the biggest hole in the tool.**

Loop containment comes from `LOOP_NODE_TYPES` (`src/source/indexer.ts:86-91`), which is exactly:

```typescript
const LOOP_NODE_TYPES = new Set([
	"repeat_statement",
	"for_statement",
	"foreach_statement",
	"while_statement",
]);
```

Four syntactic loop constructs. Nothing else.

But in a BC **report**, `OnAfterGetRecord` *is* the loop — the platform calls it once per row of the dataitem. Same for an **XMLport**. Same for a **page**, which calls it per row rendered. There is no `repeat` in the source, so `features.recordOpsInLoops` is empty, so `calcfields-in-loop`, `modify-in-loop`, `record-op-in-loop`, `missing-setloadfields` and the two new detectors from Task 2 **all see nothing**.

A `CalcFields` in a report's `OnAfterGetRecord` — one SQL aggregation per row, over a million-row ledger — is the single most common expensive thing in real BC code, and al-perf is structurally incapable of reporting it. No test caught this because **no fixture in the repo is a report**.

The data is already there: `src/source/indexer.ts:886-901` indexes `trigger_declaration` nodes with full `features` (`extractFeatures`, `extractVariables`), exactly like procedures. Triggers are parsed. They are simply never treated as loop bodies.

- [ ] **Step 1: Build the fixture first — it is the point of this task**

Create `test/fixtures/source/SlowReport.al`: a report with a dataitem over a ledger table whose `OnAfterGetRecord` does a `CalcFields` and a `Get` on another record. No `repeat`. No `for`. Nothing syntactically a loop.

This fixture is the deliverable as much as the code is. Its absence is why this bug survived.

- [ ] **Step 2: Write the failing test**

```typescript
describe("per-row triggers are loop bodies", () => {
	it("flags CalcFields in a report OnAfterGetRecord", () => {
		// OnAfterGetRecord runs once per dataitem row — it IS the loop. There is no
		// `repeat` in the source, which is exactly why this was invisible.
		const patterns = runSourceDetectors("test/fixtures/source/SlowReport.al");
		expect(patterns.find((p) => p.id === "calcfields-in-loop")).toBeDefined();
	});

	it("does not treat OnPreDataItem as a loop body — it runs once", () => {
		// The guard against over-firing. Not every trigger is per-row.
		const patterns = runSourceDetectors("test/fixtures/source/ReportPreDataItem.al");
		expect(patterns.find((p) => p.id === "calcfields-in-loop")).toBeUndefined();
	});
});
```

- [ ] **Step 3: Run, confirm it fails**

Run: `AI_DISABLED=1 bun test -t "per-row triggers"`
Expected: FAIL — nothing is detected, because nothing is in a loop.

- [ ] **Step 4: Implement — promote per-row trigger bodies to implicit loop bodies**

`extractFeatures(codeBlock)` cannot see the object type or trigger name, so thread that context in. Add to `src/source/indexer.ts`:

```typescript
/**
 * Triggers the BC platform calls ONCE PER ROW. Their whole body is a loop body,
 * even though nothing in the AL source is syntactically a loop.
 *
 * This is the most common place a real BC performance bug lives — a CalcFields in
 * a report's OnAfterGetRecord is one SQL aggregation per row of the dataitem — and
 * before this, none of the source-correlated detectors could see any of it.
 *
 * OnPreDataItem / OnPostDataItem run once and are deliberately NOT here.
 */
const PER_ROW_TRIGGERS: Record<string, Set<string>> = {
	Report: new Set(["onaftergetrecord"]),
	XmlPort: new Set(["onaftergetrecord"]),
	Page: new Set(["onaftergetrecord"]),
};

function isPerRowTrigger(objectType: string, triggerName: string): boolean {
	return PER_ROW_TRIGGERS[objectType]?.has(triggerName.toLowerCase()) ?? false;
}
```

Then in `walkForMembers` (`:886`), after `extractFeatures` for a `trigger_declaration`, if `isPerRowTrigger(objectType, name)`, promote every op in `features.recordOps` into `features.recordOpsInLoops`.

**Read `RecordOpInfo` before you do this.** If entries in `recordOpsInLoops` carry a reference to the enclosing `LoopInfo`, you must synthesize one representing the trigger (its type, its line range) rather than leaving the field undefined and hoping nothing dereferences it. Check `src/source/source-patterns.ts` for what the detectors actually read off those ops.

**Confirm the object type string.** `OBJECT_TYPE_MAP` at `src/source/indexer.ts:~70-84` decides what `objectType` actually is (`"XmlPort"` vs `"Xmlport"` etc.). Match it exactly — a silent key miss here makes the whole task a no-op that still passes typecheck.

- [ ] **Step 5: Make the finding explain itself**

The detectors will now report "inside a loop" pointing at a line in a trigger with no visible loop. A user will read that as a bug in al-perf.

Every pattern raised from an implicit loop must say so in its `evidence`, e.g.
`Report.OnAfterGetRecord runs once per dataitem row — this call executes once per row.`

If the shared message construction cannot express that, add a flag to the op (`implicitLoop: "Report.OnAfterGetRecord"`) and branch in the message. **Do not ship this without it.** A correct finding a user dismisses as a tool bug is worth nothing.

- [ ] **Step 6: Page — decide consciously**

`Page.OnAfterGetRecord` is bounded by rows rendered (tens), not table rows (millions). It is still the classic slow-list-page bug and it is still worth flagging, but it is not the same order of cost as a report.

If severity is derived per-pattern, drop a page-sourced implicit-loop finding one level (critical → warning). If that is not expressible without restructuring, ship Page at full severity and note it in the commit — over-reporting a real slow-list-page is acceptable; missing reports is not.

**Table triggers (`OnValidate`, `OnInsert`, `OnModify`) are deliberately excluded.** They are per-*operation*, not per-row — they are only a loop when the caller loops, which is the cross-procedure problem in "Not in this plan". Flagging every `CalcFields` in an `OnValidate` would be noise.

- [ ] **Step 7: Update the docs**

`CLAUDE.md` describes the source-correlated detectors as working on loops. State that per-row triggers (`Report`/`XmlPort`/`Page` `OnAfterGetRecord`) count as loop bodies.

- [ ] **Step 8: Run the FULL suite, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/source/indexer.ts
git add src/source/indexer.ts CLAUDE.md test/fixtures/source/ test/source/
git commit -m "$(cat <<'EOF'
feat(source): treat per-row triggers as loop bodies

Loop containment came from LOOP_NODE_TYPES — repeat/for/foreach/while. Four
syntactic constructs, nothing else.

But in a BC report, OnAfterGetRecord IS the loop: the platform calls it once per
dataitem row. There is no `repeat` in the source, so recordOpsInLoops was empty,
so calcfields-in-loop, modify-in-loop, record-op-in-loop and missing-setloadfields
all saw nothing. A CalcFields in a report's OnAfterGetRecord — one SQL aggregation
per row of a million-row ledger — is the most common expensive thing in real BC
code, and al-perf was structurally incapable of reporting it.

Triggers were already fully indexed with features; they were simply never treated
as loop bodies. Report/XmlPort/Page OnAfterGetRecord now are. OnPreDataItem and
OnPostDataItem run once and are not. Table triggers are per-operation, not per-row,
and are excluded.

Findings raised from an implicit loop say so in their evidence, because a user
reading "inside a loop" against a trigger with no visible loop would rightly call
that a tool bug.

No test caught this because no fixture in the repo was a report. There is one now.

Found by an external-model audit (Fable 5) reading the source.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 8: Record calls on the implicit `Rec` are silently dropped

**Depends on Task 7** (the object-context parameter on `extractFeatures`).

**Files:**
- Modify: `src/source/indexer.ts` — `collectRecordOps` (`:372-380`)
- Test: `test/source/*` + fixtures

**Background.** `collectRecordOps`:

```typescript
if (n.type === "call_expression") {
    const funcNode = n.childForFieldName("function") ?? n.namedChildren[0];
    if (funcNode) {
        if (funcNode.type === "member_expression") {
```

Only `member_expression` calls — `SomeRec.FindSet()`. In table, page, report and XMLport code, the implicit `Rec` is idiomatic and pervasive: plain `FindSet();`, `Modify();`, `CalcFields(Amount);`. Those parse as a `call_expression` with a **plain identifier** function node, and are **never collected**. Not by any detector, at any severity.

This is an inconsistency, not a considered choice: `collectDangerousCalls` (`:424-433`) takes `funcNode.text` with **no type check at all**, so bare `Commit;` is collected fine. The two collectors in the same file disagree about what a call looks like.

Combined with Task 7 this is what makes report analysis actually work — a report's `OnAfterGetRecord` is *full* of bare `Rec` calls.

- [ ] **Step 1: Write the failing test**

```typescript
describe("implicit Rec", () => {
	it("collects a bare CalcFields() in table code", () => {
		// `CalcFields(Amount);` with no receiver — the implicit Rec. Idiomatic in
		// table/page/report code and previously invisible to every detector.
		const feats = indexFixture("test/fixtures/source/ImplicitRec.al");
		expect(feats.recordOps.some((op) => op.type === "CalcFields")).toBe(true);
	});

	it("does not collect a bare call in a codeunit, which has no implicit Rec", () => {
		// A codeunit's `Get(...)` is a local procedure, not a record op.
		const feats = indexFixture("test/fixtures/source/CodeunitLocalGet.al");
		expect(feats.recordOps).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run, confirm it fails**

- [ ] **Step 3: Implement, narrowly**

Add an `else` branch for a plain-identifier function node, gated on **both**:

1. the object having an implicit `Rec` — `Table`, `Page`, `Report`, `XmlPort`, `RequestPage`. A codeunit has no `Rec`, so a bare `Get(...)` there is a local procedure call, not a record op. This is why Task 7's object-context parameter is a prerequisite.
2. the name being in `RECORD_OPS`.

Set `recordVariable` to `"Rec"` so downstream variable resolution, `isTemporaryOp`, and table lookup all have something to work with.

**Accept and document the residual false positive:** a local procedure in a *table* named `Get` or `Count` will now be read as a record op. That is rare, and it is a far smaller error than dropping every implicit-`Rec` call in every table, page and report. Put that reasoning in a code comment, not just the commit.

- [ ] **Step 4: Run the FULL suite — this WILL surface new findings**

```bash
AI_DISABLED=1 bun test
```

Existing fixtures with implicit-`Rec` code will start producing findings they never produced. Read each new one before touching a test. A new finding here is very likely a real bug that was invisible.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit
bunx biome check --write src/source/indexer.ts
git add src/source/indexer.ts test/
git commit -m "$(cat <<'EOF'
fix(source): collect record calls on the implicit Rec

collectRecordOps only matched member_expression calls — SomeRec.FindSet(). In
table, page, report and XMLport code the implicit Rec is idiomatic: plain
FindSet();, Modify();, CalcFields(Amount);. Those are call_expressions with a
plain identifier and were never collected — not by any detector, at any severity.

An inconsistency, not a choice: collectDangerousCalls in the same file reads
funcNode.text with no type check, so bare Commit; was collected fine. The two
collectors disagreed about what a call looks like.

Gated on objects that actually HAVE an implicit Rec (Table/Page/Report/XmlPort/
RequestPage) — a bare Get(...) in a codeunit is a local procedure, not a record op.

Residual false positive accepted and commented: a local procedure in a table named
Get or Count now reads as a record op. Rare, and far smaller than dropping every
implicit-Rec call in every table, page and report.

Found by an external-model audit (Fable 5) reading the source.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 9: `dangerous-call-in-loop` does not know what a dangerous call is

**Depends on Task 8** (bare-identifier calls, for `Sleep`).

**Files:**
- Modify: `src/source/indexer.ts:405-411` (`DANGEROUS_CALLS`), `src/source/source-only-patterns.ts:179-182`
- Modify: `CLAUDE.md` (detector count and description)
- Test: `test/source/source-only-patterns.test.ts` + fixtures

**Background.** The whole set, `src/source/indexer.ts:405`:

```typescript
const DANGEROUS_CALLS = new Set(["commit", "error", "testfield"]);
```

An `HttpClient.Send()` inside a loop — **one network round-trip per iteration**, the most expensive thing an AL developer can accidentally write — is not dangerous. `Sleep()` in a loop is not dangerous. A detector named `dangerous-call-in-loop` that misses a per-row HTTP call is misnamed.

**A new detector, not a widened set.** `Commit`/`Error`/`TestField` in a loop are *transactional* problems (a `Commit` in a loop breaks the write transaction into N). An HTTP call in a loop is a *latency* problem, with a completely different fix — batch the request, or hoist it. Same reasoning as Task 2: different fix, different pattern id.

New pattern id: **`external-call-in-loop`**.

- [ ] **Step 1: Check what variable type information exists**

`HttpClient.Send()` is a `member_expression` on a variable declared `HttpClient`. To recognize it you need the variable's declared type. `extractVariables` (`:477`) already resolves `isRecord` / `tableName` / temporary, so *some* type is parsed.

**If `VariableInfo` does not retain the declared type name for non-record variables, extend it.** That is the real work of this task; the detector itself is trivial. If the extension turns out to be large, STOP and report — `Sleep` alone (a bare identifier, no type resolution needed) is still worth shipping, and the HTTP half becomes its own task.

- [ ] **Step 2: Write the failing test**

```typescript
describe("external-call-in-loop", () => {
	it("flags HttpClient.Send() inside a loop", () => {
		// One network round-trip per iteration.
		const patterns = runSourceDetectors("test/fixtures/source/HttpInLoop.al");
		const f = patterns.find((p) => p.id === "external-call-in-loop");
		expect(f).toBeDefined();
		expect(f?.severity).toBe("critical");
		expect(f?.suggestion).toMatch(/batch|outside the loop|single request/i);
	});

	it("does not flag an HttpClient.Send() outside a loop", () => {
		expect(
			runSourceDetectors("test/fixtures/source/HttpNoLoop.al")
				.find((p) => p.id === "external-call-in-loop"),
		).toBeUndefined();
	});

	it("leaves dangerous-call-in-loop reporting only Commit/Error/TestField", () => {
		// Transactional problems, different fix, separate id. Not merged.
		const patterns = runSourceDetectors("test/fixtures/source/HttpInLoop.al");
		expect(patterns.find((p) => p.id === "dangerous-call-in-loop")).toBeUndefined();
	});
});
```

- [ ] **Step 3: Implement**

Collect external calls: `HttpClient.{Send,Get,Post,Put,Patch,Delete}` (by declared variable type, not by method name alone — `Get` and `Delete` collide with record ops), plus bare `Sleep(...)`.

Severity `critical`. Suggestion: hoist the call out of the loop, or batch the payload into a single request — N iterations means N round-trips, and network latency dominates everything else in the profile.

**`Codeunit.Run` in a loop is NOT in scope.** It is a transaction-boundary problem and needs its own thinking. Note it as a follow-up.

- [ ] **Step 4: Update the docs**

`CLAUDE.md`: the count moves again (20 after Task 2 → 21), and `external-call-in-loop` joins the source-only list. Grep for every stated count: `grep -rn "detectors" CLAUDE.md README.md docs/`.

- [ ] **Step 5: Run, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/source/indexer.ts src/source/source-only-patterns.ts
git add src/source/indexer.ts src/source/source-only-patterns.ts CLAUDE.md test/
git commit -m "$(cat <<'EOF'
feat(patterns): detect external calls in a loop

The entire dangerous-call set was:

    const DANGEROUS_CALLS = new Set(["commit", "error", "testfield"]);

So an HttpClient.Send() inside a loop — one network round-trip per iteration, the
most expensive thing an AL developer can accidentally write — was not dangerous.
A detector named dangerous-call-in-loop that misses a per-row HTTP call is
misnamed.

New pattern id rather than a widened set, because the fixes differ: Commit in a
loop is a TRANSACTIONAL problem (one write transaction becomes N); an HTTP call in
a loop is a LATENCY problem, fixed by batching or hoisting. One suggestion cannot
serve both.

Codeunit.Run in a loop is a transaction-boundary problem and is deliberately left
for its own task.

Found by an external-model audit (Gemini 3.1 Pro) reading the source.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

## Not in this plan

**Cross-procedure loop propagation — the biggest thing left.** Loop containment is computed *within one procedure's code_block*. A `repeat` that calls `ProcessLine(SalesLine)`, where `ProcessLine` does the `Get`/`Modify`/`CalcFields`, detects **nothing**: the op is not lexically inside the loop, and the callee contains no loop. Real N+1 code is almost always factored through a helper. Fixing it needs call-graph propagation ("this procedure is reachable from a loop, so lift its record ops"), which is an architectural change, not a rule. Task 7 fixes the *implicit*-loop half of this problem; this is the other half, and it is bigger. It deserves its own spec.

**Unverified candidates.** Reported by a model, **not yet checked against the source** — verify each before acting on it:
- `unfiltered-findset`: order is ignored, so `SetRange(...); Reset(); FindSet();` counts as filtered.
- `SetLoadFields()` with **zero args** resets to loading all fields, but still registers the variable as covered.
- `extractVariables` reads only a procedure's own `var_section`, so object-level globals are never resolved — temp checks and table lookups silently fail for them.
- `unindexed-filter` only checks a key's **leading** field, and skips tables not in the index — meaning **every filter on a standard BC table is unchecked**.
- Event-subscriber identification is a regex over the preceding 5 lines plus `OnBefore|OnAfter|HandleOn` name-prefix matching. A subscriber named `MySubscriber` is invisible; a method coincidentally named `OnAfterFoo` false-positives. (Task 6 deliberately does not touch this.)
- `RecordRef`/`FieldRef` code bypasses record-op detection entirely.
- No detector uses `Count` even though it is collected: `Count > 0` should be `IsEmpty`.
- `Validate` in a loop (fires table triggers and table relations per row) and `SetAutoCalcFields` (a stealth CalcFields-per-`Next`) are not in `RECORD_OPS` at all.
- No SIFT awareness: keys are parsed but `SumIndexFields` is not extracted, so a `CalcSums` with no covering SIFT key cannot be flagged.

**Deliberately NOT a defect:** `detectHighHitCount` skips root-level nodes (`src/core/patterns.ts:68` guards on `node.parent`). That was reported as a bug. It is not — the heuristic is a *ratio* to the parent's hit count, and a node with no parent has no ratio. Leave it.

**The SQL evidence layer.** The strategic finding — that BC profiles now carry the SQL statements themselves, and RT0005 telemetry carries `sqlStatement` + `executionTime` + `alStackTrace`, and we throw all of it away — is a separate project. It needs its own brainstorm and spec. It is almost certainly worth more than every fix above combined, because it would make the *existing* detectors stop guessing.

## Self-Review

**Spec coverage.** All nine verified defects have a task: wrong advice → 1; undetected Insert/Delete → 2; ordering suppression → 3; dead prioritization → 4; identity collision → 5; per-node dominance thresholding → 6; per-row triggers not loops → 7; implicit `Rec` dropped → 8; dangerous-call set missing HTTP → 9.

**Provenance.** Tasks 1–5 from GPT-5.5, 6–8 from Fable 5, 9 from Gemini 3.1 Pro — three model families, all reading the same source. Task 2 was found independently by two of them. Every claim in this plan was re-verified against the code before being written down; claims that did not survive that check are in "Not in this plan" as unverified, or called out above as not-a-defect.

**Task ordering is load-bearing.** 7 → 8 → 9 is a hard chain: Task 7 introduces the object-context parameter on `extractFeatures`, Task 8 needs it to know whether an object has an implicit `Rec`, Task 9 needs Task 8 for bare `Sleep`. Do not reorder them.

**Type consistency.** `sortPatterns(patterns: DetectedPattern[]): DetectedPattern[]` is declared in Task 4 and used at both call sites there. `methodKey(node: ProfileNode): string` is declared in Task 5 and used at all four sites there. `isPerRowTrigger(objectType, triggerName)` is declared in Task 7 and used in Tasks 7 and 8. `isTemporaryOp` is an existing helper reused in Tasks 2 and 3 — verify its real signature before calling it.

**Known soft spots**, each carrying an explicit instruction to verify rather than trust:
- Task 1 Step 4: whether the `RecordOp` carries the field names passed to `CalcFields`. If not, that sub-fix becomes its own task and the suggestion fix still stands alone.
- Task 3 Step 3: whether `SetLoadFields` ops carry their argument list (for the bare-reset case). If not, leave it — a wrong suppression rule is worse than a missing one.
- Task 5 Step 4: existing tests may have been asserting the merged behavior. Read before changing.
- Task 6 Step 3: `DetectedPattern` may carry a node-derived source location that an aggregated method does not have. Pick a representative node; do not fabricate.
- Task 7 Step 4: `RecordOpInfo` may reference an enclosing `LoopInfo`. If it does, synthesize one for the trigger — do not leave it undefined.
- Task 7 Step 4: the exact `objectType` strings come from `OBJECT_TYPE_MAP`. A key miss makes the task a silent no-op that still typechecks.
- Task 9 Step 1: whether `VariableInfo` retains declared types for non-record variables. If not, that extension is the real work — and if it is large, ship `Sleep` alone and split out the HTTP half.
