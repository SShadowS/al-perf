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
import type { NewFinding } from "../../src/lifecycle/store.js";
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

	it("recordRun accepts the telemetry capture kind", () => {
		const store = new LifecycleStore(":memory:");
		const rec = store.recordRun({
			tenant: "t1",
			stream: "telemetry",
			profileId: "batch-001",
			captureKind: "telemetry",
			captureTime: "2026-07-11T00:00:00Z",
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: [], names: [] },
		});
		expect(rec.duplicate).toBe(false);
		expect(store.getRun("t1", "batch-001")?.captureKind).toBe("telemetry");
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
		store.insertFinding(
			baseFinding({ fingerprint: "pattern:aaa", state: "open" }),
		);
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
