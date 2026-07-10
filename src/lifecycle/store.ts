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
import { LIFECYCLE_SCHEMA_VERSION } from "./config.js";

export { LIFECYCLE_SCHEMA_VERSION };

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
