# Small-Debt Batch — Design

**Date:** 2026-07-12
**Status:** Approved, ready for implementation planning

Four independent debt items in the lifecycle engine, batched into one SDD round.
They share no code beyond `src/lifecycle/store.ts`, and even there they touch
different things (item 3 adds a migration; item 2 only reads an existing column).

---

## Item 1 — CLI-level mixed-case `--tenant` coverage

### Problem

`normalizeTenantCode` (`src/lifecycle/tenant.ts:19`) lowercases and trims, and
`resolveTenantOpt` (`src/cli/commands/lifecycle.ts:56`) applies it at the CLI
boundary. Nine subcommands take `--tenant`. Only two of them — `telemetry` and
`status` — have a test that drives the real `commander` action with mixed casing
(`test/lifecycle/cli.test.ts:241-314`).

`evaluate`, the primary command, is verified only at the `evaluateRun()` function
layer (`test/lifecycle/evaluate.test.ts:710-754`). Its fusion branch
(`src/cli/commands/lifecycle.ts:737-792`) reads the CLI-normalized `tenant`
variable and passes it to `applyIdentityUpgrades` *before* `evaluateRun` runs its
own internal normalization. A regression that de-normalized the tenant on that
specific path — identity upgrades landing under `ACME` while findings land under
`acme` — would pass every existing test.

### Design

Test-only. No source changes are expected; this pins current behavior.

In `test/lifecycle/cli.test.ts`, extend the existing
`describe("lifecycle --tenant normalization")` block:

1. **`evaluate` casing collision, through the fusion branch.** Build the command
   with `createLifecycleCommand()`, `exitOverride()`, and drive it via
   `parseAsync` — the pattern already established at `cli.test.ts:263-267`. Run
   the same profile twice, once with `--tenant ACME` and once with
   `--tenant acme`, both with `--source` pointing at a fixture so the fusion /
   `applyIdentityUpgrades` path executes. Assert `listFindings({ tenant: "acme" })`
   returns one finding, and `getActiveFinding("ACME", fp)` is null.
2. **Remaining subcommands.** A table-driven pass over `digest`, `status`,
   `close`, `triage`, and `captures list`: seed one finding under `acme`, invoke
   each subcommand with `--tenant ACME`, assert it resolves to the same bucket
   (finds the seeded finding rather than reporting an empty tenant).

`triage-agent` and `pull-telemetry` are out of scope — both require network
mocking that outweighs the value for a normalization test.

### Success criteria

- A deliberate regression (removing `resolveTenantOpt` from the `evaluate`
  action) fails at least one new test.
- `AI_DISABLED=1 bun test` green.

---

## Item 2 — Algorithm-version bump orphans every finding

### Problem

`FINGERPRINT_ALGO_VERSION` (`src/lifecycle/fingerprint.ts:56`) is the first token
of every minted fingerprint. Bumping it changes every hash by design — that is
what the constant is for.

Nothing handles the consequence. On the first run after a bump:

- Every still-present problem mints an unrecognized fingerprint, misses both
  `getActiveFinding` and `getLatestClosedFinding`, and is filed as `first-seen`
  (`src/lifecycle/evaluate.ts:397-451`). Duplicate issues; age resets.
- Every pre-bump row is absent from the run, so `absenceCount` climbs and it flips
  to `resolved` after `resolveAfterRuns` (default 3). `resolved` → `closed` is
  never automatic (`src/lifecycle/states.ts:83-91`) — only a human running
  `lifecycle close` moves it. The rows sit there permanently.

`fingerprint_migrations` and `applyFingerprintMigration` exist, but the only
caller is the alsem `"identity-upgrade"` path. No `"algo-upgrade"` migration is
constructed anywhere in `src/`.

Nothing warns. The operator discovers it as duplicate issues weeks later.

### Design

The stored data is disposable test data from a solution still under development,
and the fingerprint algorithm is not final. Carrying history across a bump is not
worth building yet. Detect and refuse; provide a clean way to start over.

**Guard.** In `evaluateRun` (`src/lifecycle/evaluate.ts`), before collecting
findings: query the store for active (non-closed) findings for this tenant whose
`algo_version != FINGERPRINT_ALGO_VERSION`. If any exist, throw a typed error
carrying the count, the stale version(s), the current version, and the remedy
command. Placing the guard in the library — not the CLI action — means the CLI,
the web server, and the MCP tools all inherit it.

**Escape hatch.** `lifecycle maintain --purge-stale-fingerprints --tenant <t>`.
A plain `DELETE` of findings at the wrong algo version for that tenant, cascading
to their events, occurrences, outbox rows, and sink mappings. Not a "close with an
audit event" — the history has no value here, and deleting is the honest
operation. Prints the count deleted. The guard's error message names this exact
command.

Explicitly **not** in scope: an `identity_key` column, a re-fingerprinting
migration, `"algo-upgrade"` migration records, or any attempt to match old
fingerprints to new ones. Revisit when the algorithm stabilizes and real customer
history exists.

### Success criteria

- With `FINGERPRINT_ALGO_VERSION` stubbed to a different value than the rows in a
  seeded store, `evaluateRun` throws, and the message contains both versions and
  the remedy command.
- After `maintain --purge-stale-fingerprints`, the same `evaluateRun` succeeds and
  files the findings fresh.
- Purge is tenant-scoped: a second tenant's findings survive.
- No guard fires when every row is at the current version (the normal case).

---

## Item 3 — `sink_processed` is global, so a new sink never sees the backlog

### Problem

`finding_events.sink_processed` (`src/lifecycle/store.ts:160`) is one bit per
event. `processEventsForSinks` flips it for every event it scans, once, at the end
of the scan, regardless of how many sinks were enabled
(`src/lifecycle/sinks/triggers.ts:302`). `finding_events` has no `sink` column.

So a tenant that has been running with only a `github` sink has its entire event
history marked processed. Enable `azureDevOps` later and those events are already
out of `listUnprocessedEvents()`'s `WHERE sink_processed = 0` filter — ADO never
sees them. Live findings still get filed on their next occurrence (the create gate
fires on any presence event with no ADO mapping), but anything dormant stays
ADO-invisible. This is documented as a known limitation in
`docs/lifecycle-ado-recipe.md:137-146`.

The mapping layer already has the dimension the processed flag lacks:
`sink_issue_map` is keyed `(tenant, sink, fingerprint)` (`store.ts:151-159`).

### Design

**Schema (migration v6).**

```sql
CREATE TABLE IF NOT EXISTS sink_progress (
    sink          TEXT NOT NULL PRIMARY KEY,
    last_event_id INTEGER NOT NULL DEFAULT 0
)
```

Keyed by sink alone, not `(tenant, sink)`: sink configuration is global (see
`buildSinkRuntimes`, `triggers.ts:65-94` — it takes no tenant), tenants arrive
with the data, and `finding_events` has no tenant column anyway. Event ids are a
single global ordering, so one watermark per sink is sufficient and avoids a join.

**Seeding, in the migration, in pure SQL.** Insert a row for every sink that has
already done work — i.e. every distinct `sink` in `sink_issue_map` — with
`last_event_id = (SELECT COALESCE(MAX(id), 0) FROM finding_events WHERE sink_processed = 1)`.
Sinks that have already filed issues resume where they left off and do not
re-scan. A sink never seen before has no row, starts at 0, and replays history —
which is precisely the backlog behavior being added.

**Reads and writes.**

- `listUnprocessedEvents(sink, limit = 500)` → `WHERE id > <watermark for sink> ORDER BY id LIMIT ?`.
- `markEventsProcessed(ids)` → `advanceSinkProgress(sink, lastEventId)`, an upsert.
- `finding_events.sink_processed` stays in the schema (it is the seed source) but
  is no longer read by the trigger scan. Dropping it is out of scope.

**Fan-out inversion.** `processEventsForSinks` currently loops events on the
outside and sinks on the inside. It inverts: loop sinks on the outside, and for
each, scan that sink's own unprocessed events and advance that sink's watermark.
The whole scan remains inside the one enclosing `store.db.transaction()` it uses
today.

**Replay safety.** Three mechanisms already make replay safe, and none of them are
new work:

- The `create-issue` gate (`triggers.ts:276-286`) requires `absenceCount === 0`,
  `state != "resolved"`, and `state != "closed"`. A replayed presence event for a
  finding that has since died files nothing. This is the liveness guard.
- The comment and close gates all require an existing `mapping`. A fresh sink has
  none, so it cannot emit comments for history it never filed. Within a single
  scan the mapping is written only on delivery, so no ordering hazard exists.
- Outbox rows are never deleted (`status` is `pending|delivered|dead`; there is no
  `DELETE FROM outbox` in the codebase) and `dedupe_key` is `UNIQUE` with
  `INSERT OR IGNORE`. A sink that re-scans events it has already handled
  re-derives the same dedupe keys and enqueues nothing.

**Backlog drain.** `lifecycle sync` loops `processEventsForSinks` until a scan
reports `processed === 0`, accumulating the report. A backlog larger than the 500
-event batch limit therefore drains in one `sync` invocation, while each
individual scan stays a bounded transaction.

The resulting storm of `create-issue` rows for a newly-enabled sink is collapsed
into one epic by the existing `collapseCreates` (`src/lifecycle/sinks/outbox.ts:76-127`).

**Docs.** `docs/lifecycle-ado-recipe.md:137-146` currently documents the
limitation. Rewrite that paragraph to describe the new behavior: a newly-enabled
sink picks up the live backlog on its first `sync`, dormant findings included, and
long-dead findings are correctly skipped.

### Success criteria

- Seeded store: events processed while only `github` was enabled; enable
  `azureDevOps`; one `sync` files the live backlog to ADO and nothing to github.
- A finding that is `resolved`/`closed`/absent at replay time files nothing in the
  new sink.
- An existing sink's watermark is seeded by the migration such that it re-scans no
  history.
- A >500-event backlog fully drains in a single `lifecycle sync`.
- Existing sink tests (`test/lifecycle/sinks/*.test.ts`) stay green.

---

## Item 4 — Epic dedupe key grows without bound

### Problem

`collapseCreates` (`src/lifecycle/sinks/outbox.ts:104-118`) builds the epic's
dedupe key as:

```ts
dedupeKey: `${sink}:epic:${tenant}:${rows.map((r) => r.id).join(",")}`
```

A 300-finding storm produces a ~2 KB string in `outbox.dedupe_key`, a
`TEXT NOT NULL UNIQUE` column (`store.ts:140`). The key is never sent to GitHub or
Azure DevOps — epic titles are the fixed `[al-perf] N new findings`, already
length-clamped — so no external limit is at risk. This is internal index bloat,
not a correctness bug.

### Design

Hash the row-id set instead of concatenating it:

```ts
dedupeKey: `${sink}:epic:${tenant}:${sha256Hex16(rows.map((r) => r.id).sort((a, b) => a - b).join(","))}`
```

Sort before hashing so the key is deterministic regardless of row order. Reuse the
existing `sha256Hex16` primitive from `src/lifecycle/fingerprint.ts` (export it if
it is not already exported).

The property the existing test at `test/lifecycle/sinks/outbox.test.ts:202-235`
pins — two separate storms in one tenant produce two distinct epic keys — is
preserved, because the hash is still over the row-id set.

### Success criteria

- Existing epic tests stay green, including the two-distinct-storms test.
- New test: a 300-row storm produces a dedupe key under 80 characters.
- New test: the same row-id set in a different order hashes to the same key.

---

## Sequencing

All four are independent enough to run as parallel SDD streams in worktrees:

| Item | Touches |
|---|---|
| 1 | `test/lifecycle/cli.test.ts` only |
| 2 | `src/lifecycle/evaluate.ts`, `src/lifecycle/store.ts` (new query + delete, no migration), `src/cli/commands/lifecycle.ts` (`maintain` flag) |
| 3 | `src/lifecycle/store.ts` (migration v6, event queries), `src/lifecycle/sinks/triggers.ts`, `src/cli/commands/lifecycle.ts` (`sync` loop), `docs/lifecycle-ado-recipe.md` |
| 4 | `src/lifecycle/sinks/outbox.ts`, `src/lifecycle/fingerprint.ts` (export) |

The one genuine collision is the migration ladder: item 3 claims **v6**
(`LIFECYCLE_SCHEMA_VERSION = 6`). Item 2 adds no migration — its guard reads the
existing `algo_version` column and its purge is a `DELETE`. Items 2 and 3 both add
code to `src/cli/commands/lifecycle.ts`, but to different subcommands
(`maintain` vs `sync`), so the merge is textual, not semantic.
