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
				store.db
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version,
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
		expect(
			store.getIssueMapping("t1", "github", "pattern:abc")?.externalId,
		).toBe("42");
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc",
			externalId: "43",
			createdAt: "2026-07-02T00:00:00Z",
		});
		expect(
			store.getIssueMapping("t1", "github", "pattern:abc")?.externalId,
		).toBe("43");
		expect(store.getIssueMapping("t1", "github", "pattern:zzz")).toBeNull();
		store.close();
	});
});

describe("outbox methods", () => {
	function enqueue(
		store: LifecycleStore,
		findingId: number,
		dedupeKey: string,
	) {
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
		expect(
			store.listDueOutbox("github", "2026-07-01T00:00:00Z", 10),
		).toHaveLength(1);
		expect(
			store.listDueOutbox("github", "2026-06-30T00:00:00Z", 10),
		).toHaveLength(0);

		const row = store.listDueOutbox("github", "2026-07-01T00:00:00Z", 10)[0];
		store.markOutboxRetry(row.id, "boom", "2026-07-01T01:00:00Z");
		let updated = store.listDueOutbox("github", "2026-07-01T02:00:00Z", 10)[0];
		expect(updated.attempts).toBe(1);
		expect(updated.lastError).toBe("boom");

		store.markOutboxDelivered(updated.id, "2026-07-01T02:00:00Z");
		expect(
			store.listDueOutbox("github", "2026-07-02T00:00:00Z", 10),
		).toHaveLength(0);

		enqueue(store, id, "k2");
		updated = store.listDueOutbox("github", "2026-07-02T00:00:00Z", 10)[0];
		store.markOutboxDead(updated.id, "422 Unprocessable");
		expect(
			store.listDueOutbox("github", "2026-07-03T00:00:00Z", 10),
		).toHaveLength(0);
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
		expect(events.map((e) => e.event)).toEqual([
			"first-seen",
			"seen-regressed",
		]);
		store.markEventsProcessed(events.map((e) => e.id));
		expect(store.listUnprocessedEvents()).toHaveLength(0);
		store.close();
	});
});
