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
