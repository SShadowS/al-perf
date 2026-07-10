/**
 * triggers.test.ts — trigger policy: digest-first (autoFile off ⇒ nothing),
 * hysteresis (M observed runs), severity threshold, comment routing via the
 * issue map, autoClose, viaMigration guard, label allow-listing, dedupe.
 */

import { describe, expect, it } from "bun:test";
import { processEventsForSinks } from "../../../src/lifecycle/sinks/triggers.js";
import type {
	GitHubSinkConfig,
	LifecycleSinksConfig,
	SinkDeliveryPayload,
} from "../../../src/lifecycle/sinks/types.js";
import {
	LifecycleStore,
	type NewFinding,
} from "../../../src/lifecycle/store.js";

const NOW = "2026-07-09T00:00:00Z";
const FP = "pattern:trig000000000001";

function config(gh?: Partial<GitHubSinkConfig>): LifecycleSinksConfig {
	return { sinks: { github: { enabled: true, repo: "owner/repo", ...gh } } };
}

function seedFinding(
	store: LifecycleStore,
	overrides?: Partial<NewFinding>,
): number {
	return store.insertFinding({
		tenant: "t1",
		fingerprint: FP,
		algoVersion: 1,
		state: "open",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "CalcFields inside loop",
		severity: "critical",
		appId: "",
		appName: "My App",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-05T00:00:00Z",
		lastEventAt: "2026-07-05T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
		...overrides,
	});
}

function seedOccurrences(
	store: LifecycleStore,
	findingId: number,
	n: number,
): void {
	for (let i = 0; i < n; i++) {
		const { runId } = store.recordRun({
			tenant: "t1",
			stream: "nightly",
			profileId: `p-${findingId}-${i}`,
			captureKind: "sampling",
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: [], names: [] },
		});
		store.recordOccurrence({
			findingId,
			runId,
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			severity: "critical",
			details: JSON.stringify({ evidence: "SELECT * repeated 500x" }),
		});
	}
}

function seedEvent(
	store: LifecycleStore,
	findingId: number,
	event: string,
	detail?: string,
): void {
	store.logEvent({
		findingId,
		event,
		fromState: "open",
		toState: event === "resolved" ? "resolved" : "regressed",
		at: "2026-07-05T00:00:00Z",
		detail,
	});
}

describe("processEventsForSinks — auto-file", () => {
	it("digest-first default: autoFile off enqueues nothing but marks events processed", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 3);
		seedEvent(store, id, "seen-normal");
		const report = processEventsForSinks(store, config(), NOW);
		expect(report.enqueued).toBe(0);
		expect(report.processed).toBeGreaterThan(0);
		expect(store.listUnprocessedEvents()).toHaveLength(0);
		store.close();
	});

	it("autoFile with hysteresis: files only once M observed runs are reached, deduped forever", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 1);
		seedEvent(store, id, "first-seen");
		expect(
			processEventsForSinks(
				store,
				config({ autoFile: true, autoFileAfterRuns: 2 }),
				NOW,
			).enqueued,
		).toBe(0); // only 1 occurrence — below M

		seedOccurrences(store, id, 2); // now 3 total
		seedEvent(store, id, "seen-normal");
		expect(
			processEventsForSinks(
				store,
				config({ autoFile: true, autoFileAfterRuns: 2 }),
				NOW,
			).enqueued,
		).toBe(1);
		const rows = store.listPendingOutbox("github", "create-issue");
		expect(rows).toHaveLength(1);
		expect(rows[0].dedupeKey).toBe(`github:create:t1:${FP}`);

		// Another seen event can never file a duplicate.
		seedEvent(store, id, "seen-normal");
		expect(
			processEventsForSinks(
				store,
				config({ autoFile: true, autoFileAfterRuns: 2 }),
				NOW,
			).enqueued,
		).toBe(0);
		store.close();
	});

	it("severity below the threshold never files", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store, { severity: "warning" });
		seedOccurrences(store, id, 3);
		seedEvent(store, id, "seen-normal");
		const report = processEventsForSinks(
			store,
			config({ autoFile: true, autoFileMinSeverity: "critical" }),
			NOW,
		);
		expect(report.enqueued).toBe(0);
		store.close();
	});

	it("labels are filtered against the allow-list", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 2);
		seedEvent(store, id, "seen-normal");
		processEventsForSinks(
			store,
			config({
				autoFile: true,
				labels: ["al-perf", "evil-label"],
				labelsAllowList: ["al-perf"],
			}),
			NOW,
		);
		const payload = JSON.parse(
			store.listPendingOutbox("github", "create-issue")[0].payload,
		) as SinkDeliveryPayload;
		expect(payload.labels).toEqual(["al-perf"]);
		expect(payload.finding.evidence).toContain("SELECT *");
		store.close();
	});
});

describe("processEventsForSinks — comments and close", () => {
	function withMapping(store: LifecycleStore): void {
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: FP,
			externalId: "7",
			createdAt: NOW,
		});
	}

	it("regressed/reopened comment only when an issue mapping exists", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedEvent(store, id, "seen-regressed");
		expect(processEventsForSinks(store, config(), NOW).enqueued).toBe(0); // no mapping

		withMapping(store);
		seedEvent(store, id, "reopened");
		expect(processEventsForSinks(store, config(), NOW).enqueued).toBe(1);
		expect(store.listPendingOutbox("github", "comment-regressed")).toHaveLength(
			1,
		);
		store.close();
	});

	it("resolved comments; close-issue only with autoClose", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store, { state: "resolved" });
		withMapping(store);
		seedEvent(store, id, "resolved");
		expect(processEventsForSinks(store, config(), NOW).enqueued).toBe(1); // comment only
		seedEvent(store, id, "resolved");
		expect(
			processEventsForSinks(store, config({ autoClose: true }), NOW).enqueued,
		).toBe(2);
		expect(store.listPendingOutbox("github", "close-issue")).toHaveLength(1);
		store.close();
	});

	it("viaMigration events are skipped (mass-transition guard)", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		withMapping(store);
		seedEvent(
			store,
			id,
			"seen-regressed",
			JSON.stringify({ viaMigration: true }),
		);
		const report = processEventsForSinks(store, config(), NOW);
		expect(report.enqueued).toBe(0);
		expect(report.skippedMigration).toBe(1);
		store.close();
	});

	it("a mass-migration burst produces zero deliveries even with every trigger path armed", () => {
		const store = new LifecycleStore(":memory:");
		const migrationDetail = JSON.stringify({ viaMigration: true });
		const armedConfig = config({
			autoFile: true,
			autoFileAfterRuns: 1,
			autoClose: true,
		});

		// Findings 1..5: no mapping yet, autoFile-eligible occurrence counts,
		// but every event is a migration-caused transition — the guard must
		// hold regardless of how "fileable" the finding otherwise looks.
		for (let i = 0; i < 5; i++) {
			const fid = seedFinding(store, { fingerprint: `${FP}-fresh-${i}` });
			seedOccurrences(store, fid, 2);
			seedEvent(store, fid, "seen-regressed", migrationDetail);
		}

		// Findings 6..10: already mapped to an issue, so comment/close routing
		// would normally fire on seen-regressed/resolved — still migration-caused.
		for (let i = 0; i < 5; i++) {
			const fp = `${FP}-mapped-${i}`;
			const fid = seedFinding(store, { fingerprint: fp, state: "resolved" });
			store.putIssueMapping({
				tenant: "t1",
				sink: "github",
				fingerprint: fp,
				externalId: `${100 + i}`,
				createdAt: NOW,
			});
			seedEvent(store, fid, "resolved", migrationDetail);
			seedEvent(store, fid, "seen-regressed", migrationDetail);
		}

		const report = processEventsForSinks(store, armedConfig, NOW);
		expect(report.enqueued).toBe(0);
		expect(report.skippedMigration).toBe(15);
		expect(report.processed).toBe(15);
		expect(store.listUnprocessedEvents()).toHaveLength(0);
		expect(store.listPendingOutbox("github")).toHaveLength(0);
		store.close();
	});

	it("a disabled sink leaves events unprocessed for later enablement", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedEvent(store, id, "seen-normal");
		const report = processEventsForSinks(
			store,
			{ sinks: { github: { enabled: false, repo: "owner/repo" } } },
			NOW,
		);
		expect(report.processed).toBe(0);
		expect(store.listUnprocessedEvents()).toHaveLength(1);
		store.close();
	});
});
