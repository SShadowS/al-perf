# Detector Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four ready-to-code follow-ups carried out of the `feat/detector-audit-fixes` whole-branch review — one real correctness bug (source-match collides across object types), one non-actionable-advice bug (`CalcSums` gets `CalcFields` advice), one display collision, and one testability gap (no way to assert `PATTERN_DOCS` is complete).

**Architecture:** Four independent fixes across four areas. No schema changes, no fingerprint-algorithm change. Task 1 is the only one that changes *which* source location a finding attaches to; the other three are advice text, a display key, and a new registry + test.

**Tech Stack:** Bun, TypeScript, `bun:test`, Biome, tree-sitter-al.

**Source:** the follow-up list at the bottom of `.superpowers/sdd/progress.md` (gitignored), triaged by the whole-branch review of the detector-audit branch. That review is merged at `264b119` on `master`.

## Global Constraints

- Tests run as `AI_DISABLED=1 bun test`. **Never** without that env var.
- `bunx tsc --noEmit` must be clean before any commit.
- `bunx biome check --write` on every file you touch.
- **CRLF TRAP:** the repo has ~200 files that show as stat-dirty from `core.autocrlf` noise and are NOT your changes. **Only ever `git add` the exact paths you changed.** Never `git add -A`, `git add .`, `git checkout`, `git reset`, or `git stash`. If you think you need one of those, stop and report.
- Every commit ends with the trailer:
  `Claude-Session: https://claude.ai/code/session_016kmkaWAj6JRobrX1hKkdXM`
- **Do NOT touch `FINGERPRINT_ALGO_VERSION` (`src/lifecycle/fingerprint.ts`) or anything under `src/lifecycle/`.** `involvedMethods[0]` is the lifecycle fingerprint anchor; a sort must never reorder it. If you find yourself editing that constant, you have gone wrong.
- Detector count in `CLAUDE.md` is **21 pattern ids** (7 profile-only + 7 source-correlated + 7 source-only — `detectEventSubscriberIssues` emits two ids, so 20 functions yield 21 ids). It stays 21; no task here adds a detector.
- Fixture count in `test/fixtures/source/` is **28**. Prefer extending existing fixtures. If you add one, update all the fixture-count assertions honestly and state the new number in your report. The count-asserting sites are `test/source/source-map.test.ts`, `test/e2e/source-correlation.test.ts`, `test/source/cache.test.ts`, `test/source/indexer.test.ts`, `test/source/indexer-snapshots.test.ts`.

## Why these four, and not the other four follow-ups

The follow-up list has eight items. Four are ready to code (this plan). Four are NOT, and are in "Not in this plan" with the reason each needs its own brainstorm or systematic-debugging pass first — do not fold them in here.

## File Structure

| Task | Touches |
|---|---|
| 1 | `src/source/locator.ts` (`matchAllToSource` step 1), `test/source/locator.test.ts`, two new `.al` fixtures |
| 2 | `src/source/source-patterns.ts` (`calcFieldsSuggestion` + its one call site), `test/source/source-patterns.test.ts` |
| 3 | `src/core/table-view.ts` (the parent-ref key), `test/core/table-view.test.ts` |
| 4 | `src/types/patterns.ts` (new `PATTERN_IDS`), `src/mcp/server.ts` (`PATTERN_DOCS` keyed off it), a new exhaustiveness test |

All four are independent and touch disjoint files. **Do Task 1 first** — it is the only real correctness bug and the reviewer flagged it as the top follow-up. The rest may run in any order or parallel worktrees.

---

### Task 1: source-match collides across object types

**Files:**
- Modify: `src/source/locator.ts` — `matchAllToSource`, step 1 (`:41-43`)
- Test: `test/source/locator.test.ts`
- Create: `test/fixtures/source/CollisionCodeunit50999.al`, `test/fixtures/source/CollisionTable50999.al`

**Interfaces:**
- Consumes: `canonicalObjectType(s: string): string` from `src/semantic/identity.ts` (case-insensitive; returns the input unchanged for unknown types; maps `"CodeUnit" → "Codeunit"`, `"XMLPort" → "XMLport"`, `"TableData" → "Table"`, and leaves `"PageExtension"` as-is).
- Produces: no signature change. `matchAllToSource` and `matchToSource` keep their exact shapes; only the candidate-selection logic changes.

**Background.** `matchAllToSource` (`src/source/locator.ts:27`) resolves a profile method to its source. Its **step 1** is:

```typescript
// 1. All candidates matching objectId (may be multiple overloads).
const exactMatches = allCandidates.filter((c) => c.objectId === objectId);
if (exactMatches.length > 0) return exactMatches;
```

It filters on **`objectId` alone.** Object ids in AL are unique *per type* — Table 50100 and Codeunit 50100 coexist legally. If two objects of different types share an id **and** a member name (e.g. both have a `Refresh` procedure), step 1 returns **both**, so a finding is emitted against **both** anchors — one of which is a routine that does not contain the code, with its own (wrong) fingerprint and wrong `file:line` routing for the lifecycle engine.

The type-aware branch already exists at `:49-52` (step 3, `objectType === objectType && objectId === objectId`), but it is **dead whenever step 1 fires**, because step 1 returns first on any id match.

**This is not the fabrication class the branch blocked on.** The finding's description and `file:line` still point at real code; only the `involvedMethods[0]` label (hence lifecycle routing) is wrong. Precision is unchanged from before the fix; recall is unaffected. But a finding filed against a routine that does not contain the code is wrong, and the fix is contained.

**The fix (the reviewer's prototype):** make step 1 require a canonical object-type match, and fall back to the id-only set only when no type matches — preserving today's recall for callers whose `objectType` is absent or unrecognized.

**Why fixtures are the deliverable.** This bug is **invisible to the fixture corpus and to every corpus sweep** — no fixture has two objects that share an id and a member name. Without the two fixtures below, any fix here is unfalsifiable. Build them first.

- [ ] **Step 1: Build the two colliding fixtures**

`test/fixtures/source/CollisionCodeunit50999.al`:

```al
codeunit 50999 "Collision Handler"
{
    procedure Refresh()
    var
        Customer: Record Customer;
    begin
        if Customer.FindSet() then
            repeat
                Customer.CalcFields("Balance (LCY)");
            until Customer.Next() = 0;
    end;
}
```

`test/fixtures/source/CollisionTable50999.al`:

```al
table 50999 "Collision Buffer"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
    }

    procedure Refresh()
    begin
        Message('no record work here');
    end;
}
```

Both declare `Refresh`; both have object id 50999; one is a `Codeunit`, one a `Table`. Only the codeunit's `Refresh` contains a `calcfields-in-loop`.

- [ ] **Step 2: Write the failing unit test**

Add to `test/source/locator.test.ts`, using the file's existing `makeProcedure` / `makeIndex` helpers (`test/source/locator.test.ts:9-47`). A `makeIndex` call takes a list of procedures; two procedures with the same lowercased name land in the same map bucket, which is exactly the collision.

```typescript
describe("matchAllToSource — object-type collision (id is unique only per type)", () => {
	it("returns only the candidate whose object type matches", () => {
		const cuRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Codeunit",
			objectId: 50999,
			objectName: "Collision Handler",
		});
		const tblRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Table",
			objectId: 50999,
			objectName: "Collision Buffer",
		});
		const index = makeIndex([cuRefresh, tblRefresh]);

		const matches = matchAllToSource("Refresh", "Codeunit", 50999, index);

		expect(matches).toHaveLength(1);
		expect(matches[0].objectType).toBe("Codeunit");
	});

	it("is case-insensitive on the object type (CodeUnit vs Codeunit)", () => {
		const cuRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Codeunit",
			objectId: 50999,
		});
		const tblRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Table",
			objectId: 50999,
		});
		const index = makeIndex([cuRefresh, tblRefresh]);

		// Profiles sometimes carry "CodeUnit"; the index carries "Codeunit".
		expect(matchAllToSource("Refresh", "CodeUnit", 50999, index)).toHaveLength(1);
	});

	it("falls back to the id-only set when NO candidate type matches", () => {
		// Preserves today's recall: an unrecognized/absent caller type must not
		// silently drop a real match.
		const cuRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Codeunit",
			objectId: 50999,
		});
		const index = makeIndex([cuRefresh]);

		const matches = matchAllToSource("Refresh", "Query", 50999, index);
		expect(matches).toHaveLength(1);
		expect(matches[0].objectType).toBe("Codeunit");
	});

	it("still returns genuine same-type overloads (two Codeunit 50999 Refresh)", () => {
		// The overload case step 1 was designed for must survive the fix.
		const a = makeProcedure({ name: "Refresh", objectType: "Codeunit", objectId: 50999, lineStart: 10 });
		const b = makeProcedure({ name: "Refresh", objectType: "Codeunit", objectId: 50999, lineStart: 40 });
		const index = makeIndex([a, b]);

		expect(matchAllToSource("Refresh", "Codeunit", 50999, index)).toHaveLength(2);
	});
});
```

- [ ] **Step 3: Run, confirm the collision tests fail**

Run: `AI_DISABLED=1 bun test test/source/locator.test.ts -t "collision"`
Expected: the first two tests FAIL — today both candidates come back (`length` is 2, not 1). The id-only-fallback and same-type-overload tests should PASS already (they assert behavior the current code also has); if either fails, your fixture setup is wrong, not the code.

- [ ] **Step 4: Fix step 1**

In `src/source/locator.ts`, add the import and replace step 1. The current step 1 is at `:41-43`:

```typescript
	// 1. All candidates matching objectId (may be multiple overloads).
	const exactMatches = allCandidates.filter((c) => c.objectId === objectId);
	if (exactMatches.length > 0) return exactMatches;
```

Replace it with:

```typescript
	// 1. Canonical (objectType, objectId) match — the precise answer. objectIds
	//    are unique only PER TYPE in AL (Table 50999 and Codeunit 50999 coexist),
	//    so an id-only match returns a routine from the wrong object whenever two
	//    types share an id and a member name. canonicalObjectType absorbs the
	//    profile-says-"CodeUnit" / index-says-"Codeunit" casing split.
	const wantType = canonicalObjectType(objectType);
	const typeAndId = allCandidates.filter(
		(c) => c.objectId === objectId && canonicalObjectType(c.objectType) === wantType,
	);
	if (typeAndId.length > 0) return typeAndId;

	// 2. Fallback: id-only. Reached only when NO candidate's type matched — an
	//    absent or unrecognized caller type must not silently drop a real match.
	//    Preserves the recall of the previous id-only step 1.
	const idOnly = allCandidates.filter((c) => c.objectId === objectId);
	if (idOnly.length > 0) return idOnly;
```

Add to the imports at the top of the file:

```typescript
import { canonicalObjectType } from "../semantic/identity.js";
```

The existing step 2 (single-candidate, `:45-46`) and step 3 (type+id, `:48-52`) below become redundant with the new step 2 fallback and MAY be removed — but only if the full suite stays green. If unsure, leave them; the new step 1 short-circuits before them and they become dead-but-harmless. State in your report which you did.

- [ ] **Step 5: Run the unit tests, confirm green**

Run: `AI_DISABLED=1 bun test test/source/locator.test.ts`
Expected: all PASS, including the pre-existing tests above line 49.

- [ ] **Step 6: Add an end-to-end fixture assertion**

The unit test pins the resolver. This step pins that the *detector output* is now correct on the real fixtures. Add to `test/source/source-patterns.test.ts` (use the same fixture-indexing helper the other source-correlated tests in that file use — do not invent a harness):

```typescript
describe("source-match collision — codeunit and table sharing id 50999", () => {
	it("attributes calcfields-in-loop to the Codeunit, not the Table", () => {
		// Both objects declare Refresh() and share id 50999; only the codeunit's
		// Refresh has the loop. Before the locator fix, the Table's Refresh was a
		// phantom anchor for this finding.
		const patterns = runSourceDetectorsOnFixtures([
			"test/fixtures/source/CollisionCodeunit50999.al",
			"test/fixtures/source/CollisionTable50999.al",
		]);
		const calc = patterns.filter((p) => p.id === "calcfields-in-loop");
		expect(calc).toHaveLength(1);
		expect(calc[0].involvedMethods[0]).toContain("Codeunit");
		expect(calc[0].involvedMethods[0]).not.toContain("Table");
	});
});
```

If the file has no multi-file fixture helper, index both files into one `SourceIndex` the way the existing tests build theirs, then call `runSourceDetectors` over its methods. Do not add profile data — this is the source-only correlation path.

- [ ] **Step 7: Update the fixture count**

You added two fixtures: 28 → 30. Update all five count-asserting sites listed in Global Constraints. Grep to be sure: `grep -rn "28" test/source/*.test.ts test/e2e/source-correlation.test.ts` and change only the fixture-count assertions (read each hit — do not blind-replace).

- [ ] **Step 8: Run the full suite, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/source/locator.ts test/source/locator.test.ts test/source/source-patterns.test.ts
git add src/source/locator.ts test/source/locator.test.ts test/source/source-patterns.test.ts test/fixtures/source/CollisionCodeunit50999.al test/fixtures/source/CollisionTable50999.al test/source/source-map.test.ts test/e2e/source-correlation.test.ts test/source/cache.test.ts test/source/indexer.test.ts test/source/indexer-snapshots.test.ts
git commit -m "$(cat <<'EOF'
fix(source): match source by object TYPE and id, not id alone

matchAllToSource step 1 filtered candidates on objectId alone. AL object ids are
unique only PER TYPE — Table 50999 and Codeunit 50999 coexist — so when two
objects of different types share an id AND a member name, a finding was emitted
against BOTH, one of them a routine that does not contain the code (wrong anchor,
wrong lifecycle routing, wrong file:line).

Now requires a canonical objectType match first, falling back to the id-only set
only when no candidate type matches, so recall is unchanged for callers whose
objectType is absent or unrecognized.

Invisible to every corpus sweep because no prior fixture had two objects sharing
an id and a member name. Two such fixtures are added; they are the deliverable as
much as the code.

Claude-Session: https://claude.ai/code/session_016kmkaWAj6JRobrX1hKkdXM
EOF
)"
```

---

### Task 2: `CalcSums` in a loop gets advice that does nothing

**Files:**
- Modify: `src/source/source-patterns.ts` — `calcFieldsSuggestion` (`:188-198`) and its call site (`:253`)
- Test: `test/source/source-patterns.test.ts`

**Interfaces:**
- Consumes: `RecordOpInfo.type` (the string `"CalcFields"` or `"CalcSums"`, already on the op — see the filter at `source-patterns.ts:227`).
- Produces: no new export; `calcFieldsSuggestion` gains an `opType` parameter.

**Background.** `detectCalcFieldsInLoop` covers **both** `CalcFields` and `CalcSums` (`src/source/source-patterns.ts:227`). But `calcFieldsSuggestion` (`:188`) always emits:

> "Call **SetAutoCalcFields()** before the loop so the FlowField is calculated as each record is retrieved…"

**`SetAutoCalcFields` does nothing for `CalcSums`.** `CalcSums` sums a FlowField/SumIndexField over the record's current filter; the fix is to hoist it out of the loop onto a filtered set, or use a SIFT key / Query object. So a `CalcSums(Amount)` in a loop is told to call a method that has no effect on it — the same "confident non-actionable advice" class Task 1 of the detector-audit branch existed to remove, in a sibling of the very detector that fixed it.

The suggestion builder never sees `op.type`, so it cannot branch. Thread it in.

- [ ] **Step 1: Write the failing test**

Add to `test/source/source-patterns.test.ts`. Use whatever fixture the existing `calcfields-in-loop` / `CalcSums` tests in that file already use; if none exercises `CalcSums`, extend an existing fixture (e.g. add a `CalcSums` call inside a loop to a fixture that already has a loop) rather than adding a file.

```typescript
describe("calcfields-in-loop — CalcSums gets actionable advice", () => {
	it("does not tell a CalcSums to call SetAutoCalcFields (a no-op for CalcSums)", () => {
		const patterns = runSourceDetectorsOnFixture(/* a fixture with CalcSums in a loop */);
		const f = patterns.find((p) => p.id === "calcfields-in-loop" && p.title.includes("CalcSums"));
		expect(f).toBeDefined();
		expect(f?.suggestion).not.toContain("SetAutoCalcFields");
		expect(f?.suggestion).toMatch(/outside the loop|filtered set|SIFT|CalcSums on the filtered/i);
	});

	it("still tells a CalcFields to call SetAutoCalcFields", () => {
		const patterns = runSourceDetectorsOnFixture(/* a fixture with CalcFields in a loop */);
		const f = patterns.find((p) => p.id === "calcfields-in-loop" && p.title.includes("CalcFields"));
		expect(f?.suggestion).toContain("SetAutoCalcFields");
	});
});
```

- [ ] **Step 2: Run, confirm the CalcSums test fails**

Run: `AI_DISABLED=1 bun test test/source/source-patterns.test.ts -t "CalcSums gets actionable"`
Expected: the first test FAILS — the current suggestion contains "SetAutoCalcFields" for CalcSums too.

- [ ] **Step 3: Thread `op.type` into the suggestion and branch the action**

Change the signature of `calcFieldsSuggestion` (`src/source/source-patterns.ts:188`) to take the op type, and branch the action verb:

```typescript
function calcFieldsSuggestion(
	opType: "CalcFields" | "CalcSums",
	severity: "critical" | "warning",
	resolved: TableFieldInfo[] | undefined,
): string {
	if (opType === "CalcSums") {
		// SetAutoCalcFields does NOT affect CalcSums — it only auto-calculates
		// FlowFields on record retrieval. A CalcSums in a loop must be hoisted
		// out onto a filtered set (one aggregate query instead of N), or backed
		// by a SIFT key / Query object.
		const fact = resolved ? ` ${calcFieldFactSentence(resolved)}` : "";
		return `Move the CalcSums() outside the loop and run it once on the filtered set, or back the sum with a SIFT (SumIndexFields) key so the total is maintained incrementally.${fact}`;
	}

	const action =
		severity === "critical"
			? "Call SetAutoCalcFields() before the loop so the FlowField is calculated as each record is retrieved, or filter on the FlowField instead of calculating it per row."
			: "Call SetAutoCalcFields() before the loop so the FlowField is calculated as each record is retrieved.";
	const fact = resolved ? ` ${calcFieldFactSentence(resolved)}` : "";
	return `${action}${fact} Note SetLoadFields() does NOT help here — it does not accept FlowFields.`;
}
```

Update the one call site (`src/source/source-patterns.ts:253`), passing `op.type`:

```typescript
					suggestion: calcFieldsSuggestion(op.type, severity, resolvedFields),
```

`op.type` here is narrowed by the filter at `:227` to exactly `"CalcFields" | "CalcSums"`, so the argument type is sound; if tsc complains about the union, add `op.type as "CalcFields" | "CalcSums"` at the call site with a short comment noting the filter guarantees it.

**Note on the advice guard:** there is a test asserting no shipped advice string in four files matches `/(use|using|consider)\s+SetLoadFields/i`. The new CalcSums text contains no "SetLoadFields" at all, so it does not trip the guard. Do not weaken that guard.

- [ ] **Step 4: Run the full suite, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/source/source-patterns.ts test/source/source-patterns.test.ts
git add src/source/source-patterns.ts test/source/source-patterns.test.ts test/fixtures/source/
git commit -m "$(cat <<'EOF'
fix(patterns): CalcSums in a loop got CalcFields advice that does nothing

detectCalcFieldsInLoop covers both CalcFields and CalcSums, but the suggestion
always recommended SetAutoCalcFields — which has no effect on CalcSums. A
CalcSums(Amount) in a loop was told to call a method that does nothing for it:
the same confident-but-non-actionable advice the calcfields-in-loop suggestion
fix removed, in a sibling case.

The suggestion builder now takes op.type and, for CalcSums, recommends hoisting
the aggregate onto a filtered set outside the loop or backing it with a SIFT key.

Claude-Session: https://claude.ai/code/session_016kmkaWAj6JRobrX1hKkdXM
EOF
)"
```

---

### Task 3: `table-view` parent key collides across object types

**Files:**
- Modify: `src/core/table-view.ts:57` (the parent-ref key)
- Test: `test/core/table-view.test.ts`

**Interfaces:**
- No signature change. Behavior only: `callSiteCount` becomes correct when two distinct parents share an object id.

**Background.** `src/core/table-view.ts:57` builds a call-site key from the parent frame:

```typescript
const parentRef = `${node.parent.callFrame.functionName}:${node.parent.applicationDefinition.objectId}`;
entry.callSites.add(parentRef);
```

**No object type in the key** — the same collision Task 5 of the detector-audit branch fixed in `patterns.ts`, still live here. Two distinct parents (Codeunit 50000 `Run` and Table 50000 `Run`) collapse into one `callSites` entry, **under-reporting `callSiteCount`** (`table-view.ts:114`).

This is **display-only** — `callSiteCount` feeds the terminal/markdown/html table breakdowns and nothing else: no detector, no fingerprint, no gate. So it is a small fix, but it is the same bug the branch already fixed once, and `grep -rn 'functionName}:\${' src/` is non-empty because of it.

The repo's correct convention is `functionName_objectType_objectId` (`aggregateByMethod`, `src/core/aggregator.ts:63`). Match it.

- [ ] **Step 1: Write the failing test**

Add to `test/core/table-view.test.ts`, using the fixture/profile helper that file already uses to build a `ProcessedProfile`. Build two parent frames that share `objectId` but differ in `objectType`, both calling the same child, and assert the child's `callSiteCount` is 2, not 1.

```typescript
describe("table-view callSiteCount — parents sharing an object id", () => {
	it("counts a Codeunit 50000 parent and a Table 50000 parent as two call sites", () => {
		// Same function name, same objectId, different objectType — legal in AL.
		// The old key `${functionName}:${objectId}` merged them into one site.
		const profile = makeProfileWithParents([
			{ parent: { functionName: "Run", objectType: "Codeunit", objectId: 50000 }, child: CHILD },
			{ parent: { functionName: "Run", objectType: "Table", objectId: 50000 }, child: CHILD },
		]);

		const view = buildTableView(profile);
		const childRow = view.rows.find((r) => /* the CHILD row */);

		expect(childRow?.callSiteCount).toBe(2);
	});
});
```

Adapt the helper names to whatever `test/core/table-view.test.ts` actually exports/uses — read the file first and mirror its existing profile-construction pattern. If it has no way to set distinct parent frames, extend the helper minimally; do not switch to a real `.alcpuprofile` fixture.

- [ ] **Step 2: Run, confirm it fails**

Run: `AI_DISABLED=1 bun test test/core/table-view.test.ts -t "sharing an object id"`
Expected: FAIL — `callSiteCount` is 1 (the two parents merged).

- [ ] **Step 3: Add the object type to the key**

`src/core/table-view.ts:57`:

```typescript
const parentRef = `${node.parent.callFrame.functionName}_${node.parent.applicationDefinition.objectType}_${node.parent.applicationDefinition.objectId}`;
entry.callSites.add(parentRef);
```

(Use the same `functionName_objectType_objectId` shape as `aggregateByMethod` so the codebase has one convention.)

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/core/table-view.ts test/core/table-view.test.ts
git add src/core/table-view.ts test/core/table-view.test.ts
git commit -m "$(cat <<'EOF'
fix(table-view): parent call-site key omitted object type

The callSites key was `${functionName}:${objectId}` — no object type — so a
Codeunit 50000 parent and a Table 50000 parent (legal: ids are unique only per
type) merged into one call site, under-reporting callSiteCount. Display-only (it
feeds no detector, fingerprint, or gate), but it is the same collision fixed in
patterns.ts, and it now uses the repo's functionName_objectType_objectId key.

Claude-Session: https://claude.ai/code/session_016kmkaWAj6JRobrX1hKkdXM
EOF
)"
```

---

### Task 4: make `PATTERN_DOCS` completeness testable

**Files:**
- Create: `src/types/patterns.ts` addition — an exported `PATTERN_IDS` array (the canonical list of every pattern id the detectors can emit)
- Modify: `src/mcp/server.ts` — key `PATTERN_DOCS` off `PATTERN_IDS` (or add a test that cross-checks them)
- Test: new test asserting every id in `PATTERN_IDS` has a `PATTERN_DOCS` entry

**Interfaces:**
- Produces: `export const PATTERN_IDS: readonly string[]` (or a `PatternId` union) in `src/types/patterns.ts`. Later consumers (fingerprints, docs, sinks) may key off it, but this task only wires the docs check.

**Background.** `DetectedPattern.id` is a plain `string` with **no registry or union type**, and `PATTERN_DOCS` in `src/mcp/server.ts` keys off Title-Case prose headings, not ids. So there is **no way to assert `PATTERN_DOCS` is complete**, and it silently is not: it omits `recursive-call` and `event-chain`, and misfiles `unindexed-filter` under source-correlated when it is source-only. Every new detector on the audit branch had to have its docs entry added by hand, and two tasks were sent back for forgetting.

The fix is a single source of truth for pattern ids plus one test.

- [ ] **Step 1: Enumerate the real ids**

Grep for every literal `id:` a detector emits, across the three detector files:

```bash
grep -rhn 'id: "' src/core/patterns.ts src/source/source-patterns.ts src/source/source-only-patterns.ts
```

Confirm you get exactly 21 distinct ids (remember `detectEventSubscriberIssues` emits two: `event-subscriber-with-loop-ops` and `event-subscriber-with-loops`, or whatever the current pair is — read them, do not assume). Record the exact list.

- [ ] **Step 2: Write the failing test**

Create `test/types/pattern-ids.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { PATTERN_IDS } from "../../src/types/patterns.js";
import { PATTERN_DOCS } from "../../src/mcp/server.js";

describe("PATTERN_IDS is the complete detector vocabulary", () => {
	it("has exactly the 21 ids the detectors emit", () => {
		expect(new Set(PATTERN_IDS).size).toBe(21);
	});

	it("every PATTERN_IDS entry has a PATTERN_DOCS section", () => {
		const missing = PATTERN_IDS.filter((id) => !patternDocHas(id));
		expect(missing).toEqual([]);
	});
});
```

You will need a way to check `PATTERN_DOCS` for an id. If `PATTERN_DOCS` is keyed by prose heading, add a small exported helper `patternDocHas(id: string): boolean` in `src/mcp/server.ts` that maps ids → sections (or, better, re-key `PATTERN_DOCS` by id — see Step 4). Import whatever you expose. **Do not** hand-maintain a second id→heading map in the test; that recreates the drift this task removes.

- [ ] **Step 3: Run, confirm it fails**

Run: `AI_DISABLED=1 bun test test/types/pattern-ids.test.ts`
Expected: FAIL — `PATTERN_IDS` does not exist yet; once it does, the completeness test fails on `recursive-call`, `event-chain`, and any other gap.

- [ ] **Step 4: Add `PATTERN_IDS` and close the docs gaps**

In `src/types/patterns.ts`:

```typescript
/**
 * The canonical set of every pattern id the detectors can emit. Single source
 * of truth: fingerprints, docs, and any id-keyed surface should reference this
 * rather than re-listing ids. Keep in lockstep with the detector `id:` literals
 * in patterns.ts / source-patterns.ts / source-only-patterns.ts — the test in
 * test/types/pattern-ids.test.ts fails if they drift.
 */
export const PATTERN_IDS = [
	// profile-only (7)
	"single-method-dominance",
	"high-hit-count",
	"deep-call-stack",
	"repeated-siblings",
	"event-subscriber-hotspot",
	"recursive-call",
	"event-chain",
	// source-correlated (7)
	"calcfields-in-loop",
	"modify-in-loop",
	"insert-in-loop",
	"delete-in-loop",
	"record-op-in-loop",
	"missing-setloadfields",
	"incomplete-setloadfields",
	// source-only (7)
	"nested-loops",
	"unfiltered-findset",
	"event-subscriber-with-loop-ops",
	"event-subscriber-with-loops",
	"dangerous-call-in-loop",
	"external-call-in-loop",
	"unindexed-filter",
] as const;
```

**Reconcile this list against Step 1's grep output** — if any id differs (spelling, a pair you misremembered), the grep is truth; fix the array.

Then make `PATTERN_DOCS` provably cover it: add the missing sections (`recursive-call`, `event-chain`, and any others the test reports), correct the `unindexed-filter` misfiling, and expose whatever `patternDocHas` needs. Prefer re-keying `PATTERN_DOCS` by pattern id if that is a contained change; if it is large, keep the prose structure and add an explicit `id → section` map *inside* `server.ts` next to `PATTERN_DOCS` (one map, one place, covered by the test) rather than in the test file.

- [ ] **Step 5: Run, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/types/patterns.ts src/mcp/server.ts test/types/pattern-ids.test.ts
git add src/types/patterns.ts src/mcp/server.ts test/types/pattern-ids.test.ts
git commit -m "$(cat <<'EOF'
feat(types): PATTERN_IDS registry + PATTERN_DOCS completeness test

DetectedPattern.id was a bare string with no registry, and PATTERN_DOCS keyed off
prose headings, so nothing could assert the docs were complete — and they were
not (missing recursive-call and event-chain, unindexed-filter misfiled). Every
new detector needed a hand-added docs entry and two branch tasks were sent back
for forgetting.

Adds PATTERN_IDS as the single source of truth and a test asserting every id has
a PATTERN_DOCS section, closing the whole drift class.

Claude-Session: https://claude.ai/code/session_016kmkaWAj6JRobrX1hKkdXM
EOF
)"
```

---

## Not in this plan

These four follow-ups are real but are **not ready to code** — each needs its own brainstorm, spec, or debugging pass first. Do not fold them into a task here; a bite-sized plan for work whose shape isn't decided would be placeholders.

- **Object-level global variables are invisible to type-gated detectors.** `extractVariables` (`src/source/indexer.ts`) reads only a member's own `var_section`, so a global `HttpClient` is invisible to `external-call-in-loop`, and `isKnownNonRecordOp` fails open on globals. The right fix is an **audit of every declared-type consumer** (this detector, `unindexed-filter`, and any future type-gated one), not a one-detector patch — its blast radius is why it was deferred. Needs a brainstorm to scope the audit and decide whether `extractVariables` grows an object-scope pass.

- **`aggregateByMethod` runs twice per analysis** (`analyzer.ts:209` for the breakdown, `patterns.ts` inside `runDetectors`). It is the heaviest aggregation in the codebase, doubled; it matters at `config.irJson.maxInvocations` = 500,000 × batch. The fix — pass the already-computed `MethodBreakdown[]` into the detectors — is a **`PatternDetector` signature change** that ripples across every detector. Needs a spec (new signature, migration of all detectors, how source-only detectors that take no profile fit).

- **The `analyze-source` spawn flake.** `test/cli/commands/analyze-source.test.ts` makes four `Bun.spawn` calls, each cold-compiling `tree-sitter-al.wasm`; under parallel load a different subtest times out each run. This is a **systematic-debugging** task, not a planning one — confirm the cold-compile hypothesis, then choose a fix (share a warmed parser, serialize those tests, or raise the spawn timeout). Use `superpowers:systematic-debugging`.

- **MCP's flat `findings` array can't reach `missing-setloadfields` / `incomplete-setloadfields`.** The MCP `analyze_source` producer was patched, not fully replaced, during the audit branch, and its flat output shape is (per the branch notes) **incompatible with full replacement** by the real detectors. Whether to reshape the MCP response or route it differently is a **design decision** — brainstorm it before coding.

## Self-Review

**Spec coverage.** The four ready follow-ups each have a task: source-type collision → 1; CalcSums advice → 2; table-view key → 3; PATTERN_DOCS untestable → 4. The four not-ready follow-ups are enumerated under "Not in this plan" with the reason each is deferred.

**No placeholders.** Every code step carries real code. The two places that say "adapt to the file's existing helper" (Task 2's fixture, Task 3's profile builder) name the exact file to read and the exact shape to mirror, because those helpers already exist and must not be re-invented — that is a direction, not a placeholder.

**Type consistency.** `canonicalObjectType(s: string): string` (Task 1) is used exactly as `src/semantic/identity.ts:124` declares it. `calcFieldsSuggestion(opType, severity, resolved)` (Task 2) matches its single call site. `PATTERN_IDS` (Task 4) is `readonly` and consumed by the completeness test only. No task references a symbol another task was supposed to create — the four are independent.

**Known soft spots**, each carrying a verify-don't-trust instruction:
- Task 1 Step 4: the old steps 2/3 may become dead code. Remove only if the suite stays green; otherwise leave them.
- Task 2 Step 3: `op.type`'s union may need a narrowing cast at the call site — the filter at `:227` guarantees it, so the cast is sound.
- Task 4 Step 4: the id list must be reconciled against the Step 1 grep — the grep is truth, the array in this plan is a starting point.
