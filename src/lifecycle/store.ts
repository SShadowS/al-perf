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
 * plan (2026-07-10-github-sink.md), which appends LIFECYCLE_MIGRATIONS[1] (v2).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { LIFECYCLE_SCHEMA_VERSION } from "./config.js";
import { type FingerprintMigration, formatFingerprint } from "./fingerprint.js";
import type { FindingState } from "./states.js";

export { LIFECYCLE_SCHEMA_VERSION };

/**
 * LIFECYCLE_MIGRATIONS[n] upgrades user_version n → n+1. Applied in order on
 * open. v1 (index 0) is the full initial schema. Exported for the upgrade-
 * path tests ONLY — never mutate at runtime.
 */
export const LIFECYCLE_MIGRATIONS: string[][] = [
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
	[
		// SQLite cannot ALTER a CHECK constraint, so the `telemetry` capture
		// kind requires rebuilding the `runs` table (the documented 12-step
		// ALTER pattern): create runs_new with the widened CHECK, copy rows,
		// carry over the AUTOINCREMENT high-water mark explicitly (a plain
		// row copy only advances runs_new's own sqlite_sequence entry as far
		// as the highest copied id — if `runs` ever had a row deleted, that
		// leaves a lower watermark than the original and a future insert
		// could reissue an id that was already handed out), drop the old
		// table, rename, recreate its index. See migrate() below for why
		// foreign_keys must be OFF for this step: occurrences/finding_events
		// still hold live references to `runs` and SQLite's implicit
		// pre-DROP DELETE would otherwise reject the DROP as a constraint
		// violation even though the table is about to come back with the
		// same rows under the same name.
		`CREATE TABLE runs_new (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant TEXT NOT NULL,
			stream TEXT NOT NULL,
			profile_id TEXT NOT NULL,
			capture_kind TEXT NOT NULL CHECK (capture_kind IN ('sampling','instrumentation','telemetry')),
			capture_time TEXT NOT NULL,
			version_stamp TEXT NOT NULL DEFAULT '',
			incomplete INTEGER NOT NULL DEFAULT 0,
			exercised_apps TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			UNIQUE (tenant, profile_id)
		)`,
		`INSERT INTO runs_new (id, tenant, stream, profile_id, capture_kind, capture_time, version_stamp, incomplete, exercised_apps, created_at)
		 SELECT id, tenant, stream, profile_id, capture_kind, capture_time, version_stamp, incomplete, exercised_apps, created_at FROM runs`,
		`UPDATE sqlite_sequence SET seq = (SELECT seq FROM sqlite_sequence WHERE name = 'runs') WHERE name = 'runs_new'`,
		`DROP TABLE runs`,
		`ALTER TABLE runs_new RENAME TO runs`,
		`CREATE INDEX IF NOT EXISTS idx_runs_stream ON runs(tenant, stream, capture_time)`,
	],
];

export interface ExercisedApps {
	ids: string[];
	names: string[];
}

export interface RunInput {
	tenant: string;
	stream: string;
	profileId: string;
	captureKind: "sampling" | "instrumentation" | "telemetry";
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

/** Severity ranking for merge reconciliation (applyFingerprintMigration) — higher wins. */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
	info: 0,
	warning: 1,
	critical: 2,
};

/** Non-closed, non-resolved states — a resolved to-row absorbing a from-row in one of these is revived into it. */
const LIVE_STATES = new Set<FindingState>([
	"new",
	"open",
	"regressed",
	"improving",
]);

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
		while (version < LIFECYCLE_MIGRATIONS.length) {
			// PRAGMA foreign_keys only takes effect outside a pending
			// transaction (SQLite silently no-ops it inside one) — toggled
			// here, around the transaction, not inside it. Off for the
			// duration because a table-rebuild migration (v3) DROPs a table
			// that other tables still hold live FK references to; see the
			// v3 migration's comment above for why that requires this.
			this.db.run("PRAGMA foreign_keys = OFF");
			try {
				const apply = this.db.transaction(() => {
					for (const stmt of LIFECYCLE_MIGRATIONS[version]) {
						this.db.run(stmt);
					}
					this.db.run(`PRAGMA user_version = ${version + 1}`);
				});
				apply();
			} finally {
				this.db.run("PRAGMA foreign_keys = ON");
			}
			const violations = this.db.query("PRAGMA foreign_key_check").all();
			if (violations.length > 0) {
				throw new Error(
					`migration to schema v${version + 1} left dangling foreign key references: ${JSON.stringify(violations)}`,
				);
			}
			version++;
		}
	}

	close(): void {
		this.db.close();
	}

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
			[
				m.tenant,
				m.sink,
				m.fingerprint,
				m.externalId,
				m.externalUrl ?? null,
				m.createdAt,
			],
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

	listDeadOutbox(sink?: string): OutboxRow[] {
		const sql = sink
			? "SELECT * FROM outbox WHERE sink = ? AND status = 'dead' ORDER BY id"
			: "SELECT * FROM outbox WHERE status = 'dead' ORDER BY id";
		const params = sink ? [sink] : [];
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
			captureKind: row.capture_kind as "sampling" | "instrumentation" | "telemetry",
			captureTime: row.capture_time as string,
			versionStamp: row.version_stamp as string,
			incomplete: (row.incomplete as number) === 1,
			exercisedApps: JSON.parse(row.exercised_apps as string) as ExercisedApps,
			createdAt: row.created_at as string,
		};
	}

	/**
	 * Throws (SQLite unique-constraint) if an active finding already exists
	 * for (tenant, fingerprint) — callers must check getActiveFinding first.
	 */
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

	/**
	 * Occurrences whose run was NOT incomplete — the umbrella spec excludes
	 * incomplete captures from lifecycle run-counting, and auto-file
	 * hysteresis (design decision 2) IS run-counting: an incomplete capture
	 * must never push a finding over `autoFileAfterRuns`.
	 */
	countQualifyingOccurrences(findingId: number): number {
		const row = this.db
			.query<{ n: number }, [number]>(
				`SELECT count(*) AS n FROM occurrences o
				 JOIN runs r ON r.id = o.run_id
				 WHERE o.finding_id = ? AND r.incomplete = 0`,
			)
			.get(findingId);
		return row?.n ?? 0;
	}

	/** Newest occurrence's details JSON for a finding (sink body evidence). */
	getLatestOccurrenceDetails(findingId: number): string | null {
		const row = this.db
			.query<{ details: string | null }, [number]>(
				"SELECT details FROM occurrences WHERE finding_id = ? ORDER BY capture_time DESC, run_id DESC LIMIT 1",
			)
			.get(findingId);
		return row?.details ?? null;
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

	/**
	 * Apply one FingerprintMigration (spec §4). The migration-table insert,
	 * the rename/merge writes, and every audit event are ALL one transaction
	 * — a crash mid-apply never strands a "recorded but not applied"
	 * migration (which would permanently no-op on retry); a retry after a
	 * crash re-applies cleanly. Events are logged with viaMigration:true so
	 * sink triggers can guard against mass state transitions caused by an
	 * algorithm change.
	 */
	applyFingerprintMigration(
		tenant: string,
		migration: FingerprintMigration,
		appliedAt: string,
	): "renamed" | "merged" | "no-op" {
		const from = formatFingerprint(migration.from);
		const to = formatFingerprint(migration.to);
		const detail = JSON.stringify({
			viaMigration: true,
			from,
			to,
			reason: migration.reason,
		});

		const apply = this.db.transaction((): "renamed" | "merged" | "no-op" => {
			const recorded = this.db.run(
				`INSERT OR IGNORE INTO fingerprint_migrations (tenant, from_fingerprint, to_fingerprint, reason, applied_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[tenant, from, to, migration.reason, appliedAt],
			);
			if (recorded.changes === 0) return "no-op"; // already applied

			const fromRow = this.getActiveFinding(tenant, from);
			if (!fromRow) return "no-op";
			const toRow = this.getActiveFinding(tenant, to);

			if (!toRow) {
				this.db.run(
					"UPDATE findings SET fingerprint = ?, algo_version = ? WHERE id = ?",
					[to, migration.to.algoVersion, fromRow.id],
				);
				// A rename must not orphan an existing sink issue mapping — the
				// old fingerprint is no longer active, so comment/close routing
				// (which looks the mapping up by fingerprint) would otherwise go
				// blind and, worse, auto-file a DUPLICATE issue for the same
				// finding under its new identity.
				//
				// OR REPLACE: the to-fingerprint can already have a mapping row
				// even though no ACTIVE finding holds it (mappings are never
				// deleted on close) — e.g. a prior finding closed under `to` and
				// left its issue mapping behind. Without OR REPLACE this UPDATE
				// would hit the (tenant, sink, fingerprint) PK and throw,
				// rolling back the whole migration transaction and re-throwing on
				// every retry forever. The from-row's mapping is the live one
				// here (its finding is still active), so it should win; the
				// stale to-row mapping is the one that gets replaced away.
				this.db.run(
					"UPDATE OR REPLACE sink_issue_map SET fingerprint = ? WHERE tenant = ? AND fingerprint = ?",
					[to, tenant, from],
				);
				this.logEvent({
					findingId: fromRow.id,
					event: "migrated",
					fromState: fromRow.state,
					toState: fromRow.state,
					at: appliedAt,
					detail,
				});
				return "renamed";
			}

			// Move history; a run present on both sides keeps the to-row's
			// occurrence (INSERT OR IGNORE semantics via UPDATE OR IGNORE,
			// then the still-there from-row leftover is deleted).
			this.db.run(
				"UPDATE OR IGNORE occurrences SET finding_id = ? WHERE finding_id = ?",
				[toRow.id, fromRow.id],
			);
			this.db.run("DELETE FROM occurrences WHERE finding_id = ?", [fromRow.id]);
			this.db.run(
				"UPDATE finding_events SET finding_id = ? WHERE finding_id = ?",
				[toRow.id, fromRow.id],
			);
			// Rekey sink issue mappings per-sink: if the to-fingerprint has no
			// mapping yet for a given sink, the from-row's mapping moves over
			// (comment/close routing keeps finding the same issue under the new
			// identity); if the to-fingerprint is ALREADY mapped for that sink,
			// its issue is canonical and the from-row's mapping is discarded —
			// otherwise a later create-issue scan would have two mappings
			// racing for one fingerprint and violate the PK.
			const fromMappings = this.db
				.query<{ sink: string }, [string, string]>(
					"SELECT sink FROM sink_issue_map WHERE tenant = ? AND fingerprint = ?",
				)
				.all(tenant, from);
			for (const { sink } of fromMappings) {
				const toHasMapping = this.db
					.query<{ n: number }, [string, string, string]>(
						"SELECT count(*) AS n FROM sink_issue_map WHERE tenant = ? AND sink = ? AND fingerprint = ?",
					)
					.get(tenant, sink, to);
				if ((toHasMapping?.n ?? 0) === 0) {
					this.db.run(
						"UPDATE sink_issue_map SET fingerprint = ? WHERE tenant = ? AND sink = ? AND fingerprint = ?",
						[to, tenant, sink, from],
					);
				} else {
					this.db.run(
						"DELETE FROM sink_issue_map WHERE tenant = ? AND sink = ? AND fingerprint = ?",
						[tenant, sink, from],
					);
				}
			}
			// The from-row's own history now lives under toRow.id — log ITS
			// ending against fromRow.id AFTER that reassignment, so the
			// from-row's own id still carries a record of how it closed
			// (otherwise listEvents(fromRow.id) would be permanently empty).
			this.logEvent({
				findingId: fromRow.id,
				event: "merged-away",
				fromState: fromRow.state,
				toState: "closed",
				at: appliedAt,
				detail,
			});

			const kinds = [
				...new Set([...toRow.observedKinds, ...fromRow.observedKinds]),
			];
			const streams = [
				...new Set([...toRow.observedStreams, ...fromRow.observedStreams]),
			];
			// Fresher observation wins: the row most recently actually SEEN
			// (last_seen_at, untouched by mere absences) carries its own
			// absence_count forward — an absence never moves last_seen_at, so
			// this stays coherent even if that row has since racked up misses.
			const fromIsFresher = fromRow.lastSeenAt > toRow.lastSeenAt;
			const lastSeenAt = fromIsFresher ? fromRow.lastSeenAt : toRow.lastSeenAt;
			const lastEventAt =
				fromRow.lastEventAt > toRow.lastEventAt
					? fromRow.lastEventAt
					: toRow.lastEventAt;
			const absenceCount = fromIsFresher
				? fromRow.absenceCount
				: toRow.absenceCount;
			const severity =
				SEVERITY_RANK[fromRow.severity] > SEVERITY_RANK[toRow.severity]
					? fromRow.severity
					: toRow.severity;
			const needsTriage = fromRow.needsTriage || toRow.needsTriage;
			// A resolved to-row absorbing a still-live from-row must not stay
			// invisible to listAbsenceCandidates — revive it into the
			// from-row's live state.
			const revive =
				toRow.state === "resolved" && LIVE_STATES.has(fromRow.state);
			const finalState = revive ? fromRow.state : toRow.state;

			this.db.run(
				`UPDATE findings SET first_seen_at = min(first_seen_at, ?), observed_kinds = ?, observed_streams = ?,
					last_seen_at = ?, last_event_at = ?, absence_count = ?, severity = ?, needs_triage = ?,
					state = ?, resolved_at = ? WHERE id = ?`,
				[
					fromRow.firstSeenAt,
					JSON.stringify(kinds),
					JSON.stringify(streams),
					lastSeenAt,
					lastEventAt,
					absenceCount,
					severity,
					needsTriage ? 1 : 0,
					finalState,
					revive ? null : toRow.resolvedAt,
					toRow.id,
				],
			);

			if (revive) {
				this.logEvent({
					findingId: toRow.id,
					event: "reopened",
					fromState: "resolved",
					toState: finalState,
					at: appliedAt,
					detail: JSON.stringify({
						viaMigration: true,
						from,
						to,
						reason: migration.reason,
						reopenedByMerge: true,
					}),
				});
			}

			this.db.run(
				"UPDATE findings SET state = 'closed', closed_at = ? WHERE id = ?",
				[appliedAt, fromRow.id],
			);
			this.logEvent({
				findingId: toRow.id,
				event: "merged",
				fromState: toRow.state,
				toState: finalState,
				at: appliedAt,
				detail,
			});
			return "merged";
		});

		return apply();
	}
}
