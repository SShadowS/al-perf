/**
 * migrations.test.ts — applying FingerprintMigration records to the store:
 * rename (identity-upgrade), merge (both identities active), idempotency.
 * Also: the schema v2 -> v3 runs-table rebuild (telemetry capture kind).
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LIFECYCLE_SCHEMA_VERSION } from "../../src/lifecycle/config.js";
import { linkFingerprints } from "../../src/lifecycle/fingerprint.js";
import {
	LIFECYCLE_MIGRATIONS,
	LifecycleStore,
	type NewFinding,
} from "../../src/lifecycle/store.js";

const OLD = {
	value: "fallbackhash00001",
	namespace: "pattern" as const,
	algoVersion: 1,
};
const NEW = {
	value: "stablehash000001",
	namespace: "pattern" as const,
	algoVersion: 1,
};
const MIGRATION = linkFingerprints(OLD, NEW, "identity-upgrade");

function finding(
	fingerprint: string,
	overrides?: Partial<NewFinding>,
): NewFinding {
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
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("renamed");
		expect(
			store.getActiveFinding("t1", "pattern:fallbackhash00001"),
		).toBeNull();
		expect(store.getActiveFinding("t1", "pattern:stablehash000001")?.id).toBe(
			id,
		);
		const events = store.listEvents(id);
		expect(events[events.length - 1]?.event).toBe("migrated");
		expect(events[events.length - 1]?.detail).toContain("viaMigration");
		store.close();
	});

	it("merges when both identities are active: history moves, old row closes", () => {
		const store = new LifecycleStore(":memory:");
		const oldId = store.insertFinding(
			finding("pattern:fallbackhash00001", {
				firstSeenAt: "2026-06-01T00:00:00Z",
			}),
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
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("merged");
		const merged = store.getActiveFinding("t1", "pattern:stablehash000001");
		expect(merged?.id).toBe(newId);
		expect(merged?.firstSeenAt).toBe("2026-06-01T00:00:00Z"); // earlier wins
		expect(store.countOccurrences(newId)).toBe(1); // moved
		expect(store.getFinding(oldId)?.state).toBe("closed");
		// The from-row's own id still carries a record of how it ended, even
		// though its prior history was reassigned to the to-row.
		const fromEvents = store.listEvents(oldId);
		expect(fromEvents).toHaveLength(1);
		expect(fromEvents[0]?.event).toBe("merged-away");
		expect(fromEvents[0]?.detail).toContain("viaMigration");
		store.close();
	});

	it("is idempotent: a second application is a no-op", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(finding("pattern:fallbackhash00001"));
		expect(
			store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z"),
		).toBe("renamed");
		expect(
			store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z"),
		).toBe("no-op");
		store.close();
	});

	it("no active from-finding is a recorded no-op", () => {
		const store = new LifecycleStore(":memory:");
		expect(
			store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z"),
		).toBe("no-op");
		const row = store.db
			.query<{ n: number }, []>(
				"SELECT count(*) AS n FROM fingerprint_migrations",
			)
			.get();
		expect(row?.n).toBe(1);
		store.close();
	});

	it("an existing migration audit row does NOT permanently block a LATER rekey once a from-finding actually appears (I1 regression)", () => {
		const store = new LifecycleStore(":memory:");
		// First application: no from-finding exists yet (e.g. a run without
		// fusion, or the al-sem engine was down) — recorded as a no-op, same as
		// "no active from-finding is a recorded no-op" above.
		expect(
			store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z"),
		).toBe("no-op");

		// A later run (still without fusion, or before the engine came back)
		// files a fresh finding under the fallback fingerprint — this is the
		// exact duplicate-forking scenario the branch exists to prevent.
		const id = store.insertFinding(finding("pattern:fallbackhash00001"));

		// The SAME migration is applied again (a subsequent fused run). The
		// audit row from the first application already exists (INSERT OR
		// IGNORE no-ops on it), but that must NOT suppress the rekey now that
		// an active from-finding is actually present — otherwise this finding
		// is permanently stuck at F1, unmergeable, flapping seen/absent.
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-09T00:00:00Z",
		);
		expect(outcome).toBe("renamed");
		expect(
			store.getActiveFinding("t1", "pattern:fallbackhash00001"),
		).toBeNull();
		expect(store.getActiveFinding("t1", "pattern:stablehash000001")?.id).toBe(
			id,
		);
		store.close();
	});

	it("PK collision: a run present under both identities keeps the to-row's occurrence", () => {
		const store = new LifecycleStore(":memory:");
		const oldId = store.insertFinding(finding("pattern:fallbackhash00001"));
		const newId = store.insertFinding(finding("pattern:stablehash000001"));
		const { runId } = store.recordRun({
			tenant: "t1",
			stream: "nightly",
			profileId: "p-shared",
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
		store.recordOccurrence({
			findingId: newId,
			runId,
			captureTime: "2026-06-01T00:00:00Z",
			severity: "critical",
		});
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("merged");
		expect(store.countOccurrences(newId)).toBe(1); // no error, no duplicate
		const occ = store.db
			.query<{ severity: string }, [number, number]>(
				"SELECT severity FROM occurrences WHERE finding_id = ? AND run_id = ?",
			)
			.get(newId, runId);
		expect(occ?.severity).toBe("critical"); // to-row's own occurrence survives
		store.close();
	});

	it("merge revives a resolved to-row absorbing a still-live from-row, and logs a reopened event", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(
			finding("pattern:fallbackhash00001", { state: "open" }),
		);
		const newId = store.insertFinding(
			finding("pattern:stablehash000001", {
				state: "resolved",
				severity: "info",
			}),
		);
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("merged");
		const merged = store.getActiveFinding("t1", "pattern:stablehash000001");
		expect(merged?.id).toBe(newId);
		expect(merged?.state).toBe("open"); // revived into the from-row's live state
		expect(merged?.resolvedAt).toBeNull();
		expect(merged?.severity).toBe("warning"); // more severe of info/warning wins
		const reopened = store
			.listEvents(newId)
			.find((e) => e.event === "reopened");
		expect(reopened).toBeDefined();
		expect(reopened?.detail).toContain("reopenedByMerge");
		store.close();
	});

	it("merge adopts the fresher row's absence_count (the identity most recently actually seen)", () => {
		const store = new LifecycleStore(":memory:");
		const oldId = store.insertFinding(
			finding("pattern:fallbackhash00001", {
				lastSeenAt: "2026-07-05T00:00:00Z",
			}),
		);
		store.insertFinding(
			finding("pattern:stablehash000001", {
				lastSeenAt: "2026-07-01T00:00:00Z",
			}),
		);
		// oldId has since racked up absences, but last_seen_at (its last true
		// observation) stays the fresher of the two — markAbsent never moves it.
		store.markAbsent(oldId, {
			state: "open",
			absenceCount: 2,
			captureTime: "2026-07-06T00:00:00Z",
		});
		expect(store.getFinding(oldId)?.lastSeenAt).toBe("2026-07-05T00:00:00Z");
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("merged");
		const merged = store.getActiveFinding("t1", "pattern:stablehash000001");
		expect(merged?.lastSeenAt).toBe("2026-07-05T00:00:00Z");
		expect(merged?.absenceCount).toBe(2);
		store.close();
	});

	it("a crash mid-merge rolls back the WHOLE migration — record, rows, and occurrences all revert; a retry re-applies cleanly", () => {
		const store = new LifecycleStore(":memory:");
		const oldId = store.insertFinding(finding("pattern:fallbackhash00001"));
		const newId = store.insertFinding(finding("pattern:stablehash000001"));
		const { runId } = store.recordRun({
			tenant: "t1",
			stream: "nightly",
			profileId: "p-crash",
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

		// Force the SECOND logEvent call (the "merged" event, after the
		// from-row's own "merged-away" audit event already ran) to throw,
		// simulating a mid-merge crash.
		let calls = 0;
		const originalLogEvent = store.logEvent.bind(store);
		store.logEvent = (e) => {
			calls++;
			if (calls === 2) throw new Error("simulated crash");
			return originalLogEvent(e);
		};

		expect(() =>
			store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z"),
		).toThrow("simulated crash");

		// Nothing from the failed attempt persisted: not the migration record,
		// not either finding's state, not the occurrence.
		const row = store.db
			.query<{ n: number }, []>(
				"SELECT count(*) AS n FROM fingerprint_migrations",
			)
			.get();
		expect(row?.n).toBe(0);
		expect(store.getFinding(oldId)?.state).toBe("open");
		expect(store.getFinding(newId)?.state).toBe("open");
		expect(store.countOccurrences(oldId)).toBe(1);
		expect(store.countOccurrences(newId)).toBe(0);

		// Retry with the real logEvent — applies cleanly, no residue.
		store.logEvent = originalLogEvent;
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("merged");
		expect(store.getFinding(oldId)?.state).toBe("closed");
		expect(store.countOccurrences(newId)).toBe(1);
		store.close();
	});

	it("rename rekeys the sink issue mapping — comment routing still finds the issue under the new fingerprint", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(finding("pattern:fallbackhash00001"));
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:fallbackhash00001",
			externalId: "42",
			createdAt: "2026-07-01T00:00:00Z",
		});
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("renamed");
		expect(
			store.getIssueMapping("t1", "github", "pattern:fallbackhash00001"),
		).toBeNull();
		const rekeyed = store.getIssueMapping(
			"t1",
			"github",
			"pattern:stablehash000001",
		);
		expect(rekeyed?.externalId).toBe("42");
		store.close();
	});

	it("rename survives a stale mapping already parked under the to-fingerprint (PK collision) — the live from-row's mapping wins, and a retry no-ops without throwing", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(finding("pattern:fallbackhash00001"));
		// Stale: left behind by a finding that was previously closed under the
		// to-fingerprint. Mappings are never deleted on close, so this can
		// coexist with a live finding under a different fingerprint.
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:stablehash000001",
			externalId: "99",
			createdAt: "2026-06-01T00:00:00Z",
		});
		// Live: the from-row's own mapping.
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:fallbackhash00001",
			externalId: "42",
			createdAt: "2026-07-01T00:00:00Z",
		});
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("renamed");
		expect(
			store.getIssueMapping("t1", "github", "pattern:fallbackhash00001"),
		).toBeNull();
		const rekeyed = store.getIssueMapping(
			"t1",
			"github",
			"pattern:stablehash000001",
		);
		expect(rekeyed?.externalId).toBe("42"); // live from-row wins; stale row lost

		// Retry (e.g. after a crash before the migration was recorded elsewhere,
		// or simply re-running the same migration batch) must be a clean no-op,
		// not a re-throw of the same PK collision.
		expect(() =>
			store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z"),
		).not.toThrow();
		expect(
			store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z"),
		).toBe("no-op");
		store.close();
	});

	it("merge repoints the from-row's mapping onto the to-fingerprint when the to-fingerprint has none", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(finding("pattern:fallbackhash00001"));
		store.insertFinding(finding("pattern:stablehash000001"));
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:fallbackhash00001",
			externalId: "7",
			createdAt: "2026-07-01T00:00:00Z",
		});
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("merged");
		expect(
			store.getIssueMapping("t1", "github", "pattern:fallbackhash00001"),
		).toBeNull();
		const repointed = store.getIssueMapping(
			"t1",
			"github",
			"pattern:stablehash000001",
		);
		expect(repointed?.externalId).toBe("7");
		store.close();
	});

	it("merge keeps the to-row's mapping as canonical and discards the from-row's when both are mapped", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(finding("pattern:fallbackhash00001"));
		store.insertFinding(finding("pattern:stablehash000001"));
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:fallbackhash00001",
			externalId: "7",
			createdAt: "2026-07-01T00:00:00Z",
		});
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:stablehash000001",
			externalId: "99",
			createdAt: "2026-07-02T00:00:00Z",
		});
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("merged");
		expect(
			store.getIssueMapping("t1", "github", "pattern:fallbackhash00001"),
		).toBeNull();
		const canonical = store.getIssueMapping(
			"t1",
			"github",
			"pattern:stablehash000001",
		);
		expect(canonical?.externalId).toBe("99"); // to-row's own issue survives
		store.close();
	});

	function captureRequest(
		overrides: Partial<Parameters<LifecycleStore["createCaptureRequest"]>[0]> &
			Pick<
				Parameters<LifecycleStore["createCaptureRequest"]>[0],
				"fingerprint" | "findingId"
			>,
	): Parameters<LifecycleStore["createCaptureRequest"]>[0] {
		return {
			tenant: "t1",
			appId: "app1",
			appName: null,
			objectType: "codeunit",
			objectId: 50100,
			methodName: "postorder",
			reason: "RT0018 × 5 runs, max 42000ms",
			requestedAt: "2026-07-01T00:00:00Z",
			expiresAt: "2026-07-08T00:00:00Z",
			...overrides,
		};
	}

	it("rename repoints an active capture request onto the new fingerprint, keeping it active", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(finding("pattern:fallbackhash00001"));
		store.createCaptureRequest(
			captureRequest({ fingerprint: "pattern:fallbackhash00001", findingId }),
		);
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("renamed");
		const requests = store.listCaptureRequests("t1");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.fingerprint).toBe("pattern:stablehash000001");
		expect(requests[0]?.status).toBe("pending");
		store.close();
	});

	it("rename survives an active capture request already parked under the to-fingerprint (PK collision) — the live from-row wins, and a retry no-ops without throwing", () => {
		const store = new LifecycleStore(":memory:");
		const fromFindingId = store.insertFinding(
			finding("pattern:fallbackhash00001"),
		);
		const otherFindingId = store.insertFinding(
			finding("pattern:otherfinding001"),
		);
		// Pre-existing, unrelated active request already sitting at the
		// to-fingerprint.
		store.createCaptureRequest(
			captureRequest({
				fingerprint: "pattern:stablehash000001",
				findingId: otherFindingId,
				reason: "stale ask",
				requestedAt: "2026-06-01T00:00:00Z",
			}),
		);
		// The from-row's own, live request.
		store.createCaptureRequest(
			captureRequest({
				fingerprint: "pattern:fallbackhash00001",
				findingId: fromFindingId,
				reason: "live ask",
			}),
		);
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("renamed");
		const pending = store.listCaptureRequests("t1", "pending");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.reason).toBe("live ask"); // live from-row wins; stale row lost
		expect(pending[0]?.fingerprint).toBe("pattern:stablehash000001");

		// Retry (e.g. after a crash, or simply re-running the same batch) must
		// be a clean no-op, not a re-throw of the same PK collision.
		expect(() =>
			store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z"),
		).not.toThrow();
		expect(
			store.applyFingerprintMigration("t1", MIGRATION, "2026-07-08T00:00:00Z"),
		).toBe("no-op");
		store.close();
	});

	it("rename rekeys a terminal (fulfilled) capture request too, for fingerprint coherence", () => {
		const store = new LifecycleStore(":memory:");
		const findingId = store.insertFinding(finding("pattern:fallbackhash00001"));
		store.createCaptureRequest(
			captureRequest({ fingerprint: "pattern:fallbackhash00001", findingId }),
		);
		const [req] = store.listCaptureRequests("t1");
		store.db.run(
			"UPDATE capture_requests SET status = 'fulfilled', fulfilled_at = ?, fulfilled_by_profile_id = ? WHERE id = ?",
			["2026-06-05T00:00:00Z", "p1", req?.id],
		);
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("renamed");
		const fulfilled = store.listCaptureRequests("t1", "fulfilled");
		expect(fulfilled).toHaveLength(1);
		expect(fulfilled[0]?.fingerprint).toBe("pattern:stablehash000001");
		store.close();
	});

	it("merge repoints the from-row's active capture request onto the to-fingerprint when the to-fingerprint has none", () => {
		const store = new LifecycleStore(":memory:");
		const fromFindingId = store.insertFinding(
			finding("pattern:fallbackhash00001"),
		);
		store.insertFinding(finding("pattern:stablehash000001"));
		store.createCaptureRequest(
			captureRequest({
				fingerprint: "pattern:fallbackhash00001",
				findingId: fromFindingId,
			}),
		);
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("merged");
		const requests = store.listCaptureRequests("t1", "pending");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.fingerprint).toBe("pattern:stablehash000001");
		store.close();
	});

	it("merge cancels the from-row's active capture request when the to-fingerprint already has one (duplicate ask, not harmful)", () => {
		const store = new LifecycleStore(":memory:");
		const fromFindingId = store.insertFinding(
			finding("pattern:fallbackhash00001"),
		);
		const toFindingId = store.insertFinding(
			finding("pattern:stablehash000001"),
		);
		store.createCaptureRequest(
			captureRequest({
				fingerprint: "pattern:fallbackhash00001",
				findingId: fromFindingId,
				reason: "from ask",
				requestedAt: "2026-07-01T00:00:00Z",
			}),
		);
		store.createCaptureRequest(
			captureRequest({
				fingerprint: "pattern:stablehash000001",
				findingId: toFindingId,
				reason: "to ask",
				requestedAt: "2026-07-02T00:00:00Z",
			}),
		);
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("merged");
		const pending = store.listCaptureRequests("t1", "pending");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.reason).toBe("to ask"); // to-row's own request survives
		const cancelled = store.listCaptureRequests("t1", "cancelled");
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0]?.reason).toBe("from ask");
		// Cancelling doesn't exempt it from "rekey every row for tenant+from" —
		// it stays coherent with every other row instead of being the lone
		// row still parked at the old identity.
		expect(cancelled[0]?.fingerprint).toBe("pattern:stablehash000001");
		store.close();
	});

	it("no-op migration (no active finding under from) leaves capture_requests untouched", () => {
		const store = new LifecycleStore(":memory:");
		// A finding exists (to satisfy the FK) under a DIFFERENT fingerprint
		// than the one the capture request itself claims — the migration's
		// `from` never resolves to an active finding, so it must no-op before
		// touching anything, capture_requests included.
		const anchorFindingId = store.insertFinding(
			finding("pattern:unrelatedanchor1"),
		);
		store.createCaptureRequest(
			captureRequest({
				fingerprint: "pattern:fallbackhash00001",
				findingId: anchorFindingId,
			}),
		);
		const outcome = store.applyFingerprintMigration(
			"t1",
			MIGRATION,
			"2026-07-08T00:00:00Z",
		);
		expect(outcome).toBe("no-op");
		const requests = store.listCaptureRequests("t1");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.fingerprint).toBe("pattern:fallbackhash00001");
		store.close();
	});
});

/**
 * Builds a genuine v2 database on disk: runs the real v1 + v2 migration
 * statements directly against a raw bun:sqlite connection (bypassing
 * LifecycleStore, whose constructor would otherwise upgrade straight past
 * v2 to whatever the ladder's current head is) and inserts one pre-existing
 * `runs` row PLUS an `occurrences` row and a `finding_events` row that hold
 * live foreign-key references to it (and to a `findings` row, to satisfy
 * their own `finding_id` FK). This is the exact shape that makes `DROP
 * TABLE runs` fail under `foreign_keys = ON` — a run row with no
 * FK-referencing children would rebuild cleanly even if the migrate() FK
 * toggle were removed, silently passing a migration test that isn't
 * actually exercising the mechanism it claims to guard.
 * Reopening the DB through LifecycleStore then exercises the real v2 -> v3
 * migration step on open. Caller must `rmSync(dir, ...)` when done.
 */
function openV2FixtureWithOneRun(): {
	store: LifecycleStore;
	dir: string;
	runId: number;
	findingId: number;
} {
	const dir = mkdtempSync(join(tmpdir(), "alperf-migrations-v3-"));
	const dbPath = join(dir, "lifecycle.sqlite");
	const v2 = new Database(dbPath, { create: true });
	for (const stmt of LIFECYCLE_MIGRATIONS[0]) v2.run(stmt);
	for (const stmt of LIFECYCLE_MIGRATIONS[1]) v2.run(stmt);
	v2.run("PRAGMA user_version = 2");
	v2.run(
		`INSERT INTO runs (tenant, stream, profile_id, capture_kind, capture_time, version_stamp, incomplete, exercised_apps, created_at)
		 VALUES ('t', 'nightly', 'existing-profile', 'sampling', '2026-07-01T00:00:00.000Z', '', 0, '[]', '2026-07-01T00:00:00.000Z')`,
	);
	const runId = v2
		.query<{ id: number }, []>(
			"SELECT id FROM runs WHERE profile_id = 'existing-profile'",
		)
		.get()?.id as number;
	v2.run(
		`INSERT INTO findings (tenant, fingerprint, algo_version, state, source, pattern_id, title, severity, first_seen_at, last_seen_at, last_event_at)
		 VALUES ('t', 'pattern:existingfinding01', 1, 'open', 'pattern', 'x', 'x', 'warning', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
	);
	const findingId = v2
		.query<{ id: number }, []>(
			"SELECT id FROM findings WHERE fingerprint = 'pattern:existingfinding01'",
		)
		.get()?.id as number;
	v2.run(
		`INSERT INTO occurrences (finding_id, run_id, capture_time, severity)
		 VALUES (?, ?, '2026-07-01T00:00:00.000Z', 'warning')`,
		[findingId, runId],
	);
	v2.run(
		`INSERT INTO finding_events (finding_id, run_id, event, from_state, to_state, at)
		 VALUES (?, ?, 'first-seen', NULL, 'open', '2026-07-01T00:00:00.000Z')`,
		[findingId, runId],
	);
	v2.close();
	const store = new LifecycleStore(dbPath); // runs the real ladder from user_version 2 onward
	return { store, dir, runId, findingId };
}

/**
 * Builds a genuine v3 database on disk: runs the real v1 + v2 + v3
 * migration statements directly against a raw bun:sqlite connection
 * (bypassing LifecycleStore, whose constructor would otherwise upgrade
 * straight past v3 to whatever the ladder's current head is) and inserts
 * one pre-existing `findings` row. Reopening the DB through LifecycleStore
 * then exercises the real v3 -> v4 migration step on open. Caller must
 * `rmSync(dir, ...)` when done.
 */
function openV3FixtureWithOneFinding(): {
	store: LifecycleStore;
	dir: string;
	findingId: number;
} {
	const dir = mkdtempSync(join(tmpdir(), "alperf-migrations-v4-"));
	const dbPath = join(dir, "lifecycle.sqlite");
	const v3 = new Database(dbPath, { create: true });
	for (const stmts of LIFECYCLE_MIGRATIONS.slice(0, 3)) {
		for (const stmt of stmts) v3.run(stmt);
	}
	v3.run("PRAGMA user_version = 3");
	v3.run(
		`INSERT INTO findings (tenant, fingerprint, algo_version, state, source, pattern_id, title, severity, first_seen_at, last_seen_at, last_event_at)
		 VALUES ('t', 'telemetry:existingfinding0', 1, 'open', 'telemetry', 'x', 'x', 'warning', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
	);
	const findingId = v3
		.query<{ id: number }, []>(
			"SELECT id FROM findings WHERE fingerprint = 'telemetry:existingfinding0'",
		)
		.get()?.id as number;
	v3.close();
	const store = new LifecycleStore(dbPath); // runs the real ladder from user_version 3 onward
	return { store, dir, findingId };
}

/**
 * Builds a genuine v4 database on disk: runs the real v1..v4 migration
 * statements directly against a raw bun:sqlite connection (bypassing
 * LifecycleStore, whose constructor would otherwise upgrade straight past
 * v4 to whatever the ladder's current head is) and inserts one pre-existing,
 * already needs-triage `findings` row. Reopening the DB through
 * LifecycleStore then exercises the real v4 -> v5 migration step on open.
 * Caller must `rmSync(dir, ...)` when done.
 */
function openV4FixtureWithOneFinding(): {
	store: LifecycleStore;
	dir: string;
	findingId: number;
} {
	const dir = mkdtempSync(join(tmpdir(), "alperf-migrations-v5-"));
	const dbPath = join(dir, "lifecycle.sqlite");
	const v4 = new Database(dbPath, { create: true });
	for (const stmts of LIFECYCLE_MIGRATIONS.slice(0, 4)) {
		for (const stmt of stmts) v4.run(stmt);
	}
	v4.run("PRAGMA user_version = 4");
	v4.run(
		`INSERT INTO findings (tenant, fingerprint, algo_version, state, needs_triage, source, pattern_id, title, severity, first_seen_at, last_seen_at, last_event_at)
		 VALUES ('t', 'pattern:existingfinding02', 1, 'open', 1, 'pattern', 'x', 'x', 'warning', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
	);
	const findingId = v4
		.query<{ id: number }, []>(
			"SELECT id FROM findings WHERE fingerprint = 'pattern:existingfinding02'",
		)
		.get()?.id as number;
	v4.close();
	const store = new LifecycleStore(dbPath); // runs the real ladder from user_version 4 onward
	return { store, dir, findingId };
}

/**
 * Builds a genuine v5 database on disk: runs the real v1..v5 migration
 * statements directly against a raw bun:sqlite connection (bypassing
 * LifecycleStore, whose constructor would otherwise upgrade straight past
 * v5 to whatever the ladder's current head is), maps one finding to github
 * via `sink_issue_map` (proof that github has already filed something for
 * this tenant, not merely an enabled-but-idle config block), and inserts
 * `total` `finding_events` rows of which the first `processed` already carry
 * the OLD global `sink_processed = 1` bit. Reopening the DB through
 * LifecycleStore then exercises the real v5 -> v6 migration step on open —
 * specifically the `sink_progress` seed, which decides once and
 * irreversibly, on every existing production store, whether each sink
 * resumes where it left off or replays its whole history.
 * Caller must `rmSync(dir, ...)` when done.
 */
function openV5FixtureWithSinkHistory(
	total: number,
	processed: number,
): { store: LifecycleStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "alperf-migrations-v6-"));
	const dbPath = join(dir, "lifecycle.sqlite");
	const v5 = new Database(dbPath, { create: true });
	for (const stmts of LIFECYCLE_MIGRATIONS.slice(0, 5)) {
		for (const stmt of stmts) v5.run(stmt);
	}
	v5.run("PRAGMA user_version = 5");
	v5.run(
		`INSERT INTO findings (tenant, fingerprint, algo_version, state, source, pattern_id, title, severity, first_seen_at, last_seen_at, last_event_at)
		 VALUES ('t', 'pattern:v6seedhistory01', 1, 'open', 'pattern', 'x', 'x', 'warning', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
	);
	const findingId = v5
		.query<{ id: number }, []>(
			"SELECT id FROM findings WHERE fingerprint = 'pattern:v6seedhistory01'",
		)
		.get()?.id as number;
	v5.run(
		`INSERT INTO sink_issue_map (tenant, sink, fingerprint, external_id, created_at)
		 VALUES ('t', 'github', 'pattern:v6seedhistory01', '42', '2026-07-01T00:00:00.000Z')`,
	);
	for (let i = 0; i < total; i++) {
		v5.run(
			`INSERT INTO finding_events (finding_id, event, from_state, to_state, at, sink_processed)
			 VALUES (?, 'seen-normal', 'open', 'open', '2026-07-01T00:00:00.000Z', ?)`,
			[findingId, i < processed ? 1 : 0],
		);
	}
	v5.close();
	const store = new LifecycleStore(dbPath); // runs the real ladder from user_version 5 onward
	return { store, dir };
}

/**
 * Builds a genuine v6 database on disk with one finding and one
 * capture_requests row inserted directly (v6 predates the reclaim_count
 * column, so the raw INSERT can't set it). Reopening through LifecycleStore
 * exercises the real v6 -> v7 migration step: the additive
 * `ALTER TABLE capture_requests ADD COLUMN reclaim_count INTEGER NOT NULL
 * DEFAULT 0`. Caller must `rmSync(dir, ...)` when done.
 */
function openV6FixtureWithCaptureRequest(): {
	store: LifecycleStore;
	dir: string;
	captureRequestId: number;
} {
	const dir = mkdtempSync(join(tmpdir(), "alperf-migrations-v7-"));
	const dbPath = join(dir, "lifecycle.sqlite");
	const v6 = new Database(dbPath, { create: true });
	for (const stmts of LIFECYCLE_MIGRATIONS.slice(0, 6)) {
		for (const stmt of stmts) v6.run(stmt);
	}
	v6.run("PRAGMA user_version = 6");
	v6.run(
		`INSERT INTO findings (tenant, fingerprint, algo_version, state, needs_triage, source, pattern_id, title, severity, first_seen_at, last_seen_at, last_event_at)
		 VALUES ('t', 'telemetry:existingfinding03', 1, 'open', 0, 'telemetry', 'x', 'x', 'warning', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
	);
	const findingId = v6
		.query<{ id: number }, []>(
			"SELECT id FROM findings WHERE fingerprint = 'telemetry:existingfinding03'",
		)
		.get()?.id as number;
	v6.run(
		`INSERT INTO capture_requests (tenant, fingerprint, finding_id, app_id, app_name, object_type, object_id, method_name, reason, requested_at, expires_at)
		 VALUES ('t', 'telemetry:existingfinding03', ?, 'abc123', 'My App', 'codeunit', 50100, 'postorder', 'RT0018 x 5 runs', '2026-07-01T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`,
		[findingId],
	);
	const captureRequestId = v6
		.query<{ id: number }, []>(
			"SELECT id FROM capture_requests WHERE fingerprint = 'telemetry:existingfinding03'",
		)
		.get()?.id as number;
	v6.close();
	const store = new LifecycleStore(dbPath); // runs the real ladder from user_version 6 onward
	return { store, dir, captureRequestId };
}

describe("schema v7 (capture request reclaim_count)", () => {
	it("v7 adds reclaim_count to existing capture_requests rows as 0, not NULL; v6 data survives, no dangling FKs, DB lands on the current schema head", () => {
		const { store, dir, captureRequestId } = openV6FixtureWithCaptureRequest();
		try {
			expect(
				store.db
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version,
			).toBe(LIFECYCLE_SCHEMA_VERSION);
			// rowToCaptureRequest coalesces reclaim_count with `?? 0`, which would
			// mask a NULL — assert on the raw column via a direct query instead,
			// so a broken migration (ADD COLUMN without DEFAULT 0) can't hide.
			const raw = store.db
				.query<{ reclaim_count: number | null }, [number]>(
					"SELECT reclaim_count FROM capture_requests WHERE id = ?",
				)
				.get(captureRequestId);
			expect(raw?.reclaim_count).toBe(0);
			// pre-migration row survived untouched
			expect(
				store.listCaptureRequests().find((r) => r.id === captureRequestId)
					?.fingerprint,
			).toBe("telemetry:existingfinding03");
			expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("schema v6 (per-sink watermark seed)", () => {
	it("resumes a sink that has already filed at the last event it scanned under the old global bit, and leaves an unmapped sink at 0", () => {
		// N=10 events, the first M=6 already flagged sink_processed=1 under the
		// old global bit. This straddles both failure modes a broken seed can
		// take: seeding past event 6 silently drops events 7-10 forever (the
		// seed runs exactly once, so a dropped event is never redelivered);
		// seeding at 0 instead of 6 replays events 1-6 that github already
		// handled.
		const TOTAL = 10;
		const ALREADY_PROCESSED = 6;
		const { store, dir } = openV5FixtureWithSinkHistory(
			TOTAL,
			ALREADY_PROCESSED,
		);
		try {
			expect(
				store.db
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version,
			).toBe(LIFECYCLE_SCHEMA_VERSION);
			expect(store.getSinkProgress("github")).toBe(ALREADY_PROCESSED);
			expect(store.getSinkProgress("azureDevOps")).toBe(0);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("schema v5 (triage notes)", () => {
	it("v5 adds triage_note/triaged_at/triaged_by; v4 data survives, no dangling FKs, DB lands on the current schema head", () => {
		const { store, dir, findingId } = openV4FixtureWithOneFinding();
		try {
			expect(
				store.db
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version,
			).toBe(LIFECYCLE_SCHEMA_VERSION);
			// Pre-migration finding row survived untouched; the new columns
			// default to NULL (additive ALTER TABLE, no backfill).
			const before = store.getFinding(findingId);
			expect(before?.fingerprint).toBe("pattern:existingfinding02");
			expect(before?.needsTriage).toBe(true);
			expect(before?.triageNote).toBeNull();
			expect(before?.triagedAt).toBeNull();
			expect(before?.triagedBy).toBeNull();
			expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);

			// The new columns are actually usable post-migration.
			expect(
				store.recordTriage(
					findingId,
					"benign — expected fan-out",
					"agent-triage",
					"2026-07-12T00:00:00.000Z",
				),
			).toBe(true);
			const after = store.getFinding(findingId);
			expect(after?.needsTriage).toBe(false);
			expect(after?.triageNote).toBe("benign — expected fan-out");
			expect(after?.triagedBy).toBe("agent-triage");
			expect(after?.triagedAt).toBe("2026-07-12T00:00:00.000Z");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("schema v4 (capture request queue)", () => {
	it("v4 adds capture_requests; v3 data survives, no dangling FKs, DB lands on the current schema head", () => {
		const { store, dir, findingId } = openV3FixtureWithOneFinding();
		try {
			// Reopening through LifecycleStore always migrates to the ladder's
			// current head, not just one step — this DB started at v3 and (as
			// of schema v5) passes through v4 on its way to v5.
			expect(
				store.db
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version,
			).toBe(LIFECYCLE_SCHEMA_VERSION);
			const tables = store.db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table'",
				)
				.all()
				.map((r) => r.name);
			expect(tables).toContain("capture_requests");
			// pre-migration finding row survived untouched
			expect(store.getFinding(findingId)?.fingerprint).toBe(
				"telemetry:existingfinding0",
			);
			expect(
				store.createCaptureRequest({
					tenant: "t",
					fingerprint: "telemetry:existingfinding0",
					findingId,
					appId: "abc123",
					appName: "My App",
					objectType: "codeunit",
					objectId: 50100,
					methodName: "postorder",
					reason: "RT0018 × 5 runs, max 42000ms",
					requestedAt: "2026-07-11T00:00:00.000Z",
					expiresAt: "2026-07-18T00:00:00.000Z",
				}),
			).toBe(true);
			expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("schema v3 (telemetry capture kind)", () => {
	it("v3 accepts telemetry capture kind; v2 data (including FK-child rows) survives the runs-table rebuild", () => {
		const { store, dir, runId, findingId } = openV2FixtureWithOneRun();
		try {
			const rec = store.recordRun({
				tenant: "t",
				stream: "telemetry",
				profileId: "batch-1",
				captureKind: "telemetry",
				captureTime: "2026-07-11T00:00:00.000Z",
				versionStamp: "",
				incomplete: false,
				exercisedApps: { ids: [], names: [] },
			});
			expect(rec.duplicate).toBe(false);
			// pre-migration run row survived the table rebuild byte-for-byte
			const preExisting = store.getRun("t", "existing-profile");
			expect(preExisting).toBeTruthy();
			expect(preExisting?.captureKind).toBe("sampling");
			expect(preExisting?.stream).toBe("nightly");
			expect(preExisting?.captureTime).toBe("2026-07-01T00:00:00.000Z");
			// the rebuild preserves ids (explicit id copy + carried-over
			// AUTOINCREMENT sequence), so the FK-child rows below can still be
			// found by the same run_id/finding_id captured before migration.
			expect(preExisting?.id).toBe(runId);

			// The occurrences/finding_events rows that held live FK references
			// to this run before the rebuild must still resolve to it — this is
			// the exact mechanism the migrate() foreign_keys toggle protects.
			// Without that toggle, DROP TABLE runs throws while these rows are
			// still live, so this assertion fails loudly if the toggle is ever
			// removed (a fixture with no FK-referencing children would not).
			const occurrence = store.db
				.query<{ finding_id: number; run_id: number }, [number, number]>(
					"SELECT finding_id, run_id FROM occurrences WHERE finding_id = ? AND run_id = ?",
				)
				.get(findingId, runId);
			expect(occurrence).toEqual({ finding_id: findingId, run_id: runId });

			const event = store.db
				.query<{ event: string; run_id: number | null }, [number]>(
					"SELECT event, run_id FROM finding_events WHERE finding_id = ?",
				)
				.get(findingId);
			expect(event).toEqual({ event: "first-seen", run_id: runId });

			// Both children's run_id still joins to a live runs row (not
			// dangling) — the direct DB-level confirmation that the rebuild
			// didn't orphan them.
			const joined = store.db
				.query<{ n: number }, [number]>(
					`SELECT count(*) AS n FROM occurrences o
					 JOIN runs r ON r.id = o.run_id
					 WHERE o.run_id = ?`,
				)
				.get(runId);
			expect(joined?.n).toBe(1);

			// No dangling foreign keys anywhere in the store after the rebuild.
			expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
