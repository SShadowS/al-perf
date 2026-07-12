# Stale-Algo Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the stale-algo guard visible on the automated paths — the web ingest response and the operator status surfaces — instead of only a stderr line nobody reads.

**Architecture:** Three additive surfaces on existing state. No new persistence: "is this tenant stale-algo?" is already answerable by querying the store. One new store query, one specific catch in the ingest hook, two status surfaces. Plus a two-line doc cross-reference (unrelated follow-up, folded in).

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (`LifecycleStore`), `commander`, `bun:test`, Biome.

**Follow-up to:** `docs/superpowers/plans/2026-07-12-small-debt-batch.md` (Task 2 shipped the guard; this makes it audible).

## Global Constraints

- Tests run as `AI_DISABLED=1 bun test`. Never without that env var.
- `bunx tsc --noEmit` clean before any commit.
- `bunx biome check --write` on every touched file.
- Only `git add` the exact changed paths. The repo has ~200 CRLF-noise files that must never be staged. Never `git checkout`, `git reset`, or `git stash`.
- Every commit ends with the trailer:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- **Additive only.** The ingest response keeps `202 {id, status:"stored", keyVersion}`; the new `lifecycle` key is added alongside. `lifecycle status --format json` keeps emitting a bare array on stdout. Do not break either shape.
- **Do not open a lifecycle store where one wasn't opened before.** Lifecycle is opt-in via `AL_PERF_LIFECYCLE=1`; creating a DB just to answer a status query would be a regression.

---

## Background

`src/lifecycle/evaluate.ts` throws `StaleAlgoVersionError` when a tenant holds active findings fingerprinted by an older `FINGERPRINT_ALGO_VERSION`. On the CLI that's loud — the process exits nonzero and prints the remedy.

On the web ingest path it is not. `web/handlers/ingest.ts:390-426` calls `evaluateRun` inside a `try/catch` that logs and swallows, then returns `202 {status: "stored"}`. So a stale-algo tenant gets: one stderr line, a success response, and lifecycle tracking silently doing nothing — every ingest, forever.

The catch is correct for what it was built for. The file says so one block up (`ingest.ts:315-321`): a malformed config file "must fail the request outright (never swallowed into the hook's own try/catch, which exists for **runtime evaluation errors on an already-stored profile, not operator misconfiguration**)". `StaleAlgoVersionError` is operator misconfiguration. It is on the wrong side of that line.

We are not failing the request — the profile is genuinely stored, genuinely reanalyzable, and no data is corrupted (the guard throws before any write). We are making the response stop *claiming plain success*, and giving a monitor something to poll.

---

### Task 1: Store query — which tenants are blocked

**Files:**
- Modify: `src/lifecycle/store.ts` (add next to `countStaleAlgoFindings`)
- Test: `test/lifecycle/store.test.ts` (the existing `describe("stale algo-version findings")` block)

**Interfaces:**
- Produces: `LifecycleStore.listStaleAlgoTenants(currentVersion: number): Array<{ tenant: string; count: number; versions: number[] }>` — every tenant with at least one active (non-closed) finding at a different algo version. Empty array in the normal case. Ordered by tenant for deterministic output.

- [ ] **Step 1: Write the failing test**

```typescript
	it("listStaleAlgoTenants reports every blocked tenant, and nothing when clean", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "acme", "pattern:ddddddddddddddd1", 1);
		seed(store, "acme", "pattern:ddddddddddddddd2", 1);
		seed(store, "beta", "pattern:ddddddddddddddd3", 1);
		seed(store, "clean", "pattern:ddddddddddddddd4", 2);

		expect(store.listStaleAlgoTenants(2)).toEqual([
			{ tenant: "acme", count: 2, versions: [1] },
			{ tenant: "beta", count: 1, versions: [1] },
		]);
		expect(store.listStaleAlgoTenants(1)).toEqual([
			{ tenant: "clean", count: 1, versions: [2] },
		]);
		store.close();
	});
```

Reuse the `seed` helper already in that describe block. Match its signature.

- [ ] **Step 2: Run it, confirm it fails**

`AI_DISABLED=1 bun test test/lifecycle/store.test.ts -t "listStaleAlgoTenants"` → FAIL, not a function.

- [ ] **Step 3: Implement**

```typescript
	/**
	 * Every tenant currently blocked by the stale-algo guard. Same predicate as
	 * countStaleAlgoFindings, widened across tenants — the query the status
	 * surfaces poll so an operator learns about a blocked tenant from a
	 * dashboard rather than from a stderr line in a headless service's log.
	 */
	listStaleAlgoTenants(
		currentVersion: number,
	): Array<{ tenant: string; count: number; versions: number[] }> {
		const rows = this.db
			.query<{ tenant: string; algo_version: number; n: number }, [number]>(
				`SELECT tenant, algo_version, COUNT(*) AS n FROM findings
				 WHERE state != 'closed' AND algo_version != ?
				 GROUP BY tenant, algo_version
				 ORDER BY tenant, algo_version`,
			)
			.all(currentVersion);
		const byTenant = new Map<string, { tenant: string; count: number; versions: number[] }>();
		for (const r of rows) {
			const entry = byTenant.get(r.tenant);
			if (entry) {
				entry.count += r.n;
				entry.versions.push(r.algo_version);
			} else {
				byTenant.set(r.tenant, { tenant: r.tenant, count: r.n, versions: [r.algo_version] });
			}
		}
		return [...byTenant.values()];
	}
```

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
AI_DISABLED=1 bun test test/lifecycle/store.test.ts
bunx tsc --noEmit
bunx biome check --write src/lifecycle/store.ts test/lifecycle/store.test.ts
git add src/lifecycle/store.ts test/lifecycle/store.test.ts
```

---

### Task 2: Ingest tells the truth

**Files:**
- Modify: `web/handlers/ingest.ts:390-430`
- Test: `test/web/lifecycle-ingest.test.ts`

**Interfaces:**
- Consumes: `StaleAlgoVersionError` (exported from `src/lifecycle/evaluate.ts`), `FINGERPRINT_ALGO_VERSION` (from `src/lifecycle/fingerprint.ts`).
- Produces: the ingest 202 body gains an optional `lifecycle` key. Absent on the happy path (keep the common response byte-identical). Present only when the guard fired:
  ```json
  { "id": "...", "status": "stored", "keyVersion": 1,
    "lifecycle": { "status": "blocked", "reason": "stale-algo",
                   "remediation": "lifecycle maintain --purge-stale-fingerprints --tenant acme" } }
  ```

- [ ] **Step 1: Write the failing test**

In `test/web/lifecycle-ingest.test.ts`, following that file's existing harness (it already drives ingest with `AL_PERF_LIFECYCLE=1`):

Seed the lifecycle store for the test tenant with one active finding at `FINGERPRINT_ALGO_VERSION + 1`, POST a profile, then assert:
- status is still `202`
- `body.status === "stored"` (the profile IS stored — verify the ciphertext exists on disk, as the file's other tests do)
- `body.lifecycle.status === "blocked"`, `body.lifecycle.reason === "stale-algo"`
- `body.lifecycle.remediation` contains `--purge-stale-fingerprints` and the tenant

And a second test: on a CLEAN tenant, the response body has NO `lifecycle` key at all (the happy path must not change shape).

- [ ] **Step 2: Run it, confirm it fails** — no `lifecycle` key today.

- [ ] **Step 3: Implement**

Replace the catch at `web/handlers/ingest.ts:420-426`. The existing catch must keep swallowing everything else — this adds ONE specific branch, it does not change the general policy.

```typescript
	let lifecycleBlocked: {
		status: "blocked";
		reason: "stale-algo";
		remediation: string;
	} | null = null;

	if (process.env.AL_PERF_LIFECYCLE === "1") {
		try {
			// ... existing evaluateRun call, unchanged ...
		} catch (err) {
			// StaleAlgoVersionError is operator misconfiguration, not a runtime
			// evaluation error — the distinction this file already draws for a
			// malformed config file above. We still don't fail the request (the
			// profile is stored and reanalyzable, and the guard threw before any
			// write), but the response must stop claiming plain success: lifecycle
			// tracking is doing nothing for this tenant on EVERY ingest until an
			// operator purges, and a stderr line in a headless service is the
			// weakest signal there is.
			const { StaleAlgoVersionError } = await import(
				"../../src/lifecycle/evaluate.ts"
			);
			if (err instanceof StaleAlgoVersionError) {
				lifecycleBlocked = {
					status: "blocked",
					reason: "stale-algo",
					remediation: `lifecycle maintain --purge-stale-fingerprints --tenant ${err.tenant}`,
				};
			}
			console.error(
				`[lifecycle] evaluation failed for tenant ${tenantCode} activity ${activityId}: ${err}`,
			);
		}
	}

	return jsonResponse(202, {
		id: activityId,
		status: "stored",
		keyVersion: Number(KEY_VERSION_POC),
		...(lifecycleBlocked ? { lifecycle: lifecycleBlocked } : {}),
	});
```

Note the dynamic `import()` — this file already imports lifecycle modules dynamically inside the hook (so the POC path never loads them). Keep that. If a static import is cleaner and does not load lifecycle code on the non-lifecycle path, use it — but verify.

- [ ] **Step 4: Run, typecheck, lint, commit**

---

### Task 3: Status surfaces

**Files:**
- Modify: `web/server.ts:983-996` (the `/api/debug/status` handler)
- Modify: `src/cli/commands/lifecycle.ts:854+` (the `status` subcommand action)
- Test: `test/web/server.test.ts`, `test/lifecycle/cli.test.ts`

**Interfaces:**
- Consumes: `LifecycleStore.listStaleAlgoTenants` from Task 1.
- Produces: `/api/debug/status` gains `staleAlgoTenants: Array<{tenant, count, versions}>`. `lifecycle status` prints a warning when the queried tenant is blocked.

- [ ] **Step 1: `/api/debug/status`**

Add `staleAlgoTenants` to the JSON. **Only query when `AL_PERF_LIFECYCLE === "1"`** — otherwise report `[]` without opening a store (opening one would create a lifecycle DB on a deployment that doesn't use lifecycle: a regression). Use the same `getLifecycleStore(dataDir)` accessor `ingest.ts` uses.

Test: with lifecycle off, `staleAlgoTenants` is `[]` and no DB file is created. With lifecycle on and a seeded stale finding, it reports the tenant.

- [ ] **Step 2: `lifecycle status`**

When `listStaleAlgoTenants(FINGERPRINT_ALGO_VERSION)` contains the queried tenant, warn — naming the count, the versions, and the remedy command.

Shape rules, both load-bearing:
- `--format table`: print the warning as a visible banner ABOVE the table, via `console.log`.
- `--format json`: write the warning to **stderr** (`process.stderr.write`), NOT stdout. Stdout must stay a bare parseable JSON array — piping `lifecycle status -f json | jq` must keep working. Pin that in a test.

- [ ] **Step 3: Run, typecheck, lint, commit**

---

### Task 4: The autoFile doc cross-reference

**Files:**
- Modify: `docs/lifecycle-ado-recipe.md`

Unrelated to the guard; folded in because it is two lines and was deferred from the same review.

Task 3 of the small-debt batch changed the backlog paragraph to say a newly-enabled sink picks up the live backlog on its first `sync`. What that paragraph does not say, and should: enabling `autoFile` on a tenant with long history now files that whole backlog **in one burst**, where previously findings trickled in as they recurred. That sits directly against the data-egress/confidentiality warning further down the same file (around lines 168-179).

- [ ] **Step 1:** Add a sentence to the backlog paragraph pointing at the confidentiality note, and advising the operator to review the digest (`lifecycle digest`) before enabling `autoFile` on a mature tenant. Do not restate the warning — link to it.

- [ ] **Step 2: Commit** (docs only, no tests).

---

## Self-Review

**Coverage:** every surface named in the chosen option is a task — store query (1), honest ingest response (2), `/api/debug/status` + `lifecycle status` (3) — plus the deferred doc note (4).

**Type consistency:** `listStaleAlgoTenants(currentVersion: number)` returns `Array<{tenant, count, versions}>`, declared in Task 1 and consumed with those exact field names in Task 3. `StaleAlgoVersionError.tenant` is used in Task 2's remediation string; that field exists (declared in the small-debt batch's Task 2).

**Non-breaking:** the happy-path ingest body is unchanged (the `lifecycle` key is spread in only when blocked); `lifecycle status -f json` stdout stays a bare array. Both are pinned by tests, not just asserted here.
