# Telemetry SQL Evidence — Design (project 2 of 2)

**Date:** 2026-07-25
**Revision:** 3
**Status:** design approved; **Gate 0 PASSED 2026-07-25** on live BC telemetry (see the research doc's Gate 0 section) — implementation unblocked, with one shipped-code prerequisite (§1)
**Scope:** project 2 of 2 — the telemetry-side counterpart to the shipped profile-side SQL evidence
layer v1 (`docs/superpowers/specs/2026-07-16-sql-evidence-layer-design.md`). Profile-side behavior
is untouched by this design.
**Grounding:** `docs/superpowers/research/2026-07-16-bc-sql-evidence-sources.md` (BC source +
real-capture inventory), plus three rounds of three-model adversarial review
(`.panel/*-telemetry-sql*.md`).

**What revision 3 changes.**

- **The identity-migration apparatus is cut.** Revisions 1 and 2 designed machinery to migrate
  existing RT0005 findings onto corrected identities — a wire field, a deliberate re-run of the
  buggy parse, a one-to-many collapse policy, a dry-run CLI flag. There is nothing to migrate: the
  telemetry commands shipped in v3.0.0, but no lifecycle store with RT0005 findings exists. The
  stack-parse bug is still fixed (§4.2); identities simply change. One changelog line replaces a
  third of the spec.
- **The RT0005 signal query must change shape** (§10). Revision 2 claimed the existing per-signal
  query was unchanged while simultaneously requiring per-routine RT0005 findings; that query groups
  by `methodName` (empty for RT0005) and carries `stackTrace = any(stackTrace)`
  (`src/lifecycle/appinsights.ts:211-215`), collapsing exactly the rows this feature needs. No
  TypeScript parser can recover them afterwards.
- **Signal availability gates lifecycle state, not just rendering** (§9). A partial batch would
  otherwise accrue absence against the failed signal's findings and resolve them.
- **The evidence join happens per split group** (§10), after tenant grouping — a global join could
  attach one tenant's SQL to another tenant's finding and ship it to that tenant's issue tracker.
- Smaller corrections: the identity normalizers live in `src/semantic/identity.ts`; the persisted
  evidence string must be plain text (Azure DevOps escapes it into `<pre>`, GitHub fences it); the
  SQL and stack helpers get their own module so the adapter stays KQL-plus-wire.

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

## Module layout

One new module, `src/lifecycle/telemetry-sql.ts`, holds the pure logic: `parseAlStackFrame`,
`telemetryRoutineKey`, `redactSqlForSink`, and the statement grouping. `appinsights.ts` stays what it
is — the only KQL-aware module, translating queries to wire format — and calls into it. This keeps
SQL-shape knowledge out of the adapter and makes every rule in §4 and §6 unit-testable without a
fetch mock.

---

## 1. Gate 0 — the probe (blocking)

Nothing is built until one discovery query against live App Insights answers the following, with the
answers recorded in the research doc. Revision 1 assumed field names the documentation does not
support; this gate exists so that never happens twice.

**Gate 0 ran on 2026-07-25 and PASSED** (7-day window: RT0005 15,987 rows / 841 distinct stacks,
RT0018 17,073 / 1,381). Answers are in the research doc; the redacted probe output is committed at
`test/fixtures/telemetry/rt0005-probe.json`. Three results changed this design:

- **`executionTimeInMs` is effectively absent** — non-null on 0 of 17,045 RT0018 rows and 6 of
  15,957 RT0005 rows — and the shipped puller reads it, so `asDurationMs` throws and
  `lifecycle pull-telemetry` cannot have worked against real telemetry. **Fixing the duration
  extraction to `toreal(totimespan(customDimensions.executionTime))/10000` (100% non-null, both
  signals) is a prerequisite of this work, not a side effect.**
- **`longRunningThreshold` is present on 100% of rows** as a timespan, uniform per signal (RT0005
  750 ms, RT0018 1000 ms). §5's `threshold` will in practice always be populated from the adapter;
  it stays optional only for third-party producers.
- **Statements alias-qualify their columns** (`"50102"."Store No_" FROM dbo."COMPANY$Table$guid" "50102"`),
  so §6's redactor must handle an aliased FROM with alias references in the projection.

The stack grammar, `alMethod`'s absence from RT0005, RT0018's SQL counters, and stack fragmentation
(~19 RT0005 rows per distinct stack) all matched the design's assumptions.

| Question | Why it blocks |
|---|---|
| Does RT0005 carry `alMethod`? | Documentation says no. The routine join depends on the answer. |
| Does `customDimensions.sqlStatement` exist, and is it the SQL text? | The entire feature rests on this one field. |
| Exact `alStackTrace` grammar (header lines + `AL CallStack:` frame format) | The method name must be parsed out of it (§4.2). |
| Does `customDimensions.executionTimeInMs` exist? | The **shipped** puller already reads it (`src/lifecycle/appinsights.ts:197-198`) and the only thing pinning it is a KQL **snapshot** test (`test/lifecycle/appinsights.test.ts`) — which asserts the query string, not that Azure returns the column. Microsoft's own KQL derives ms from the `executionTime` timespan. If the column does not exist, `asDurationMs` throws (`appinsights.ts:258-262`) and every pull is already broken. |
| Is `longRunningThreshold` present per row? | Decides whether `threshold` is measured or falls back to config (§5). |
| Are RT0018 `sqlExecutes` / `sqlRowsRead` present, and on which BC version? | Documented from v22.0; absent must never be read as zero (§11). |
| Statement naming: does a 3-part `"DB".dbo."Company$Table"` form appear? What marks truncation? | Both defeat the current table parser and the current literal blanking (§6). |
| Row volume, and how many distinct `alStackTrace` values one routine produces per window | §10 groups on the stack; fragmented stacks fragment the findings themselves, not just their evidence. |

The probe query is part of this design, not left to the implementer:

```kql
traces
| where timestamp > ago(24h)
| where customDimensions.eventId in ("RT0005", "RT0018")
| extend eventId = tostring(customDimensions.eventId)
| summarize
    rows = count(),
    dimensionKeys = make_set(bag_keys(customDimensions), 200),
    distinctStacks = dcount(tostring(customDimensions.alStackTrace)),
    sampleStack = any(tostring(customDimensions.alStackTrace)),
    sampleStatement = any(tostring(customDimensions.sqlStatement))
  by eventId
```

`bag_keys` answers the field-set questions directly rather than by inference; `distinctStacks`
answers the fragmentation question §10's new grouping depends on. Gate 0's output is a committed,
redacted fixture (§12) plus a field table in the research doc.

## 2. Scope

- RT0005 slow-statement rows become `sqlEvidence` on telemetry findings.
- RT0018 rows additionally carry `sqlExecutes` / `sqlRowsRead` onto their own findings.
- The RT0005 stack-parse bug is fixed (§4.2), which changes RT0005 finding identities.
- Nothing profile-side changes: no existing type field changes meaning, no profile fingerprint moves.

## 3. Non-goals

- **RT0009 all-statement trace.** Out of scope for v1, and named for what it is: the future
  *threshold-free* telemetry SQL lane. RT0005 is not "the" telemetry SQL source; it is the
  threshold-gated one.
- **Cross-source join to profile findings.** Deferred; the routine key in §4.1 is what would make it
  possible later.
- **Migrating existing RT0005 findings** (§4.3).
- **Refutation or suppression.** Evidence never downgrades, closes, or reprioritizes a finding.
- **Per-statement rows-read.** BC does not emit it; rows-read exists only at object granularity
  (RT0018/RT0006/RT0008).
- **Raw statement retention.**
- **Operation-level causality.** RT0018's slow method and RT0005's slow statement inside the same
  window are not provably the same execution. Evidence is window- and routine-level, and every
  rendering says so.

## 4. Routine key and stack parsing

### 4.1 The join key

Telemetry finding identity is minted over `(signalId, appId, objectType, objectNumber, routineName)`
— `computeTelemetryFingerprint`, `src/lifecycle/fingerprint.ts:362-379`. **`signalId` is part of
it**, so a statement row keyed on that identity could only ever reach an RT0005 finding.

v1 introduces a separate join key in `telemetry-sql.ts`:

```
telemetryRoutineKey(appId, objectType, objectId, methodName)
  = normalizeAppGuid(appId)
  + canonicalObjectType(objectType)
  + objectId
  + normalizeTriggerName(methodName).toLowerCase()
```

The three normalizers come from `src/semantic/identity.ts` (`:124`, `:203`, `:277`) — the same ones
`computeTelemetryFingerprint` uses, so the key and the fingerprint can never disagree on casing or
trigger spelling. **`signalId` is deliberately omitted**, commented as such at the definition, so
evidence reaches every finding on the routine — RT0018 and RT0005 alike.

### 4.2 The stack parser

RT0005 documents no `alMethod`. The method comes from `alStackTrace`.

The current fallback takes the stack's first line (`buildSignalFromRow`,
`src/lifecycle/appinsights.ts:293-298`). Microsoft's documented RT0005 sample begins with header
lines (`AppObjectType: …`, `AppObjectId: …`) before `AL CallStack:`, so line 0 is the header, not a
method — every RT0005 finding minted that way carries a non-method string as its routine name.
`parseAlStackFrame()` replaces it: skip headers, take the first `AL CallStack:` frame, extract the
method name from the frame grammar. When no frame parses, the row is skipped rather than given an
invented name, matching today's empty-identity behavior (`appinsights.ts:303-305`).

### 4.3 No migration

Fixing the parse changes RT0005 finding identities. There is nothing to migrate: the telemetry
commands shipped in v3.0.0, but no lifecycle store containing RT0005 findings exists. Revisions 1
and 2 specified a `legacyMethodName` wire field, a deliberate re-run of the buggy parse, a
one-to-many collapse policy and a dry-run flag to preserve history that does not exist — all cut.

If an operator did run telemetry ingest before this change, their RT0005 findings re-file once under
corrected identities and the old rows resolve through normal absence handling. That is a changelog
line, not a mechanism. Its cost is bounded and its alternative was not: the old identities were
minted from `any(stackTrace)` over already-collapsed rows (§10), so faithful reconstruction was never
actually available.

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
  stack-parse tier, so there is nothing to mix and a merge never changes it.
- `threshold?: { minMs: number; maxMs: number }` — from the per-row `longRunningThreshold` when
  Gate 0 confirms that field exists. Optional, because Gate 0 has not confirmed it; when absent,
  renderers fall back to the operator-declared default in lifecycle config and say which they used.

Discrimination is the safety mechanism where the compiler is involved — and **only there**:

- `terminal.ts`'s `renderSqlEvidence` reads `totalSampledCostUs` / `sampledCostUs` unnarrowed and
  **does** compile-break.
- `json.ts` is `JSON.stringify` and the MCP surface only sorts and serializes — **neither breaks**.
  `SectionRenderers<T>` enforces one renderer per *section*, not exhaustiveness inside a field.
- So: a shared `isTelemetrySqlEvidence(e)` narrowing helper, plus tests asserting that a measured
  block never renders under a sampled label in any of the four formatters or the MCP output. Tests,
  not the compiler, are the guarantee on the stringify surfaces.

**Ranking stays in one unit — microseconds.** Telemetry sets `sqlRank = totalMeasuredMs * 1000`, so
`bySqlRankDesc` (`src/semantic/sql-evidence.ts:29-31`) never compares µs against ms. Consequence,
documented rather than discovered: RT0005 is threshold-gated at ~750 ms, so telemetry ranks start near
750,000 µs and usually dominate a mixed `--sort sql` list. `sqlRank` remains a rank signal only: never
`impact`, never severity, never identity.

## 6. Redaction — a canonical redacted form

`normalizeSqlShape` (`src/core/sql-node.ts:64-68`) blanks single-quoted literals and bare numbers. It
was built for query-**shape grouping**, not as a privacy boundary, and telemetry findings drive the
GitHub and Azure DevOps sinks — so anything attached to them can land in an issue tracker.

`redactSqlForSink()` lives in `telemetry-sql.ts` and runs before anything is stored:

1. **Strip the company/database prefix from EVERY table reference** — not just the first `FROM`:
   `FROM`, every `JOIN`, `INTO`, `UPDATE`, `MERGE … USING`, `OUTPUT … INTO`, CTE bodies and
   subqueries. BC physical names embed the company (`dbo."CRONUS Danmark A_S$Sales Header"`), and
   Microsoft's RT0005 sample shows the 3-part `"SQLDATABASE".dbo."COMPANY$Table$guid"` form. Company
   and database names are customer-identifying and never survive.
2. **Tokenize, don't pattern-match.** Rule 1 is a lexer requirement, not a regex list: a scanner that
   understands quoted identifiers (`"…"`, `[…]` with `]]` escaping), string literals with `''`
   escaping, and comments, then rewrites identifier tokens. Unparseable input fails **closed** — the
   statement is dropped from the evidence rather than emitted half-redacted.
3. **Fix `parseSqlTable` for 3-part names.** Its `FROM` regex (`src/core/sql-node.ts:100`) matches the
   first quoted segment, which for a 3-part name is the **database**. The `INTO` / `UPDATE` / `MERGE`
   variants (`:92`, `:94`, `:96`) share the shape and the fix.
4. **Retain the logical table name and extension GUID as separate fields.** A deliberate privacy
   decision, stated so it can be challenged: a BC table name is schema, not customer data, and without
   it the evidence is not diagnostic. Column names surviving rule 5 fall under the same decision.
   Company, database and literal values are never retained.
5. **Collapse column lists** past five named columns, rendering the remainder as `…+N more`, and keep
   the full column count — the count is what makes `missing-setloadfields` legible.
6. **Strip comments.**
7. **Blank literals, including the forms the profile-side regex misses**: `N'…'` unicode literals and
   `0x…` hex literals.
8. **Handle truncation.** RT0005 truncates `sqlStatement` at 8192 characters; a cut inside a string
   literal leaves an unclosed quote, so the blanking regex stops matching and the raw literal
   survives. Everything after the last complete token is dropped, the statement is flagged
   `truncated: true`, and the result is understood to be an excerpt, not executable SQL.
9. **`alStackTrace` is never stored** — only the parsed method name. The stack carries object names,
   method names, extension names, publishers and line numbers.

Exactly one implementation, in TypeScript, with the fixture corpus in §12. None of it in KQL.

## 7. Wire contract and parser

`TelemetrySignal` gains three optional fields — `sqlEvidence?`, `sqlExecutes?`, `sqlRowsRead?`.
`TelemetryBatchDocument` gains optional `signalAvailability?` (§9). All optional and additive, so
`TELEMETRY_BATCH_SCHEMA_VERSION` stays `1` per the stated policy (`src/types/telemetry.ts:1-10`,
mirroring ir-json §3.7): a producer that omits them emits a valid v1 batch.

- **The parser does not pass unknown fields through.** `validateSignal`
  (`src/core/telemetry-parser.ts:184-196`) builds a fresh object from named fields only, so evidence
  does not survive the parser until it is extended — with fail-closed validators matching the module's
  discipline: `sqlExecutes` / `sqlRowsRead` non-negative integers, `sqlEvidence` shape-validated, an
  unknown `provenance` rejected rather than passed on.
- **Merge semantics.** `buildMergedPattern` (`src/core/telemetry-parser.ts:336-381`) merges
  same-fingerprint signals across client types and carries no SQL fields today. Defined behavior:
  union statements by redacted text, sum `occurrences` and `measuredTotalMs`, take the max of maxima,
  widen `threshold` to cover all constituents, sum `sqlExecutes` / `sqlRowsRead` treating `undefined`
  as unknown rather than zero, and order merged statements by `measuredTotalMs` descending with the
  redacted text as tiebreak so output is stable. Where constituents disagree on `operation`, `table`
  or `extensionAppId` for identical text, the first by that ordering wins — identical redacted text
  with different tables means the redactor lost information, which the corpus in §12 exists to
  prevent. `attribution` stays `"telemetry-stack"`. Statement rows for a routine whose signal row was
  skipped (`appinsights.ts:303-305`) are dropped, never minted into a finding.

Widening `SqlEvidence` changes the public `DetectedPattern` shape, and therefore the analysis JSON and
MCP output — an output-contract change even though the telemetry-batch contract stays v1. It is
additive: a new variant, no existing field altered.

## 8. How evidence reaches an issue body

Structured `sqlEvidence` never reaches a sink. `collectFindings` persists
`details: JSON.stringify({ evidence, suggestion })` (`src/lifecycle/evaluate.ts:221`) — `evidence`
being the **string** field of `DetectedPattern`. `triggers.ts:156-157` reads `occDetails.evidence`
only when it is a string. GitHub fences it; Azure DevOps escapes it into `<pre>`.

Decision: **the redacted statements are formatted into `DetectedPattern.evidence`**, the string that
survives the database round-trip.

- `buildSinglePattern` / `buildMergedPattern` (`src/core/telemetry-parser.ts:303-381`) append a
  compact block to the existing evidence line: up to **three** statements, each ≤200 characters, each
  with its `occurrences` and `measuredTotalMs`, then the provenance and threshold caveat, then — when
  a signal was unavailable or truncated — one line naming that (§9).
- **Plain text only.** No markdown, no code fences: GitHub wraps the string in a fence and Azure
  DevOps escapes it into `<pre>` (`sinks/azureDevOps.ts:115`), so any markup renders literally in one
  of the two.
- The structured `sqlEvidence` object stays in memory for the formatters, JSON and MCP, and is
  **documented as not persisted**: historical trends and sinks see the string form only.
- `redactSqlForSink` runs before the string is built, and the string is assembled only from
  already-redacted text — for the **adapter path** (`appinsights.ts` pulling from App Insights and
  building `sqlEvidence` itself). There is no path from raw statement text to `evidence` there.
  **Correction (final review, F4):** this is not true of the **ingest path**. A producer posting a
  telemetry batch directly (`/api/ingest`, or any third-party producer) can supply `sqlEvidence`
  on the wire; the parser validates its *shape* field-by-field (every statement field checked, F4
  fix) but does not re-run `redactSqlForSink` or otherwise verify the *content* is actually redacted
  — wire-supplied evidence is trusted as producer-redacted, the same trust posture the wire contract
  already extends to every other field. Severity is contained: `/api/ingest` binds its bearer token
  to one tenant, so a producer can only inject unredacted text into its own findings, never another
  tenant's.

Three statements rather than five because an issue body is read by a human; the full set still drives
the totals. Two consequences, stated rather than discovered:

- Appending to `evidence` breaks the byte-identical golden pin in
  `test/core/telemetry-contract.test.ts`; that pin is re-baselined deliberately as part of this work.
- Evidence changes do not trigger issue updates. Sink deliveries are event-driven — create, and
  comments on regression, recurrence and resolution — so a per-window evidence string produces
  occurrence-detail churn, not issue churn. An issue body created in window N keeps window N's
  evidence; later windows surface through comments.

## 9. Availability, the puller's failure model, and absence

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

**The puller's failure model changes.** Today `fetchSignalTable` throws on a non-OK response and the
per-signal loops have no catch (`src/lifecycle/appinsights.ts:496-498, 516-529, 581-596`) — a failed
RT0005 query produces no batch at all. v1 captures per signal: a failing signal records
`{ queried: true, rows: 0, error }` and the pull continues. **If every signal fails, the pull still
throws** — a bad API key or app id must stay loud. Capture covers **row normalization too**, not just
HTTP: `asDurationMs` can throw mid-normalization (`appinsights.ts:258-262`), and that must degrade the
one signal rather than the whole pull.

**Availability gates lifecycle state, not just rendering.** The absence pass gates only on stream,
capture kind and app-exercised (`src/lifecycle/evaluate.ts:610-617`) — there is no per-signal gate —
so an RT0018-only batch would accrue absence against every RT0005 finding of the same app and
eventually resolve them, with the sinks announcing it.

Rule: **a batch in which any configured signal failed is an incomplete run.** The parser sets
`meta.incompleteInvocations > 0`, which `evaluateRun` already reads (`evaluate.ts:353`) to skip the
absence pass entirely (`evaluate.ts:610-611`). No new gate and no new state — the mechanism ir-json's
incomplete captures already use. Findings still record occurrences and still transition on what *was*
observed; nothing resolves on evidence that was never fetched.

**Split mode.** Availability is per pull, not per tenant row: a failed signal returns no tenant
dimensions, so there is nothing to attribute it to. Every group emitted from that pull carries the
same `signalAvailability` array, and a tenant that produced no rows at all in a failed-signal pull
produces no group — which the digest reports as "not observed this window", never as "clean".

Rendering rule: a finding renders "no slow statement crossed the threshold" **only** when availability
shows the signal was queried, returned without error, and was not truncated. Otherwise the rendering
names the actual reason. Availability reaches an issue the same way evidence does (§8); the structured
array stays on the batch for the CLI and JSON.

**Not wired to the digest (final review, F3).** `digest.ts`'s renderer accepts a `signalAvailability`
option and formats it into the same wording as §8, but nothing currently supplies that option with real
data: `signalAvailability` is not persisted anywhere — absent from the lifecycle store's schema, not
passed at the `lifecycle digest` CLI command's `buildDigest` call site
(`src/cli/commands/lifecycle.ts`), and dropped from `metrics.json` on the web ingest path
(`web/handlers/ingest.ts`). So today, per-window availability is visible in `lifecycle pull-telemetry`'s
own output and in a finding's evidence text, but not in `lifecycle digest`. Persisting
`signalAvailability` so the digest can surface it too is a tracked follow-up, deliberately not attempted
here — see `docs/telemetry-recipe.md`'s "Window completeness" section, which carries the matching note.

**Idempotency note.** `profileId` for split pulls is a content hash over `[tenant, stream, batch]`
(`src/cli/commands/lifecycle.ts:659-661`), so adding `signalAvailability` changes it. A re-pull of the
same window after a signal recovers is therefore *not* deduplicated — it evaluates as a fresh run,
which is intended (the second run carries evidence the first could not), but it does mean that window
counts twice among absence-compatible runs. Documented, not worked around.

## 10. KQL — both queries change

Revision 2 claimed the existing per-signal query was unchanged. It cannot be. That query groups by
`methodName` and carries `stackTrace = any(stackTrace)` (`src/lifecycle/appinsights.ts:211-215`); for
RT0005 `methodName` is empty, so every statement under one object collapses into a single row with one
arbitrary stack. Per-routine RT0005 findings cannot be recovered from that in TypeScript.

**Signal query.** For RT0005 only, group by `alStackTrace` instead of carrying `any(stackTrace)`;
RT0018's grouping is unchanged. The KQL snapshot pin in `test/lifecycle/appinsights.test.ts` and the
byte-identical golden in `test/core/telemetry-contract.test.ts` are re-baselined deliberately, with
the diff reviewed rather than accepted wholesale. The additive `sqlExecutes` / `sqlRowsRead` extends
ride on the same query; those columns are null for RT0005, which is expected — they land only on
RT0018 findings.

**Statement query.** Groups by `(extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement)`,
plus `aadTenantId` and `environmentName` **in split mode**, matching the dimensions
`pullTelemetrySplit` groups rows on (`appinsights.ts:581-647`). Top-N per routine (`top-nested`), not
global, so one noisy routine cannot crush every other routine's only statement; truncation is reported
through `signalAvailability`, never silently.

**The join happens per split group, after grouping — never globally.** A global join keyed on the
routine alone would attach one tenant's redacted SQL to another tenant's finding whose app, object and
method happen to match, and §8's string would carry it into that tenant's issue tracker. In non-split
mode there is one group and the distinction is moot; the code path is the same either way, which is
why it is one rule rather than two.

Five statements per finding in the structured block, three in the persisted string (§8); the full set
drives the totals either way.

## 11. Version floors

RT0018 `sqlExecutes` / `sqlRowsRead` are documented from BC v22.0. Absent means **unknown**, never
zero: the fields stay `undefined` and render as "not reported by this environment". Same rule for any
dimension Gate 0 finds missing on a given tenant.

## 12. Testing

- **Fixtures are a deliverable.** Gate 0's probe payload becomes a committed, redacted fixture, so the
  pipeline pins run on a clean checkout.
- **Identity pins:** RT0018 fingerprints byte-identical before and after. RT0005 fingerprints change
  by design (§4.3) — pinned to the *new* values, with a test asserting that a header-line stack no
  longer produces a finding whose routine name is a header.
- **Invariant pins:** no new field alters `impact`, severity, or state.
- **Absence pins:** a batch with a failed signal marks the run incomplete and accrues **no** absence;
  a batch with all signals healthy accrues absence exactly as today.
- **Tenant-isolation pin:** two split groups whose findings share app, object and method receive only
  their own statements — the test that would have caught the cross-tenant join.
- **Type pins:** `terminal.ts` narrows before reading variant fields; JSON and MCP output for a
  telemetry finding never contains a sampled label (test-enforced, since the compiler cannot).
- **Redaction corpus:** 3-part database-qualified name; `Company$Table`; `Company$Table$guid`;
  `[System Table]` and a `]]`-escaped bracket identifier; a multi-table `JOIN`; a subquery and a CTE;
  `MERGE … USING`; a statement truncated mid-literal (unclosed quote); `N'…'` and `0x…` literals; a
  comment-bearing statement; a 47-column `SELECT`; an aliased FROM with alias-qualified columns (the
  shape Gate 0 found in real rows); and one input the tokenizer cannot parse, which must be dropped
  rather than half-redacted.
- **Sink-path pin:** a telemetry finding's persisted `evidence` string contains the redacted
  statements, no company or database name, and no markdown — asserted at the `occurrences.details`
  boundary, the last point before an external tracker.
- **Availability pins:** "not queried", "error", "truncated" and "queried and empty" each render
  distinct text; one failing signal does not abort a pull; all signals failing does; a normalization
  throw degrades one signal, not the pull.
- **Merge pins:** two client-type constituents each carrying evidence merge per §7 — no drop, no
  double-count, stable order.
- **Rank pin:** telemetry and profile findings sort coherently in one surface.
- **Re-baselined pins, reviewed not rubber-stamped:** the KQL snapshot and the telemetry-contract
  golden (§10).

## 13. Known constraints

- RT0005 is threshold-gated: BC online sends statements over ~750 ms; on-prem
  `SqlLongRunningThreshold` defaults to 1000 ms and is server-configurable. **Absence of evidence is
  never evidence a routine issues no SQL.**
- Statement text is truncated by the platform at 8192 characters.
- Attribution is routine-level, from a stack frame — not a call-site handle. Several findings on one
  routine share its statements.
- RT0005 and RT0018 rows are correlated by routine and window, not by execution (§3).
- Structured `sqlEvidence` is not persisted; the store and the sinks see the string form (§8).
- Sink comments read the *latest* occurrence, not the occurrence of the event being delivered
  (`triggers.ts:139-157`), so a comment can describe a later window than the transition it reports.
  Pre-existing; the SQL block makes it more visible.
- Overlapping pull windows (a cron shorter than `--since`, default `1h`, `appinsights.ts:36`)
  re-observe the same statements. This already affects `count` today; evidence makes it more visible.

## 14. Follow-ups left open at implementation (2026-07-25)

The layer shipped on 2026-07-25 (65 commits, merged to local master at `45978c4`).
Three things were deliberately deferred, with rulings, and none blocked use.
**All three were closed later the same day**; the original rulings are kept below
with their resolutions.

1. ~~**`signalAvailability` is not persisted, so `lifecycle digest` cannot render
   it.**~~ **CLOSED.** §9 says the array "stays on the batch for the CLI, JSON and
   the digest"; the digest option existed, was tested, and no caller populated it,
   because availability is per-pull while `digest` reads the store.
   Schema v8 adds a one-row-per-tenant `signal_availability` snapshot;
   `evaluateTelemetryBatch` writes it after a successful evaluate (and only when
   the batch actually carries the field — an absent array means the producer does
   not emit it, not that failing signals recovered); the `digest` command reads it
   for the requested tenant. An older `windowEnd` never overwrites a newer one,
   since cron-driven pulls can land out of order. **§9 is now complete** — verified
   end to end through the real CLI: `lifecycle telemetry` then `lifecycle digest`
   renders both the unavailable and the truncated line.
2. ~~**Two redaction residuals leak a server or database name**~~ **CLOSED**, both
   by one guard. Both required a cross-database or linked-server reference in a
   non-first table position: a joiner carrying two or more bare words
   (`server.MyDb.dbo."T"`), and a fully bare qualifier (`mydb.dbo."T"`,
   structurally invisible because only quoted ident tokens are dropped). BC
   reaches each tenant database over its own connection and emits the two-part
   `dbo."COMPANY$Table"` form, so its runtime cannot produce either for tenant
   data. Two or more bare segments before a quoted or bracketed name now fail the
   whole statement closed, in both the join and the subquery position; the
   ordinary `dbo."T"` form and `alias."column"` pairs are unaffected.
   A third residual of the same class — a quoted identifier that is customer data
   but carries no `$` — remains open **deliberately**: no discriminator separates
   a customer-derived quoted name from a legitimate one (BC field names carry
   spaces too), and blanking alias identifiers would leave every `alias."column"`
   reference dangling. Measured against the captured BC SQL in this repo's
   fixtures, zero `AS "..."` alias forms appear at all and the company name shows
   up only inside `$`-bearing identifiers. Documented at `redactSqlForSink` along
   with the invariant the redactor actually relies on.
3. **Smaller carries:** ~~the adapter can emit a `clientType` the parser's
   `^[A-Za-z]+$` rejects, costing the whole window on one bad row~~ **CLOSED** —
   `safeClientType` drops just the field at both normalizers, so the row's timing
   and finding data survive and only the client-type dimension is lost (still not
   observed on measured data; all five production values are letters-only). Still
   open: the non-split statement tests use the split-mode column fixture, which is
   the same shape-fidelity assumption that produced the NaN defect during
   implementation.

## 14. Risks

- **Gate 0 invalidates part of the design.** If `alStackTrace` has no parseable frame grammar on real
  rows, routine-level attribution degrades to object-level and §10's regrouping loses its point.
  Largest open risk; it is why Gate 0 blocks.
- **Stack fragmentation.** If one routine produces many distinct stacks per window, §10's regrouping
  fragments the findings themselves — not just their evidence. Gate 0's `distinctStacks` measures it
  before anything is built.
- **`executionTimeInMs` may not exist**, in which case the shipped puller has a latent failure and
  fixing it is a prerequisite rather than part of this work.
- **Redaction is a security boundary.** A miss ships customer-identifying SQL into an external
  tracker. The corpus in §12 is the mitigation and must grow with every real payload seen.
