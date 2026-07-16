# SQL Evidence Layer v1 — Design

**Date:** 2026-07-16
**Status:** design, pending user review
**Supersedes:** the earlier v1 in this same file (commit `448b5e4`), which a two-model panel found not plan-ready. This rewrite removes the two defects that panel and the real-capture research exposed: the fusion **"runtime-confirmed"** tier (overclaims causation on *sampled* data) and the **impact-overwrite** rule (mutates a ranking field that is also a health-score input). What remains is an honest, annotate-and-rank-only v1.
**Scope:** project 1 of 2 (profile-side SQL). The RT0005 telemetry SQL path is a separate follow-on spec.

## Goal

Make al-perf's findings point at the **actual SQL** they correlate to, instead of inferring purely from AL shape — and let a batch capture show, at the activity level, how much **measured** SQL time it actually spent.

Two layers, one plan:

1. **Per-finding SQL annotation + rank.** A finding whose method issued SQL carries the correlated `SELECT`/`UPDATE`/… statements, each with a **sampled** cost and hit count, plus a separate SQL rank signal. This is enrichment: it never downgrades, suppresses, or "confirms" a finding.
2. **Activity-level measured corroboration.** In the batch path, the profile's sidecar manifest already carries **measured** per-activity `sqlCallCount` / `sqlCallDuration`. Surface it against the sampled-attributed cost, plus an "unaccounted time" figure. This is a coarser, whole-activity signal — deliberately separate from per-finding evidence.

Everything SQL-derived in a profile is a **sampled estimate** (SQL nodes carry `hitCount`/`selfTime`, never a measured statement duration). There is **no** "confirmed" / "exact" / "runtime-verified" tier in v1. The one place a *measured* number exists is the manifest, and it is per-activity, not per-statement.

## What already exists (and what is actually missing)

- **Profile path — the SQL is present, parsed, and unused by detectors.** In a `.alcpuprofile`, SQL statements are call-tree nodes whose `callFrame.functionName` *is* the statement. `src/explain/payloads/sql-patterns.ts` (`extractSqlPatterns`, `isSqlNode`) already recognizes them — but **only for the `--deep` AI payload**. The 21 deterministic detectors never see them. `src/core/processor.ts` has zero SQL handling.
- **Batch path — measured SQL is present and discarded.** `ProfileMetadata` (`src/types/batch.ts`) carries measured `sqlCallCount`, `sqlCallDuration`, `httpCallCount/Duration`, `alExecutionDuration`, `activityDuration` per activity. Only `sqlCallCount`/`sqlCallDuration` are read, and only in one HTML expander (`batch-html.ts:125`); no detector, no terminal/markdown/json aggregate, no arithmetic.
- **Telemetry path — RT0005 SQL is fetched and discarded.** `src/lifecycle/appinsights.ts`'s KQL pulls `alStackTrace` (first line only) and never extends `sqlStatement`. **Out of scope here** — the telemetry-SQL follow-on.

This spec addresses the profile path (both layers above). No new ingest, no KQL change, no telemetry schema bump.

## Decisions settled during brainstorming (banked)

1. **v1 scope = both layers** (per-finding annotation + activity corroboration), one plan.
2. **Annotate + rank, NO refutation or suppression.** Evidence attaches and ranks; it never downgrades or hides a finding. Refutation is a deliberate follow-on.
3. **Rank on a SEPARATE field, never `impact`.** `method.selfTime` (the source of `impact`) *excludes* children, and SQL is a child; overwriting `impact` is both directionally wrong and pollutes the health score. `sqlRank` is its own field.
4. **No "runtime-confirmed" fusion tier.** Sampled SQL is correlation, not causation. The prior Component 2 badge is dropped; fusion's existing shape-correlation is untouched.
5. **Correlation key is method identity, matched against `involvedMethods`.** Findings carry no call-tree node handle (`DetectedPattern` is `{ id, involvedMethods: string[], evidence, … }`, `patterns.ts:3-10`), so attribution is method-level, not exact call-site. Verified against source.
6. **SQL-node → issuing object: `scriptId`/`applicationDefinition` primary, nearest-AL-ancestor fallback.** Real captures show SQL nodes frequently self-identify their issuing object; use that when present, fall back to tree ancestry.
7. **Table parser rewritten to `split('$')`** — `parts[1]` = table, `parts[2]` = extension GUID. The existing `extractTableName` splits at the *first* `$` and returns the company; that bug must not be reused.
8. **Provenance is honest and explicit.** All per-finding SQL is labelled `sampled-estimate`. ir-json carries no SQL, so per-finding `sqlEvidence` is simply absent there.

## The correlation primitive (shared foundation)

New pure module `src/semantic/sql-evidence.ts`.

```typescript
export interface SqlStatementEvidence {
  /** Normalized, truncated statement text (reuse sql-patterns truncation). */
  text: string;
  operation: "SELECT" | "COUNT" | "INSERT" | "UPDATE" | "DELETE" | "OTHER";
  /** Parsed via split('$'): parts[1]. null when unparseable (e.g. 128-char overflow). */
  table: string | null;
  /** split('$')[2] when GUID-shaped. */
  extensionAppId: string | null;
  /** WITH(READUNCOMMITTED) present. */
  readUncommitted: boolean;
  /** Summed hitCount of identical normalized statements under the owning routine. */
  executionCount: number;
  /** Summed node.selfTime (µs) of those SQL nodes — a SAMPLED estimate. */
  sampledCostUs: number;
}

/**
 * Map a routine's canonical key (`${functionName}_${objectType}_${objectId}`,
 * matching aggregateByMethod) to the SQL it issued. A SQL node's owning routine
 * is resolved by: (1) callFrame.scriptId / applicationDefinition → issuing object,
 * when populated; else (2) nearest AL-routine ancestor in the call tree. A SQL node
 * with neither is placed in the "" (unattributed) bucket, not dropped.
 *
 * Identical statements collapse (param-normalized) into one item: executionCount =
 * Σ hitCount, sampledCostUs = Σ selfTime.
 */
export function buildSqlByRoutine(profile: ProcessedProfile): Map<string, SqlStatementEvidence[]>;
```

Implementation invariants:

- **"SQL node"** = reuse `isSqlNode` / the `SQL_PREFIX_RE` predicate from `sql-patterns.ts` (extract the shared helpers; do not re-derive). `sql-patterns.ts` keeps working.
- **Issuing object, primary path:** read `callFrame.scriptId` / `applicationDefinition` → `(ObjectType ObjectId)`. This is more direct than ancestry and survives when the tree parent is a builtin.
- **Issuing object, fallback:** nearest ancestor for which `isAlRoutineFrame` is true (reuse `src/semantic/identity.ts`), walking `node.parent` upward.
- **Cost = summed `node.selfTime`** (already computed by the processor), not a re-derived `hitCount × interval`. Labelled `sampled-estimate` regardless.
- **Param-normalization for grouping** (the one new parse, deliberately conservative): blank numeric and quoted-string literals to `?` before grouping, so `WHERE "No."='C10'` and `='C20'` collapse to one shape — this is what proves "the same query ran N times" for N+1. Keep the first-seen form as `text`. No semantic SQL parsing beyond literal-blanking + table extraction.

## Data model

### Per-finding evidence (Component 1)

`DetectedPattern` gains two optional, additive fields — never identity, never `impact`:

```typescript
export interface SqlEvidence {
  statements: SqlStatementEvidence[]; // top-5 by sampledCostUs, attributed to this finding
  totalSampledCostUs: number;         // Σ statements[].sampledCostUs
  opCount: number;                    // Σ statements[].executionCount
  provenance: "sampled-estimate";     // SQL is sampling-only, always an estimate
  attribution: "object-method" | "ancestor-fallback"; // which resolution path fed it
}
// on DetectedPattern:
sqlEvidence?: SqlEvidence;
sqlRank?: number;                     // = totalSampledCostUs; a SEPARATE ordering signal
```

### Activity corroboration (Component 2, batch path)

A separate, profile-level type — **not** merged into per-finding evidence (granularity mismatch):

```typescript
export interface SqlActivityCorroboration {
  measuredSqlCount: number;          // manifest.sqlCallCount   (MEASURED)
  measuredSqlDurationMs: number;     // manifest.sqlCallDuration (MEASURED)
  sampledAttributedCostUs: number;   // Σ all SQL selfTime in this profile (double-count-guarded)
  activityDurationMs?: number;
  alExecutionDurationMs?: number;
  measuredHttpDurationMs?: number;
  unaccountedMs?: number;            // activityDuration − alExec − sql − http, when all present
}
```

Attaches to the per-profile `AnalysisResult` where a manifest exists. Single-profile captures have no manifest → absent.

## Component 1 — attach per-finding evidence

A new pass `attachSqlEvidence(patterns, profile, sqlByRoutine)` runs in `analyzeProfile` **after** detectors and **before** `sortPatterns`:

1. For each pattern, resolve the routine that *issues* its evidence SQL via a per-pattern `anchorIndex` into `involvedMethods` (the loop-owning routine and the SQL-issuing routine differ for some detectors). Resolve that entry to the canonical `${functionName}_${objectType}_${objectId}` key (thread the key rather than re-parsing the display string; the plan decides).
2. Look up that routine's SQL in `sqlByRoutine`; filter to the op-types that are evidence for *this* pattern id (rule map below). If none match, leave `sqlEvidence` unset — **silent, never negative**.
3. Set `sqlEvidence` (top-5 by cost) and `sqlRank = totalSampledCostUs`. Do **not** touch `impact`.

Per-detector rule map (`SQL_EVIDENCE_RULES`), small and curated like `CORROBORATION_MAP`, each entry carrying `anchorIndex`:

| Pattern id | `anchorIndex` | Evidence op-types |
|---|---|---|
| `missing-setloadfields`, `incomplete-setloadfields`, `unfiltered-findset`, `unindexed-filter` | 0 | `SELECT` |
| `calcfields-in-loop` | 0 | `SELECT`/`COUNT` with an aggregate (`SUM`/`COUNT`/`AVG`/`MIN`/`MAX`) |
| `modify-in-loop` | 0 | `UPDATE` |
| `insert-in-loop` | 0 | `INSERT` |
| `delete-in-loop` | 0 | `DELETE` |
| `record-op-in-loop` | 0 | any DML |
| `high-hit-count` | 0 | any SQL under the routine, grouped by normalized statement |
| `repeated-siblings` | **1** | repeated normalized SQL — `involvedMethods = [parent, representativeChild]`; the SELECT is issued by the **child** `[1]` |

`anchorIndex` matches what fusion already verified in `CORROBORATION_MAP`. A pattern id absent from the map gets no SQL evidence (same "not in the map ⇒ no signal" discipline). Note: source-only detectors (`nested-loops`, `external-call-in-loop`, `unindexed-filter`, …) **do not run in the analyze path** (`analyzer.ts:218,228` run `runDetectors` + `runSourceDetectors` only, never `runSourceOnlyDetectors`), so most of them will not be present to annotate here — that is expected, not a gap this spec closes.

## Component 2 — activity corroboration

A new pass `buildSqlActivityCorroboration(profile, sqlByRoutine, manifest)` runs when a manifest is present (batch path). It reads the measured fields, sums the profile's SQL selfTime (each `(object,method)` counted once — the double-count guard), and computes `unaccountedMs` when all four inputs exist. Result attaches to the per-profile `AnalysisResult`; `batch-analyzer.ts` threads the manifest in. No detector, no finding — this is a displayed corroboration banner, and `unaccountedMs` is **shown, not raised as a finding** in v1.

## Pipeline / data flow

```
analyzeProfile(path, opts):
  processed    = process(raw)                       # unchanged
  patterns     = runDetectors [+ runSourceDetectors]# unchanged
  sqlByRoutine = buildSqlByRoutine(processed)       # NEW (primitive; no-op if no SQL nodes)
  attachSqlEvidence(patterns, processed, sqlByRoutine)  # NEW (Component 1; sets sqlEvidence + sqlRank)
  patterns     = sortPatterns(patterns)             # unchanged (impact-sorted; sqlRank is a separate view)
  fingerprintPatterns(patterns, ...)                # unchanged — evidence is not identity
  # batch path only:
  activityCorroboration = buildSqlActivityCorroboration(processed, sqlByRoutine, manifest)  # NEW (Component 2)
```

Guard: the whole enrichment is skipped (no-op) unless `sourceFormat` is sampling V8 **and** SQL nodes exist. ir-json → no SQL → both layers absent. No profile at all (source-only static analysis) → empty map, silent.

## Identity / fingerprint safety (non-negotiable)

`sqlEvidence`, `sqlRank`, and `SqlActivityCorroboration` are **descriptive metadata, never identity**. Fingerprints are minted by `fingerprintPatterns` from the anchor; `identityTokens()` reads only `(patternId, appId, canonicalObjectType, objectNumber, normalizedRoutineName)`. The evidence pass touches none of them, and **does not set `impact`**. A test pins that finding fingerprints are byte-identical with and without the pass. `FINGERPRINT_ALGO_VERSION` does not change.

## Output / formatter parity

- Per-finding `sqlEvidence` renders inline in the **existing** patterns section of every formatter (terminal/json/markdown/html) and the `analyze_profile` MCP tool: statement, `×executionCount`, sampled cost, and a `sampled-estimate` marker so a reader never mistakes it for a measured duration. Updates the existing pattern renderers; parity is compile-enforced by `SectionRenderers<T>`.
- `SqlActivityCorroboration` is a **new** section added to `SECTION_ORDER` and `BATCH_SECTION_ORDER`, with a renderer in all four formatters + batch formatters — compile-enforced by `SectionRenderers<T>` / `BatchSectionRenderers<T>`.

## Non-goals (explicit)

- **Refutation / suppression** — deferred; v1 never downgrades a finding.
- **"Runtime-confirmed" fusion tier** — dropped from the prior draft; sampled SQL is correlation, not causation.
- **Rows-read / `sqlExecutes` / query plans / measured per-statement duration** — telemetry (RT0005/report) and OnPrem (Query Store/XE) fields, not in profiles. Separate features (see the enrichment opportunity map in the research doc).
- **RT0005 telemetry SQL ingest** — separate spec (project 2 of 2).
- **Semantic SQL parsing** beyond literal-blanking (N+1 grouping) and table extraction. No column counting (that is a refutation prerequisite — deferred with it).
- **Database Locks / Query Store / Database Index enrichments** — independent features from the same sweep; each its own spec.

## Known constraints (from source verification)

- Attribution granularity is **method-level**, not exact call-site — findings carry no node handle. Multiple findings on one method share its SQL; the double-count guard keeps profile-level totals honest.
- **ir-json carries no SQL** → per-finding evidence and activity corroboration are both absent there; op-count-as-exact does not apply to SQL.
- **Source-only detectors are not run** in the analyze path, so their findings are generally not present to annotate.

## Testing (fixtures are a first-class deliverable)

No existing fixture has a call tree with SQL child nodes under AL routines with a manifest, so the fixtures must be built.

- **Fixtures:** the real `test/fixtures/batch-recorded/profile-1..4.alcpuprofile` (181/488 SQL nodes) plus a `manifest.json` (`sqlCallCount:1381, sqlCallDuration:382`), and a minimal ir-json fixture. Cover: a `SELECT` under a `missing-setloadfields` routine (attributed); N identical `SELECT`s under a `repeated-siblings` parent (grouped, anchored to child `[1]`); an aggregate `SELECT` under `calcfields-in-loop`; an `UPDATE` under `modify-in-loop`; a SQL node under a *callee* of the finding's routine (must NOT attribute to the finding — pins nearest-ancestor/scriptId resolution); a routine with no SQL (silent); a SQL node with no object + no AL ancestor (→ unattributed bucket, surfaces in the activity total, not lost).
- **Unit tests:** `buildSqlByRoutine` (scriptId-primary vs ancestor-fallback, param-normalized grouping, unattributed bucket), the rewritten table parser (`Company$Table`, `Company$Table$guid`, `[System Table]`, 128-char overflow → `null`), `attachSqlEvidence` (per-detector rule + anchorIndex matching; `impact` untouched; `sqlRank` set), `buildSqlActivityCorroboration` (measured vs sampled, unaccounted-time math, double-count guard), and the **ir-json → no evidence** negative.
- **Identity pin:** finding fingerprints unchanged by the evidence pass.
- **Corpus/mutation discipline:** run detectors over every fixture before/after — the only deltas are added `sqlEvidence`/`sqlRank`/activity section; no fingerprint moves, no finding appears/disappears. Every new behavior pinned so breaking it reddens a test (ancestor→caller: red; drop a rule-map entry: red; provenance hardcoded wrong: red; impact mutated: red).

## Risks

- **SQL-frame recognition is regex-on-functionName.** SQL in a shape `SQL_PREFIX_RE` misses is silently uncorrelated (under-report, never a false claim — no worse than today). Widen via fixture-driven follow-up if real profiles show it.
- **Anchor-key round-trip.** Resolving `involvedMethods[anchorIndex]` to a routine key must exactly match `aggregateByMethod`'s key; a mismatch means silent non-correlation. Prefer threading the key over re-parsing the display string; pin with the fixtures.
- **Param-normalization false-merge.** Over-blanking could merge two different queries. Conservative literal-only blanking keeps this small; the N+1 fixture pins that identical shapes merge and the callee fixture pins that different trees don't.
- **scriptId/appDef not always populated.** When absent, attribution falls back to ancestry; when the tree parent is a builtin with no AL ancestor, the SQL lands in the unattributed bucket (visible in the activity total, never silently dropped).
