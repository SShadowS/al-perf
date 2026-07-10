/**
 * migrations.test.ts — applying FingerprintMigration records to the store:
 * rename (identity-upgrade), merge (both identities active), idempotency.
 */

import { describe, expect, it } from "bun:test";
import { linkFingerprints } from "../../src/lifecycle/fingerprint.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";

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
});
