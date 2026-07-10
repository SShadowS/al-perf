# GitHub Issues Sink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver lifecycle finding transitions to GitHub Issues through a `SinkAdapter` interface with an async outbox (retry, backoff, rate limiting, collapse-to-epic), strict escaping of all finding-controlled text, a `lifecycle sync` CLI command, and a documented zero-custody `gh issue create` recipe — umbrella spec §4 sink adapters, phase 3 part 2.

**Architecture:** State transitions already COMMIT LOCALLY in Plan A (`2026-07-10-lifecycle-engine.md` — **hard dependency, must be fully merged first**); this plan consumes them. Schema v2 adds a fingerprint↔issue map and a `sink_processed` flag on `finding_events`. `lifecycle sync` runs two decoupled stages: **triggers** (scan unprocessed events, apply digest-first policy + hysteresis, enqueue outbox rows) and **drain** (deliver due outbox rows via the adapter with retry/backoff/rate-limit). The GitHub adapter is plain `fetch` against `api.github.com` with an injectable `fetchImpl` for mocked-HTTP contract tests.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, global `fetch` (no new dependencies), `commander`, `bun:test`, biome (tabs, double quotes).

## Global Constraints

- **Depends on Plan A** (`docs/superpowers/plans/2026-07-10-lifecycle-engine.md`) — all its modules, tests, and schema v1 must be merged before Task 1 here.
- **No new dependencies** — GitHub API via plain `fetch`; storage via `bun:sqlite`.
- **State transitions commit locally; sink delivery is asynchronous outbox rows with retry** (spec §4 — the lifecycle NEVER blocks on GitHub).
- **Digest-first posture:** auto-filing is OFF by default (`autoFile: false`); when enabled it fires only above the severity threshold AND after M consecutive observed runs (hysteresis).
- **ALL interpolated finding text is escaped and fenced** — no @mentions, no directive syntax, no fence breakout; labels validated against a per-config allow-list (spec §4: finding/issue text is data, never instructions).
- **Tokens never live in the config file** — the config names an env var (`tokenEnv`, default `GITHUB_TOKEN`); minimal scopes documented (fine-grained PAT, Issues read/write on one repo).
- **Optional auto-close default OFF** (spec §4).
- **Migration-caused transitions never reach sinks** — events whose detail contains `"viaMigration": true` are skipped (mass-transition guard, spec §4).
- **Web ingest behavior untouched** — sync is CLI-driven in this plan; the web hook from Plan A only evaluates.
- **Style:** tabs, double quotes, `.js` extensions on relative imports; `bunx biome check --write <files>` before each commit.
- **TDD:** failing test first, every task. Test commands: `AI_DISABLED=1 bun test <file>`. `bunx tsc --noEmit` before every commit.
- Commits are conventional-commit style and every commit message ends with the trailer line:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`

---

## Design Decisions (binding for all tasks)

1. **Event-scan trigger architecture.** Schema v2 adds `finding_events.sink_processed`; `lifecycle sync` scans unprocessed events and applies trigger policy THEN, not at evaluate time. Rationale: evaluation (CLI and web) stays sink-free and config-free; sync is idempotent and replayable; a sink added later can process the backlog of events it never saw. Every scanned event is marked processed exactly once, whether or not it enqueued anything.

2. **Hysteresis for auto-file** (spec: "fire only after M consecutive over-threshold runs"): a `create-issue` row is enqueued only when `autoFile` is true, the finding's severity ranks at/above `autoFileMinSeverity` (default `critical`), `countOccurrences(findingId) >= autoFileAfterRuns` (default 2), the finding's `absenceCount` is 0 (currently present), its state is active (`new/open/regressed/improving`), and no issue mapping exists yet. The dedupe key `github:create:<tenant>:<fingerprint>` makes re-scans and duplicate enqueues structurally impossible (UNIQUE column).

3. **Comment routing via the issue map.** `comment-regressed` fires on `seen-regressed`/`reopened` events, `comment-resolved` ("not observed since <date>") on `resolved` events — each ONLY when a fingerprint↔issue mapping exists (never create an issue just to comment). Dedupe key per event id (`github:comment-regressed:<eventId>`), so one event = at most one comment, forever. `close-issue` fires with `comment-resolved` only when `autoClose` is true.

4. **Collapse-to-epic lives in the outbox** (spec §4): at drain time, if ≥ `collapseThreshold` (default 5) `create-issue` rows are pending for one (tenant, sink), they are replaced by a single `create-epic` delivery listing all children; the original rows are marked delivered with `last_error = "collapsed-into-epic"`. Children's fingerprints map to the epic issue, so later regressed/resolved comments land on the epic.

5. **Retry policy:** exponential backoff `min(30s × 2^attempts, 1h)`; dead-letter (`status='dead'`) after 8 attempts or on a non-retryable error. Retryable = thrown fetch (network), HTTP 429, HTTP 403 with `x-ratelimit-remaining: 0`, HTTP ≥ 500. Everything else 4xx = non-retryable (a bad payload will not get better by retrying).

6. **Rate limiting:** sequential delivery with `minMillisBetweenCalls` (default 1000) between calls and `maxPerDrain` (default 20) per sync — deliberately far under GitHub's secondary rate limits. The sleep function is injectable so tests run instantly.

7. **Escaping is owned by the adapter** (the last hand to touch the text): payloads carry RAW structured finding fields; `renderIssueBody` escapes everything interpolated outside fenced blocks (`& < > @ \` #` → HTML entities, so @mentions and issue-reference syntax are neutral) and puts free-form evidence inside a dynamic fence longer than any backtick run in the content (no fence breakout). Titles are escaped and truncated to 120 chars. Label allow-listing happens in the triggers (before payload construction).

8. **Config file** `.al-perf/lifecycle.config.json` (CLI `--config` overrides). Missing file → `lifecycle sync` exits 1 pointing at the gh-recipe doc (the zero-custody alternative is the documented default posture).

9. **JSON digest is the gh-recipe contract:** `docs/lifecycle-gh-recipe.md` drives `gh issue create` off `lifecycle digest -f json` (`DigestData` shape from Plan A Task 7) with fingerprint-in-body search for dedup.

## File Structure

| File | Responsibility |
|---|---|
| `src/lifecycle/store.ts` (modify) | Schema v2 migration; issue-map, outbox, and unprocessed-event methods. |
| `src/lifecycle/sinks/types.ts` (create) | `SinkAdapter` contract, delivery/payload/result types, config types + defaults + loader. |
| `src/lifecycle/sinks/triggers.ts` (create) | Event scan → trigger policy (hysteresis, allow-listed labels) → outbox rows. |
| `src/lifecycle/sinks/outbox.ts` (create) | Drain: claim due rows, collapse-to-epic, deliver, retry/backoff/dead-letter, rate limit. |
| `src/lifecycle/sinks/github.ts` (create) | GitHub adapter: fetch calls, escaping, body rendering, issue-map upkeep. |
| `src/cli/commands/lifecycle.ts` (modify) | `lifecycle sync` subcommand. |
| `docs/lifecycle-gh-recipe.md` (create) | Zero-custody `gh` recipe over the JSON digest; token-scope documentation. |
| `test/lifecycle/sinks/*.test.ts` (create) | Schema v2, config, triggers, outbox, GitHub contract + injection tests. |

---

### Task 1: Schema v2 + store sink methods (issue map, outbox, unprocessed events)

**Files:**
- Modify: `src/lifecycle/store.ts`
- Test: `test/lifecycle/sinks/store-v2.test.ts`

**Interfaces:**
- Consumes: Plan A store (schema v1 migration ladder, `MIGRATIONS` array, CRUD).
- Produces:
  - `LIFECYCLE_SCHEMA_VERSION` bumped to `2`; `MIGRATIONS` renamed to exported `LIFECYCLE_MIGRATIONS` (needed by the upgrade test) with a new index-1 entry.
  - `interface SinkIssueMapping { tenant: string; sink: string; fingerprint: string; externalId: string; externalUrl: string | null }`
  - `LifecycleStore.getIssueMapping(tenant: string, sink: string, fingerprint: string): SinkIssueMapping | null`
  - `LifecycleStore.putIssueMapping(m: { tenant: string; sink: string; fingerprint: string; externalId: string; externalUrl?: string; createdAt: string }): void` (upsert)
  - `interface OutboxRow { id: number; tenant: string; sink: string; kind: string; findingId: number; payload: string; dedupeKey: string; status: "pending" | "delivered" | "dead"; attempts: number; nextAttemptAt: string; lastError: string | null; createdAt: string; deliveredAt: string | null }`
  - `LifecycleStore.enqueueOutbox(row: { tenant: string; sink: string; kind: string; findingId: number; payload: string; dedupeKey: string; nextAttemptAt: string; createdAt: string }): boolean` — false on dedupe-key collision
  - `LifecycleStore.listDueOutbox(sink: string, now: string, limit: number): OutboxRow[]` — pending rows with `next_attempt_at <= now`, oldest first
  - `LifecycleStore.listPendingOutbox(sink: string, kind?: string): OutboxRow[]`
  - `LifecycleStore.markOutboxDelivered(id: number, at: string, note?: string): void`
  - `LifecycleStore.markOutboxRetry(id: number, error: string, nextAttemptAt: string): void` — increments `attempts`
  - `LifecycleStore.markOutboxDead(id: number, error: string): void`
  - `interface UnprocessedEvent { id: number; findingId: number; runId: number | null; event: string; fromState: string | null; toState: string; at: string; detail: string | null }`
  - `LifecycleStore.listUnprocessedEvents(limit?: number): UnprocessedEvent[]`
  - `LifecycleStore.markEventsProcessed(ids: number[]): void`

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/sinks/store-v2.test.ts`:

```typescript
/**
 * store-v2.test.ts — schema v2 (sink_issue_map + sink_processed), the v1→v2
 * upgrade path, issue-map upsert, outbox lifecycle methods, event scanning.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	LIFECYCLE_MIGRATIONS,
	LIFECYCLE_SCHEMA_VERSION,
	LifecycleStore,
	type NewFinding,
} from "../../../src/lifecycle/store.js";

function finding(fingerprint: string): NewFinding {
	return {
		tenant: "t1",
		fingerprint,
		algoVersion: 1,
		state: "open",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "x",
		severity: "critical",
		appId: "",
		appName: "",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-01T00:00:00Z",
		lastEventAt: "2026-07-01T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
	};
}

describe("schema v2", () => {
	it("fresh stores land at version 2 with sink tables", () => {
		const store = new LifecycleStore(":memory:");
		expect(LIFECYCLE_SCHEMA_VERSION).toBe(2);
		expect(
			store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version,
		).toBe(2);
		const tables = store.db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table'",
			)
			.all()
			.map((r) => r.name);
		expect(tables).toContain("sink_issue_map");
		store.close();
	});

	it("upgrades a v1 database in place, preserving rows", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-v2-"));
		try {
			const dbPath = join(dir, "lifecycle.sqlite");
			// Build a genuine v1 database from the ladder's first rung.
			const v1 = new Database(dbPath, { create: true });
			for (const stmt of LIFECYCLE_MIGRATIONS[0]) v1.run(stmt);
			v1.run("PRAGMA user_version = 1");
			v1.run(
				`INSERT INTO findings (tenant, fingerprint, algo_version, state, source, pattern_id, title, severity, first_seen_at, last_seen_at, last_event_at)
				 VALUES ('t1', 'pattern:v1row', 1, 'open', 'pattern', 'x', 'x', 'info', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
			);
			v1.close();

			const store = new LifecycleStore(dbPath);
			expect(
				store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
					?.user_version,
			).toBe(2);
			expect(store.getActiveFinding("t1", "pattern:v1row")).not.toBeNull();
			// New column exists and defaults to unprocessed.
			store.logEvent({
				findingId: store.getActiveFinding("t1", "pattern:v1row")?.id ?? -1,
				event: "seen-normal",
				fromState: "open",
				toState: "open",
				at: "2026-07-01T00:00:00Z",
			});
			expect(store.listUnprocessedEvents()).toHaveLength(1);
			store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("issue map", () => {
	it("put/get roundtrip and upsert", () => {
		const store = new LifecycleStore(":memory:");
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc",
			externalId: "42",
			externalUrl: "https://github.com/o/r/issues/42",
			createdAt: "2026-07-01T00:00:00Z",
		});
		expect(store.getIssueMapping("t1", "github", "pattern:abc")?.externalId).toBe("42");
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc",
			externalId: "43",
			createdAt: "2026-07-02T00:00:00Z",
		});
		expect(store.getIssueMapping("t1", "github", "pattern:abc")?.externalId).toBe("43");
		expect(store.getIssueMapping("t1", "github", "pattern:zzz")).toBeNull();
		store.close();
	});
});

describe("outbox methods", () => {
	function enqueue(store: LifecycleStore, findingId: number, dedupeKey: string) {
		return store.enqueueOutbox({
			tenant: "t1",
			sink: "github",
			kind: "create-issue",
			findingId,
			payload: "{}",
			dedupeKey,
			nextAttemptAt: "2026-07-01T00:00:00Z",
			createdAt: "2026-07-01T00:00:00Z",
		});
	}

	it("dedupe key makes enqueue idempotent", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(finding("pattern:a"));
		expect(enqueue(store, id, "github:create:t1:pattern:a")).toBe(true);
		expect(enqueue(store, id, "github:create:t1:pattern:a")).toBe(false);
		store.close();
	});

	it("listDueOutbox honors next_attempt_at and status; retry/dead/delivered transitions", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(finding("pattern:a"));
		enqueue(store, id, "k1");
		expect(store.listDueOutbox("github", "2026-07-01T00:00:00Z", 10)).toHaveLength(1);
		expect(store.listDueOutbox("github", "2026-06-30T00:00:00Z", 10)).toHaveLength(0);

		const row = store.listDueOutbox("github", "2026-07-01T00:00:00Z", 10)[0];
		store.markOutboxRetry(row.id, "boom", "2026-07-01T01:00:00Z");
		let updated = store.listDueOutbox("github", "2026-07-01T02:00:00Z", 10)[0];
		expect(updated.attempts).toBe(1);
		expect(updated.lastError).toBe("boom");

		store.markOutboxDelivered(updated.id, "2026-07-01T02:00:00Z");
		expect(store.listDueOutbox("github", "2026-07-02T00:00:00Z", 10)).toHaveLength(0);

		enqueue(store, id, "k2");
		updated = store.listDueOutbox("github", "2026-07-02T00:00:00Z", 10)[0];
		store.markOutboxDead(updated.id, "422 Unprocessable");
		expect(store.listDueOutbox("github", "2026-07-03T00:00:00Z", 10)).toHaveLength(0);
		expect(store.listPendingOutbox("github")).toHaveLength(0);
		store.close();
	});
});

describe("event scanning", () => {
	it("listUnprocessedEvents returns oldest-first and markEventsProcessed clears them", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(finding("pattern:a"));
		for (const event of ["first-seen", "seen-regressed"]) {
			store.logEvent({
				findingId: id,
				event,
				fromState: null,
				toState: "new",
				at: "2026-07-01T00:00:00Z",
			});
		}
		const events = store.listUnprocessedEvents();
		expect(events.map((e) => e.event)).toEqual(["first-seen", "seen-regressed"]);
		store.markEventsProcessed(events.map((e) => e.id));
		expect(store.listUnprocessedEvents()).toHaveLength(0);
		store.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/store-v2.test.ts`
Expected: FAIL — `LIFECYCLE_MIGRATIONS` not exported / version still 1.

- [ ] **Step 3: Write the implementation**

In `src/lifecycle/store.ts`:

1. Bump the constant and export the ladder:

```typescript
export const LIFECYCLE_SCHEMA_VERSION = 2;

/**
 * LIFECYCLE_MIGRATIONS[n] upgrades user_version n → n+1. Applied in order on
 * open. Exported for the upgrade-path tests ONLY — never mutate at runtime.
 */
export const LIFECYCLE_MIGRATIONS: string[][] = [
	[
		/* ...the existing v1 statements, unchanged... */
	],
	[
		`CREATE TABLE IF NOT EXISTS sink_issue_map (
			tenant TEXT NOT NULL,
			sink TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			external_id TEXT NOT NULL,
			external_url TEXT,
			created_at TEXT NOT NULL,
			PRIMARY KEY (tenant, sink, fingerprint)
		)`,
		`ALTER TABLE finding_events ADD COLUMN sink_processed INTEGER NOT NULL DEFAULT 0`,
		`CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON finding_events(sink_processed, id)`,
	],
];
```

(Rename every internal use of `MIGRATIONS` to `LIFECYCLE_MIGRATIONS`; the `migrate()` loop needs no other change — it already walks to `LIFECYCLE_MIGRATIONS.length`.)

2. Add the row type exports and methods to `LifecycleStore`:

```typescript
export interface SinkIssueMapping {
	tenant: string;
	sink: string;
	fingerprint: string;
	externalId: string;
	externalUrl: string | null;
}

export interface OutboxRow {
	id: number;
	tenant: string;
	sink: string;
	kind: string;
	findingId: number;
	payload: string;
	dedupeKey: string;
	status: "pending" | "delivered" | "dead";
	attempts: number;
	nextAttemptAt: string;
	lastError: string | null;
	createdAt: string;
	deliveredAt: string | null;
}

export interface UnprocessedEvent {
	id: number;
	findingId: number;
	runId: number | null;
	event: string;
	fromState: string | null;
	toState: string;
	at: string;
	detail: string | null;
}
```

```typescript
	getIssueMapping(
		tenant: string,
		sink: string,
		fingerprint: string,
	): SinkIssueMapping | null {
		const row = this.db
			.query<Record<string, unknown>, [string, string, string]>(
				"SELECT * FROM sink_issue_map WHERE tenant = ? AND sink = ? AND fingerprint = ?",
			)
			.get(tenant, sink, fingerprint);
		if (!row) return null;
		return {
			tenant: row.tenant as string,
			sink: row.sink as string,
			fingerprint: row.fingerprint as string,
			externalId: row.external_id as string,
			externalUrl: (row.external_url as string | null) ?? null,
		};
	}

	putIssueMapping(m: {
		tenant: string;
		sink: string;
		fingerprint: string;
		externalId: string;
		externalUrl?: string;
		createdAt: string;
	}): void {
		this.db.run(
			`INSERT OR REPLACE INTO sink_issue_map (tenant, sink, fingerprint, external_id, external_url, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[m.tenant, m.sink, m.fingerprint, m.externalId, m.externalUrl ?? null, m.createdAt],
		);
	}

	enqueueOutbox(row: {
		tenant: string;
		sink: string;
		kind: string;
		findingId: number;
		payload: string;
		dedupeKey: string;
		nextAttemptAt: string;
		createdAt: string;
	}): boolean {
		const res = this.db.run(
			`INSERT OR IGNORE INTO outbox (tenant, sink, kind, finding_id, payload, dedupe_key, next_attempt_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				row.tenant,
				row.sink,
				row.kind,
				row.findingId,
				row.payload,
				row.dedupeKey,
				row.nextAttemptAt,
				row.createdAt,
			],
		);
		return res.changes > 0;
	}

	private rowToOutbox(row: Record<string, unknown>): OutboxRow {
		return {
			id: row.id as number,
			tenant: row.tenant as string,
			sink: row.sink as string,
			kind: row.kind as string,
			findingId: row.finding_id as number,
			payload: row.payload as string,
			dedupeKey: row.dedupe_key as string,
			status: row.status as OutboxRow["status"],
			attempts: row.attempts as number,
			nextAttemptAt: row.next_attempt_at as string,
			lastError: (row.last_error as string | null) ?? null,
			createdAt: row.created_at as string,
			deliveredAt: (row.delivered_at as string | null) ?? null,
		};
	}

	listDueOutbox(sink: string, now: string, limit: number): OutboxRow[] {
		return this.db
			.query<Record<string, unknown>, [string, string, number]>(
				`SELECT * FROM outbox WHERE sink = ? AND status = 'pending' AND next_attempt_at <= ?
				 ORDER BY id LIMIT ?`,
			)
			.all(sink, now, limit)
			.map((r) => this.rowToOutbox(r));
	}

	listPendingOutbox(sink: string, kind?: string): OutboxRow[] {
		const sql = kind
			? "SELECT * FROM outbox WHERE sink = ? AND status = 'pending' AND kind = ? ORDER BY id"
			: "SELECT * FROM outbox WHERE sink = ? AND status = 'pending' ORDER BY id";
		const params = kind ? [sink, kind] : [sink];
		return this.db
			.query<Record<string, unknown>, string[]>(sql)
			.all(...params)
			.map((r) => this.rowToOutbox(r));
	}

	markOutboxDelivered(id: number, at: string, note?: string): void {
		this.db.run(
			"UPDATE outbox SET status = 'delivered', delivered_at = ?, last_error = coalesce(?, last_error) WHERE id = ?",
			[at, note ?? null, id],
		);
	}

	markOutboxRetry(id: number, error: string, nextAttemptAt: string): void {
		this.db.run(
			"UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?",
			[error, nextAttemptAt, id],
		);
	}

	markOutboxDead(id: number, error: string): void {
		this.db.run(
			"UPDATE outbox SET status = 'dead', attempts = attempts + 1, last_error = ? WHERE id = ?",
			[error, id],
		);
	}

	listUnprocessedEvents(limit = 500): UnprocessedEvent[] {
		return this.db
			.query<Record<string, unknown>, [number]>(
				"SELECT * FROM finding_events WHERE sink_processed = 0 ORDER BY id LIMIT ?",
			)
			.all(limit)
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

	markEventsProcessed(ids: number[]): void {
		if (ids.length === 0) return;
		const mark = this.db.prepare(
			"UPDATE finding_events SET sink_processed = 1 WHERE id = ?",
		);
		const tx = this.db.transaction(() => {
			for (const id of ids) mark.run(id);
		});
		tx();
	}
```

- [ ] **Step 4: Run tests to verify they pass (v2 AND all Plan A suites)**

Run: `AI_DISABLED=1 bun test test/lifecycle`
Expected: PASS — including Plan A's store tests (they assert `user_version === LIFECYCLE_SCHEMA_VERSION`, which now reads 2).

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle test/lifecycle`

```bash
git add src/lifecycle/store.ts test/lifecycle/sinks/store-v2.test.ts
git commit -m "feat(lifecycle): schema v2 — sink issue map, outbox methods, event scanning

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 2: SinkAdapter contract + config types/loader

**Files:**
- Create: `src/lifecycle/sinks/types.ts`
- Test: `test/lifecycle/sinks/config.test.ts`

**Interfaces:**
- Consumes: `SinkIssueMapping` (Task 1).
- Produces (Tasks 3–6 rely on these exact names):
  - `interface SinkFindingContext { fingerprint: string; title: string; severity: string; state: string; patternId: string; appName: string; firstSeenAt: string; lastSeenAt: string; occurrenceCount: number; event: string; metricClass: string | null; resolvedAt: string | null; evidence: string | null }`
  - `type SinkDeliveryKind = "create-issue" | "create-epic" | "comment-regressed" | "comment-resolved" | "close-issue"`
  - `interface SinkDeliveryPayload { finding: SinkFindingContext; labels: string[]; children?: SinkFindingContext[] }`
  - `interface SinkDelivery { id: number; tenant: string; sink: string; kind: SinkDeliveryKind; findingId: number; payload: SinkDeliveryPayload; dedupeKey: string }`
  - `type SinkResult = { ok: true; externalId?: string; externalUrl?: string } | { ok: false; retryable: boolean; error: string }`
  - `interface SinkIssueMapPort { getIssueMapping(tenant: string, sink: string, fingerprint: string): SinkIssueMapping | null; putIssueMapping(m: { tenant: string; sink: string; fingerprint: string; externalId: string; externalUrl?: string; createdAt: string }): void }` — `LifecycleStore` satisfies this structurally.
  - `interface SinkAdapter { readonly name: string; deliver(delivery: SinkDelivery, issueMap: SinkIssueMapPort): Promise<SinkResult> }`
  - `interface GitHubSinkConfig { enabled: boolean; repo: string; tokenEnv?: string; autoFile?: boolean; autoFileMinSeverity?: "critical" | "warning" | "info"; autoFileAfterRuns?: number; autoClose?: boolean; labels?: string[]; labelsAllowList?: string[]; minMillisBetweenCalls?: number; maxPerDrain?: number; collapseThreshold?: number }`
  - `interface LifecycleSinksConfig { sinks: { github?: GitHubSinkConfig } }`
  - `const SINK_DEFAULTS: Required<Omit<GitHubSinkConfig, "enabled" | "repo">>` with values `{ tokenEnv: "GITHUB_TOKEN", autoFile: false, autoFileMinSeverity: "critical", autoFileAfterRuns: 2, autoClose: false, labels: ["al-perf"], labelsAllowList: ["al-perf", "performance", "regression"], minMillisBetweenCalls: 1000, maxPerDrain: 20, collapseThreshold: 5 }`
  - `function resolveGitHubConfig(cfg: GitHubSinkConfig): Required<GitHubSinkConfig>` — defaults merged
  - `function loadSinksConfig(path: string): LifecycleSinksConfig | null` — null when the file is missing; throws with a clear message on invalid JSON or a `repo` not matching `owner/name`
  - `function severityRank(s: string): number` — `critical`=3, `warning`=2, `info`=1, unknown=0

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/sinks/config.test.ts`:

```typescript
/**
 * config.test.ts — sink config loading, defaults (digest-first: autoFile and
 * autoClose OFF), validation, severity ranking.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	loadSinksConfig,
	resolveGitHubConfig,
	severityRank,
	SINK_DEFAULTS,
} from "../../../src/lifecycle/sinks/types.js";

describe("SINK_DEFAULTS", () => {
	it("is digest-first: autoFile and autoClose are OFF by default", () => {
		expect(SINK_DEFAULTS.autoFile).toBe(false);
		expect(SINK_DEFAULTS.autoClose).toBe(false);
		expect(SINK_DEFAULTS.autoFileAfterRuns).toBe(2);
		expect(SINK_DEFAULTS.autoFileMinSeverity).toBe("critical");
		expect(SINK_DEFAULTS.tokenEnv).toBe("GITHUB_TOKEN");
	});
});

describe("resolveGitHubConfig", () => {
	it("merges defaults under explicit values", () => {
		const cfg = resolveGitHubConfig({
			enabled: true,
			repo: "owner/repo",
			autoFile: true,
		});
		expect(cfg.autoFile).toBe(true);
		expect(cfg.autoClose).toBe(false);
		expect(cfg.maxPerDrain).toBe(20);
	});
});

describe("loadSinksConfig", () => {
	it("returns null for a missing file", () => {
		expect(loadSinksConfig(join(tmpdir(), "nope", "lifecycle.config.json"))).toBeNull();
	});

	it("loads a valid config and rejects a malformed repo", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-"));
		try {
			const good = join(dir, "good.json");
			writeFileSync(
				good,
				JSON.stringify({ sinks: { github: { enabled: true, repo: "owner/repo" } } }),
			);
			expect(loadSinksConfig(good)?.sinks.github?.repo).toBe("owner/repo");

			const bad = join(dir, "bad.json");
			writeFileSync(
				bad,
				JSON.stringify({ sinks: { github: { enabled: true, repo: "https://github.com/owner/repo" } } }),
			);
			expect(() => loadSinksConfig(bad)).toThrow(/owner\/name/);

			const junk = join(dir, "junk.json");
			writeFileSync(junk, "{not json");
			expect(() => loadSinksConfig(junk)).toThrow(/JSON/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("severityRank", () => {
	it("orders critical > warning > info > unknown", () => {
		expect(severityRank("critical")).toBeGreaterThan(severityRank("warning"));
		expect(severityRank("warning")).toBeGreaterThan(severityRank("info"));
		expect(severityRank("info")).toBeGreaterThan(severityRank("weird"));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/config.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lifecycle/sinks/types.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lifecycle/sinks/types.ts`:

```typescript
/**
 * types.ts — the SinkAdapter contract (umbrella spec §4).
 *
 * A SinkAdapter delivers ONE outbox row to an external system. Everything
 * around it — enqueueing (triggers.ts), retry/backoff/rate-limit/collapse
 * (outbox.ts), idempotency (dedupe keys + the issue map) — is owned by the
 * outbox machinery, so later sinks (ADO, Slack, email digest) are additive
 * files implementing this interface.
 *
 * Payloads carry RAW structured finding fields; escaping/fencing is owned
 * by the adapter — the last hand to touch the text (plan D7).
 */

import { existsSync, readFileSync } from "fs";
import type { SinkIssueMapping } from "../store.js";

export interface SinkFindingContext {
	fingerprint: string;
	title: string;
	severity: string;
	state: string;
	patternId: string;
	appName: string;
	firstSeenAt: string;
	lastSeenAt: string;
	occurrenceCount: number;
	/** The lifecycle event that produced this delivery (e.g. "seen-regressed"). */
	event: string;
	metricClass: string | null;
	resolvedAt: string | null;
	/** Free-form finding evidence — rendered ONLY inside a fenced block. */
	evidence: string | null;
}

export type SinkDeliveryKind =
	| "create-issue"
	| "create-epic"
	| "comment-regressed"
	| "comment-resolved"
	| "close-issue";

export interface SinkDeliveryPayload {
	finding: SinkFindingContext;
	/** Already validated against the allow-list by the triggers. */
	labels: string[];
	/** create-epic only: the collapsed findings. */
	children?: SinkFindingContext[];
}

export interface SinkDelivery {
	id: number;
	tenant: string;
	sink: string;
	kind: SinkDeliveryKind;
	findingId: number;
	payload: SinkDeliveryPayload;
	dedupeKey: string;
}

export type SinkResult =
	| { ok: true; externalId?: string; externalUrl?: string }
	| { ok: false; retryable: boolean; error: string };

/** LifecycleStore satisfies this structurally — adapters never see SQL. */
export interface SinkIssueMapPort {
	getIssueMapping(
		tenant: string,
		sink: string,
		fingerprint: string,
	): SinkIssueMapping | null;
	putIssueMapping(m: {
		tenant: string;
		sink: string;
		fingerprint: string;
		externalId: string;
		externalUrl?: string;
		createdAt: string;
	}): void;
}

export interface SinkAdapter {
	readonly name: string;
	deliver(
		delivery: SinkDelivery,
		issueMap: SinkIssueMapPort,
	): Promise<SinkResult>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GitHubSinkConfig {
	enabled: boolean;
	/** "owner/name" — never a URL. */
	repo: string;
	/** Env var holding the token — tokens NEVER live in the config file. */
	tokenEnv?: string;
	/** Digest-first: OFF by default; only high-confidence auto-filing. */
	autoFile?: boolean;
	autoFileMinSeverity?: "critical" | "warning" | "info";
	/** Hysteresis M: observed in at least this many runs before filing. */
	autoFileAfterRuns?: number;
	autoClose?: boolean;
	/** Labels applied to created issues (filtered by the allow-list). */
	labels?: string[];
	labelsAllowList?: string[];
	minMillisBetweenCalls?: number;
	maxPerDrain?: number;
	collapseThreshold?: number;
}

export interface LifecycleSinksConfig {
	sinks: { github?: GitHubSinkConfig };
}

export const SINK_DEFAULTS = {
	tokenEnv: "GITHUB_TOKEN",
	autoFile: false,
	autoFileMinSeverity: "critical" as const,
	autoFileAfterRuns: 2,
	autoClose: false,
	labels: ["al-perf"],
	labelsAllowList: ["al-perf", "performance", "regression"],
	minMillisBetweenCalls: 1000,
	maxPerDrain: 20,
	collapseThreshold: 5,
};

export function resolveGitHubConfig(
	cfg: GitHubSinkConfig,
): Required<GitHubSinkConfig> {
	return { ...SINK_DEFAULTS, ...cfg };
}

/**
 * Load `.al-perf/lifecycle.config.json` (or an explicit path). Missing file
 * → null (the caller points the user at the gh recipe). Invalid content
 * throws — a misconfigured sink must fail loudly, not silently no-op.
 */
export function loadSinksConfig(path: string): LifecycleSinksConfig | null {
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		throw new Error(`${path} is not valid JSON: ${err}`);
	}
	const cfg = parsed as LifecycleSinksConfig;
	const gh = cfg?.sinks?.github;
	if (gh && !/^[\w.-]+\/[\w.-]+$/.test(gh.repo ?? "")) {
		throw new Error(
			`${path}: sinks.github.repo must be "owner/name" (got ${JSON.stringify(gh?.repo)})`,
		);
	}
	return cfg;
}

export function severityRank(s: string): number {
	if (s === "critical") return 3;
	if (s === "warning") return 2;
	if (s === "info") return 1;
	return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle/sinks test/lifecycle/sinks`

```bash
git add src/lifecycle/sinks/types.ts test/lifecycle/sinks/config.test.ts
git commit -m "feat(sinks): SinkAdapter contract and sink config with digest-first defaults

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 3: Trigger rules — event scan → outbox rows (hysteresis, digest-first)

**Files:**
- Create: `src/lifecycle/sinks/triggers.ts`
- Modify: `src/lifecycle/store.ts` (one helper: `getLatestOccurrenceDetails`)
- Test: `test/lifecycle/sinks/triggers.test.ts`

**Interfaces:**
- Consumes: store v2 methods (Task 1), config/types (Task 2).
- Produces:
  - `LifecycleStore.getLatestOccurrenceDetails(findingId: number): string | null` (newest occurrence's `details` JSON, for evidence in sink bodies)
  - `interface TriggerReport { processed: number; enqueued: number; skippedMigration: number }`
  - `function processEventsForSinks(store: LifecycleStore, config: LifecycleSinksConfig, now?: string): TriggerReport`

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/sinks/triggers.test.ts`:

```typescript
/**
 * triggers.test.ts — trigger policy: digest-first (autoFile off ⇒ nothing),
 * hysteresis (M observed runs), severity threshold, comment routing via the
 * issue map, autoClose, viaMigration guard, label allow-listing, dedupe.
 */

import { describe, expect, it } from "bun:test";
import { processEventsForSinks } from "../../../src/lifecycle/sinks/triggers.js";
import type {
	GitHubSinkConfig,
	LifecycleSinksConfig,
	SinkDeliveryPayload,
} from "../../../src/lifecycle/sinks/types.js";
import { LifecycleStore, type NewFinding } from "../../../src/lifecycle/store.js";

const NOW = "2026-07-09T00:00:00Z";
const FP = "pattern:trig000000000001";

function config(gh?: Partial<GitHubSinkConfig>): LifecycleSinksConfig {
	return { sinks: { github: { enabled: true, repo: "owner/repo", ...gh } } };
}

function seedFinding(store: LifecycleStore, overrides?: Partial<NewFinding>): number {
	return store.insertFinding({
		tenant: "t1",
		fingerprint: FP,
		algoVersion: 1,
		state: "open",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "CalcFields inside loop",
		severity: "critical",
		appId: "",
		appName: "My App",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-05T00:00:00Z",
		lastEventAt: "2026-07-05T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
		...overrides,
	});
}

function seedOccurrences(store: LifecycleStore, findingId: number, n: number): void {
	for (let i = 0; i < n; i++) {
		const { runId } = store.recordRun({
			tenant: "t1",
			stream: "nightly",
			profileId: `p-${findingId}-${i}`,
			captureKind: "sampling",
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: [], names: [] },
		});
		store.recordOccurrence({
			findingId,
			runId,
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			severity: "critical",
			details: JSON.stringify({ evidence: "SELECT * repeated 500x" }),
		});
	}
}

function seedEvent(store: LifecycleStore, findingId: number, event: string, detail?: string): void {
	store.logEvent({
		findingId,
		event,
		fromState: "open",
		toState: event === "resolved" ? "resolved" : "regressed",
		at: "2026-07-05T00:00:00Z",
		detail,
	});
}

describe("processEventsForSinks — auto-file", () => {
	it("digest-first default: autoFile off enqueues nothing but marks events processed", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 3);
		seedEvent(store, id, "seen-normal");
		const report = processEventsForSinks(store, config(), NOW);
		expect(report.enqueued).toBe(0);
		expect(report.processed).toBeGreaterThan(0);
		expect(store.listUnprocessedEvents()).toHaveLength(0);
		store.close();
	});

	it("autoFile with hysteresis: files only once M observed runs are reached, deduped forever", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 1);
		seedEvent(store, id, "first-seen");
		expect(
			processEventsForSinks(store, config({ autoFile: true, autoFileAfterRuns: 2 }), NOW).enqueued,
		).toBe(0); // only 1 occurrence — below M

		seedOccurrences(store, id, 2); // now 3 total
		seedEvent(store, id, "seen-normal");
		expect(
			processEventsForSinks(store, config({ autoFile: true, autoFileAfterRuns: 2 }), NOW).enqueued,
		).toBe(1);
		const rows = store.listPendingOutbox("github", "create-issue");
		expect(rows).toHaveLength(1);
		expect(rows[0].dedupeKey).toBe(`github:create:t1:${FP}`);

		// Another seen event can never file a duplicate.
		seedEvent(store, id, "seen-normal");
		expect(
			processEventsForSinks(store, config({ autoFile: true, autoFileAfterRuns: 2 }), NOW).enqueued,
		).toBe(0);
		store.close();
	});

	it("severity below the threshold never files", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store, { severity: "warning" });
		seedOccurrences(store, id, 3);
		seedEvent(store, id, "seen-normal");
		const report = processEventsForSinks(
			store,
			config({ autoFile: true, autoFileMinSeverity: "critical" }),
			NOW,
		);
		expect(report.enqueued).toBe(0);
		store.close();
	});

	it("labels are filtered against the allow-list", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 2);
		seedEvent(store, id, "seen-normal");
		processEventsForSinks(
			store,
			config({ autoFile: true, labels: ["al-perf", "evil-label"], labelsAllowList: ["al-perf"] }),
			NOW,
		);
		const payload = JSON.parse(
			store.listPendingOutbox("github", "create-issue")[0].payload,
		) as SinkDeliveryPayload;
		expect(payload.labels).toEqual(["al-perf"]);
		expect(payload.finding.evidence).toContain("SELECT *");
		store.close();
	});
});

describe("processEventsForSinks — comments and close", () => {
	function withMapping(store: LifecycleStore): void {
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: FP,
			externalId: "7",
			createdAt: NOW,
		});
	}

	it("regressed/reopened comment only when an issue mapping exists", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedEvent(store, id, "seen-regressed");
		expect(processEventsForSinks(store, config(), NOW).enqueued).toBe(0); // no mapping

		withMapping(store);
		seedEvent(store, id, "reopened");
		expect(processEventsForSinks(store, config(), NOW).enqueued).toBe(1);
		expect(store.listPendingOutbox("github", "comment-regressed")).toHaveLength(1);
		store.close();
	});

	it("resolved comments; close-issue only with autoClose", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store, { state: "resolved" });
		withMapping(store);
		seedEvent(store, id, "resolved");
		expect(processEventsForSinks(store, config(), NOW).enqueued).toBe(1); // comment only
		seedEvent(store, id, "resolved");
		expect(processEventsForSinks(store, config({ autoClose: true }), NOW).enqueued).toBe(2);
		expect(store.listPendingOutbox("github", "close-issue")).toHaveLength(1);
		store.close();
	});

	it("viaMigration events are skipped (mass-transition guard)", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		withMapping(store);
		seedEvent(store, id, "seen-regressed", JSON.stringify({ viaMigration: true }));
		const report = processEventsForSinks(store, config(), NOW);
		expect(report.enqueued).toBe(0);
		expect(report.skippedMigration).toBe(1);
		store.close();
	});

	it("a disabled sink leaves events unprocessed for later enablement", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedEvent(store, id, "seen-normal");
		const report = processEventsForSinks(
			store,
			{ sinks: { github: { enabled: false, repo: "owner/repo" } } },
			NOW,
		);
		expect(report.processed).toBe(0);
		expect(store.listUnprocessedEvents()).toHaveLength(1);
		store.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/triggers.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lifecycle/sinks/triggers.js'`

- [ ] **Step 3: Write the implementation**

First add the small helper to `LifecycleStore` in `src/lifecycle/store.ts` (after `countOccurrences`):

```typescript
	/** Newest occurrence's details JSON for a finding (sink body evidence). */
	getLatestOccurrenceDetails(findingId: number): string | null {
		const row = this.db
			.query<{ details: string | null }, [number]>(
				"SELECT details FROM occurrences WHERE finding_id = ? ORDER BY capture_time DESC, run_id DESC LIMIT 1",
			)
			.get(findingId);
		return row?.details ?? null;
	}
```

Create `src/lifecycle/sinks/triggers.ts`:

```typescript
/**
 * triggers.ts — scan unprocessed finding_events and enqueue outbox rows
 * per the trigger policy (umbrella spec §4).
 *
 * Digest-first: with autoFile off (the default) NOTHING is ever filed —
 * only comments on already-mapped issues flow. Auto-filing requires
 * severity ≥ threshold AND hysteresis (observed in ≥ M runs, currently
 * present). viaMigration events never reach sinks (mass-transition guard).
 *
 * Decoupling invariant: evaluation (Plan A) logs events with no sink
 * knowledge; this scan runs at `lifecycle sync` time. A disabled sink
 * leaves events unprocessed so enabling it later can see the backlog.
 */

import type {
	FindingRow,
	LifecycleStore,
	UnprocessedEvent,
} from "../store.js";
import {
	type LifecycleSinksConfig,
	resolveGitHubConfig,
	type SinkDeliveryKind,
	type SinkDeliveryPayload,
	type SinkFindingContext,
	severityRank,
} from "./types.js";

const SINK = "github";

const PRESENCE_EVENTS = new Set([
	"first-seen",
	"filed-fresh",
	"seen-normal",
	"seen-regressed",
	"seen-improved",
	"reopened",
]);

export interface TriggerReport {
	processed: number;
	enqueued: number;
	skippedMigration: number;
}

function safeParse(json: string | null): Record<string, unknown> | null {
	if (!json) return null;
	try {
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function contextOf(
	store: LifecycleStore,
	row: FindingRow,
	event: UnprocessedEvent,
): SinkFindingContext {
	const detail = safeParse(event.detail);
	const occDetails = safeParse(store.getLatestOccurrenceDetails(row.id));
	return {
		fingerprint: row.fingerprint,
		title: row.title,
		severity: row.severity,
		state: row.state,
		patternId: row.patternId,
		appName: row.appName,
		firstSeenAt: row.firstSeenAt,
		lastSeenAt: row.lastSeenAt,
		occurrenceCount: store.countOccurrences(row.id),
		event: event.event,
		metricClass:
			typeof detail?.metricClass === "string" ? detail.metricClass : null,
		resolvedAt: row.resolvedAt,
		evidence:
			typeof occDetails?.evidence === "string" ? occDetails.evidence : null,
	};
}

export function processEventsForSinks(
	store: LifecycleStore,
	config: LifecycleSinksConfig,
	now = new Date().toISOString(),
): TriggerReport {
	const gh = config.sinks.github;
	if (!gh?.enabled) {
		// Leave events unprocessed: a sink enabled later sees the backlog.
		return { processed: 0, enqueued: 0, skippedMigration: 0 };
	}
	const cfg = resolveGitHubConfig(gh);
	const labels = cfg.labels.filter((l) => cfg.labelsAllowList.includes(l));

	const enqueue = (
		row: FindingRow,
		event: UnprocessedEvent,
		kind: SinkDeliveryKind,
		dedupeKey: string,
	): boolean => {
		const payload: SinkDeliveryPayload = {
			finding: contextOf(store, row, event),
			labels,
		};
		return store.enqueueOutbox({
			tenant: row.tenant,
			sink: SINK,
			kind,
			findingId: row.id,
			payload: JSON.stringify(payload),
			dedupeKey,
			nextAttemptAt: now,
			createdAt: now,
		});
	};

	let enqueued = 0;
	let skippedMigration = 0;
	const processedIds: number[] = [];

	for (const event of store.listUnprocessedEvents()) {
		processedIds.push(event.id);
		const detail = safeParse(event.detail);
		if (detail?.viaMigration === true) {
			skippedMigration++;
			continue;
		}
		const row = store.getFinding(event.findingId);
		if (!row) continue;
		const mapping = store.getIssueMapping(row.tenant, SINK, row.fingerprint);

		if (
			(event.event === "seen-regressed" || event.event === "reopened") &&
			mapping
		) {
			if (enqueue(row, event, "comment-regressed", `${SINK}:comment-regressed:${event.id}`)) {
				enqueued++;
			}
		}

		if (event.event === "resolved" && mapping) {
			if (enqueue(row, event, "comment-resolved", `${SINK}:comment-resolved:${event.id}`)) {
				enqueued++;
			}
			if (cfg.autoClose) {
				if (enqueue(row, event, "close-issue", `${SINK}:close:${event.id}`)) {
					enqueued++;
				}
			}
		}

		if (
			PRESENCE_EVENTS.has(event.event) &&
			cfg.autoFile &&
			!mapping &&
			severityRank(row.severity) >= severityRank(cfg.autoFileMinSeverity) &&
			store.countOccurrences(row.id) >= cfg.autoFileAfterRuns &&
			row.absenceCount === 0 &&
			row.state !== "resolved" &&
			row.state !== "closed"
		) {
			if (
				enqueue(row, event, "create-issue", `${SINK}:create:${row.tenant}:${row.fingerprint}`)
			) {
				enqueued++;
			}
		}
	}

	store.markEventsProcessed(processedIds);
	return { processed: processedIds.length, enqueued, skippedMigration };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/triggers.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle test/lifecycle/sinks`

```bash
git add src/lifecycle/sinks/triggers.ts src/lifecycle/store.ts test/lifecycle/sinks/triggers.test.ts
git commit -m "feat(sinks): trigger rules with hysteresis and digest-first defaults

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 4: Outbox worker — drain, retry/backoff, rate limit, collapse-to-epic

**Files:**
- Create: `src/lifecycle/sinks/outbox.ts`
- Test: `test/lifecycle/sinks/outbox.test.ts`

**Interfaces:**
- Consumes: store outbox methods (Task 1), `SinkAdapter`/`SinkDelivery`/`SinkResult` (Task 2).
- Produces:
  - `const MAX_ATTEMPTS = 8`
  - `function backoffAt(now: string, attempts: number): string` — `now + min(30s × 2^attempts, 1h)`
  - `interface DrainRuntime { minMillisBetweenCalls: number; maxPerDrain: number; collapseThreshold: number }`
  - `interface DrainOptions { now?: string; sleep?: (ms: number) => Promise<void> }`
  - `interface DrainReport { delivered: number; retried: number; dead: number; collapsed: number }`
  - `function drainOutbox(store: LifecycleStore, adapter: SinkAdapter, runtime: DrainRuntime, opts?: DrainOptions): Promise<DrainReport>`

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/sinks/outbox.test.ts`:

```typescript
/**
 * outbox.test.ts — drain semantics with a fake adapter: delivery, retryable
 * backoff, non-retryable dead-letter, attempt cap, rate-limit spacing,
 * collapse-to-epic.
 */

import { describe, expect, it } from "bun:test";
import {
	backoffAt,
	drainOutbox,
	MAX_ATTEMPTS,
} from "../../../src/lifecycle/sinks/outbox.js";
import type {
	SinkAdapter,
	SinkDelivery,
	SinkFindingContext,
	SinkResult,
} from "../../../src/lifecycle/sinks/types.js";
import { LifecycleStore, type NewFinding } from "../../../src/lifecycle/store.js";

const NOW = "2026-07-09T00:00:00Z";
const RUNTIME = { minMillisBetweenCalls: 100, maxPerDrain: 20, collapseThreshold: 5 };

function fakeAdapter(script: SinkResult[]): SinkAdapter & { seen: SinkDelivery[] } {
	const seen: SinkDelivery[] = [];
	return {
		name: "github",
		seen,
		async deliver(delivery) {
			seen.push(delivery);
			return script[Math.min(seen.length - 1, script.length - 1)];
		},
	};
}

function seedFinding(store: LifecycleStore, n: number): number {
	return store.insertFinding({
		tenant: "t1",
		fingerprint: `pattern:outbox0000000${String(n).padStart(3, "0")}`,
		algoVersion: 1,
		state: "open",
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

function contextFor(n: number): SinkFindingContext {
	return {
		fingerprint: `pattern:outbox0000000${String(n).padStart(3, "0")}`,
		title: `Finding ${n}`,
		severity: "critical",
		state: "open",
		patternId: "calcfields-in-loop",
		appName: "",
		firstSeenAt: NOW,
		lastSeenAt: NOW,
		occurrenceCount: 2,
		event: "seen-normal",
		metricClass: null,
		resolvedAt: null,
		evidence: null,
	};
}

function enqueueCreate(store: LifecycleStore, n: number): void {
	store.enqueueOutbox({
		tenant: "t1",
		sink: "github",
		kind: "create-issue",
		findingId: seedFinding(store, n),
		payload: JSON.stringify({ finding: contextFor(n), labels: ["al-perf"] }),
		dedupeKey: `github:create:t1:${n}`,
		nextAttemptAt: NOW,
		createdAt: NOW,
	});
}

describe("backoffAt", () => {
	it("doubles up to the one-hour cap", () => {
		expect(backoffAt(NOW, 0)).toBe("2026-07-09T00:00:30.000Z");
		expect(backoffAt(NOW, 1)).toBe("2026-07-09T00:01:00.000Z");
		expect(backoffAt(NOW, 10)).toBe("2026-07-09T01:00:00.000Z"); // capped
	});
});

describe("drainOutbox", () => {
	it("delivers due rows and marks them delivered", async () => {
		const store = new LifecycleStore(":memory:");
		enqueueCreate(store, 1);
		const adapter = fakeAdapter([{ ok: true, externalId: "10" }]);
		const report = await drainOutbox(store, adapter, RUNTIME, { now: NOW, sleep: async () => {} });
		expect(report.delivered).toBe(1);
		expect(store.listPendingOutbox("github")).toHaveLength(0);
		store.close();
	});

	it("retryable failure backs off with incremented attempts; dead after MAX_ATTEMPTS", async () => {
		const store = new LifecycleStore(":memory:");
		enqueueCreate(store, 1);
		const failing = fakeAdapter([{ ok: false, retryable: true, error: "503" }]);
		let report = await drainOutbox(store, failing, RUNTIME, { now: NOW, sleep: async () => {} });
		expect(report.retried).toBe(1);
		const later = "2026-07-10T00:00:00Z";
		let row = store.listDueOutbox("github", later, 10)[0];
		expect(row.attempts).toBe(1);
		expect(row.nextAttemptAt > NOW).toBe(true);

		// Push attempts to the cap: it dead-letters instead of retrying forever.
		for (let i = 1; i < MAX_ATTEMPTS - 1; i++) {
			store.markOutboxRetry(row.id, "503", later);
		}
		report = await drainOutbox(store, failing, RUNTIME, { now: "2026-07-11T00:00:00Z", sleep: async () => {} });
		expect(report.dead).toBe(1);
		store.close();
	});

	it("non-retryable failure dead-letters immediately", async () => {
		const store = new LifecycleStore(":memory:");
		enqueueCreate(store, 1);
		const adapter = fakeAdapter([{ ok: false, retryable: false, error: "422 bad payload" }]);
		const report = await drainOutbox(store, adapter, RUNTIME, { now: NOW, sleep: async () => {} });
		expect(report.dead).toBe(1);
		expect(store.listPendingOutbox("github")).toHaveLength(0);
		store.close();
	});

	it("spaces deliveries by minMillisBetweenCalls (sleep injected)", async () => {
		const store = new LifecycleStore(":memory:");
		enqueueCreate(store, 1);
		enqueueCreate(store, 2);
		enqueueCreate(store, 3);
		const sleeps: number[] = [];
		const adapter = fakeAdapter([{ ok: true }]);
		await drainOutbox(store, adapter, RUNTIME, {
			now: NOW,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(sleeps).toEqual([100, 100]); // n-1 gaps
		store.close();
	});

	it("collapses >= threshold pending creates into one epic; children noted", async () => {
		const store = new LifecycleStore(":memory:");
		for (let n = 1; n <= 5; n++) enqueueCreate(store, n);
		const adapter = fakeAdapter([{ ok: true, externalId: "99" }]);
		const report = await drainOutbox(store, adapter, RUNTIME, { now: NOW, sleep: async () => {} });
		expect(report.collapsed).toBe(1);
		expect(report.delivered).toBe(1); // the epic itself
		expect(adapter.seen).toHaveLength(1);
		expect(adapter.seen[0].kind).toBe("create-epic");
		expect(adapter.seen[0].payload.children).toHaveLength(5);
		// Originals were closed out with a collapse note, not delivered to GitHub.
		const collapsedNote = store.db
			.query<{ n: number }, []>(
				"SELECT count(*) AS n FROM outbox WHERE status = 'delivered' AND last_error = 'collapsed-into-epic'",
			)
			.get();
		expect(collapsedNote?.n).toBe(5);
		store.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/outbox.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lifecycle/sinks/outbox.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lifecycle/sinks/outbox.ts`:

```typescript
/**
 * outbox.ts — asynchronous sink delivery (umbrella spec §4).
 *
 * State transitions commit locally in the lifecycle store; this worker
 * drains pending outbox rows to a SinkAdapter with:
 *  - exponential backoff (min(30s × 2^attempts, 1h)), dead-letter after
 *    MAX_ATTEMPTS or on a non-retryable error;
 *  - per-sink rate limiting (sequential, minMillisBetweenCalls between
 *    calls, maxPerDrain per invocation);
 *  - collapse-to-epic: ≥ collapseThreshold pending create-issue rows for
 *    one tenant become a single create-epic delivery (alert-storm guard).
 *
 * The lifecycle NEVER blocks on a sink: a GitHub outage just leaves rows
 * pending for the next `lifecycle sync`.
 */

import type { LifecycleStore, OutboxRow } from "../store.js";
import type {
	SinkAdapter,
	SinkDelivery,
	SinkDeliveryPayload,
	SinkResult,
} from "./types.js";

export const MAX_ATTEMPTS = 8;

export function backoffAt(now: string, attempts: number): string {
	const delay = Math.min(30_000 * 2 ** attempts, 3_600_000);
	return new Date(new Date(now).getTime() + delay).toISOString();
}

export interface DrainRuntime {
	minMillisBetweenCalls: number;
	maxPerDrain: number;
	collapseThreshold: number;
}

export interface DrainOptions {
	now?: string;
	/** Injectable for tests; defaults to Bun.sleep. */
	sleep?: (ms: number) => Promise<void>;
}

export interface DrainReport {
	delivered: number;
	retried: number;
	dead: number;
	collapsed: number;
}

function toDelivery(row: OutboxRow): SinkDelivery {
	return {
		id: row.id,
		tenant: row.tenant,
		sink: row.sink,
		kind: row.kind as SinkDelivery["kind"],
		findingId: row.findingId,
		payload: JSON.parse(row.payload) as SinkDeliveryPayload,
		dedupeKey: row.dedupeKey,
	};
}

/** Fold ≥ threshold pending creates per tenant into one create-epic row. */
function collapseCreates(
	store: LifecycleStore,
	sink: string,
	threshold: number,
	now: string,
): number {
	const pending = store.listPendingOutbox(sink, "create-issue");
	const byTenant = new Map<string, OutboxRow[]>();
	for (const row of pending) {
		const bucket = byTenant.get(row.tenant);
		if (bucket) bucket.push(row);
		else byTenant.set(row.tenant, [row]);
	}
	let collapsed = 0;
	for (const [tenant, rows] of byTenant) {
		if (rows.length < threshold) continue;
		const payloads = rows.map(
			(r) => JSON.parse(r.payload) as SinkDeliveryPayload,
		);
		const epic: SinkDeliveryPayload = {
			finding: payloads[0].finding,
			labels: payloads[0].labels,
			children: payloads.map((p) => p.finding),
		};
		store.enqueueOutbox({
			tenant,
			sink,
			kind: "create-epic",
			findingId: rows[0].findingId,
			payload: JSON.stringify(epic),
			dedupeKey: `${sink}:epic:${tenant}:${rows.map((r) => r.id).join(",")}`,
			nextAttemptAt: now,
			createdAt: now,
		});
		for (const r of rows) {
			store.markOutboxDelivered(r.id, now, "collapsed-into-epic");
		}
		collapsed++;
	}
	return collapsed;
}

export async function drainOutbox(
	store: LifecycleStore,
	adapter: SinkAdapter,
	runtime: DrainRuntime,
	opts?: DrainOptions,
): Promise<DrainReport> {
	const now = opts?.now ?? new Date().toISOString();
	const sleep = opts?.sleep ?? ((ms: number) => Bun.sleep(ms));
	const report: DrainReport = {
		delivered: 0,
		retried: 0,
		dead: 0,
		collapsed: collapseCreates(store, adapter.name, runtime.collapseThreshold, now),
	};

	const due = store.listDueOutbox(adapter.name, now, runtime.maxPerDrain);
	let first = true;
	for (const row of due) {
		if (!first) await sleep(runtime.minMillisBetweenCalls);
		first = false;

		let result: SinkResult;
		try {
			result = await adapter.deliver(toDelivery(row), store);
		} catch (err) {
			result = { ok: false, retryable: true, error: String(err) };
		}

		if (result.ok) {
			store.markOutboxDelivered(row.id, now);
			report.delivered++;
			continue;
		}
		if (!result.retryable || row.attempts + 1 >= MAX_ATTEMPTS) {
			store.markOutboxDead(row.id, result.error);
			report.dead++;
		} else {
			store.markOutboxRetry(row.id, result.error, backoffAt(now, row.attempts + 1));
			report.retried++;
		}
	}
	return report;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/outbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle/sinks test/lifecycle/sinks`

```bash
git add src/lifecycle/sinks/outbox.ts test/lifecycle/sinks/outbox.test.ts
git commit -m "feat(sinks): outbox drain with backoff, rate limiting, collapse-to-epic

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 5: GitHub adapter — fetch, escaping, fenced bodies, issue map

**Files:**
- Create: `src/lifecycle/sinks/github.ts`
- Test: `test/lifecycle/sinks/github.test.ts`

**Interfaces:**
- Consumes: `SinkAdapter`/`SinkDelivery`/`SinkFindingContext`/`SinkIssueMapPort`/`SinkResult` (Task 2).
- Produces:
  - `interface GitHubAdapterOptions { repo: string; token: string; apiBase?: string; fetchImpl?: typeof fetch }`
  - `function createGitHubSink(options: GitHubAdapterOptions): SinkAdapter`
  - Exported for tests: `escapeInline(text: string): string`, `fenceBlock(text: string): string`, `renderTitle(f: SinkFindingContext): string`, `renderIssueBody(f: SinkFindingContext, children?: SinkFindingContext[]): string`, `renderRegressedComment(f: SinkFindingContext): string`, `renderResolvedComment(f: SinkFindingContext): string`

Security posture (spec §4 — "ALL interpolated finding text is escaped and fenced; no @mentions, no directive syntax"):
- `escapeInline` HTML-entity-escapes `&`, `<`, `>`, `#`, `@`, and backtick — in exactly that order: `&` first (so produced entities aren't double-escaped) and `#` before `@`/backtick (whose entities `&#64;`/`&#96;` themselves contain `#`). `@user` can never notify, `#123` can never cross-reference, backticks can never open code spans, HTML can never render.
- `fenceBlock` wraps free-form text (evidence) in a backtick fence strictly longer than the longest backtick run inside it — fence breakout is impossible.
- Titles are escaped and truncated to 120 chars.
- Labels arrive pre-filtered by the triggers (allow-list) and are passed through verbatim — the adapter never invents labels.

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/sinks/github.test.ts`:

```typescript
/**
 * github.test.ts — mocked-HTTP contract tests (paths, methods, headers,
 * bodies, retryability classification) and injection-escaping tests.
 */

import { describe, expect, it } from "bun:test";
import {
	createGitHubSink,
	escapeInline,
	fenceBlock,
	renderIssueBody,
	renderTitle,
} from "../../../src/lifecycle/sinks/github.js";
import type {
	SinkDelivery,
	SinkFindingContext,
	SinkIssueMapPort,
} from "../../../src/lifecycle/sinks/types.js";

function ctx(overrides?: Partial<SinkFindingContext>): SinkFindingContext {
	return {
		fingerprint: "pattern:abc123def4567890",
		title: "CalcFields inside loop",
		severity: "critical",
		state: "open",
		patternId: "calcfields-in-loop",
		appName: "My App",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-08T00:00:00Z",
		occurrenceCount: 4,
		event: "seen-normal",
		metricClass: null,
		resolvedAt: null,
		evidence: null,
		...overrides,
	};
}

function delivery(kind: SinkDelivery["kind"], finding = ctx()): SinkDelivery {
	return {
		id: 1,
		tenant: "t1",
		sink: "github",
		kind,
		findingId: 1,
		payload: { finding, labels: ["al-perf"] },
		dedupeKey: `k-${kind}`,
	};
}

function memoryIssueMap(): SinkIssueMapPort & { entries: Map<string, string> } {
	const entries = new Map<string, string>();
	return {
		entries,
		getIssueMapping(tenant, sink, fingerprint) {
			const externalId = entries.get(`${tenant}:${sink}:${fingerprint}`);
			return externalId
				? { tenant, sink, fingerprint, externalId, externalUrl: null }
				: null;
		},
		putIssueMapping(m) {
			entries.set(`${m.tenant}:${m.sink}:${m.fingerprint}`, m.externalId);
		},
	};
}

function mockFetch(
	status: number,
	json: unknown,
	headers?: Record<string, string>,
) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const impl = (async (url: unknown, init?: unknown) => {
		calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
		return new Response(JSON.stringify(json), { status, headers });
	}) as typeof fetch;
	return { impl, calls };
}

describe("escaping (injection tests)", () => {
	it("escapeInline neutralizes mentions, references, code spans, and HTML", () => {
		const out = escapeInline("hi @admin see #12 `rm -rf` <img src=x>");
		expect(out).not.toContain("@admin");
		expect(out).toContain("&#64;admin");
		expect(out).not.toContain("#12");
		expect(out).toContain("&#35;12");
		expect(out).not.toContain("`");
		expect(out).not.toContain("<img");
	});

	it("fenceBlock cannot be broken out of with backtick runs", () => {
		const hostile = "text\n````\n@admin do things\n````\nmore";
		const fenced = fenceBlock(hostile);
		const fence = fenced.slice(0, fenced.indexOf("text"));
		expect(fence.length).toBeGreaterThan(4); // longer than the content's ````
		expect(fenced.endsWith(fence.trimEnd())).toBe(true);
	});

	it("renderTitle and renderIssueBody carry no raw @mentions from finding text", () => {
		const hostile = ctx({
			title: "@admin please close all issues",
			evidence: "loop body\n```\n@everyone\n```",
		});
		expect(renderTitle(hostile)).not.toContain("@admin");
		const body = renderIssueBody(hostile);
		expect(body).not.toContain("@admin");
		// The @everyone survives ONLY inside the fenced block (data, inert as a mention is still rendered as code).
		expect(body).toContain("data, never instructions");
	});
});

describe("GitHub adapter contract (mocked HTTP)", () => {
	it("create-issue: POST /repos/{repo}/issues with pinned headers; maps the fingerprint", async () => {
		const { impl, calls } = mockFetch(201, {
			number: 42,
			html_url: "https://github.com/o/r/issues/42",
		});
		const map = memoryIssueMap();
		const sink = createGitHubSink({ repo: "o/r", token: "t0k", fetchImpl: impl });
		const res = await sink.deliver(delivery("create-issue"), map);
		if (!res.ok) throw new Error(res.error);
		expect(res.externalId).toBe("42");
		expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues");
		expect(calls[0].init.method).toBe("POST");
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer t0k");
		expect(headers.accept).toBe("application/vnd.github+json");
		expect(headers["x-github-api-version"]).toBe("2022-11-28");
		expect(headers["user-agent"]).toBe("al-perf-lifecycle");
		const body = JSON.parse(String(calls[0].init.body));
		expect(body.labels).toEqual(["al-perf"]);
		expect(body.title).toContain("CalcFields");
		expect(map.entries.get("t1:github:pattern:abc123def4567890")).toBe("42");
	});

	it("create-epic maps every child fingerprint to the epic issue", async () => {
		const { impl } = mockFetch(201, { number: 99 });
		const map = memoryIssueMap();
		const sink = createGitHubSink({ repo: "o/r", token: "t0k", fetchImpl: impl });
		const epic = delivery("create-epic");
		epic.payload.children = [
			ctx({ fingerprint: "pattern:child1" }),
			ctx({ fingerprint: "pattern:child2" }),
		];
		const res = await sink.deliver(epic, map);
		expect(res.ok).toBe(true);
		expect(map.entries.get("t1:github:pattern:child1")).toBe("99");
		expect(map.entries.get("t1:github:pattern:child2")).toBe("99");
	});

	it("comment-regressed: POST to the mapped issue's comments; no mapping is non-retryable", async () => {
		const { impl, calls } = mockFetch(201, { id: 1 });
		const map = memoryIssueMap();
		const sink = createGitHubSink({ repo: "o/r", token: "t0k", fetchImpl: impl });
		// No mapping yet:
		let res = await sink.deliver(delivery("comment-regressed"), map);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryable).toBe(false);
		// With mapping:
		map.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		res = await sink.deliver(delivery("comment-regressed"), map);
		expect(res.ok).toBe(true);
		expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/42/comments");
	});

	it("comment-resolved says 'not observed since'; close-issue PATCHes state", async () => {
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const resolved = ctx({ resolvedAt: "2026-07-08T00:00:00Z", state: "resolved" });

		const comment = mockFetch(201, { id: 1 });
		const sink1 = createGitHubSink({ repo: "o/r", token: "t0k", fetchImpl: comment.impl });
		await sink1.deliver(delivery("comment-resolved", resolved), map);
		const commentBody = JSON.parse(String(comment.calls[0].init.body));
		expect(commentBody.body).toContain("Not observed since 2026-07-08");

		const close = mockFetch(200, { number: 42 });
		const sink2 = createGitHubSink({ repo: "o/r", token: "t0k", fetchImpl: close.impl });
		await sink2.deliver(delivery("close-issue", resolved), map);
		expect(close.calls[0].url).toBe("https://api.github.com/repos/o/r/issues/42");
		expect(close.calls[0].init.method).toBe("PATCH");
		expect(JSON.parse(String(close.calls[0].init.body)).state).toBe("closed");
	});

	it("classifies retryability: 500/429/rate-limited-403 retryable, 422 not, network throw retryable", async () => {
		const map = memoryIssueMap();
		const attempt = async (status: number, headers?: Record<string, string>) => {
			const { impl } = mockFetch(status, { message: "err" }, headers);
			const sink = createGitHubSink({ repo: "o/r", token: "t0k", fetchImpl: impl });
			return sink.deliver(delivery("create-issue"), map);
		};
		let res = await attempt(500);
		if (!res.ok) expect(res.retryable).toBe(true);
		res = await attempt(429);
		if (!res.ok) expect(res.retryable).toBe(true);
		res = await attempt(403, { "x-ratelimit-remaining": "0" });
		if (!res.ok) expect(res.retryable).toBe(true);
		res = await attempt(422);
		if (!res.ok) expect(res.retryable).toBe(false);

		const throwing = (async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		const sink = createGitHubSink({ repo: "o/r", token: "t0k", fetchImpl: throwing });
		res = await sink.deliver(delivery("create-issue"), map);
		if (!res.ok) expect(res.retryable).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/github.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lifecycle/sinks/github.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lifecycle/sinks/github.ts`:

```typescript
/**
 * github.ts — GitHub Issues SinkAdapter (umbrella spec §4, sink v1).
 *
 * Plain fetch against api.github.com — no SDK dependency; fetchImpl is
 * injectable for mocked-HTTP contract tests. Token comes from the caller
 * (lifecycle sync reads the env var named by config.tokenEnv). Minimal
 * scopes: a fine-grained PAT with Issues read/write on ONE repository
 * (classic PATs need `repo`; prefer fine-grained). See
 * docs/lifecycle-gh-recipe.md for the token setup notes.
 *
 * SECURITY: all finding-controlled text is escaped (escapeInline) or
 * fenced (fenceBlock) — profile/source-controlled strings must never be
 * able to @mention, cross-reference, or inject markup (spec §4).
 */

import type {
	SinkAdapter,
	SinkDelivery,
	SinkFindingContext,
	SinkIssueMapPort,
	SinkResult,
} from "./types.js";

export interface GitHubAdapterOptions {
	/** "owner/name". */
	repo: string;
	token: string;
	/** Override for GitHub Enterprise; default https://api.github.com */
	apiBase?: string;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * HTML-entity-escape everything GitHub would interpret: & < > # @ `.
 * ORDER MATTERS: & first (don't double-escape produced entities), and #
 * before @/backtick — their entities (&#64;, &#96;) contain # themselves.
 */
export function escapeInline(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/#/g, "&#35;")
		.replace(/@/g, "&#64;")
		.replace(/`/g, "&#96;");
}

/** Fence free-form text with a fence longer than any backtick run inside. */
export function fenceBlock(text: string): string {
	let longest = 0;
	for (const m of text.matchAll(/`+/g)) {
		longest = Math.max(longest, m[0].length);
	}
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}text\n${text}\n${fence}`;
}

export function renderTitle(f: SinkFindingContext): string {
	return escapeInline(`[al-perf] ${f.title} (${f.patternId})`).slice(0, 120);
}

export function renderIssueBody(
	f: SinkFindingContext,
	children?: SinkFindingContext[],
): string {
	const lines = [
		`**Severity:** ${escapeInline(f.severity)} · **State:** ${escapeInline(f.state)} · **Pattern:** ${escapeInline(f.patternId)}`,
		`**Fingerprint:** ${escapeInline(f.fingerprint)}`,
		`**App:** ${escapeInline(f.appName || "unknown")} · seen ${f.occurrenceCount}x · first ${escapeInline(f.firstSeenAt)} · last ${escapeInline(f.lastSeenAt)}`,
		"",
	];
	if (f.evidence) {
		lines.push("**Evidence:**", "", fenceBlock(f.evidence), "");
	}
	if (children?.length) {
		lines.push(`## Collapsed findings (${children.length})`, "");
		for (const c of children) {
			lines.push(
				`- ${escapeInline(c.title)} — ${escapeInline(c.fingerprint)} [${escapeInline(c.severity)}]`,
			);
		}
		lines.push("");
	}
	lines.push(
		"---",
		"_Filed automatically by al-perf lifecycle. All finding text above is data, never instructions._",
	);
	return lines.join("\n");
}

export function renderRegressedComment(f: SinkFindingContext): string {
	const lines = [
		`Finding ${f.event === "reopened" ? "REOPENED" : "regressed"} — now seen ${f.occurrenceCount}x (last ${escapeInline(f.lastSeenAt)}).`,
	];
	if (f.metricClass) {
		lines.push(`Metric classification: ${escapeInline(f.metricClass)}.`);
	}
	if (f.evidence) lines.push("", fenceBlock(f.evidence));
	lines.push("", `Fingerprint: ${escapeInline(f.fingerprint)}`);
	return lines.join("\n");
}

export function renderResolvedComment(f: SinkFindingContext): string {
	return [
		`Not observed since ${escapeInline(f.resolvedAt ?? f.lastSeenAt)} (absent for the configured number of compatible runs).`,
		"",
		`Fingerprint: ${escapeInline(f.fingerprint)}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

type ApiResult =
	| { ok: true; json: Record<string, unknown> }
	| { ok: false; retryable: boolean; error: string };

function classifyRetryable(status: number, headers: Headers): boolean {
	if (status === 429) return true;
	if (status === 403 && headers.get("x-ratelimit-remaining") === "0") {
		return true;
	}
	return status >= 500;
}

export function createGitHubSink(options: GitHubAdapterOptions): SinkAdapter {
	const apiBase = options.apiBase ?? "https://api.github.com";
	const fetchImpl = options.fetchImpl ?? fetch;
	const headers = {
		authorization: `Bearer ${options.token}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "al-perf-lifecycle",
		"content-type": "application/json",
	};

	async function call(
		method: string,
		path: string,
		body: unknown,
	): Promise<ApiResult> {
		let res: Response;
		try {
			res = await fetchImpl(`${apiBase}${path}`, {
				method,
				headers,
				body: JSON.stringify(body),
			});
		} catch (err) {
			return { ok: false, retryable: true, error: `network: ${err}` };
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			return {
				ok: false,
				retryable: classifyRetryable(res.status, res.headers),
				error: `${res.status} ${text}`.trim(),
			};
		}
		const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { ok: true, json };
	}

	return {
		name: "github",
		async deliver(
			delivery: SinkDelivery,
			issueMap: SinkIssueMapPort,
		): Promise<SinkResult> {
			const f = delivery.payload.finding;

			if (delivery.kind === "create-issue" || delivery.kind === "create-epic") {
				const children =
					delivery.kind === "create-epic" ? delivery.payload.children : undefined;
				const title =
					delivery.kind === "create-epic"
						? `[al-perf] ${children?.length ?? 0} new findings`
						: renderTitle(f);
				const res = await call("POST", `/repos/${options.repo}/issues`, {
					title,
					body: renderIssueBody(f, children),
					labels: delivery.payload.labels,
				});
				if (!res.ok) return res;
				const externalId = String(res.json.number ?? "");
				const externalUrl =
					typeof res.json.html_url === "string" ? res.json.html_url : undefined;
				const fingerprints = children?.length
					? children.map((c) => c.fingerprint)
					: [f.fingerprint];
				for (const fingerprint of fingerprints) {
					issueMap.putIssueMapping({
						tenant: delivery.tenant,
						sink: "github",
						fingerprint,
						externalId,
						externalUrl,
						createdAt: new Date().toISOString(),
					});
				}
				return { ok: true, externalId, externalUrl };
			}

			const mapping = issueMap.getIssueMapping(
				delivery.tenant,
				"github",
				f.fingerprint,
			);
			if (!mapping) {
				return {
					ok: false,
					retryable: false,
					error: `no issue mapping for ${f.fingerprint}`,
				};
			}

			if (
				delivery.kind === "comment-regressed" ||
				delivery.kind === "comment-resolved"
			) {
				const body =
					delivery.kind === "comment-regressed"
						? renderRegressedComment(f)
						: renderResolvedComment(f);
				const res = await call(
					"POST",
					`/repos/${options.repo}/issues/${mapping.externalId}/comments`,
					{ body },
				);
				return res.ok ? { ok: true, externalId: mapping.externalId } : res;
			}

			// close-issue
			const res = await call(
				"PATCH",
				`/repos/${options.repo}/issues/${mapping.externalId}`,
				{ state: "closed", state_reason: "completed" },
			);
			return res.ok ? { ok: true, externalId: mapping.externalId } : res;
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/sinks/github.test.ts`
Expected: PASS — contract + injection tests.

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle/sinks test/lifecycle/sinks`

```bash
git add src/lifecycle/sinks/github.ts test/lifecycle/sinks/github.test.ts
git commit -m "feat(sinks): GitHub Issues adapter with strict escaping and mocked-HTTP contract tests

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 6: `lifecycle sync` CLI + gh recipe doc + library exports

**Files:**
- Modify: `src/cli/commands/lifecycle.ts` (add the `sync` subcommand), `src/index.ts`, `test/lifecycle/cli.test.ts`, `CLAUDE.md`
- Create: `docs/lifecycle-gh-recipe.md`

**Interfaces:**
- Consumes: `loadSinksConfig`/`resolveGitHubConfig` (Task 2), `processEventsForSinks` (Task 3), `drainOutbox` (Task 4), `createGitHubSink` (Task 5).
- Produces: `lifecycle sync [--config <path>] [--dry-run] [-f text|json]`; sink API exported from the package.

- [ ] **Step 1: Write the failing test**

In `test/lifecycle/cli.test.ts`, extend the registration test's subcommand list:

```typescript
		for (const s of ["evaluate", "digest", "status", "close", "triage", "maintain", "sync"]) {
			expect(subs).toContain(s);
		}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/cli.test.ts`
Expected: FAIL — `"sync"` not among subcommands.

- [ ] **Step 3: Write the implementation**

In `src/cli/commands/lifecycle.ts`, add imports:

```typescript
import { drainOutbox } from "../../lifecycle/sinks/outbox.js";
import { createGitHubSink } from "../../lifecycle/sinks/github.js";
import { processEventsForSinks } from "../../lifecycle/sinks/triggers.js";
import {
	loadSinksConfig,
	resolveGitHubConfig,
} from "../../lifecycle/sinks/types.js";
```

and the subcommand (before `return cmd;`):

```typescript
	cmd
		.command("sync")
		.description("Apply sink trigger rules and drain the delivery outbox")
		.option(
			"--config <path>",
			"Sinks config file",
			".al-perf/lifecycle.config.json",
		)
		.option("--dry-run", "Enqueue outbox rows but do not deliver")
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action(async (opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const config = loadSinksConfig(opts.config);
				if (!config) {
					console.error(
						`No sink config at ${opts.config}. Zero-custody alternative: drive 'gh issue create' from 'lifecycle digest -f json' — see docs/lifecycle-gh-recipe.md.`,
					);
					process.exitCode = 1;
					return;
				}
				const triggers = processEventsForSinks(store, config);
				let drain = { delivered: 0, retried: 0, dead: 0, collapsed: 0 };
				const gh = config.sinks.github;
				if (!opts.dryRun && gh?.enabled) {
					const resolved = resolveGitHubConfig(gh);
					const token = process.env[resolved.tokenEnv];
					if (!token) {
						console.error(
							`sinks.github is enabled but the ${resolved.tokenEnv} environment variable is not set.`,
						);
						process.exitCode = 1;
						return;
					}
					drain = await drainOutbox(
						store,
						createGitHubSink({ repo: resolved.repo, token }),
						{
							minMillisBetweenCalls: resolved.minMillisBetweenCalls,
							maxPerDrain: resolved.maxPerDrain,
							collapseThreshold: resolved.collapseThreshold,
						},
					);
				}
				const summary = { triggers, drain, dryRun: Boolean(opts.dryRun) };
				if (opts.format === "json") {
					process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
					return;
				}
				console.log(
					`Triggers: ${triggers.processed} events processed, ${triggers.enqueued} enqueued, ` +
						`${triggers.skippedMigration} migration-skipped. ` +
						`Drain: ${drain.delivered} delivered, ${drain.retried} retried, ${drain.dead} dead, ` +
						`${drain.collapsed} collapsed.${opts.dryRun ? " (dry run)" : ""}`,
				);
			} finally {
				store.close();
			}
		});
```

Append to `src/index.ts`:

```typescript
export { createGitHubSink } from "./lifecycle/sinks/github.js";
export { drainOutbox } from "./lifecycle/sinks/outbox.js";
export { processEventsForSinks } from "./lifecycle/sinks/triggers.js";
export {
	loadSinksConfig,
	type LifecycleSinksConfig,
	type SinkAdapter,
	type SinkDelivery,
	type SinkResult,
} from "./lifecycle/sinks/types.js";
```

Update `CLAUDE.md`: extend the `lifecycle` command mention (added in Plan A Task 9) with `sync`, and note the config file: `.al-perf/lifecycle.config.json` (GitHub sink; token via env var named by tokenEnv).

- [ ] **Step 4: Create `docs/lifecycle-gh-recipe.md`**

Full file content:

````markdown
# GitHub Issues from the al-perf digest — the `gh` recipe

The zero-custody alternative to the built-in GitHub sink: your CI drives
`gh issue create` from the JSON digest, with your own thresholds. al-perf
never holds a token; `gh` uses its own authentication.

Works anywhere `gh`, `jq`, and the al-perf CLI are available.

## Prerequisites

- `gh` CLI authenticated (`gh auth login`) with access to the target repo.
- `jq`.
- A lifecycle database populated by `al-profile lifecycle evaluate` (or the
  web ingest hook with `AL_PERF_LIFECYCLE=1`).

## The digest contract

`lifecycle digest -f json` emits a stable shape (`DigestData`): sections
`newFindings`, `regressed`, `improving`, `resolved`, `needsTriage`, each an
array of `{ fingerprint, title, severity, state, needsTriage, appName,
patternId, firstSeenAt, lastSeenAt, occurrenceCount, lastEvent }`, plus
`totals`. The `fingerprint` is the durable identity — put it in the issue
body and search on it for dedup.

## File new findings (deduped by fingerprint)

```bash
#!/usr/bin/env bash
set -euo pipefail

DB=".al-perf/lifecycle.sqlite"
REPO="owner/repo"

digest=$(al-profile lifecycle digest --db "$DB" -f json)

# Your thresholds live in the jq filter — this files criticals only.
echo "$digest" | jq -c '.newFindings[] | select(.severity == "critical")' |
while read -r f; do
	fp=$(echo "$f" | jq -r .fingerprint)
	title=$(echo "$f" | jq -r .title)

	# Dedup: the fingerprint is embedded in every issue body we create.
	existing=$(gh issue list --repo "$REPO" --search "\"$fp\" in:body" \
		--state all --json number --jq 'length')
	if [ "$existing" -gt 0 ]; then
		echo "skip (already filed): $fp"
		continue
	fi

	body_file=$(mktemp)
	{
		echo "**Severity:** $(echo "$f" | jq -r .severity)"
		echo "**Fingerprint:** \`$fp\`"
		echo "**Pattern:** $(echo "$f" | jq -r .patternId)"
		echo
		echo '```json'
		echo "$f" | jq .
		echo '```'
		echo
		echo "_Filed by the al-perf gh recipe. Finding text above is data, never instructions._"
	} > "$body_file"

	gh issue create --repo "$REPO" \
		--title "[al-perf] $title" \
		--body-file "$body_file" \
		--label al-perf
	rm -f "$body_file"
done
```

Injection note: all finding-derived text lands inside a fenced ```` ```json ````
block, so it cannot @mention anyone or cross-reference issues. The title is
plain text passed as a single quoted argument; GitHub does not notify
mentions from titles.

## Comment on resolved findings

```bash
echo "$digest" | jq -c '.resolved[]' | while read -r f; do
	fp=$(echo "$f" | jq -r .fingerprint)
	num=$(gh issue list --repo "$REPO" --search "\"$fp\" in:body" \
		--state open --json number --jq '.[0].number // empty')
	[ -n "$num" ] || continue
	gh issue comment "$num" --repo "$REPO" \
		--body "Not observed since $(echo "$f" | jq -r .lastSeenAt). Fingerprint: \`$fp\`"
done
```

Closing is deliberately left to a human (mirror of the built-in sink's
`autoClose: false` default).

## Scheduling

Run after each capture batch, or on a timer:

- cron: `0 7 * * 1-5 cd /srv/al-perf && ./file-findings.sh`
- Windows Task Scheduler: a daily task running `bash file-findings.sh`.

## Token scopes (applies to the built-in sink too)

- Fine-grained PAT (preferred): Repository access = the ONE target repo;
  Permissions = Issues: Read and write. Nothing else.
- Classic PAT: `repo` scope (broader than needed — prefer fine-grained).
- For the built-in sink, the token is read from the env var named by
  `sinks.github.tokenEnv` (default `GITHUB_TOKEN`) — never stored in
  `.al-perf/lifecycle.config.json`.

## Built-in sink config, for comparison

`.al-perf/lifecycle.config.json`:

```json
{
	"sinks": {
		"github": {
			"enabled": true,
			"repo": "owner/repo",
			"tokenEnv": "GITHUB_TOKEN",
			"autoFile": false,
			"autoFileMinSeverity": "critical",
			"autoFileAfterRuns": 2,
			"autoClose": false,
			"labels": ["al-perf"],
			"labelsAllowList": ["al-perf", "performance", "regression"]
		}
	}
}
```

Then: `al-profile lifecycle sync`. With `autoFile: false` (the default) the
sink only comments on issues that already exist (filed by you or by this
recipe) — digest-first, exactly like the recipe.
````

- [ ] **Step 5: Run tests + full suite**

Run: `AI_DISABLED=1 bun test test/lifecycle && AI_DISABLED=1 bun test && bunx tsc --noEmit && bunx biome check --write src docs test`
Expected: everything green.

- [ ] **Step 6: Smoke `lifecycle sync` dry-run**

```bash
mkdir -p .al-perf && printf '{"sinks":{"github":{"enabled":true,"repo":"owner/repo"}}}' > .al-perf/lifecycle.config.json
bun run src/cli/index.ts lifecycle sync --db .al-perf/smoke.sqlite --dry-run
rm .al-perf/lifecycle.config.json .al-perf/smoke.sqlite*
```
Expected: `Triggers: 0 events processed, 0 enqueued, 0 migration-skipped. Drain: 0 delivered, 0 retried, 0 dead, 0 collapsed. (dry run)` and exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/lifecycle.ts src/index.ts test/lifecycle/cli.test.ts docs/lifecycle-gh-recipe.md CLAUDE.md
git commit -m "feat(cli): lifecycle sync command and documented gh issue recipe

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

## Verification (whole plan)

- `AI_DISABLED=1 bun test` — full suite green (including all Plan A lifecycle suites against schema v2).
- `bunx tsc --noEmit` and `bunx biome check .` — clean.
- Spec §4 sink coverage: SinkAdapter interface owning outbox/retry/idempotency (Tasks 2/4), create-on-trigger + comment-on-regressed + "not observed since" + autoClose-off (Tasks 3/5), escaping + fenced bodies + label allow-lists (Task 5), per-sink rate limiting + collapse-to-epic in the outbox (Task 4), fingerprint↔issue map (Tasks 1/5), migration mass-transition guard (Task 3), state-commits-locally/async-outbox (architecture — evaluation never touches sinks), documented `gh` recipe over the JSON digest (Task 6), minimal token scopes documented (Tasks 5/6).
