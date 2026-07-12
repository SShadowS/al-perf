# Small-Debt Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four independent debt items in the lifecycle engine: pin CLI-level tenant normalization, guard against algorithm-version fingerprint orphaning, make sink event-processing per-sink so a newly-enabled sink picks up the backlog, and bound the epic dedupe key.

**Architecture:** Four disjoint changes. Task 1 is test-only. Task 2 adds a throw-guard in `evaluateRun` plus a purge escape hatch on `lifecycle maintain`. Task 3 replaces the global `finding_events.sink_processed` bit with a per-sink watermark table (schema migration v6) and inverts the trigger scan's loop nesting. Task 4 hashes the epic dedupe key instead of concatenating row ids.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (`LifecycleStore`), `commander`, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-07-12-small-debt-batch-design.md`

## Global Constraints

- Tests run as `AI_DISABLED=1 bun test`. Never run the suite without that env var.
- Type check with `bunx tsc --noEmit`. It must be clean before any commit.
- Lint/format with `bunx biome check --write <files>` on files you touched.
- Every commit message ends with the trailer:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- The repo has ~200 files that show as stat-dirty from CRLF/`core.autocrlf` noise. **Only ever `git add` the exact paths you changed.** Never `git add -A`, never `git add .`, never `git checkout`/`reset`.
- Migration ladder ownership: **Task 3 owns `LIFECYCLE_MIGRATIONS` index 5 (schema v6).** No other task adds a migration.
- `LIFECYCLE_MIGRATIONS` entries are append-only and are never mutated once shipped (`src/lifecycle/store.ts:25-28`).

---

## File Structure

| Task | Creates | Modifies |
|---|---|---|
| 1 | — | `test/lifecycle/cli.test.ts` |
| 2 | — | `src/lifecycle/evaluate.ts`, `src/lifecycle/store.ts`, `src/cli/commands/lifecycle.ts`, `test/lifecycle/evaluate.test.ts`, `test/lifecycle/cli.test.ts` |
| 3 | `test/lifecycle/sinks/backlog.test.ts` | `src/lifecycle/store.ts`, `src/lifecycle/config.ts`, `src/lifecycle/sinks/triggers.ts`, `src/cli/commands/lifecycle.ts`, `docs/lifecycle-ado-recipe.md` |
| 4 | — | `src/lifecycle/fingerprint.ts`, `src/lifecycle/sinks/outbox.ts`, `test/lifecycle/sinks/outbox.test.ts` |

Tasks 1, 2, and 4 are fully disjoint from each other. Task 3 shares two files with Task 2 (`store.ts`, `cli/commands/lifecycle.ts`) but touches different regions: Task 2 adds queries near the finding accessors and a flag on the `maintain` subcommand; Task 3 adds a migration, event-query methods, and a loop in the `sync` subcommand. Merges are textual, not semantic.

---

### Task 1: Pin CLI-level mixed-case `--tenant` behavior

Test-only. No source change is expected — this task pins behavior that already works, so that a future regression in `resolveTenantOpt`'s wiring is caught. If a test genuinely fails, that is a real bug: report it rather than editing the test to pass.

**Files:**
- Modify: `test/lifecycle/cli.test.ts` — add to the existing `describe("lifecycle --tenant normalization")` block, which ends at line 314.

**Interfaces:**
- Consumes: `createLifecycleCommand()` from `src/cli/commands/lifecycle.js`; `LifecycleStore`, `NewFinding` from `src/lifecycle/store.js`. All three are already imported at the top of this test file.
- Produces: nothing consumed by other tasks.

**Background for the implementer.** `resolveTenantOpt` (`src/cli/commands/lifecycle.ts:56`) lowercases and trims `--tenant` at the CLI boundary. `evaluateRun` also normalizes internally (`src/lifecycle/evaluate.ts:302`), so most commands are protected twice. The exception is `lifecycle evaluate`'s al-sem fusion branch (`src/cli/commands/lifecycle.ts:757-792`): it passes the CLI-normalized `tenant` variable to `applyIdentityUpgrades` **before** `evaluateRun` runs. If that variable were ever un-normalized, the fingerprint migration would be written under `ACME` while the findings live under `acme`, and the finding would fork into a duplicate. Nothing currently tests that.

The existing tests in this block use `--tenant` on `telemetry` and `status` only.

- [ ] **Step 1: Write the failing test for `evaluate` casing collision (no source)**

Add inside the `describe("lifecycle --tenant normalization")` block in `test/lifecycle/cli.test.ts`, before its closing `});` at line 314. Note `--profile-id`: `runs` has `UNIQUE (tenant, profile_id)` and `evaluate` defaults `profileId` to a hash of the file content, so two runs of the same fixture would otherwise be skipped as a duplicate run.

```typescript
	it("evaluate: two --tenant casings land on one finding, not two", async () => {
		await run([
			"evaluate",
			"test/fixtures/sampling-minimal.alcpuprofile",
			"--tenant",
			"ACME",
			"--profile-id",
			"p1",
			"--capture-time",
			"2026-07-01T00:00:00Z",
		]);
		await run([
			"evaluate",
			"test/fixtures/sampling-minimal.alcpuprofile",
			"--tenant",
			"acme",
			"--profile-id",
			"p2",
			"--capture-time",
			"2026-07-02T00:00:00Z",
		]);

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "acme" });
		expect(findings.length).toBeGreaterThan(0);
		// Every finding was seen twice — one row per problem, not two.
		for (const f of findings) {
			expect(store.countOccurrences(f.id)).toBe(2);
		}
		expect(store.listFindings({ tenant: "ACME" }).length).toBe(0);
		store.close();
	});
```

- [ ] **Step 2: Run it**

Run: `AI_DISABLED=1 bun test test/lifecycle/cli.test.ts -t "two --tenant casings land on one finding"`
Expected: PASS (it pins existing behavior). If it FAILS, stop and report — that is a real bug, not a test to fix.

- [ ] **Step 3: Write the `evaluate --source` fusion-branch test**

This is the actual gap. It drives the real fusion path so `applyIdentityUpgrades` executes with the CLI's `tenant` variable.

`fuseProfile` resolves its engine from the `engine` option, then the `AL_SEM_BIN` env var, then `alsem` on `PATH` (`src/semantic/fuse.ts:33-35`). The CLI passes no `engine` option, so setting `AL_SEM_BIN` to the stub binary is what makes the CLI use it.

Copy the `makeStubBinary` helper and the `WS_MIN` / `STUB_TS` / `FIXTURE_DIR` constants from `test/lifecycle/wire-fuse.integration.test.ts:36-75` into `test/lifecycle/cli.test.ts` (top-level, above the `describe`). Do not export them from the other test file — bun test files are not modules other tests should import.

Then add to the same `describe` block:

```typescript
	it("evaluate --source: identity upgrades land in the normalized tenant", async () => {
		const stubBin = makeStubBinary("findings");
		const prevBin = process.env.AL_SEM_BIN;
		process.env.AL_SEM_BIN = stubBin;
		const migrateSpy = spyOn(
			LifecycleStore.prototype,
			"applyFingerprintMigration",
		);
		try {
			await run([
				"evaluate",
				"test/fixtures/sampling-minimal.alcpuprofile",
				"--tenant",
				"ACME",
				"--source",
				WS_MIN,
				"--profile-id",
				"p1",
				"--capture-time",
				"2026-07-01T00:00:00Z",
			]);

			// Whatever fingerprint migrations the fusion branch applied, every one
			// of them must have been written under the NORMALIZED tenant. A raw
			// "ACME" here means applyIdentityUpgrades got the un-normalized value
			// and the finding will fork on the next run.
			for (const call of migrateSpy.mock.calls) {
				expect(call[0]).toBe("acme");
			}
		} finally {
			migrateSpy.mockRestore();
			if (prevBin === undefined) delete process.env.AL_SEM_BIN;
			else process.env.AL_SEM_BIN = prevBin;
		}

		const store = new LifecycleStore(dbPath);
		expect(store.listFindings({ tenant: "ACME" }).length).toBe(0);
		expect(store.listFindings({ tenant: "acme" }).length).toBeGreaterThan(0);
		store.close();
	});
```

Note: `applyFingerprintMigration`'s first parameter is the tenant. Verify that against `src/lifecycle/store.ts` before relying on it; if the signature takes an object, assert on `call[0].tenant` instead.

- [ ] **Step 4: Run it**

Run: `AI_DISABLED=1 bun test test/lifecycle/cli.test.ts -t "identity upgrades land in the normalized tenant"`
Expected: PASS.

If `migrateSpy.mock.calls` is empty, the stub produced no identity upgrade and the test proves nothing. In that case fix the fixture wiring (compare against `test/lifecycle/wire-fuse.integration.test.ts:311-380`, which is known to produce an upgrade) until at least one call is recorded, then assert `expect(migrateSpy.mock.calls.length).toBeGreaterThan(0);` before the loop.

- [ ] **Step 5: Write the table-driven pass over the remaining subcommands**

```typescript
	it("digest/status/close/triage resolve mixed-case --tenant to one bucket", async () => {
		const store = new LifecycleStore(dbPath);
		const fp = "pattern:0123456789abcdef";
		store.insertFinding({
			tenant: "acme",
			fingerprint: fp,
			algoVersion: 1,
			state: "resolved",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Seeded finding",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);
		store.close();

		// `close` is only legal from `resolved` — the seed above is resolved, so
		// an uppercase --tenant that resolves correctly will find and close it.
		await run(["close", fp, "--tenant", "ACME"]);

		const after = new LifecycleStore(dbPath);
		const row = after.listFindings({ tenant: "acme" })[0];
		expect(row.state).toBe("closed");
		after.close();
	});
```

Then add one more, for the read-only commands, asserting they do not report an empty tenant:

```typescript
	it("status with mixed-case --tenant reads the lowercase bucket", async () => {
		const store = new LifecycleStore(dbPath);
		store.insertFinding({
			tenant: "acme",
			fingerprint: "pattern:fedcba9876543210",
			algoVersion: 1,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Seeded open finding",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);
		store.close();

		logSpy.mockClear();
		await run(["status", "--tenant", "ACME", "-f", "json"]);

		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Seeded open finding");
	});
```

If `status -f json` is not a supported format, drop `-f json` and assert on the plain-text output instead — check the subcommand's options at `src/cli/commands/lifecycle.ts:855`.

- [ ] **Step 6: Run the whole file, type check, lint**

```bash
AI_DISABLED=1 bun test test/lifecycle/cli.test.ts
bunx tsc --noEmit
bunx biome check --write test/lifecycle/cli.test.ts
```
Expected: all tests pass, no type errors, no lint diagnostics.

- [ ] **Step 7: Commit**

```bash
git add test/lifecycle/cli.test.ts
git commit -m "$(cat <<'EOF'
test(lifecycle): pin CLI-level mixed-case --tenant behavior

`evaluate` was only verified at the evaluateRun() layer. Its fusion branch
passes the CLI-normalized tenant to applyIdentityUpgrades before evaluateRun
runs its own normalization, and nothing pinned that wiring — a regression
there would write the fingerprint migration under `ACME` while the findings
live under `acme`, forking the finding into a duplicate.

Drives the real fusion path via AL_SEM_BIN + the ws-min fixture and asserts
every applyFingerprintMigration call lands on the lowercase tenant. Adds
casing coverage for close and status.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 2: Guard against algorithm-version fingerprint orphaning

**Files:**
- Modify: `src/lifecycle/store.ts` — add two methods near the other finding accessors (around `getActiveFinding`, ~line 690).
- Modify: `src/lifecycle/evaluate.ts` — add the guard and its error class; `evaluateRun` starts at line 294.
- Modify: `src/cli/commands/lifecycle.ts` — add a flag to the `maintain` subcommand at line 1047-1071.
- Modify: `test/lifecycle/evaluate.test.ts` — guard tests.
- Modify: `test/lifecycle/cli.test.ts` — purge CLI test.

**Interfaces:**
- Produces (used by nothing else in this batch, but is the task's public surface):
  - `class StaleAlgoVersionError extends Error` — exported from `src/lifecycle/evaluate.ts`. Fields: `readonly tenant: string`, `readonly currentVersion: number`, `readonly staleVersions: number[]`, `readonly count: number`.
  - `LifecycleStore.countStaleAlgoFindings(tenant: string, currentVersion: number): { count: number; versions: number[] }` — active (non-closed) findings only.
  - `LifecycleStore.purgeStaleAlgoFindings(tenant: string, currentVersion: number): number` — deletes findings at any state whose `algo_version !== currentVersion`, returns the count deleted.

**Background for the implementer.** `FINGERPRINT_ALGO_VERSION` (`src/lifecycle/fingerprint.ts:56`) is the first token in every fingerprint hash. Bumping it changes every fingerprint by design. Today nothing handles the fallout: every live problem re-files as `first-seen` (duplicate issues, age reset) and every pre-bump row goes absent, auto-`resolved` after 3 runs, then sits in `resolved` forever because `resolved → closed` is only reachable via a human running `lifecycle close` (`src/lifecycle/states.ts:83-91`).

The stored data is disposable test data and the algorithm is not final, so we are **not** building a fingerprint migration. Detect, refuse, and offer a clean purge.

- [ ] **Step 1: Write the failing store test**

Add to `test/lifecycle/store.test.ts` (or `test/lifecycle/evaluate.test.ts` if the store file does not exist — check first):

```typescript
describe("stale algo-version findings", () => {
	function seed(store: LifecycleStore, tenant: string, fp: string, algo: number) {
		return store.insertFinding({
			tenant,
			fingerprint: fp,
			algoVersion: algo,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: `Finding ${fp}`,
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);
	}

	it("counts only active findings at a different algo version", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "acme", "pattern:aaaaaaaaaaaaaaa1", 1);
		seed(store, "acme", "pattern:aaaaaaaaaaaaaaa2", 1);
		seed(store, "acme", "pattern:aaaaaaaaaaaaaaa3", 2);
		const stale = store.countStaleAlgoFindings("acme", 2);
		expect(stale.count).toBe(2);
		expect(stale.versions).toEqual([1]);
		store.close();
	});

	it("purge is tenant-scoped and deletes every state", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "acme", "pattern:bbbbbbbbbbbbbbb1", 1);
		seed(store, "other", "pattern:bbbbbbbbbbbbbbb2", 1);
		const deleted = store.purgeStaleAlgoFindings("acme", 2);
		expect(deleted).toBe(1);
		expect(store.listFindings({ tenant: "acme" }).length).toBe(0);
		expect(store.listFindings({ tenant: "other" }).length).toBe(1);
		store.close();
	});

	it("purge removes dependent rows so no orphans survive", () => {
		const store = new LifecycleStore(":memory:");
		const id = seed(store, "acme", "pattern:ccccccccccccccc1", 1);
		store.putIssueMapping({
			tenant: "acme",
			sink: "github",
			fingerprint: "pattern:ccccccccccccccc1",
			externalId: "42",
			createdAt: "2026-07-01T00:00:00Z",
		});
		store.createCaptureRequest({
			tenant: "acme",
			fingerprint: "pattern:ccccccccccccccc1",
			findingId: id,
			appId: "",
			appName: null,
			objectType: "codeunit",
			objectId: 50000,
			methodName: "processline",
			reason: "test",
			requestedAt: "2026-07-01T00:00:00Z",
			expiresAt: "2026-07-15T00:00:00Z",
		});

		store.purgeStaleAlgoFindings("acme", 2);

		expect(
			store.getIssueMapping("acme", "github", "pattern:ccccccccccccccc1"),
		).toBeNull();
		const violations = store.db.query("PRAGMA foreign_key_check").all();
		expect(violations).toEqual([]);
		store.close();
	});
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts -t "stale algo-version"`
Expected: FAIL — `store.countStaleAlgoFindings is not a function`.

- [ ] **Step 3: Implement the two store methods**

Add to `src/lifecycle/store.ts`, near the other finding accessors:

```typescript
	/**
	 * Active (non-closed) findings whose fingerprint was minted by a different
	 * algorithm version than the one now in force. Non-empty means an algo bump
	 * happened without a purge: every live problem is about to re-file as
	 * first-seen and every row here is about to strand in `resolved` forever.
	 * evaluateRun refuses to run while this is non-empty.
	 */
	countStaleAlgoFindings(
		tenant: string,
		currentVersion: number,
	): { count: number; versions: number[] } {
		const rows = this.db
			.query<{ algo_version: number; n: number }, [string, number]>(
				`SELECT algo_version, COUNT(*) AS n FROM findings
				 WHERE tenant = ? AND state != 'closed' AND algo_version != ?
				 GROUP BY algo_version ORDER BY algo_version`,
			)
			.all(tenant, currentVersion);
		return {
			count: rows.reduce((sum, r) => sum + r.n, 0),
			versions: rows.map((r) => r.algo_version),
		};
	}

	/**
	 * Delete every finding for `tenant` minted at a different algorithm version,
	 * in any state, along with its dependent rows. This is the escape hatch the
	 * stale-algo guard points at: history cannot be carried across a fingerprint
	 * algorithm change, so it is discarded deliberately rather than left to rot
	 * as un-closable `resolved` rows. Returns the number of findings deleted.
	 */
	purgeStaleAlgoFindings(tenant: string, currentVersion: number): number {
		const purge = this.db.transaction((): number => {
			const doomed = this.db
				.query<{ id: number; fingerprint: string }, [string, number]>(
					"SELECT id, fingerprint FROM findings WHERE tenant = ? AND algo_version != ?",
				)
				.all(tenant, currentVersion);
			if (doomed.length === 0) return 0;

			const ids = doomed.map((r) => r.id);
			const idList = ids.join(",");
			const fpPlaceholders = doomed.map(() => "?").join(",");
			const fingerprints = doomed.map((r) => r.fingerprint);

			// Children first, then the findings themselves. `supersedes` is a
			// self-reference, so any surviving row pointing at a doomed one must be
			// detached before the delete or foreign_key_check trips.
			this.db.run(`DELETE FROM outbox WHERE finding_id IN (${idList})`);
			this.db.run(
				`DELETE FROM capture_requests WHERE finding_id IN (${idList})`,
			);
			this.db.run(`DELETE FROM occurrences WHERE finding_id IN (${idList})`);
			this.db.run(`DELETE FROM finding_events WHERE finding_id IN (${idList})`);
			this.db.run(
				`DELETE FROM sink_issue_map WHERE tenant = ? AND fingerprint IN (${fpPlaceholders})`,
				[tenant, ...fingerprints],
			);
			this.db.run(
				`DELETE FROM fingerprint_migrations
				 WHERE tenant = ?
				   AND (from_fingerprint IN (${fpPlaceholders})
				     OR to_fingerprint IN (${fpPlaceholders}))`,
				[tenant, ...fingerprints, ...fingerprints],
			);
			this.db.run(
				`UPDATE findings SET supersedes = NULL WHERE supersedes IN (${idList})`,
			);
			this.db.run(`DELETE FROM findings WHERE id IN (${idList})`);
			return doomed.length;
		});
		return purge();
	}
```

Interpolating `idList` directly is safe here: the ids come from SQLite's own `INTEGER PRIMARY KEY` column, never from user input. Fingerprints are user-adjacent, so they are bound as parameters.

- [ ] **Step 4: Run the store tests**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts -t "stale algo-version"`
Expected: PASS.

- [ ] **Step 5: Write the failing guard test**

Add to `test/lifecycle/evaluate.test.ts`:

```typescript
describe("evaluateRun — stale algo-version guard", () => {
	it("refuses to run when active findings carry a different algo version", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding({
			tenant: "acme",
			fingerprint: "pattern:deadbeefdeadbeef",
			algoVersion: FINGERPRINT_ALGO_VERSION + 1,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Stale finding",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);

		expect(() =>
			evaluateRun(store, makeAnalysisResult(), makeRun({ tenant: "acme" })),
		).toThrow(StaleAlgoVersionError);

		try {
			evaluateRun(store, makeAnalysisResult(), makeRun({ tenant: "acme" }));
		} catch (err) {
			const e = err as StaleAlgoVersionError;
			expect(e.count).toBe(1);
			expect(e.currentVersion).toBe(FINGERPRINT_ALGO_VERSION);
			expect(e.staleVersions).toEqual([FINGERPRINT_ALGO_VERSION + 1]);
			expect(e.message).toContain("--purge-stale-fingerprints");
			expect(e.message).toContain("--tenant acme");
		}
		store.close();
	});

	it("does not fire when every finding is at the current version", () => {
		const store = new LifecycleStore(":memory:");
		expect(() =>
			evaluateRun(store, makeAnalysisResult(), makeRun({ tenant: "acme" })),
		).not.toThrow();
		store.close();
	});

	it("is tenant-scoped: another tenant's stale rows do not block this one", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding({
			tenant: "other",
			fingerprint: "pattern:deadbeefdeadbeef",
			algoVersion: FINGERPRINT_ALGO_VERSION + 1,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Stale finding",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);
		expect(() =>
			evaluateRun(store, makeAnalysisResult(), makeRun({ tenant: "acme" })),
		).not.toThrow();
		store.close();
	});
});
```

Reuse whatever `makeAnalysisResult` / `makeRun` helpers already exist in `test/lifecycle/evaluate.test.ts` — match their existing signatures rather than inventing new ones. Import `FINGERPRINT_ALGO_VERSION` from `src/lifecycle/fingerprint.js` and `StaleAlgoVersionError` from `src/lifecycle/evaluate.js`.

- [ ] **Step 6: Run it, confirm it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/evaluate.test.ts -t "stale algo-version guard"`
Expected: FAIL — `StaleAlgoVersionError` is not exported.

- [ ] **Step 7: Implement the guard**

In `src/lifecycle/evaluate.ts`, add the error class near the top-level exports:

```typescript
/**
 * Thrown when the store holds active findings whose fingerprints were minted by
 * a different FINGERPRINT_ALGO_VERSION than the one now in force. Their history
 * cannot be carried across the change — the fingerprints simply no longer match
 * — so continuing would silently re-file every live problem as first-seen and
 * strand every existing row in `resolved` (which only a human `lifecycle close`
 * can clear). Refusing is the honest move; `maintain --purge-stale-fingerprints`
 * is the way forward.
 */
export class StaleAlgoVersionError extends Error {
	readonly tenant: string;
	readonly currentVersion: number;
	readonly staleVersions: number[];
	readonly count: number;

	constructor(
		tenant: string,
		currentVersion: number,
		staleVersions: number[],
		count: number,
	) {
		super(
			`${count} active finding(s) for tenant '${tenant}' were fingerprinted by algorithm ` +
				`v${staleVersions.join("/v")}, but v${currentVersion} is now in force. Their history ` +
				`cannot be carried across a fingerprint algorithm change. Discard them with:\n` +
				`  lifecycle maintain --purge-stale-fingerprints --tenant ${tenant}`,
		);
		this.name = "StaleAlgoVersionError";
		this.tenant = tenant;
		this.currentVersion = currentVersion;
		this.staleVersions = staleVersions;
		this.count = count;
	}
}
```

Then, inside `evaluateRun`, immediately after the `run = { ...run, tenant: normalizeTenantCode(run.tenant), ... }` block at lines 300-304 and **before** `const runTx = store.db.transaction(...)` at line 315:

```typescript
	// Refuse to run against findings minted by a different fingerprint algorithm
	// — see StaleAlgoVersionError. Deliberately outside runTx: this must throw
	// before any write, not roll one back.
	const stale = store.countStaleAlgoFindings(run.tenant, FINGERPRINT_ALGO_VERSION);
	if (stale.count > 0) {
		throw new StaleAlgoVersionError(
			run.tenant,
			FINGERPRINT_ALGO_VERSION,
			stale.versions,
			stale.count,
		);
	}
```

`FINGERPRINT_ALGO_VERSION` is already imported in `evaluate.ts` (it is read at line 197). Confirm, and add the import if not.

- [ ] **Step 8: Run the guard tests**

Run: `AI_DISABLED=1 bun test test/lifecycle/evaluate.test.ts -t "stale algo-version guard"`
Expected: PASS.

- [ ] **Step 9: Write the failing CLI purge test**

Add to `test/lifecycle/cli.test.ts` as its own `describe` block:

```typescript
describe("lifecycle maintain --purge-stale-fingerprints", () => {
	let dir: string;
	let dbPath: string;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-purge-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		logSpy = spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(async () => {
		logSpy.mockRestore();
		await rmSyncRetrying(dir);
	});

	it("purges the tenant's stale-algo findings and reports the count", async () => {
		const store = new LifecycleStore(dbPath);
		store.insertFinding({
			tenant: "acme",
			fingerprint: "pattern:1111111111111111",
			algoVersion: FINGERPRINT_ALGO_VERSION + 1,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Stale",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);
		store.close();

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"maintain",
				"--purge-stale-fingerprints",
				"--tenant",
				"ACME",
			],
			{ from: "user" },
		);

		const after = new LifecycleStore(dbPath);
		expect(after.listFindings({ tenant: "acme" }).length).toBe(0);
		after.close();

		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("1");
	});
});
```

Note the uppercase `--tenant ACME`: purge must go through `resolveTenantOpt` like every other tenant-scoped subcommand.

- [ ] **Step 10: Run it, confirm it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/cli.test.ts -t "purge-stale-fingerprints"`
Expected: FAIL — commander rejects the unknown option.

- [ ] **Step 11: Add the `maintain` flag**

In `src/cli/commands/lifecycle.ts`, replace the `maintain` subcommand (lines 1047-1071) with:

```typescript
	cmd
		.command("maintain")
		.description(
			"Run store maintenance: roll up routine metrics older than the retention window, or purge findings left behind by a fingerprint-algorithm bump",
		)
		.option(
			"--retention-days <n>",
			"Raw metric retention in days",
			String(DEFAULT_LIFECYCLE_CONFIG.rawMetricsRetentionDays),
		)
		.option(
			"--purge-stale-fingerprints",
			"Delete findings whose fingerprints were minted by an older algorithm version (requires --tenant). Their history cannot be carried across an algorithm change; this discards it deliberately.",
		)
		.option("--tenant <tenant>", "Tenant key (required with --purge-stale-fingerprints)")
		.action((opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				if (opts.purgeStaleFingerprints) {
					if (!opts.tenant) {
						console.error(
							"--purge-stale-fingerprints requires --tenant (the purge is tenant-scoped).",
						);
						process.exitCode = 2;
						return;
					}
					const tenant = resolveTenantOpt(opts.tenant);
					if (tenant === null) return;
					const deleted = store.purgeStaleAlgoFindings(
						tenant,
						FINGERPRINT_ALGO_VERSION,
					);
					console.log(
						`Purged ${deleted} finding(s) for tenant '${tenant}' minted by an older fingerprint algorithm (current: v${FINGERPRINT_ALGO_VERSION}).`,
					);
					return;
				}

				const res = rollupRoutineMetrics(
					store,
					new Date().toISOString(),
					parseInt(opts.retentionDays, 10),
				);
				console.log(
					`Rolled up ${res.rolledUp} day-buckets, deleted ${res.deleted} raw rows.`,
				);
			} finally {
				store.close();
			}
		});
```

Add `FINGERPRINT_ALGO_VERSION` to the imports from `../../lifecycle/fingerprint.js` at the top of the file if it is not already there.

- [ ] **Step 12: Run it**

Run: `AI_DISABLED=1 bun test test/lifecycle/cli.test.ts -t "purge-stale-fingerprints"`
Expected: PASS.

- [ ] **Step 13: Full suite, type check, lint**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/lifecycle/store.ts src/lifecycle/evaluate.ts src/cli/commands/lifecycle.ts test/lifecycle/evaluate.test.ts test/lifecycle/cli.test.ts test/lifecycle/store.test.ts
```
Expected: all green. The guard is a new throw on a path many tests exercise — if any pre-existing test now fails with `StaleAlgoVersionError`, it means that test seeds findings at a hard-coded `algoVersion` that differs from `FINGERPRINT_ALGO_VERSION`. Fix the fixture to use the constant, not the guard.

- [ ] **Step 14: Commit**

```bash
git add src/lifecycle/store.ts src/lifecycle/evaluate.ts src/cli/commands/lifecycle.ts test/lifecycle/evaluate.test.ts test/lifecycle/cli.test.ts test/lifecycle/store.test.ts
git commit -m "$(cat <<'EOF'
feat(lifecycle): refuse to run against stale-algo findings

Bumping FINGERPRINT_ALGO_VERSION changes every fingerprint by design, but
nothing handled the fallout: every live problem re-filed as first-seen
(duplicate issues, age reset) while every pre-bump row went absent,
auto-resolved after 3 runs, and then sat in `resolved` forever — only a human
`lifecycle close` can clear that state. Silent, and discovered weeks later as
duplicate issues.

evaluateRun now throws StaleAlgoVersionError before any write when the tenant
holds active findings at a different algo version, naming the exact remedy.
`maintain --purge-stale-fingerprints --tenant <t>` is that remedy: a scoped
delete of the stale findings and their dependent rows.

No fingerprint migration: the algorithm isn't final and the stored data is
disposable. Revisit when there's real history worth carrying.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 3: Per-sink event watermark, so a new sink picks up the backlog

**Files:**
- Modify: `src/lifecycle/store.ts` — append migration index 5 to `LIFECYCLE_MIGRATIONS` (ends line 237); replace `listUnprocessedEvents` / `markEventsProcessed` (lines 575-602).
- Modify: `src/lifecycle/config.ts:79` — `LIFECYCLE_SCHEMA_VERSION = 6`.
- Modify: `src/lifecycle/sinks/triggers.ts` — invert the loop nesting in `processEventsForSinks` (lines 146-307).
- Modify: `src/cli/commands/lifecycle.ts` — loop the trigger scan in `sync` (line 1121).
- Modify: `docs/lifecycle-ado-recipe.md:137-146` — rewrite the "Both sinks at once" limitation paragraph.
- Create: `test/lifecycle/sinks/backlog.test.ts`.

**Interfaces:**
- Produces:
  - `LifecycleStore.getSinkProgress(sink: string): number` — last processed event id, `0` if the sink has no row.
  - `LifecycleStore.advanceSinkProgress(sink: string, lastEventId: number): void` — upsert; never moves the watermark backwards.
  - `LifecycleStore.listUnprocessedEvents(sink: string, limit?: number): UnprocessedEvent[]` — **signature change**: now takes the sink name as its first parameter. The old zero-arg-plus-limit form is gone.
  - `LifecycleStore.markEventsProcessed` — **removed**. Callers use `advanceSinkProgress`.
  - `TriggerReport` is unchanged: `{ processed, enqueued, skippedMigration }`. `processed` remains a count of **distinct** events, not a per-sink sum.

**Background for the implementer.** `finding_events.sink_processed` (`src/lifecycle/store.ts:160`) is one bit per event, flipped for every scanned event at the end of the scan regardless of how many sinks were enabled (`src/lifecycle/sinks/triggers.ts:302`). So a tenant that has run with only `github` has its whole event history marked processed; enable `azureDevOps` later and it never sees any of it. Documented as a known limitation at `docs/lifecycle-ado-recipe.md:137-146`.

Replay is already safe — none of this is new work, but you must not break it:
- The `create-issue` gate (`triggers.ts:276-286`) requires `absenceCount === 0 && state != 'resolved' && state != 'closed'`, so replaying a presence event for a finding that has since died files nothing.
- The comment/close gates all require an existing `mapping`, which a fresh sink lacks.
- `outbox.dedupe_key` is `TEXT NOT NULL UNIQUE` with `INSERT OR IGNORE` (`store.ts:140`, `store.ts:487-501`) and outbox rows are **never** deleted (`status` is `pending|delivered|dead`; there is no `DELETE FROM outbox` in the codebase). A sink that re-scans events it already handled re-derives the same dedupe keys and enqueues nothing.

- [ ] **Step 1: Write the failing migration + watermark test**

Create `test/lifecycle/sinks/backlog.test.ts`:

```typescript
/**
 * backlog.test.ts — per-sink event watermark: a sink enabled after a tenant has
 * history replays that history and picks up the live backlog, while an existing
 * sink resumes where it left off.
 */

import { describe, expect, it } from "bun:test";
import { LifecycleStore, type NewFinding } from "../../../src/lifecycle/store.js";

const NOW = "2026-07-09T00:00:00Z";

function seedFinding(store: LifecycleStore, n: number, state = "open"): number {
	return store.insertFinding({
		tenant: "t1",
		fingerprint: `pattern:backlog000000${String(n).padStart(4, "0")}`,
		algoVersion: 1,
		state: state as NewFinding["state"],
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: `Finding ${n}`,
		severity: "critical",
		appId: "",
		appName: "",
		routineKey: "",
		firstSeenAt: NOW,
		lastSeenAt: NOW,
		lastEventAt: NOW,
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
	} satisfies NewFinding);
}

describe("sink_progress watermark", () => {
	it("an unknown sink starts at 0 and sees every event", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store, 1);
		store.recordEvent({
			findingId: id,
			runId: null,
			event: "first-seen",
			fromState: null,
			toState: "new",
			at: NOW,
			detail: null,
		});

		expect(store.getSinkProgress("azureDevOps")).toBe(0);
		expect(store.listUnprocessedEvents("azureDevOps").length).toBe(1);
		store.close();
	});

	it("advancing the watermark hides events from that sink only", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store, 1);
		store.recordEvent({
			findingId: id,
			runId: null,
			event: "first-seen",
			fromState: null,
			toState: "new",
			at: NOW,
			detail: null,
		});
		const events = store.listUnprocessedEvents("github");
		store.advanceSinkProgress("github", events[events.length - 1].id);

		expect(store.listUnprocessedEvents("github").length).toBe(0);
		expect(store.listUnprocessedEvents("azureDevOps").length).toBe(1);
		store.close();
	});

	it("the watermark never moves backwards", () => {
		const store = new LifecycleStore(":memory:");
		store.advanceSinkProgress("github", 10);
		store.advanceSinkProgress("github", 3);
		expect(store.getSinkProgress("github")).toBe(10);
		store.close();
	});
});
```

`recordEvent` is the store's existing event-insert method — confirm its exact name and parameter shape in `src/lifecycle/store.ts` and match it. If it takes different fields, adjust the calls; do not change the store method.

- [ ] **Step 2: Run it, confirm it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/backlog.test.ts`
Expected: FAIL — `store.getSinkProgress is not a function`.

- [ ] **Step 3: Add migration v6 and the schema-version bump**

Append a sixth entry to `LIFECYCLE_MIGRATIONS` in `src/lifecycle/store.ts` (after the fifth, which ends at line 236):

```typescript
	[
		// Purely additive — no table rebuild, no FK-toggle complications.
		//
		// finding_events.sink_processed was ONE bit per event, flipped once per
		// trigger scan regardless of how many sinks were enabled. A sink turned on
		// after a tenant had accrued history therefore never saw any of it. The
		// watermark is per-sink, so each sink advances independently.
		`CREATE TABLE IF NOT EXISTS sink_progress (
			sink TEXT NOT NULL PRIMARY KEY,
			last_event_id INTEGER NOT NULL DEFAULT 0
		)`,
		// Seed: every sink that has ALREADY done work — i.e. every sink with an
		// issue mapping — resumes at the old global high-water mark instead of
		// re-scanning its whole history. A sink with no mappings gets no row, so
		// it starts at 0 and replays: exactly the backlog behavior being added.
		// (Re-scanning would in fact be harmless — outbox dedupe keys are UNIQUE
		// and rows are never deleted — but it would be pure waste on every sync.)
		`INSERT OR IGNORE INTO sink_progress (sink, last_event_id)
		 SELECT DISTINCT sink,
		        (SELECT COALESCE(MAX(id), 0) FROM finding_events WHERE sink_processed = 1)
		 FROM sink_issue_map`,
	],
```

`finding_events.sink_processed` stays in the schema — it is the seed source above, and dropping a column is a table rebuild for no benefit. It is simply no longer read.

Then in `src/lifecycle/config.ts:79`: `export const LIFECYCLE_SCHEMA_VERSION = 6;`

- [ ] **Step 4: Implement the store methods**

Replace `listUnprocessedEvents` and `markEventsProcessed` (`src/lifecycle/store.ts:575-602`) with:

```typescript
	getSinkProgress(sink: string): number {
		const row = this.db
			.query<{ last_event_id: number }, [string]>(
				"SELECT last_event_id FROM sink_progress WHERE sink = ?",
			)
			.get(sink);
		return row?.last_event_id ?? 0;
	}

	/**
	 * Upsert the sink's watermark. MAX() guards against a concurrent or
	 * out-of-order caller dragging it backwards, which would replay events the
	 * sink has already handled.
	 */
	advanceSinkProgress(sink: string, lastEventId: number): void {
		this.db.run(
			`INSERT INTO sink_progress (sink, last_event_id) VALUES (?, ?)
			 ON CONFLICT(sink) DO UPDATE SET last_event_id = MAX(last_event_id, excluded.last_event_id)`,
			[sink, lastEventId],
		);
	}

	/**
	 * Events this sink has not yet scanned. A sink with no sink_progress row
	 * starts at 0 and therefore sees the full history — that is how a
	 * newly-enabled sink picks up the backlog.
	 */
	listUnprocessedEvents(sink: string, limit = 500): UnprocessedEvent[] {
		return this.db
			.query<Record<string, unknown>, [string, number]>(
				`SELECT e.* FROM finding_events e
				 WHERE e.id > COALESCE((SELECT last_event_id FROM sink_progress WHERE sink = ?), 0)
				 ORDER BY e.id LIMIT ?`,
			)
			.all(sink, limit)
			.map((row) => ({
				id: row.id as number,
				findingId: row.finding_id as number,
				runId: (row.run_id as number | null) ?? null,
				event: row.event as string,
				fromState: (row.from_state as string | null) ?? null,
				toState: row.to_state as string,
				at: row.at as string,
				detail: (row.detail as string | null) ?? null,
			}));
	}
```

- [ ] **Step 5: Run the watermark tests**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/backlog.test.ts`
Expected: PASS.

- [ ] **Step 6: Invert the trigger scan's loop nesting**

In `src/lifecycle/sinks/triggers.ts`, replace the `scan` transaction body (lines 180-304). The gate bodies are unchanged — only the loop nesting and the bookkeeping move.

```typescript
	const scan = store.db.transaction((): TriggerReport => {
		let enqueued = 0;
		// Sets, not counters: with two sinks enabled the same event is scanned
		// twice, but TriggerReport.processed/skippedMigration have always meant
		// DISTINCT events. Counting per-sink would silently double the numbers.
		const processedIds = new Set<number>();
		const skippedIds = new Set<number>();

		for (const sink of sinks) {
			const events = store.listUnprocessedEvents(sink.name);
			if (events.length === 0) continue;

			for (const event of events) {
				processedIds.add(event.id);
				const detail = safeParse(event.detail);
				if (detail?.viaMigration === true) {
					skippedIds.add(event.id);
					continue;
				}
				const row = store.getFinding(event.findingId);
				if (!row) continue;

				const mapping = store.getIssueMapping(
					row.tenant,
					sink.name,
					row.fingerprint,
				);

				if (
					(event.event === "seen-regressed" || event.event === "reopened") &&
					mapping
				) {
					if (
						enqueue(
							sink,
							row,
							event,
							"comment-regressed",
							`${sink.name}:comment-regressed:${event.id}`,
						)
					) {
						enqueued++;
					}
				}

				if (event.event === "filed-fresh" && mapping) {
					if (
						enqueue(
							sink,
							row,
							event,
							"comment-recurred",
							`${sink.name}:comment-recurred:${event.id}`,
						)
					) {
						enqueued++;
					}
					// reopenOnRecurrence: comment-recurred above is the visibility
					// mechanism regardless of this flag; when true, also PATCH the
					// mapped issue back open (see github.ts's reopen-issue kind).
					if (sink.reopenOnRecurrence) {
						if (
							enqueue(
								sink,
								row,
								event,
								"reopen-issue",
								`${sink.name}:reopen:${event.id}`,
							)
						) {
							enqueued++;
						}
					}
				}

				if (event.event === "resolved" && mapping) {
					if (
						enqueue(
							sink,
							row,
							event,
							"comment-resolved",
							`${sink.name}:comment-resolved:${event.id}`,
						)
					) {
						enqueued++;
					}
					if (sink.autoClose) {
						if (
							enqueue(
								sink,
								row,
								event,
								"close-issue",
								`${sink.name}:close:${event.id}`,
							)
						) {
							enqueued++;
						}
					}
				}

				// The liveness guard for replay: a newly-enabled sink walking a
				// tenant's whole history must file the LIVE backlog and nothing
				// else. absenceCount/state pin the finding to its state NOW, not
				// its state when the event fired, so a long-dead finding files
				// nothing no matter how many presence events it once had.
				if (
					PRESENCE_EVENTS.has(event.event) &&
					sink.autoFile &&
					!mapping &&
					severityRank(row.severity) >=
						severityRank(sink.autoFileMinSeverity) &&
					store.countQualifyingOccurrences(row.id) >= sink.autoFileAfterRuns &&
					row.absenceCount === 0 &&
					row.state !== "resolved" &&
					row.state !== "closed"
				) {
					if (
						enqueue(
							sink,
							row,
							event,
							"create-issue",
							`${sink.name}:create:${row.tenant}:${row.fingerprint}`,
						)
					) {
						enqueued++;
					}
				}
			}

			// Events come back ORDER BY id, so the last one is the high-water mark
			// for this sink's batch. A backlog larger than the batch limit drains
			// over successive scans — `lifecycle sync` loops until a scan is empty.
			store.advanceSinkProgress(sink.name, events[events.length - 1].id);
		}

		return {
			processed: processedIds.size,
			enqueued,
			skippedMigration: skippedIds.size,
		};
	});
```

Leave the `sinks.length === 0` early return at lines 151-155 in place, but update its comment — with per-sink watermarks it is now simply "nothing to do", not a trick to preserve the backlog:

```typescript
	const sinks = buildSinkRuntimes(config);
	if (sinks.length === 0) {
		// No enabled sink: nothing to scan and no watermark to advance. Each
		// sink's watermark is its own, so a sink enabled later still sees the
		// backlog — that no longer depends on leaving events unprocessed.
		return { processed: 0, enqueued: 0, skippedMigration: 0 };
	}
```

- [ ] **Step 7: Run the existing sink tests**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/`
Expected: PASS. These tests (`triggers.test.ts`, `outbox.test.ts`, `github.test.ts`, `azuredevops.test.ts`) pin the gate behavior that must survive the loop inversion. If `triggers.test.ts:674-677` asserts something about `markEventsProcessed` firing once, update that assertion to the watermark equivalent — the invariant it protects (one scan, one transaction) is unchanged.

- [ ] **Step 8: Write the backlog end-to-end test**

Append to `test/lifecycle/sinks/backlog.test.ts`. Build the config the same way `test/lifecycle/sinks/triggers.test.ts` does — copy its config-literal helper rather than inventing one.

```typescript
describe("a sink enabled after the tenant has history", () => {
	it("files the LIVE backlog and skips findings that have since died", () => {
		const store = new LifecycleStore(":memory:");

		// Two findings with enough history to auto-file; one of them is dead.
		const live = seedFinding(store, 1, "open");
		const dead = seedFinding(store, 2, "resolved");
		for (const id of [live, dead]) {
			store.recordEvent({
				findingId: id,
				runId: null,
				event: "first-seen",
				fromState: null,
				toState: "new",
				at: NOW,
				detail: null,
			});
		}

		// Scan with ONLY github enabled: github advances its watermark past both.
		const ghOnly = sinksConfig({ github: true, azureDevOps: false });
		processEventsForSinks(store, ghOnly, NOW);
		expect(store.listUnprocessedEvents("github").length).toBe(0);

		// Now enable azureDevOps. Its watermark is still 0, so it replays.
		const both = sinksConfig({ github: true, azureDevOps: true });
		const report = processEventsForSinks(store, both, NOW);
		expect(report.processed).toBeGreaterThan(0);

		const adoCreates = store
			.listPendingOutbox("azureDevOps", "create-issue")
			.map((r) => r.findingId);
		expect(adoCreates).toContain(live);
		expect(adoCreates).not.toContain(dead);

		// github, already caught up, enqueued nothing new.
		expect(store.listPendingOutbox("github", "create-issue").length).toBe(0);

		store.close();
	});
});
```

Adjust `seedFinding` / occurrence seeding until the `create-issue` gate actually fires for `live` — it requires `countQualifyingOccurrences(row.id) >= autoFileAfterRuns` and `absenceCount === 0`. Copy the seeding shape from `test/lifecycle/sinks/triggers.test.ts`'s auto-file tests; do not weaken the gate to make the test pass.

- [ ] **Step 9: Run it**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/backlog.test.ts`
Expected: PASS.

- [ ] **Step 10: Loop the trigger scan in `sync`**

In `src/cli/commands/lifecycle.ts`, replace the single call at line 1121:

```typescript
					triggers = processEventsForSinks(store, config);
```

with a drain loop. A backlog larger than `listUnprocessedEvents`'s 500-event batch would otherwise need one `sync` per batch:

```typescript
					// Drain the whole backlog in one sync. Each scan is capped at a
					// batch of events per sink so the enclosing transaction stays
					// bounded; a newly-enabled sink replaying a long history therefore
					// needs several scans. The loop terminates because every non-empty
					// scan advances at least one sink's watermark.
					for (;;) {
						const scan = processEventsForSinks(store, config);
						if (scan.processed === 0) break;
						triggers.processed += scan.processed;
						triggers.enqueued += scan.enqueued;
						triggers.skippedMigration += scan.skippedMigration;
					}
```

`triggers` is already initialized to `{ processed: 0, enqueued: 0, skippedMigration: 0 }` at line 1106.

- [ ] **Step 11: Add the >500-event drain test**

Append to `test/lifecycle/sinks/backlog.test.ts` — this one drives the CLI, so import `createLifecycleCommand` and follow the harness in `test/lifecycle/sync-cli.test.ts` (temp dir, temp db, config file, `parseAsync`).

```typescript
	it("a backlog larger than one batch drains in a single sync", async () => {
		// 600 events > the 500-event scan batch: one processEventsForSinks call
		// cannot see them all, so this fails unless `sync` loops.
		// (Set up dbPath/configPath per test/lifecycle/sync-cli.test.ts's harness,
		// seed 600 events across findings, run `sync`, then assert:)
		const store = new LifecycleStore(dbPath);
		expect(store.listUnprocessedEvents("github").length).toBe(0);
		store.close();
	});
```

Flesh out the seeding per the sync-cli harness. The assertion that matters is the one shown: after a single `sync`, github's watermark has passed **every** event, not just the first 500.

- [ ] **Step 12: Rewrite the docs paragraph**

Replace `docs/lifecycle-ado-recipe.md:137-146` (the "Both sinks at once" paragraph beginning "**Adding Azure DevOps to an already-running GitHub tenant:**") with:

```markdown
**Adding Azure DevOps to an already-running GitHub tenant:** each sink tracks its
own position in the event history, so a sink you enable today replays everything
that came before it and picks up the backlog on its first `sync`. Dormant
findings — ones that would never have recurred and so would never have filed —
are included. Findings that have since resolved or closed are not: the create
gate checks the finding's state *now*, not its state when the event fired, so a
long-dead finding files nothing no matter how much history it has. GitHub, having
already scanned that history, enqueues nothing new. There is no longer any reason
to enable both sinks before a tenant accrues history.
```

Also check `docs/lifecycle-sinks.md` (or whichever multi-sink reference doc exists — `grep -rln "sink_processed" docs/`) for the same claim and update it.

- [ ] **Step 13: Full suite, type check, lint**

```bash
AI_DISABLED=1 bun test
bunx tsc --noEmit
bunx biome check --write src/lifecycle/store.ts src/lifecycle/config.ts src/lifecycle/sinks/triggers.ts src/cli/commands/lifecycle.ts test/lifecycle/sinks/backlog.test.ts
```
Expected: all green. `test/lifecycle/migrations.test.ts` exercises the upgrade ladder — if it asserts a specific `LIFECYCLE_SCHEMA_VERSION`, update it to 6.

- [ ] **Step 14: Commit**

```bash
git add src/lifecycle/store.ts src/lifecycle/config.ts src/lifecycle/sinks/triggers.ts src/cli/commands/lifecycle.ts test/lifecycle/sinks/backlog.test.ts test/lifecycle/sinks/triggers.test.ts test/lifecycle/migrations.test.ts docs/lifecycle-ado-recipe.md
git commit -m "$(cat <<'EOF'
feat(sinks): per-sink event watermark so a new sink sees the backlog

finding_events.sink_processed was one global bit per event, flipped once per
scan no matter how many sinks were enabled. A tenant running with only github
had its whole event history marked processed, so azureDevOps enabled later
never saw any of it — only findings that happened to recur ever reached it.

Migration v6 adds sink_progress(sink, last_event_id), seeded from
sink_issue_map so sinks that have already filed issues resume where they were
and a sink never seen before starts at 0 and replays. The trigger scan now
loops sinks on the outside and each sink's own unprocessed events on the
inside, advancing that sink's watermark.

Replay was already safe and stays that way: the create gate checks the
finding's state now (so dead findings file nothing), comment/close gates
require an existing mapping (so a fresh sink can't comment on history it never
filed), and outbox dedupe keys are UNIQUE and never deleted (so a re-scan
enqueues nothing). `sync` loops the scan so a backlog past the batch limit
drains in one invocation.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

### Task 4: Bound the epic dedupe key

**Files:**
- Modify: `src/lifecycle/fingerprint.ts:233` — export `sha256Hex16`.
- Modify: `src/lifecycle/sinks/outbox.ts:115` — hash the row-id set.
- Modify: `test/lifecycle/sinks/outbox.test.ts` — add two tests.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `sha256Hex16(tokens: readonly string[]): string` becomes an export of `src/lifecycle/fingerprint.ts` (it is currently a module-private function at line 233).

**Background for the implementer.** `collapseCreates` (`src/lifecycle/sinks/outbox.ts:76-127`) collapses N pending `create-issue` rows into one epic when N crosses the threshold. Its dedupe key concatenates every collapsed row's id:

```typescript
dedupeKey: `${sink}:epic:${tenant}:${rows.map((r) => r.id).join(",")}`
```

A 300-finding storm yields a ~2 KB string in `outbox.dedupe_key`, a `TEXT NOT NULL UNIQUE` column. The key is never sent to GitHub or Azure DevOps — epic titles are the fixed `[al-perf] N new findings`, already length-clamped — so this is internal index bloat, not a correctness bug. The property that must survive: two separate storms in one tenant produce two **distinct** epic keys (pinned by `test/lifecycle/sinks/outbox.test.ts:202-235`).

- [ ] **Step 1: Write the failing tests**

Add to `test/lifecycle/sinks/outbox.test.ts`:

```typescript
	it("a large storm's epic dedupe key stays bounded", async () => {
		const store = new LifecycleStore(":memory:");
		for (let n = 1; n <= 300; n++) {
			const id = seedFinding(store, n);
			store.enqueueOutbox({
				tenant: "t1",
				sink: "github",
				kind: "create-issue",
				findingId: id,
				payload: JSON.stringify({ finding: contextFor(n), labels: [] }),
				dedupeKey: `github:create:t1:${n}`,
				nextAttemptAt: NOW,
				createdAt: NOW,
			});
		}

		await drainOutbox(store, fakeAdapter([{ ok: true, externalId: "1" }]), {
			...RUNTIME,
			maxPerDrain: 1,
		});

		const epic = store.db
			.query<{ dedupe_key: string }, []>(
				"SELECT dedupe_key FROM outbox WHERE kind = 'create-epic'",
			)
			.get();
		expect(epic).not.toBeNull();
		expect((epic as { dedupe_key: string }).dedupe_key.length).toBeLessThan(80);
		store.close();
	});
```

Match `drainOutbox`'s actual signature and the existing collapse tests' setup (`outbox.test.ts:179-235`) — copy their shape rather than guessing.

- [ ] **Step 2: Run it, confirm it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/outbox.test.ts -t "stays bounded"`
Expected: FAIL — the key is ~1.9 KB, far over 80.

- [ ] **Step 3: Export the hash primitive**

In `src/lifecycle/fingerprint.ts:233`, change:

```typescript
function sha256Hex16(tokens: readonly string[]): string {
```

to:

```typescript
export function sha256Hex16(tokens: readonly string[]): string {
```

Leave the body untouched.

- [ ] **Step 4: Hash the row-id set**

In `src/lifecycle/sinks/outbox.ts`, add the import:

```typescript
import { sha256Hex16 } from "../fingerprint.js";
```

and replace line 115:

```typescript
					dedupeKey: `${sink}:epic:${tenant}:${rows.map((r) => r.id).join(",")}`,
```

with:

```typescript
					// Hash, not concatenate: a 300-finding storm produced a ~2 KB key
					// in a UNIQUE TEXT column. Sorted so the key is a property of the
					// row-SET, not of the order listPendingOutbox happened to return.
					// Still row-set-scoped, so two separate storms in one tenant still
					// mint two distinct epics.
					dedupeKey: `${sink}:epic:${tenant}:${sha256Hex16(
						rows
							.map((r) => r.id)
							.sort((a, b) => a - b)
							.map(String),
					)}`,
```

- [ ] **Step 5: Run the outbox tests**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/outbox.test.ts`
Expected: PASS — including the pre-existing `two separate collapse storms produce two distinct epics` test at line 202, which is the property this change must not break.

- [ ] **Step 6: Add the order-independence test**

```typescript
	it("the epic dedupe key is a property of the row set, not its order", () => {
		const key = (ids: number[]) =>
			`github:epic:t1:${sha256Hex16(
				ids.sort((a, b) => a - b).map(String),
			)}`;
		expect(key([3, 1, 2])).toBe(key([1, 2, 3]));
		expect(key([1, 2, 3])).not.toBe(key([1, 2, 4]));
	});
```

Import `sha256Hex16` from `../../../src/lifecycle/fingerprint.js` at the top of the test file.

- [ ] **Step 7: Run it, type check, lint**

```bash
AI_DISABLED=1 bun test test/lifecycle/sinks/outbox.test.ts
bunx tsc --noEmit
bunx biome check --write src/lifecycle/fingerprint.ts src/lifecycle/sinks/outbox.ts test/lifecycle/sinks/outbox.test.ts
```
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/lifecycle/fingerprint.ts src/lifecycle/sinks/outbox.ts test/lifecycle/sinks/outbox.test.ts
git commit -m "$(cat <<'EOF'
fix(sinks): hash the epic dedupe key instead of concatenating row ids

collapseCreates built the epic's dedupe key by joining every collapsed row's
id, so a 300-finding storm produced a ~2 KB string in outbox.dedupe_key — a
UNIQUE TEXT column. The key never leaves the process (epic titles are the fixed
`[al-perf] N new findings`), so this was index bloat rather than a correctness
bug, but it grew without any bound.

Hash the sorted id set with the existing sha256Hex16 primitive. The key stays
row-set-scoped, so two separate storms in one tenant still mint two distinct
epics, and sorting makes it independent of the order listPendingOutbox returns.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp
EOF
)"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: item 1 → Task 1 (both the `evaluate` fusion-branch gap and the remaining-subcommands sweep), item 2 → Task 2 (guard in `evaluateRun`, purge on `maintain`, explicitly no fingerprint migration), item 3 → Task 3 (migration v6, SQL seed, watermark reads/writes, loop inversion, `sync` drain loop, docs), item 4 → Task 4 (sorted-hash key, both success criteria). The spec's sequencing table is reflected in the File Structure table and the Global Constraints' migration-ownership line.

**Type consistency.** `listUnprocessedEvents(sink, limit)` is declared once in Task 3's Interfaces block and used with that signature in Task 3's steps and tests. `markEventsProcessed` is explicitly removed there, and no other task references it. `sha256Hex16(tokens: readonly string[])` is exported in Task 4 Step 3 and called with `.map(String)` in Steps 4 and 6, matching the `readonly string[]` parameter. `StaleAlgoVersionError`'s four fields are declared in Task 2's Interfaces block and asserted by exactly those names in Step 5.

**Known soft spots** — each has an explicit instruction to verify against the real code rather than trust the plan:
- Task 1 Step 3: `applyFingerprintMigration`'s parameter shape (positional tenant vs. object).
- Task 1 Step 5: whether `status` supports `-f json`.
- Task 3 Steps 1/8: `recordEvent`'s exact name and field shape; the occurrence seeding needed to open the auto-file gate.
- Task 4 Step 1: `drainOutbox`'s signature.
