# Detector Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five verified defects in al-perf's detectors, one of which actively misleads users, and one of which means a documented capability does not exist.

**Architecture:** Five independent fixes across three detector files plus two sort sites. No schema changes, no fingerprint-algorithm change (verified — see Global Constraints).

**Tech Stack:** Bun, TypeScript, `bun:test`, Biome.

**Source:** `private/research/VERIFIED-FINDINGS.md`. Every defect below was reported by GPT-5.5 (which read the real code and fetched Microsoft docs) and then **verified by me against the source**. Two were independently confirmed by a second model.

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

Tasks 1–5 are largely independent. Tasks 1, 2, and 3 all touch `source-patterns.ts`, so run them sequentially, not in parallel worktrees. Tasks 4 and 5 both touch `core/patterns.ts` — same rule.

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

## Not in this plan

**The unverified candidates.** `private/research/VERIFIED-FINDINGS.md` lists five more suspected defects that I have **not** checked against the source (the `unfiltered-findset` ordering bug, the `unindexed-filter` composite-key false positive, the `incomplete-setloadfields` factually-wrong message, and the name-prefix event-subscriber detection). Verify each before acting — the model that reported them was right five times out of five, but that is not a licence to skip checking.

**The SQL evidence layer.** The strategic finding — that BC profiles now carry the SQL statements themselves, and RT0005 telemetry carries `sqlStatement` + `executionTime` + `alStackTrace`, and we throw all of it away — is a separate project. It needs its own brainstorm and spec. It is almost certainly worth more than all five fixes above combined, because it would make five *existing* detectors stop guessing.

## Self-Review

**Spec coverage.** All five verified defects have a task: wrong advice → 1; undetected Insert/Delete → 2; ordering suppression → 3; dead prioritization → 4; identity collision → 5.

**Type consistency.** `sortPatterns(patterns: DetectedPattern[]): DetectedPattern[]` is declared in Task 4 and used at both call sites there. `methodKey(node: ProfileNode): string` is declared in Task 5 and used at all four sites there. `isTemporaryOp` is an existing helper reused in Tasks 2 and 3 — verify its real signature before calling it.

**Known soft spots**, each carrying an explicit instruction to verify rather than trust:
- Task 1 Step 4: whether the `RecordOp` carries the field names passed to `CalcFields`. If not, that sub-fix becomes its own task and the suggestion fix still stands alone.
- Task 3 Step 3: whether `SetLoadFields` ops carry their argument list (for the bare-reset case). If not, leave it — a wrong suppression rule is worse than a missing one.
- Task 5 Step 4: existing tests may have been asserting the merged behavior. Read before changing.
