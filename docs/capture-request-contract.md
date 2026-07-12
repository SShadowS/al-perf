# Deep-capture request executor contract

A recurring BC telemetry finding (`RT0018`/`RT0005`, see
[`docs/telemetry-recipe.md`](telemetry-recipe.md)) tells you a routine is
worth a real profiler run, but telemetry alone has no call tree — only a
profile (sampling or instrumentation) gets you line-level evidence.
`lifecycle sync` automatically **schedules** that follow-up by filing a
`capture_requests` row; it deliberately does **not** run the capture itself
(spec D1's two-stage orchestrator posture — al-perf decides *where* a
capture would pay off, an external executor decides *when* and *how* to
actually run one). This file is the contract for that executor: a human, a
scheduled task, or automation such as bc-dev-mcp.

## 1. Where requests come from

`lifecycle sync`'s trigger scan (`processCaptureTriggers`) walks
`telemetry:`-namespaced findings and files a request for each one that
clears these thresholds — code defaults in `src/lifecycle/config.ts`
(`DEFAULT_LIFECYCLE_CONFIG.captureRequests`), overridable per tenant via a
`captureRequests` block in `.al-perf/lifecycle.config.json`, loaded through
`lifecycle`'s parent `--config <path>` flag or the web ingest path's
`AL_PERF_LIFECYCLE_CONFIG` env var — same mechanism as the telemetry
severity thresholds (see [`docs/telemetry-recipe.md`](telemetry-recipe.md)
§11 for a full example with `sinks` + `telemetry` + `captureRequests`
coexisting). Fields not present in the file keep their code default:

```json
{
	"captureRequests": {
		"enabled": true,
		"minOccurrences": 3,
		"minSeverity": "warning",
		"ttlDays": 14,
		"maxPending": 20,
		"claimTtlMinutes": 60
	}
}
```

`maxPending` caps ACTIVE (pending/claimed) requests per tenant — further
qualifying candidates are skipped, not queued, until the count drops.
`claimTtlMinutes` bounds how long a claim survives an executor that never
reports back — see §3 for what reclaims it and why an executor should not
also build its own version of this.

## 2. The executor loop

1. **Poll.**
   ```bash
   al-profile lifecycle captures list -f json --status pending [--tenant <t>]
   ```
   Returns a JSON array of `CaptureRequestRow` (exact shape in §4). See §6
   for how often to poll.

2. **Claim** before starting work, with a stable executor name (hostname,
   service account, agent id — not a random id per run):
   ```bash
   al-profile lifecycle captures claim <id> --by <executor-name>
   ```
   Exit 0 means you now hold the claim. Exit 1 means someone/something beat
   you to it, or the id doesn't exist — the error message names the row's
   **current status** (e.g. `status is claimed.` / `status is fulfilled.`)
   or says outright that the id doesn't exist, so retry logic can branch on
   the reason instead of just "failed."

3. **Capture** against the named `appId`/`objectType`/`objectId`/`methodName`
   (§4) — not against `reason`, which is a human-readable summary line and
   not guaranteed to parse back into the structured fields. On
   OnPrem/container targets, drive the capture with bc-dev-mcp's
   capture-and-ship recipe (a separate repository —
   `docs/capture-ship-recipe.md` there; not vendored or duplicated here).
   On SaaS targets where you can't install your own extension, the `cu1924`
   canary (the public Performance Profiler codeunit — see
   `docs/telemetry-recipe.md` §1) is the reachable capture path.

4. **Ship to the SAME tenant** that requested it — `tenant` on the
   `CaptureRequestRow` (§4) is the join key fulfillment matches on. Shipping
   to a different tenant does not error; the request simply never fulfills
   and eventually expires (§5). Get the tenant right on the way out — there
   is no "wrong tenant" failure to catch and retry on.

5. **Fulfillment is automatic.** There is no "mark fulfilled" call in this
   loop. Once the shipped profile is evaluated — `lifecycle evaluate` or the
   web ingest path — `evaluateRun`'s fulfillment hook matches the profile's
   method index against every pending/claimed request for that tenant by the
   same normalized routine key (`appId|objectType|objectId|methodName`) used
   at creation time, and flips matching rows to `fulfilled` with
   `fulfilledAt`/`fulfilledByProfileId` set. Shipping a profile that never
   gets evaluated fulfills nothing.

6. **Cancel** instead of leaving a claimed request to expire if you decide
   not to service it (target unreachable, false positive, deprioritized):
   ```bash
   al-profile lifecycle captures cancel <id>
   ```
   Same exit semantics as claim (0/1, current-status message on failure).
   Cancelling doesn't reopen the slot as a fresh pending request — if the
   underlying finding is still recurring, the next `lifecycle sync` scan
   will queue a new one once the identity is free of an active request
   again.

## 3. Claim is advisory (D5)

`claimCaptureRequest` only guards against two executors claiming the SAME
row (the `status = 'pending'` predicate makes the second claim fail). It is
not a lock on the target routine: nothing stops a second executor from
claiming a *different* request for the same routine, or a human from running
an ad-hoc capture outside the queue entirely — and a claimed request can
still be fulfilled by any matching profile, from any source (see
`capture-fulfill.test.ts`'s "a claimed request is also fulfillable" case).

The claim TTL itself is **server-side, not something your executor builds**:
on every `lifecycle sync` scan, the engine reclaims any claim older than
`claimTtlMinutes` (default 60, configurable under `captureRequests` — see §1)
and returns the request to `pending` for another worker to pick up. Do not
also implement your own claim TTL — an executor that builds one on top of
this ends up with two independent timers racing each other. What stays
unchanged is that the claim is advisory only *between two live workers*
racing the same row; the reclaim above handles the dead-worker case for you.

One consequence: a slow-but-alive executor — one still working past
`claimTtlMinutes` — can have its claim reclaimed and the same request handed
to, and captured by, a second worker. That is wasteful, not corrupting: both
captures fulfil the same finding (§2 step 5), and the second is simply
redundant. If your captures routinely run longer than the default TTL, raise
`claimTtlMinutes` rather than re-adding a client-side guard.

**Note for bc-dev-mcp's `--keep-claim-on-failure`:** this flag's guarantee is
weaker than its name implies. It keeps the claim held after a failed capture
attempt (rather than cancelling it), but the engine reclaims a kept claim
just like any other, once it passes `claimTtlMinutes` — another worker can
then pick it up and retry. Arguably that outcome *is* the retry you wanted,
but the flag does not hold the request indefinitely, and an operator relying
on it to pin a request to one executor until it succeeds needs to know it
will eventually be reclaimed and handed elsewhere.

## 4. `CaptureRequestRow` — the exact JSON shape

This is `list -f json`'s array element type, verbatim (`src/lifecycle/store.ts`):

```typescript
interface CaptureRequestRow {
	id: number;
	tenant: string;
	fingerprint: string; // telemetry:<16hex> — the requesting finding's identity
	findingId: number;
	appId: string;
	appName: string | null;
	objectType: string; // e.g. "Codeunit"
	objectId: number;
	methodName: string; // trigger-normalized, lowercased
	reason: string; // human summary, e.g. "RT0018: 5 runs, severity critical"
	status: "pending" | "claimed" | "fulfilled" | "expired" | "cancelled";
	requestedAt: string; // ISO 8601
	expiresAt: string; // ISO 8601
	claimedAt: string | null;
	claimedBy: string | null;
	fulfilledAt: string | null;
	fulfilledByProfileId: string | null;
}
```

Example row, as returned by `captures list -f json --status pending`:

```json
[
	{
		"id": 17,
		"tenant": "contoso",
		"fingerprint": "telemetry:9f2c1a7b0e4d5f61",
		"findingId": 203,
		"appId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		"appName": "Sales Extensions",
		"objectType": "Codeunit",
		"objectId": 50100,
		"methodName": "processline",
		"reason": "RT0018: 5 runs, severity critical",
		"status": "pending",
		"requestedAt": "2026-07-01T09:00:00.000Z",
		"expiresAt": "2026-07-15T09:00:00.000Z",
		"claimedAt": null,
		"claimedBy": null,
		"fulfilledAt": null,
		"fulfilledByProfileId": null
	}
]
```

Text output (`-f text`, the default) renders the same rows as a
`cli-table3` table, the same style as `lifecycle status`.

## 5. TTL expiry

Requests live `ttlDays` (default 14) from `requestedAt`. `lifecycle sync`'s
scan sweeps expired pending/claimed rows to `status: "expired"` before
filing new ones each run — an executor sitting on a stale claim past the TTL
loses it silently (the row is no longer pending or claimed, so a late claim
or cancel attempt fails with `status is expired.`). If the underlying finding
is still recurring, it re-qualifies for a fresh request on a later scan.

## 6. Re-poll cadence

`lifecycle sync` (which runs the trigger scan) needs to run on a schedule of
its own for requests to appear at all — treat it like the `pull-telemetry`
cron in [`docs/telemetry-recipe.md`](telemetry-recipe.md) §4, a separate
tick on the same box or pipeline. Poll `captures list` no faster than new
telemetry findings can plausibly clear the thresholds; hourly is a
reasonable default alongside a 15-minute `pull-telemetry` pull — there is no
reason to poll on a tighter cadence than the scan that produces the rows.

## 7. Identity-upgrade migrations rekey requests, they never duplicate them

A finding's fingerprint isn't permanent: `lifecycle evaluate`/`lifecycle
sync` run with `--source` pointed at an AL workspace can trigger al-sem
fusion, which upgrades a pattern from its fallback identity to a stable
`stableRoutineId`-anchored one once the anchor routine confidently matches.
When that happens, the resulting `identity-upgrade` `FingerprintMigration` is
applied via `applyFingerprintMigration` **before** the run is evaluated — the
existing finding (and its capture requests, active or terminal) is renamed
to the new fingerprint, not left behind under the old one. An executor
polling `captures list` never sees a stale duplicate request under the old
identity alongside a fresh one under the new: the original request row is
what shows up, just with an updated `fingerprint` field, and a request
already claimed keeps its claim and status across the rekey.

## 8. Related docs

- [`docs/telemetry-recipe.md`](telemetry-recipe.md) — how findings enter the
  lifecycle DB in the first place, and §8 "Closing the loop" for the
  end-to-end cycle this file is one link in.
- [`docs/lifecycle-gh-recipe.md`](lifecycle-gh-recipe.md) — the digest/sink
  side, for comparison; capture requests are local DB state, not a delivery
  sink, so they have no GitHub-issue equivalent.
