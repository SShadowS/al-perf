# Deep-Capture Queue: Observability and Self-Correction — Design

**Date:** 2026-07-12
**Status:** Approved, ready for implementation planning

The deep-capture loop works end to end. A telemetry finding files a capture
request; an executor polls, claims, captures, and ships; `evaluateRun`
auto-fulfils the request when the profile arrives. That chain was proven live
against Cronus28 earlier today.

What it lacks is any way to tell you when it has stopped working. Every failure
mode is detected correctly in the data and then made invisible. This spec fixes
that, and makes the one failure mode that requires a human today correct itself.

Scope is **al-perf only**. A canonical orchestrator job set for bc-dev-mcp is a
separate, smaller project — the two are independent (a jammed queue is invisible
whether or not the cron is hand-written, and a job set does not fix the
blindness).

---

## The three failures

### 1. Starvation is completely silent

`processCaptureTriggers` skips a qualifying finding when its tenant is already at
`maxPending` active requests, and counts it in `skippedMaxPending`
(`src/lifecycle/capture-triggers.ts:120`). So when the executor dies, the queue
fills to the cap and new findings stop generating requests — the pipeline has
stopped, but nothing has failed.

The count reaches exactly one place: `sync -f json`'s
`summary.captureRequests.skippedMaxPending`. In text mode it is not merely
omitted from the message — the message is suppressed entirely
(`src/cli/commands/lifecycle.ts:1312`):

```ts
if (captureRequests.created > 0 || captureRequests.expired > 0) {
    console.log(`Capture requests: ${created} created, ${expired} expired.`);
}
```

In the starvation state `created` and `expired` are both `0`, so the guard is
`0 > 0 || 0 > 0` and **no line prints at all**. A jammed pipeline is
byte-identical, on stdout, to a healthy idle one.

Neither `lifecycle status` nor `lifecycle digest` mentions capture requests at
all.

### 2. A dead executor's claims never come back

There is no server-side claim TTL. `claimCaptureRequest` only ever moves
`pending → claimed` (`src/lifecycle/store.ts:1497-1504`); nothing moves it back.
A request held by an executor that died stays `claimed` until either a human runs
`captures cancel`, or its **creation-time** TTL elapses — which, depending on when
it was claimed, may be thirteen days later or one.

`docs/capture-request-contract.md` §3 acknowledges this and pushes the problem
outward: *"If your executor pool needs stronger mutual exclusion, build it above
this — e.g. your own scheduler enforcing a claim TTL."*

### 3. There is no queue health surface

`captures list` filters by status and prints raw ISO timestamps sliced to 19
characters. No age, no sort, no highlighting. Spotting a three-day-old claim from
a dead executor is an eyeball exercise. `countActiveCaptureRequests` exists
(`store.ts:1488`) but is internal to the `maxPending` check and exposed nowhere.

---

## Design

### Auto-reclaim (fixes #2)

New config `captureRequests.claimTtlMinutes`, default `60`.

`reclaimStaleClaims(now, claimTtlMinutes)` runs inside `processCaptureTriggers`'s
existing transaction, **after** `expireCaptureRequests` — a request past its
creation TTL should die, not be recycled. A `claimed` row whose `claimed_at` is
older than the TTL becomes:

- `status = 'pending'`
- `claimed_at = NULL`
- `claimed_by` — **deliberately kept**
- `reclaim_count = reclaim_count + 1`

Nulling `claimed_at` is mandatory, not cosmetic: leave it set and the next sweep
immediately re-reclaims the row it just reclaimed.

Keeping `claimed_by` is a deliberate oddity. It is semantically strange on a
`pending` row, and it is the only breadcrumb naming which executor dropped the
request — without it, the evidence of a dead executor evaporates at the exact
moment the sweep runs. `claimCaptureRequest` overwrites it on the next claim, so
it reads as "last claimed by". Document it as such.

`reclaim_count` separates two failure modes that look identical from the outside:

- an executor that **died** — many requests, one reclaim each
- a **poison request** that kills whatever picks it up — one request, many reclaims

**Accepted limit:** a poison request will be handed to executor after executor
until its creation TTL reaps it, holding a `maxPending` slot the whole time
(bounded: 14 days by default). No reclaim cap, no auto-cancel — that is machinery
for a failure we have never observed. `reclaim_count` makes it visible in
`health`; a human cancels it. This is a choice, not an oversight.

**Schema:** migration **v7**, purely additive:
`ALTER TABLE capture_requests ADD COLUMN reclaim_count INTEGER NOT NULL DEFAULT 0`.

### Three surfaces (fixes #1 and #3)

**`sync`** — fix the guard and give starvation its own line:

```
Capture requests: 0 created, 0 expired, 2 reclaimed.
  WARNING: 12 finding(s) qualified but were NOT requested — tenant at the
  maxPending cap (12). The queue may be jammed. Run: lifecycle captures health
```

The guard becomes `created || expired || reclaimed || skippedMaxPending`. The
warning line is separate from the counts line and prints whenever
`skippedMaxPending > 0`, regardless of the other counts. `CaptureTriggerReport`
gains `reclaimed: number`, which flows into the JSON summary alongside the
existing fields.

**`lifecycle captures health`** — a new subcommand under the existing `captures`
group (`src/cli/commands/lifecycle.ts:1520`). It reports **facts, not verdicts**:

```
Tenant: acme
  pending:  12   oldest: 8d 4h
  claimed:   3   stuck (claimed > 60m): 3   last held by: bc-dev-mcp-01
  at maxPending cap (12): YES
  reclaimed at least once: 3   most-reclaimed request: #418 (5 times)
```

No "executor appears dead" heuristic — the operator draws that conclusion. `-f
json` for scripting. Runs across all tenants when `--tenant` is omitted, matching
`captures list`.

**`digest`** — `DigestData` (`src/lifecycle/digest.ts:38`) gains a
`captureQueue` block: pending count, claimed count, stuck count, `atCap` boolean,
oldest-pending age.

It renders **only when the queue is jammed** — `atCap`, or `stuck > 0`. The
healthy case stays silent, so the digest (and the GitHub/ADO issues it drives)
does not get spammed with routine queue chatter. This is the layer that matters:
it reaches a human who is not watching a terminal.

**"Jammed" is defined crisply as *at `maxPending`***, because that is literally
the state in which new requests stop being filed. Not a heuristic, not a
threshold someone has to tune.

---

## Consequences outside this repo

**bc-dev-mcp's `--keep-claim-on-failure` changes meaning.** That flag exists so an
operator can build retry above the queue: on a failed capture the worker keeps
the claim so nothing else grabs the request
(`bc-dev-mcp/src/core/queue/worker.ts:131-133`). With a server-side claim TTL,
that kept claim is reclaimed after `claimTtlMinutes` anyway and another worker
picks it up. Arguably that *is* retry, and the outcome is reasonable — but the
flag's guarantee is now weaker than its name implies. Both repos' docs must say
so.

**The executor contract changes.** `docs/capture-request-contract.md` §3 tells
executors to build their own claim TTL. That guidance is now wrong: the TTL ships
server-side, and an executor that already built one will have two. Rewrite §3 to
state that stale claims are reclaimed by the engine on the `sync` scan, name the
`claimTtlMinutes` config, and tell executor authors to remove any TTL of their
own.

---

## Testing

- **Reclaim:** a stale claim returns to `pending` with `claimed_at` nulled,
  `claimed_by` retained, `reclaim_count` incremented. A *fresh* claim is
  untouched. Expiry runs before reclaim (a request past its creation TTL expires
  rather than being recycled) — pin the ordering, not just the outcomes.
- **Starvation:** `sync` in text mode, with `created == 0 && expired == 0 &&
  skippedMaxPending > 0`, prints the warning. This is the exact state that
  currently prints nothing, so the test must fail against today's guard.
- **Health:** counts, oldest-pending age, at-cap detection, stuck-claim
  detection, and the most-reclaimed request are each correct against a seeded
  queue.
- **Digest:** the `captureQueue` block is present when jammed and **absent** when
  healthy. Both directions — a block that always renders would spam every sink.

Each of these must fail if the behavior it claims to pin is broken. Three test
defects in the last batch were tests that rebuilt the production expression in
their own body, or whose fixture never created the state they claimed to check.
