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
(`DEFAULT_LIFECYCLE_CONFIG.captureRequests`), same honest-docs posture as the
telemetry severity thresholds (no CLI flag or config-file override in v1 —
a different threshold today is a build-time fork of this block):

```json
{
	"captureRequests": {
		"enabled": true,
		"minOccurrences": 3,
		"minSeverity": "warning",
		"ttlDays": 14,
		"maxPending": 20
	}
}
```

`maxPending` caps ACTIVE (pending/claimed) requests per tenant — further
qualifying candidates are skipped, not queued, until the count drops.

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
`capture-fulfill.test.ts`'s "a claimed request is also fulfillable" case). If
your executor pool needs stronger mutual exclusion, build it above this —
e.g. your own scheduler enforcing a claim TTL, after which it re-polls and
reclaims a stale claim.

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

## 7. Related docs

- [`docs/telemetry-recipe.md`](telemetry-recipe.md) — how findings enter the
  lifecycle DB in the first place, and §8 "Closing the loop" for the
  end-to-end cycle this file is one link in.
- [`docs/lifecycle-gh-recipe.md`](lifecycle-gh-recipe.md) — the digest/sink
  side, for comparison; capture requests are local DB state, not a delivery
  sink, so they have no GitHub-issue equivalent.
