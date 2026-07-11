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
});

/**
 * Builds a genuine v2 database on disk: runs the real v1 + v2 migration
 * statements directly against a raw bun:sqlite connection (bypassing
 * LifecycleStore, whose constructor would otherwise upgrade straight past
 * v2 to whatever the ladder's current head is) and inserts one pre-existing
 * `runs` row. Reopening it through LifecycleStore then exercises the real
 * v2 -> v3 migration step on open. Caller must `rmSync(dir, ...)` when done.
 */
function openV2FixtureWithOneRun(): { store: LifecycleStore; dir: string } {
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
	v2.close();
	const store = new LifecycleStore(dbPath); // runs the real ladder from user_version 2 onward
	return { store, dir };
}

describe("schema v3 (telemetry capture kind)", () => {
	it("v3 accepts telemetry capture kind; v2 data survives the runs-table rebuild", () => {
		const { store, dir } = openV2FixtureWithOneRun();
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
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
