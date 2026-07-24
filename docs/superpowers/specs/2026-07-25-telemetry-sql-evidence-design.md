# Telemetry SQL Evidence — Design (project 2 of 2)

**Date:** 2026-07-25
**Status:** design approved; blocked on Gate 0 (live telemetry probe) before a plan is written
**Scope:** project 2 of 2 — the telemetry-side counterpart to the shipped profile-side SQL evidence
layer v1 (`docs/superpowers/specs/2026-07-16-sql-evidence-layer-design.md`). Profile-side behavior
is untouched by this design.
**Grounding:** `docs/superpowers/research/2026-07-16-bc-sql-evidence-sources.md` (BC source +
real-capture inventory), plus a three-model adversarial review of the first draft of this design
(`.panel/anthropic-telemetry-sql.md`, `.panel/google-telemetry-sql.md`,
`.panel/openai-telemetry-sql.md`). Every correction that review produced is folded in below; the
draft it reviewed is superseded.

---

## Problem

Profile-side v1 answers "which SQL statements sit under this finding?" for a sampling
`.alcpuprofile`, and answers it in **sampled estimates** — a sampling profile's `hitCount` is a
sample count, never an invocation count, and its SQL nodes carry no duration at all
(research doc, "What the SAMPLING payload actually contains").

Business Central telemetry carries the other half: RT0005 emits the **text and measured duration**
of individual slow SQL statements, and RT0018 emits **measured SQL statement counts and rows-read**
per long-running AL method. al-perf already pulls both signals by default
(`DEFAULT_SIGNALS = ["RT0018", "RT0005"]`, `src/lifecycle/appinsights.ts:33`) and turns them into
lifecycle findings — but discards every SQL-bearing dimension on the way through.

This design attaches that measured evidence to the telemetry findings the tool already mints.

## Fixed decisions

Settled with the project owner before design; not revisited here.

1. **Evidence attaches to telemetry findings.** No cross-source join to profile findings in v1.
2. **Signals: RT0005 + RT0018.** RT0005 supplies statement text and measured duration; RT0018 rows,
   already being pulled, additionally yield `sqlExecutes` / `sqlRowsRead`.
3. **Probe before building.** The real `customDimensions` field set is verified against live
   App Insights first (this design promotes that from a first task to a blocking gate — see Gate 0).
4. **Normalize at ingest; raw statement text is never persisted.**
5. **One shared evidence type, not a parallel telemetry type** — implemented as a discriminated
   union (§4).
6. **Per-tenant signal availability is recorded**, so "signal absent" is distinguishable from
   "no slow SQL".
7. **Second KQL query for statement rows; normalization and the join happen in TypeScript**, not in
   KQL. Redaction must be testable by `bun test` and must exist exactly once.

---

## Gate 0 — the probe (blocking)

Nothing is built until one discovery query against live App Insights answers the following, with the
answers recorded in the research doc. The first draft of this design assumed field names that the
documentation does not support; this gate exists so that never happens twice.

| Question | Why it blocks |
|---|---|
| Does RT0005 carry `alMethod`? | Documentation says no. The entire routine join depends on the answer. |
| Exact `alStackTrace` grammar (header lines + `AL CallStack:` frame format) | The method name must be parsed out of it (§3). |
| Does `customDimensions.executionTimeInMs` exist? | The **shipped** puller already reads it (`src/lifecycle/appinsights.ts:197-198`) and the only thing pinning it is a KQL **snapshot** test (`test/lifecycle/appinsights.test.ts:97`) — which asserts the query string, not that Azure returns the column. Microsoft's own KQL derives ms from the `executionTime` timespan. If the column does not exist, `asDurationMs` throws (`appinsights.ts:258-262`) and every pull is already broken. |
| Is `longRunningThreshold` present per row? | Decides whether the threshold is one number or a range (§4). |
| Are RT0018 `sqlExecutes` / `sqlRowsRead` present, and on which BC version? | Documented from v22.0; absent must never be read as zero (§9). |
| Statement naming: does a 3-part `"DB".dbo."Company$Table"` form appear? What marks truncation? | Both defeat the current table parser and the current literal blanking (§5). |

Gate 0 output is a committed, redacted fixture (§10) plus a field table in the research doc.

---

## 1. Scope

A telemetry-side SQL evidence lane:

- RT0005 slow-statement rows become `sqlEvidence` on telemetry findings.
- RT0018 rows additionally carry `sqlExecutes` / `sqlRowsRead` onto their own findings.
- Nothing profile-side changes: no existing type field changes meaning, no existing query changes
  shape, no existing fingerprint moves except the deliberate RT0005 identity fix in §3.

## 2. Non-goals

- **RT0009 all-statement trace.** Out of scope for v1, and named here for what it is: the future
  *threshold-free* telemetry SQL lane. RT0005 is not "the" telemetry SQL source; it is the
  threshold-gated one.
- **Cross-source join to profile findings.** Deferred; the routine key built in §3 is the piece that
  would make it possible later.
- **Refutation or suppression.** Evidence never downgrades, closes, or reprioritizes a finding.
- **Per-statement rows-read.** BC does not emit it. Rows-read exists only at object granularity
  (RT0018/RT0006/RT0008).
- **Raw statement retention.** See §5.
- **Operation-level causality.** RT0018's slow method and RT0005's slow statement inside the same
  window are not provably the same execution. Evidence is window- and routine-level, and every
  rendering says so. Nothing in this design may imply "this statement caused this slow method".

## 3. Routine key, stack parsing, and the RT0005 identity fix

### The key

Telemetry finding identity is minted over `(signalId, appId, objectType, objectNumber, routineName)`
— `computeTelemetryFingerprint`, `src/lifecycle/fingerprint.ts:362-379`. **`signalId` is part of
it.** An RT0005 statement row joined on that identity can therefore only ever reach an
RT0005-minted finding, never the RT0018 finding for the same routine.

v1 introduces an explicit, separate join key:

```
telemetryRoutineKey(appId, objectType, objectId, methodName)
  = normalizeAppGuid(appId)
  + canonicalObjectType(objectType)
  + objectId
  + normalizeTriggerName(methodName).toLowerCase()
```

It reuses the same normalizers the fingerprint uses, so the two never disagree on casing or trigger
spelling, and it **deliberately omits `signalId`** — that omission is the feature, and it is
commented as such at the definition. Evidence attaches to every finding sharing the routine key,
RT0018 and RT0005 alike.

### The stack parser

RT0005 does not document an `alMethod` dimension. The method must come from `alStackTrace`.

The current fallback takes the stack's first line
(`buildSignalFromRow`, `src/lifecycle/appinsights.ts:293-298`). Microsoft's documented RT0005 sample
begins with header lines (`AppObjectType: …`, `AppObjectId: …`) before `AL CallStack:`, so line 0 is
not a method — it is the header. `parseAlStackFrame()` replaces it: skip headers, take the first
`AL CallStack:` frame, extract the method name from the frame grammar. Its output feeds both the
signal's `methodName` and the evidence attribution.

### The migration this forces

Because today's RT0005 findings carry the stack header line as `methodName`, that string is already
baked into their fingerprints. Fixing the parse **re-mints RT0005 identities**. That is handled, not
hidden:

- Each re-minted RT0005 finding emits a `FingerprintMigration` with reason `"identity-upgrade"`
  (`src/lifecycle/fingerprint.ts:449-464`), applied through the existing
  `LifecycleStore.applyFingerprintMigration` (`src/lifecycle/store.ts:1181`), which already handles
  rename vs merge and severity reconciliation.
- **`FINGERPRINT_ALGO_VERSION` is NOT bumped.** RT0018 identities are untouched, so the mass-orphan
  guard (`evaluateRun`'s stale-algo refusal) must not fire. A bump here would re-file every finding
  in every namespace for a change that affects one signal.
- The migration is emitted once per affected finding and is idempotent on re-run.

## 4. Evidence type — one shared type, discriminated

```ts
type SqlEvidence = ProfileSqlEvidence | TelemetrySqlEvidence; // discriminated on `provenance`
```

**`ProfileSqlEvidence`** is today's shape verbatim: `provenance: "sampled-estimate"`, required
`sampledHitCount` / `sampledCostUs` per statement, required `totalSampledCostUs` /
`totalSampledHitCount`, `attribution: "object-method" | "ancestor-fallback" | "mixed"`
(`src/types/patterns.ts:8-29`). No field becomes optional; no existing consumer changes.

**`TelemetrySqlEvidence`**:

- `provenance: "measured-threshold-gated"`
- per statement: redacted `text`, `operation`, logical `table`, `extensionAppId`, `occurrences`,
  `measuredTotalMs`, `truncated: boolean`
- block totals: `totalMeasuredMs`, `totalOccurrences`
- `attribution: "telemetry-stack"` — a constant on this variant, not a widened member of the profile
  variant's union
- `threshold: { minMs: number; maxMs: number }` — **required**, from the per-row
  `longRunningThreshold`, a range because it can vary between rows in one window

The discrimination is the safety mechanism: every consumer is compile-forced to narrow before
touching statement fields, so measured data cannot render under sampled labels. A loose
"optional sampled fields plus optional measured fields, exactly one pair populated" shape — the
first draft's proposal — is unenforceable and would either break required-field consumers or
zero-fill measured evidence into "× 0 sampled, 0µs".

**Ranking stays in one unit.** `sqlRank` is microseconds. Telemetry sets
`sqlRank = totalMeasuredMs * 1000`, so `bySqlRankDesc` (`src/semantic/sql-evidence.ts:29-31`) — a
bare numeric compare shared by CLI `--sort sql` and MCP `sort: "sql"` — never compares µs against
ms. `sqlRank` remains a rank signal only: it never feeds `impact`, severity, or identity.

## 5. Redaction — a canonical redacted form

`normalizeSqlShape` (`src/core/sql-node.ts:64-68`) blanks single-quoted literals and bare numbers.
It was built for query-**shape grouping**, not as a privacy boundary, and telemetry findings drive
the GitHub and Azure DevOps sinks — so anything attached to them can land in an issue tracker.

`redactSqlForSink()` runs at the adapter, before anything is stored:

1. **Strip the database/company prefix.** BC physical names embed the company:
   `dbo."CRONUS Danmark A_S$Sales Header"`, and Microsoft's RT0005 sample shows a 3-part
   `"SQLDATABASE".dbo."COMPANY$Table$guid"`. The company name is customer-identifying. The logical
   table and extension GUID are kept as separate fields; the prefix is dropped from the text.
2. **Fix `parseSqlTable` for 3-part names.** Its `FROM` regex
   (`src/core/sql-node.ts:100`) matches the first quoted segment, which for a 3-part name is the
   **database**, not the table. The `INTO` / `UPDATE` / `MERGE` variants (`:92`, `:94`, `:96`) have
   the same shape and need the same fix.
3. **Collapse column lists** past five named columns, rendering the remainder as `…+N more` — a
   47-column `SELECT` is diagnostic as "47 columns", not as 47 custom field names. The full column
   count is kept as a number, since it is exactly what makes `missing-setloadfields` legible.
4. **Strip comments.**
5. **Blank literals, and handle truncation.** RT0005 truncates `sqlStatement` at 8192 characters. A
   cut inside a string literal leaves an unclosed quote, so the blanking regex
   (`/'(?:[^']|'')*'/g`) no longer matches and the raw literal survives. A truncated statement has
   its trailing partial dropped and is flagged `truncated: true`.
6. **`alStackTrace` is never stored** — only the parsed method name. The stack carries object names,
   method names, extension names, publishers and line numbers.

Exactly one redaction implementation, in TypeScript, with a fixture corpus (§10). None of it lives
in a KQL string.

## 6. Availability on the wire

`TelemetryBatchDocument` gains:

```ts
signalAvailability?: Array<{
  signalId: string;
  queried: boolean;
  rows: number;
  truncated?: boolean;
  error?: string;
}>;
```

Without it, "no evidence" is unprovable — it could equally mean not queried, query failed, tenant
skipped, top-N truncated, schema mismatch, or join missed. With it:

> A finding renders "no slow statement crossed the threshold" **only** when availability shows the
> signal was queried, returned without error, and was not truncated. Otherwise the rendering names
> the actual reason.

The digest reports which signals were unavailable per tenant, so a silent gap reads as a known gap.

## 7. Wire contract and parser

`TelemetrySignal` gains three optional fields: `sqlEvidence?`, `sqlExecutes?`, `sqlRowsRead?`.
`TelemetryBatchDocument` gains optional `signalAvailability?`. All additive and optional, so
`TELEMETRY_BATCH_SCHEMA_VERSION` stays `1` per the stated policy (`src/types/telemetry.ts:1-10`,
mirroring ir-json §3.7) — a producer that omits them emits a valid v1 batch.

Two implementation consequences the first draft missed:

- **The parser does not pass unknown fields through.** `validateSignal`
  (`src/core/telemetry-parser.ts:184-196`) builds a fresh object from named fields only, so
  "parser copies evidence" is false until it is extended — with fail-closed validators matching the
  module's existing discipline (`sqlExecutes`/`sqlRowsRead` non-negative integers, evidence shape
  validated, unknown provenance rejected).
- **Merge semantics are required, not optional.** `buildMergedPattern`
  (`src/core/telemetry-parser.ts:336-381`) merges same-fingerprint signals across client types and
  carries no SQL fields today. Defined behavior: union statements by redacted text, sum
  `occurrences` and `measuredTotalMs`, take the max of maxima, widen `threshold` to cover all
  constituents, set `attribution` to `"mixed"` when constituents disagree. Statement rows for a
  routine whose signal row was skipped (empty-identity skip, `appinsights.ts:303-305`) are dropped,
  never minted into a new finding.

Widening `SqlEvidence` changes the public `DetectedPattern` shape, and therefore the analysis JSON
and MCP output — an output-contract change even though the telemetry-batch contract stays v1. It is
additive (a new variant, no existing field altered), and the formatter parity registries make every
renderer's handling compile-enforced.

## 8. KQL and budgets

The statement query groups by `(extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement)`:

- **No `alMethod`** — it is not a documented RT0005 dimension.
- **`alStackTrace` is a grouping key, not `any(stackTrace)`.** The existing per-signal query
  summarizes first and carries `stackTrace = any(stackTrace)`
  (`src/lifecycle/appinsights.ts:211`), which for several statements under one object picks an
  arbitrary stack — enough to attribute statements to the wrong method of the right object.
- **Top-N per routine, not global.** A global top-N lets one noisy routine crush every other
  routine's only statement. Any truncation is reported through `signalAvailability`, never silently.
- Five statements per finding, matching v1's display cap; the full set still drives the totals.
- The existing per-signal query keeps its exact current shape (it is snapshot-pinned) apart from the
  additive `sqlExecutes` / `sqlRowsRead` extends on RT0018.

## 9. Version floors

RT0018 `sqlExecutes` / `sqlRowsRead` are documented from BC v22.0. Absent means **unknown**, never
zero: the fields stay `undefined` and render as "not reported by this environment". The same rule
applies to any dimension Gate 0 finds missing on a given tenant.

## 10. Testing

- **Fixtures are a deliverable.** Gate 0's probe payload becomes a committed, redacted fixture, so
  the pipeline pins run on a clean checkout (the same discipline the profile-side layer needed).
- **Identity pins:** RT0018 fingerprints byte-identical before and after this change; the RT0005
  `identity-upgrade` migration emitted exactly once per finding and idempotent on re-run;
  `FINGERPRINT_ALGO_VERSION` unchanged.
- **Invariant pins:** no new field alters `impact`, severity, or state; a finding's rendered output
  differs only by the evidence block and rank.
- **Type pins:** discriminated-union exhaustiveness across all four formatters and the MCP surface;
  a measured block can never render under a sampled label.
- **Redaction corpus:** 3-part database-qualified name, `Company$Table`, `Company$Table$guid`,
  `[System Table]`, a statement truncated mid-literal (unclosed quote), a comment-bearing statement,
  a 47-column `SELECT`.
- **Merge pins:** two client-type constituents each carrying evidence merge per §7 — no drop, no
  double-count.
- **Availability pins:** each of "not queried", "error", "truncated", "queried and empty" renders
  its own distinct text.
- **Rank pin:** telemetry and profile findings in one sorted surface order coherently (one unit).

## Known constraints

- RT0005 is threshold-gated: BC online sends statements over ~750 ms; on-prem
  `SqlLongRunningThreshold` defaults to 1000 ms and is server-configurable. **Absence of evidence is
  never evidence a routine issues no SQL.** The `threshold` range makes this explicit per finding.
- Statement text is truncated by the platform at 8192 characters.
- Attribution is routine-level, from a stack frame — not a call-site handle. Several findings on one
  routine share its statements.
- RT0005 and RT0018 rows are correlated by routine and window, not by execution (§2).
- Overlapping pull windows (a cron shorter than `--since`, which defaults to `1h`,
  `appinsights.ts:36`) re-observe the same statements. This already affects `count` today; evidence
  makes it more visible. v1 documents the interaction rather than deduplicating.

## Risks

- **Gate 0 invalidates part of the design.** If `alStackTrace` has no parseable frame grammar on
  real rows, routine-level attribution for RT0005 is not achievable and the layer degrades to
  object-level. That is the single largest open risk, and it is why Gate 0 blocks.
- **`executionTimeInMs` may not exist.** If Gate 0 shows it does not, the shipped puller has a
  latent failure and fixing it is a prerequisite, not part of this work.
- **The RT0005 identity migration touches live findings.** It is one signal's namespace, applied
  through existing machinery, but it is still a rewrite of stored rows and warrants a dry-run
  report before the first real apply.
- **Redaction is a security boundary.** A miss ships customer-identifying SQL into an external issue
  tracker. The corpus in §10 is the mitigation and must grow with every real payload seen.
