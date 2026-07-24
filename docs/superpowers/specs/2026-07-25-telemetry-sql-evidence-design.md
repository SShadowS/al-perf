# Telemetry SQL Evidence — Design (project 2 of 2)

**Date:** 2026-07-25
**Revision:** 2
**Status:** design approved; blocked on Gate 0 (live telemetry probe) before a plan is written
**Scope:** project 2 of 2 — the telemetry-side counterpart to the shipped profile-side SQL evidence
layer v1 (`docs/superpowers/specs/2026-07-16-sql-evidence-layer-design.md`). Profile-side behavior
is untouched by this design.
**Grounding:** `docs/superpowers/research/2026-07-16-bc-sql-evidence-sources.md` (BC source +
real-capture inventory), plus two rounds of three-model adversarial review — round 1 over the design
before it was written down (`.panel/*-telemetry-sql.md`), round 2 over revision 1 of this file
(`.panel/*-telemetry-sql-r2.md`).

**What revision 2 changes.** Round 2 confirmed every file:line claim in revision 1 as accurate, and
then found that the integration story was missing. Rewritten: §4 (the RT0005 identity migration now
has a transport, a reconstruction rule, and a one-to-many policy), §6 (redaction now covers every
table reference), §8 (new — how evidence actually reaches an issue body, which revision 1 never
specified), §9 (availability now requires changing the puller's failure model). Corrected: the
`attribution` contradiction, the `threshold`-required-versus-unknown contradiction, and an
overstated claim about compile-enforced formatter parity.

---

## Problem

Profile-side v1 answers "which SQL statements sit under this finding?" for a sampling
`.alcpuprofile`, and answers it in **sampled estimates** — a sampling profile's `hitCount` is a
sample count, never an invocation count, and its SQL nodes carry no duration at all (research doc,
"What the SAMPLING payload actually contains").

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
3. **Probe before building** (Gate 0).
4. **Normalize and redact at ingest; raw statement text is never persisted.**
5. **One shared evidence type, not a parallel telemetry type** — implemented as a discriminated
   union (§5).
6. **Per-tenant signal availability is recorded**, so "signal absent" is distinguishable from
   "no slow SQL".
7. **Second KQL query for statement rows; normalization and the join happen in TypeScript**, not in
   KQL. Redaction must be testable by `bun test` and must exist exactly once.

---

## 1. Gate 0 — the probe (blocking)

Nothing is built until one discovery query against live App Insights answers the following, with the
answers recorded in the research doc. Revision 1 of this design assumed field names the
documentation does not support; this gate exists so that never happens twice.

| Question | Why it blocks |
|---|---|
| Does RT0005 carry `alMethod`? | Documentation says no. The routine join depends on the answer. |
| Does `customDimensions.sqlStatement` exist, and is it the SQL text? | The entire feature rests on this one field. |
| Exact `alStackTrace` grammar (header lines + `AL CallStack:` frame format) | The method name must be parsed out of it (§4.3). |
| Does `customDimensions.executionTimeInMs` exist? | The **shipped** puller already reads it (`src/lifecycle/appinsights.ts:197-198`) and the only thing pinning it is a KQL **snapshot** test (`test/lifecycle/appinsights.test.ts:97`) — which asserts the query string, not that Azure returns the column. Microsoft's own KQL derives ms from the `executionTime` timespan. If the column does not exist, `asDurationMs` throws (`appinsights.ts:258-262`) and every pull is already broken. |
| Is `longRunningThreshold` present per row? | Decides whether `threshold` is measured or falls back to config (§5). |
| Are RT0018 `sqlExecutes` / `sqlRowsRead` present, and on which BC version? | Documented from v22.0; absent must never be read as zero (§11). |
| Statement naming: does a 3-part `"DB".dbo."Company$Table"` form appear? What marks truncation? | Both defeat the current table parser and the current literal blanking (§6). |
| Row volume and stack-shape stability for one window | §10's grouping key is `alStackTrace`; fragmented stacks fragment the groups and make per-routine top-N misbehave. |

The probe query itself is part of this design, not left to the implementer:

```kql
traces
| where timestamp > ago(24h)
| where customDimensions.eventId in ("RT0005", "RT0018")
| extend eventId = tostring(customDimensions.eventId)
| summarize
    rows = count(),
    dimensionKeys = make_set(bag_keys(customDimensions), 200),
    sampleStack = any(tostring(customDimensions.alStackTrace)),
    sampleStatement = any(tostring(customDimensions.sqlStatement))
  by eventId
```

`bag_keys` answers the field-set questions directly rather than by inference. Gate 0's output is a
committed, redacted fixture (§12) plus a field table in the research doc.

**What Gate 0 cannot answer:** the stack grammar of rows minted *months ago*, which is the `from`
side of the migration in §4. That is why §4 reconstructs old identities from the adapter's own
legacy algorithm rather than from probe data, and why its dry run is mandatory.

## 2. Scope

- RT0005 slow-statement rows become `sqlEvidence` on telemetry findings.
- RT0018 rows additionally carry `sqlExecutes` / `sqlRowsRead` onto their own findings.
- Nothing profile-side changes: no existing type field changes meaning, no existing query changes
  shape, no existing fingerprint moves except the deliberate RT0005 identity fix in §4.

## 3. Non-goals

- **RT0009 all-statement trace.** Out of scope for v1, and named here for what it is: the future
  *threshold-free* telemetry SQL lane. RT0005 is not "the" telemetry SQL source; it is the
  threshold-gated one.
- **Cross-source join to profile findings.** Deferred; the routine key built in §4 is the piece that
  would make it possible later.
- **Refutation or suppression.** Evidence never downgrades, closes, or reprioritizes a finding.
- **Per-statement rows-read.** BC does not emit it. Rows-read exists only at object granularity
  (RT0018/RT0006/RT0008).
- **Raw statement retention.**
- **Operation-level causality.** RT0018's slow method and RT0005's slow statement inside the same
  window are not provably the same execution. Evidence is window- and routine-level, and every
  rendering says so.
- **Closing issues orphaned by a merge-mode migration** (§4) — reported, not automated.

## 4. Routine key, stack parsing, and the RT0005 identity migration

### 4.1 The join key

Telemetry finding identity is minted over `(signalId, appId, objectType, objectNumber, routineName)`
— `computeTelemetryFingerprint`, `src/lifecycle/fingerprint.ts:362-379`. **`signalId` is part of
it**, so an RT0005 row keyed on that identity can only ever reach an RT0005 finding.

v1 introduces a separate join key:

```
telemetryRoutineKey(appId, objectType, objectId, methodName)
  = normalizeAppGuid(appId)
  + canonicalObjectType(objectType)
  + objectId
  + normalizeTriggerName(methodName).toLowerCase()
```

Same normalizers as the fingerprint, so the two never disagree on casing or trigger spelling, and
**`signalId` is deliberately omitted** — commented as such at the definition. Evidence attaches to
every finding sharing the routine key, RT0018 and RT0005 alike.

### 4.2 Where the join executes

**In the adapter, `src/lifecycle/appinsights.ts`, before the batch document is emitted.** This
follows from fixed decision 5 above: `TelemetrySignal` carries `sqlEvidence`, so by the time
`telemetry-parser.ts` sees a signal the join has already happened. The adapter runs both queries,
parses stacks, builds routine keys, redacts, and attaches. The parser never queries anything.

### 4.3 The stack parser

RT0005 documents no `alMethod`. The method comes from `alStackTrace`.

The current fallback takes the stack's first line (`buildSignalFromRow`,
`src/lifecycle/appinsights.ts:293-298`). Microsoft's documented RT0005 sample begins with header
lines (`AppObjectType: …`, `AppObjectId: …`) before `AL CallStack:`, so line 0 is the header, not a
method. `parseAlStackFrame()` replaces it: skip headers, take the first `AL CallStack:` frame,
extract the method name from the frame grammar.

### 4.4 The migration: transport

Fixing the parse re-mints RT0005 identities. Revision 1 asserted a `FingerprintMigration` would be
"emitted" without saying by what. The path, end to end:

1. **Adapter** computes *both* names for every RT0005 row: the fixed `methodName` via
   `parseAlStackFrame`, and `legacyMethodName` — the value the **old** algorithm would have
   produced, by literally applying it: `stackTrace.split(/\r?\n/)[0].trim()`. `TelemetrySignal`
   gains `legacyMethodName?: string`, optional and additive, omitted when it equals `methodName`.
2. **Parser** (`parseTelemetryBatch`) mints the new fingerprint as today and, when
   `legacyMethodName` is present, mints the old one from the same inputs with `routineName =
   legacyMethodName`. Each distinct pair becomes an `IdentityUpgrade`
   (`src/lifecycle/fingerprint.ts:479-485`). `ParsedTelemetryBatch` gains
   `identityUpgrades: IdentityUpgrade[]`.
3. **`evaluateTelemetryBatch`** (`src/lifecycle/telemetry.ts:20-37`) calls
   `applyIdentityUpgrades(store, run.tenant, parsed.identityUpgrades, appliedAt)` **before**
   `evaluateRun`, mirroring the ordering the fusion path already uses
   (`src/cli/commands/lifecycle.ts:756-790`). This is the single choke point — all three CLI call
   sites and the web ingest handler route through it, so none of them needs to change.

`applyIdentityUpgrades` already reduces to `store.applyFingerprintMigration(..., "identity-upgrade",
...)` (`src/lifecycle/evaluate.ts:279-292`), which renames or merges, rekeys `sink_issue_map` so
open GitHub/ADO issues keep routing, and records a no-op when the tenant never saw the old identity.

### 4.5 The migration: one-to-many policy

The old `methodName` was the stack's **header** line, which is roughly constant per object — so all
of an object's slow statements collapsed into a single old RT0005 finding. After the fix, one old
fingerprint maps to **N** new ones, while `FingerprintMigration` is one-to-one.

Policy, deterministic by construction:

- Group upgrades by `from`. Where N > 1, the migration targets the new finding with the highest
  `impact`; ties break on the fingerprint string ascending. The remaining N−1 file as new findings.
- Never first-applied-wins: the order signals arrive in must not decide which finding inherits the
  history and the open issue.
- Every collapse is listed in the dry-run report (§4.6) with all N candidates and the winner.

### 4.6 The migration: dry run is mandatory

`lifecycle telemetry` and `lifecycle pull-telemetry` gain `--dry-run-migrations`, which computes and
prints the migration table — `from`, `to`, rename/merge/no-op, and every one-to-many collapse — and
applies nothing. Running it before the first real apply on a tenant is a documented prerequisite,
not a suggestion.

Two honest limits, both surfaced by the dry run rather than discovered later:

- If a tenant's stored RT0005 findings were minted from a stack shape the legacy algorithm no longer
  reproduces, the migration simply no-ops: the old finding ages out through normal absence handling
  and the new one files fresh. History is lost for that finding, not corrupted.
- If both old and new findings are active *and* both already have sink mappings, merge keeps the
  `to` mapping and drops the `from` one, orphaning the old external issue — it is neither closed nor
  commented. The dry run lists these; closing them is out of scope (§3).

### 4.7 `FINGERPRINT_ALGO_VERSION` is not bumped

RT0018 identities are untouched, so the stale-algo guard in `evaluateRun` must not fire. A bump
would re-file every finding in every namespace for a change affecting one signal. The corollary is
that no guard protects this path either: if migrations are not emitted, old RT0005 findings rot into
`resolved` while duplicates file. §4.6's dry run is the compensating control.

## 5. Evidence type — one shared type, discriminated

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
- `attribution: "telemetry-stack"` — a constant. Every telemetry statement resolves through the same
  stack-parse tier, so there is nothing to mix; merging two telemetry blocks never changes it.
  (Revision 1 contradicted itself by also assigning `"mixed"` on merge.)
- `threshold?: { minMs: number; maxMs: number }` — populated from the per-row `longRunningThreshold`
  when Gate 0 confirms that field exists. **Optional**, because Gate 0 has not yet confirmed it; when
  absent, renderers fall back to the operator-declared default in lifecycle config and say so.
  (Revision 1 made it required while simultaneously listing its source as unknown.)

The discrimination is the safety mechanism where the compiler can enforce it — but **only where the
compiler is involved**, which revision 1 overstated:

- `terminal.ts`'s `renderSqlEvidence` reads `totalSampledCostUs` / `sampledCostUs` unnarrowed and
  **does** compile-break. Good.
- `json.ts` is `JSON.stringify` and the MCP surface only sorts and serializes — **neither breaks**.
  `SectionRenderers<T>` enforces one renderer per *section*, not exhaustiveness inside a field.
- Therefore: a shared `isTelemetrySqlEvidence(e)` narrowing helper, plus explicit tests that a
  measured block never renders under a sampled label in any of the four formatters and the MCP
  output. Tests, not the compiler, are the guarantee on the stringify surfaces.

**Ranking stays in one unit — microseconds.** Telemetry sets `sqlRank = totalMeasuredMs * 1000`, so
`bySqlRankDesc` (`src/semantic/sql-evidence.ts:29-31`) never compares µs against ms. Note the
consequence: RT0005 is threshold-gated at ~750 ms, so telemetry ranks start around 750,000 µs and
will usually dominate a mixed `--sort sql` list. That is expected and documented, not a defect.
`sqlRank` remains a rank signal only: never `impact`, never severity, never identity.

## 6. Redaction — a canonical redacted form

`normalizeSqlShape` (`src/core/sql-node.ts:64-68`) blanks single-quoted literals and bare numbers.
It was built for query-**shape grouping**, not as a privacy boundary, and telemetry findings drive
the GitHub and Azure DevOps sinks — so anything attached to them can land in an issue tracker.

`redactSqlForSink()` runs in the adapter, before anything is stored:

1. **Strip the company/database prefix from EVERY table reference** — not just the first `FROM`.
   `FROM`, every `JOIN`, `INTO`, `UPDATE`, `MERGE … USING`, `OUTPUT … INTO`, CTE bodies and
   subqueries. BC physical names embed the company (`dbo."CRONUS Danmark A_S$Sales Header"`), and
   Microsoft's RT0005 sample shows the 3-part `"SQLDATABASE".dbo."COMPANY$Table$guid"` form. The
   company and database names are customer-identifying and never survive.
2. **Fix `parseSqlTable` for 3-part names.** Its `FROM` regex (`src/core/sql-node.ts:100`) matches
   the first quoted segment, which for a 3-part name is the **database**. The `INTO` / `UPDATE` /
   `MERGE` variants (`:92`, `:94`, `:96`) share the shape and the fix.
3. **Retain the logical table name and extension GUID as separate fields.** This is a deliberate
   privacy decision, stated so it can be challenged: a BC table name is schema, not customer data,
   and without it the evidence is not diagnostic. Company, database and literal values are not
   retained in any form.
4. **Collapse column lists** past five named columns, rendering the remainder as `…+N more`, and
   keep the full column count as a number — the count is exactly what makes
   `missing-setloadfields` legible.
5. **Strip comments.**
6. **Blank literals, including the forms the profile-side regex misses**: `N'…'` unicode literals
   and `0x…` hex literals, neither of which the bare-number regex touches.
7. **Handle truncation.** RT0005 truncates `sqlStatement` at 8192 characters; a cut inside a string
   literal leaves an unclosed quote, so the blanking regex (`/'(?:[^']|'')*'/g`) stops matching and
   the raw literal survives. A truncated statement has its trailing partial dropped and is flagged
   `truncated: true`.
8. **`alStackTrace` is never stored** — only the parsed method name. The stack carries object names,
   method names, extension names, publishers and line numbers.

Exactly one implementation, in TypeScript, with the fixture corpus in §12. None of it in KQL.

## 7. Wire contract and parser

`TelemetrySignal` gains four optional fields — `sqlEvidence?`, `sqlExecutes?`, `sqlRowsRead?`, and
`legacyMethodName?` (§4.4). `TelemetryBatchDocument` gains optional `signalAvailability?` (§9).
`ParsedTelemetryBatch` gains `identityUpgrades`. All wire additions are optional and additive, so
`TELEMETRY_BATCH_SCHEMA_VERSION` stays `1` per the stated policy (`src/types/telemetry.ts:1-10`,
mirroring ir-json §3.7): a producer that omits them emits a valid v1 batch.

Two consequences that are easy to assume away:

- **The parser does not pass unknown fields through.** `validateSignal`
  (`src/core/telemetry-parser.ts:184-196`) builds a fresh object from named fields only, so evidence
  does not survive the parser until it is extended — with fail-closed validators matching the
  module's existing discipline: `sqlExecutes` / `sqlRowsRead` non-negative integers, `sqlEvidence`
  shape-validated, an unknown `provenance` rejected rather than passed on.
- **Merge semantics are required.** `buildMergedPattern` (`src/core/telemetry-parser.ts:336-381`)
  merges same-fingerprint signals across client types and carries no SQL fields today. Defined
  behavior: union statements by redacted text, sum `occurrences` and `measuredTotalMs`, take the max
  of maxima, widen `threshold` to cover all constituents, sum `sqlExecutes` / `sqlRowsRead` while
  treating `undefined` as unknown rather than zero. `attribution` stays `"telemetry-stack"` — every
  telemetry statement resolves through the same tier, so a merge cannot mix tiers. Statement rows
  for a routine whose signal row was skipped (empty-identity skip, `appinsights.ts:303-305`) are
  dropped, never minted into a finding.

Widening `SqlEvidence` changes the public `DetectedPattern` shape, and therefore the analysis JSON
and MCP output — an output-contract change even though the telemetry-batch contract stays v1. It is
additive: a new variant, no existing field altered.

## 8. How evidence reaches an issue body

Revision 1 designed a redactor for a pipe that does not exist. The pipe, as it stands:

`collectFindings` persists `details: JSON.stringify({ evidence, suggestion })`
(`src/lifecycle/evaluate.ts:221`) — `evidence` being the **string** field of `DetectedPattern`.
`triggers.ts:156-157` reads `occDetails.evidence` **only when it is a string**. GitHub fences it;
Azure DevOps escapes it into `<pre>`. Structured `sqlEvidence` is never persisted and never reaches
a sink.

Decision: **the redacted statements are formatted into `DetectedPattern.evidence`**, the string that
already survives the database round-trip.

- `buildSinglePattern` / `buildMergedPattern` (`src/core/telemetry-parser.ts:303-381`) append a
  compact block to the existing evidence line: up to **three** statements, each ≤200 characters,
  each with its `occurrences` and `measuredTotalMs`, followed by the provenance and threshold
  caveat, and — when the signal was unavailable or truncated — one line naming that (§9).
- The structured `sqlEvidence` object stays in memory for the formatters, JSON and MCP, and is
  **documented as not persisted**: historical trends and sinks see the string form only.
- Because the string is what reaches an external tracker, `redactSqlForSink` runs before the string
  is built, and the string is assembled only from already-redacted text. There is no path from raw
  statement text to `evidence`.

This is also why the cap is three rather than five: an issue body is read by a human, and the full
set still drives the totals.

## 9. Availability, and the puller's failure model

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

**The puller's failure model must change for this to mean anything.** Today `fetchSignalTable`
throws on a non-OK response and `pullTelemetry`'s per-signal loop has no catch
(`src/lifecycle/appinsights.ts:496-498, 516-529`) — so a failed RT0005 query produces *no batch at
all*, not a batch that records the failure. v1 changes it to per-signal capture: a failing signal
records `{ queried: true, rows: 0, error }` and the pull continues with the signals that worked.
**If every signal fails, the pull still throws** — a bad API key or app id must stay loud.

Rendering rule:

> A finding renders "no slow statement crossed the threshold" **only** when availability shows the
> signal was queried, returned without error, and was not truncated. Otherwise the rendering names
> the actual reason.

Availability reaches a rendered issue the same way evidence does (§8): as a line in the evidence
string. The structured array stays on the batch for the CLI, JSON and the digest, which reports
which signals were unavailable per tenant.

## 10. KQL and budgets

The statement query groups by `(extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement)`:

- **No `alMethod`** — not a documented RT0005 dimension.
- **`alStackTrace` is a grouping key, not `any(stackTrace)`.** The existing per-signal query
  summarizes first and carries `stackTrace = any(stackTrace)` (`src/lifecycle/appinsights.ts:211`),
  which for several statements under one object picks an arbitrary stack — enough to attribute
  statements to the wrong method of the right object.
- **Top-N per routine, not global** (`top-nested` over the routine key), so one noisy routine cannot
  crush every other routine's only statement. Any truncation is reported through
  `signalAvailability`, never silently.
- Five statements per finding in the structured block, three in the persisted string (§8); the full
  set drives the totals either way.
- The existing per-signal query keeps its exact current shape (it is snapshot-pinned) apart from the
  additive `sqlExecutes` / `sqlRowsRead` extends. Those columns are null for RT0005, which is
  expected — they land only on RT0018 findings.

## 11. Version floors

RT0018 `sqlExecutes` / `sqlRowsRead` are documented from BC v22.0. Absent means **unknown**, never
zero: the fields stay `undefined` and render as "not reported by this environment". Same rule for
any dimension Gate 0 finds missing on a given tenant.

## 12. Testing

- **Fixtures are a deliverable.** Gate 0's probe payload becomes a committed, redacted fixture, so
  the pipeline pins run on a clean checkout.
- **Identity pins:** RT0018 fingerprints byte-identical before and after; the RT0005
  `identity-upgrade` emitted once per pair and idempotent on re-run; one-to-many collapse resolves
  to the same winner regardless of signal order; `FINGERPRINT_ALGO_VERSION` unchanged; a tenant with
  no old identity records a no-op and files fresh.
- **Invariant pins:** no new field alters `impact`, severity, or state.
- **Type pins:** `terminal.ts` narrows before reading variant fields; JSON and MCP output for a
  telemetry finding never contains a sampled label (test-enforced, since the compiler cannot).
- **Redaction corpus:** 3-part database-qualified name; `Company$Table`; `Company$Table$guid`;
  `[System Table]`; a multi-table `JOIN`; a subquery and a CTE; `MERGE … USING`; a statement
  truncated mid-literal (unclosed quote); `N'…'` and `0x…` literals; a comment-bearing statement; a
  47-column `SELECT`.
- **Sink-path pin:** a telemetry finding's persisted `evidence` string contains the redacted
  statements and no company or database name, asserted at the `occurrences.details` boundary — the
  last point before an external tracker.
- **Availability pins:** "not queried", "error", "truncated" and "queried and empty" each render
  distinct text; one failing signal does not abort a pull; all signals failing does.
- **Merge pins:** two client-type constituents each carrying evidence merge per §7 — no drop, no
  double-count.
- **Rank pin:** telemetry and profile findings sort coherently in one surface.

## 13. Known constraints

- RT0005 is threshold-gated: BC online sends statements over ~750 ms; on-prem
  `SqlLongRunningThreshold` defaults to 1000 ms and is server-configurable. **Absence of evidence is
  never evidence a routine issues no SQL.**
- Statement text is truncated by the platform at 8192 characters.
- Attribution is routine-level, from a stack frame — not a call-site handle. Several findings on one
  routine share its statements.
- RT0005 and RT0018 rows are correlated by routine and window, not by execution (§3).
- Structured `sqlEvidence` is not persisted; the lifecycle store and the sinks see the string form
  (§8).
- Overlapping pull windows (a cron shorter than `--since`, default `1h`, `appinsights.ts:36`)
  re-observe the same statements. This already affects `count` today; evidence makes it more
  visible. v1 documents the interaction rather than deduplicating.

## 14. Risks

- **Gate 0 invalidates part of the design.** If `alStackTrace` has no parseable frame grammar on
  real rows, routine-level attribution degrades to object-level — and §4's migration loses its
  reason to exist along with it. Largest open risk; it is why Gate 0 blocks.
- **`executionTimeInMs` may not exist**, in which case the shipped puller has a latent failure and
  fixing it is a prerequisite rather than part of this work.
- **The migration rewrites live rows.** One signal's namespace, existing machinery, mandatory dry
  run — but still a rewrite, and the one-to-many collapse means some findings legitimately lose
  their history.
- **Redaction is a security boundary.** A miss ships customer-identifying SQL into an external
  tracker. The corpus in §12 is the mitigation and must grow with every real payload seen.
