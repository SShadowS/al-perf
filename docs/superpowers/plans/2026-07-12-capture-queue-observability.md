# Capture-Queue Observability and Self-Correction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deep-capture queue tell you when it has stopped working, and make a dead executor's claims come back on their own.

**Architecture:** One new schema column (`reclaim_count`, migration v7) and one new sweep (`reclaimStaleClaims`) inside the existing trigger transaction. Three read surfaces over state that already exists: a fixed `sync` warning, a new `captures health` subcommand, and a jammed-only block in `digest`.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (`LifecycleStore`), `commander`, `cli-table3`, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-07-12-capture-queue-observability-design.md`

## Global Constraints

- Tests run as `AI_DISABLED=1 bun test`. Never run the suite without that env var.
- `bunx tsc --noEmit` must be clean before any commit.
- `bunx biome check --write <files>` on every file you touch.
- The repo has ~200 files that show as stat-dirty from CRLF/`core.autocrlf` noise. **Only ever `git add` the exact paths you changed.** Never `git add -A`, never `git add .`, never `git checkout`/`reset`/`stash`.
- Every commit message ends with the trailer:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- **Task 1 owns migration v7.** No other task adds a migration. `LIFECYCLE_MIGRATIONS` entries are append-only and never mutated once shipped (`src/lifecycle/store.ts:25-28`). The ladder is currently at v6.
- **"Jammed" has exactly one definition: the tenant is at `maxPending`.** Not an age threshold, not a tunable. That is the state in which new capture requests genuinely stop being filed. Do not invent a second definition in any surface.
- **Every test must fail if the behavior it claims to pin is broken.** The last batch shipped three test defects: tests that rebuilt the production expression inside their own body (asserting nothing about production), and fixtures that never created the state they claimed to check (passing with the production code deleted). Where you have any doubt, break the source, watch the test go red, restore it, confirm green — and report that evidence.

---

## File Structure

| Task | Modifies |
|---|---|
| 1 | `src/lifecycle/store.ts` (migration v7, `reclaimStaleClaims`, `reclaimCount` on the row type), `src/lifecycle/config.ts` (`claimTtlMinutes`), `src/lifecycle/capture-triggers.ts` (`reclaimed` in the report), `test/lifecycle/capture-triggers.test.ts`, `test/lifecycle/store.test.ts` |
| 2 | `src/cli/commands/lifecycle.ts` (the `sync` text output), `test/lifecycle/sync-cli.test.ts` |
| 3 | `src/lifecycle/store.ts` (`captureQueueHealth`), `src/cli/commands/lifecycle.ts` (the `captures health` subcommand), `test/lifecycle/store.test.ts`, `test/lifecycle/cli.test.ts` |
| 4 | `src/lifecycle/digest.ts`, `src/cli/commands/lifecycle.ts` (digest wiring, if needed), `test/lifecycle/digest.test.ts`, `docs/capture-request-contract.md` |

Tasks 2, 3, and 4 all consume Task 1's output, so **Task 1 must land first**. After that, 2/3/4 are independent of one another (different files, different surfaces) — except that 3 and 4 both add a store query, so they should not run concurrently in the same worktree.

---

### Task 1: Auto-reclaim stale claims

**Files:**
- Modify: `src/lifecycle/config.ts` — add `claimTtlMinutes` to the `captureRequests` block (interface ~line 36-46, defaults ~line 69-74).
- Modify: `src/lifecycle/store.ts` — append migration index 6 (schema v7) to `LIFECYCLE_MIGRATIONS`; add `reclaimStaleClaims`; add `reclaimCount` to `CaptureRequestRow` (line 374) and to `rowToCaptureRequest` (line 1404).
- Modify: `src/lifecycle/capture-triggers.ts` — add `reclaimed` to `CaptureTriggerReport` (line 28) and call the sweep in `processCaptureTriggers` (line 91).
- Modify: `src/lifecycle/config.ts` — bump `LIFECYCLE_SCHEMA_VERSION` to `7`.
- Test: `test/lifecycle/store.test.ts`, `test/lifecycle/capture-triggers.test.ts`.

**Interfaces:**
- Produces:
  - `LifecycleStore.reclaimStaleClaims(now: string, claimTtlMinutes: number): number` — returns the number of rows reclaimed.
  - `CaptureRequestRow.reclaimCount: number` — new field on the existing row type.
  - `CaptureTriggerReport.reclaimed: number` — new field, alongside the existing `scanned`, `created`, `expired`, `skippedMaxPending`.
  - `LifecycleConfig.captureRequests.claimTtlMinutes: number` — default `60`.

**Background.** There is no server-side claim TTL today. `claimCaptureRequest` (`store.ts:1497`) only moves `pending → claimed`; nothing moves it back. A request held by an executor that died stays `claimed` until a human runs `captures cancel` or its **creation-time** TTL elapses — which, depending on when it was claimed, could be thirteen days later or one.

Two details of the reclaim are load-bearing and easy to get wrong:

- **`claimed_at` MUST be nulled.** Leave it set and the next sweep immediately re-reclaims the row it just reclaimed, incrementing `reclaim_count` on every scan forever.
- **`claimed_by` MUST be kept.** It is semantically odd on a `pending` row, and it is the only breadcrumb naming which executor dropped the request — without it, the evidence of a dead executor evaporates at the exact moment the sweep runs. `claimCaptureRequest` overwrites it on the next claim, so it reads as "last claimed by".

- [ ] **Step 1: Write the failing store tests**

Add to `test/lifecycle/store.test.ts`. Match the existing capture-request fixture helpers in that file (`baseFinding()`, `baseCaptureRequest({ findingId })` — check their real signatures and use them).

```typescript
describe("reclaimStaleClaims", () => {
	const T0 = "2026-07-01T00:00:00Z";

	it("returns a stale claim to pending, nulls claimed_at, KEEPS claimed_by, counts the reclaim", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		const [row] = store.listCaptureRequests();
		expect(store.claimCaptureRequest(row.id, "executor-1", T0)).toBe(true);

		// 61 minutes later, with a 60-minute claim TTL.
		const reclaimed = store.reclaimStaleClaims("2026-07-01T01:01:00Z", 60);
		expect(reclaimed).toBe(1);

		const [after] = store.listCaptureRequests();
		expect(after.status).toBe("pending");
		expect(after.claimedAt).toBeNull();
		expect(after.claimedBy).toBe("executor-1"); // the breadcrumb survives
		expect(after.reclaimCount).toBe(1);
		store.close();
	});

	it("leaves a FRESH claim alone", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		const [row] = store.listCaptureRequests();
		store.claimCaptureRequest(row.id, "executor-1", T0);

		// 59 minutes later — inside the 60-minute TTL.
		expect(store.reclaimStaleClaims("2026-07-01T00:59:00Z", 60)).toBe(0);

		const [after] = store.listCaptureRequests();
		expect(after.status).toBe("claimed");
		expect(after.claimedAt).not.toBeNull();
		expect(after.reclaimCount).toBe(0);
		store.close();
	});

	it("does not re-reclaim on the next sweep (claimed_at was nulled)", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		const [row] = store.listCaptureRequests();
		store.claimCaptureRequest(row.id, "executor-1", T0);

		expect(store.reclaimStaleClaims("2026-07-01T01:01:00Z", 60)).toBe(1);
		// Immediately sweep again. A row left with claimed_at set would be
		// reclaimed a second time, and every scan thereafter, forever.
		expect(store.reclaimStaleClaims("2026-07-01T01:02:00Z", 60)).toBe(0);
		expect(store.listCaptureRequests()[0].reclaimCount).toBe(1);
		store.close();
	});

	it("only touches claimed rows — pending/fulfilled/expired/cancelled are inert", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		// Left pending, never claimed.
		expect(store.reclaimStaleClaims("2026-08-01T00:00:00Z", 60)).toBe(0);
		expect(store.listCaptureRequests()[0].status).toBe("pending");
		store.close();
	});
});
```

- [ ] **Step 2: Run them, confirm they fail**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts -t "reclaimStaleClaims"`
Expected: FAIL — `store.reclaimStaleClaims is not a function`.

- [ ] **Step 3: Add migration v7 and bump the schema version**

Append a seventh entry to `LIFECYCLE_MIGRATIONS` in `src/lifecycle/store.ts` (after the sixth, which ends the array):

```typescript
	[
		// Purely additive — no table rebuild, no FK-toggle complications.
		//
		// Counts how many times a request has been reclaimed from a stale claim.
		// This is what separates two failure modes that look identical from the
		// outside: an executor that DIED (many requests, one reclaim each) versus a
		// POISON request that kills whatever picks it up (one request, many
		// reclaims). `captures health` surfaces it; nothing acts on it automatically.
		`ALTER TABLE capture_requests ADD COLUMN reclaim_count INTEGER NOT NULL DEFAULT 0`,
	],
```

Then in `src/lifecycle/config.ts`: `export const LIFECYCLE_SCHEMA_VERSION = 7;`

- [ ] **Step 4: Add the config field**

In `src/lifecycle/config.ts`, in the `captureRequests` interface block (after `maxPending`):

```typescript
		/**
		 * Minutes after which a CLAIMED request whose executor never reported back
		 * is returned to `pending` for another worker. The claim is advisory (see
		 * docs/capture-request-contract.md); this is the engine-side backstop for
		 * an executor that died mid-capture. Generous by default: a slow-but-alive
		 * executor that gets reclaimed causes a duplicate capture — wasteful, not
		 * corrupting, since both fulfil the same finding.
		 */
		claimTtlMinutes: number;
```

And in the defaults block (after `maxPending: 20,`):

```typescript
		claimTtlMinutes: 60,
```

- [ ] **Step 5: Implement `reclaimStaleClaims` and surface `reclaimCount`**

In `src/lifecycle/store.ts`, add next to `expireCaptureRequests` (~line 1515):

```typescript
	/**
	 * Return claims older than `claimTtlMinutes` to `pending` so another worker
	 * can take them — the engine-side backstop for an executor that died
	 * mid-capture (nothing else ever moves a row out of `claimed`).
	 *
	 * `claimed_at` MUST be nulled: leave it set and the next sweep re-reclaims the
	 * row it just reclaimed, on every scan, forever.
	 *
	 * `claimed_by` is deliberately KEPT. It is odd on a `pending` row, but it is
	 * the only breadcrumb naming which executor dropped the request — without it
	 * the evidence of a dead executor evaporates at the exact moment the sweep
	 * runs. `claimCaptureRequest` overwrites it on the next claim, so read it as
	 * "last claimed by".
	 */
	reclaimStaleClaims(now: string, claimTtlMinutes: number): number {
		const cutoff = new Date(
			Date.parse(now) - claimTtlMinutes * 60_000,
		).toISOString();
		const res = this.db.run(
			`UPDATE capture_requests
			 SET status = 'pending',
			     claimed_at = NULL,
			     reclaim_count = reclaim_count + 1
			 WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
			[cutoff],
		);
		return res.changes;
	}
```

Add `reclaimCount: number;` to `CaptureRequestRow` (`store.ts:374`), after `claimedBy`. Add to `rowToCaptureRequest` (`store.ts:1404`):

```typescript
			reclaimCount: (row.reclaim_count as number | null) ?? 0,
```

- [ ] **Step 6: Run the store tests**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts -t "reclaimStaleClaims"`
Expected: PASS, all four.

- [ ] **Step 7: Write the failing trigger-ordering test**

The sweep order matters: a request past its **creation** TTL must expire, not be recycled. Add to `test/lifecycle/capture-triggers.test.ts`, matching that file's existing fixture style:

```typescript
	it("expiry runs BEFORE reclaim — a past-TTL claimed request expires, it is not recycled", () => {
		const store = new LifecycleStore(":memory:");
		// Seed a claimed request whose creation TTL has ALSO elapsed, and whose
		// claim is stale. If reclaim ran first it would go back to pending; the
		// correct outcome is `expired`.
		// (Build the finding + request with this file's existing helpers, claim it,
		// then run processCaptureTriggers at a `now` past BOTH expires_at and the
		// claim TTL.)
		const report = processCaptureTriggers(store, cfg, PAST_BOTH);
		expect(report.expired).toBe(1);
		expect(report.reclaimed).toBe(0);
		expect(store.listCaptureRequests()[0].status).toBe("expired");
		store.close();
	});

	it("a stale claim inside its creation TTL is reclaimed and reported", () => {
		const store = new LifecycleStore(":memory:");
		// Same seed, but `now` is past the claim TTL and BEFORE expires_at.
		const report = processCaptureTriggers(store, cfg, PAST_CLAIM_TTL_ONLY);
		expect(report.reclaimed).toBe(1);
		expect(report.expired).toBe(0);
		expect(store.listCaptureRequests()[0].status).toBe("pending");
		store.close();
	});
```

Fill in the fixture construction from the helpers already in that file (see its existing `"after the expiry sweep reaps the old request, a later scan re-creates it"` test at ~line 155 for the shape). Use the real config object the other tests use, with `claimTtlMinutes` set.

- [ ] **Step 8: Run them, confirm they fail**

Run: `AI_DISABLED=1 bun test test/lifecycle/capture-triggers.test.ts -t "reclaim"`
Expected: FAIL — `report.reclaimed` is `undefined`.

- [ ] **Step 9: Wire the sweep into the trigger scan**

In `src/lifecycle/capture-triggers.ts`, add to `CaptureTriggerReport` (line 28), after `expired`:

```typescript
	/** Stale claims returned to `pending` for another worker (executor died mid-capture). */
	reclaimed: number;
```

In `processCaptureTriggers`, at the top of the transaction (line 91), immediately **after** the existing `expireCaptureRequests` call:

```typescript
		const expired = store.expireCaptureRequests(now);
		// Order matters: a request past its CREATION ttl must die, not be recycled.
		// Expire first, then reclaim whatever survived.
		const reclaimed = store.reclaimStaleClaims(now, cfg.claimTtlMinutes);
```

Note `cfg` is `config.captureRequests`, already destructured a few lines below in the current code — move that destructure above these two calls if needed, or read `config.captureRequests.claimTtlMinutes` directly. Then add `reclaimed` to the returned report object (line 136).

- [ ] **Step 10: Run the trigger tests, then the full suite**

```bash
AI_DISABLED=1 bun test test/lifecycle/capture-triggers.test.ts
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/lifecycle/store.ts src/lifecycle/config.ts src/lifecycle/capture-triggers.ts test/lifecycle/store.test.ts test/lifecycle/capture-triggers.test.ts
```
Expected: all green. `test/lifecycle/migrations.test.ts` exercises the ladder — if it asserts a specific `LIFECYCLE_SCHEMA_VERSION`, update it to 7.

- [ ] **Step 11: Commit**

```bash
git add src/lifecycle/store.ts src/lifecycle/config.ts src/lifecycle/capture-triggers.ts test/lifecycle/store.test.ts test/lifecycle/capture-triggers.test.ts test/lifecycle/migrations.test.ts
git commit -m "$(cat <<'EOF'
feat(lifecycle): reclaim capture requests from dead executors

There was no server-side claim TTL: claimCaptureRequest only ever moved
pending -> claimed, and nothing moved it back. A request held by an executor
that died sat there until a human ran `captures cancel` or its CREATION-time
TTL elapsed — which, depending on when it was claimed, could be thirteen days
later or one.

reclaimStaleClaims returns claims older than claimTtlMinutes (default 60) to
pending. It runs after the expiry sweep, not before: a request past its
creation TTL must die rather than be recycled.

Two details are load-bearing. claimed_at is nulled, because a row left with it
set would be re-reclaimed on every subsequent scan forever. claimed_by is
deliberately KEPT — odd on a pending row, but it is the only breadcrumb naming
which executor dropped the request, and without it the evidence of a dead
executor evaporates at the exact moment the sweep runs.

reclaim_count (migration v7) separates a dead executor (many requests, one
reclaim each) from a poison request that kills whatever picks it up (one
request, many reclaims).

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 2: Make starvation visible in `sync`

**Files:**
- Modify: `src/cli/commands/lifecycle.ts:1312-1316` (the `sync` text-mode print) and the JSON summary at `:1292-1296`.
- Test: `test/lifecycle/sync-cli.test.ts`.

**Interfaces:**
- Consumes: `CaptureTriggerReport.reclaimed` from Task 1.

**Background — this is the headline bug.** When the executor dies, the queue fills to `maxPending` and qualifying findings stop generating requests. `processCaptureTriggers` counts them in `skippedMaxPending`. The current print (`lifecycle.ts:1312`):

```ts
if (captureRequests.created > 0 || captureRequests.expired > 0) {
    console.log(`Capture requests: ${created} created, ${expired} expired.`);
}
```

In the starvation state `created` and `expired` are both `0`, so the guard is `0 > 0 || 0 > 0` and **no line prints at all**. A jammed pipeline is byte-identical, on stdout, to a healthy idle one. The count exists only in `sync -f json`.

- [ ] **Step 1: Write the failing test**

Add to `test/lifecycle/sync-cli.test.ts`, following that file's existing harness (temp dir, temp db, config file, `createLifecycleCommand().parseAsync`, and its `console.log` spy).

Seed a tenant already at its `maxPending` cap with a qualifying finding that will therefore be skipped, and set the config so `created` and `expired` both come back `0`. That is the exact starvation state.

```typescript
	it("sync warns when findings were skipped at the maxPending cap (the queue is jammed)", async () => {
		// Seed: tenant at maxPending with active requests, plus one MORE qualifying
		// finding that will be skipped. No new requests can be created and nothing
		// is due to expire — created == 0 && expired == 0 && skippedMaxPending > 0.
		// (Build this with the same helpers the other tests in this file use.)

		logSpy.mockClear();
		await run(["sync"]);

		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Capture requests:");
		expect(printed).toMatch(/NOT requested/i);
		expect(printed).toContain("maxPending");
		expect(printed).toContain("captures health");
	});
```

This test MUST fail against today's code — the current guard prints nothing at all in this state. If it passes before you change anything, your fixture is not actually in the starvation state; fix the fixture, not the test.

- [ ] **Step 2: Run it, confirm it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/sync-cli.test.ts -t "jammed"`
Expected: FAIL — nothing printed.

- [ ] **Step 3: Fix the guard and add the warning**

Replace `src/cli/commands/lifecycle.ts:1312-1316`:

```typescript
				const cr = captureRequests;
				// The guard must include skippedMaxPending. In the starvation state
				// — executor dead, queue at the cap — created and expired are BOTH
				// zero, so a guard on those two alone prints nothing, and a jammed
				// pipeline looks byte-identical to a healthy idle one on stdout.
				if (
					cr.created > 0 ||
					cr.expired > 0 ||
					cr.reclaimed > 0 ||
					cr.skippedMaxPending > 0
				) {
					console.log(
						`Capture requests: ${cr.created} created, ${cr.expired} expired, ${cr.reclaimed} reclaimed.`,
					);
				}
				if (cr.skippedMaxPending > 0) {
					console.log(
						`  WARNING: ${cr.skippedMaxPending} finding(s) qualified but were NOT requested — tenant at the maxPending cap (${lifecycleConfig.captureRequests.maxPending}). The queue may be jammed. Run: lifecycle captures health`,
					);
				}
```

Also add `reclaimed` to the JSON summary at `:1292-1296`:

```typescript
				captureRequests: {
					created: captureRequests.created,
					expired: captureRequests.expired,
					reclaimed: captureRequests.reclaimed,
					skippedMaxPending: captureRequests.skippedMaxPending,
				},
```

- [ ] **Step 4: Run it**

Run: `AI_DISABLED=1 bun test test/lifecycle/sync-cli.test.ts`
Expected: PASS. The existing JSON assertion at `sync-cli.test.ts:460` must stay green.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bunx tsc --noEmit
bunx biome check --write src/cli/commands/lifecycle.ts test/lifecycle/sync-cli.test.ts
git add src/cli/commands/lifecycle.ts test/lifecycle/sync-cli.test.ts
git commit -m "$(cat <<'EOF'
fix(lifecycle): sync was silent in exactly the state that matters

When the executor dies, the queue fills to maxPending and qualifying findings
stop generating capture requests. processCaptureTriggers counts them in
skippedMaxPending — but sync's text-mode guard was `created > 0 || expired > 0`,
and in that state both are zero. So the line didn't print at all: a jammed
pipeline was byte-identical, on stdout, to a healthy idle one. The count existed
only in `sync -f json`, for an operator who already knew to look for it.

The guard now includes skippedMaxPending (and reclaimed), and a skip gets its
own warning line naming the cap and pointing at `captures health`.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 3: `lifecycle captures health`

**Files:**
- Modify: `src/lifecycle/store.ts` — add `captureQueueHealth`.
- Modify: `src/cli/commands/lifecycle.ts` — add a `health` subcommand to the existing `captures` group (`:1520`), alongside `list`/`claim`/`cancel`.
- Test: `test/lifecycle/store.test.ts`, `test/lifecycle/cli.test.ts`.

**Interfaces:**
- Consumes: `CaptureRequestRow.reclaimCount` and `LifecycleConfig.captureRequests.claimTtlMinutes` from Task 1.
- Produces:
  ```typescript
  export interface CaptureQueueHealth {
      tenant: string;
      pending: number;
      claimed: number;
      /** Claimed longer than claimTtlMinutes — an executor that has not reported back. */
      stuck: number;
      /** Distinct executors holding stuck claims. */
      stuckHolders: string[];
      /** true when the tenant is at maxPending — the state in which new requests stop being filed. */
      atCap: boolean;
      maxPending: number;
      /** ISO timestamp of the oldest pending request, or null when none are pending. */
      oldestPendingAt: string | null;
      /** Requests reclaimed at least once. */
      reclaimedEver: number;
      /** The single most-reclaimed request, or null when none have been reclaimed. */
      mostReclaimed: { id: number; reclaimCount: number } | null;
  }
  ```
  `LifecycleStore.captureQueueHealth(now: string, claimTtlMinutes: number, maxPending: number, tenant?: string): CaptureQueueHealth[]` — one entry per tenant that has any capture requests, ordered by tenant. Scoped to one tenant when `tenant` is given.

**Background.** `captures list` prints raw ISO timestamps sliced to 19 characters — no age, no sort, no highlighting. Spotting a three-day-old claim from a dead executor is an eyeball exercise. `countActiveCaptureRequests` exists (`store.ts:1488`) but is internal to the `maxPending` check and exposed nowhere.

**This surface reports FACTS, NOT VERDICTS.** No "executor appears dead" heuristic — print the numbers and let the operator draw the conclusion. The one exception is `atCap`, which is not a heuristic: it is literally the state in which new requests stop being filed.

- [ ] **Step 1: Write the failing store test**

```typescript
describe("captureQueueHealth", () => {
	const NOW = "2026-07-10T00:00:00Z";

	it("reports depth, stuck claims with their holders, at-cap, oldest pending, and reclaims", () => {
		const store = new LifecycleStore(":memory:");
		// Seed for tenant "acme": 2 pending (one old), 2 claimed — one claimed long
		// ago by "dead-executor" (stuck), one claimed just now by "live-executor".
		// Give one request a reclaimCount of 3 by reclaiming it repeatedly, or by
		// claiming + sweeping three times.
		// (Use this file's existing baseFinding/baseCaptureRequest helpers.)

		const [health] = store.captureQueueHealth(NOW, 60, 4, "acme");

		expect(health.tenant).toBe("acme");
		expect(health.pending).toBe(2);
		expect(health.claimed).toBe(2);
		expect(health.stuck).toBe(1);
		expect(health.stuckHolders).toEqual(["dead-executor"]);
		expect(health.atCap).toBe(true); // 2 pending + 2 claimed == maxPending 4
		expect(health.maxPending).toBe(4);
		expect(health.oldestPendingAt).toBe("2026-07-01T00:00:00Z");
		expect(health.reclaimedEver).toBe(1);
		expect(health.mostReclaimed).toEqual({ id: expect.any(Number), reclaimCount: 3 });
		store.close();
	});

	it("a healthy queue reports atCap false, no stuck claims, no reclaims", () => {
		const store = new LifecycleStore(":memory:");
		// One pending request, maxPending 20.
		const [health] = store.captureQueueHealth(NOW, 60, 20, "acme");
		expect(health.atCap).toBe(false);
		expect(health.stuck).toBe(0);
		expect(health.stuckHolders).toEqual([]);
		expect(health.reclaimedEver).toBe(0);
		expect(health.mostReclaimed).toBeNull();
		store.close();
	});

	it("returns one entry per tenant when no tenant is given", () => {
		const store = new LifecycleStore(":memory:");
		// Seed requests for "acme" and "beta".
		const all = store.captureQueueHealth(NOW, 60, 20);
		expect(all.map((h) => h.tenant)).toEqual(["acme", "beta"]);
		store.close();
	});
});
```

`atCap` counts ACTIVE requests — `pending + claimed` — matching `countActiveCaptureRequests`'s `status IN ('pending','claimed')`, because that is the exact count `processCaptureTriggers` compares against `maxPending`. Do not invent a different denominator.

- [ ] **Step 2: Run it, confirm it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts -t "captureQueueHealth"`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement `captureQueueHealth`**

Add to `src/lifecycle/store.ts` near `listCaptureRequests`. Keep it simple: read the rows and reduce in TypeScript. Row counts are bounded by `maxPending` per tenant (the file already notes this at `store.ts:1487`), so a per-tenant SQL aggregate would be premature.

```typescript
	/**
	 * Queue health per tenant. Reports FACTS, not verdicts — no "the executor is
	 * dead" heuristic; the operator draws that conclusion from `stuck` and
	 * `stuckHolders`. `atCap` is the exception, and it is not a heuristic: it is
	 * literally the state in which processCaptureTriggers stops filing new
	 * requests, so it is the one crisp definition of a jammed queue.
	 */
	captureQueueHealth(
		now: string,
		claimTtlMinutes: number,
		maxPending: number,
		tenant?: string,
	): CaptureQueueHealth[] {
		const rows = this.listCaptureRequests(tenant);
		const cutoff = Date.parse(now) - claimTtlMinutes * 60_000;

		const byTenant = new Map<string, CaptureRequestRow[]>();
		for (const r of rows) {
			const bucket = byTenant.get(r.tenant);
			if (bucket) bucket.push(r);
			else byTenant.set(r.tenant, [r]);
		}

		return [...byTenant.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([t, rs]) => {
				const pending = rs.filter((r) => r.status === "pending");
				const claimed = rs.filter((r) => r.status === "claimed");
				const stuck = claimed.filter(
					(r) => r.claimedAt !== null && Date.parse(r.claimedAt) <= cutoff,
				);
				const reclaimed = rs.filter((r) => r.reclaimCount > 0);
				const worst = reclaimed.reduce<CaptureRequestRow | null>(
					(acc, r) => (acc === null || r.reclaimCount > acc.reclaimCount ? r : acc),
					null,
				);
				const oldestPendingAt = pending.reduce<string | null>(
					(acc, r) => (acc === null || r.requestedAt < acc ? r.requestedAt : acc),
					null,
				);
				return {
					tenant: t,
					pending: pending.length,
					claimed: claimed.length,
					stuck: stuck.length,
					stuckHolders: [
						...new Set(stuck.map((r) => r.claimedBy).filter((b): b is string => b !== null)),
					].sort(),
					// Same denominator processCaptureTriggers uses against maxPending.
					atCap: pending.length + claimed.length >= maxPending,
					maxPending,
					oldestPendingAt,
					reclaimedEver: reclaimed.length,
					mostReclaimed:
						worst === null ? null : { id: worst.id, reclaimCount: worst.reclaimCount },
				};
			});
	}
```

Export the `CaptureQueueHealth` interface from `store.ts`.

- [ ] **Step 4: Run the store tests**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts -t "captureQueueHealth"`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI test**

Add to `test/lifecycle/cli.test.ts`. Seed a jammed queue, run the command, assert the output carries the facts.

```typescript
	it("captures health reports depth, stuck claims, and the at-cap state", async () => {
		// Seed a jammed queue for tenant "acme" (at maxPending, one stuck claim).
		logSpy.mockClear();
		await run(["captures", "health", "--tenant", "ACME"]); // mixed case: must normalize

		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("acme");
		expect(printed).toMatch(/stuck/i);
		expect(printed).toContain("dead-executor");
		expect(printed).toMatch(/YES/); // at-cap
	});

	it("captures health -f json emits a bare parseable array on stdout", async () => {
		// Same seed. stdout must stay pipeable: `captures health -f json | jq`.
		const out: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((s: string) => {
			out.push(s);
			return true;
		}) as any);
		try {
			await run(["captures", "health", "-f", "json"]);
			const parsed = JSON.parse(out.join(""));
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed[0]).toHaveProperty("atCap");
		} finally {
			stdoutSpy.mockRestore();
		}
	});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/cli.test.ts -t "captures health"`
Expected: FAIL — commander rejects the unknown subcommand.

- [ ] **Step 7: Add the subcommand**

In `src/cli/commands/lifecycle.ts`, in the `captures` group (`:1520`), alongside `list`/`claim`/`cancel`. Load the config the same way `sync` does (the `--config` option on the parent command) so `claimTtlMinutes` and `maxPending` come from the operator's real config, not from hard-coded defaults.

```typescript
	captures
		.command("health")
		.description(
			"Queue health: depth, oldest pending, stuck claims, at-cap state",
		)
		.option("--tenant <tenant>", "Tenant key (all tenants if omitted)")
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action((opts: any) => {
			if (opts.tenant !== undefined) {
				const tenant = resolveTenantOpt(opts.tenant);
				if (tenant === null) return;
				opts.tenant = tenant;
			}
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const cfg = loadLifecycleConfig(cmd.opts().config).captureRequests;
				const now = new Date().toISOString();
				const health = store.captureQueueHealth(
					now,
					cfg.claimTtlMinutes,
					cfg.maxPending,
					opts.tenant,
				);
				if (opts.format === "json") {
					process.stdout.write(JSON.stringify(health, null, 2) + "\n");
					return;
				}
				if (health.length === 0) {
					console.log("No capture requests.");
					return;
				}
				for (const h of health) {
					const oldest =
						h.oldestPendingAt === null
							? "—"
							: `${Math.floor((Date.parse(now) - Date.parse(h.oldestPendingAt)) / 3_600_000)}h`;
					console.log(`Tenant: ${h.tenant}`);
					console.log(`  pending:  ${h.pending}   oldest: ${oldest}`);
					console.log(
						`  claimed:  ${h.claimed}   stuck (claimed > ${cfg.claimTtlMinutes}m): ${h.stuck}${
							h.stuckHolders.length > 0
								? `   last held by: ${h.stuckHolders.join(", ")}`
								: ""
						}`,
					);
					console.log(
						`  at maxPending cap (${h.maxPending}): ${h.atCap ? "YES" : "no"}`,
					);
					if (h.reclaimedEver > 0 && h.mostReclaimed !== null) {
						console.log(
							`  reclaimed at least once: ${h.reclaimedEver}   most-reclaimed: #${h.mostReclaimed.id} (${h.mostReclaimed.reclaimCount} times)`,
						);
					}
				}
			} finally {
				store.close();
			}
		});
```

`captures` here is the `Command` returned by `.command("captures")` at `:1520` — check how `list`/`claim`/`cancel` are attached in the current code and follow that exact pattern. `loadLifecycleConfig` is the loader `sync` already uses — find its real name in the imports at the top of the file and use it.

- [ ] **Step 8: Run, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test test/lifecycle/cli.test.ts test/lifecycle/store.test.ts
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/lifecycle/store.ts src/cli/commands/lifecycle.ts test/lifecycle/store.test.ts test/lifecycle/cli.test.ts
git add src/lifecycle/store.ts src/cli/commands/lifecycle.ts test/lifecycle/store.test.ts test/lifecycle/cli.test.ts
git commit -m "$(cat <<'EOF'
feat(lifecycle): add `captures health`

`captures list` printed raw ISO timestamps sliced to 19 characters — no age, no
sort, no highlighting — so spotting a three-day-old claim from a dead executor
was an eyeball exercise. countActiveCaptureRequests existed but was internal to
the maxPending check and exposed nowhere.

`captures health` reports depth, oldest pending, stuck claims with the executor
holding them, the at-cap state, and reclaim counts. Facts, not verdicts: there
is no "the executor is dead" heuristic — the operator draws that conclusion.
atCap is the exception, and it isn't a heuristic: it is literally the state in
which processCaptureTriggers stops filing new requests.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 4: Put the jammed queue in the digest, and fix the contract

**Files:**
- Modify: `src/lifecycle/digest.ts` — `DigestData` (`:38-56`), `buildDigest` (`:75`), `renderDigestMarkdown` (`:149`).
- Modify: `docs/capture-request-contract.md` — §3.
- Test: `test/lifecycle/digest.test.ts`.

**Interfaces:**
- Consumes: `LifecycleStore.captureQueueHealth` and `CaptureQueueHealth` from Task 3.
- Produces: `DigestData.captureQueue: CaptureQueueHealth | null` — `null` when the digest is not tenant-scoped or the tenant has no capture requests.

**Background — this is the layer that matters.** `sync`'s stdout is read by nobody on a cron box, and `captures health` only helps someone who already suspects a problem. The digest is what actually reaches a human: it drives the GitHub and Azure DevOps sinks. If the capture pipeline has jammed, that belongs where people already look.

**It must render ONLY when jammed.** A queue-health section that always appears would push routine chatter into every issue the digest drives, and the whole thing gets ignored inside a month. Jammed means `atCap || stuck > 0` — nothing else.

- [ ] **Step 1: Write the failing digest tests**

Add to `test/lifecycle/digest.test.ts`, matching its existing fixture style. **Both directions matter** — the absent case is the one that keeps the digest readable, so pin it as hard as the present case.

```typescript
describe("digest — capture queue", () => {
	it("includes a capture-queue warning when the queue is JAMMED (at cap)", () => {
		const store = new LifecycleStore(":memory:");
		// Seed tenant "acme" at maxPending with pending requests.
		const digest = buildDigest(store, { tenant: "acme" });
		expect(digest.captureQueue).not.toBeNull();
		expect(digest.captureQueue?.atCap).toBe(true);

		const md = renderDigestMarkdown(digest);
		expect(md).toMatch(/capture queue/i);
		expect(md).toMatch(/jammed/i);
		store.close();
	});

	it("includes it when claims are STUCK, even below the cap", () => {
		const store = new LifecycleStore(":memory:");
		// Seed one stale claim, well under maxPending.
		const digest = buildDigest(store, { tenant: "acme" });
		expect(digest.captureQueue?.stuck).toBeGreaterThan(0);
		expect(renderDigestMarkdown(digest)).toMatch(/capture queue/i);
		store.close();
	});

	it("renders NOTHING about the queue when it is healthy", () => {
		const store = new LifecycleStore(":memory:");
		// Seed one pending request, well under maxPending, no stuck claims.
		const digest = buildDigest(store, { tenant: "acme" });
		const md = renderDigestMarkdown(digest);
		expect(md).not.toMatch(/capture queue/i);
		store.close();
	});

	it("renders nothing about the queue when the tenant has no requests at all", () => {
		const store = new LifecycleStore(":memory:");
		const digest = buildDigest(store, { tenant: "acme" });
		expect(digest.captureQueue).toBeNull();
		expect(renderDigestMarkdown(digest)).not.toMatch(/capture queue/i);
		store.close();
	});
});
```

- [ ] **Step 2: Run them, confirm they fail**

Run: `AI_DISABLED=1 bun test test/lifecycle/digest.test.ts -t "capture queue"`
Expected: FAIL — `digest.captureQueue` is `undefined`.

- [ ] **Step 3: Implement**

`buildDigest` currently takes `(store, opts)`. It needs `claimTtlMinutes` and `maxPending` to compute health. Extend `DigestOptions` with an optional `captureRequests?: { claimTtlMinutes: number; maxPending: number }` — when absent, `captureQueue` is `null` and nothing renders. That keeps every existing `buildDigest` caller working unchanged, and lets the CLI pass the real config.

In `src/lifecycle/digest.ts`, add to `DigestData` (`:38`):

```typescript
	/**
	 * Queue health for the digest's tenant, or null when the digest is not
	 * tenant-scoped, the tenant has no capture requests, or the caller did not
	 * supply the capture config. Rendered ONLY when jammed — see
	 * renderDigestMarkdown.
	 */
	captureQueue: CaptureQueueHealth | null;
```

In `buildDigest`, after the existing queries:

```typescript
	let captureQueue: CaptureQueueHealth | null = null;
	if (tenant && opts?.captureRequests) {
		const [h] = store.captureQueueHealth(
			generatedAt,
			opts.captureRequests.claimTtlMinutes,
			opts.captureRequests.maxPending,
			tenant,
		);
		captureQueue = h ?? null;
	}
```

and include `captureQueue` in the returned object.

In `renderDigestMarkdown` (`:149`), after the header block:

```typescript
	// ONLY when jammed. A section that always renders would push routine queue
	// chatter into every GitHub/ADO issue the digest drives, and the whole digest
	// gets ignored inside a month.
	const q = digest.captureQueue;
	const jammed = q !== null && (q.atCap || q.stuck > 0);
	const queueBlock = jammed
		? [
				"> **⚠ Capture queue jammed.**",
				`> ${q.pending} pending, ${q.claimed} claimed (${q.stuck} stuck)${
					q.atCap ? `, at the maxPending cap (${q.maxPending})` : ""
				}.`,
				q.atCap
					? "> New capture requests are NOT being filed while the queue is at the cap."
					: "",
				q.stuckHolders.length > 0
					? `> Stuck claims last held by: ${q.stuckHolders.join(", ")}.`
					: "",
				"> Run `lifecycle captures health` for detail.",
				"",
			].filter((line) => line !== "")
		: [];
```

Splice `queueBlock` into the rendered output right after the header, before the totals.

- [ ] **Step 4: Wire the CLI's digest call**

In `src/cli/commands/lifecycle.ts:840`, pass the capture config through:

```typescript
				const digest = buildDigest(store, {
					// ... existing options unchanged ...
					captureRequests: {
						claimTtlMinutes: lifecycleConfig.captureRequests.claimTtlMinutes,
						maxPending: lifecycleConfig.captureRequests.maxPending,
					},
				});
```

The `digest` action must load the config the same way `sync` does. If it does not already, add that — check how `sync` reads `--config` and follow it.

- [ ] **Step 5: Run the digest tests**

Run: `AI_DISABLED=1 bun test test/lifecycle/digest.test.ts`
Expected: PASS, all four. The healthy-case tests are the ones that keep the digest readable — if they go red later, someone has made the block unconditional.

- [ ] **Step 6: Fix the executor contract**

`docs/capture-request-contract.md` §3 currently tells executor authors to build their own claim TTL:

> "If your executor pool needs stronger mutual exclusion, build it above this — e.g. your own scheduler enforcing a claim TTL, after which it re-polls and reclaims a stale claim."

That guidance is now **wrong** — the TTL ships server-side, and an executor that already built one will have two. Rewrite §3 to state that:

- The engine reclaims stale claims itself on the `sync` scan, after `claimTtlMinutes` (default 60), returning the request to `pending` for another worker.
- An executor should **remove** any claim TTL of its own.
- The claim remains advisory for mutual exclusion between two *live* workers racing the same row — that part is unchanged.
- A slow-but-alive executor can have its work reclaimed and captured twice. Wasteful, not corrupting: both captures fulfil the same finding. Raise `claimTtlMinutes` if your captures routinely run longer than it.

Add a short note to the same doc recording that **bc-dev-mcp's `--keep-claim-on-failure` now has a weaker guarantee than its name implies**: the worker keeps the claim on a failed capture, but the engine reclaims it after `claimTtlMinutes` anyway and another worker picks it up. Arguably that *is* retry — but the flag no longer holds the request indefinitely, and an operator relying on it must know.

- [ ] **Step 7: Run everything, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/lifecycle/digest.ts src/cli/commands/lifecycle.ts test/lifecycle/digest.test.ts
git add src/lifecycle/digest.ts src/cli/commands/lifecycle.ts test/lifecycle/digest.test.ts docs/capture-request-contract.md
git commit -m "$(cat <<'EOF'
feat(lifecycle): surface a jammed capture queue in the digest

sync's stdout is read by nobody on a cron box, and `captures health` only helps
someone who already suspects a problem. The digest is what actually reaches a
human — it drives the GitHub and Azure DevOps sinks. A jammed capture pipeline
belongs where people already look.

The block renders ONLY when jammed (at the maxPending cap, or holding stuck
claims). A section that always appeared would push routine queue chatter into
every issue the digest drives, and the digest would be ignored inside a month.
Both directions are pinned: present when jammed, absent when healthy.

Also fixes the executor contract. §3 told executor authors to build their own
claim TTL; that TTL now ships server-side, so an executor following the old
advice would have two. Records that bc-dev-mcp's --keep-claim-on-failure now
has a weaker guarantee than its name implies — the engine reclaims the kept
claim after claimTtlMinutes anyway.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

## Self-Review

**Spec coverage.** Auto-reclaim with `claimTtlMinutes`, `reclaim_count` (v7), and the expire-before-reclaim ordering → Task 1. The `sync` guard bug → Task 2. `captures health` → Task 3. The jammed-only digest block, the contract §3 rewrite, and the `--keep-claim-on-failure` note → Task 4. The spec's accepted limit (a poison request churns until its creation TTL, no reclaim cap) is honored by omission — no task adds one, and Task 1's migration comment records why.

**Type consistency.** `reclaimStaleClaims(now, claimTtlMinutes)` is declared in Task 1 and called with that signature in Task 1 Step 9. `CaptureRequestRow.reclaimCount` is added in Task 1 and read in Task 3's `captureQueueHealth`. `CaptureQueueHealth`'s nine fields are declared in Task 3's Interfaces block and used by exactly those names in Task 3's tests, its CLI renderer, and Task 4's digest renderer. `CaptureTriggerReport.reclaimed` is added in Task 1 and consumed in Task 2's guard and JSON summary.

**Known soft spots** — each carries an explicit instruction to verify against real code rather than trust the plan:
- Task 1 Steps 1/7: the real names of the capture-request fixture helpers in `store.test.ts` and `capture-triggers.test.ts`.
- Task 1 Step 9: whether `cfg` is already destructured above the expiry call in `processCaptureTriggers`.
- Task 3 Step 7: the real name of the config loader `sync` uses, and how `list`/`claim`/`cancel` attach to the `captures` group.
- Task 4 Step 4: whether the `digest` CLI action currently loads the config at all.
