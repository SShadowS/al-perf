# Static Cause Annotation — Design

**Date:** 2026-07-26
**Status:** design, approved in conversation; pending written review
**Scope:** one project. Makes the seven profile-only detectors' suggestions name what is actually in the routine they flag, by cross-referencing findings the source-correlated detectors already produced.

## Goal

A profile-only detector knows a method name, a time and a hit count. It knows nothing about what the code does, so its advice cannot be more specific than "investigate this method for tight computation loops or excessive calls". That is not something a reader can act on, and it is why these detectors' savings multipliers have never been checkable.

When `--source` is available, the tool usually *does* know what is in that routine — a source-correlated detector may already have flagged a `Modify` in a loop inside the very method the profile says is dominant. The two facts are produced metres apart and never joined.

This design joins them: a profile-only finding names the source findings that share its routine, or — when the routine was demonstrably read and nothing was found — says that instead.

## Non-goals

- **No savings multiplier changes.** Better prose does not make "optimize the dominant method" a measurable edit. All six unmeasured models keep their `Rough estimate (not measured)` label. This makes advice actionable; it does not make a number checkable.
- **No new detection.** The pass invents no findings and suppresses none. It only restates findings other detectors already emitted.
- **No fusion dependency.** `fusionViews` joins runtime routines to al-sem static findings already, but is gated on an al-sem workspace. This works on plain `--source`.

**Citation convention:** code is cited by symbol, not by line number, except where a line is the whole point (`locator.ts:65`). Two line citations in the first draft of this spec were already stale one commit after being written.

## Architecture

One new module, one call site.

```
src/core/annotate-cause.ts
  export function annotateStaticCause(
    patterns: DetectedPattern[],
    methods: MethodBreakdown[],
    sourceIndex?: SourceIndex,
  ): void
```

Called from `src/core/analyzer.ts` immediately before the existing `annotateEstimatedSavings(patterns)` (currently line 317), where every pattern from both detector sets is already in one array and `methods` (line 263) is in scope. It mutates `suggestion` in place, mirroring how `annotateEstimatedSavings` mutates `estimatedSavings`.

`PatternDetector` is `(profile) => DetectedPattern[]` and never receives a `SourceIndex`. A post-pass avoids changing that type and all seven implementations. It is also the only place where findings from *both* detector families coexist, which is precisely what the join needs.

Without `sourceIndex` the function returns immediately, so profile-only runs are byte-identical to today.

A second argument for the post-pass: `high-hit-count` is emitted from **two** sites in `patterns.ts` (the sampling path and the exact-count ir-json path). Annotating the assembled array covers both for free, where editing detectors would have to touch each — and would silently cover only one if the second were missed.

## The join

All `involvedMethods` anchors render `Name (Type Id)` through a single helper, `formatMethodBreakdownRef` (`src/core/method-ref.ts`), so the strings are directly comparable with `===`.

That is true as of `d0705af` and was NOT true when this spec was first written. A review found the earlier claim false, and checking it turned up **five** builders of that format — `formatMethodRef` (patterns.ts), `formatMethodBreakdownRef`, `methodLabel` (source-patterns.ts), an inline literal in `telemetry-parser.ts` (`buildSinglePattern`), and the display-only `displayMethodRef`. Four fed `involvedMethods`. They agreed by convention, not by construction. All now delegate to the one helper, pinned by `test/core/method-ref.test.ts`.

The implementer should not re-derive this: if a new anchor builder appears, the join degrades silently to "no siblings found", which looks exactly like a routine with no findings.

Two lookups, both by string equality — no parsing:

1. **Sibling findings.** Group all patterns by `involvedMethods[0]`. For a profile-only pattern, its siblings are the other patterns sharing that string, minus itself and minus other profile-only patterns. "Profile-only" is decided by a hardcoded `Set<string>` of the seven ids listed under Scope, exported from the new module so a test can assert it matches the detector registry — an id added to `allDetectors` without being added here would silently annotate a profile-only finding with itself.
2. **The routine's `MethodBreakdown`.** Scan `methods` for the first `m` where `formatMethodBreakdownRef(m) === pattern.involvedMethods[0]`, exactly as `semantic/corroborate.ts` already does. This yields `functionName` / `objectType` / `objectId` for the index lookup.

`involvedMethods[0]` is the finding-lifecycle fingerprint anchor. This pass **reads** it and must never write it.

Not every anchor is a routine. On a sampling capture a SQL statement node is a call-tree node like any other, so `high-hit-count`'s anchor can be a thousand characters of raw SQL rather than a method name. Nothing special is needed: such an anchor matches no `MethodBreakdown` and resolves to no member, so both lookups return nothing and the pass stays silent. It is recorded here so the implementer recognises the case rather than treating it as a bug.

Parsing the anchor string back into its three parts with a regex is rejected: real function names contain quotes, dots and parentheses (`OnAfterPostSalesDoc."Sales Header"`), and a parser that is wrong on one shape silently mis-attributes a finding.

## The fence

Saying "nothing was found here" is a claim about coverage, not about findings, and it is the only part of this design that can produce a confident falsehood. Three conditions must ALL hold before it is made.

### 1. The routine must resolve EXACTLY, on type and id

`matchAllToSource` (`src/source/locator.ts:32`) must NOT be used for this claim. It is a recall-oriented resolver with two fallbacks after its canonical step:

- step 2 returns id-only matches when no candidate's type matched;
- step 3 (`locator.ts:65`) returns a lone candidate **regardless of `objectId`** — a same-named routine in an entirely different object.

Under step 3, "resolves to exactly one member" can be a routine the profile never measured, and the clean sentence would then describe the wrong code with full confidence. Those fallbacks are correct for their existing callers, which want a probable location; they are wrong here, where the question is "did we definitely read THIS routine".

This design adds a strict sibling to `locator.ts`:

```ts
export function matchExactToSource(
  functionName: string,
  objectType: string,
  objectId: number,
  index: SourceIndex,
): SourceMatch[]
```

Its body is `matchAllToSource`'s step 1 alone — candidates from `index.procedures` and `index.triggers` under the lowercased name, filtered to `c.objectId === objectId && canonicalObjectType(c.objectType) === canonicalObjectType(objectType)`. No fallbacks. It returns `[]` where `matchAllToSource` would guess.

Reusing `canonicalObjectType` matters: the profile says `CodeUnit` and the index says `Codeunit`, and a naive `===` on the type would make this fence reject every real match and go permanently silent.

### 2. The finding must be about ONE routine

`involvedMethods` is not always a single anchor, and it is only two of the seven profile-only detectors — `single-method-dominance` and `recursive-call` — that always name exactly one. The other five all build multi-anchor `involvedMethods`: `high-hit-count` names exactly two at both of its emit sites in patterns.ts (`[formatMethodRef(node), formatMethodRef(node.parent)]` in the sampling path, `[formatMethodRef(edge.child), formatMethodRef(edge.parent)]` in the exact-count ir-json path), `repeated-siblings` names exactly two (`[formatMethodRef(node), formatMethodRef(representative)]`), and `event-chain` names its root plus every subscriber beneath it (`chain.chain.map(formatMethodRef)`, always ≥ 2 since a chain with zero members is never reported). `event-subscriber-hotspot` sets it to every aggregated subscriber (`aggregated.map(formatMethodBreakdownRef)` in `detectEventSubscriberHotspot`), and `deep-call-stack` to the deepest nodes in traversal order, up to five (`deepestNodes.slice(0, 5).map(formatMethodRef)`) — both variable-length, so `[0]` is an arbitrary member of a set for them too. For all five, attaching "no anti-patterns were found in **this** routine" to a finding about N routines is a single-routine claim on a multi-routine finding.

So the clean sentence requires `involvedMethods.length === 1`, and — measured, not assumed — that condition can in practice only ever be met by `single-method-dominance` and `recursive-call`; the other five are excluded by construction. Sibling naming does not have this restriction: a sibling finding on any listed routine is a real finding about this finding's subject matter.

### 3. The claim must name what was actually checked

`analyzeProfile` runs `runDetectors` and `runSourceDetectors` and merges both into `patterns`. It never runs `runSourceOnlyDetectors` — so `unfiltered-findset`, `nested-loops`, `unindexed-filter`, `dangerous-call-in-loop` and `external-call-in-loop` are absent from this path entirely (see CLAUDE.md's Pattern Detection section). A routine whose real problem is an unfiltered `FindSet` or a `Commit` in a loop has no finding here.

An unqualified "no database anti-patterns were found in this routine" would therefore be false exactly when it matters most. The sentence names its own scope instead:

> No loop or SetLoadFields findings were raised for this routine.

The sentence ends at that premise. An earlier draft continued "...so its cost is more likely computational than per-row I/O" — an inference the fences above do not cover, since `analyzeProfile` never runs the source-ONLY family (`unfiltered-findset`, `external-call-in-loop`, `dangerous-call-in-loop`, `nested-loops`, `unindexed-filter`). A routine can carry an HTTP call inside a loop, or an unfiltered `FindSet`, with none of that visible to this pass — both are real costs and neither is "computational". The premise (no loop or SetLoadFields finding was raised) is proven by the fences; the inference from it to "therefore computational" was not, and review found it false on real routines. Cut, not reworded.

### Resulting behaviour

| routine resolves exactly | `involvedMethods` | siblings | annotation |
|---|---|---|---|
| yes or no | any | ≥ 1 | name them: `Static analysis also flagged modify-in-loop, calcfields-in-loop on this routine.` |
| yes | exactly 1 | 0 | the scoped sentence above |
| yes | > 1 | 0 | *(silent)* — multi-routine finding |
| no | any | 0 | *(silent)* — not provably this routine |

Siblings are named regardless of exact resolution because those findings exist and were produced by a detector that did resolve the routine; only the *negative* claim needs proof of coverage.

## Output

The annotation is appended to the existing `suggestion` string, separated by a single space, and only when the detector already has one. All seven do — verified individually, though `repeated-siblings`' `suggestion` sits fifteen lines below its `id`, far enough to be missed by a narrow grep.

Pattern ids are written bare, not in backticks: `suggestion` is plain text in the terminal formatter and HTML-escaped in the HTML one, so markdown syntax reaches the user as literal punctuation.

`suggestion` renders in terminal, markdown and HTML today, so this needs no formatter work and adds no surface to the field-parity test. `estimatedSavings`, `savingsExplanation`, `severity`, `impact` and `involvedMethods` are untouched.

## Scope

All seven profile-only detectors, identified by pattern id:

`single-method-dominance`, `high-hit-count`, `deep-call-stack`, `repeated-siblings`, `event-subscriber-hotspot`, `recursive-call`, `event-chain`

Not just the five carrying savings models. But they do NOT all benefit equally, and the spec should not pretend otherwise: `high-hit-count`, `deep-call-stack`, `repeated-siblings`, `event-subscriber-hotspot` and `event-chain` all emit multi-routine `involvedMethods` (see fence 2 above), so by fence 2 they can never receive the clean sentence — they gain sibling naming only. Only `single-method-dominance` and `recursive-call`, which always anchor a single routine, can receive either.

## Error handling

The pass is advisory and must never fail an analysis. A pattern with an empty `involvedMethods`, an anchor matching no `MethodBreakdown`, or a `sourceIndex` whose `procedures` map lacks the name all resolve to "annotate nothing" rather than throwing. There is no partial-failure state to report: an un-annotated finding is exactly today's output.

## Testing

Unit tests in `test/core/annotate-cause.test.ts`, driven by hand-built `DetectedPattern[]` plus a `SourceIndex` from `buildSourceIndex("test/fixtures/source")`:

1. A profile-only pattern whose routine has a source-correlated sibling names that sibling's pattern id.
2. A profile-only pattern whose routine resolves to exactly one indexed member with no siblings gets the scoped no-findings sentence.
3. A profile-only pattern whose routine resolves to **zero** members is left byte-identical.
4. A profile-only pattern whose anchor name exists in the index but under a **different `objectId`** is left byte-identical — the `matchExactToSource` fence. Using `matchAllToSource` instead makes this test fail, which is the point of the new function.
5. A profile-only pattern whose anchor type is `CodeUnit` against an index entry typed `Codeunit` still resolves — `canonicalObjectType` is applied. Without it the fence is silent for every real finding and the feature looks like a no-op.
6. A multi-routine finding (`involvedMethods.length > 1`) with no siblings is left byte-identical, even when `[0]` resolves exactly.
7. The scoped sentence names loop/SetLoadFields, and does NOT claim "no database anti-patterns" — pinned by string, because the unscoped wording is the confident falsehood this fence exists to prevent.
8. The profile-only id set matches the ids emitted by `runDetectors` over a fixture profile.
9. A source-correlated pattern is never annotated, even when it shares a routine with a profile-only one.
10. `annotateStaticCause(patterns, methods, undefined)` leaves every suggestion byte-identical.
11. `involvedMethods` is unchanged for every pattern in every case above.

**Every fence must be mutation-tested** — delete it, confirm a test fails on an assertion that encodes the behaviour, restore byte-identical. This is the codebase's most repeated defect: today alone, two guards shipped green with tests that could not fail, including one in this same session where a Page severity downgrade masked the very refinement under test. Cases 3 and 4 are the fences here; if removing the `matchAllToSource` check leaves the suite green, the test is measuring nothing.

Fixture note: `test/fixtures/source/` gains no new files, so the `48 → 49` count assertions in `indexer.test.ts`, `indexer-snapshots.test.ts`, `cache.test.ts`, `source-map.test.ts` and `e2e/source-correlation.test.ts` stay put. Any new fixture requires updating all five.

## Risks, accepted

- **Redundancy.** A routine with a `modify-in-loop` finding now mentions it twice — once as its own finding, once inside the dominance suggestion. Accepted deliberately: the cause is named where the reader is already looking.
- **Frequently silent, and more so after review.** In a real capture the dominant method is often base-app or dependency code, which `.dependencies/` exclusion means is never indexed. The three fences narrow it further: exact type+id resolution, single-routine findings only, and five of the seven detectors excluded from the clean sentence by construction, leaving only `single-method-dominance` and `recursive-call` able to receive it. Expect silence to be the common outcome. That is correct behaviour rather than a gap — the alternative is a confident sentence about code the tool did not read — but it does mean the feature's visible value rests mostly on sibling naming, not on the clean claim.
- **The clean claim is the risky half and the small half.** It survives review only because it is scoped to "loop or SetLoadFields findings". If a future change runs `runSourceOnlyDetectors` inside `analyzeProfile`, that wording becomes needlessly narrow and should widen with it; if a new source-correlated detector is added, the wording is already correct without edit. Either way the sentence must never be widened to "no database anti-patterns" while any detector family is absent from the path.
