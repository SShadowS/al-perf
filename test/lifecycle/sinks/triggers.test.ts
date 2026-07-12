/**
 * triggers.test.ts — trigger policy: digest-first (autoFile off ⇒ nothing),
 * hysteresis (M observed runs), severity threshold, comment routing via the
 * issue map, autoClose, viaMigration guard, label allow-listing, dedupe.
 */

import { describe, expect, it } from "bun:test";
import { processEventsForSinks } from "../../../src/lifecycle/sinks/triggers.js";
import type {
	AzureDevOpsSinkConfig,
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

function adoConfig(ado?: Partial<AzureDevOpsSinkConfig>): LifecycleSinksConfig {
	return {
		sinks: {
			azureDevOps: { enabled: true, org: "myorg", project: "myproj", ...ado },
		},
	};
}

function multiConfig(
	gh?: Partial<GitHubSinkConfig>,
	ado?: Partial<AzureDevOpsSinkConfig>,
): LifecycleSinksConfig {
	return {
		sinks: {
			github: { enabled: true, repo: "owner/repo", ...gh },
			azureDevOps: { enabled: true, org: "myorg", project: "myproj", ...ado },
		},
	};
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

/** A single occurrence tied to a run whose `incomplete` flag is controllable. */
function seedOccurrenceRun(
	store: LifecycleStore,
	findingId: number,
	i: number,
	incomplete: boolean,
): void {
	const { runId } = store.recordRun({
		tenant: "t1",
		stream: "nightly",
		profileId: `p-${findingId}-${i}`,
		captureKind: "sampling",
		captureTime: `2026-07-0${i + 1}T00:00:00Z`,
		versionStamp: "",
		incomplete,
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
		expect(store.listUnprocessedEvents("github")).toHaveLength(0);
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

	it("hysteresis counts only qualifying (non-incomplete) occurrences", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrenceRun(store, id, 0, false); // complete — qualifies
		seedOccurrenceRun(store, id, 1, true); // incomplete — must NOT count
		seedEvent(store, id, "seen-normal");
		expect(
			processEventsForSinks(
				store,
				config({ autoFile: true, autoFileAfterRuns: 2 }),
				NOW,
			).enqueued,
		).toBe(0); // only 1 qualifying occurrence — the incomplete one never counts

		seedOccurrenceRun(store, id, 2, false); // a second complete run
		seedEvent(store, id, "seen-normal");
		expect(
			processEventsForSinks(
				store,
				config({ autoFile: true, autoFileAfterRuns: 2 }),
				NOW,
			).enqueued,
		).toBe(1);
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

	it("filed-fresh with an existing mapping enqueues comment-recurred (recurrence after human close)", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		withMapping(store);
		seedEvent(store, id, "filed-fresh");
		const [event] = store.listUnprocessedEvents("github");
		expect(processEventsForSinks(store, config(), NOW).enqueued).toBe(1);
		const rows = store.listPendingOutbox("github", "comment-recurred");
		expect(rows).toHaveLength(1);
		expect(rows[0].dedupeKey).toBe(`github:comment-recurred:${event.id}`);
		store.close();
	});

	it("reopenOnRecurrence default false: filed-fresh with a mapping enqueues ONLY comment-recurred (today's behavior byte-unchanged)", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		withMapping(store);
		seedEvent(store, id, "filed-fresh");
		const report = processEventsForSinks(store, config(), NOW);
		expect(report.enqueued).toBe(1);
		expect(store.listPendingOutbox("github", "comment-recurred")).toHaveLength(
			1,
		);
		expect(store.listPendingOutbox("github", "reopen-issue")).toHaveLength(0);
		store.close();
	});

	it("reopenOnRecurrence true: filed-fresh with a mapping ALSO enqueues reopen-issue alongside comment-recurred", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		withMapping(store);
		seedEvent(store, id, "filed-fresh");
		const [event] = store.listUnprocessedEvents("github");
		const report = processEventsForSinks(
			store,
			config({ reopenOnRecurrence: true }),
			NOW,
		);
		expect(report.enqueued).toBe(2);
		expect(store.listPendingOutbox("github", "comment-recurred")).toHaveLength(
			1,
		);
		const reopenRows = store.listPendingOutbox("github", "reopen-issue");
		expect(reopenRows).toHaveLength(1);
		expect(reopenRows[0].dedupeKey).toBe(`github:reopen:${event.id}`);
		store.close();
	});

	it("filed-fresh WITHOUT a mapping enqueues nothing when autoFile is off", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedEvent(store, id, "filed-fresh");
		const report = processEventsForSinks(store, config(), NOW);
		expect(report.enqueued).toBe(0);
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
		expect(store.listUnprocessedEvents("github")).toHaveLength(0);
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
		expect(store.listUnprocessedEvents("github")).toHaveLength(1);
		store.close();
	});
});

/**
 * D5 — the backward-compat golden snapshot (plan §multi-sink-ado, Task 2
 * step 1). Captured BEFORE the multi-sink fan-out refactor and asserted
 * byte-identical after it: a github-only config must produce the exact same
 * outbox rows (sink, kind, dedupeKey, findingId, payload) it does today.
 * Covers every delivery kind the trigger scan can produce in one pass:
 * create-issue, comment-regressed, comment-resolved, close-issue,
 * comment-recurred, reopen-issue.
 */
describe("processEventsForSinks — golden snapshot (D5, github backward-compat)", () => {
	it("produces byte-identical outbox rows for a github-only config", () => {
		const store = new LifecycleStore(":memory:");

		// CREATE: fresh finding, hysteresis satisfied (2 qualifying occurrences), no mapping.
		const createId = seedFinding(store, {
			fingerprint: `${FP}-create`,
			title: "CalcFields inside loop (create)",
		});
		seedOccurrences(store, createId, 2);
		seedEvent(store, createId, "seen-normal");

		// REGRESSED: mapped finding, seen-regressed -> comment-regressed only.
		const regressedId = seedFinding(store, {
			fingerprint: `${FP}-regressed`,
			title: "CalcFields inside loop (regressed)",
		});
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: `${FP}-regressed`,
			externalId: "101",
			createdAt: NOW,
		});
		seedEvent(store, regressedId, "seen-regressed");

		// RESOLVED: mapped finding, resolved -> comment-resolved + close-issue (autoClose).
		const resolvedId = seedFinding(store, {
			fingerprint: `${FP}-resolved`,
			title: "CalcFields inside loop (resolved)",
			state: "resolved",
		});
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: `${FP}-resolved`,
			externalId: "102",
			createdAt: NOW,
		});
		seedEvent(store, resolvedId, "resolved");

		// RECURRED: mapped finding, filed-fresh -> comment-recurred + reopen-issue (reopenOnRecurrence).
		const recurredId = seedFinding(store, {
			fingerprint: `${FP}-recurred`,
			title: "CalcFields inside loop (recurred)",
		});
		store.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: `${FP}-recurred`,
			externalId: "103",
			createdAt: NOW,
		});
		seedEvent(store, recurredId, "filed-fresh");

		const eventByFinding = new Map(
			store.listUnprocessedEvents("github").map((e) => [e.findingId, e]),
		);
		const createEvent = eventByFinding.get(createId);
		const regressedEvent = eventByFinding.get(regressedId);
		const resolvedEvent = eventByFinding.get(resolvedId);
		const recurredEvent = eventByFinding.get(recurredId);
		if (!createEvent || !regressedEvent || !resolvedEvent || !recurredEvent) {
			throw new Error("fixture setup failed: expected 4 unprocessed events");
		}

		const cfg = config({
			autoFile: true,
			autoFileAfterRuns: 2,
			autoClose: true,
			reopenOnRecurrence: true,
			labels: ["al-perf", "evil-label"],
			labelsAllowList: ["al-perf"],
		});

		const report = processEventsForSinks(store, cfg, NOW);
		expect(report.processed).toBe(4);
		expect(report.enqueued).toBe(6);
		expect(report.skippedMigration).toBe(0);

		const rows = store.listPendingOutbox("github").map((r) => ({
			sink: r.sink,
			kind: r.kind,
			dedupeKey: r.dedupeKey,
			findingId: r.findingId,
			payload: JSON.parse(r.payload) as SinkDeliveryPayload,
		}));

		expect(rows).toEqual([
			{
				sink: "github",
				kind: "create-issue",
				dedupeKey: `github:create:t1:${FP}-create`,
				findingId: createId,
				payload: {
					labels: ["al-perf"],
					finding: {
						fingerprint: `${FP}-create`,
						title: "CalcFields inside loop (create)",
						severity: "critical",
						state: "open",
						patternId: "calcfields-in-loop",
						appName: "My App",
						firstSeenAt: "2026-07-01T00:00:00Z",
						lastSeenAt: "2026-07-05T00:00:00Z",
						occurrenceCount: 2,
						event: "seen-normal",
						metricClass: null,
						resolvedAt: null,
						evidence: "SELECT * repeated 500x",
					},
				},
			},
			{
				sink: "github",
				kind: "comment-regressed",
				dedupeKey: `github:comment-regressed:${regressedEvent.id}`,
				findingId: regressedId,
				payload: {
					labels: ["al-perf"],
					finding: {
						fingerprint: `${FP}-regressed`,
						title: "CalcFields inside loop (regressed)",
						severity: "critical",
						state: "open",
						patternId: "calcfields-in-loop",
						appName: "My App",
						firstSeenAt: "2026-07-01T00:00:00Z",
						lastSeenAt: "2026-07-05T00:00:00Z",
						occurrenceCount: 0,
						event: "seen-regressed",
						metricClass: null,
						resolvedAt: null,
						evidence: null,
					},
				},
			},
			{
				sink: "github",
				kind: "comment-resolved",
				dedupeKey: `github:comment-resolved:${resolvedEvent.id}`,
				findingId: resolvedId,
				payload: {
					labels: ["al-perf"],
					finding: {
						fingerprint: `${FP}-resolved`,
						title: "CalcFields inside loop (resolved)",
						severity: "critical",
						state: "resolved",
						patternId: "calcfields-in-loop",
						appName: "My App",
						firstSeenAt: "2026-07-01T00:00:00Z",
						lastSeenAt: "2026-07-05T00:00:00Z",
						occurrenceCount: 0,
						event: "resolved",
						metricClass: null,
						resolvedAt: null,
						evidence: null,
					},
				},
			},
			{
				sink: "github",
				kind: "close-issue",
				dedupeKey: `github:close:${resolvedEvent.id}`,
				findingId: resolvedId,
				payload: {
					labels: ["al-perf"],
					finding: {
						fingerprint: `${FP}-resolved`,
						title: "CalcFields inside loop (resolved)",
						severity: "critical",
						state: "resolved",
						patternId: "calcfields-in-loop",
						appName: "My App",
						firstSeenAt: "2026-07-01T00:00:00Z",
						lastSeenAt: "2026-07-05T00:00:00Z",
						occurrenceCount: 0,
						event: "resolved",
						metricClass: null,
						resolvedAt: null,
						evidence: null,
					},
				},
			},
			{
				sink: "github",
				kind: "comment-recurred",
				dedupeKey: `github:comment-recurred:${recurredEvent.id}`,
				findingId: recurredId,
				payload: {
					labels: ["al-perf"],
					finding: {
						fingerprint: `${FP}-recurred`,
						title: "CalcFields inside loop (recurred)",
						severity: "critical",
						state: "open",
						patternId: "calcfields-in-loop",
						appName: "My App",
						firstSeenAt: "2026-07-01T00:00:00Z",
						lastSeenAt: "2026-07-05T00:00:00Z",
						occurrenceCount: 0,
						event: "filed-fresh",
						metricClass: null,
						resolvedAt: null,
						evidence: null,
					},
				},
			},
			{
				sink: "github",
				kind: "reopen-issue",
				dedupeKey: `github:reopen:${recurredEvent.id}`,
				findingId: recurredId,
				payload: {
					labels: ["al-perf"],
					finding: {
						fingerprint: `${FP}-recurred`,
						title: "CalcFields inside loop (recurred)",
						severity: "critical",
						state: "open",
						patternId: "calcfields-in-loop",
						appName: "My App",
						firstSeenAt: "2026-07-01T00:00:00Z",
						lastSeenAt: "2026-07-05T00:00:00Z",
						occurrenceCount: 0,
						event: "filed-fresh",
						metricClass: null,
						resolvedAt: null,
						evidence: null,
					},
				},
			},
		]);

		store.close();
	});
});

/**
 * Task 2 step 3 — new multi-sink behavior: both sink blocks enabled, each
 * evaluated with its OWN SinkTriggerConfig, fanned out from a single scan
 * that stays one transaction (each enabled sink's own watermark advances
 * exactly once per scan, and TriggerReport.processed counts distinct events,
 * not event-sink pairs).
 */
describe("processEventsForSinks — multi-sink fan-out", () => {
	function withMapping(
		store: LifecycleStore,
		sink: string,
		externalId: string,
	): void {
		store.putIssueMapping({
			tenant: "t1",
			sink,
			fingerprint: FP,
			externalId,
			createdAt: NOW,
		});
	}

	it("both sinks enabled: a qualifying finding enqueues one create-issue row per sink", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 2);
		seedEvent(store, id, "seen-normal");

		const cfg = multiConfig(
			{ autoFile: true, autoFileAfterRuns: 2 },
			{ autoFile: true, autoFileAfterRuns: 2 },
		);
		const report = processEventsForSinks(store, cfg, NOW);
		expect(report.processed).toBe(1);
		expect(report.enqueued).toBe(2);

		const ghRows = store.listPendingOutbox("github", "create-issue");
		const adoRows = store.listPendingOutbox("azureDevOps", "create-issue");
		expect(ghRows).toHaveLength(1);
		expect(adoRows).toHaveLength(1);
		expect(ghRows[0].dedupeKey).toBe(`github:create:t1:${FP}`);
		expect(adoRows[0].dedupeKey).toBe(`azureDevOps:create:t1:${FP}`);
		store.close();
	});

	it("a sink with autoFile off enqueues no create for it while the other sink does", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 2);
		seedEvent(store, id, "seen-normal");

		const cfg = multiConfig(
			{ autoFile: true, autoFileAfterRuns: 2 },
			{ autoFile: false },
		);
		const report = processEventsForSinks(store, cfg, NOW);
		expect(report.enqueued).toBe(1);
		expect(store.listPendingOutbox("github", "create-issue")).toHaveLength(1);
		expect(store.listPendingOutbox("azureDevOps", "create-issue")).toHaveLength(
			0,
		);
		store.close();
	});

	it("comment-recurred/reopen-issue fan out per sink independently using each sink's own reopenOnRecurrence", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		withMapping(store, "github", "7");
		withMapping(store, "azureDevOps", "42");
		seedEvent(store, id, "filed-fresh");

		const cfg = multiConfig(
			{ reopenOnRecurrence: true },
			{ reopenOnRecurrence: false },
		);
		const report = processEventsForSinks(store, cfg, NOW);
		// github: comment-recurred + reopen-issue; azureDevOps: comment-recurred only.
		expect(report.enqueued).toBe(3);
		expect(store.listPendingOutbox("github", "comment-recurred")).toHaveLength(
			1,
		);
		expect(store.listPendingOutbox("github", "reopen-issue")).toHaveLength(1);
		expect(
			store.listPendingOutbox("azureDevOps", "comment-recurred"),
		).toHaveLength(1);
		expect(store.listPendingOutbox("azureDevOps", "reopen-issue")).toHaveLength(
			0,
		);
		store.close();
	});

	it("close-issue fans out per sink independently using each sink's own autoClose", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store, { state: "resolved" });
		withMapping(store, "github", "7");
		withMapping(store, "azureDevOps", "42");
		seedEvent(store, id, "resolved");

		const cfg = multiConfig({ autoClose: true }, { autoClose: false });
		const report = processEventsForSinks(store, cfg, NOW);
		// github: comment-resolved + close-issue; azureDevOps: comment-resolved only.
		expect(report.enqueued).toBe(3);
		expect(store.listPendingOutbox("github", "close-issue")).toHaveLength(1);
		expect(store.listPendingOutbox("azureDevOps", "close-issue")).toHaveLength(
			0,
		);
		expect(store.listPendingOutbox("github", "comment-resolved")).toHaveLength(
			1,
		);
		expect(
			store.listPendingOutbox("azureDevOps", "comment-resolved"),
		).toHaveLength(1);
		store.close();
	});

	it("the whole scan stays one transaction: each enabled sink's watermark advances, processed counts distinct events", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedEvent(store, id, "seen-normal");

		const cfg = multiConfig({}, {}); // digest-first: autoFile off on both, no mapping
		const report = processEventsForSinks(store, cfg, NOW);
		expect(report.processed).toBe(1); // one event, not one per enabled sink
		expect(report.enqueued).toBe(0);
		expect(store.listUnprocessedEvents("github")).toHaveLength(0);
		expect(store.listUnprocessedEvents("azureDevOps")).toHaveLength(0);
		store.close();
	});

	it("azureDevOps-only config works standalone (digest-first default, same as github)", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 3);
		seedEvent(store, id, "seen-normal");
		const report = processEventsForSinks(store, adoConfig(), NOW);
		expect(report.enqueued).toBe(0); // autoFile off by default
		expect(report.processed).toBe(1);
		store.close();
	});

	it("azureDevOps tags are filtered against its own allow-list, independent of github's labels", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store);
		seedOccurrences(store, id, 2);
		seedEvent(store, id, "seen-normal");
		const cfg = multiConfig(
			{
				autoFile: true,
				autoFileAfterRuns: 2,
				labels: ["al-perf", "evil-label"],
				labelsAllowList: ["al-perf"],
			},
			{
				autoFile: true,
				autoFileAfterRuns: 2,
				tags: ["al-perf", "evil-tag"],
				tagsAllowList: ["al-perf"],
			},
		);
		processEventsForSinks(store, cfg, NOW);
		const ghPayload = JSON.parse(
			store.listPendingOutbox("github", "create-issue")[0].payload,
		) as SinkDeliveryPayload;
		const adoPayload = JSON.parse(
			store.listPendingOutbox("azureDevOps", "create-issue")[0].payload,
		) as SinkDeliveryPayload;
		expect(ghPayload.labels).toEqual(["al-perf"]);
		expect(adoPayload.labels).toEqual(["al-perf"]);
		store.close();
	});
});
