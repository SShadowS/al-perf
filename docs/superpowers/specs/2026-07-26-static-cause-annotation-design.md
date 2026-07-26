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

Source-correlated detectors build `involvedMethods` with `methodLabel()`; profile-only detectors use `formatMethodBreakdownRef()`. Both render `Name (Type Id)` and, since `core/method-ref.ts` was extracted, are one function. So the anchor strings are directly comparable with `===`.

Two lookups, both by string equality — no parsing:

1. **Sibling findings.** Group all patterns by `involvedMethods[0]`. For a profile-only pattern, its siblings are the other patterns sharing that string, minus itself and minus other profile-only patterns.
2. **The routine's `MethodBreakdown`.** Scan `methods` for the first `m` where `formatMethodBreakdownRef(m) === pattern.involvedMethods[0]`, exactly as `semantic/corroborate.ts` already does. This yields `functionName` / `objectType` / `objectId` for the index lookup.

`involvedMethods[0]` is the finding-lifecycle fingerprint anchor. This pass **reads** it and must never write it.

Parsing the anchor string back into its three parts with a regex is rejected: real function names contain quotes, dots and parentheses (`OnAfterPostSalesDoc."Sales Header"`), and a parser that is wrong on one shape silently mis-attributes a finding.

## The fence

Saying "nothing was found here" is a claim about coverage, not about findings. It is only true if the routine was read. The fence is `matchAllToSource(functionName, objectType, objectId, index)` from `src/source/locator.ts`:

| resolves to | siblings | annotation |
|---|---|---|
| ≥ 1 member | ≥ 1 | name them: `` Static analysis also flagged `modify-in-loop`, `calcfields-in-loop` on this routine. `` |
| exactly 1 member | 0 | `No database anti-patterns were found in this routine, so its cost is likely computational rather than I/O.` |
| > 1 member | 0 | *(silent)* — ambiguous; cannot prove which member ran |
| 0 members | any | *(silent)* — not indexed, so absence proves nothing |

The two silences carry the design's weight. Absence of findings on code that was never read is not evidence of clean code, and this project has shipped that error twice (`incomplete-setloadfields`' "will cause runtime errors", the fragment fences it later needed). The `> 1` case is silent even though a sibling-bearing ambiguous routine still names its siblings — naming a finding is safe under ambiguity because some member really did produce it; claiming *clean* is not.

Note the asymmetry in row 1: siblings are reported whenever the routine resolves at all, including ambiguously, because those findings exist regardless of which member matched.

## Output

The annotation is appended to the existing `suggestion` string, separated by a single space, and only when the detector already has a suggestion. All seven do — verified, though `repeated-siblings`' sits fifteen lines below its `id`, far enough from it to be missed by a narrow grep.

`suggestion` renders in terminal, markdown and HTML today, so this needs no formatter work and adds no surface to the field-parity test. `estimatedSavings`, `savingsExplanation`, `severity`, `impact` and `involvedMethods` are untouched.

## Scope

All seven profile-only detectors, identified by pattern id:

`single-method-dominance`, `high-hit-count`, `deep-call-stack`, `repeated-siblings`, `event-subscriber-hotspot`, `recursive-call`, `event-chain`

Not just the five carrying savings models — `deep-call-stack` and `event-subscriber-hotspot` name a routine and benefit identically.

## Error handling

The pass is advisory and must never fail an analysis. A pattern with an empty `involvedMethods`, an anchor matching no `MethodBreakdown`, or a `sourceIndex` whose `procedures` map lacks the name all resolve to "annotate nothing" rather than throwing. There is no partial-failure state to report: an un-annotated finding is exactly today's output.

## Testing

Unit tests in `test/core/annotate-cause.test.ts`, driven by hand-built `DetectedPattern[]` plus a `SourceIndex` from `buildSourceIndex("test/fixtures/source")`:

1. A profile-only pattern whose routine has a source-correlated sibling names that sibling's pattern id.
2. A profile-only pattern whose routine resolves to exactly one indexed member with no siblings gets the computational-cost sentence.
3. A profile-only pattern whose routine resolves to **zero** members is left byte-identical.
4. A profile-only pattern whose routine resolves to **more than one** member, with no siblings, is left byte-identical.
5. A source-correlated pattern is never annotated, even when it shares a routine with a profile-only one.
6. `annotateStaticCause(patterns, methods, undefined)` leaves every suggestion byte-identical.
7. `involvedMethods` is unchanged for every pattern in every case above.

**Every fence must be mutation-tested** — delete it, confirm a test fails on an assertion that encodes the behaviour, restore byte-identical. This is the codebase's most repeated defect: today alone, two guards shipped green with tests that could not fail, including one in this same session where a Page severity downgrade masked the very refinement under test. Cases 3 and 4 are the fences here; if removing the `matchAllToSource` check leaves the suite green, the test is measuring nothing.

Fixture note: `test/fixtures/source/` gains no new files, so the `48 → 49` count assertions in `indexer.test.ts`, `indexer-snapshots.test.ts`, `cache.test.ts`, `source-map.test.ts` and `e2e/source-correlation.test.ts` stay put. Any new fixture requires updating all five.

## Risks, accepted

- **Redundancy.** A routine with a `modify-in-loop` finding now mentions it twice — once as its own finding, once inside the dominance suggestion. Accepted deliberately: the cause is named where the reader is already looking.
- **Frequently silent.** In a real capture the dominant method is often base-app or dependency code, which `.dependencies/` exclusion means is never indexed. Expect the 0-match silence to be the common outcome. That is correct behaviour, not a gap, and it is why the empty-case sentence is worth having at all: when it *does* fire, it means something.
