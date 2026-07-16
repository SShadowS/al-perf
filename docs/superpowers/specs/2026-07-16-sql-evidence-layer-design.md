# SQL Evidence Layer v1 — Design

**Date:** 2026-07-16
**Status:** design, pending user review (revised after a GPT-5.6-sol spec review found 9 defects, all verified against source and fixed here)
**Supersedes:** the earlier v1 in this same file (commit `448b5e4`), which a two-model panel found not plan-ready. This rewrite removes its two defects (a fusion "runtime-confirmed" tier that overclaims causation on *sampled* data, and an impact-overwrite rule) and the 9 the spec-review pass then found.
**Scope:** project 1 of 2 (profile-side SQL). The RT0005 telemetry SQL path is a separate follow-on spec.

## Goal

Make al-perf's findings point at the **actual SQL** they correlate to, and let a batch capture show, at the activity level, how much **measured** SQL time it spent.

Two layers, one plan, both annotate-and-rank only (never suppress, downgrade, or "confirm"):

1. **Per-finding SQL annotation + rank.** A finding whose routine issued SQL carries the correlated `SELECT`/`UPDATE`/… statements, each with a **sampled** cost and a **sampled hit count**, plus a separate `sqlRank`.
2. **Activity-level measured corroboration.** In the batch path, the profile's sidecar manifest carries **measured** per-activity `sqlCallCount` / `sqlCallDuration`. Surface it *beside* the sampled-attributed cost. (No arithmetic across the manifest's duration fields — they overlap; see the activity section.)

Everything SQL-derived from a profile is a **sampled estimate**. SQL nodes carry `hitCount`/`selfTime`, never a measured statement duration, and — critically — a sampling profile's `hitCount` is a **sample count, not an invocation count** (`processor.ts:46-59` may even substitute sample-appearance counts). So Σ hitCount is a *sampled hit total*, never proof a query "ran N times." The only measured SQL number available is the manifest's per-activity call **count** (not per-statement, not a duration we can attribute). There is **no** "confirmed"/"exact" SQL tier in v1.

## What already exists (and what is actually missing)

- **Profile path — SQL present, parsed, unused by detectors.** SQL statements are call-tree nodes whose `callFrame.functionName` *is* the statement. `src/explain/payloads/sql-patterns.ts` (`extractSqlPatterns`, `isSqlNode`) recognizes them — but only for the `--deep` AI payload (`sql-patterns.ts:11-12,60-88`). The 21 deterministic detectors never see them. `src/core/processor.ts` has no SQL handling.
- **Batch path — measured SQL present, discarded.** `ProfileMetadata` (`src/types/batch.ts:2-14`) carries measured `sqlCallCount`, `sqlCallDuration`, `httpCallCount/Duration`, `alExecutionDuration`, `activityDuration`. Only the two SQL fields are read, and only in one HTML expander (`batch-html.ts:125-131`); the batch analyzer does no SQL arithmetic (`batch-analyzer.ts:90-99`).
- **Telemetry path — RT0005 SQL fetched and discarded** (`appinsights.ts:184-219`). **Out of scope** — the telemetry-SQL follow-on.

This spec addresses the profile path (both layers). No new ingest, no KQL change, no telemetry schema bump.

## Decisions settled during brainstorming (banked)

1. **v1 scope = both layers** (per-finding annotation + activity corroboration), one plan.
2. **Annotate + rank, NO refutation or suppression.** Refutation is a deliberate follow-on.
3. **Rank on a SEPARATE field, never `impact`.** `method.selfTime` (source of `impact`) *excludes* children, and SQL is a child; `sqlRank` is its own field.
4. **No "runtime-confirmed" fusion tier.** Sampled SQL is correlation, not causation.
5. **Attribution is method-level, matched against `involvedMethods`.** Findings carry no node handle (`DetectedPattern = { id, involvedMethods: string[], evidence, … }`, `patterns.ts:3-10`). A finding's SQL is the union of SQL owned by the routines its `involvedMethods` name.
6. **The owning routine of a SQL node is its nearest AL-routine ancestor.** That ancestor supplies the routine's `functionName` (needed for the method key); the SQL node's own `applicationDefinition` supplies/validates the issuing *object* only — it carries no routine name, and `scriptId` is opaque (`profile.ts:3-8,26-30`). So ancestry resolves the routine; `applicationDefinition` cross-checks its object identity.
7. **Table parser rewritten to `split('$')`** — `parts[1]` = table, `parts[2]` = extension GUID. The existing `extractTableName` splits at the *first* `$` and returns the company (`sql-patterns.ts:52-57`); that bug must not be reused.
8. **Provenance is honest and explicit.** All per-finding SQL is `sampled-estimate`; hit counts are `sampled`. ir-json carries no SQL → per-finding evidence absent there.

## The correlation primitive (shared foundation)

New pure module `src/semantic/sql-evidence.ts`.

```typescript
export interface SqlStatementEvidence {
  text: string;                       // first-seen normalized statement, truncated
  operation: "SELECT" | "COUNT" | "INSERT" | "UPDATE" | "DELETE" | "OTHER";
  table: string | null;               // split('$')[1]; null when unparseable (128-char overflow)
  extensionAppId: string | null;      // split('$')[2] when GUID-shaped
  readUncommitted: boolean;           // WITH(READUNCOMMITTED)
  sampledHitCount: number;            // Σ hitCount of identical normalized statements — SAMPLED, not executions
  sampledCostUs: number;              // Σ node.selfTime (µs) — a SAMPLED estimate
  attribution: "object-method" | "ancestor-fallback"; // per-statement resolution path
}

/**
 * Map a routine's canonical key (`${functionName}_${objectType}_${objectId}`,
 * matching aggregateByMethod, aggregator.ts:63) to the SQL it issued.
 *
 * Owning routine of a SQL node:
 *   1. nearest AL-routine ancestor (walk node.parent up to the first AL routine frame)
 *      → supplies functionName + object → the method key. attribution = "ancestor-fallback".
 *   2. if that ancestor's object disagrees with the SQL node's applicationDefinition,
 *      prefer the SQL node's object identity for the key's object part (the SQL frame
 *      self-identifies its true issuer) → attribution = "object-method".
 *   3. if there is no AL-routine ancestor at all → the "" (unattributed) bucket, not dropped.
 *
 * Identical statements collapse (param-normalized): sampledHitCount = Σ hitCount,
 * sampledCostUs = Σ selfTime.
 */
export function buildSqlByRoutine(profile: ProcessedProfile): Map<string, SqlStatementEvidence[]>;
```

Invariants:

- **"SQL node"** = reuse `isSqlNode` / `SQL_PREFIX_RE` from `sql-patterns.ts` (extract shared helpers; do not duplicate).
- **AL-routine-frame test on a node** must be a **node-aware** predicate. `isAlRoutineFrame` in `identity.ts:322` takes a `MethodBreakdown` (`m.functionName`, `m.isBuiltin`); a `ProcessedNode` exposes `node.callFrame.functionName` and `node.isBuiltinCodeUnitCall` (`processed.ts:8-27`). Extract a shared predicate over `{ functionName, isBuiltin }` and adapt both shapes; it already excludes SQL-text frames (the SQL-prefix check), which is exactly the "an SQL frame is not a routine" rule this module needs.
- **Cost = summed `node.selfTime`** (already computed by the processor). Labelled `sampled-estimate`.
- **Param-normalization** (the one new parse, conservative): blank numeric and quoted-string literals to `?` before grouping, so `WHERE "No."='C10'` and `='C20'` collapse to one shape. This groups *by query shape*; it is a **sampled** aggregate, NOT proof of execution multiplicity. Keep the first-seen form as `text`. No semantic SQL parsing beyond literal-blanking + table extraction.

## Data model

### Per-finding evidence (Component 1)

`DetectedPattern` gains two optional, additive fields — never identity, never `impact`:

```typescript
export interface SqlEvidence {
  statements: SqlStatementEvidence[]; // top-5 by sampledCostUs, for DISPLAY only
  totalSampledCostUs: number;         // Σ over the FULL filtered set (not the truncated top-5)
  totalSampledHitCount: number;       // Σ over the FULL filtered set
  provenance: "sampled-estimate";
  attribution: "object-method" | "ancestor-fallback" | "mixed"; // derived from the statements
}
// on DetectedPattern:
sqlEvidence?: SqlEvidence;
sqlRank?: number;                     // = totalSampledCostUs (computed from the FULL set)
```

`totalSampledCostUs`, `totalSampledHitCount`, and `sqlRank` are computed from the **complete** filtered statement set; only `statements` is truncated to the top-5 for display, so truncation can never invert the rank.

### Activity corroboration (Component 2, batch path)

```typescript
export interface SqlActivityCorroboration {
  measuredSqlCount: number;          // manifest.sqlCallCount   (MEASURED, exact call count)
  measuredSqlDurationMs: number;     // manifest.sqlCallDuration (MEASURED)
  sampledAttributedCostUs: number;   // Σ all SQL selfTime in this profile (each node once)
  activityDurationMs?: number;       // shown for context, NOT arithmetic
  alExecutionDurationMs?: number;    // shown for context
}
```

**No `unaccountedMs`.** The manifest's duration fields overlap — verified on the real fixture (`manifest.json:52-56`): `activityDuration 67350 − alExec 63803 − sql 218 − http 63489 = −60160 ms`, negative because `alExecutionDuration` already *includes* the HTTP wait. So the fields are not mutually-exclusive buckets and cannot be subtracted. v1 shows measured SQL (count + duration) beside the sampled-attributed cost, and displays activity/AL durations only as labelled context — no residual arithmetic.

## Component 1 — attach per-finding evidence

A new pass `attachSqlEvidence(patterns, profile, sqlByRoutine)` runs in `analyzeProfile` **after** detectors and **before** `sortPatterns`:

1. For each pattern, collect the routine keys from its `involvedMethods`: for each entry, skip it if its `functionName` is a SQL frame (the SQL-prefix check — SQL frames are not routines); otherwise resolve it to the `${functionName}_${objectType}_${objectId}` key (thread the key from the detector, or parse the `FunctionName (ObjectType ObjectId)` display string — the plan decides one).
2. **Union** the SQL from `sqlByRoutine` across those routine keys, then filter to the op-types that are evidence for *this* pattern id (rule map below). If nothing matches, leave `sqlEvidence` unset — **silent, never negative**.
3. Set `sqlEvidence` (full-set totals; top-5 `statements`; derived `attribution`) and `sqlRank = totalSampledCostUs`. Do **not** touch `impact`.

This **union-over-routine-entries** model replaces the earlier fragile per-detector `anchorIndex` map. It is correct regardless of which `involvedMethods` entry issues the SQL (e.g. `repeated-siblings` has `involvedMethods = [parent, representativeChild]` (`patterns.ts:366`); if the repeated child is itself a SQL frame it is skipped and the SQL is found under the parent routine that owns it; if the child is an AL routine its SQL is found under the child — either way the union resolves it). It also removes the prior spec's false claim that SQL anchors match `CORROBORATION_MAP` (they do not — that map's `anchorIndex` names the loop *owner*, `repeated-siblings→0`/`high-hit-count→1` at `corroboration-map.ts:33,46`; the SQL issuer is a different question, and the union avoids having to pick).

Per-detector op-type filter (`SQL_EVIDENCE_OPS`), small and curated:

| Pattern id | Evidence op-types |
|---|---|
| `missing-setloadfields`, `incomplete-setloadfields`, `unfiltered-findset`, `unindexed-filter` | `SELECT` |
| `calcfields-in-loop` | `SELECT`/`COUNT` with an aggregate (`SUM`/`COUNT`/`AVG`/`MIN`/`MAX`) |
| `modify-in-loop` | `UPDATE` |
| `insert-in-loop` | `INSERT` |
| `delete-in-loop` | `DELETE` |
| `record-op-in-loop` | any DML |
| `high-hit-count`, `repeated-siblings` | any SQL under the finding's routines |

A pattern id absent from the map gets no SQL evidence. Note: source-only detectors (`nested-loops`, `external-call-in-loop`, `unindexed-filter`, …) **do not run in the analyze path** (`analyzer.ts:219-245` runs `runDetectors` + `runSourceDetectors` only, never `runSourceOnlyDetectors`), so most will not be present to annotate — expected, not a gap this spec closes.

## Component 2 — activity corroboration

A new pass `buildSqlActivityCorroboration(profile, sqlByRoutine, metadata)` runs when metadata is present. It reads the measured fields, sums the profile's SQL `selfTime` (each SQL node once), and attaches `SqlActivityCorroboration` to the per-profile `AnalysisResult`. No detector, no finding, no residual arithmetic.

**Manifest threading (explicit).** `AnalyzeOptions` gains an optional `metadata?: ProfileMetadata`. `batch-analyzer.ts` must associate each profile with its manifest entry **by original index before concurrency starts** (validate `manifest.length` and order up front; do not infer association after failed analyses are filtered out — `batch-analyzer.ts` currently aligns metadata only after all analyses finish, `:90-99`), and pass that entry as `options.metadata` into each `analyzeProfile` call. Single-profile `analyze` supplies no metadata → corroboration absent.

## Pipeline / data flow

```
analyzeProfile(path, opts):
  processed    = process(raw)                        # unchanged
  patterns     = runDetectors [+ runSourceDetectors] # unchanged
  sqlByRoutine = buildSqlByRoutine(processed)        # NEW (no-op if no SQL nodes)
  attachSqlEvidence(patterns, processed, sqlByRoutine)  # NEW (Component 1)
  patterns     = sortPatterns(patterns)              # unchanged (impact-sorted)
  fingerprintPatterns(patterns, ...)                 # unchanged — evidence is not identity
  activityCorroboration = opts.metadata               # NEW (Component 2; batch path)
    ? buildSqlActivityCorroboration(processed, sqlByRoutine, opts.metadata) : undefined
```

Guard: the whole enrichment is skipped (no-op) unless `sourceFormat` is sampling V8 and SQL nodes exist. ir-json → absent. No profile → empty map, silent.

## Ranking surface

`sqlRank` and the totals are exposed in the JSON output and the `analyze_profile` MCP result so a consumer can order by SQL cost. The terminal/markdown/html formatters render `sqlEvidence` inline under each finding (statement, `× sampledHitCount` labelled *sampled*, sampled cost, `sampled-estimate` marker) and show `sqlRank` in the finding header. Default `sortPatterns` stays impact-sorted; an optional `--sort sql` flag (and the MCP `sort` param) orders findings by `sqlRank`. Defining this surface is part of v1 — a rank with nowhere to see it is not a feature.

## Identity / fingerprint safety (non-negotiable)

`sqlEvidence`, `sqlRank`, `SqlActivityCorroboration` are **descriptive metadata, never identity**. Fingerprints are minted from the anchor; `identityTokens()` reads only `(patternId, appId, canonicalObjectType, objectNumber, normalizedRoutineName)`. The pass touches none of them and does **not** set `impact`. A test pins finding fingerprints byte-identical with and without the pass. `FINGERPRINT_ALGO_VERSION` unchanged.

## Output / formatter parity

- Per-finding `sqlEvidence` renders inline in the **existing** patterns section of every formatter + the `analyze_profile` MCP tool. Updates the existing pattern renderers; parity compile-enforced by `SectionRenderers<T>`.
- `SqlActivityCorroboration` is a **new** section in `SECTION_ORDER` / `BATCH_SECTION_ORDER`, rendered by all four formatters + batch — compile-enforced by `SectionRenderers<T>` / `BatchSectionRenderers<T>`.

## Non-goals (explicit)

- **Refutation / suppression** — deferred; v1 never downgrades a finding.
- **"Runtime-confirmed" fusion tier** — dropped; sampled SQL is correlation, not causation.
- **Execution counts / rows-read / measured per-statement duration** — a sampling profile cannot supply exact execution counts; rows-read/statement-duration are telemetry (RT0005/report) and OnPrem (Query Store/XE) fields. Separate features.
- **RT0005 telemetry SQL ingest** — separate spec (project 2 of 2).
- **`unaccountedMs` / duration decomposition** — manifest duration fields overlap; deferred until BC measurement semantics define exclusive buckets.
- **Semantic SQL parsing** beyond literal-blanking and table extraction. No column counting (a refutation prerequisite — deferred with it).
- **Database Locks / Query Store / Database Index enrichments** — independent features from the same sweep; each its own spec.

## Known constraints (source-verified)

- A sampling profile's `hitCount` is a **sampled hit count, not an invocation count** (`processor.ts:46-59`); all SQL counts/costs here are sampled estimates. Exact call *counts* exist only at activity granularity in the manifest.
- Attribution granularity is **method-level**, not exact call-site — findings carry no node handle. Multiple findings on one routine share its SQL; the activity total sums each SQL node once regardless.
- **ir-json carries no SQL** → per-finding evidence and activity corroboration both absent there.
- **Source-only detectors are not run** in the analyze path, so their findings are generally not present to annotate.

## Testing (fixtures are a first-class deliverable)

- **Fixtures:** the real `test/fixtures/batch-recorded/profile-1..4.alcpuprofile` (181/488 SQL nodes) + its `manifest.json`, and a minimal ir-json fixture. Cover: a `SELECT` under a `missing-setloadfields` routine (attributed); N identical `SELECT`s grouped under one routine (grouped, labelled *sampled*, NOT "ran N times"); an aggregate `SELECT` under `calcfields-in-loop`; an `UPDATE` under `modify-in-loop`; `repeated-siblings` where the repeated child IS a SQL node (union finds it under the parent) AND a variant where the repeated child is an AL routine that owns SQL (union finds it under the child); a SQL node under a *callee* of the finding's routine (must NOT attribute to the finding); a routine with no SQL (silent); a SQL node with no AL ancestor (→ unattributed bucket, surfaces in the activity total, not lost).
- **Unit tests:** `buildSqlByRoutine` (nearest-ancestor resolution, object-validation via `applicationDefinition`, unattributed bucket, param-normalized grouping), the rewritten table parser (`Company$Table`, `Company$Table$guid`, `[System Table]`, 128-char overflow → `null`), the node-aware AL-frame predicate (node vs MethodBreakdown, SQL-frame exclusion), `attachSqlEvidence` (union across `involvedMethods`, op-type filter, SQL-frame entries skipped, `impact` untouched, totals from full set not truncated top-5, `sqlRank` set), `buildSqlActivityCorroboration` (measured vs sampled side-by-side, no residual arithmetic, each SQL node summed once), the **ir-json → no evidence** negative, and a rank-inversion test (six small groups outrank one medium group — pins full-set totals).
- **Identity pin:** finding fingerprints unchanged by the evidence pass.
- **Corpus/mutation discipline:** run detectors over every fixture before/after — the only deltas are added `sqlEvidence`/`sqlRank`/activity section; no fingerprint moves, no finding appears/disappears. Every new behavior pinned so breaking it reddens a test (ancestor→callee attribution: red; op-type filter dropped: red; provenance hardcoded wrong: red; totals from truncated set: the rank-inversion test reds; `impact` mutated: red; `unaccountedMs` reintroduced: no test, but the sampled/measured separation test guards the shape).

## Risks

- **SQL-frame recognition is regex-on-functionName.** SQL in a shape `SQL_PREFIX_RE` misses is silently uncorrelated (under-report, never a false claim). Widen via fixture-driven follow-up.
- **Routine-key round-trip.** Resolving an `involvedMethods` entry to a routine key must exactly match `aggregateByMethod`'s key (`aggregator.ts:63`); a mismatch means silent non-correlation. Prefer threading the key over re-parsing the display string; pin with fixtures.
- **Param-normalization false-merge.** Over-blanking could merge two different query shapes. Conservative literal-only blanking keeps this small; the N+1 fixture pins that identical shapes merge and the callee fixture pins that different trees don't.
- **`applicationDefinition` not always populated as expected.** When the SQL node's object is absent/`-1`, fall back to the ancestor's object; when there is no AL ancestor, the SQL lands in the unattributed bucket (visible in the activity total, never dropped).
