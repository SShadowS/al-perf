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

describe("LifecycleStore.recordTriage", () => {
	it("sets note/at/by and clears needs_triage in one UPDATE, returning true", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(baseFinding({ needsTriage: true }));
		const changed = store.recordTriage(
			id,
			"looks like an intentional batch job",
			"agent-triage v1",
			"2026-07-12T09:00:00Z",
		);
		expect(changed).toBe(true);
		const row = store.getFinding(id);
		expect(row?.needsTriage).toBe(false);
		expect(row?.triageNote).toBe("looks like an intentional batch job");
		expect(row?.triagedBy).toBe("agent-triage v1");
		expect(row?.triagedAt).toBe("2026-07-12T09:00:00Z");
		store.close();
	});

	it("no-ops (race guard) once needs_triage is already 0 — never overwrites a prior triage", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(baseFinding({ needsTriage: true }));
		expect(
			store.recordTriage(
				id,
				"first note",
				"agent-triage",
				"2026-07-12T09:00:00Z",
			),
		).toBe(true);
		// A second run (or a human, or the agent racing itself) touching the
		// same finding after the flag cleared must be a no-op, not an
		// overwrite of the recorded assessment.
		expect(
			store.recordTriage(
				id,
				"second note",
				"agent-triage",
				"2026-07-12T10:00:00Z",
			),
		).toBe(false);
		const row = store.getFinding(id);
		expect(row?.triageNote).toBe("first note");
		expect(row?.triagedAt).toBe("2026-07-12T09:00:00Z");
		store.close();
	});

	it("no-ops on a finding that never needed triage", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(baseFinding({ needsTriage: false }));
		expect(
			store.recordTriage(id, "note", "agent-triage", "2026-07-12T09:00:00Z"),
		).toBe(false);
		expect(store.getFinding(id)?.triageNote).toBeNull();
		store.close();
	});

	it("no-ops on an unknown finding id without throwing", () => {
		const store = new LifecycleStore(":memory:");
		expect(
			store.recordTriage(
				999999,
				"note",
				"agent-triage",
				"2026-07-12T09:00:00Z",
			),
		).toBe(false);
		store.close();
	});
});

function baseCaptureRequest(
	overrides?: Partial<Parameters<LifecycleStore["createCaptureRequest"]>[0]>,
): Parameters<LifecycleStore["createCaptureRequest"]>[0] {
	return {
		tenant: "t1",
		fingerprint: "telemetry:deadbeef00000000",
		findingId: 1,
		appId: "abc123",
		appName: "My App",
		objectType: "codeunit",
		objectId: 50100,
		methodName: "postorder",
		reason: "RT0018 × 5 runs, max 42000ms",
		requestedAt: "2026-07-11T00:00:00Z",
		expiresAt: "2026-07-18T00:00:00Z",
		...overrides,
	};
}

describe("LifecycleStore capture requests", () => {
	it("createCaptureRequest returns true on first insert", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		expect(
			store.createCaptureRequest(baseCaptureRequest({ findingId })),
		).toBe(true);
		expect(store.listCaptureRequests()).toHaveLength(1);
		store.close();
	});

	it("createCaptureRequest returns false when an active (pending/claimed) duplicate exists for the same (tenant, fingerprint)", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		expect(
			store.createCaptureRequest(baseCaptureRequest({ findingId })),
		).toBe(true);
		expect(
			store.createCaptureRequest(baseCaptureRequest({ findingId })),
		).toBe(false);
		expect(store.listCaptureRequests()).toHaveLength(1);
		store.close();
	});

	it("createCaptureRequest returns true again once the prior active request was fulfilled (dedupe is active-only)", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		const [row] = store.listCaptureRequests();
		store.fulfillMatchingCaptureRequests(
			"t1",
			new Set(["abc123|codeunit|50100|postorder"]),
			"profile-1",
			"2026-07-12T00:00:00Z",
		);
		expect(store.getFinding(findingId)).not.toBeNull(); // sanity: finding untouched
		expect(
			store.listCaptureRequests("t1", "fulfilled").map((r) => r.id),
		).toEqual([row.id]);
		expect(
			store.createCaptureRequest(baseCaptureRequest({ findingId })),
		).toBe(true);
		expect(store.listCaptureRequests()).toHaveLength(2);
		store.close();
	});

	it("listCaptureRequests filters by tenant and status; ordered by id", () => {
		const store = new LifecycleStore(":memory:");
		const f1 = store.insertFinding(baseFinding());
		const f2 = store.insertFinding(
			baseFinding({ fingerprint: "pattern:aaa", tenant: "t2" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f1, fingerprint: "telemetry:aaa" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({
				tenant: "t2",
				findingId: f2,
				fingerprint: "telemetry:bbb",
			}),
		);
		expect(store.listCaptureRequests("t1").map((r) => r.tenant)).toEqual([
			"t1",
		]);
		expect(store.listCaptureRequests().map((r) => r.id)).toEqual([1, 2]);
		expect(store.listCaptureRequests(undefined, "pending")).toHaveLength(2);
		expect(store.listCaptureRequests("t1", "claimed")).toHaveLength(0);
		store.close();
	});

	it("countActiveCaptureRequests counts pending + claimed only, per tenant", () => {
		const store = new LifecycleStore(":memory:");
		const f1 = store.insertFinding(baseFinding());
		const f2 = store.insertFinding(
			baseFinding({ fingerprint: "pattern:aaa" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f1, fingerprint: "telemetry:aaa" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f2, fingerprint: "telemetry:bbb" }),
		);
		const [first, second] = store.listCaptureRequests("t1");
		store.claimCaptureRequest(first.id, "executor-1", "2026-07-12T00:00:00Z");
		store.cancelCaptureRequest(second.id, "2026-07-12T00:00:00Z");
		expect(store.countActiveCaptureRequests("t1")).toBe(1); // claimed counts, cancelled doesn't
		expect(store.countActiveCaptureRequests("t2")).toBe(0);
		store.close();
	});

	it("claimCaptureRequest transitions pending -> claimed only; every other status refuses", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		const [row] = store.listCaptureRequests();

		expect(
			store.claimCaptureRequest(row.id, "executor-1", "2026-07-12T00:00:00Z"),
		).toBe(true);
		const claimed = store.listCaptureRequests()[0];
		expect(claimed.status).toBe("claimed");
		expect(claimed.claimedBy).toBe("executor-1");
		expect(claimed.claimedAt).toBe("2026-07-12T00:00:00Z");

		// already claimed -> refuse
		expect(
			store.claimCaptureRequest(row.id, "executor-2", "2026-07-13T00:00:00Z"),
		).toBe(false);

		store.cancelCaptureRequest(row.id, "2026-07-14T00:00:00Z"); // -> cancelled
		expect(
			store.claimCaptureRequest(row.id, "executor-2", "2026-07-15T00:00:00Z"),
		).toBe(false);

		const findingId2 = store.insertFinding(
			baseFinding({ fingerprint: "pattern:bbb" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({
				findingId: findingId2,
				fingerprint: "telemetry:bbb",
			}),
		);
		const expiredRow = store.listCaptureRequests().find((r) => r.id !== row.id);
		if (!expiredRow) throw new Error("expected second row");
		store.expireCaptureRequests("2027-01-01T00:00:00Z"); // -> expired
		expect(
			store.claimCaptureRequest(
				expiredRow.id,
				"executor-2",
				"2027-01-02T00:00:00Z",
			),
		).toBe(false);

		const findingId3 = store.insertFinding(
			baseFinding({ fingerprint: "pattern:ccc" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({
				findingId: findingId3,
				fingerprint: "telemetry:ccc",
			}),
		);
		const fulfilledSourceRow = store
			.listCaptureRequests()
			.find((r) => r.id !== row.id && r.id !== expiredRow.id);
		if (!fulfilledSourceRow) throw new Error("expected third row");
		store.fulfillMatchingCaptureRequests(
			"t1",
			new Set(["abc123|codeunit|50100|postorder"]),
			"profile-1",
			"2026-07-16T00:00:00Z",
		); // -> fulfilled
		expect(
			store.claimCaptureRequest(
				fulfilledSourceRow.id,
				"executor-2",
				"2026-07-17T00:00:00Z",
			),
		).toBe(false);
		store.close();
	});

	it("cancelCaptureRequest transitions pending or claimed -> cancelled", () => {
		const store = new LifecycleStore(":memory:");
		const f1 = store.insertFinding(baseFinding());
		const f2 = store.insertFinding(
			baseFinding({ fingerprint: "pattern:aaa" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f1, fingerprint: "telemetry:aaa" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f2, fingerprint: "telemetry:bbb" }),
		);
		const [pendingRow, toClaimRow] = store.listCaptureRequests();
		expect(
			store.cancelCaptureRequest(pendingRow.id, "2026-07-12T00:00:00Z"),
		).toBe(true);
		expect(store.listCaptureRequests()[0].status).toBe("cancelled");

		store.claimCaptureRequest(
			toClaimRow.id,
			"executor-1",
			"2026-07-12T00:00:00Z",
		);
		expect(
			store.cancelCaptureRequest(toClaimRow.id, "2026-07-13T00:00:00Z"),
		).toBe(true);
		expect(
			store.listCaptureRequests().find((r) => r.id === toClaimRow.id)?.status,
		).toBe("cancelled");

		// already cancelled -> refuse
		expect(
			store.cancelCaptureRequest(pendingRow.id, "2026-07-14T00:00:00Z"),
		).toBe(false);
		store.close();
	});

	it("expireCaptureRequests sweeps pending/claimed rows with expiresAt <= now, respecting the boundary", () => {
		const store = new LifecycleStore(":memory:");
		const f1 = store.insertFinding(baseFinding());
		const f2 = store.insertFinding(
			baseFinding({ fingerprint: "pattern:aaa" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({
				findingId: f1,
				fingerprint: "telemetry:aaa",
				expiresAt: "2026-07-18T00:00:00Z",
			}),
		);
		store.createCaptureRequest(
			baseCaptureRequest({
				findingId: f2,
				fingerprint: "telemetry:bbb",
				expiresAt: "2026-07-19T00:00:00Z",
			}),
		);
		// boundary: exactly at expiresAt counts as expired ("<=")
		expect(store.expireCaptureRequests("2026-07-18T00:00:00Z")).toBe(1);
		const rows = store.listCaptureRequests();
		expect(rows.find((r) => r.expiresAt === "2026-07-18T00:00:00Z")?.status).toBe(
			"expired",
		);
		expect(rows.find((r) => r.expiresAt === "2026-07-19T00:00:00Z")?.status).toBe(
			"pending",
		);
		expect(store.expireCaptureRequests("2026-07-19T00:00:00Z")).toBe(1);
		expect(
			store.listCaptureRequests().every((r) => r.status === "expired"),
		).toBe(true);
		// nothing left to expire
		expect(store.expireCaptureRequests("2026-07-20T00:00:00Z")).toBe(0);
		store.close();
	});

	it("fulfillMatchingCaptureRequests matches the exact appId|objectType|objectId|methodName join key and is tenant-scoped", () => {
		const store = new LifecycleStore(":memory:");
		const f1 = store.insertFinding(baseFinding());
		const f2 = store.insertFinding(
			baseFinding({ fingerprint: "pattern:aaa" }),
		);
		const f3 = store.insertFinding(
			baseFinding({ fingerprint: "pattern:bbb", tenant: "t2" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f1, fingerprint: "telemetry:aaa" }), // matches
		);
		store.createCaptureRequest(
			baseCaptureRequest({
				findingId: f2,
				fingerprint: "telemetry:bbb",
				methodName: "postshipment", // does not match
			}),
		);
		store.createCaptureRequest(
			baseCaptureRequest({
				tenant: "t2",
				findingId: f3,
				fingerprint: "telemetry:ccc", // same key, different tenant
			}),
		);
		const count = store.fulfillMatchingCaptureRequests(
			"t1",
			new Set(["abc123|codeunit|50100|postorder"]),
			"profile-42",
			"2026-07-20T00:00:00Z",
		);
		expect(count).toBe(1);
		const rows = store.listCaptureRequests("t1");
		const matched = rows.find((r) => r.fingerprint === "telemetry:aaa");
		expect(matched?.status).toBe("fulfilled");
		expect(matched?.fulfilledAt).toBe("2026-07-20T00:00:00Z");
		expect(matched?.fulfilledByProfileId).toBe("profile-42");
		const nonMatching = rows.find((r) => r.fingerprint === "telemetry:bbb");
		expect(nonMatching?.status).toBe("pending");
		const otherTenant = store.listCaptureRequests("t2");
		expect(otherTenant[0]?.status).toBe("pending"); // untouched despite same key
		store.close();
	});

	it("fulfillMatchingCaptureRequests also fulfills claimed (not just pending) requests", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		const [row] = store.listCaptureRequests();
		store.claimCaptureRequest(row.id, "executor-1", "2026-07-12T00:00:00Z");
		const count = store.fulfillMatchingCaptureRequests(
			"t1",
			new Set(["abc123|codeunit|50100|postorder"]),
			"profile-9",
			"2026-07-13T00:00:00Z",
		);
		expect(count).toBe(1);
		expect(store.listCaptureRequests()[0].status).toBe("fulfilled");
		store.close();
	});
});
