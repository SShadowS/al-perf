# SQL Evidence Layer — Design

**Date:** 2026-07-16
**Status:** design, pending user review
**Scope:** project 1 of 2 (profile-side SQL). The RT0005 telemetry SQL path is an explicit follow-on with its own spec.

## Goal

Make al-perf's findings point at the **actual SQL** that caused the cost, instead of inferring from AL shape. The five detectors the research audit called out as "guessing" — `missing-setloadfields`, `unindexed-filter`, `calcfields-in-loop`, `modify-in-loop`, `repeated-siblings` — should carry the real `SELECT`/`UPDATE` they correlate to, with its measured execution count and time. And the al-sem × al-perf fusion layer should be able to earn a **"runtime-confirmed"** badge where the profile shows the real database operation, which the current "runtime-correlated" (shape-only) tier deliberately withholds.

## What already exists (and what is actually missing)

The premise "we throw the SQL away" is only half-true, and the two halves are different problems.

- **Profile path — the SQL is already present, parsed, and unused by detectors.** In a `.alcpuprofile`, SQL statements appear as call-tree nodes whose `callFrame.functionName` *is* the statement (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/`MERGE`). `src/explain/payloads/sql-patterns.ts` (`extractSqlPatterns`) already recognizes these and groups them by table — but **only for the `--deep` AI payload**. `src/core/processor.ts` has zero SQL handling. The 21 deterministic detectors never look at it.
- **Telemetry path — RT0005 SQL is fetched and discarded.** `src/lifecycle/appinsights.ts`'s KQL pulls `alStackTrace` (used only as a `methodName` fallback) and never extends `sqlStatement`/`sqlRowsRead`/`sqlExecutes`; a server-side `summarize` collapses everything to routine-level `count`/`maxDurationMs`. **This is the follow-on project, out of scope here.**

This spec addresses the profile path only. No new ingest, no KQL change, no `telemetry-batch` schema bump.

## Decisions settled during brainstorming

1. **Architecture: both layers, one plan (Approach C).** Build the shared correlation primitive once; attach evidence to al-perf's own findings (Component 1) *and* expose it as a confirmation source in the semantic fusion layer (Component 2).
2. **Evidence power: annotate + rank, NO refutation in v1.** Evidence attaches, confirms, and gives measured cost for ranking. It never downgrades or suppresses a finding. Refutation (present-but-contradicting SQL disproving a shape guess) is a deliberate follow-on once statement parsing is proven.
3. **Correctness over features.** Presence of correlated SQL always annotates and confirms — strictly more information, never wrong. Absence is asymmetric (meaningful on exact ir-json captures, not on sampled profiles) and, because v1 does not suppress, is simply **silent, never negative**.

## The correlation primitive (shared foundation)

**A SQL node's owning routine is its nearest AL-routine ancestor in the call tree.** A `SELECT` node belongs to the AL frame that issued it, not to a caller three levels up, and not to a sibling. This is the sound attribution rule and the single primitive both components consume.

New pure module `src/core/sql-evidence.ts`:

```typescript
export interface SqlEvidenceItem {
  /** Normalized, truncated statement text (≤200 chars), as extractSqlPatterns already truncates. */
  statement: string;
  operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE";
  /** Table name parsed from the statement, or null when unparseable. */
  table: string | null;
  /** Aggregated across identical normalized statements under this routine. Exact on ir-json. */
  executionCount: number;
  /** Sum of self-time (µs) of the correlated SQL nodes. */
  totalSelfTimeUs: number;
}

/**
 * Build a map from a routine's canonical key (`${functionName}_${objectType}_${objectId}`,
 * matching aggregateByMethod) to the SQL statements issued DIRECTLY by that routine —
 * i.e. SQL nodes whose nearest AL-routine ancestor is that routine.
 *
 * Identical statements (after param-normalization) collapse into one item whose
 * executionCount is the summed hitCount and totalSelfTimeUs the summed selfTime.
 */
export function buildSqlByRoutine(profile: ProcessedProfile): Map<string, SqlEvidenceItem[]>;
```

Implementation notes that must hold:

- **"SQL node"** = `SQL_PREFIX_RE.test(node.callFrame.functionName)` — reuse the exact predicate from `sql-patterns.ts` (`isSqlNode`), do not re-derive it. Extract the shared regex + `extractTableName` rather than duplicating (`sql-patterns.ts` keeps working; the new module imports the helpers).
- **"AL-routine ancestor"** = the nearest ancestor for which `isAlRoutineFrame` is true (reuse `src/semantic/identity.ts`). Walk `node.parent` upward until the first AL routine frame; that routine owns the SQL node. If none (SQL under a builtin/root with no AL ancestor), the node has no owning routine and is dropped — it cannot be attributed honestly.
- **Param-normalization for grouping** (the one new parsing bit, deliberately conservative): replace numeric and quoted-string literals with `?` before grouping, so `WHERE "No."='C10'` and `WHERE "No."='C20'` collapse to the same query shape — this is what proves "the same query ran N times" for `repeated-siblings`/N+1. Keep the *displayed* `statement` as the first-seen normalized form. Do not attempt semantic SQL parsing beyond literal blanking.

## Component 1 — evidence on al-perf's own findings

`DetectedPattern` gains one optional, additive field:

```typescript
export interface SqlEvidence {
  /** "exact" on ir-json (lossless per-invocation counts), "sampled" otherwise. */
  captureKind: "exact" | "sampled";
  /** The correlated statements. Non-empty whenever this field is present. */
  items: SqlEvidenceItem[];
  /** Sum of items[].totalSelfTimeUs — the measured cost this finding correlates to. */
  measuredCostUs: number;
}
// on DetectedPattern:
sqlEvidence?: SqlEvidence;
```

A new pass `attachSqlEvidence(patterns, profile, sqlByRoutine)` runs in `analyzeProfile` **after** detectors produce patterns and **before** `sortPatterns`, so measured cost can feed the existing sort:

1. For each pattern, resolve the routine that **issues** the evidence SQL — which is not always `involvedMethods[0]` (see the anchor-index note below) — to its canonical key (`${functionName}_${objectType}_${objectId}`, matching `aggregateByMethod`). Prefer threading the key through rather than re-parsing the `FunctionName (ObjectType ObjectId)` display string; the plan decides.
2. Look up that routine's SQL items. Filter to the op-types that are evidence for *this* pattern id (the rule map below). If none match, leave `sqlEvidence` unset — **silent, not negative**.
3. Attach `sqlEvidence = { captureKind, items, measuredCostUs }`. `captureKind` = `"exact"` iff `profile.sourceFormat === "ir-json"`, else `"sampled"`.
4. **The impact:0 fix, honestly:** if `pattern.impact === 0` and evidence exists, set `pattern.impact = measuredCostUs`. Source-only findings (`nested-loops`, `unfiltered-findset`, `unindexed-filter`, …) tie at `impact: 0` today and cannot be ranked (last batch's Task 4 could only fall back to severity); a correlated SQL cost is real measured time and gives them an honest rank. Never overwrite a non-zero impact — for source-correlated findings `impact` is already `method.selfTime`, which is a superset of the SQL cost.

Per-detector evidence rule map (`SQL_EVIDENCE_RULES`), in `sql-evidence.ts`, small and curated like `CORROBORATION_MAP`. **Each entry carries an `anchorIndex`** naming which `involvedMethods[]` entry *issues* the evidence SQL — the loop-owning routine and the SQL-issuing routine are not always the same:

| Pattern id | `anchorIndex` | Evidence op-types |
|---|---|---|
| `missing-setloadfields`, `incomplete-setloadfields`, `unfiltered-findset`, `unindexed-filter` | 0 | `SELECT` |
| `calcfields-in-loop` | 0 | `SELECT` containing an aggregate (`SUM`/`COUNT`/`AVG`/`MIN`/`MAX`) |
| `modify-in-loop` | 0 | `UPDATE` |
| `insert-in-loop` | 0 | `INSERT` |
| `delete-in-loop` | 0 | `DELETE` / `MERGE` (row delete lowers as DELETE; `DeleteAll` may lower as one statement) |
| `record-op-in-loop` | 0 | any DML |
| `high-hit-count` | 0 | any SQL under the routine, grouped by normalized statement — here `involvedMethods[0]` is the child (the op fired ≫ its parent) |
| `repeated-siblings` | **1** | repeated normalized SQL — `involvedMethods = [parent, representativeChild]`; the SELECT is issued by the **child** (`[1]`), which the parent loops over |

The `anchorIndex` values are the same the fusion layer already verified against the detectors in `CORROBORATION_MAP` (`repeated-siblings` → parent at [0]/child at [1]; `high-hit-count` → child at [0]/parent at [1]). Getting this wrong attaches nothing (best case) or the wrong routine's SQL (worst case), so it is pinned by a fixture where parent and child both issue SQL and only the child's is the N+1. A pattern id absent from the map gets no SQL evidence — the same "not in the map ⇒ no signal" discipline as `CORROBORATION_MAP`.

**Surfacing.** `sqlEvidence` renders in every formatter (terminal/json/markdown/html) and in the `analyze_profile` MCP tool as an evidence block under the finding: statement, `×executionCount`, total time, and a `captureKind` marker so a reader never mistakes sampled absence for proof. Formatter parity is compile-enforced (`SectionRenderers<T>`), so all formatters must render it or fail to compile.

## Component 2 — the "runtime-confirmed" tier in fusion

`SemanticAttribution` gains a field parallel to `corroboratingPatterns`, and deliberately separate from it:

```typescript
/**
 * SQL runtime CONFIRMATION (distinct from corroboratingPatterns, which is shape
 * co-occurrence = correlation). Set when the profile shows the actual database
 * operation this attribution's al-sem finding predicted, issued DIRECTLY by this
 * routine (nearest-AL-ancestor). This is causation-grade evidence — the DB op
 * happened, measured — so it earns "runtime-confirmed", the badge the shape-only
 * corroboration map withholds. Populated only for status === "matched".
 */
sqlConfirmed?: {
  /** The al-sem detector ids confirmed by SQL under this routine. */
  detectors: string[];
  /** The confirming SQL (same items as the al-perf finding's evidence). */
  items: SqlEvidenceItem[];
};
```

A new pass `confirmWithSql(fused, sqlByRoutine, alSemRules)` runs alongside `corroborate()` in `fuseProfile`. For each `status === "matched"` attribution, if its routine has SQL evidence matching the phenomenon of one of the attribution's al-sem findings, set `sqlConfirmed`. The matching uses an `SQL_CONFIRMATION_MAP: Record<alSemDetectorId, evidence-op-types>` — the al-sem analog of `SQL_EVIDENCE_RULES`:

| al-sem detector | Confirming SQL |
|---|---|
| `d1-db-op-in-loop` | any DML under the routine |
| `d4-repeated-lookup-in-loop` | repeated normalized `SELECT` (count > 1) |
| `d7-recursive-event-expansion` | any SQL whose repetition tracks the recursion (v1: any SQL under the routine) |

`d48-io-in-loop` (non-SQL I/O, e.g. `HttpClient`) has **no** SQL confirmation and is correctly absent from the map — SQL evidence confirms database phenomena only.

**The honesty separation is the point.** `corroboratingPatterns` stays exactly what it is (shape co-occurrence → "runtime-correlated"). `sqlConfirmed` is a strictly stronger, separately-labeled tier ("runtime-confirmed"). A view may render "confirmed" only from `sqlConfirmed`, never from `corroboratingPatterns`. The existing invariant in `corroboration-map.ts` (co-occurrence is correlation, not causation) is preserved untouched.

## Identity / fingerprint safety (non-negotiable)

`sqlEvidence` and `sqlConfirmed` are **descriptive metadata, never identity.** A finding's fingerprint is minted by `fingerprintPatterns` from the anchor (`involvedMethods[0]`); `identityTokens()` reads only `(patternId, appId, canonicalObjectType, objectNumber, normalizedRoutineName)`. Attaching evidence must not change any of those. **A test pins that a profile's finding fingerprints are byte-identical with and without the SQL-evidence pass** (the same discipline every recent batch enforced). Setting `impact` from `measuredCostUs` is safe: `impact` is not an identity token. `FINGERPRINT_ALGO_VERSION` does not change.

## Data flow

```
analyzeProfile(path, opts):
  processed  = process(raw)                    # unchanged
  patterns   = runDetectors + runSource*        # unchanged
  sqlByRoutine = buildSqlByRoutine(processed)   # NEW (primitive)
  attachSqlEvidence(patterns, processed, sqlByRoutine)  # NEW (Component 1; may set impact on impact:0 findings)
  patterns   = sortPatterns(patterns)           # unchanged — now sees real impact
  fingerprintPatterns(patterns, ...)            # unchanged — evidence is not identity

fuseProfile(..., patterns):
  fused = correlate(...)                         # unchanged
  corroborate(fused, methods, patterns)         # unchanged (shape "correlated")
  confirmWithSql(fused, sqlByRoutine, rules)    # NEW (Component 2; SQL "confirmed")
```

When there is no profile (source-only static analysis with no `.alcpuprofile`), `buildSqlByRoutine` returns an empty map and everything is silent — evidence is a profile-driven enrichment, absent by design when nothing ran.

## Non-goals (explicit)

- **Refutation / suppression.** Deferred follow-on. v1 never downgrades a finding.
- **Rows-read / `sqlExecutes` / query plans.** These are telemetry (RT0005/report) fields, not in profiles. They arrive with the telemetry-SQL follow-on.
- **RT0005 telemetry SQL ingest.** Separate spec (project 2 of 2).
- **Semantic SQL parsing** beyond literal-blanking for N+1 grouping and the existing table-name extraction. No column counting (that would be needed for refutation — deferred with it).

## Testing

The last batch's final blocker got through a green suite and a clean corpus sweep because **no fixture expressed the shape**. This project has the same hazard: no existing fixture has a call tree with SQL child nodes under AL routines. **The fixtures are a first-class deliverable.**

- **Fixtures:** at least two profiles whose call trees contain AL routine frames with SQL child nodes — one sampled `.alcpuprofile` and one ir-json — covering: a `SELECT` under a routine that has `missing-setloadfields`; N identical `SELECT`s under a `repeated-siblings` parent; an aggregate `SELECT` under `calcfields-in-loop`; an `UPDATE` under `modify-in-loop`; a SQL node under a *callee* of the finding's routine (must NOT be attributed to the finding — pins the nearest-ancestor rule); a routine with no SQL (evidence silent).
- **Unit tests** for `buildSqlByRoutine` (nearest-ancestor attribution, param-normalized grouping, exact-vs-sampled `captureKind`), `attachSqlEvidence` (per-detector rule matching, impact:0 → measuredCost, non-zero impact untouched), `confirmWithSql` (matched-only gate, SQL_CONFIRMATION_MAP, `sqlConfirmed` separate from `corroboratingPatterns`).
- **The identity pin:** finding fingerprints unchanged by the evidence pass (compare `fingerprintPatterns` output with and without `attachSqlEvidence`).
- **Corpus sweep discipline** carried from the batches: run detectors over every fixture before and after; the only deltas are added `sqlEvidence`/`sqlConfirmed` and impact changes on previously-impact:0 findings that now have evidence — **no fingerprint moves, no finding appears or disappears.**
- **Mutation discipline:** every new behavior pinned so that breaking it reddens a test (nearest-ancestor → attribute to caller: red; drop a rule-map entry: red; captureKind hardcoded: red; impact-set removed: the ranking test reds).

## Risks

- **SQL frame recognition is regex-on-functionName.** If a real profile carries SQL text in a shape `SQL_PREFIX_RE` misses, that SQL is silently uncorrelated (under-report, never false claim — acceptable, and no worse than today where it's ignored entirely). Widening the predicate is a fixture-driven follow-up if real profiles show it.
- **Anchor-string round-trip.** Resolving `involvedMethods[0]` back to a routine key must exactly match `aggregateByMethod`'s key. Prefer threading the key rather than re-parsing the display string; the plan decides. A mismatch means silent non-correlation (under-report), pinned by the fixtures.
- **Param-normalization false-merge.** Over-blanking could merge two genuinely different queries. Conservative literal-only blanking keeps this small; the N+1 fixture pins that identical shapes merge and the callee fixture pins that structurally different trees don't.
