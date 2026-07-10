# Finding Lifecycle Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable, identity-keyed finding lifecycle (new → open → regressed/improving → resolved → closed) over `AnalysisResult`s across runs, with version-aware regression baselines, a markdown/JSON digest, a `lifecycle` CLI command group, SQLite persistence (history store migrates in), and an opt-in web-ingest hook — umbrella spec §4, phase 3.

**Architecture:** One new SQLite database (`bun:sqlite`, WAL, tenant-keyed rows) owned by `src/lifecycle/store.ts`. A pure state machine (`states.ts`) encodes the full transition table; `evaluate.ts` turns `(AnalysisResult, RunMetadata)` into idempotent occurrence rows, baseline rows, and state transitions keyed to profile capture time; `baselines.ts` owns per-routine metrics, version segmentation, and the 90-day rollup; `digest.ts` renders the digest. The outbox table is created here but only consumed by the companion plan `2026-07-10-github-sink.md`.

**Tech Stack:** Bun + TypeScript, `bun:sqlite` (built into Bun — zero new dependencies), `commander`, `bun:test`, biome (tabs, double quotes).

## Global Constraints

- **Storage is `bun:sqlite` only** — `import { Database } from "bun:sqlite";`. No new dependencies anywhere in this plan.
- **WAL mode** on every database open; **tenant-keyed rows** (a `tenant` column on every table — never per-tenant files).
- **DB path:** CLI default `.al-perf/lifecycle.sqlite` in cwd (overridable via `--db <path>`); web server uses `<AL_PERF_DATA_DIR>/lifecycle.sqlite`. `":memory:"` must work (tests).
- **Do NOT re-implement fingerprinting.** `src/lifecycle/fingerprint.ts` is the landed contract. The parallel phase-2 plan wires `fingerprint?: string` (canonical `"<namespace>:<value>"` string form) onto `DetectedPattern` and `meta.fingerprintAlgoVersion` onto `AnalysisResult.meta`; alsem findings already carry a native fingerprint at `FindingSummary.fingerprint` (wrapped as `alsem:<native>`). This plan only **consumes** fingerprints.
- **Lifecycle evaluation is keyed to profile CAPTURE TIME (event time)** and idempotent per (fingerprint, profileId) — reprocessing can never resurrect resolved findings or double-count (spec §4).
- **Incomplete captures (`meta.incompleteInvocations > 0`) are excluded from lifecycle run-counting** (spec §1/§4): they never count absence and never write baseline rows.
- **Formatter parity untouched:** the digest is its own output (markdown/JSON strings), NOT an `AnalysisResult` section. No changes to `src/output/sections.ts` or any formatter.
- **Web ingest default behavior unchanged** unless `AL_PERF_LIFECYCLE=1` is set.
- **Style:** tabs, double quotes, `.js` extensions on relative imports (biome enforced — run `bunx biome check --write <files>` before each commit).
- **TDD:** every task writes the failing test first. Test commands run with AI disabled: `AI_DISABLED=1 bun test <file>`. `bunx tsc --noEmit` must pass before every commit.
- Commits are conventional-commit style and every commit message ends with the trailer line:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`

---

## Design Decisions (spec ambiguities resolved here — binding for all tasks)

1. **"Seen" resets the absence counter.** Spec: "resolved = absent N compatible runs". Interpreted as N *consecutive* compatible absences — any observation resets `absence_count` to 0. Rationale: non-consecutive counting would resolve a finding that is present in every other run (flapping), the top trust risk named in the spec.

2. **Reopen-after-resolved lands in `regressed`.** Spec: "Re-appearance after `resolved` reopens with history." The reopened state is `regressed` (with a `reopened` event logged and `resolved_at` cleared) rather than `open`, so the sink rule "comment on regressed" (Plan B) covers reopeners without a special case, and the digest surfaces them under Regressed where a human will look.

3. **Re-appearance after `closed` files a fresh finding row** with `supersedes` linking to the closed row and `needs_triage = 1` (a recurrence of something a human closed is exactly what triage is for). The closed row itself never transitions. Uniqueness is therefore a **partial unique index** `(tenant, fingerprint) WHERE state != 'closed'` — exactly one active finding per identity, unlimited closed history.

4. **Absence compatibility = same stream + observed capture kind + exercised app.** A run counts toward a finding's absence only when ALL hold: (a) `run.stream ∈ finding.observed_streams` and `run.captureKind ∈ finding.observed_kinds` (a finding only ever seen in instrumentation captures is never resolved by sampling runs — spec: "sampling runs never resolve instrumentation-only findings"); (b) the run exercised the finding's app (see D7); (c) the run is not incomplete; (d) `run.captureTime > finding.last_event_at` (event-time guard). Streams and kinds are tracked as JSON arrays on the finding row, merged on every observation.

5. **Out-of-order (late-arriving old) runs record occurrences but never drive state.** Guard: a run whose `captureTime <= finding.last_event_at` updates occurrence history only. Replaying a whole fleet in capture-time order therefore reconstructs identical state; replaying out of order cannot resurrect or double-count (spec §4 idempotency requirement).

6. **Incomplete captures process the presence side only.** A finding observed in an incomplete capture is real evidence — it is recorded (occurrence, first-seen/reopen transitions) with metric qualifier forced to `"normal"` (its timings are suspect, so it can never claim regression/improvement). Incomplete runs write **no** routine-metric rows and skip the absence pass entirely.

7. **"Exercised the containing app"** = the profile contains AL frames whose normalized `appId` (via `normalizeAppGuid`) — or, when `appId` is absent, whose lowercased `appName` — matches the finding's stored app identity. The exercised-app sets are computed from `result.objectBreakdown[].methods[]` ∪ `result.hotspots[]`. A finding whose app is unknown (both fields empty) is treated as exercised by every compatible run — otherwise the common profile-only case could never resolve.

8. **Finding regression metric = the anchor routine's `selfTime`** (µs) from per-routine metrics when the finding's routine resolves against the profile's method index, else the pattern's `impact`. Baselines are computed per `(tenant, stream, captureKind, routineKey)` over the last `baselineWindow` runs *within the same version segment* — a shift coinciding with a version-stamp change classifies as `"environment-changed"` (annotated, state-neutral), never `"regressed"` (spec §4 trigger rules).

9. **Version stamp** = canonical JSON of `RunMetadata.versions` (`{platform?, apps?[]}` — apps sorted by id), `""` when absent. Today's al-perf-bc ingest manifests carry **no** `appVersions` (verified against `web/handlers/ingest.ts` `extractMetrics`), so the stamp is usually `""` and segmentation activates as soon as producers start sending versions. The field is read from `manifest.appVersions` / `manifest.platformVersion` when present (forward-compatible with the spec's ingest body).

10. **Per-run routine metrics are capped at the top 500 methods by selfTime** (`routineMetricsPerRunCap`). Real profiles can carry thousands of methods; the cap bounds row growth while keeping every routine that could plausibly anchor a finding. Raw rows are retained 90 days (`rawMetricsRetentionDays`), then folded into daily rollups by `rollupRoutineMetrics` — a callable maintenance function surfaced as `lifecycle maintain`; scheduling is out of scope (spec §4).

11. **Sensible defaults:** `resolveAfterRuns = 3`, `baselineWindow = 10`, `baselineMinRuns = 3`, `regressionFactor = 1.5`, `regressionMinDeltaUs = 100_000` (100 ms — absolute floor so tiny routines can't flap on noise), `improvementFactor = 0.67`. All configurable via `LifecycleConfig`.

12. **`close` is only legal from `resolved`** (spec sketch: `resolved → closed`, human-confirmed). A "wontfix"-style close from active states is deliberately out of scope (noted for a future phase). The `needs-triage` flag is orthogonal: auto-set on fresh-filing after closed, and settable/clearable via CLI.

13. **History store migrates into the lifecycle SQLite** (spec: "one persistence system"). `HistoryStore` keeps its public API (`save/query/get/delete/clearAll/count`) but its constructor changes to `new HistoryStore(dbPath, { legacyDir? })`; on open, a legacy JSON dir without a `MIGRATED.md` tombstone is imported (`INSERT OR IGNORE`), the tombstone written, and the JSON files left in place (never delete user data). CLI/MCP gain `--db` / `historyDb` with the old dir option retained as the migration source.

14. **The outbox table ships in schema v1 but nothing writes to it in this plan.** Trigger rules, hysteresis, and delivery are Plan B (`2026-07-10-github-sink.md`). The store carries a migration ladder (`PRAGMA user_version`) so Plan B can add v2 tables without touching v1 code.

15. **Fingerprint-migration-caused transitions are marked `via-migration` in the event detail** so Plan B's trigger rules can skip them (spec §4: "sink adapters guard against mass state transitions caused by an algorithm change").

## File Structure

| File | Responsibility |
|---|---|
| `src/lifecycle/config.ts` (create) | `LifecycleConfig` + `DEFAULT_LIFECYCLE_CONFIG` (all thresholds in one place) |
| `src/lifecycle/store.ts` (create) | `LifecycleStore` — schema DDL + migration ladder, row CRUD, queries. No policy. |
| `src/lifecycle/states.ts` (create) | Pure state machine: full transition table + guards. No I/O. |
| `src/lifecycle/baselines.ts` (create) | Routine keys, metric rows, baseline computation, classification, rollup. |
| `src/lifecycle/evaluate.ts` (create) | `evaluateRun(store, result, run, config?)` — the orchestration. |
| `src/lifecycle/digest.ts` (create) | `buildDigest` (JSON shape) + `renderDigestMarkdown`. |
| `src/history/store.ts` (rewrite) | Same public API, SQLite-backed, JSON-dir auto-migration. |
| `src/cli/commands/lifecycle.ts` (create) | `lifecycle` command group: evaluate, digest, status, close, triage, maintain. |
| `src/cli/index.ts` (modify) | Register the group. |
| `src/cli/commands/history.ts`, `src/cli/commands/analyze.ts`, `src/mcp/server.ts` (modify) | HistoryStore call sites → db path. |
| `src/index.ts` (modify) | Export `LifecycleStore`, `evaluateRun`, `buildDigest`, `renderDigestMarkdown`. |
| `web/handlers/ingest.ts` (modify) + `web/lifecycle-db.ts` (create) | Post-analysis hook behind `AL_PERF_LIFECYCLE=1`. |
| `test/lifecycle/*.test.ts`, `test/web/lifecycle-ingest.test.ts` (create), `test/history/store.test.ts`, `test/mcp/tools.test.ts` (modify) | Tests. |

---

### Task 1: Config + store skeleton (schema v1, migration ladder)

**Files:**
- Create: `src/lifecycle/config.ts`
- Create: `src/lifecycle/store.ts`
- Test: `test/lifecycle/store.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces (later tasks rely on these exact names):
  - `interface LifecycleConfig { resolveAfterRuns: number; baselineWindow: number; baselineMinRuns: number; regressionFactor: number; regressionMinDeltaUs: number; improvementFactor: number; routineMetricsPerRunCap: number; rawMetricsRetentionDays: number }`
  - `const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig`
  - `const LIFECYCLE_SCHEMA_VERSION = 1`
  - `class LifecycleStore { constructor(dbPath: string); readonly db: Database; close(): void }` — opens/creates the DB, WAL mode, applies the migration ladder up to `LIFECYCLE_SCHEMA_VERSION`.

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/store.test.ts`:

```typescript
/**
 * store.test.ts — LifecycleStore: schema creation, WAL, migration ladder,
 * row CRUD (Task 2 appends CRUD describe blocks to this file).
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	DEFAULT_LIFECYCLE_CONFIG,
	LIFECYCLE_SCHEMA_VERSION,
} from "../../src/lifecycle/config.js";
import { LifecycleStore } from "../../src/lifecycle/store.js";

describe("DEFAULT_LIFECYCLE_CONFIG", () => {
	it("pins the spec defaults", () => {
		expect(DEFAULT_LIFECYCLE_CONFIG.resolveAfterRuns).toBe(3);
		expect(DEFAULT_LIFECYCLE_CONFIG.baselineWindow).toBe(10);
		expect(DEFAULT_LIFECYCLE_CONFIG.baselineMinRuns).toBe(3);
		expect(DEFAULT_LIFECYCLE_CONFIG.regressionFactor).toBe(1.5);
		expect(DEFAULT_LIFECYCLE_CONFIG.regressionMinDeltaUs).toBe(100_000);
		expect(DEFAULT_LIFECYCLE_CONFIG.improvementFactor).toBe(0.67);
		expect(DEFAULT_LIFECYCLE_CONFIG.routineMetricsPerRunCap).toBe(500);
		expect(DEFAULT_LIFECYCLE_CONFIG.rawMetricsRetentionDays).toBe(90);
	});
});

describe("LifecycleStore schema", () => {
	it("creates all v1 tables in memory", () => {
		const store = new LifecycleStore(":memory:");
		const tables = store.db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all()
			.map((r) => r.name);
		for (const t of [
			"findings",
			"runs",
			"occurrences",
			"routine_metrics",
			"routine_metrics_rollup",
			"finding_events",
			"fingerprint_migrations",
			"outbox",
		]) {
			expect(tables).toContain(t);
		}
		expect(
			store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version,
		).toBe(LIFECYCLE_SCHEMA_VERSION);
		store.close();
	});

	it("uses WAL mode and creates parent directories for file DBs", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-lifecycle-"));
		try {
			const dbPath = join(dir, "nested", "lifecycle.sqlite");
			const store = new LifecycleStore(dbPath);
			const mode = store.db
				.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
				.get();
			expect(mode?.journal_mode).toBe("wal");
			store.close();
			// Reopen is idempotent (CREATE IF NOT EXISTS + user_version short-circuit).
			const again = new LifecycleStore(dbPath);
			again.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("enforces one active finding per (tenant, fingerprint) but allows closed history", () => {
		const store = new LifecycleStore(":memory:");
		const insert = (state: string) =>
			store.db.run(
				`INSERT INTO findings (tenant, fingerprint, algo_version, state, source, pattern_id, title, severity, first_seen_at, last_seen_at, last_event_at)
				 VALUES ('t1', 'pattern:abc', 1, ?, 'pattern', 'calcfields-in-loop', 'x', 'warning', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
				[state],
			);
		insert("closed");
		insert("closed");
		insert("open");
		expect(() => insert("new")).toThrow(); // second active row violates partial unique index
		store.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts`
Expected: FAIL — `Cannot find module '../../src/lifecycle/config.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lifecycle/config.ts`:

```typescript
/**
 * config.ts — Lifecycle engine thresholds (umbrella spec §4 trigger rules).
 * All values are configurable; the defaults are the spec's "sensible defaults"
 * as resolved in the plan's Design Decisions (D11).
 */

export interface LifecycleConfig {
	/** Consecutive compatible absent runs before a finding resolves (spec: "absent N compatible runs"). */
	resolveAfterRuns: number;
	/** How many prior runs feed a baseline (within one version segment). */
	baselineWindow: number;
	/** Minimum same-segment samples before regression/improvement claims. */
	baselineMinRuns: number;
	/** Regressed when current > baselineMedian * regressionFactor (and past the absolute floor). */
	regressionFactor: number;
	/** Absolute floor (µs) — deltas smaller than this are never regressions/improvements. */
	regressionMinDeltaUs: number;
	/** Improved when current < baselineMedian * improvementFactor (and past the floor). */
	improvementFactor: number;
	/** Per-run cap on routine-metric rows (top N methods by selfTime). */
	routineMetricsPerRunCap: number;
	/** Raw routine-metric retention before daily rollup (spec: 90 days). */
	rawMetricsRetentionDays: number;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
	resolveAfterRuns: 3,
	baselineWindow: 10,
	baselineMinRuns: 3,
	regressionFactor: 1.5,
	regressionMinDeltaUs: 100_000,
	improvementFactor: 0.67,
	routineMetricsPerRunCap: 500,
	rawMetricsRetentionDays: 90,
};
```

Create `src/lifecycle/store.ts`:

```typescript
/**
 * store.ts — SQLite persistence for the finding lifecycle engine
 * (umbrella spec §4). Owns the schema (migration ladder via PRAGMA
 * user_version), row CRUD, and queries. NO lifecycle policy lives here —
 * the state machine is src/lifecycle/states.ts and orchestration is
 * src/lifecycle/evaluate.ts.
 *
 * Tenant-keyed rows throughout (tenant column, never per-tenant files).
 * WAL mode. ":memory:" supported for tests.
 *
 * The outbox table is created in v1 but only consumed by the GitHub-sink
 * plan (2026-07-10-github-sink.md), which appends MIGRATIONS[1] (v2).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export const LIFECYCLE_SCHEMA_VERSION = 1;

/**
 * MIGRATIONS[n] upgrades user_version n → n+1. Applied in order on open.
 * v1 (index 0) is the full initial schema.
 */
const MIGRATIONS: string[][] = [
	[
		`CREATE TABLE IF NOT EXISTS findings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			algo_version INTEGER NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('new','open','regressed','improving','resolved','closed')),
			needs_triage INTEGER NOT NULL DEFAULT 0,
			source TEXT NOT NULL DEFAULT 'pattern' CHECK (source IN ('pattern','alsem','telemetry')),
			pattern_id TEXT NOT NULL DEFAULT '',
			title TEXT NOT NULL,
			severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
			app_id TEXT NOT NULL DEFAULT '',
			app_name TEXT NOT NULL DEFAULT '',
			routine_key TEXT NOT NULL DEFAULT '',
			first_seen_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			last_event_at TEXT NOT NULL,
			absence_count INTEGER NOT NULL DEFAULT 0,
			observed_kinds TEXT NOT NULL DEFAULT '[]',
			observed_streams TEXT NOT NULL DEFAULT '[]',
			resolved_at TEXT,
			closed_at TEXT,
			supersedes INTEGER REFERENCES findings(id)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_active
			ON findings(tenant, fingerprint) WHERE state != 'closed'`,
		`CREATE INDEX IF NOT EXISTS idx_findings_tenant_state ON findings(tenant, state)`,
		`CREATE TABLE IF NOT EXISTS runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant TEXT NOT NULL,
			stream TEXT NOT NULL,
			profile_id TEXT NOT NULL,
			capture_kind TEXT NOT NULL CHECK (capture_kind IN ('sampling','instrumentation')),
			capture_time TEXT NOT NULL,
			version_stamp TEXT NOT NULL DEFAULT '',
			incomplete INTEGER NOT NULL DEFAULT 0,
			exercised_apps TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			UNIQUE (tenant, profile_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_runs_stream ON runs(tenant, stream, capture_time)`,
		`CREATE TABLE IF NOT EXISTS occurrences (
			finding_id INTEGER NOT NULL REFERENCES findings(id),
			run_id INTEGER NOT NULL REFERENCES runs(id),
			capture_time TEXT NOT NULL,
			severity TEXT NOT NULL,
			impact REAL,
			metric_value REAL,
			metric_class TEXT,
			details TEXT,
			PRIMARY KEY (finding_id, run_id)
		)`,
		`CREATE TABLE IF NOT EXISTS routine_metrics (
			tenant TEXT NOT NULL,
			stream TEXT NOT NULL,
			capture_kind TEXT NOT NULL,
			routine_key TEXT NOT NULL,
			profile_id TEXT NOT NULL,
			capture_time TEXT NOT NULL,
			self_time REAL NOT NULL,
			total_time REAL NOT NULL,
			hit_count INTEGER NOT NULL,
			version_stamp TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (tenant, profile_id, routine_key)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_metrics_lookup
			ON routine_metrics(tenant, stream, capture_kind, routine_key, capture_time)`,
		`CREATE TABLE IF NOT EXISTS routine_metrics_rollup (
			tenant TEXT NOT NULL,
			stream TEXT NOT NULL,
			capture_kind TEXT NOT NULL,
			routine_key TEXT NOT NULL,
			day TEXT NOT NULL,
			run_count INTEGER NOT NULL,
			self_time_min REAL NOT NULL,
			self_time_max REAL NOT NULL,
			self_time_mean REAL NOT NULL,
			self_time_median REAL NOT NULL,
			total_time_mean REAL NOT NULL,
			hit_count_mean REAL NOT NULL,
			PRIMARY KEY (tenant, stream, capture_kind, routine_key, day)
		)`,
		`CREATE TABLE IF NOT EXISTS finding_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			finding_id INTEGER NOT NULL REFERENCES findings(id),
			run_id INTEGER REFERENCES runs(id),
			event TEXT NOT NULL,
			from_state TEXT,
			to_state TEXT NOT NULL,
			at TEXT NOT NULL,
			detail TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_events_finding ON finding_events(finding_id, at)`,
		`CREATE TABLE IF NOT EXISTS fingerprint_migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant TEXT NOT NULL,
			from_fingerprint TEXT NOT NULL,
			to_fingerprint TEXT NOT NULL,
			reason TEXT NOT NULL CHECK (reason IN ('algo-upgrade','identity-upgrade','manual-merge')),
			applied_at TEXT NOT NULL,
			UNIQUE (tenant, from_fingerprint, to_fingerprint)
		)`,
		`CREATE TABLE IF NOT EXISTS outbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant TEXT NOT NULL,
			sink TEXT NOT NULL,
			kind TEXT NOT NULL,
			finding_id INTEGER NOT NULL REFERENCES findings(id),
			payload TEXT NOT NULL,
			dedupe_key TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','dead')),
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT NOT NULL,
			last_error TEXT,
			created_at TEXT NOT NULL,
			delivered_at TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sink, status, next_attempt_at)`,
	],
];

export class LifecycleStore {
	readonly db: Database;

	constructor(dbPath: string) {
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new Database(dbPath, { create: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	private migrate(): void {
		const row = this.db
			.query<{ user_version: number }, []>("PRAGMA user_version")
			.get();
		let version = row?.user_version ?? 0;
		while (version < MIGRATIONS.length) {
			const apply = this.db.transaction(() => {
				for (const stmt of MIGRATIONS[version]) {
					this.db.run(stmt);
				}
				this.db.run(`PRAGMA user_version = ${version + 1}`);
			});
			apply();
			version++;
		}
	}

	close(): void {
		this.db.close();
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts`
Expected: PASS (3 tests + config test)

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle test/lifecycle`
Expected: no errors.

```bash
git add src/lifecycle/config.ts src/lifecycle/store.ts test/lifecycle/store.test.ts
git commit -m "feat(lifecycle): SQLite store skeleton with v1 schema and migration ladder

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 2: Pure state machine (full transition table + guards)

**Files:**
- Create: `src/lifecycle/states.ts`
- Test: `test/lifecycle/states.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type FindingState = "new" | "open" | "regressed" | "improving" | "resolved" | "closed"`
  - `type SeenQualifier = "normal" | "regressed" | "improved"`
  - `type LifecycleEvent = { type: "seen"; qualifier: SeenQualifier } | { type: "absent" } | { type: "close" }`
  - `interface TransitionGuards { absenceCount: number; resolveAfterRuns: number }`
  - `type TransitionEffect = "reset-absence" | "reopen" | "file-fresh"`
  - `type TransitionResult = { ok: true; next: FindingState; effects: TransitionEffect[] } | { ok: false; reason: string }`
  - `function transition(state: FindingState, event: LifecycleEvent, guards: TransitionGuards): TransitionResult`

**THE transition table** (spec §4 demands the table form — this is normative; the code and tests encode exactly this):

| state \ event | seen(normal) | seen(regressed) | seen(improved) | absent, count < N | absent, count >= N | close |
|---|---|---|---|---|---|---|
| `new` | -> open /reset | -> regressed /reset | -> open /reset (1) | new (count++) | -> resolved | INVALID |
| `open` | open /reset | -> regressed /reset | -> improving /reset | open (count++) | -> resolved | INVALID |
| `regressed` | -> open /reset | regressed /reset | -> improving /reset | regressed (count++) | -> resolved | INVALID |
| `improving` | -> open /reset | -> regressed /reset | improving /reset | improving (count++) | -> resolved | INVALID |
| `resolved` | -> regressed /reopen+reset (2) | -> regressed /reopen+reset | -> regressed /reopen+reset | resolved (no-op) | resolved (no-op) | -> closed |
| `closed` | closed /file-fresh (3) | closed /file-fresh | closed /file-fresh | closed (no-op) | closed (no-op) | INVALID |

Guards: `absent` transitions to `resolved` iff `guards.absenceCount >= guards.resolveAfterRuns` (the count passed in is AFTER incrementing for this run). Effects: `reset-absence` = caller zeroes the absence counter; `reopen` = caller clears `resolved_at` and logs a `reopened` event (D2); `file-fresh` = caller creates a NEW finding row superseding the closed one (D3) — the closed row itself never changes state.

(1) `new × seen(improved) -> open`: improvement requires a baseline; the evaluator never emits `improved` for a first-window finding, but the table stays total.
(2) Re-appearance after `resolved` reopens WITH history (same row, occurrences retained) — spec §4.
(3) Re-appearance after `closed` (human-confirmed) files fresh with a link — spec §4.

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/states.test.ts`:

```typescript
/**
 * states.test.ts — exhaustive coverage of the lifecycle transition table
 * (every state × event × guard combination from the plan's normative table).
 */

import { describe, expect, it } from "bun:test";
import {
	type FindingState,
	type LifecycleEvent,
	transition,
} from "../../src/lifecycle/states.js";

const seen = (qualifier: "normal" | "regressed" | "improved"): LifecycleEvent => ({
	type: "seen",
	qualifier,
});
const absent: LifecycleEvent = { type: "absent" };
const close: LifecycleEvent = { type: "close" };
const below = { absenceCount: 1, resolveAfterRuns: 3 };
const atThreshold = { absenceCount: 3, resolveAfterRuns: 3 };

// [state, event, guards, expectedNext, expectedEffects] — INVALID rows use null next.
const TABLE: Array<
	[FindingState, LifecycleEvent, typeof below, FindingState | null, string[]]
> = [
	["new", seen("normal"), below, "open", ["reset-absence"]],
	["new", seen("regressed"), below, "regressed", ["reset-absence"]],
	["new", seen("improved"), below, "open", ["reset-absence"]],
	["new", absent, below, "new", []],
	["new", absent, atThreshold, "resolved", []],
	["new", close, below, null, []],
	["open", seen("normal"), below, "open", ["reset-absence"]],
	["open", seen("regressed"), below, "regressed", ["reset-absence"]],
	["open", seen("improved"), below, "improving", ["reset-absence"]],
	["open", absent, below, "open", []],
	["open", absent, atThreshold, "resolved", []],
	["open", close, below, null, []],
	["regressed", seen("normal"), below, "open", ["reset-absence"]],
	["regressed", seen("regressed"), below, "regressed", ["reset-absence"]],
	["regressed", seen("improved"), below, "improving", ["reset-absence"]],
	["regressed", absent, below, "regressed", []],
	["regressed", absent, atThreshold, "resolved", []],
	["regressed", close, below, null, []],
	["improving", seen("normal"), below, "open", ["reset-absence"]],
	["improving", seen("regressed"), below, "regressed", ["reset-absence"]],
	["improving", seen("improved"), below, "improving", ["reset-absence"]],
	["improving", absent, below, "improving", []],
	["improving", absent, atThreshold, "resolved", []],
	["improving", close, below, null, []],
	["resolved", seen("normal"), below, "regressed", ["reopen", "reset-absence"]],
	["resolved", seen("regressed"), below, "regressed", ["reopen", "reset-absence"]],
	["resolved", seen("improved"), below, "regressed", ["reopen", "reset-absence"]],
	["resolved", absent, below, "resolved", []],
	["resolved", absent, atThreshold, "resolved", []],
	["resolved", close, below, "closed", []],
	["closed", seen("normal"), below, "closed", ["file-fresh"]],
	["closed", seen("regressed"), below, "closed", ["file-fresh"]],
	["closed", seen("improved"), below, "closed", ["file-fresh"]],
	["closed", absent, below, "closed", []],
	["closed", absent, atThreshold, "closed", []],
	["closed", close, below, null, []],
];

describe("transition table", () => {
	for (const [state, event, guards, next, effects] of TABLE) {
		const eventLabel =
			event.type === "seen" ? `seen(${event.qualifier})` : event.type;
		const guardLabel =
			guards.absenceCount >= guards.resolveAfterRuns ? ">=N" : "<N";
		it(`${state} x ${eventLabel} [${guardLabel}] -> ${next ?? "INVALID"}`, () => {
			const result = transition(state, event, guards);
			if (next === null) {
				expect(result.ok).toBe(false);
			} else {
				if (!result.ok) throw new Error(`unexpected invalid: ${result.reason}`);
				expect(result.next).toBe(next);
				expect(result.effects).toEqual(effects as never);
			}
		});
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/states.test.ts`
Expected: FAIL — `Cannot find module '../../src/lifecycle/states.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lifecycle/states.ts`:

```typescript
/**
 * states.ts — the pure lifecycle state machine (umbrella spec §4).
 *
 * The FULL transition table lives in the plan document
 * (docs/superpowers/plans/2026-07-10-lifecycle-engine.md, Task 2) and in the
 * exhaustive test (test/lifecycle/states.test.ts). This module encodes it —
 * no I/O, no storage; guards are passed in.
 *
 * Effects tell the CALLER (evaluate.ts / CLI) what bookkeeping the
 * transition implies:
 *  - "reset-absence" — zero the consecutive-absence counter.
 *  - "reopen"        — clear resolved_at, log a "reopened" event (re-appearance
 *                      after resolved reopens WITH history).
 *  - "file-fresh"    — the closed row stays closed; create a NEW finding row
 *                      with a supersedes link (re-appearance after human close).
 */

export type FindingState =
	| "new"
	| "open"
	| "regressed"
	| "improving"
	| "resolved"
	| "closed";

export type SeenQualifier = "normal" | "regressed" | "improved";

export type LifecycleEvent =
	| { type: "seen"; qualifier: SeenQualifier }
	| { type: "absent" }
	| { type: "close" };

export interface TransitionGuards {
	/** Consecutive-absence count AFTER incrementing for the current run. */
	absenceCount: number;
	/** Config N: resolved after N consecutive compatible absences. */
	resolveAfterRuns: number;
}

export type TransitionEffect = "reset-absence" | "reopen" | "file-fresh";

export type TransitionResult =
	| { ok: true; next: FindingState; effects: TransitionEffect[] }
	| { ok: false; reason: string };

export function transition(
	state: FindingState,
	event: LifecycleEvent,
	guards: TransitionGuards,
): TransitionResult {
	switch (event.type) {
		case "seen": {
			if (state === "closed") {
				return { ok: true, next: "closed", effects: ["file-fresh"] };
			}
			if (state === "resolved") {
				return {
					ok: true,
					next: "regressed",
					effects: ["reopen", "reset-absence"],
				};
			}
			if (event.qualifier === "regressed") {
				return { ok: true, next: "regressed", effects: ["reset-absence"] };
			}
			if (event.qualifier === "improved") {
				// A brand-new finding has no baseline to improve against.
				const next = state === "new" ? "open" : "improving";
				return { ok: true, next, effects: ["reset-absence"] };
			}
			// qualifier === "normal": steady state is "open".
			return { ok: true, next: "open", effects: ["reset-absence"] };
		}
		case "absent": {
			if (state === "resolved" || state === "closed") {
				return { ok: true, next: state, effects: [] };
			}
			if (guards.absenceCount >= guards.resolveAfterRuns) {
				return { ok: true, next: "resolved", effects: [] };
			}
			return { ok: true, next: state, effects: [] };
		}
		case "close": {
			if (state === "resolved") {
				return { ok: true, next: "closed", effects: [] };
			}
			return {
				ok: false,
				reason: `close is only legal from resolved (state=${state})`,
			};
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/states.test.ts`
Expected: PASS — 36 table-row tests.

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle/states.ts test/lifecycle/states.test.ts`

```bash
git add src/lifecycle/states.ts test/lifecycle/states.test.ts
git commit -m "feat(lifecycle): pure state machine encoding the full transition table

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 3: Store CRUD (runs, findings, occurrences, events)

**Files:**
- Modify: `src/lifecycle/store.ts` (types + methods below the Task 1 class members)
- Test: `test/lifecycle/store.test.ts` (append describe blocks)

**Interfaces:**
- Consumes: `FindingState` from `./states.js` (Task 2); schema from Task 1.
- Produces (evaluate/digest/CLI rely on these exact signatures):
  - `interface ExercisedApps { ids: string[]; names: string[] }`
  - `interface RunInput { tenant: string; stream: string; profileId: string; captureKind: "sampling" | "instrumentation"; captureTime: string; versionStamp: string; incomplete: boolean; exercisedApps: ExercisedApps }`
  - `interface StoredRun extends RunInput { id: number; createdAt: string }`
  - `type FindingSeverity = "critical" | "warning" | "info"`; `type FindingSource = "pattern" | "alsem" | "telemetry"`
  - `interface FindingRow { id: number; tenant: string; fingerprint: string; algoVersion: number; state: FindingState; needsTriage: boolean; source: FindingSource; patternId: string; title: string; severity: FindingSeverity; appId: string; appName: string; routineKey: string; firstSeenAt: string; lastSeenAt: string; lastEventAt: string; absenceCount: number; observedKinds: string[]; observedStreams: string[]; resolvedAt: string | null; closedAt: string | null; supersedes: number | null }`
  - `interface NewFinding` — the insert shape (see code below): `FindingRow` minus `id/needsTriage/absenceCount/resolvedAt/closedAt/supersedes`, plus optional `needsTriage?: boolean`, `supersedes?: number`
  - Methods on `LifecycleStore`:
    - `recordRun(run: RunInput): { runId: number; duplicate: boolean }`
    - `getRun(tenant: string, profileId: string): StoredRun | null`
    - `insertFinding(f: NewFinding): number`
    - `getActiveFinding(tenant: string, fingerprint: string): FindingRow | null`
    - `getLatestClosedFinding(tenant: string, fingerprint: string): FindingRow | null`
    - `getFinding(id: number): FindingRow | null`
    - `listFindings(q?: { tenant?: string; state?: FindingState; needsTriage?: boolean; limit?: number }): FindingRow[]`
    - `listAbsenceCandidates(tenant: string): FindingRow[]` — state ∈ {new, open, regressed, improving}
    - `markSeen(id: number, args: { state: FindingState; severity: FindingSeverity; captureTime: string; captureKind: string; stream: string }): void` — zeroes absence, merges observed kinds/streams, advances last_seen_at/last_event_at (monotonic max), clears resolved_at
    - `markAbsent(id: number, args: { state: FindingState; absenceCount: number; captureTime: string }): void` — sets resolved_at when the new state is resolved
    - `updateFindingState(id: number, patch: { state: FindingState; closedAt?: string }): void`
    - `setNeedsTriage(id: number, flag: boolean): void`
    - `recordOccurrence(o: { findingId: number; runId: number; captureTime: string; severity: string; impact?: number; metricValue?: number; metricClass?: string; details?: string }): boolean` — false when the (findingId, runId) pair already exists (idempotency per (fingerprint, profileId))
    - `countOccurrences(findingId: number): number`
    - `logEvent(e: { findingId: number; runId?: number; event: string; fromState: string | null; toState: string; at: string; detail?: string }): void`
    - `listEvents(findingId: number): Array<{ id: number; findingId: number; runId: number | null; event: string; fromState: string | null; toState: string; at: string; detail: string | null }>`

- [ ] **Step 1: Write the failing tests**

Append to `test/lifecycle/store.test.ts` (add the `NewFinding` type import to the existing import from `../../src/lifecycle/store.js`):

```typescript
import type { NewFinding } from "../../src/lifecycle/store.js";

function baseFinding(overrides?: Partial<NewFinding>): NewFinding {
	return {
		tenant: "t1",
		fingerprint: "pattern:deadbeef00000000",
		algoVersion: 1,
		state: "new",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "CalcFields inside loop",
		severity: "warning",
		appId: "abc123",
		appName: "My App",
		routineKey: "abc123|codeunit|50100|postorder",
		firstSeenAt: "2026-07-01T10:00:00Z",
		lastSeenAt: "2026-07-01T10:00:00Z",
		lastEventAt: "2026-07-01T10:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
		...overrides,
	};
}

describe("LifecycleStore CRUD", () => {
	it("recordRun is idempotent per (tenant, profileId)", () => {
		const store = new LifecycleStore(":memory:");
		const run = {
			tenant: "t1",
			stream: "nightly",
			profileId: "p-001",
			captureKind: "sampling" as const,
			captureTime: "2026-07-01T10:00:00Z",
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: ["abc123"], names: ["my app"] },
		};
		const first = store.recordRun(run);
		expect(first.duplicate).toBe(false);
		const second = store.recordRun(run);
		expect(second.duplicate).toBe(true);
		expect(second.runId).toBe(first.runId);
		const stored = store.getRun("t1", "p-001");
		expect(stored?.exercisedApps.ids).toEqual(["abc123"]);
		store.close();
	});

	it("insertFinding + getActiveFinding roundtrip; closed rows are not active", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(baseFinding());
		const row = store.getActiveFinding("t1", "pattern:deadbeef00000000");
		expect(row?.id).toBe(id);
		expect(row?.state).toBe("new");
		expect(row?.observedKinds).toEqual(["sampling"]);
		store.updateFindingState(id, {
			state: "closed",
			closedAt: "2026-07-02T00:00:00Z",
		});
		expect(store.getActiveFinding("t1", "pattern:deadbeef00000000")).toBeNull();
		expect(
			store.getLatestClosedFinding("t1", "pattern:deadbeef00000000")?.id,
		).toBe(id);
		store.close();
	});

	it("recordOccurrence is idempotent per (findingId, runId)", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		const { runId } = store.recordRun({
			tenant: "t1",
			stream: "nightly",
			profileId: "p-001",
			captureKind: "sampling",
			captureTime: "2026-07-01T10:00:00Z",
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: [], names: [] },
		});
		const occ = {
			findingId,
			runId,
			captureTime: "2026-07-01T10:00:00Z",
			severity: "warning",
			impact: 5000,
		};
		expect(store.recordOccurrence(occ)).toBe(true);
		expect(store.recordOccurrence(occ)).toBe(false);
		expect(store.countOccurrences(findingId)).toBe(1);
		store.close();
	});

	it("markSeen merges observed kinds/streams, resets absence, clears resolved_at", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(baseFinding());
		store.markAbsent(id, {
			state: "resolved",
			absenceCount: 3,
			captureTime: "2026-07-03T10:00:00Z",
		});
		expect(store.getFinding(id)?.resolvedAt).toBe("2026-07-03T10:00:00Z");
		store.markSeen(id, {
			state: "regressed",
			severity: "critical",
			captureTime: "2026-07-04T10:00:00Z",
			captureKind: "instrumentation",
			stream: "adhoc",
		});
		const row = store.getFinding(id);
		expect(row?.state).toBe("regressed");
		expect(row?.severity).toBe("critical");
		expect(row?.absenceCount).toBe(0);
		expect(row?.resolvedAt).toBeNull();
		expect(row?.observedKinds).toEqual(["sampling", "instrumentation"]);
		expect(row?.observedStreams).toEqual(["nightly", "adhoc"]);
		expect(row?.lastEventAt).toBe("2026-07-04T10:00:00Z");
		store.close();
	});

	it("listAbsenceCandidates returns only active-state findings for the tenant", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(baseFinding({ fingerprint: "pattern:aaa", state: "open" }));
		store.insertFinding(
			baseFinding({ fingerprint: "pattern:bbb", state: "resolved" }),
		);
		store.insertFinding(
			baseFinding({ fingerprint: "pattern:ccc", tenant: "t2", state: "open" }),
		);
		const rows = store.listAbsenceCandidates("t1");
		expect(rows.map((r) => r.fingerprint)).toEqual(["pattern:aaa"]);
		store.close();
	});

	it("logEvent/listEvents roundtrip in insertion order", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(baseFinding());
		store.logEvent({
			findingId: id,
			event: "first-seen",
			fromState: null,
			toState: "new",
			at: "2026-07-01T10:00:00Z",
		});
		store.logEvent({
			findingId: id,
			event: "seen",
			fromState: "new",
			toState: "open",
			at: "2026-07-02T10:00:00Z",
			detail: JSON.stringify({ metricClass: "normal" }),
		});
		const events = store.listEvents(id);
		expect(events.map((e) => e.event)).toEqual(["first-seen", "seen"]);
		expect(events[1].fromState).toBe("new");
		store.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts`
Expected: FAIL — `recordRun is not a function` (and missing `NewFinding` export).

- [ ] **Step 3: Write the implementation**

In `src/lifecycle/store.ts`, add the import at the top:

```typescript
import type { FindingState } from "./states.js";
```

Add these exported types (below `LIFECYCLE_SCHEMA_VERSION`, above the class):

```typescript
export interface ExercisedApps {
	ids: string[];
	names: string[];
}

export interface RunInput {
	tenant: string;
	stream: string;
	profileId: string;
	captureKind: "sampling" | "instrumentation";
	captureTime: string;
	versionStamp: string;
	incomplete: boolean;
	exercisedApps: ExercisedApps;
}

export interface StoredRun extends RunInput {
	id: number;
	createdAt: string;
}

export type FindingSeverity = "critical" | "warning" | "info";
export type FindingSource = "pattern" | "alsem" | "telemetry";

export interface FindingRow {
	id: number;
	tenant: string;
	fingerprint: string;
	algoVersion: number;
	state: FindingState;
	needsTriage: boolean;
	source: FindingSource;
	patternId: string;
	title: string;
	severity: FindingSeverity;
	appId: string;
	appName: string;
	routineKey: string;
	firstSeenAt: string;
	lastSeenAt: string;
	lastEventAt: string;
	absenceCount: number;
	observedKinds: string[];
	observedStreams: string[];
	resolvedAt: string | null;
	closedAt: string | null;
	supersedes: number | null;
}

export interface NewFinding {
	tenant: string;
	fingerprint: string;
	algoVersion: number;
	state: FindingState;
	source: FindingSource;
	patternId: string;
	title: string;
	severity: FindingSeverity;
	appId: string;
	appName: string;
	routineKey: string;
	firstSeenAt: string;
	lastSeenAt: string;
	lastEventAt: string;
	observedKinds: string[];
	observedStreams: string[];
	needsTriage?: boolean;
	supersedes?: number;
}
```

Add these methods inside the `LifecycleStore` class (after `close()`):

```typescript
	recordRun(run: RunInput): { runId: number; duplicate: boolean } {
		const existing = this.db
			.query<{ id: number }, [string, string]>(
				"SELECT id FROM runs WHERE tenant = ? AND profile_id = ?",
			)
			.get(run.tenant, run.profileId);
		if (existing) return { runId: existing.id, duplicate: true };
		const res = this.db.run(
			`INSERT INTO runs (tenant, stream, profile_id, capture_kind, capture_time, version_stamp, incomplete, exercised_apps, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				run.tenant,
				run.stream,
				run.profileId,
				run.captureKind,
				run.captureTime,
				run.versionStamp,
				run.incomplete ? 1 : 0,
				JSON.stringify(run.exercisedApps),
				new Date().toISOString(),
			],
		);
		return { runId: Number(res.lastInsertRowid), duplicate: false };
	}

	getRun(tenant: string, profileId: string): StoredRun | null {
		const row = this.db
			.query<Record<string, unknown>, [string, string]>(
				"SELECT * FROM runs WHERE tenant = ? AND profile_id = ?",
			)
			.get(tenant, profileId);
		if (!row) return null;
		return {
			id: row.id as number,
			tenant: row.tenant as string,
			stream: row.stream as string,
			profileId: row.profile_id as string,
			captureKind: row.capture_kind as "sampling" | "instrumentation",
			captureTime: row.capture_time as string,
			versionStamp: row.version_stamp as string,
			incomplete: (row.incomplete as number) === 1,
			exercisedApps: JSON.parse(row.exercised_apps as string) as ExercisedApps,
			createdAt: row.created_at as string,
		};
	}

	insertFinding(f: NewFinding): number {
		const res = this.db.run(
			`INSERT INTO findings (tenant, fingerprint, algo_version, state, needs_triage, source, pattern_id, title, severity, app_id, app_name, routine_key, first_seen_at, last_seen_at, last_event_at, observed_kinds, observed_streams, supersedes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				f.tenant,
				f.fingerprint,
				f.algoVersion,
				f.state,
				f.needsTriage ? 1 : 0,
				f.source,
				f.patternId,
				f.title,
				f.severity,
				f.appId,
				f.appName,
				f.routineKey,
				f.firstSeenAt,
				f.lastSeenAt,
				f.lastEventAt,
				JSON.stringify(f.observedKinds),
				JSON.stringify(f.observedStreams),
				f.supersedes ?? null,
			],
		);
		return Number(res.lastInsertRowid);
	}

	private rowToFinding(row: Record<string, unknown>): FindingRow {
		return {
			id: row.id as number,
			tenant: row.tenant as string,
			fingerprint: row.fingerprint as string,
			algoVersion: row.algo_version as number,
			state: row.state as FindingState,
			needsTriage: (row.needs_triage as number) === 1,
			source: row.source as FindingSource,
			patternId: row.pattern_id as string,
			title: row.title as string,
			severity: row.severity as FindingSeverity,
			appId: row.app_id as string,
			appName: row.app_name as string,
			routineKey: row.routine_key as string,
			firstSeenAt: row.first_seen_at as string,
			lastSeenAt: row.last_seen_at as string,
			lastEventAt: row.last_event_at as string,
			absenceCount: row.absence_count as number,
			observedKinds: JSON.parse(row.observed_kinds as string) as string[],
			observedStreams: JSON.parse(row.observed_streams as string) as string[],
			resolvedAt: (row.resolved_at as string | null) ?? null,
			closedAt: (row.closed_at as string | null) ?? null,
			supersedes: (row.supersedes as number | null) ?? null,
		};
	}

	getActiveFinding(tenant: string, fingerprint: string): FindingRow | null {
		const row = this.db
			.query<Record<string, unknown>, [string, string]>(
				"SELECT * FROM findings WHERE tenant = ? AND fingerprint = ? AND state != 'closed'",
			)
			.get(tenant, fingerprint);
		return row ? this.rowToFinding(row) : null;
	}

	getLatestClosedFinding(
		tenant: string,
		fingerprint: string,
	): FindingRow | null {
		const row = this.db
			.query<Record<string, unknown>, [string, string]>(
				"SELECT * FROM findings WHERE tenant = ? AND fingerprint = ? AND state = 'closed' ORDER BY id DESC LIMIT 1",
			)
			.get(tenant, fingerprint);
		return row ? this.rowToFinding(row) : null;
	}

	getFinding(id: number): FindingRow | null {
		const row = this.db
			.query<Record<string, unknown>, [number]>(
				"SELECT * FROM findings WHERE id = ?",
			)
			.get(id);
		return row ? this.rowToFinding(row) : null;
	}

	listFindings(q?: {
		tenant?: string;
		state?: FindingState;
		needsTriage?: boolean;
		limit?: number;
	}): FindingRow[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (q?.tenant) {
			where.push("tenant = ?");
			params.push(q.tenant);
		}
		if (q?.state) {
			where.push("state = ?");
			params.push(q.state);
		}
		if (q?.needsTriage !== undefined) {
			where.push("needs_triage = ?");
			params.push(q.needsTriage ? 1 : 0);
		}
		let sql = "SELECT * FROM findings";
		if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
		sql += " ORDER BY last_seen_at DESC, id DESC";
		if (q?.limit !== undefined && q.limit > 0) {
			sql += " LIMIT ?";
			params.push(q.limit);
		}
		return this.db
			.query<Record<string, unknown>, (string | number)[]>(sql)
			.all(...params)
			.map((row) => this.rowToFinding(row));
	}

	listAbsenceCandidates(tenant: string): FindingRow[] {
		return this.db
			.query<Record<string, unknown>, [string]>(
				"SELECT * FROM findings WHERE tenant = ? AND state IN ('new','open','regressed','improving')",
			)
			.all(tenant)
			.map((row) => this.rowToFinding(row));
	}

	markSeen(
		id: number,
		args: {
			state: FindingState;
			severity: FindingSeverity;
			captureTime: string;
			captureKind: string;
			stream: string;
		},
	): void {
		const row = this.getFinding(id);
		if (!row) throw new Error(`markSeen: finding ${id} not found`);
		const kinds = row.observedKinds.includes(args.captureKind)
			? row.observedKinds
			: [...row.observedKinds, args.captureKind];
		const streams = row.observedStreams.includes(args.stream)
			? row.observedStreams
			: [...row.observedStreams, args.stream];
		this.db.run(
			`UPDATE findings SET state = ?, severity = ?, absence_count = 0, resolved_at = NULL,
				last_seen_at = max(last_seen_at, ?), last_event_at = max(last_event_at, ?),
				observed_kinds = ?, observed_streams = ? WHERE id = ?`,
			[
				args.state,
				args.severity,
				args.captureTime,
				args.captureTime,
				JSON.stringify(kinds),
				JSON.stringify(streams),
				id,
			],
		);
	}

	markAbsent(
		id: number,
		args: { state: FindingState; absenceCount: number; captureTime: string },
	): void {
		this.db.run(
			`UPDATE findings SET state = ?, absence_count = ?, last_event_at = max(last_event_at, ?),
				resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END WHERE id = ?`,
			[
				args.state,
				args.absenceCount,
				args.captureTime,
				args.state,
				args.captureTime,
				id,
			],
		);
	}

	updateFindingState(
		id: number,
		patch: { state: FindingState; closedAt?: string },
	): void {
		this.db.run(
			"UPDATE findings SET state = ?, closed_at = coalesce(?, closed_at) WHERE id = ?",
			[patch.state, patch.closedAt ?? null, id],
		);
	}

	setNeedsTriage(id: number, flag: boolean): void {
		this.db.run("UPDATE findings SET needs_triage = ? WHERE id = ?", [
			flag ? 1 : 0,
			id,
		]);
	}

	recordOccurrence(o: {
		findingId: number;
		runId: number;
		captureTime: string;
		severity: string;
		impact?: number;
		metricValue?: number;
		metricClass?: string;
		details?: string;
	}): boolean {
		const res = this.db.run(
			`INSERT OR IGNORE INTO occurrences (finding_id, run_id, capture_time, severity, impact, metric_value, metric_class, details)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				o.findingId,
				o.runId,
				o.captureTime,
				o.severity,
				o.impact ?? null,
				o.metricValue ?? null,
				o.metricClass ?? null,
				o.details ?? null,
			],
		);
		return res.changes > 0;
	}

	countOccurrences(findingId: number): number {
		const row = this.db
			.query<{ n: number }, [number]>(
				"SELECT count(*) AS n FROM occurrences WHERE finding_id = ?",
			)
			.get(findingId);
		return row?.n ?? 0;
	}

	logEvent(e: {
		findingId: number;
		runId?: number;
		event: string;
		fromState: string | null;
		toState: string;
		at: string;
		detail?: string;
	}): void {
		this.db.run(
			`INSERT INTO finding_events (finding_id, run_id, event, from_state, to_state, at, detail)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				e.findingId,
				e.runId ?? null,
				e.event,
				e.fromState,
				e.toState,
				e.at,
				e.detail ?? null,
			],
		);
	}

	listEvents(findingId: number): Array<{
		id: number;
		findingId: number;
		runId: number | null;
		event: string;
		fromState: string | null;
		toState: string;
		at: string;
		detail: string | null;
	}> {
		return this.db
			.query<Record<string, unknown>, [number]>(
				"SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id",
			)
			.all(findingId)
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

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/store.test.ts`
Expected: PASS — all schema + CRUD tests.

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle test/lifecycle`

```bash
git add src/lifecycle/store.ts test/lifecycle/store.test.ts
git commit -m "feat(lifecycle): store CRUD for runs, findings, occurrences, events

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 4: Baselines — routine metrics, version segmentation, rollup

**Files:**
- Create: `src/lifecycle/baselines.ts`
- Test: `test/lifecycle/baselines.test.ts`

**Interfaces:**
- Consumes: `LifecycleStore` (Task 3), `LifecycleConfig` (Task 1), `canonicalObjectType`/`normalizeAppGuid`/`normalizeTriggerName` from `src/semantic/identity.js` (existing), `MethodBreakdown` from `src/types/aggregated.js` (existing).
- Produces:
  - `interface RunVersions { platform?: string; apps?: Array<{ id: string; version: string }> }`
  - `function versionStampFrom(versions?: RunVersions): string`
  - `function routineKeyFor(m: { appId?: string; objectType: string; objectId: number; functionName: string }): string`
  - `interface MetricRunKey { tenant: string; stream: string; captureKind: "sampling" | "instrumentation"; profileId: string; captureTime: string; versionStamp: string }`
  - `function recordRoutineMetrics(store: LifecycleStore, run: MetricRunKey, methods: MethodBreakdown[], cap: number): number`
  - `interface BaselineStats { median: number; sameStampCount: number; latestPriorStamp: string }`
  - `function computeBaseline(store: LifecycleStore, key: { tenant: string; stream: string; captureKind: string; routineKey: string }, beforeTime: string, window: number): BaselineStats | null`
  - `type MetricClass = "normal" | "regressed" | "improved" | "no-baseline" | "environment-changed"`
  - `function classifyObservation(current: number, baseline: BaselineStats | null, currentVersionStamp: string, cfg: LifecycleConfig): MetricClass`
  - `function rollupRoutineMetrics(store: LifecycleStore, now: string, retentionDays: number): { rolledUp: number; deleted: number }`

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/baselines.test.ts`:

```typescript
/**
 * baselines.test.ts — routine keys, version stamps, metric recording (cap +
 * builtin filter), median baselines, version segmentation
 * ("environment-changed", spec §4), and the 90-day rollup.
 */

import { describe, expect, it } from "bun:test";
import {
	classifyObservation,
	computeBaseline,
	recordRoutineMetrics,
	rollupRoutineMetrics,
	routineKeyFor,
	versionStampFrom,
} from "../../src/lifecycle/baselines.js";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/lifecycle/config.js";
import { LifecycleStore } from "../../src/lifecycle/store.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";

function method(overrides: Partial<MethodBreakdown>): MethodBreakdown {
	return {
		functionName: "PostOrder",
		objectType: "codeunit",
		objectName: "Order Post",
		objectId: 50100,
		appName: "My App",
		appId: "ABC-123",
		selfTime: 1_000_000,
		selfTimePercent: 50,
		totalTime: 1_200_000,
		totalTimePercent: 60,
		hitCount: 10,
		calledBy: [],
		calls: [],
		costPerHit: 100_000,
		efficiencyScore: 0.8,
		...overrides,
	};
}

const KEY = {
	tenant: "t1",
	stream: "nightly",
	captureKind: "sampling" as const,
	routineKey: routineKeyFor({
		appId: "ABC-123",
		objectType: "codeunit",
		objectId: 50100,
		functionName: "PostOrder",
	}),
};

function seedRun(
	store: LifecycleStore,
	profileId: string,
	captureTime: string,
	selfTime: number,
	versionStamp = "",
) {
	recordRoutineMetrics(
		store,
		{ ...KEY, profileId, captureTime, versionStamp },
		[method({ selfTime })],
		500,
	);
}

describe("routineKeyFor / versionStampFrom", () => {
	it("normalizes app guid, object type casing, and routine name casing", () => {
		expect(
			routineKeyFor({
				appId: "ABC-123",
				objectType: "CODEUNIT",
				objectId: 50100,
				functionName: "PostOrder",
			}),
		).toBe(
			routineKeyFor({
				appId: "abc123",
				objectType: "Codeunit",
				objectId: 50100,
				functionName: "POSTORDER",
			}),
		);
	});

	it("versionStampFrom is canonical (app order irrelevant) and empty when absent", () => {
		expect(versionStampFrom(undefined)).toBe("");
		expect(versionStampFrom({})).toBe("");
		const a = versionStampFrom({
			platform: "26.0",
			apps: [
				{ id: "b", version: "2.0" },
				{ id: "a", version: "1.0" },
			],
		});
		const b = versionStampFrom({
			platform: "26.0",
			apps: [
				{ id: "a", version: "1.0" },
				{ id: "b", version: "2.0" },
			],
		});
		expect(a).toBe(b);
	});
});

describe("recordRoutineMetrics", () => {
	it("caps rows by selfTime and skips builtins; idempotent per profile", () => {
		const store = new LifecycleStore(":memory:");
		const methods = [
			method({ functionName: "A", selfTime: 300 }),
			method({ functionName: "B", selfTime: 200 }),
			method({ functionName: "C", selfTime: 100 }),
			method({ functionName: "Sys", selfTime: 999, isBuiltin: true }),
		];
		const run = {
			tenant: "t1",
			stream: "nightly",
			captureKind: "sampling" as const,
			profileId: "p1",
			captureTime: "2026-07-01T00:00:00Z",
			versionStamp: "",
		};
		expect(recordRoutineMetrics(store, run, methods, 2)).toBe(2);
		// Re-recording the same profile writes nothing (INSERT OR IGNORE).
		expect(recordRoutineMetrics(store, run, methods, 2)).toBe(0);
		const names = store.db
			.query<{ routine_key: string }, []>(
				"SELECT routine_key FROM routine_metrics ORDER BY self_time DESC",
			)
			.all()
			.map((r) => r.routine_key);
		expect(names.length).toBe(2);
		expect(names[0]).toContain("|a"); // top selfTime first, builtin excluded
		store.close();
	});
});

describe("computeBaseline / classifyObservation", () => {
	it("returns null with no prior rows, then the same-segment median", () => {
		const store = new LifecycleStore(":memory:");
		expect(
			computeBaseline(store, KEY, "2026-07-05T00:00:00Z", 10),
		).toBeNull();
		seedRun(store, "p1", "2026-07-01T00:00:00Z", 1_000_000);
		seedRun(store, "p2", "2026-07-02T00:00:00Z", 1_200_000);
		seedRun(store, "p3", "2026-07-03T00:00:00Z", 1_100_000);
		const b = computeBaseline(store, KEY, "2026-07-05T00:00:00Z", 10);
		expect(b?.median).toBe(1_100_000);
		expect(b?.sameStampCount).toBe(3);
		store.close();
	});

	it("classifies regressed/improved with factor AND absolute floor", () => {
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		const base = { median: 1_000_000, sameStampCount: 3, latestPriorStamp: "" };
		expect(classifyObservation(2_000_000, base, "", cfg)).toBe("regressed");
		expect(classifyObservation(500_000, base, "", cfg)).toBe("improved");
		expect(classifyObservation(1_100_000, base, "", cfg)).toBe("normal");
		// Below the absolute floor a tiny routine can never regress (D11).
		const tiny = { median: 10_000, sameStampCount: 3, latestPriorStamp: "" };
		expect(classifyObservation(50_000, tiny, "", cfg)).toBe("normal");
		expect(classifyObservation(null as never, null, "", cfg)).toBe("no-baseline");
	});

	it("a shift coinciding with a version change is environment-changed, not regressed", () => {
		const store = new LifecycleStore(":memory:");
		const v1 = versionStampFrom({ platform: "25.0" });
		const v2 = versionStampFrom({ platform: "26.0" });
		seedRun(store, "p1", "2026-07-01T00:00:00Z", 1_000_000, v1);
		seedRun(store, "p2", "2026-07-02T00:00:00Z", 1_000_000, v1);
		seedRun(store, "p3", "2026-07-03T00:00:00Z", 1_000_000, v1);
		const b = computeBaseline(store, KEY, "2026-07-04T00:00:00Z", 10);
		expect(
			classifyObservation(9_000_000, b, v2, DEFAULT_LIFECYCLE_CONFIG),
		).toBe("environment-changed");
		// Same stamp would have been a regression.
		expect(
			classifyObservation(9_000_000, b, v1, DEFAULT_LIFECYCLE_CONFIG),
		).toBe("regressed");
		store.close();
	});

	it("baselines never cross the version boundary once the segment has enough runs", () => {
		const store = new LifecycleStore(":memory:");
		const v1 = versionStampFrom({ platform: "25.0" });
		const v2 = versionStampFrom({ platform: "26.0" });
		seedRun(store, "p1", "2026-07-01T00:00:00Z", 100_000, v1);
		seedRun(store, "p2", "2026-07-02T00:00:00Z", 5_000_000, v2);
		seedRun(store, "p3", "2026-07-03T00:00:00Z", 5_100_000, v2);
		seedRun(store, "p4", "2026-07-04T00:00:00Z", 5_200_000, v2);
		const b = computeBaseline(store, KEY, "2026-07-05T00:00:00Z", 10);
		// Median over the v2 segment only — the old 100ms row is excluded.
		expect(b?.median).toBe(5_100_000);
		expect(b?.sameStampCount).toBe(3);
		store.close();
	});
});

describe("rollupRoutineMetrics", () => {
	it("folds raw rows older than retention into daily rollups and deletes them", () => {
		const store = new LifecycleStore(":memory:");
		seedRun(store, "old1", "2026-01-01T06:00:00Z", 1_000_000);
		seedRun(store, "old2", "2026-01-01T18:00:00Z", 3_000_000);
		seedRun(store, "recent", "2026-07-01T00:00:00Z", 2_000_000);
		const res = rollupRoutineMetrics(store, "2026-07-09T00:00:00Z", 90);
		expect(res.deleted).toBe(2);
		expect(res.rolledUp).toBe(1);
		const rollup = store.db
			.query<Record<string, unknown>, []>(
				"SELECT * FROM routine_metrics_rollup",
			)
			.get();
		expect(rollup?.day).toBe("2026-01-01");
		expect(rollup?.run_count).toBe(2);
		expect(rollup?.self_time_median).toBe(2_000_000);
		const rawLeft = store.db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM routine_metrics")
			.get();
		expect(rawLeft?.n).toBe(1);
		store.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/baselines.test.ts`
Expected: FAIL — `Cannot find module '../../src/lifecycle/baselines.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lifecycle/baselines.ts`:

```typescript
/**
 * baselines.ts — per-routine, per-run metrics with version-aware rolling
 * baselines (umbrella spec §4 trigger rules).
 *
 * Baselines are keyed (tenant, stream, captureKind, routineKey) — sampling
 * statistical self-time and instrumentation exact ticks are never comparable
 * — and version-stamped: a metric shift that coincides with a version-stamp
 * change classifies as "environment-changed", never "regressed" (monthly BC
 * minor updates must not file false regressions).
 *
 * Retention: raw rows for rawMetricsRetentionDays (default 90), folded into
 * daily rollups by rollupRoutineMetrics — a callable maintenance function
 * (surfaced as `lifecycle maintain`); scheduling is out of scope.
 */

import {
	canonicalObjectType,
	normalizeAppGuid,
	normalizeTriggerName,
} from "../semantic/identity.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { LifecycleConfig } from "./config.js";
import type { LifecycleStore } from "./store.js";

export interface RunVersions {
	platform?: string;
	apps?: Array<{ id: string; version: string }>;
}

/**
 * Canonical version stamp: "" when no version info, else stable JSON with
 * apps sorted by id (so producer ordering can't split segments).
 */
export function versionStampFrom(versions?: RunVersions): string {
	if (!versions || (!versions.platform && !(versions.apps?.length ?? 0))) {
		return "";
	}
	const apps = [...(versions.apps ?? [])].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	return JSON.stringify({ platform: versions.platform ?? "", apps });
}

/**
 * Normalized routine identity for baseline keying — the same normalization
 * family as the fingerprint fallback key (identity must not split on casing
 * or GUID-dash drift between producers).
 */
export function routineKeyFor(m: {
	appId?: string;
	objectType: string;
	objectId: number;
	functionName: string;
}): string {
	return [
		normalizeAppGuid(m.appId),
		canonicalObjectType(m.objectType),
		String(m.objectId),
		normalizeTriggerName(m.functionName).toLowerCase(),
	].join("|");
}

export interface MetricRunKey {
	tenant: string;
	stream: string;
	captureKind: "sampling" | "instrumentation";
	profileId: string;
	captureTime: string;
	versionStamp: string;
}

/**
 * Write per-routine metric rows for one run: top `cap` AL methods by
 * selfTime (builtins excluded — they can't anchor findings). INSERT OR
 * IGNORE keyed (tenant, profileId, routineKey) makes re-recording a no-op.
 * Returns the number of rows actually written.
 */
export function recordRoutineMetrics(
	store: LifecycleStore,
	run: MetricRunKey,
	methods: MethodBreakdown[],
	cap: number,
): number {
	const top = methods
		.filter((m) => !m.isBuiltin)
		.sort((a, b) => b.selfTime - a.selfTime)
		.slice(0, cap);
	const insert = store.db.prepare(
		`INSERT OR IGNORE INTO routine_metrics (tenant, stream, capture_kind, routine_key, profile_id, capture_time, self_time, total_time, hit_count, version_stamp)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	let written = 0;
	const tx = store.db.transaction(() => {
		for (const m of top) {
			const res = insert.run(
				run.tenant,
				run.stream,
				run.captureKind,
				routineKeyFor(m),
				run.profileId,
				run.captureTime,
				m.selfTime,
				m.totalTime,
				m.hitCount,
				run.versionStamp,
			);
			if (res.changes > 0) written++;
		}
	});
	tx();
	return written;
}

export interface BaselineStats {
	/** Median selfTime over prior runs in the CURRENT segment. */
	median: number;
	/** Number of prior runs sharing the latest prior version stamp. */
	sameStampCount: number;
	/** Version stamp of the most recent prior run (segment-boundary detection). */
	latestPriorStamp: string;
}

/**
 * Rolling baseline: the last `window` rows strictly before `beforeTime` for
 * the key. The median is computed over the rows sharing the MOST RECENT
 * prior version stamp only — baselines segment at version boundaries.
 */
export function computeBaseline(
	store: LifecycleStore,
	key: {
		tenant: string;
		stream: string;
		captureKind: string;
		routineKey: string;
	},
	beforeTime: string,
	window: number,
): BaselineStats | null {
	const rows = store.db
		.query<
			{ self_time: number; version_stamp: string },
			[string, string, string, string, string, number]
		>(
			`SELECT self_time, version_stamp FROM routine_metrics
			 WHERE tenant = ? AND stream = ? AND capture_kind = ? AND routine_key = ? AND capture_time < ?
			 ORDER BY capture_time DESC LIMIT ?`,
		)
		.all(
			key.tenant,
			key.stream,
			key.captureKind,
			key.routineKey,
			beforeTime,
			window,
		);
	if (rows.length === 0) return null;
	const latestPriorStamp = rows[0].version_stamp;
	const same = rows
		.filter((r) => r.version_stamp === latestPriorStamp)
		.map((r) => r.self_time)
		.sort((a, b) => a - b);
	const mid = Math.floor(same.length / 2);
	const median =
		same.length % 2 === 1 ? same[mid] : (same[mid - 1] + same[mid]) / 2;
	return { median, sameStampCount: same.length, latestPriorStamp };
}

export type MetricClass =
	| "normal"
	| "regressed"
	| "improved"
	| "no-baseline"
	| "environment-changed";

/**
 * Classify a current observation against its baseline:
 *  - no prior rows, or too few same-segment samples → "no-baseline"
 *  - version stamp changed since the baseline → "environment-changed"
 *    (annotated, never a regression — spec §4)
 *  - factor AND absolute-floor guards for regressed/improved (both must
 *    hold, so tiny routines can't flap on noise)
 */
export function classifyObservation(
	current: number,
	baseline: BaselineStats | null,
	currentVersionStamp: string,
	cfg: LifecycleConfig,
): MetricClass {
	if (!baseline) return "no-baseline";
	if (baseline.latestPriorStamp !== currentVersionStamp) {
		return "environment-changed";
	}
	if (baseline.sameStampCount < cfg.baselineMinRuns) return "no-baseline";
	const delta = current - baseline.median;
	if (
		current > baseline.median * cfg.regressionFactor &&
		delta >= cfg.regressionMinDeltaUs
	) {
		return "regressed";
	}
	if (
		current < baseline.median * cfg.improvementFactor &&
		-delta >= cfg.regressionMinDeltaUs
	) {
		return "improved";
	}
	return "normal";
}

/**
 * Maintenance: fold raw routine_metrics rows older than `retentionDays`
 * (relative to `now`) into daily rollups, then delete the raw rows.
 * Idempotent: re-running with no old rows is a no-op; rollup rows are
 * REPLACEd per (tenant, stream, captureKind, routineKey, day).
 */
export function rollupRoutineMetrics(
	store: LifecycleStore,
	now: string,
	retentionDays: number,
): { rolledUp: number; deleted: number } {
	const cutoff = new Date(
		new Date(now).getTime() - retentionDays * 86_400_000,
	).toISOString();
	const rows = store.db
		.query<
			{
				tenant: string;
				stream: string;
				capture_kind: string;
				routine_key: string;
				capture_time: string;
				self_time: number;
				total_time: number;
				hit_count: number;
			},
			[string]
		>(
			`SELECT tenant, stream, capture_kind, routine_key, capture_time, self_time, total_time, hit_count
			 FROM routine_metrics WHERE capture_time < ?`,
		)
		.all(cutoff);
	if (rows.length === 0) return { rolledUp: 0, deleted: 0 };

	const groups = new Map<string, typeof rows>();
	for (const row of rows) {
		const day = row.capture_time.slice(0, 10);
		const key = JSON.stringify([row.tenant, row.stream, row.capture_kind, row.routine_key, day]);
		const bucket = groups.get(key);
		if (bucket) bucket.push(row);
		else groups.set(key, [row]);
	}

	const upsert = store.db.prepare(
		`INSERT OR REPLACE INTO routine_metrics_rollup (tenant, stream, capture_kind, routine_key, day, run_count, self_time_min, self_time_max, self_time_mean, self_time_median, total_time_mean, hit_count_mean)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	let rolledUp = 0;
	const tx = store.db.transaction(() => {
		for (const [key, bucket] of groups) {
			const [tenant, stream, captureKind, routineKey, day] = JSON.parse(key) as string[];
			const selfTimes = bucket.map((r) => r.self_time).sort((a, b) => a - b);
			const mid = Math.floor(selfTimes.length / 2);
			const median =
				selfTimes.length % 2 === 1
					? selfTimes[mid]
					: (selfTimes[mid - 1] + selfTimes[mid]) / 2;
			const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
			upsert.run(
				tenant,
				stream,
				captureKind,
				routineKey,
				day,
				bucket.length,
				selfTimes[0],
				selfTimes[selfTimes.length - 1],
				mean(bucket.map((r) => r.self_time)),
				median,
				mean(bucket.map((r) => r.total_time)),
				mean(bucket.map((r) => r.hit_count)),
			);
			rolledUp++;
		}
		store.db.run("DELETE FROM routine_metrics WHERE capture_time < ?", [cutoff]);
	});
	tx();
	return { rolledUp, deleted: rows.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/baselines.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle test/lifecycle`

```bash
git add src/lifecycle/baselines.ts test/lifecycle/baselines.test.ts
git commit -m "feat(lifecycle): version-aware routine baselines with daily rollup

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 5: Evaluation — AnalysisResult + RunMetadata → transitions

**Files:**
- Create: `src/lifecycle/evaluate.ts`
- Modify: `src/types/patterns.ts` (only if the parallel phase-2 fingerprint plan has not landed yet — see Step 0)
- Modify: `src/output/types.ts` (same condition)
- Test: `test/lifecycle/evaluate.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4; `AnalysisResult` (`src/output/types.js`), `DetectedPattern` (`src/types/patterns.js`), `FusionViews`/`PrioritizedFinding` (`src/semantic/views.js` — `finding.fingerprint` is the native alsem fingerprint, `finding.detector`, `finding.severity` are strings), `FINGERPRINT_ALGO_VERSION` (`src/lifecycle/fingerprint.js`), `normalizeAppGuid` (`src/semantic/identity.js`).
- Produces:
  - `interface RunMetadata { tenant: string; stream: string; profileId: string; captureKind: "sampling" | "instrumentation"; captureTime: string; versions?: RunVersions }`
  - `interface FindingTransitionRecord { findingId: number; fingerprint: string; from: FindingState | null; to: FindingState; event: string; metricClass?: MetricClass }`
  - `interface EvaluationOutcome { runId: number; skipped?: "duplicate-run"; incomplete: boolean; findingsSeen: number; unfingerprinted: number; transitions: FindingTransitionRecord[] }`
  - `function evaluateRun(store: LifecycleStore, result: AnalysisResult, run: RunMetadata, configPatch?: Partial<LifecycleConfig>): EvaluationOutcome`

- [ ] **Step 0: Verify the phase-2 fingerprint fields exist**

Run: `grep -n "fingerprint" src/types/patterns.ts src/output/types.ts`

If `fingerprint?: string` is already on `DetectedPattern` and `fingerprintAlgoVersion?: number` on `AnalysisResult["meta"]`, skip to Step 1. Otherwise add them now (this is idempotent with the phase-2 plan — same field names, same doc intent):

In `src/types/patterns.ts`, add to `DetectedPattern` after `savingsExplanation`:

```typescript
	/**
	 * Canonical lifecycle fingerprint ("pattern:<16hex>" string form) — minted
	 * by the phase-2 fingerprint wiring. Absent when fingerprinting didn't run.
	 */
	fingerprint?: string;
```

In `src/output/types.ts`, add to `AnalysisResult["meta"]` after `incompleteInvocations`:

```typescript
		/** FINGERPRINT_ALGO_VERSION in effect when pattern fingerprints were minted. */
		fingerprintAlgoVersion?: number;
```

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/evaluate.test.ts`:

```typescript
/**
 * evaluate.test.ts — lifecycle evaluation scenarios (spec §4):
 * first-seen, idempotent re-processing per (fingerprint, profileId),
 * compatible-absence counting (kind/stream/app guards), resolve after N,
 * reopen-after-resolved, fresh-filing after closed, event-time replay
 * guard, incomplete-capture exclusion, baseline-driven regression.
 */

import { describe, expect, it } from "bun:test";
import { evaluateRun, type RunMetadata } from "../../src/lifecycle/evaluate.js";
import { LifecycleStore } from "../../src/lifecycle/store.js";
import type { AnalysisResult } from "../../src/output/types.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const FP = "pattern:deadbeef00000001";

function makeMethod(overrides?: Partial<MethodBreakdown>): MethodBreakdown {
	return {
		functionName: "PostOrder",
		objectType: "codeunit",
		objectName: "Order Post",
		objectId: 50100,
		appName: "My App",
		appId: "abc123",
		selfTime: 1_000_000,
		selfTimePercent: 50,
		totalTime: 1_200_000,
		totalTimePercent: 60,
		hitCount: 10,
		calledBy: [],
		calls: [],
		costPerHit: 100_000,
		efficiencyScore: 0.8,
		...overrides,
	};
}

function makePattern(overrides?: Partial<DetectedPattern>): DetectedPattern {
	return {
		id: "calcfields-in-loop",
		severity: "warning",
		title: "CalcFields inside loop",
		description: "d",
		impact: 500_000,
		involvedMethods: ["PostOrder (codeunit 50100)"],
		evidence: "e",
		fingerprint: FP,
		...overrides,
	};
}

function makeResult(args?: {
	patterns?: DetectedPattern[];
	methods?: MethodBreakdown[];
	incompleteInvocations?: number;
}): AnalysisResult {
	const methods = args?.methods ?? [makeMethod()];
	return {
		meta: {
			profilePath: "p.alcpuprofile",
			profileType: "sampling",
			totalDuration: 2_000_000,
			totalSelfTime: 2_000_000,
			idleSelfTime: 0,
			totalNodes: 10,
			maxDepth: 3,
			incompleteInvocations: args?.incompleteInvocations,
			sourceAvailable: false,
			confidenceScore: 90,
			confidenceFactors: {
				sampleCount: { value: 100, score: 90 },
				duration: { value: 2_000_000, score: 90 },
				incompleteMeasurements: { value: 0, score: 100 },
			},
			analyzedAt: "2026-07-01T10:00:00Z",
		},
		summary: {
			oneLiner: "x",
			topApp: null,
			topMethod: null,
			patternCount: { critical: 0, warning: 1, info: 0 },
			healthScore: 80,
		},
		criticalPath: [],
		hotspots: methods,
		patterns: args?.patterns ?? [makePattern()],
		appBreakdown: [],
		objectBreakdown: [
			{
				objectType: "codeunit",
				objectName: "Order Post",
				objectId: 50100,
				appName: "My App",
				selfTime: 1_000_000,
				selfTimePercent: 50,
				totalTime: 1_200_000,
				methodCount: methods.length,
				methods,
			},
		],
	};
}

function makeRun(overrides?: Partial<RunMetadata>): RunMetadata {
	return {
		tenant: "t1",
		stream: "nightly",
		profileId: `p-${Math.random().toString(36).slice(2)}`,
		captureKind: "sampling",
		captureTime: "2026-07-01T10:00:00Z",
		...overrides,
	};
}

// Small config so absence scenarios stay short.
const CFG = { resolveAfterRuns: 2, baselineMinRuns: 2, baselineWindow: 10 };

describe("evaluateRun — presence", () => {
	it("first observation creates a NEW finding with an occurrence and event", () => {
		const store = new LifecycleStore(":memory:");
		const outcome = evaluateRun(store, makeResult(), makeRun({ profileId: "p1" }), CFG);
		expect(outcome.transitions).toEqual([
			expect.objectContaining({ fingerprint: FP, from: null, to: "new", event: "first-seen" }),
		]);
		const row = store.getActiveFinding("t1", FP);
		expect(row?.state).toBe("new");
		expect(row?.observedKinds).toEqual(["sampling"]);
		expect(store.countOccurrences(row?.id ?? -1)).toBe(1);
		store.close();
	});

	it("is idempotent per (fingerprint, profileId): re-processing the same profile is a no-op", () => {
		const store = new LifecycleStore(":memory:");
		const run = makeRun({ profileId: "p1" });
		evaluateRun(store, makeResult(), run, CFG);
		const second = evaluateRun(store, makeResult(), run, CFG);
		expect(second.skipped).toBe("duplicate-run");
		expect(second.transitions).toEqual([]);
		expect(store.countOccurrences(store.getActiveFinding("t1", FP)?.id ?? -1)).toBe(1);
		store.close();
	});

	it("second observation moves new → open", () => {
		const store = new LifecycleStore(":memory:");
		evaluateRun(store, makeResult(), makeRun({ profileId: "p1", captureTime: "2026-07-01T10:00:00Z" }), CFG);
		const o = evaluateRun(store, makeResult(), makeRun({ profileId: "p2", captureTime: "2026-07-02T10:00:00Z" }), CFG);
		expect(o.transitions[0]).toEqual(
			expect.objectContaining({ from: "new", to: "open", event: "seen-normal" }),
		);
		store.close();
	});

	it("unfingerprinted patterns are counted and skipped, not crashed on", () => {
		const store = new LifecycleStore(":memory:");
		const result = makeResult({
			patterns: [makePattern({ fingerprint: undefined })],
		});
		const o = evaluateRun(store, result, makeRun(), CFG);
		expect(o.unfingerprinted).toBe(1);
		expect(o.findingsSeen).toBe(0);
		store.close();
	});
});

describe("evaluateRun — absence and resolution", () => {
	function seedOpenFinding(store: LifecycleStore) {
		evaluateRun(store, makeResult(), makeRun({ profileId: "p1", captureTime: "2026-07-01T10:00:00Z" }), CFG);
		evaluateRun(store, makeResult(), makeRun({ profileId: "p2", captureTime: "2026-07-02T10:00:00Z" }), CFG);
	}
	const emptyResult = () => makeResult({ patterns: [] });

	it("resolves after N consecutive compatible absences", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		evaluateRun(store, emptyResult(), makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }), CFG);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(1);
		const o = evaluateRun(store, emptyResult(), makeRun({ profileId: "p4", captureTime: "2026-07-04T10:00:00Z" }), CFG);
		const row = store.getActiveFinding("t1", FP);
		expect(row?.state).toBe("resolved");
		expect(row?.resolvedAt).toBe("2026-07-04T10:00:00Z");
		expect(o.transitions[0]?.event).toBe("resolved");
		store.close();
	});

	it("an observation resets the absence counter", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		evaluateRun(store, emptyResult(), makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }), CFG);
		evaluateRun(store, makeResult(), makeRun({ profileId: "p4", captureTime: "2026-07-04T10:00:00Z" }), CFG);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		store.close();
	});

	it("incompatible capture kind never counts absence (sampling finding vs instrumentation run)", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		evaluateRun(store, emptyResult(), makeRun({ profileId: "p3", captureKind: "instrumentation", captureTime: "2026-07-03T10:00:00Z" }), CFG);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		store.close();
	});

	it("a different stream never counts absence", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		evaluateRun(store, emptyResult(), makeRun({ profileId: "p3", stream: "weekly", captureTime: "2026-07-03T10:00:00Z" }), CFG);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		store.close();
	});

	it("a run that did not exercise the finding's app never counts absence", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		const otherApp = makeResult({
			patterns: [],
			methods: [makeMethod({ appId: "ffff99", appName: "Other App", functionName: "Run", objectId: 60000 })],
		});
		evaluateRun(store, otherApp, makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }), CFG);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		store.close();
	});

	it("incomplete captures are excluded from run-counting (no absence, no metrics)", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		const incomplete = makeResult({ patterns: [], incompleteInvocations: 2 });
		const o = evaluateRun(store, incomplete, makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }), CFG);
		expect(o.incomplete).toBe(true);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		const metricRows = store.db
			.query<{ n: number }, [string]>(
				"SELECT count(*) AS n FROM routine_metrics WHERE profile_id = ?",
			)
			.get("p3");
		expect(metricRows?.n).toBe(0);
		store.close();
	});

	it("a late-arriving OLD run records history but never drives state (event-time replay guard)", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		// Old empty run, captured BEFORE the finding was last seen.
		evaluateRun(store, emptyResult(), makeRun({ profileId: "p0", captureTime: "2026-06-01T10:00:00Z" }), CFG);
		const row = store.getActiveFinding("t1", FP);
		expect(row?.state).toBe("open");
		expect(row?.absenceCount).toBe(0);
		store.close();
	});
});

describe("evaluateRun — reopen and fresh-filing", () => {
	function resolveFinding(store: LifecycleStore) {
		evaluateRun(store, makeResult(), makeRun({ profileId: "p1", captureTime: "2026-07-01T10:00:00Z" }), CFG);
		evaluateRun(store, makeResult(), makeRun({ profileId: "p2", captureTime: "2026-07-02T10:00:00Z" }), CFG);
		evaluateRun(store, makeResult({ patterns: [] }), makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }), CFG);
		evaluateRun(store, makeResult({ patterns: [] }), makeRun({ profileId: "p4", captureTime: "2026-07-04T10:00:00Z" }), CFG);
	}

	it("re-appearance after resolved reopens (→ regressed) WITH history", () => {
		const store = new LifecycleStore(":memory:");
		resolveFinding(store);
		const o = evaluateRun(store, makeResult(), makeRun({ profileId: "p5", captureTime: "2026-07-05T10:00:00Z" }), CFG);
		expect(o.transitions[0]).toEqual(
			expect.objectContaining({ from: "resolved", to: "regressed", event: "reopened" }),
		);
		const row = store.getActiveFinding("t1", FP);
		expect(row?.resolvedAt).toBeNull();
		expect(store.countOccurrences(row?.id ?? -1)).toBe(3); // history retained
		store.close();
	});

	it("re-appearance after CLOSED files a fresh finding with a supersedes link and needs-triage", () => {
		const store = new LifecycleStore(":memory:");
		resolveFinding(store);
		const resolved = store.getActiveFinding("t1", FP);
		store.updateFindingState(resolved?.id ?? -1, { state: "closed", closedAt: "2026-07-05T00:00:00Z" });
		const o = evaluateRun(store, makeResult(), makeRun({ profileId: "p6", captureTime: "2026-07-06T10:00:00Z" }), CFG);
		expect(o.transitions[0]?.event).toBe("filed-fresh");
		const fresh = store.getActiveFinding("t1", FP);
		expect(fresh?.id).not.toBe(resolved?.id);
		expect(fresh?.state).toBe("new");
		expect(fresh?.needsTriage).toBe(true);
		expect(fresh?.supersedes).toBe(resolved?.id ?? -1);
		store.close();
	});
});

describe("evaluateRun — baseline-driven regression", () => {
	it("a stable finding whose routine blows past its baseline goes to regressed", () => {
		const store = new LifecycleStore(":memory:");
		const at = (d: number) => `2026-07-0${d}T10:00:00Z`;
		for (let d = 1; d <= 3; d++) {
			evaluateRun(store, makeResult(), makeRun({ profileId: `p${d}`, captureTime: at(d) }), CFG);
		}
		const slow = makeResult({ methods: [makeMethod({ selfTime: 9_000_000 })] });
		const o = evaluateRun(store, slow, makeRun({ profileId: "p9", captureTime: at(4) }), CFG);
		expect(o.transitions[0]).toEqual(
			expect.objectContaining({ to: "regressed", event: "seen-regressed", metricClass: "regressed" }),
		);
		store.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/evaluate.test.ts`
Expected: FAIL — `Cannot find module '../../src/lifecycle/evaluate.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lifecycle/evaluate.ts`:

```typescript
/**
 * evaluate.ts — turn (AnalysisResult, RunMetadata) into lifecycle state
 * (umbrella spec §4). The orchestration layer over the pure state machine
 * (states.ts), the store (store.ts), and the baselines (baselines.ts).
 *
 * Invariants enforced here:
 *  - Keyed to CAPTURE time (event time), never processing time.
 *  - Idempotent per (fingerprint, profileId): a duplicate run is a no-op;
 *    a late-arriving OLD run records occurrences but never drives state.
 *  - Incomplete captures (meta.incompleteInvocations > 0) process the
 *    presence side only: no absence counting, no baseline rows, and their
 *    metric qualifier is forced to "normal".
 *  - Absence compatibility: same stream + previously-observed capture kind
 *    + the run exercised the finding's app (plan D4/D7).
 *
 * Fingerprints are CONSUMED, never minted here — patterns carry
 * `fingerprint` from the phase-2 wiring; fusion findings carry the native
 * alsem fingerprint which is namespaced as `alsem:<native>`.
 */

import type { AnalysisResult } from "../output/types.js";
import { normalizeAppGuid } from "../semantic/identity.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import {
	classifyObservation,
	computeBaseline,
	type MetricClass,
	recordRoutineMetrics,
	routineKeyFor,
	type RunVersions,
	versionStampFrom,
} from "./baselines.js";
import { DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from "./config.js";
import { FINGERPRINT_ALGO_VERSION } from "./fingerprint.js";
import { type FindingState, type SeenQualifier, transition } from "./states.js";
import type {
	ExercisedApps,
	FindingRow,
	FindingSeverity,
	FindingSource,
	LifecycleStore,
} from "./store.js";

export interface RunMetadata {
	/** Tenant key (CLI default "local"; web: the authenticated tenant code). */
	tenant: string;
	/** Capture stream — schedule/job id; "adhoc" when uncorrelated (spec: "Run" = same (tenant, schedule/job) stream). */
	stream: string;
	/** Idempotency key: ingest activityId, or a content hash for CLI files. */
	profileId: string;
	captureKind: "sampling" | "instrumentation";
	/** Profile CAPTURE time (ISO 8601) — the event time all state is keyed to. */
	captureTime: string;
	versions?: RunVersions;
}

export interface FindingTransitionRecord {
	findingId: number;
	fingerprint: string;
	from: FindingState | null;
	to: FindingState;
	event: string;
	metricClass?: MetricClass;
}

export interface EvaluationOutcome {
	runId: number;
	skipped?: "duplicate-run";
	incomplete: boolean;
	findingsSeen: number;
	unfingerprinted: number;
	transitions: FindingTransitionRecord[];
}

interface CollectedFinding {
	fingerprint: string;
	algoVersion: number;
	source: FindingSource;
	patternId: string;
	title: string;
	severity: FindingSeverity;
	appId: string;
	appName: string;
	routineKey: string;
	metricValue: number;
	impact: number;
	details: string;
}

/** "FunctionName (ObjectType ObjectId)" — the involvedMethods display form. */
const INVOLVED_METHOD_RE = /^(.+) \((\w+) (\d+)\)$/;

function buildMethodIndex(result: AnalysisResult): Map<string, MethodBreakdown> {
	const map = new Map<string, MethodBreakdown>();
	const all = [
		...result.objectBreakdown.flatMap((o) => o.methods),
		...result.hotspots,
	];
	for (const m of all) {
		const key = `${m.objectType}:${m.objectId}:${m.functionName}`.toLowerCase();
		if (!map.has(key)) map.set(key, m);
	}
	return map;
}

function exercisedAppsOf(methods: Iterable<MethodBreakdown>): ExercisedApps {
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const m of methods) {
		const id = normalizeAppGuid(m.appId);
		if (id) ids.add(id);
		if (m.appName) names.add(m.appName.toLowerCase());
	}
	return { ids: [...ids], names: [...names] };
}

function appWasExercised(row: FindingRow, exercised: ExercisedApps): boolean {
	if (row.appId) return exercised.ids.includes(row.appId);
	if (row.appName) return exercised.names.includes(row.appName.toLowerCase());
	return true; // unknown app: treated as exercised (plan D7)
}

function alsemSeverity(s: string): FindingSeverity {
	const v = s.toLowerCase();
	if (v === "error" || v === "critical") return "critical";
	if (v === "warning") return "warning";
	return "info";
}

function sourceOf(fingerprint: string): FindingSource {
	const ns = fingerprint.split(":", 1)[0];
	return ns === "alsem" || ns === "telemetry" ? ns : "pattern";
}

function collectFindings(
	result: AnalysisResult,
	index: Map<string, MethodBreakdown>,
): { collected: CollectedFinding[]; unfingerprinted: number } {
	const byFingerprint = new Map<string, CollectedFinding>();
	let unfingerprinted = 0;
	const algoVersion =
		result.meta.fingerprintAlgoVersion ?? FINGERPRINT_ALGO_VERSION;

	for (const p of result.patterns) {
		if (!p.fingerprint) {
			unfingerprinted++;
			continue;
		}
		const match = p.involvedMethods[0]?.match(INVOLVED_METHOD_RE);
		const method = match
			? index.get(`${match[2]}:${match[3]}:${match[1]}`.toLowerCase())
			: undefined;
		const entry: CollectedFinding = {
			fingerprint: p.fingerprint,
			algoVersion,
			source: sourceOf(p.fingerprint),
			patternId: p.id,
			title: p.title,
			severity: p.severity,
			appId: normalizeAppGuid(method?.appId),
			appName: method?.appName ?? "",
			routineKey: method ? routineKeyFor(method) : "",
			metricValue: method?.selfTime ?? p.impact,
			impact: p.impact,
			details: JSON.stringify({ evidence: p.evidence, suggestion: p.suggestion }),
		};
		if (!byFingerprint.has(entry.fingerprint)) {
			byFingerprint.set(entry.fingerprint, entry);
		}
	}

	const fv = result.fusionViews;
	if (fv) {
		for (const pf of [...fv.prioritizedFindings, ...fv.unweightedFindings]) {
			const native = pf.finding.fingerprint;
			if (!native) {
				unfingerprinted++;
				continue;
			}
			const key = `${pf.objectType}:${pf.objectId}:${pf.functionName}`.toLowerCase();
			const method = index.get(key);
			const entry: CollectedFinding = {
				fingerprint: `alsem:${native}`,
				algoVersion,
				source: "alsem",
				patternId: pf.finding.detector,
				title: pf.finding.title,
				severity: alsemSeverity(pf.finding.severity),
				appId: normalizeAppGuid(method?.appId),
				appName: pf.appName || (method?.appName ?? ""),
				routineKey: method ? routineKeyFor(method) : "",
				metricValue: method?.selfTime ?? 0,
				impact: method?.selfTime ?? 0,
				details: JSON.stringify({ rootCause: pf.finding.rootCause }),
			};
			if (!byFingerprint.has(entry.fingerprint)) {
				byFingerprint.set(entry.fingerprint, entry);
			}
		}
	}

	return { collected: [...byFingerprint.values()], unfingerprinted };
}

> **AMENDMENT (post-T5-review, 2026-07-10):** This sketch has a hole in the
> `!active` branch below: when `getLatestClosedFinding` returns a row, it
> files a fresh finding UNCONDITIONALLY — including when `run.captureTime`
> is a stale backfill no newer than the closed row's `lastEventAt`. That's a
> late old run driving state (filing a brand-new active row), the exact
> thing the seen/absence replay guards elsewhere in this sketch exist to
> prevent. The fix: before filing fresh, check
> `if (closed && run.captureTime <= closed.lastEventAt)` — record an
> occurrence against `closed.id` and `continue`, do not file. The shipped
> implementation (`src/lifecycle/evaluate.ts`) also wraps the whole per-run
> write path (`recordRun` through the absence pass) in one enclosing
> `store.db.transaction()` (this sketch's per-pair transactions become
> nested savepoints) and canonicalizes `run.captureTime` to UTC on entry —
> neither is reflected in the code below; treat this sketch as historical
> intent, not the final shape.

export function evaluateRun(
	store: LifecycleStore,
	result: AnalysisResult,
	run: RunMetadata,
	configPatch?: Partial<LifecycleConfig>,
): EvaluationOutcome {
	const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, ...configPatch };
	const incomplete = (result.meta.incompleteInvocations ?? 0) > 0;
	const index = buildMethodIndex(result);
	const exercised = exercisedAppsOf(index.values());
	const stamp = versionStampFrom(run.versions);

	const rec = store.recordRun({
		tenant: run.tenant,
		stream: run.stream,
		profileId: run.profileId,
		captureKind: run.captureKind,
		captureTime: run.captureTime,
		versionStamp: stamp,
		incomplete,
		exercisedApps: exercised,
	});
	if (rec.duplicate) {
		return {
			runId: rec.runId,
			skipped: "duplicate-run",
			incomplete,
			findingsSeen: 0,
			unfingerprinted: 0,
			transitions: [],
		};
	}

	if (!incomplete) {
		recordRoutineMetrics(
			store,
			{
				tenant: run.tenant,
				stream: run.stream,
				captureKind: run.captureKind,
				profileId: run.profileId,
				captureTime: run.captureTime,
				versionStamp: stamp,
			},
			[...index.values()],
			cfg.routineMetricsPerRunCap,
		);
	}

	const { collected, unfingerprinted } = collectFindings(result, index);
	const transitions: FindingTransitionRecord[] = [];
	const seenIds = new Set<number>();

	for (const f of collected) {
		const active = store.getActiveFinding(run.tenant, f.fingerprint);
		if (!active) {
			const closed = store.getLatestClosedFinding(run.tenant, f.fingerprint);
			const id = store.insertFinding({
				tenant: run.tenant,
				fingerprint: f.fingerprint,
				algoVersion: f.algoVersion,
				state: "new",
				source: f.source,
				patternId: f.patternId,
				title: f.title,
				severity: f.severity,
				appId: f.appId,
				appName: f.appName,
				routineKey: f.routineKey,
				firstSeenAt: run.captureTime,
				lastSeenAt: run.captureTime,
				lastEventAt: run.captureTime,
				observedKinds: [run.captureKind],
				observedStreams: [run.stream],
				needsTriage: closed !== null,
				supersedes: closed?.id,
			});
			store.recordOccurrence({
				findingId: id,
				runId: rec.runId,
				captureTime: run.captureTime,
				severity: f.severity,
				impact: f.impact,
				metricValue: f.metricValue,
				metricClass: "no-baseline",
				details: f.details,
			});
			const event = closed ? "filed-fresh" : "first-seen";
			store.logEvent({
				findingId: id,
				runId: rec.runId,
				event,
				fromState: null,
				toState: "new",
				at: run.captureTime,
				detail: closed ? JSON.stringify({ supersedes: closed.id }) : undefined,
			});
			transitions.push({
				findingId: id,
				fingerprint: f.fingerprint,
				from: null,
				to: "new",
				event,
				metricClass: "no-baseline",
			});
			seenIds.add(id);
			continue;
		}

		seenIds.add(active.id);
		let metricClass: MetricClass = "no-baseline";
		let qualifier: SeenQualifier = "normal";
		if (!incomplete && f.routineKey) {
			const baseline = computeBaseline(
				store,
				{
					tenant: run.tenant,
					stream: run.stream,
					captureKind: run.captureKind,
					routineKey: f.routineKey,
				},
				run.captureTime,
				cfg.baselineWindow,
			);
			metricClass = classifyObservation(f.metricValue, baseline, stamp, cfg);
			if (metricClass === "regressed") qualifier = "regressed";
			else if (metricClass === "improved") qualifier = "improved";
		}

		const inserted = store.recordOccurrence({
			findingId: active.id,
			runId: rec.runId,
			captureTime: run.captureTime,
			severity: f.severity,
			impact: f.impact,
			metricValue: f.metricValue,
			metricClass,
			details: f.details,
		});
		if (!inserted) continue; // already counted for this profile (idempotency)
		if (run.captureTime <= active.lastEventAt) continue; // replay guard (D5)

		const res = transition(
			active.state,
			{ type: "seen", qualifier },
			{ absenceCount: active.absenceCount, resolveAfterRuns: cfg.resolveAfterRuns },
		);
		if (!res.ok) continue; // seen is always valid; defensive
		store.markSeen(active.id, {
			state: res.next,
			severity: f.severity,
			captureTime: run.captureTime,
			captureKind: run.captureKind,
			stream: run.stream,
		});
		if (res.next !== active.state || res.effects.includes("reopen")) {
			const event = res.effects.includes("reopen")
				? "reopened"
				: `seen-${qualifier}`;
			store.logEvent({
				findingId: active.id,
				runId: rec.runId,
				event,
				fromState: active.state,
				toState: res.next,
				at: run.captureTime,
				detail: JSON.stringify({ metricClass }),
			});
			transitions.push({
				findingId: active.id,
				fingerprint: f.fingerprint,
				from: active.state,
				to: res.next,
				event,
				metricClass,
			});
		}
	}

	// Absence pass — incomplete captures are excluded from run-counting (D6).
	if (!incomplete) {
		for (const row of store.listAbsenceCandidates(run.tenant)) {
			if (seenIds.has(row.id)) continue;
			if (run.captureTime <= row.lastEventAt) continue; // replay guard
			if (!row.observedStreams.includes(run.stream)) continue;
			if (!row.observedKinds.includes(run.captureKind)) continue;
			if (!appWasExercised(row, exercised)) continue;
			const newCount = row.absenceCount + 1;
			const res = transition(
				row.state,
				{ type: "absent" },
				{ absenceCount: newCount, resolveAfterRuns: cfg.resolveAfterRuns },
			);
			if (!res.ok) continue;
			store.markAbsent(row.id, {
				state: res.next,
				absenceCount: newCount,
				captureTime: run.captureTime,
			});
			if (res.next !== row.state) {
				store.logEvent({
					findingId: row.id,
					runId: rec.runId,
					event: "resolved",
					fromState: row.state,
					toState: res.next,
					at: run.captureTime,
					detail: JSON.stringify({ absentRuns: newCount }),
				});
				transitions.push({
					findingId: row.id,
					fingerprint: row.fingerprint,
					from: row.state,
					to: res.next,
					event: "resolved",
				});
			}
		}
	}

	return {
		runId: rec.runId,
		incomplete,
		findingsSeen: collected.length,
		unfingerprinted,
		transitions,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/evaluate.test.ts`
Expected: PASS — all scenario groups.

- [ ] **Step 5: Run the full lifecycle suite + type-check, format, commit**

Run: `AI_DISABLED=1 bun test test/lifecycle && bunx tsc --noEmit && bunx biome check --write src/lifecycle src/types src/output test/lifecycle`

```bash
git add src/lifecycle/evaluate.ts test/lifecycle/evaluate.test.ts src/types/patterns.ts src/output/types.ts
git commit -m "feat(lifecycle): event-time-keyed run evaluation with idempotent occurrences

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 6: Fingerprint migration application (algo/identity upgrades, manual merges)

**Files:**
- Modify: `src/lifecycle/store.ts` (add one method + import)
- Test: `test/lifecycle/migrations.test.ts`

**Interfaces:**
- Consumes: `FingerprintMigration`, `formatFingerprint` from `src/lifecycle/fingerprint.js` (landed contract — `linkFingerprints` builds the records; this task only APPLIES them); store CRUD (Task 3).
- Produces:
  - `LifecycleStore.applyFingerprintMigration(tenant: string, migration: FingerprintMigration, appliedAt: string): "renamed" | "merged" | "no-op"`

Semantics (spec §4: "`fingerprintAlgoVersion` is stored per finding; FingerprintMigration records applied via a migration table"):
- Idempotent: the migration is recorded in `fingerprint_migrations` with `INSERT OR IGNORE`; a previously applied (tenant, from, to) pair returns `"no-op"` without touching findings.
- No active `from` finding → `"no-op"` (record still written so re-runs stay idempotent).
- Active `from`, no active `to` → **rename**: the finding row's `fingerprint` and `algo_version` are rewritten in place; a `migrated` event is logged with `detail` containing `"viaMigration": true` (Plan B's sink triggers skip these — mass-transition guard, plan D15).
- Active `from` AND active `to` → **merge**: occurrences and events move to the `to` row (`INSERT OR IGNORE` semantics on the occurrence PK — colliding runs keep the `to` row's occurrence), observed kinds/streams union, `first_seen_at` takes the earlier value, then the `from` row is closed (`state='closed'`, `closed_at=appliedAt`) with a `merged` event (also `"viaMigration": true`).

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/migrations.test.ts`:

```typescript
/**
 * migrations.test.ts — applying FingerprintMigration records to the store:
 * rename (identity-upgrade), merge (both identities active), idempotency.
 */

import { describe, expect, it } from "bun:test";
import { linkFingerprints } from "../../src/lifecycle/fingerprint.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";

const OLD = { value: "fallbackhash00001", namespace: "pattern" as const, algoVersion: 1 };
const NEW = { value: "stablehash000001", namespace: "pattern" as const, algoVersion: 1 };
const MIGRATION = linkFingerprints(OLD, NEW, "identity-upgrade");

function finding(fingerprint: string, overrides?: Partial<NewFinding>): NewFinding {
	return {
		tenant: "t1",
		fingerprint,
		algoVersion: 1,
		state: "open",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "x",
		severity: "warning",
		appId: "",
		appName: "",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-01T00:00:00Z",
		lastEventAt: "2026-07-01T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
		...overrides,
	};
}

describe("applyFingerprintMigration", () => {
	it("renames a lone active finding in place and logs a viaMigration event", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(finding("pattern:fallbackhash00001"));
		const outcome = store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z");
		expect(outcome).toBe("renamed");
		expect(store.getActiveFinding("t1", "pattern:fallbackhash00001")).toBeNull();
		expect(store.getActiveFinding("t1", "pattern:stablehash000001")?.id).toBe(id);
		const events = store.listEvents(id);
		expect(events[events.length - 1]?.event).toBe("migrated");
		expect(events[events.length - 1]?.detail).toContain("viaMigration");
		store.close();
	});

	it("merges when both identities are active: history moves, old row closes", () => {
		const store = new LifecycleStore(":memory:");
		const oldId = store.insertFinding(
			finding("pattern:fallbackhash00001", { firstSeenAt: "2026-06-01T00:00:00Z" }),
		);
		const newId = store.insertFinding(finding("pattern:stablehash000001"));
		const { runId } = store.recordRun({
			tenant: "t1",
			stream: "nightly",
			profileId: "p-old",
			captureKind: "sampling",
			captureTime: "2026-06-01T00:00:00Z",
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: [], names: [] },
		});
		store.recordOccurrence({
			findingId: oldId,
			runId,
			captureTime: "2026-06-01T00:00:00Z",
			severity: "warning",
		});
		const outcome = store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z");
		expect(outcome).toBe("merged");
		const merged = store.getActiveFinding("t1", "pattern:stablehash000001");
		expect(merged?.id).toBe(newId);
		expect(merged?.firstSeenAt).toBe("2026-06-01T00:00:00Z"); // earlier wins
		expect(store.countOccurrences(newId)).toBe(1); // moved
		expect(store.getFinding(oldId)?.state).toBe("closed");
		store.close();
	});

	it("is idempotent: a second application is a no-op", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(finding("pattern:fallbackhash00001"));
		expect(store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z")).toBe("renamed");
		expect(store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z")).toBe("no-op");
		store.close();
	});

	it("no active from-finding is a recorded no-op", () => {
		const store = new LifecycleStore(":memory:");
		expect(store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z")).toBe("no-op");
		const row = store.db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM fingerprint_migrations")
			.get();
		expect(row?.n).toBe(1);
		store.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/migrations.test.ts`
Expected: FAIL — `applyFingerprintMigration is not a function`

- [ ] **Step 3: Write the implementation**

In `src/lifecycle/store.ts`, add to the imports:

```typescript
import {
	type FingerprintMigration,
	formatFingerprint,
} from "./fingerprint.js";
```

Add this method to `LifecycleStore` (after `listEvents`):

```typescript
	/**
	 * Apply one FingerprintMigration (spec §4). Idempotent via the
	 * fingerprint_migrations table. Events are logged with viaMigration:true
	 * so sink triggers can guard against mass state transitions caused by an
	 * algorithm change.
	 */
	applyFingerprintMigration(
		tenant: string,
		migration: FingerprintMigration,
		appliedAt: string,
	): "renamed" | "merged" | "no-op" {
		const from = formatFingerprint(migration.from);
		const to = formatFingerprint(migration.to);
		const recorded = this.db.run(
			`INSERT OR IGNORE INTO fingerprint_migrations (tenant, from_fingerprint, to_fingerprint, reason, applied_at)
			 VALUES (?, ?, ?, ?, ?)`,
			[tenant, from, to, migration.reason, appliedAt],
		);
		if (recorded.changes === 0) return "no-op"; // already applied

		const fromRow = this.getActiveFinding(tenant, from);
		if (!fromRow) return "no-op";
		const toRow = this.getActiveFinding(tenant, to);
		const detail = JSON.stringify({
			viaMigration: true,
			from,
			to,
			reason: migration.reason,
		});

		if (!toRow) {
			const rename = this.db.transaction(() => {
				this.db.run(
					"UPDATE findings SET fingerprint = ?, algo_version = ? WHERE id = ?",
					[to, migration.to.algoVersion, fromRow.id],
				);
				this.logEvent({
					findingId: fromRow.id,
					event: "migrated",
					fromState: fromRow.state,
					toState: fromRow.state,
					at: appliedAt,
					detail,
				});
			});
			rename();
			return "renamed";
		}

		const merge = this.db.transaction(() => {
			// Move history; a run present on both sides keeps the to-row's
			// occurrence (INSERT OR IGNORE semantics via UPDATE OR IGNORE).
			this.db.run(
				"UPDATE OR IGNORE occurrences SET finding_id = ? WHERE finding_id = ?",
				[toRow.id, fromRow.id],
			);
			this.db.run("DELETE FROM occurrences WHERE finding_id = ?", [fromRow.id]);
			this.db.run("UPDATE finding_events SET finding_id = ? WHERE finding_id = ?", [
				toRow.id,
				fromRow.id,
			]);
			const kinds = [...new Set([...toRow.observedKinds, ...fromRow.observedKinds])];
			const streams = [
				...new Set([...toRow.observedStreams, ...fromRow.observedStreams]),
			];
			this.db.run(
				`UPDATE findings SET first_seen_at = min(first_seen_at, ?), observed_kinds = ?, observed_streams = ? WHERE id = ?`,
				[fromRow.firstSeenAt, JSON.stringify(kinds), JSON.stringify(streams), toRow.id],
			);
			this.db.run(
				"UPDATE findings SET state = 'closed', closed_at = ? WHERE id = ?",
				[appliedAt, fromRow.id],
			);
			this.logEvent({
				findingId: toRow.id,
				event: "merged",
				fromState: toRow.state,
				toState: toRow.state,
				at: appliedAt,
				detail,
			});
		});
		merge();
		return "merged";
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle test/lifecycle`

```bash
git add src/lifecycle/store.ts test/lifecycle/migrations.test.ts
git commit -m "feat(lifecycle): apply fingerprint migrations (rename/merge) idempotently

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 7: Digest — markdown + JSON

**Files:**
- Create: `src/lifecycle/digest.ts`
- Test: `test/lifecycle/digest.test.ts`

**Interfaces:**
- Consumes: store CRUD (Task 3).
- Produces (the JSON shape is the CONTRACT for Plan B's `gh` recipe — do not rename fields later without updating `docs/lifecycle-gh-recipe.md`):
  - `interface DigestOptions { tenant?: string; since?: string; now?: string; limit?: number }`
  - `interface DigestFindingEntry { fingerprint: string; title: string; severity: string; state: string; needsTriage: boolean; appName: string; patternId: string; firstSeenAt: string; lastSeenAt: string; occurrenceCount: number; lastEvent: string | null }`
  - `interface DigestData { generatedAt: string; tenant: string | null; since: string | null; totals: { new: number; open: number; regressed: number; improving: number; resolved: number; closed: number; needsTriage: number }; newFindings: DigestFindingEntry[]; regressed: DigestFindingEntry[]; improving: DigestFindingEntry[]; resolved: DigestFindingEntry[]; needsTriage: DigestFindingEntry[] }`
  - `function buildDigest(store: LifecycleStore, opts?: DigestOptions): DigestData`
  - `function renderDigestMarkdown(digest: DigestData): string`

Digest posture (spec §4): the digest is the DEFAULT reporting output — auto-filing to sinks is opt-in and separate (Plan B). It is NOT an `AnalysisResult` section; formatter parity does not apply.

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/digest.test.ts`:

```typescript
/**
 * digest.test.ts — digest sections, since-filtering, totals, and the
 * markdown rendering. Findings are seeded directly through the store.
 */

import { describe, expect, it } from "bun:test";
import { buildDigest, renderDigestMarkdown } from "../../src/lifecycle/digest.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";
import type { FindingState } from "../../src/lifecycle/states.js";

let seq = 0;
function seed(store: LifecycleStore, state: FindingState, overrides?: Partial<NewFinding>): number {
	seq++;
	return store.insertFinding({
		tenant: "t1",
		fingerprint: `pattern:fp${String(seq).padStart(12, "0")}`,
		algoVersion: 1,
		state,
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: `Finding ${seq}`,
		severity: "warning",
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

describe("buildDigest", () => {
	it("sections findings by state and counts totals + needs-triage", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "new");
		seed(store, "open");
		seed(store, "regressed");
		seed(store, "improving");
		const resolvedId = seed(store, "resolved");
		store.db.run("UPDATE findings SET resolved_at = '2026-07-05T00:00:00Z' WHERE id = ?", [resolvedId]);
		const triageId = seed(store, "open", { needsTriage: true });
		const digest = buildDigest(store, { tenant: "t1", now: "2026-07-09T00:00:00Z" });
		expect(digest.totals).toEqual({
			new: 1,
			open: 2,
			regressed: 1,
			improving: 1,
			resolved: 1,
			closed: 0,
			needsTriage: 1,
		});
		expect(digest.newFindings).toHaveLength(1);
		expect(digest.regressed).toHaveLength(1);
		expect(digest.improving).toHaveLength(1);
		expect(digest.resolved).toHaveLength(1);
		expect(digest.needsTriage[0]?.fingerprint).toBe(
			store.getFinding(triageId)?.fingerprint,
		);
		store.close();
	});

	it("since filters sections by their relevant timestamp", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "new", { firstSeenAt: "2026-06-01T00:00:00Z" }); // old — excluded
		seed(store, "new", { firstSeenAt: "2026-07-08T00:00:00Z" });
		const resolvedOld = seed(store, "resolved");
		store.db.run("UPDATE findings SET resolved_at = '2026-06-01T00:00:00Z' WHERE id = ?", [resolvedOld]);
		const digest = buildDigest(store, { tenant: "t1", since: "2026-07-01T00:00:00Z" });
		expect(digest.newFindings).toHaveLength(1);
		expect(digest.resolved).toHaveLength(0);
		// Totals stay unfiltered (current inventory, not deltas).
		expect(digest.totals.new).toBe(2);
		store.close();
	});
});

describe("renderDigestMarkdown", () => {
	it("renders headers, counts, and finding lines", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "regressed", { title: "CalcFields storm", severity: "critical" });
		const md = renderDigestMarkdown(buildDigest(store, { tenant: "t1" }));
		expect(md).toContain("# al-perf Finding Digest");
		expect(md).toContain("## Regressed");
		expect(md).toContain("CalcFields storm");
		expect(md).toContain("critical");
		expect(md).toContain("pattern:fp"); // fingerprint shown for gh-recipe dedup
		store.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/digest.test.ts`
Expected: FAIL — `Cannot find module '../../src/lifecycle/digest.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lifecycle/digest.ts`:

```typescript
/**
 * digest.ts — the digest-first reporting output (umbrella spec §4).
 *
 * buildDigest returns a stable JSON shape (DigestData) — this is the
 * contract consumed by the documented `gh issue create` recipe
 * (docs/lifecycle-gh-recipe.md, Plan B) — and renderDigestMarkdown renders
 * the human form. NOT an AnalysisResult section: formatter parity
 * deliberately does not apply.
 */

import type { FindingState } from "./states.js";
import type { FindingRow, LifecycleStore } from "./store.js";

export interface DigestOptions {
	tenant?: string;
	/** ISO timestamp — filter sections to activity at/after this time. */
	since?: string;
	/** Clock override for tests; defaults to the current time. */
	now?: string;
	/** Per-section cap (default 50). */
	limit?: number;
}

export interface DigestFindingEntry {
	fingerprint: string;
	title: string;
	severity: string;
	state: string;
	needsTriage: boolean;
	appName: string;
	patternId: string;
	firstSeenAt: string;
	lastSeenAt: string;
	occurrenceCount: number;
	lastEvent: string | null;
}

export interface DigestData {
	generatedAt: string;
	tenant: string | null;
	since: string | null;
	totals: {
		new: number;
		open: number;
		regressed: number;
		improving: number;
		resolved: number;
		closed: number;
		needsTriage: number;
	};
	newFindings: DigestFindingEntry[];
	regressed: DigestFindingEntry[];
	improving: DigestFindingEntry[];
	resolved: DigestFindingEntry[];
	needsTriage: DigestFindingEntry[];
}

function toEntry(store: LifecycleStore, row: FindingRow): DigestFindingEntry {
	const events = store.listEvents(row.id);
	return {
		fingerprint: row.fingerprint,
		title: row.title,
		severity: row.severity,
		state: row.state,
		needsTriage: row.needsTriage,
		appName: row.appName,
		patternId: row.patternId,
		firstSeenAt: row.firstSeenAt,
		lastSeenAt: row.lastSeenAt,
		occurrenceCount: store.countOccurrences(row.id),
		lastEvent: events.length > 0 ? events[events.length - 1].event : null,
	};
}

export function buildDigest(
	store: LifecycleStore,
	opts?: DigestOptions,
): DigestData {
	const limit = opts?.limit ?? 50;
	const tenant = opts?.tenant;
	const since = opts?.since ?? null;

	const byState = (state: FindingState): FindingRow[] =>
		store.listFindings({ tenant, state });

	const totals = {
		new: byState("new").length,
		open: byState("open").length,
		regressed: byState("regressed").length,
		improving: byState("improving").length,
		resolved: byState("resolved").length,
		closed: byState("closed").length,
		needsTriage: store.listFindings({ tenant, needsTriage: true }).length,
	};

	const section = (
		state: FindingState,
		timeOf: (row: FindingRow) => string | null,
	): DigestFindingEntry[] =>
		byState(state)
			.filter((row) => {
				if (!since) return true;
				const t = timeOf(row);
				return t !== null && t >= since;
			})
			.slice(0, limit)
			.map((row) => toEntry(store, row));

	return {
		generatedAt: opts?.now ?? new Date().toISOString(),
		tenant: tenant ?? null,
		since,
		totals,
		newFindings: section("new", (r) => r.firstSeenAt),
		regressed: section("regressed", (r) => r.lastSeenAt),
		improving: section("improving", (r) => r.lastSeenAt),
		resolved: section("resolved", (r) => r.resolvedAt),
		needsTriage: store
			.listFindings({ tenant, needsTriage: true, limit })
			.map((row) => toEntry(store, row)),
	};
}

function renderSection(title: string, entries: DigestFindingEntry[]): string {
	const lines = [`## ${title}`, ""];
	if (entries.length === 0) {
		lines.push("_none_", "");
		return lines.join("\n");
	}
	for (const e of entries) {
		const triage = e.needsTriage ? " [needs-triage]" : "";
		lines.push(
			`- **[${e.severity}]** ${e.title}${triage}`,
			`  \`${e.fingerprint}\` · ${e.patternId} · ${e.appName || "unknown app"} · seen ${e.occurrenceCount}x · first ${e.firstSeenAt.slice(0, 10)} · last ${e.lastSeenAt.slice(0, 10)}`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

export function renderDigestMarkdown(digest: DigestData): string {
	const t = digest.totals;
	const header = [
		"# al-perf Finding Digest",
		"",
		`Generated: ${digest.generatedAt}${digest.tenant ? ` · tenant: ${digest.tenant}` : ""}${digest.since ? ` · since: ${digest.since}` : ""}`,
		"",
		`| new | open | regressed | improving | resolved | closed | needs-triage |`,
		`|---|---|---|---|---|---|---|`,
		`| ${t.new} | ${t.open} | ${t.regressed} | ${t.improving} | ${t.resolved} | ${t.closed} | ${t.needsTriage} |`,
		"",
	].join("\n");
	return [
		header,
		renderSection("New findings", digest.newFindings),
		renderSection("Regressed", digest.regressed),
		renderSection("Improving", digest.improving),
		renderSection("Resolved", digest.resolved),
		renderSection("Needs triage", digest.needsTriage),
	].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/digest.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/lifecycle test/lifecycle`

```bash
git add src/lifecycle/digest.ts test/lifecycle/digest.test.ts
git commit -m "feat(lifecycle): markdown/JSON digest over the finding store

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 8: History store migrates into SQLite

**Files:**
- Rewrite: `src/history/store.ts`
- Modify: `src/cli/commands/history.ts`, `src/cli/commands/analyze.ts`, `src/mcp/server.ts`
- Modify: `test/history/store.test.ts`, `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `HistoryEntry`/`HistoryQuery` (`src/types/history.js`, unchanged), `AnalysisResult`.
- Produces:
  - `class HistoryStore { constructor(dbPath: string, options?: { legacyDir?: string }); save(result: AnalysisResult, options?: { gitCommit?: string; label?: string }): HistoryEntry; query(q?: HistoryQuery): HistoryEntry[]; get(id: string): HistoryEntry | null; delete(id: string): boolean; clearAll(): void; count(): number; close(): void }`
  - Spec §4: "The existing JSON-file history store migrates into the same SQLite when the lifecycle engine lands — one persistence system." The `history_entries` table lives in the SAME database file as the lifecycle tables (default `.al-perf/lifecycle.sqlite`); `HistoryStore` opens its own `bun:sqlite` connection with `CREATE TABLE IF NOT EXISTS`, so it works standalone and alongside `LifecycleStore` (WAL handles concurrent connections).
  - Migration (plan D13): when `options.legacyDir` exists, contains `*.json`, and has no `MIGRATED.md` tombstone → import every parseable entry with `INSERT OR IGNORE`, write `MIGRATED.md`, leave the JSON files in place (never delete user data). Presence of the tombstone skips re-migration.

- [ ] **Step 1: Write the failing test**

Replace the top of `test/history/store.test.ts`: change every `new HistoryStore(historyDir)` to `new HistoryStore(dbPath)` where each test derives `const dbPath = join(historyDir, "lifecycle.sqlite");` from its existing temp dir (the existing temp-dir setup/teardown stays). Keep all existing behavioral assertions — the public API is unchanged. If any existing assertion inspects `*.json` files inside the store dir, replace it with the equivalent `store.count()` / `store.get()` assertion (entries are rows now, not files).

Then APPEND this describe block:

```typescript
import { existsSync, mkdirSync, writeFileSync } from "fs";

describe("HistoryStore legacy JSON migration", () => {
	const legacyEntry = {
		id: "2026-01-01T00-00-00-000Z_abcd1234",
		timestamp: "2026-01-01T00:00:00.000Z",
		profilePath: "/profiles/old.alcpuprofile",
		profileType: "sampling" as const,
		metrics: {
			totalDuration: 1000,
			totalSelfTime: 900,
			idleSelfTime: 0,
			nodeCount: 10,
			maxDepth: 3,
			confidenceScore: 90,
			healthScore: 80,
			patternCount: { critical: 0, warning: 1, info: 0 },
		},
		topHotspots: [],
	};

	it("imports legacy entries once, writes a tombstone, keeps the files", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-history-legacy-"));
		try {
			const legacy = join(dir, ".al-perf-history");
			mkdirSync(legacy, { recursive: true });
			const jsonFile = join(legacy, `${legacyEntry.id}.json`);
			writeFileSync(jsonFile, JSON.stringify(legacyEntry));
			const dbPath = join(dir, "lifecycle.sqlite");

			const store = new HistoryStore(dbPath, { legacyDir: legacy });
			expect(store.count()).toBe(1);
			expect(store.get(legacyEntry.id)?.profilePath).toBe(legacyEntry.profilePath);
			expect(existsSync(join(legacy, "MIGRATED.md"))).toBe(true);
			expect(existsSync(jsonFile)).toBe(true); // originals kept
			store.close();

			// Tombstone prevents re-import (no duplicates on reopen).
			const again = new HistoryStore(dbPath, { legacyDir: legacy });
			expect(again.count()).toBe(1);
			again.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
```

(Adjust the import list at the top of the file so `mkdtempSync`, `rmSync`, `tmpdir`, `join`, `existsSync`, `mkdirSync`, `writeFileSync` are all imported once — the file already imports most of them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/history/store.test.ts`
Expected: FAIL — constructor still treats the argument as a JSON directory (entries land as files, counts/migration assertions fail).

- [ ] **Step 3: Rewrite `src/history/store.ts`**

Replace the whole file with:

```typescript
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import type { AnalysisResult } from "../output/types.js";
import type { HistoryEntry, HistoryQuery } from "../types/history.js";

const TOMBSTONE = "MIGRATED.md";

/**
 * SQLite-backed store for analysis history (bun:sqlite, WAL).
 *
 * Lives in the SAME database file as the lifecycle engine (default
 * `.al-perf/lifecycle.sqlite`) — one persistence system (umbrella spec §4).
 * Opens its own connection and owns only the history_entries table, so it
 * also works standalone.
 *
 * Legacy migration: pass `legacyDir` (the old JSON-file store directory,
 * default `.al-perf-history` at the call sites). Entries are imported once;
 * a MIGRATED.md tombstone marks completion and the JSON files are kept as a
 * backup — never deleted.
 */
export class HistoryStore {
	private db: Database;

	constructor(dbPath: string, options?: { legacyDir?: string }) {
		const resolved = dbPath === ":memory:" ? dbPath : resolve(dbPath);
		if (resolved !== ":memory:") {
			mkdirSync(dirname(resolved), { recursive: true });
		}
		this.db = new Database(resolved, { create: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run(`CREATE TABLE IF NOT EXISTS history_entries (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			profile_path TEXT NOT NULL,
			label TEXT,
			entry_json TEXT NOT NULL
		)`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_history_time ON history_entries(timestamp)",
		);
		if (options?.legacyDir) this.migrateLegacyDir(options.legacyDir);
	}

	private migrateLegacyDir(dir: string): void {
		const legacy = resolve(dir);
		if (!existsSync(legacy)) return;
		if (existsSync(join(legacy, TOMBSTONE))) return;
		let migrated = 0;
		for (const file of readdirSync(legacy).filter((f) => f.endsWith(".json"))) {
			try {
				const entry: HistoryEntry = JSON.parse(
					readFileSync(join(legacy, file), "utf-8"),
				);
				const res = this.insertEntry(entry, true);
				if (res) migrated++;
			} catch {
				// Skip corrupted files — same policy as the old JSON store.
			}
		}
		writeFileSync(
			join(legacy, TOMBSTONE),
			`# Migrated\n\nThese JSON history entries were imported into the SQLite history store on ${new Date().toISOString()} (${migrated} entries).\nThe files are kept as a backup; the history CLI/MCP tools now read from the database.\nDelete this directory when you no longer need the backup.\n`,
			"utf-8",
		);
	}

	private insertEntry(entry: HistoryEntry, ignoreDupes: boolean): boolean {
		const res = this.db.run(
			`INSERT ${ignoreDupes ? "OR IGNORE " : ""}INTO history_entries (id, timestamp, profile_path, label, entry_json)
			 VALUES (?, ?, ?, ?, ?)`,
			[
				entry.id,
				entry.timestamp,
				entry.profilePath,
				entry.label ?? null,
				JSON.stringify(entry),
			],
		);
		return res.changes > 0;
	}

	/** Store an analysis result as a history entry. */
	save(
		result: AnalysisResult,
		options?: { gitCommit?: string; label?: string },
	): HistoryEntry {
		const timestamp = result.meta.analyzedAt;
		const profileHash = createHash("sha256")
			.update(result.meta.profilePath)
			.digest("hex")
			.slice(0, 8);
		const baseId = `${timestamp.replace(/[:.]/g, "-")}_${profileHash}`;

		// Ensure uniqueness: append a counter while the id exists.
		let id = baseId;
		let counter = 1;
		while (this.get(id) !== null) {
			id = `${baseId}_${counter}`;
			counter++;
		}

		const entry: HistoryEntry = {
			id,
			timestamp,
			profilePath: result.meta.profilePath,
			profileType: result.meta.profileType,
			gitCommit: options?.gitCommit,
			label: options?.label,
			metrics: {
				totalDuration: result.meta.totalDuration,
				totalSelfTime: result.meta.totalSelfTime,
				idleSelfTime: result.meta.idleSelfTime,
				nodeCount: result.meta.totalNodes,
				maxDepth: result.meta.maxDepth,
				confidenceScore: result.meta.confidenceScore,
				healthScore: result.summary.healthScore,
				patternCount: result.summary.patternCount,
			},
			topHotspots: result.hotspots.slice(0, 5).map((h) => ({
				functionName: h.functionName,
				objectType: h.objectType,
				objectId: h.objectId,
				selfTime: h.selfTime,
				selfTimePercent: h.selfTimePercent,
			})),
		};

		this.insertEntry(entry, false);
		return entry;
	}

	/** Query history entries with optional filters (newest first). */
	query(q?: HistoryQuery): HistoryEntry[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (q?.profilePath) {
			where.push("instr(lower(profile_path), lower(?)) > 0");
			params.push(q.profilePath);
		}
		if (q?.since) {
			where.push("timestamp >= ?");
			params.push(q.since);
		}
		if (q?.until) {
			where.push("timestamp <= ?");
			params.push(q.until);
		}
		if (q?.label) {
			where.push("label = ?");
			params.push(q.label);
		}
		let sql = "SELECT entry_json FROM history_entries";
		if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
		sql += " ORDER BY timestamp DESC, id DESC";
		if (q?.limit !== undefined && q.limit > 0) {
			sql += " LIMIT ?";
			params.push(q.limit);
		}
		return this.db
			.query<{ entry_json: string }, (string | number)[]>(sql)
			.all(...params)
			.map((row) => JSON.parse(row.entry_json) as HistoryEntry);
	}

	/** Get a specific entry by ID. */
	get(id: string): HistoryEntry | null {
		const row = this.db
			.query<{ entry_json: string }, [string]>(
				"SELECT entry_json FROM history_entries WHERE id = ?",
			)
			.get(id);
		if (!row) return null;
		try {
			return JSON.parse(row.entry_json) as HistoryEntry;
		} catch {
			return null;
		}
	}

	/** Delete a specific entry. */
	delete(id: string): boolean {
		const res = this.db.run("DELETE FROM history_entries WHERE id = ?", [id]);
		return res.changes > 0;
	}

	/** Clear all history entries (rows only — the database file remains). */
	clearAll(): void {
		this.db.run("DELETE FROM history_entries");
	}

	/** Count total entries. */
	count(): number {
		const row = this.db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM history_entries")
			.get();
		return row?.n ?? 0;
	}

	close(): void {
		this.db.close();
	}
}
```

- [ ] **Step 4: Update the call sites**

`src/cli/commands/history.ts` — on the parent command, add a `--db` option and keep `--history-dir` as the legacy-migration source; change all three `new HistoryStore(cmd.opts().historyDir)` constructions:

```typescript
	const cmd = new Command("history")
		.description("Manage performance analysis history")
		.option("--db <path>", "History database file", ".al-perf/lifecycle.sqlite")
		.option(
			"--history-dir <dir>",
			"Legacy JSON history directory (auto-migrated into --db)",
			".al-perf-history",
		);
```

and in each subcommand action:

```typescript
			const store = new HistoryStore(cmd.opts().db, {
				legacyDir: cmd.opts().historyDir,
			});
```

`src/cli/commands/analyze.ts` — locate the existing `--history-dir` option declaration (search for `history-dir`) and add next to it:

```typescript
		.option(
			"--history-db <path>",
			"History database file",
			".al-perf/lifecycle.sqlite",
		)
```

then change the save block (currently `src/cli/commands/analyze.ts:214-218`):

```typescript
			if (opts.saveHistory) {
				const { HistoryStore } = await import("../../history/store.js");
				const store = new HistoryStore(opts.historyDb, {
					legacyDir: opts.historyDir,
				});
				store.save(result, { gitCommit: opts.gitCommit, label: opts.label });
			}
```

`src/mcp/server.ts` — find the server options type carrying `historyDir` (search for `historyDir?:`) and add `historyDb?: string;` beside it with a doc comment `/** History database file (default .al-perf/lifecycle.sqlite). */`. Then change BOTH construction sites (`src/mcp/server.ts:1001` and `src/mcp/server.ts:1047`):

```typescript
				const store = new HistoryStore(
					options?.historyDb ?? ".al-perf/lifecycle.sqlite",
					{ legacyDir: options?.historyDir ?? ".al-perf-history" },
				);
```

`test/mcp/tools.test.ts` — the history tool tests construct `new HistoryStore(historyDir)` and pass `historyDir` into `createMcpServer`. Change each to derive `const historyDb = join(historyDir, "lifecycle.sqlite");`, construct `new HistoryStore(historyDb)`, and pass `{ historyDb }` in the server options (keep the temp-dir lifecycle as-is).

- [ ] **Step 5: Run the affected suites**

Run: `AI_DISABLED=1 bun test test/history/store.test.ts test/mcp/tools.test.ts`
Expected: PASS — API behavior identical, storage now SQLite.

- [ ] **Step 6: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/history src/cli src/mcp test/history test/mcp`

```bash
git add src/history/store.ts src/cli/commands/history.ts src/cli/commands/analyze.ts src/mcp/server.ts test/history/store.test.ts test/mcp/tools.test.ts
git commit -m "feat(history): migrate JSON-file history store into lifecycle SQLite

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 9: `lifecycle` CLI command group + library exports

**Files:**
- Create: `src/cli/commands/lifecycle.ts`
- Modify: `src/cli/index.ts`, `src/index.ts`, `CLAUDE.md`
- Test: `test/lifecycle/cli.test.ts`

**Interfaces:**
- Consumes: `analyzeProfile` (`src/core/analyzer.js`, existing), everything from Tasks 1–7.
- Produces:
  - `const DEFAULT_DB_PATH = ".al-perf/lifecycle.sqlite"`
  - `function createLifecycleCommand(): Command` — subcommands `evaluate <profile>`, `digest`, `status`, `close <fingerprint>`, `triage <fingerprint>`, `maintain`
  - `function applyClose(store: LifecycleStore, tenant: string, fingerprint: string, now: string): { ok: boolean; message: string }` (exported for tests; the `close` subcommand is a thin wrapper)
  - Library exports appended to `src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/cli.test.ts`:

```typescript
/**
 * cli.test.ts — lifecycle CLI: close guard (only from resolved), triage
 * toggling helper path, command registration. The evaluate/digest logic is
 * covered by evaluate.test.ts / digest.test.ts; here we test the CLI-owned
 * glue that isn't just commander wiring.
 */

import { describe, expect, it } from "bun:test";
import {
	applyClose,
	createLifecycleCommand,
	DEFAULT_DB_PATH,
} from "../../src/cli/commands/lifecycle.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";

function finding(state: NewFinding["state"]): NewFinding {
	return {
		tenant: "local",
		fingerprint: "pattern:cli0000000000001",
		algoVersion: 1,
		state,
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "x",
		severity: "warning",
		appId: "",
		appName: "",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-01T00:00:00Z",
		lastEventAt: "2026-07-01T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["adhoc"],
	};
}

describe("applyClose", () => {
	it("closes a resolved finding and logs the event", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(finding("resolved"));
		const res = applyClose(store, "local", "pattern:cli0000000000001", "2026-07-09T00:00:00Z");
		expect(res.ok).toBe(true);
		expect(store.getFinding(id)?.state).toBe("closed");
		expect(store.getFinding(id)?.closedAt).toBe("2026-07-09T00:00:00Z");
		expect(store.listEvents(id).at(-1)?.event).toBe("closed");
		store.close();
	});

	it("refuses to close a non-resolved finding (spec: close is human confirmation of resolved)", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(finding("open"));
		const res = applyClose(store, "local", "pattern:cli0000000000001", "2026-07-09T00:00:00Z");
		expect(res.ok).toBe(false);
		expect(res.message).toContain("resolved");
		store.close();
	});

	it("reports a missing fingerprint", () => {
		const store = new LifecycleStore(":memory:");
		const res = applyClose(store, "local", "pattern:nope", "2026-07-09T00:00:00Z");
		expect(res.ok).toBe(false);
		expect(res.message).toContain("No active finding");
		store.close();
	});
});

describe("createLifecycleCommand", () => {
	it("registers the command group with all subcommands", () => {
		const cmd = createLifecycleCommand();
		expect(cmd.name()).toBe("lifecycle");
		const subs = cmd.commands.map((c) => c.name());
		for (const s of ["evaluate", "digest", "status", "close", "triage", "maintain"]) {
			expect(subs).toContain(s);
		}
		expect(DEFAULT_DB_PATH).toBe(".al-perf/lifecycle.sqlite");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/cli.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/commands/lifecycle.js'`

- [ ] **Step 3: Write the implementation**

Create `src/cli/commands/lifecycle.ts`:

```typescript
import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import chalk from "chalk";
import Table from "cli-table3";
import { Command } from "commander";
import { analyzeProfile } from "../../core/analyzer.js";
import { rollupRoutineMetrics } from "../../lifecycle/baselines.js";
import {
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig,
} from "../../lifecycle/config.js";
import { buildDigest, renderDigestMarkdown } from "../../lifecycle/digest.js";
import { evaluateRun } from "../../lifecycle/evaluate.js";
import { transition } from "../../lifecycle/states.js";
import { LifecycleStore } from "../../lifecycle/store.js";

/** CLI default DB location (plan decision: dot-dir in cwd, one file). */
export const DEFAULT_DB_PATH = ".al-perf/lifecycle.sqlite";

/**
 * Close a resolved finding (human confirmation). Exported for tests; the
 * `lifecycle close` subcommand is a thin wrapper. Close is only legal from
 * `resolved` — the state machine enforces it.
 */
export function applyClose(
	store: LifecycleStore,
	tenant: string,
	fingerprint: string,
	now: string,
): { ok: boolean; message: string } {
	const row = store.getActiveFinding(tenant, fingerprint);
	if (!row) {
		return { ok: false, message: `No active finding for ${fingerprint}` };
	}
	const res = transition(
		row.state,
		{ type: "close" },
		{
			absenceCount: row.absenceCount,
			resolveAfterRuns: DEFAULT_LIFECYCLE_CONFIG.resolveAfterRuns,
		},
	);
	if (!res.ok) return { ok: false, message: res.reason };
	store.updateFindingState(row.id, { state: "closed", closedAt: now });
	store.logEvent({
		findingId: row.id,
		event: "closed",
		fromState: row.state,
		toState: "closed",
		at: now,
	});
	return { ok: true, message: `Closed ${fingerprint}` };
}

export function createLifecycleCommand(): Command {
	const cmd = new Command("lifecycle")
		.description(
			"Finding lifecycle engine — durable finding state across profile runs",
		)
		.option("--db <path>", "Lifecycle database file", DEFAULT_DB_PATH);

	cmd
		.command("evaluate <profile>")
		.description("Analyze a profile and evaluate finding lifecycle state")
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--stream <stream>", "Capture stream (schedule/job id)", "adhoc")
		.option(
			"--profile-id <id>",
			"Idempotency key (default: sha256 of the file content)",
		)
		.option(
			"--capture-time <iso>",
			"Profile capture time, ISO 8601 (default: file mtime)",
		)
		.option("-s, --source <path>", "AL source directory")
		.option("--resolve-after <n>", "Absent runs before a finding resolves")
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action(async (profilePath: string, opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const result = await analyzeProfile(profilePath, {
					includePatterns: true,
					sourcePath: opts.source,
				});
				const profileId =
					opts.profileId ??
					createHash("sha256")
						.update(readFileSync(profilePath))
						.digest("hex")
						.slice(0, 32);
				const captureTime =
					opts.captureTime ?? statSync(profilePath).mtime.toISOString();
				const configPatch: Partial<LifecycleConfig> = {};
				if (opts.resolveAfter !== undefined) {
					configPatch.resolveAfterRuns = parseInt(opts.resolveAfter, 10);
				}
				const outcome = evaluateRun(
					store,
					result,
					{
						tenant: opts.tenant,
						stream: opts.stream,
						profileId,
						captureKind: result.meta.captureKind ?? result.meta.profileType,
						captureTime,
					},
					configPatch,
				);
				if (opts.format === "json") {
					process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
					return;
				}
				const skipped = outcome.skipped ? ` (${outcome.skipped})` : "";
				console.log(
					`Run ${outcome.runId}${skipped}: ${outcome.findingsSeen} findings seen, ` +
						`${outcome.transitions.length} transitions, ${outcome.unfingerprinted} unfingerprinted` +
						(outcome.incomplete ? " [incomplete capture — absence not counted]" : ""),
				);
				for (const t of outcome.transitions) {
					console.log(
						`  ${t.fingerprint}: ${t.from ?? "-"} -> ${t.to} (${t.event})`,
					);
				}
			} finally {
				store.close();
			}
		});

	cmd
		.command("digest")
		.description("Render the finding digest (digest-first reporting posture)")
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--since <iso>", "Only activity at/after this time")
		.option("-f, --format <format>", "Output format: markdown|json", "markdown")
		.action((opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const digest = buildDigest(store, {
					tenant: opts.tenant,
					since: opts.since,
				});
				process.stdout.write(
					opts.format === "json"
						? JSON.stringify(digest, null, 2) + "\n"
						: renderDigestMarkdown(digest),
				);
			} finally {
				store.close();
			}
		});

	cmd
		.command("status")
		.description("List findings and their lifecycle state")
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--state <state>", "Filter by state")
		.option("--triage", "Only needs-triage findings")
		.option("-n, --limit <n>", "Maximum findings to show", "50")
		.option("-f, --format <format>", "Output format: table|json", "table")
		.action((opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const rows = store.listFindings({
					tenant: opts.tenant,
					state: opts.state,
					needsTriage: opts.triage ? true : undefined,
					limit: parseInt(opts.limit, 10),
				});
				if (opts.format === "json") {
					process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
					return;
				}
				if (rows.length === 0) {
					console.log("No findings.");
					return;
				}
				const table = new Table({
					head: [
						chalk.gray("State"),
						chalk.gray("Sev"),
						chalk.gray("Title"),
						chalk.gray("Fingerprint"),
						chalk.gray("Last seen"),
						chalk.gray("Absent"),
						chalk.gray("Triage"),
					],
					style: { head: [], border: [] },
				});
				for (const r of rows) {
					table.push([
						r.state,
						r.severity,
						r.title.slice(0, 40),
						r.fingerprint,
						r.lastSeenAt.slice(0, 19),
						String(r.absenceCount),
						r.needsTriage ? "yes" : "",
					]);
				}
				console.log(table.toString());
			} finally {
				store.close();
			}
		});

	cmd
		.command("close <fingerprint>")
		.description("Close a RESOLVED finding (human confirmation)")
		.option("--tenant <tenant>", "Tenant key", "local")
		.action((fingerprint: string, opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const res = applyClose(
					store,
					opts.tenant,
					fingerprint,
					new Date().toISOString(),
				);
				if (!res.ok) {
					console.error(res.message);
					process.exitCode = 1;
					return;
				}
				console.log(res.message);
			} finally {
				store.close();
			}
		});

	cmd
		.command("triage <fingerprint>")
		.description("Set or clear the needs-triage flag")
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--clear", "Clear the flag instead of setting it")
		.action((fingerprint: string, opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const row = store.getActiveFinding(opts.tenant, fingerprint);
				if (!row) {
					console.error(`No active finding for ${fingerprint}`);
					process.exitCode = 1;
					return;
				}
				store.setNeedsTriage(row.id, !opts.clear);
				console.log(
					`${opts.clear ? "Cleared" : "Set"} needs-triage on ${fingerprint}`,
				);
			} finally {
				store.close();
			}
		});

	cmd
		.command("maintain")
		.description(
			"Run store maintenance: roll up routine metrics older than the retention window",
		)
		.option(
			"--retention-days <n>",
			"Raw metric retention in days",
			String(DEFAULT_LIFECYCLE_CONFIG.rawMetricsRetentionDays),
		)
		.action((opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
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

	return cmd;
}
```

Register in `src/cli/index.ts` — add the import and registration alongside the existing ones:

```typescript
import { createLifecycleCommand } from "./commands/lifecycle.js";
```

and after `program.addCommand(createHistoryCommand());`:

```typescript
program.addCommand(createLifecycleCommand());
```

Append to `src/index.ts` (library API):

```typescript
export { rollupRoutineMetrics } from "./lifecycle/baselines.js";
export type { RunVersions } from "./lifecycle/baselines.js";
export {
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig,
} from "./lifecycle/config.js";
export {
	buildDigest,
	type DigestData,
	renderDigestMarkdown,
} from "./lifecycle/digest.js";
export {
	evaluateRun,
	type EvaluationOutcome,
	type RunMetadata,
} from "./lifecycle/evaluate.js";
export { LifecycleStore } from "./lifecycle/store.js";
```

Update `CLAUDE.md`: in the Architecture section's `src/cli` line, extend the command list with `lifecycle`; add one line under it: `` lifecycle/ — finding lifecycle engine (SQLite store, state machine, baselines, digest) `` in the `src/` tree listing.

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Smoke the CLI end-to-end**

Run: `bun run src/cli/index.ts lifecycle evaluate test/fixtures/sampling-small.alcpuprofile --db .al-perf/smoke.sqlite -f json` (use any existing fixture from `test/fixtures/*.alcpuprofile`; check with `ls test/fixtures/*.alcpuprofile`)
Expected: JSON outcome with `runId`, `findingsSeen` ≥ 0 (0 transitions is fine while fingerprints aren't wired), exit 0. Then `bun run src/cli/index.ts lifecycle digest --db .al-perf/smoke.sqlite` prints the markdown digest. Delete `.al-perf/smoke.sqlite*` afterwards.

- [ ] **Step 6: Type-check, format, commit**

Run: `bunx tsc --noEmit && bunx biome check --write src/cli src/index.ts test/lifecycle`

```bash
git add src/cli/commands/lifecycle.ts src/cli/index.ts src/index.ts CLAUDE.md test/lifecycle/cli.test.ts
git commit -m "feat(cli): lifecycle command group (evaluate/digest/status/close/triage/maintain)

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 10: Web ingest hook behind AL_PERF_LIFECYCLE=1

**Files:**
- Create: `web/lifecycle-db.ts`
- Modify: `web/handlers/ingest.ts`
- Test: `test/web/lifecycle-ingest.test.ts`

**Interfaces:**
- Consumes: `evaluateRun` (Task 5), `LifecycleStore` (Task 1), the existing ingest handler flow (`web/handlers/ingest.ts` — `tenantCode`, `activityId`, `manifest`, `analysisResult` are all in scope after the successful-analysis branch).
- Produces:
  - `function getLifecycleStore(dataDir: string): LifecycleStore` (`web/lifecycle-db.ts`) — process-wide singleton per DB path at `<dataDir>/lifecycle.sqlite`.
  - Ingest behavior: byte-unchanged by default; with `AL_PERF_LIFECYCLE=1` (read per request), a successful ingest additionally records a lifecycle run. Lifecycle errors are logged to stderr and NEVER fail the ingest.

- [ ] **Step 1: Write the failing test**

Create `test/web/lifecycle-ingest.test.ts` (follows the server-boot pattern of `test/web/poc-ingest-v1.test.ts`: env set before the shared-module-cache server import; distinct tenant code and GUID so it can't collide with other web tests):

```typescript
import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { LifecycleStore } from "../../src/lifecycle/store.js";

const TEST_DATA = mkdtempSync(join(tmpdir(), "alperf-lifecycle-ingest-"));
process.env.AL_PERF_DATA_DIR = TEST_DATA;
process.env.AL_PERF_POC_SECRET = "test-secret-1234";
// PORT shared with prior poc-* tests (Bun module cache).
process.env.PORT ??= "3999";

const { server } = await import("../../web/server.ts");
const BASE = `http://localhost:${server.port}`;

afterAll(() => {
	delete process.env.AL_PERF_LIFECYCLE;
	rmSync(TEST_DATA, { recursive: true, force: true });
});

const GUID_OFF = "550e8400-e29b-41d4-a716-446655440201";
const GUID_ON = "550e8400-e29b-41d4-a716-446655440202";

async function registerTenant(tenantCode: string): Promise<string> {
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
	const publicXml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;
	const res = await fetch(`${BASE}/api/tenants/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			tenantCode,
			sharedSecret: "test-secret-1234",
			publicKeyXml: publicXml,
		}),
	});
	const { tenantToken } = (await res.json()) as { tenantToken: string };
	return tenantToken;
}

async function postIngest(tenantCode: string, token: string, activityId: string) {
	const profilePath = resolve(
		import.meta.dir,
		"../fixtures/instrumentation-minimal.alcpuprofile",
	);
	const manifest = {
		activityId,
		activityType: "Background",
		scheduleId: "nightly-job",
		captureKind: "sampling",
		startTime: "2026-07-09T01:00:00Z",
	};
	const fd = new FormData();
	fd.append(
		"manifest",
		new Blob([JSON.stringify(manifest)], { type: "application/json" }),
		"manifest.json",
	);
	fd.append(
		"profile",
		new Blob([readFileSync(profilePath)], { type: "application/octet-stream" }),
		"p.alcpuprofile",
	);
	return fetch(`${BASE}/api/ingest`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"x-tenant-id": tenantCode,
			"x-idempotency-key": activityId,
		},
		body: fd,
	});
}

describe("ingest lifecycle hook (AL_PERF_LIFECYCLE)", () => {
	it("default OFF: successful ingest writes no lifecycle run", async () => {
		delete process.env.AL_PERF_LIFECYCLE;
		const token = await registerTenant("lcoff");
		const res = await postIngest("lcoff", token, GUID_OFF);
		expect(res.status).toBe(202);
		expect(existsSync(join(TEST_DATA, "lifecycle.sqlite"))).toBe(false);
	});

	it("AL_PERF_LIFECYCLE=1: successful ingest records a lifecycle run keyed to manifest metadata", async () => {
		process.env.AL_PERF_LIFECYCLE = "1";
		const token = await registerTenant("lcon");
		const res = await postIngest("lcon", token, GUID_ON);
		expect(res.status).toBe(202);
		const store = new LifecycleStore(join(TEST_DATA, "lifecycle.sqlite"));
		const run = store.getRun("lcon", GUID_ON);
		expect(run).not.toBeNull();
		expect(run?.stream).toBe("nightly-job");
		expect(run?.captureKind).toBe("sampling");
		expect(run?.captureTime).toBe("2026-07-09T01:00:00Z");
		store.close();
	});
});
```

Note: the assertion is on the RUN row, not on findings — findings require pattern fingerprints (phase-2 wiring), and this test must pass regardless of whether that plan has merged.

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/web/lifecycle-ingest.test.ts`
Expected: the OFF test passes, the ON test FAILS (`run` is null — no hook yet).

- [ ] **Step 3: Write the implementation**

Create `web/lifecycle-db.ts`:

```typescript
/**
 * lifecycle-db.ts — process-wide LifecycleStore singleton for the web
 * server. One connection per DB path (opening per request would churn WAL
 * handles). The DB lives under the data root so it survives container
 * redeploys: <AL_PERF_DATA_DIR>/lifecycle.sqlite.
 */

import { join } from "path";
import { LifecycleStore } from "../src/lifecycle/store.ts";

const stores = new Map<string, LifecycleStore>();

export function getLifecycleStore(dataDir: string): LifecycleStore {
	const path = join(dataDir, "lifecycle.sqlite");
	let store = stores.get(path);
	if (!store) {
		store = new LifecycleStore(path);
		stores.set(path, store);
	}
	return store;
}
```

In `web/handlers/ingest.ts`, insert the hook AFTER the `keyversion.txt` write (the point where the ingest is durably complete) and BEFORE the final `return jsonResponse(202, ...)`:

```typescript
	// Lifecycle evaluation (phase 3) — opt-in via AL_PERF_LIFECYCLE=1 (read
	// per request) so the POC ingest behavior is byte-unchanged by default.
	// Errors are logged and never fail the ingest: the profile is already
	// stored and reanalyzable.
	if (process.env.AL_PERF_LIFECYCLE === "1") {
		try {
			const { getLifecycleStore } = await import("../lifecycle-db.ts");
			const { evaluateRun } = await import("../../src/lifecycle/evaluate.ts");
			const result = analysisResult as import("../../src/output/types.ts").AnalysisResult;
			const captureKind =
				manifest.captureKind === "instrumentation" ||
				manifest.captureKind === "sampling"
					? manifest.captureKind
					: (result.meta.captureKind ?? result.meta.profileType);
			evaluateRun(getLifecycleStore(dataDir), result, {
				tenant: tenantCode,
				stream:
					typeof manifest.scheduleId === "string" && manifest.scheduleId !== ""
						? manifest.scheduleId
						: "adhoc",
				profileId: activityId,
				captureKind,
				captureTime:
					typeof manifest.startTime === "string"
						? manifest.startTime
						: new Date().toISOString(),
				versions: parseManifestVersions(manifest),
			});
		} catch (err) {
			console.error(
				`[lifecycle] evaluation failed for tenant ${tenantCode} activity ${activityId}: ${err}`,
			);
		}
	}
```

Add this helper at module level in `web/handlers/ingest.ts` (next to `extractMetrics`):

```typescript
/**
 * Versions from the ingest manifest (spec §2 ingest body mentions
 * appVersions[]; today's al-perf-bc manifests don't send it yet — this is
 * forward-compatible and returns undefined until producers do).
 */
function parseManifestVersions(
	manifest: Record<string, unknown>,
): { platform?: string; apps?: Array<{ id: string; version: string }> } | undefined {
	const platform =
		typeof manifest.platformVersion === "string"
			? manifest.platformVersion
			: undefined;
	const apps = Array.isArray(manifest.appVersions)
		? manifest.appVersions.filter(
				(a): a is { id: string; version: string } =>
					typeof a === "object" &&
					a !== null &&
					typeof (a as { id?: unknown }).id === "string" &&
					typeof (a as { version?: unknown }).version === "string",
			)
		: undefined;
	if (!platform && !apps?.length) return undefined;
	return { platform, apps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `AI_DISABLED=1 bun test test/web/lifecycle-ingest.test.ts`
Expected: PASS — both OFF and ON behavior.

- [ ] **Step 5: Run the full suite to prove nothing else moved**

Run: `AI_DISABLED=1 bun test && bunx tsc --noEmit && bunx biome check --write web src/lifecycle test`
Expected: full suite green (the existing poc-* web tests prove default ingest is unchanged).

- [ ] **Step 6: Commit**

```bash
git add web/lifecycle-db.ts web/handlers/ingest.ts test/web/lifecycle-ingest.test.ts
git commit -m "feat(web): opt-in lifecycle evaluation on ingest (AL_PERF_LIFECYCLE=1)

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

## Verification (whole plan)

- `AI_DISABLED=1 bun test` — full suite green.
- `bunx tsc --noEmit` — clean.
- `bunx biome check .` — clean.
- Spec §4 coverage: states + transition table (Task 2), run/absence definition + event-time idempotency (Task 5), version-aware baselines + 90-day rollup (Task 4), fingerprintAlgoVersion + migration table (Tasks 3/6), digest-first (Task 7), history-store consolidation (Task 8), CLI surface (Task 9), ingest hook with incomplete-capture exclusion (Tasks 5/10). Sinks/outbox consumption: Plan B (`2026-07-10-github-sink.md`).
