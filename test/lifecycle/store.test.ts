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
		expect(store.createCaptureRequest(baseCaptureRequest({ findingId }))).toBe(
			true,
		);
		expect(store.listCaptureRequests()).toHaveLength(1);
		store.close();
	});

	it("createCaptureRequest returns false when an active (pending/claimed) duplicate exists for the same (tenant, fingerprint)", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		expect(store.createCaptureRequest(baseCaptureRequest({ findingId }))).toBe(
			true,
		);
		expect(store.createCaptureRequest(baseCaptureRequest({ findingId }))).toBe(
			false,
		);
		expect(store.listCaptureRequests()).toHaveLength(1);
		store.close();
	});

	it("createCaptureRequest returns false when a claimed duplicate exists for the same (tenant, fingerprint) — the partial-unique index covers claimed, not just pending", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		expect(store.createCaptureRequest(baseCaptureRequest({ findingId }))).toBe(
			true,
		);
		const [row] = store.listCaptureRequests();
		expect(
			store.claimCaptureRequest(row.id, "executor-1", "2026-07-12T00:00:00Z"),
		).toBe(true);
		expect(store.createCaptureRequest(baseCaptureRequest({ findingId }))).toBe(
			false,
		);
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
		expect(store.createCaptureRequest(baseCaptureRequest({ findingId }))).toBe(
			true,
		);
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
		const f2 = store.insertFinding(baseFinding({ fingerprint: "pattern:aaa" }));
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f1, fingerprint: "telemetry:aaa" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f2, fingerprint: "telemetry:bbb" }),
		);
		const [first, second] = store.listCaptureRequests("t1");
		store.claimCaptureRequest(first.id, "executor-1", "2026-07-12T00:00:00Z");
		store.cancelCaptureRequest(second.id);
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

		store.cancelCaptureRequest(row.id); // -> cancelled
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
		const f2 = store.insertFinding(baseFinding({ fingerprint: "pattern:aaa" }));
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f1, fingerprint: "telemetry:aaa" }),
		);
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f2, fingerprint: "telemetry:bbb" }),
		);
		const [pendingRow, toClaimRow] = store.listCaptureRequests();
		expect(store.cancelCaptureRequest(pendingRow.id)).toBe(true);
		expect(store.listCaptureRequests()[0].status).toBe("cancelled");

		store.claimCaptureRequest(
			toClaimRow.id,
			"executor-1",
			"2026-07-12T00:00:00Z",
		);
		expect(store.cancelCaptureRequest(toClaimRow.id)).toBe(true);
		expect(
			store.listCaptureRequests().find((r) => r.id === toClaimRow.id)?.status,
		).toBe("cancelled");

		// already cancelled -> refuse
		expect(store.cancelCaptureRequest(pendingRow.id)).toBe(false);
		store.close();
	});

	it("expireCaptureRequests sweeps pending/claimed rows with expiresAt <= now, respecting the boundary", () => {
		const store = new LifecycleStore(":memory:");
		const f1 = store.insertFinding(baseFinding());
		const f2 = store.insertFinding(baseFinding({ fingerprint: "pattern:aaa" }));
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
		expect(
			rows.find((r) => r.expiresAt === "2026-07-18T00:00:00Z")?.status,
		).toBe("expired");
		expect(
			rows.find((r) => r.expiresAt === "2026-07-19T00:00:00Z")?.status,
		).toBe("pending");
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
		const f2 = store.insertFinding(baseFinding({ fingerprint: "pattern:aaa" }));
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

describe("reclaimStaleClaims", () => {
	const T0 = "2026-07-01T00:00:00Z";

	it("returns a stale claim to pending, nulls claimed_at, KEEPS claimed_by, counts the reclaim", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		const [row] = store.listCaptureRequests();
		expect(store.claimCaptureRequest(row.id, "executor-1", T0)).toBe(true);

		// 61 minutes later, with a 60-minute claim TTL.
		const reclaimed = store.reclaimStaleClaims("2026-07-01T01:01:00Z", 60);
		expect(reclaimed).toBe(1);

		const [after] = store.listCaptureRequests();
		expect(after.status).toBe("pending");
		expect(after.claimedAt).toBeNull();
		expect(after.claimedBy).toBe("executor-1"); // the breadcrumb survives
		expect(after.reclaimCount).toBe(1);
		store.close();
	});

	it("leaves a FRESH claim alone", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		const [row] = store.listCaptureRequests();
		store.claimCaptureRequest(row.id, "executor-1", T0);

		// 59 minutes later — inside the 60-minute TTL.
		expect(store.reclaimStaleClaims("2026-07-01T00:59:00Z", 60)).toBe(0);

		const [after] = store.listCaptureRequests();
		expect(after.status).toBe("claimed");
		expect(after.claimedAt).not.toBeNull();
		expect(after.reclaimCount).toBe(0);
		store.close();
	});

	it("reclaims the same row again after it is re-claimed and goes stale a second time, incrementing reclaim_count", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		const [row] = store.listCaptureRequests();
		store.claimCaptureRequest(row.id, "executor-1", T0);

		expect(store.reclaimStaleClaims("2026-07-01T01:01:00Z", 60)).toBe(1);

		// A second executor picks up the reclaimed row, then also dies.
		store.claimCaptureRequest(row.id, "executor-2", "2026-07-01T01:05:00Z");
		expect(store.reclaimStaleClaims("2026-07-01T02:06:00Z", 60)).toBe(1);

		const [after] = store.listCaptureRequests();
		expect(after.status).toBe("pending");
		expect(after.claimedBy).toBe("executor-2");
		expect(after.reclaimCount).toBe(2);
		store.close();
	});

	it("leaves a pending row (never claimed) alone", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(baseFinding());
		store.createCaptureRequest(baseCaptureRequest({ findingId }));
		// Left pending, never claimed — excluded by `claimed_at IS NOT NULL`,
		// not by the `status = 'claimed'` guard exercised below.
		expect(store.reclaimStaleClaims("2026-08-01T00:00:00Z", 60)).toBe(0);
		expect(store.listCaptureRequests()[0].status).toBe("pending");
		store.close();
	});

	it("only touches claimed rows — fulfilled/expired/cancelled requests keep their status and reclaim_count, even though claimed_at is still set and stale", () => {
		const store = new LifecycleStore(":memory:");
		const CLAIM_AT = "2026-07-01T00:00:00Z";
		const SWEEP_AT = "2026-07-01T01:01:00Z"; // 61 min later, 60-min TTL

		// Fulfilled: claimed, then fulfilled. fulfillMatchingCaptureRequests
		// does not touch claimed_at, so it stays set on a terminal row.
		const f1 = store.insertFinding(baseFinding());
		store.createCaptureRequest(
			baseCaptureRequest({ findingId: f1, fingerprint: "telemetry:aaa" }),
		);
		const [fulfilledRow] = store.listCaptureRequests("t1", "pending");
		store.claimCaptureRequest(fulfilledRow.id, "executor-1", CLAIM_AT);
		store.fulfillMatchingCaptureRequests(
			"t1",
			new Set(["abc123|codeunit|50100|postorder"]),
			"profile-1",
			"2026-07-01T00:30:00Z",
		);

		// Expired: claimed, then past its TTL. expireCaptureRequests does not
		// touch claimed_at either.
		const f2 = store.insertFinding(baseFinding({ fingerprint: "pattern:bbb" }));
		store.createCaptureRequest(
			baseCaptureRequest({
				findingId: f2,
				fingerprint: "telemetry:bbb",
				methodName: "postshipment",
				expiresAt: "2026-07-01T00:30:00Z",
			}),
		);
		const [expiredRow] = store.listCaptureRequests("t1", "pending");
		store.claimCaptureRequest(expiredRow.id, "executor-1", CLAIM_AT);
		store.expireCaptureRequests("2026-07-01T00:30:00Z");

		// Cancelled: claimed, then cancelled.
		const f3 = store.insertFinding(baseFinding({ fingerprint: "pattern:ccc" }));
		store.createCaptureRequest(
			baseCaptureRequest({
				findingId: f3,
				fingerprint: "telemetry:ccc",
				methodName: "postinvoice",
			}),
		);
		const [cancelledRow] = store.listCaptureRequests("t1", "pending");
		store.claimCaptureRequest(cancelledRow.id, "executor-1", CLAIM_AT);
		store.cancelCaptureRequest(cancelledRow.id);

		// Sanity: all three rows are in a terminal state but still carry a
		// stale claimed_at old enough to pass the TTL cutoff — if the guard
		// were missing, the sweep below would resurrect them to pending.
		const before = store.listCaptureRequests("t1");
		expect(before.map((r) => r.status).sort()).toEqual(
			["cancelled", "expired", "fulfilled"].sort(),
		);
		for (const row of before) {
			expect(row.claimedAt).toBe(CLAIM_AT);
		}

		expect(store.reclaimStaleClaims(SWEEP_AT, 60)).toBe(0);

		const after = store.listCaptureRequests("t1");
		expect(after.find((r) => r.id === fulfilledRow.id)?.status).toBe(
			"fulfilled",
		);
		expect(after.find((r) => r.id === expiredRow.id)?.status).toBe("expired");
		expect(after.find((r) => r.id === cancelledRow.id)?.status).toBe(
			"cancelled",
		);
		for (const row of after) {
			expect(row.reclaimCount).toBe(0);
		}
		store.close();
	});
});

describe("stale algo-version findings", () => {
	function seed(
		store: LifecycleStore,
		tenant: string,
		fp: string,
		algo: number,
	) {
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
		// The FK-constrained relations the purge's DELETEs actually protect
		// against: occurrences and finding_events both need a live row here or
		// removing their DELETE never trips PRAGMA foreign_keys (it stays a
		// vacuous check on empty tables). occurrences needs a run row first.
		const { runId } = store.recordRun({
			tenant: "acme",
			stream: "nightly",
			profileId: "profile-ccc",
			captureKind: "sampling",
			captureTime: "2026-07-01T00:00:00Z",
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: [], names: [] },
		});
		store.recordOccurrence({
			findingId: id,
			runId,
			captureTime: "2026-07-01T00:00:00Z",
			severity: "critical",
		});
		store.logEvent({
			findingId: id,
			event: "first-seen",
			fromState: null,
			toState: "new",
			at: "2026-07-01T00:00:00Z",
		});
		store.enqueueOutbox({
			tenant: "acme",
			sink: "github",
			kind: "file",
			findingId: id,
			payload: "{}",
			dedupeKey: "acme:github:pattern:ccccccccccccccc1",
			nextAttemptAt: "2026-07-01T00:00:00Z",
			createdAt: "2026-07-01T00:00:00Z",
		});
		// A finding at the CURRENT algo version that supersedes the doomed one —
		// the FK constraint (REFERENCES findings(id)) enforces that the pointer is
		// nulled or the reference deleted; the assertion below proves that the
		// survivor itself is preserved and its supersedes pointer is actually nulled.
		const survivorId = seed(store, "acme", "pattern:ccccccccccccccc2", 2);
		store.db.run("UPDATE findings SET supersedes = ? WHERE id = ?", [
			id,
			survivorId,
		]);

		store.purgeStaleAlgoFindings("acme", 2);

		expect(
			store.getIssueMapping("acme", "github", "pattern:ccccccccccccccc1"),
		).toBeNull();
		expect(store.getFinding(survivorId)?.supersedes).toBeNull();
		const violations = store.db.query("PRAGMA foreign_key_check").all();
		expect(violations).toEqual([]);
		store.close();
	});
});
