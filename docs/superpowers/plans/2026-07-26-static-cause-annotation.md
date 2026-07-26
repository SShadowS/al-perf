# Static Cause Annotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `--source` is available, a profile-only finding names the source-correlated findings that share its routine — or, when that routine was provably read and nothing was raised, says so in scoped language.

**Architecture:** A post-pass over the assembled `patterns` array in `analyzeProfile`, mirroring the existing `annotateEstimatedSavings`. It appends to `suggestion` only. It performs no analysis: it restates findings other detectors already produced, joined by the `involvedMethods[0]` anchor string. A new strict resolver, `matchExactToSource`, backs the one negative claim the pass can make.

**Tech Stack:** TypeScript on Bun, `bun:test`, biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-26-static-cause-annotation-design.md`

## Global Constraints

- **Never write `involvedMethods`.** It is the finding-lifecycle fingerprint anchor. This feature reads it only. Changing one byte severs stored finding identity.
- **Never change `estimatedSavings`, `savingsExplanation`, `severity`, `impact`, `id`, `title`, `description` or `evidence`.** `suggestion` is the only mutated field.
- **Without a `SourceIndex`, output must be byte-identical to today.**
- **Every fence must be mutation-tested:** delete it, confirm a test fails on an assertion encoding the behaviour, restore byte-identical. A green suite after deleting a guard means the test is measuring nothing. This is the most repeated defect in this codebase.
- **Cite code by symbol, not line number,** in comments and docs. Line citations in the spec were stale one commit after being written.
- **Pattern ids in user-facing text are written bare, never in backticks.** `suggestion` is plain text in the terminal formatter and HTML-escaped in the HTML one, so markdown syntax reaches the user as literal punctuation.
- Run `bun run verify` (biome + tsc + tests) before every commit.

## File Structure

| File | Responsibility |
|---|---|
| `src/source/locator.ts` (modify) | Add `matchExactToSource` — canonical type+id match only, no recall fallbacks. |
| `src/core/annotate-cause.ts` (create) | The post-pass: `annotateStaticCause`, the profile-only id set, and the two annotation sentences. |
| `src/core/analyzer.ts` (modify) | One call, immediately before `annotateEstimatedSavings(patterns)`. |
| `test/source/locator.test.ts` (modify) | Strict-resolver tests, including the case `matchAllToSource` deliberately answers and `matchExactToSource` must not. |
| `test/core/annotate-cause.test.ts` (create) | The pass's behaviour and all three fences. |

---

### Task 1: `matchExactToSource` — a resolver that refuses to guess

**Files:**
- Modify: `src/source/locator.ts`
- Test: `test/source/locator.test.ts`

**Interfaces:**
- Consumes: `SourceMatch` (`= ProcedureInfo | TriggerInfo`), `canonicalObjectType` from `../semantic/identity.js` — both already imported in this file.
- Produces: `export function matchExactToSource(functionName: string, objectType: string, objectId: number, index: SourceIndex): SourceMatch[]`

**Why this exists:** `matchAllToSource` has two fallbacks after its canonical step. Step 3 returns a lone candidate *regardless of `objectId`* — a same-named routine in a different object. That recall is correct for callers wanting a probable source location. It is wrong for a caller asking "did we definitely read THIS routine", because the answer feeds a negative claim.

- [ ] **Step 1: Write the failing tests**

Append to `test/source/locator.test.ts`. That file already has `makeProcedure(overrides)` and `makeIndex(procs, trigs?)` helpers and builds synthetic indexes rather than calling `buildSourceIndex` — follow that pattern; these tests need three routines, not a 49-file fixture build. Add `matchExactToSource` to the existing `import { matchAllToSource, matchToSource } from "../../src/source/locator.js";`.

```typescript
describe("matchExactToSource", () => {
	// ProcessRecords exists once, in Codeunit 50100. LookupRecords shares that
	// id under a different TYPE — the pair that separates an id-only rule from
	// a type+id one.
	const index = makeIndex([
		makeProcedure({ name: "ProcessRecords", objectType: "Codeunit", objectId: 50100 }),
		makeProcedure({ name: "LookupRecords", objectType: "Table", objectId: 50100 }),
	]);

	it("resolves a routine when type and id both match", () => {
		const m = matchExactToSource("ProcessRecords", "Codeunit", 50100, index);
		expect(m.length).toBe(1);
		expect(m[0].objectId).toBe(50100);
	});

	it("tolerates the profile's object-type casing", () => {
		// Profiles say "CodeUnit"; the index says "Codeunit". Without
		// canonicalObjectType this fence rejects every real match, and the
		// feature depending on it goes permanently silent while looking like it
		// works.
		expect(matchExactToSource("ProcessRecords", "CodeUnit", 50100, index).length).toBe(1);
	});

	it("refuses a name-only match that matchAllToSource accepts", () => {
		// Asked about Codeunit 99999, matchAllToSource falls through to its
		// step-3 single-candidate rule and returns the WRONG object's routine.
		// Verified against the real fixture index too, not just this synthetic
		// one. matchExactToSource must return nothing: that is why it exists.
		expect(matchAllToSource("ProcessRecords", "Codeunit", 99999, index).length).toBe(1);
		expect(matchExactToSource("ProcessRecords", "Codeunit", 99999, index).length).toBe(0);
	});

	it("refuses a right-id, wrong-type match", () => {
		expect(matchAllToSource("LookupRecords", "Codeunit", 50100, index).length).toBe(1);
		expect(matchExactToSource("LookupRecords", "Codeunit", 50100, index).length).toBe(0);
	});

	it("returns nothing for an unknown name", () => {
		expect(matchExactToSource("NoSuchRoutineAnywhere", "Codeunit", 50100, index).length).toBe(0);
	});
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test test/source/locator.test.ts -t "matchExactToSource"`
Expected: FAIL — `matchExactToSource is not a function` (or a TypeScript import error).

- [ ] **Step 3: Implement**

Add to `src/source/locator.ts`, directly beneath `matchAllToSource`:

```typescript
/**
 * Resolve a routine ONLY when the object type and id both match — no
 * fallbacks.
 *
 * `matchAllToSource` is recall-oriented: after its canonical step it falls back
 * to id-only, then to a single candidate regardless of `objectId`. Those steps
 * are right for callers that want a probable source location for a hotspot.
 *
 * They are wrong for a caller whose next move is a NEGATIVE claim — "nothing
 * was found in this routine" — because a step-3 answer can be a same-named
 * routine in an entirely different object, and the claim would then describe
 * code the profile never measured. Anything asserting coverage must use this
 * function; anything merely locating source should keep using
 * `matchAllToSource`.
 */
export function matchExactToSource(
	functionName: string,
	objectType: string,
	objectId: number,
	index: SourceIndex,
): SourceMatch[] {
	const nameLower = functionName.toLowerCase();
	const candidates: SourceMatch[] = [
		...(index.procedures.get(nameLower) ?? []),
		...(index.triggers.get(nameLower) ?? []),
	];
	const wantType = canonicalObjectType(objectType);
	return candidates.filter(
		(c) =>
			c.objectId === objectId && canonicalObjectType(c.objectType) === wantType,
	);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test test/source/locator.test.ts -t "matchExactToSource"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-test the strictness**

Temporarily replace the `return candidates.filter(...)` body with `return matchAllToSource(functionName, objectType, objectId, index);`, then run the same command.
Expected: the "refuses a name-only match" and "refuses a right-id, wrong-type match" tests FAIL.
Restore the file byte-identical and re-run to confirm PASS. If either test still passes under the mutation, the test is not measuring the fence — fix the test before continuing.

- [ ] **Step 6: Verify and commit**

```bash
bun run verify
git add src/source/locator.ts test/source/locator.test.ts
git commit -m "feat(locator): add matchExactToSource, a resolver that refuses to guess

matchAllToSource falls back to id-only and then to a lone candidate regardless
of objectId. That recall is right for locating a hotspot's source and wrong for
answering \"did we definitely read this routine\", where the answer feeds a
negative claim about coverage.

Mutation-checked: swapping the body for matchAllToSource fails the two refusal
tests."
```

---

### Task 2: the annotation pass

**Files:**
- Create: `src/core/annotate-cause.ts`
- Test: `test/core/annotate-cause.test.ts`

**Interfaces:**
- Consumes: `matchExactToSource` from Task 1; `formatMethodBreakdownRef` from `./method-ref.js`; types `DetectedPattern` (`../types/patterns.js`), `MethodBreakdown` (`../types/aggregated.js`), `SourceIndex` (`../types/source-index.js`).
- Produces: `export function annotateStaticCause(patterns: DetectedPattern[], methods: MethodBreakdown[], sourceIndex?: SourceIndex): void` and `export const PROFILE_ONLY_PATTERN_IDS: ReadonlySet<string>`.

**Behaviour, exactly:**

| routine resolves exactly | `involvedMethods.length` | siblings | appended |
|---|---|---|---|
| yes or no | any | ≥ 1 | `Static analysis also flagged <ids> on this routine.` |
| yes | 1 | 0 | `No loop or SetLoadFields findings were raised for this routine, so its cost is more likely computational than per-row I/O.` |
| yes | > 1 | 0 | nothing |
| no | any | 0 | nothing |

- [ ] **Step 1: Write the failing tests**

Create `test/core/annotate-cause.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
	annotateStaticCause,
	PROFILE_ONLY_PATTERN_IDS,
} from "../../src/core/annotate-cause.js";
import { buildSourceIndex } from "../../src/source/indexer.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const INDEX = await buildSourceIndex("test/fixtures/source");

function method(
	functionName: string,
	objectType: string,
	objectId: number,
): MethodBreakdown {
	return {
		functionName,
		objectType,
		objectId,
		objectName: "Fixture",
		appName: "Fixture App",
		selfTime: 1000,
		totalTime: 2000,
		selfTimePercent: 10,
		totalTimePercent: 20,
		hitCount: 1,
		callSites: 1,
		calledBy: [],
	} as unknown as MethodBreakdown;
}

function pattern(
	id: string,
	involvedMethods: string[],
	suggestion = "BASE.",
): DetectedPattern {
	return {
		id,
		severity: "warning",
		title: `${id} title`,
		description: "d",
		impact: 1000,
		involvedMethods,
		evidence: "e",
		suggestion,
	};
}

const PROCESS = "ProcessRecords (Codeunit 50100)";
const SIMPLE = "SimpleMethod (Codeunit 50100)";

describe("annotateStaticCause", () => {
	test("names a source-correlated sibling on the same routine", () => {
		const p = [
			pattern("single-method-dominance", [PROCESS]),
			pattern("modify-in-loop", [PROCESS]),
		];
		annotateStaticCause(p, [method("ProcessRecords", "Codeunit", 50100)], INDEX);
		expect(p[0].suggestion).toContain("modify-in-loop");
		expect(p[0].suggestion).toStartWith("BASE.");
	});

	test("claims no loop findings only in scoped language", () => {
		// The unscoped phrasing would be false whenever the routine's real
		// problem is a source-ONLY pattern -- unfiltered-findset,
		// dangerous-call-in-loop -- which analyzeProfile never runs.
		const p = [pattern("single-method-dominance", [SIMPLE])];
		annotateStaticCause(p, [method("SimpleMethod", "Codeunit", 50100)], INDEX);
		expect(p[0].suggestion).toContain("No loop or SetLoadFields findings");
		expect(p[0].suggestion).not.toContain("No database anti-patterns");
	});

	test("says nothing when the routine does not resolve exactly", () => {
		const anchor = "ProcessRecords (Codeunit 99999)";
		const p = [pattern("single-method-dominance", [anchor])];
		annotateStaticCause(p, [method("ProcessRecords", "Codeunit", 99999)], INDEX);
		expect(p[0].suggestion).toBe("BASE.");
	});

	test("says nothing about a multi-routine finding", () => {
		const p = [pattern("deep-call-stack", [PROCESS, SIMPLE])];
		annotateStaticCause(
			p,
			[
				method("ProcessRecords", "Codeunit", 50100),
				method("SimpleMethod", "Codeunit", 50100),
			],
			INDEX,
		);
		expect(p[0].suggestion).toBe("BASE.");
	});

	test("still names siblings for a multi-routine finding", () => {
		const p = [
			pattern("deep-call-stack", [PROCESS, SIMPLE]),
			pattern("modify-in-loop", [PROCESS]),
		];
		annotateStaticCause(p, [method("ProcessRecords", "Codeunit", 50100)], INDEX);
		expect(p[0].suggestion).toContain("modify-in-loop");
	});

	test("never annotates a source-correlated pattern", () => {
		const p = [
			pattern("modify-in-loop", [PROCESS]),
			pattern("calcfields-in-loop", [PROCESS]),
		];
		annotateStaticCause(p, [method("ProcessRecords", "Codeunit", 50100)], INDEX);
		expect(p[0].suggestion).toBe("BASE.");
		expect(p[1].suggestion).toBe("BASE.");
	});

	test("is a no-op without a source index", () => {
		const p = [
			pattern("single-method-dominance", [PROCESS]),
			pattern("modify-in-loop", [PROCESS]),
		];
		annotateStaticCause(p, [method("ProcessRecords", "Codeunit", 50100)], undefined);
		expect(p[0].suggestion).toBe("BASE.");
	});

	test("never writes involvedMethods", () => {
		const before = [PROCESS];
		const p = [pattern("single-method-dominance", before)];
		annotateStaticCause(p, [method("ProcessRecords", "Codeunit", 50100)], INDEX);
		expect(p[0].involvedMethods).toEqual([PROCESS]);
	});

	test("ignores a pattern with no involvedMethods", () => {
		const p = [pattern("single-method-dominance", [])];
		annotateStaticCause(p, [], INDEX);
		expect(p[0].suggestion).toBe("BASE.");
	});

	test("writes pattern ids bare, without backticks", () => {
		// suggestion is plain text in the terminal formatter and HTML-escaped in
		// the HTML one, so backticks would reach the user as punctuation.
		const p = [
			pattern("single-method-dominance", [PROCESS]),
			pattern("modify-in-loop", [PROCESS]),
		];
		annotateStaticCause(p, [method("ProcessRecords", "Codeunit", 50100)], INDEX);
		expect(p[0].suggestion).not.toContain("`");
	});

	test("the profile-only id set matches the detector registry", () => {
		expect([...PROFILE_ONLY_PATTERN_IDS].sort()).toEqual([
			"deep-call-stack",
			"event-chain",
			"event-subscriber-hotspot",
			"high-hit-count",
			"recursive-call",
			"repeated-siblings",
			"single-method-dominance",
		]);
	});
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test test/core/annotate-cause.test.ts`
Expected: FAIL — cannot resolve `../../src/core/annotate-cause.js`.

- [ ] **Step 3: Implement**

Create `src/core/annotate-cause.ts`:

```typescript
import { matchExactToSource } from "../source/locator.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import type { SourceIndex } from "../types/source-index.js";
import { formatMethodBreakdownRef } from "./method-ref.js";

/**
 * Detectors that fire from a profile alone. They know a method name, a time and
 * a hit count, and nothing about what the code does — which is why their advice
 * cannot be specific without help, and why they are the only patterns this pass
 * annotates.
 *
 * Kept in sync with `allDetectors` in patterns.ts by a test; an id added there
 * and not here would let a profile-only finding cite itself as its own cause.
 */
export const PROFILE_ONLY_PATTERN_IDS: ReadonlySet<string> = new Set([
	"single-method-dominance",
	"high-hit-count",
	"deep-call-stack",
	"repeated-siblings",
	"event-subscriber-hotspot",
	"recursive-call",
	"event-chain",
]);

/**
 * Append what static analysis knows about a profile-only finding's routine.
 *
 * Restates findings other detectors already produced — it analyses nothing, so
 * it cannot contradict them. The join is the `involvedMethods[0]` anchor, which
 * every detector builds through `formatMethodBreakdownRef`.
 *
 * The negative claim ("no loop findings here") is fenced three ways, because it
 * is the only output here that can be a confident falsehood:
 *
 *  1. the routine must resolve on type AND id (`matchExactToSource`, never
 *     `matchAllToSource`, whose fallbacks can answer about a different object);
 *  2. the finding must name exactly one routine — `deep-call-stack` and
 *     `event-subscriber-hotspot` carry several, so `[0]` is arbitrary for them;
 *  3. the wording names only what `analyzeProfile` actually runs. The
 *     source-ONLY family (unfiltered-findset, dangerous-call-in-loop,
 *     external-call-in-loop, nested-loops, unindexed-filter) never runs in this
 *     path, so "no database anti-patterns" would be false exactly when a
 *     routine's real problem is one of those.
 *
 * Mutates `suggestion` only. `involvedMethods` is the lifecycle fingerprint
 * anchor and is read, never written.
 */
export function annotateStaticCause(
	patterns: DetectedPattern[],
	methods: MethodBreakdown[],
	sourceIndex?: SourceIndex,
): void {
	if (!sourceIndex) return;

	const siblingsByAnchor = new Map<string, string[]>();
	for (const p of patterns) {
		if (PROFILE_ONLY_PATTERN_IDS.has(p.id)) continue;
		for (const anchor of p.involvedMethods) {
			const list = siblingsByAnchor.get(anchor) ?? [];
			if (!list.includes(p.id)) list.push(p.id);
			siblingsByAnchor.set(anchor, list);
		}
	}

	for (const p of patterns) {
		if (!PROFILE_ONLY_PATTERN_IDS.has(p.id)) continue;
		if (!p.suggestion) continue;

		const siblings = new Set<string>();
		for (const anchor of p.involvedMethods) {
			for (const id of siblingsByAnchor.get(anchor) ?? []) siblings.add(id);
		}

		if (siblings.size > 0) {
			p.suggestion = `${p.suggestion} Static analysis also flagged ${[...siblings].join(", ")} on this routine.`;
			continue;
		}

		// Negative claim from here down — every fence applies.
		if (p.involvedMethods.length !== 1) continue;
		const anchor = p.involvedMethods[0];
		const m = methods.find((x) => formatMethodBreakdownRef(x) === anchor);
		if (!m) continue;
		const exact = matchExactToSource(
			m.functionName,
			m.objectType,
			m.objectId,
			sourceIndex,
		);
		if (exact.length === 0) continue;

		p.suggestion = `${p.suggestion} No loop or SetLoadFields findings were raised for this routine, so its cost is more likely computational than per-row I/O.`;
	}
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test test/core/annotate-cause.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Mutation-test all three fences**

Run `bun test test/core/annotate-cause.test.ts` after each mutation; restore byte-identical after each.

| mutation | test that must fail |
|---|---|
| `matchExactToSource` → `matchAllToSource` | "says nothing when the routine does not resolve exactly" |
| delete `if (p.involvedMethods.length !== 1) continue;` | "says nothing about a multi-routine finding" |
| delete `if (!sourceIndex) return;` | "is a no-op without a source index" |
| delete `if (PROFILE_ONLY_PATTERN_IDS.has(p.id)) continue;` in the sibling loop | "never annotates a source-correlated pattern" |

If any mutation leaves the suite green, that fence is untested — fix the test before continuing.

- [ ] **Step 6: Verify and commit**

```bash
bun run verify
git add src/core/annotate-cause.ts test/core/annotate-cause.test.ts
git commit -m "feat(annotate-cause): name a profile-only finding's static cause

A profile-only detector knows a method name and a time. When --source is
available a source-correlated detector has often already flagged the actual
problem inside that same routine, and the two facts were never joined.

The negative claim is fenced three ways -- exact type+id resolution,
single-routine findings only, and wording scoped to the detector families that
actually run in analyzeProfile. All three mutation-checked."
```

---

### Task 3: wire it into `analyzeProfile`

**Files:**
- Modify: `src/core/analyzer.ts`
- Test: `test/core/annotate-cause.test.ts` (append the integration test)

**Interfaces:**
- Consumes: `annotateStaticCause` from Task 2.
- Produces: nothing new; `analyzeProfile`'s existing return shape is unchanged.

- [ ] **Step 1: Write the failing integration test**

Append to `test/core/annotate-cause.test.ts`. Add `import { analyzeProfile } from "../../src/core/analyzer.js";` to the imports.

```typescript
describe("annotateStaticCause wired into analyzeProfile", () => {
	test("a profile-only finding is unannotated without --source", async () => {
		const result = await analyzeProfile(
			"test/fixtures/sampling-minimal.alcpuprofile",
		);
		for (const p of result.patterns) {
			expect(p.suggestion ?? "").not.toContain("Static analysis also flagged");
			expect(p.suggestion ?? "").not.toContain("No loop or SetLoadFields");
		}
	});
});
```

- [ ] **Step 2: Run it and confirm it passes already**

Run: `bun test test/core/annotate-cause.test.ts -t "wired into analyzeProfile"`
Expected: PASS. This is a regression guard, not a red test — it pins that the no-source path stays byte-identical once the call is added in Step 3.

- [ ] **Step 3: Add the call**

In `src/core/analyzer.ts`, find:

```typescript
	// Annotate patterns with estimated savings
	annotateEstimatedSavings(patterns);
```

Replace with:

```typescript
	// Name each profile-only finding's static cause, where source can supply
	// one. Runs before the savings annotator only for readability; the two are
	// independent. `methods` is `aggregateByMethod(processed)` from above.
	annotateStaticCause(patterns, methods, sourceIndex);

	// Annotate patterns with estimated savings
	annotateEstimatedSavings(patterns);
```

Add the import beside the existing `annotateEstimatedSavings` import:

```typescript
import { annotateStaticCause } from "./annotate-cause.js";
```

`sourceIndex` is the correct in-scope name — `analyzeProfile` declares `let sourceIndex: SourceIndex | undefined = options?.sourceIndex;` near the top and populates it from `options.sourcePath` well before this point, in the same block that produces `sourcePatterns`. It is legitimately `undefined` on a profile-only run, which is why the parameter is optional.

- [ ] **Step 4: Run the full suite**

Run: `bun run verify`
Expected: PASS, 0 fail. Any formatter snapshot that now contains an appended sentence is a real behaviour change — read it and confirm it is the intended annotation before updating the expectation.

- [ ] **Step 5: Commit**

```bash
git add src/core/annotate-cause.ts src/core/analyzer.ts test/core/annotate-cause.test.ts
git commit -m "feat(analyzer): run the static-cause pass when source is available

One call before annotateEstimatedSavings, where both detector families'
findings are already in one array. No-source runs stay byte-identical, pinned
by a regression test."
```

---

### Task 4: keep the id set honest, and document the feature

**Files:**
- Modify: `test/core/annotate-cause.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `PROFILE_ONLY_PATTERN_IDS` from Task 2, `runDetectors` from `src/core/patterns.js`.
- Produces: nothing.

**Why:** the id set is duplicated knowledge. `allDetectors` in patterns.ts is the real registry; the set is a copy. A test must fail when they diverge, or a newly added profile-only detector silently becomes its own sibling.

- [ ] **Step 1: Write the failing test**

Append to `test/core/annotate-cause.test.ts`:

```typescript
test("every id emitted by runDetectors is classified profile-only", async () => {
	// The id set is a copy of knowledge that lives in patterns.ts's
	// `allDetectors`. If a new profile-only detector ships without being added
	// to the set, it would be treated as a source-correlated finding and could
	// be cited as its own cause.
	const { parseProfile } = await import("../../src/core/parser.js");
	const { processProfile } = await import("../../src/core/processor.js");
	const { runDetectors } = await import("../../src/core/patterns.js");
	const raw = await parseProfile("test/fixtures/sampling-minimal.alcpuprofile");
	const emitted = new Set(runDetectors(processProfile(raw)).map((p) => p.id));
	for (const id of emitted) {
		expect(PROFILE_ONLY_PATTERN_IDS.has(id)).toBe(true);
	}
});
```

- [ ] **Step 2: Run it**

Run: `bun test test/core/annotate-cause.test.ts -t "classified profile-only"`
Expected: PASS if the set is complete. If it FAILS, the failing id is a real gap — add it to `PROFILE_ONLY_PATTERN_IDS` and re-run.

The two-line setup above matches `test/core/patterns.test.ts`, which builds a processed profile the same way: `await parseProfile(path)` then `processProfile(parsed)`. Neither takes further arguments.

- [ ] **Step 3: Document the feature**

In `CLAUDE.md`, in the `### Pattern Detection` section, immediately after the paragraph beginning "That last line is load-bearing", add:

```markdown
When `--source` is available, `annotateStaticCause` (`src/core/annotate-cause.ts`) appends to each profile-only finding's `suggestion` either the source-correlated findings sharing its routine, or — fenced — a scoped statement that none were raised. The fences exist because the negative claim is the only output here that can be a confident falsehood: the routine must resolve on type AND id (`matchExactToSource`, never `matchAllToSource`, whose fallbacks can answer about a different object), the finding must name exactly one routine (`deep-call-stack` and `event-subscriber-hotspot` name several), and the wording says "loop or SetLoadFields findings" rather than "database anti-patterns" because the source-only family never runs in this path.
```

- [ ] **Step 4: Verify and commit**

```bash
bun run verify
git add test/core/annotate-cause.test.ts CLAUDE.md
git commit -m "test(annotate-cause): pin the id set to the detector registry

The profile-only id set copies knowledge that lives in patterns.ts. A detector
added there and not here would be treated as source-correlated and could be
cited as its own cause."
```

---

## Verification

After all four tasks:

```bash
bun run verify
bun run src/cli/index.ts analyze test/fixtures/sampling-minimal.alcpuprofile --source test/fixtures/source
```

Expect at least one profile-only finding whose suggestion carries an appended sentence. If none does, that is a legitimate outcome for this fixture — confirm by checking whether any profile-only finding's routine resolves via `matchExactToSource` — but it means the feature is unexercised end to end, and Task 3's integration coverage rests on the unit tests alone.
