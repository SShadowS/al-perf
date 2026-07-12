/**
 * capture-triggers.test.ts — the deep-capture request trigger scan
 * (processCaptureTriggers): files a capture request from a recurring
 * telemetry finding, gated by severity/occurrence thresholds, the
 * pattern/alsem namespace guard, active-dedupe, and the per-tenant
 * maxPending cap. Run inside `lifecycle sync` (see sync-cli.test.ts).
 */

import { describe, expect, it } from "bun:test";
import { processCaptureTriggers } from "../../src/lifecycle/capture-triggers.js";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/lifecycle/config.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";

const NOW = "2026-07-11T00:00:00Z";

function telemetryFinding(overrides?: Partial<NewFinding>): NewFinding {
	return {
		tenant: "t1",
		fingerprint: "telemetry:deadbeef00000001",
		algoVersion: 1,
		state: "open",
		source: "telemetry",
		patternId: "telemetry-rt0018",
		title: "RT0018: PostOrder (Codeunit 50100) slow — max 42000ms × 5",
		severity: "warning",
		appId: "abc123",
		appName: "My App",
		routineKey: "abc123|Codeunit|50100|postorder",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-05T00:00:00Z",
		lastEventAt: "2026-07-05T00:00:00Z",
		observedKinds: ["telemetry"],
		observedStreams: ["telemetry"],
		...overrides,
	};
}

/** Seed N occurrences (each on its own run) so countOccurrences(findingId) === n. */
function seedOccurrences(
	store: LifecycleStore,
	findingId: number,
	n: number,
	tenant = "t1",
): void {
	for (let i = 0; i < n; i++) {
		const { runId } = store.recordRun({
			tenant,
			stream: "telemetry",
			profileId: `p-${findingId}-${i}`,
			captureKind: "telemetry",
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: [], names: [] },
		});
		store.recordOccurrence({
			findingId,
			runId,
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			severity: "warning",
		});
	}
}

describe("processCaptureTriggers", () => {
	it("telemetry finding with 3+ occurrences creates a request with normalized key fields and correct expiry", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(telemetryFinding());
		seedOccurrences(store, id, 3);

		const report = processCaptureTriggers(store, DEFAULT_LIFECYCLE_CONFIG, NOW);

		expect(report.created).toBe(1);
		expect(report.scanned).toBe(1);
		expect(report.expired).toBe(0);
		expect(report.skippedMaxPending).toBe(0);

		const [row] = store.listCaptureRequests();
		expect(row.tenant).toBe("t1");
		expect(row.fingerprint).toBe("telemetry:deadbeef00000001");
		expect(row.findingId).toBe(id);
		expect(row.appId).toBe("abc123");
		expect(row.objectType).toBe("Codeunit");
		expect(row.objectId).toBe(50100);
		expect(row.methodName).toBe("postorder");
		expect(row.reason).toContain("RT0018");
		expect(row.reason).toContain("3 runs");
		expect(row.reason).toContain("warning");
		expect(row.requestedAt).toBe(NOW);
		expect(row.expiresAt).toBe(
			new Date(Date.parse(NOW) + 14 * 86_400_000).toISOString(),
		);
		store.close();
	});

	it("2 occurrences (below minOccurrences) creates nothing", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(telemetryFinding());
		seedOccurrences(store, id, 2);

		const report = processCaptureTriggers(store, DEFAULT_LIFECYCLE_CONFIG, NOW);

		expect(report.created).toBe(0);
		expect(store.listCaptureRequests()).toHaveLength(0);
		store.close();
	});

	it("info severity (below minSeverity threshold) creates nothing", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(telemetryFinding({ severity: "info" }));
		seedOccurrences(store, id, 3);

		const report = processCaptureTriggers(store, DEFAULT_LIFECYCLE_CONFIG, NOW);

		expect(report.created).toBe(0);
		expect(store.listCaptureRequests()).toHaveLength(0);
		store.close();
	});

	it("namespace guard: a pattern-namespaced finding is never a candidate, even with high severity and occurrences", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(
			telemetryFinding({
				fingerprint: "pattern:deadbeef00000002",
				source: "pattern",
				patternId: "calcfields-in-loop",
				severity: "critical",
			}),
		);
		seedOccurrences(store, id, 5);

		const report = processCaptureTriggers(store, DEFAULT_LIFECYCLE_CONFIG, NOW);

		expect(report.scanned).toBe(0);
		expect(report.created).toBe(0);
		expect(store.listCaptureRequests()).toHaveLength(0);
		store.close();
	});

	it("an active duplicate is not re-created on a second scan", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(telemetryFinding());
		seedOccurrences(store, id, 3);

		expect(
			processCaptureTriggers(store, DEFAULT_LIFECYCLE_CONFIG, NOW).created,
		).toBe(1);
		expect(
			processCaptureTriggers(store, DEFAULT_LIFECYCLE_CONFIG, NOW).created,
		).toBe(0);
		expect(store.listCaptureRequests()).toHaveLength(1);
		store.close();
	});

	it("after the expiry sweep reaps the old request, a later scan re-creates it", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(telemetryFinding());
		seedOccurrences(store, id, 3);

		expect(
			processCaptureTriggers(store, DEFAULT_LIFECYCLE_CONFIG, NOW).created,
		).toBe(1);

		const later = new Date(Date.parse(NOW) + 15 * 86_400_000).toISOString(); // past the 14-day ttl
		const report = processCaptureTriggers(
			store,
			DEFAULT_LIFECYCLE_CONFIG,
			later,
		);

		expect(report.expired).toBe(1);
		expect(report.created).toBe(1);
		expect(store.listCaptureRequests()).toHaveLength(2);
		expect(store.listCaptureRequests("t1", "expired")).toHaveLength(1);
		expect(store.listCaptureRequests("t1", "pending")).toHaveLength(1);
		store.close();
	});

	it("maxPending cap: further qualifying candidates are skipped and counted, not queued", () => {
		const store = new LifecycleStore(":memory:");
		const id1 = store.insertFinding(
			telemetryFinding({ fingerprint: "telemetry:deadbeef00000003" }),
		);
		const id2 = store.insertFinding(
			telemetryFinding({
				fingerprint: "telemetry:deadbeef00000004",
				routineKey: "abc123|Codeunit|50200|postcredit",
			}),
		);
		seedOccurrences(store, id1, 3);
		seedOccurrences(store, id2, 3);

		const cfg = {
			...DEFAULT_LIFECYCLE_CONFIG,
			captureRequests: {
				...DEFAULT_LIFECYCLE_CONFIG.captureRequests,
				maxPending: 1,
			},
		};
		const report = processCaptureTriggers(store, cfg, NOW);

		expect(report.created).toBe(1);
		expect(report.skippedMaxPending).toBe(1);
		expect(store.listCaptureRequests()).toHaveLength(1);
		store.close();
	});

	it("healthy-but-full queue: candidates that already hold their own active request are not counted as skipped", () => {
		const store = new LifecycleStore(":memory:");
		const id1 = store.insertFinding(
			telemetryFinding({ fingerprint: "telemetry:deadbeef00000007" }),
		);
		const id2 = store.insertFinding(
			telemetryFinding({
				fingerprint: "telemetry:deadbeef00000008",
				routineKey: "abc123|Codeunit|50200|postcredit",
			}),
		);
		seedOccurrences(store, id1, 3);
		seedOccurrences(store, id2, 3);

		const cfg = {
			...DEFAULT_LIFECYCLE_CONFIG,
			captureRequests: {
				...DEFAULT_LIFECYCLE_CONFIG.captureRequests,
				maxPending: 2,
			},
		};

		// First scan: both qualify, both fit under the cap, both get queued.
		const first = processCaptureTriggers(store, cfg, NOW);
		expect(first.created).toBe(2);
		expect(first.skippedMaxPending).toBe(0);

		// Second scan, same instant: the tenant is now AT the cap (2/2), but
		// both active requests belong to these exact candidates — nothing is
		// starved. A re-scan must not blame either of them for occupying the
		// slot they themselves hold.
		const second = processCaptureTriggers(store, cfg, NOW);
		expect(second.created).toBe(0);
		expect(second.skippedMaxPending).toBe(0);
		expect(store.listCaptureRequests()).toHaveLength(2);
		store.close();
	});

	it("a genuinely starved finding is still counted even while other candidates already hold their own requests", () => {
		const store = new LifecycleStore(":memory:");
		const id1 = store.insertFinding(
			telemetryFinding({ fingerprint: "telemetry:deadbeef00000009" }),
		);
		const id2 = store.insertFinding(
			telemetryFinding({
				fingerprint: "telemetry:deadbeef0000000a",
				routineKey: "abc123|Codeunit|50200|postcredit",
			}),
		);
		seedOccurrences(store, id1, 3);
		seedOccurrences(store, id2, 3);

		const cfg = {
			...DEFAULT_LIFECYCLE_CONFIG,
			captureRequests: {
				...DEFAULT_LIFECYCLE_CONFIG.captureRequests,
				maxPending: 2,
			},
		};
		expect(processCaptureTriggers(store, cfg, NOW).created).toBe(2);

		// A brand-new qualifying finding with NO active request of its own —
		// this one really is starved by the full queue.
		const id3 = store.insertFinding(
			telemetryFinding({
				fingerprint: "telemetry:deadbeef0000000b",
				routineKey: "abc123|Codeunit|50300|postinvoice",
			}),
		);
		seedOccurrences(store, id3, 3);

		const report = processCaptureTriggers(store, cfg, NOW);
		expect(report.created).toBe(0);
		expect(report.skippedMaxPending).toBe(1);
		expect(store.listCaptureRequests()).toHaveLength(2);
		store.close();
	});

	it("resolved/closed findings are never candidates", () => {
		const store = new LifecycleStore(":memory:");
		const resolvedId = store.insertFinding(
			telemetryFinding({
				fingerprint: "telemetry:deadbeef00000005",
				state: "resolved",
				severity: "critical",
			}),
		);
		const closedId = store.insertFinding(
			telemetryFinding({
				fingerprint: "telemetry:deadbeef00000006",
				state: "closed",
				severity: "critical",
			}),
		);
		seedOccurrences(store, resolvedId, 5);
		seedOccurrences(store, closedId, 5);

		const report = processCaptureTriggers(store, DEFAULT_LIFECYCLE_CONFIG, NOW);

		expect(report.scanned).toBe(0);
		expect(report.created).toBe(0);
		expect(store.listCaptureRequests()).toHaveLength(0);
		store.close();
	});

	it("expiry runs BEFORE reclaim — a request past its creation TTL never records a spurious reclaim, even though it also clears the claim TTL", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(telemetryFinding());
		seedOccurrences(store, id, 3);

		const cfg = {
			...DEFAULT_LIFECYCLE_CONFIG,
			captureRequests: {
				...DEFAULT_LIFECYCLE_CONFIG.captureRequests,
				claimTtlMinutes: 60,
			},
		};
		expect(processCaptureTriggers(store, cfg, NOW).created).toBe(1);
		const [row] = store.listCaptureRequests();
		store.claimCaptureRequest(row.id, "executor-1", NOW);

		// Past BOTH the 14-day creation TTL and the 60-minute claim TTL. The
		// row dies either way (expireCaptureRequests matches 'claimed' rows
		// directly) — what the order actually protects is reclaim_count: if
		// reclaim ran first it would flip this row to 'pending' and increment
		// reclaim_count on a request that's about to expire anyway, corrupting
		// the exact signal reclaim_count exists to carry.
		const pastBoth = new Date(Date.parse(NOW) + 15 * 86_400_000).toISOString();
		const report = processCaptureTriggers(store, cfg, pastBoth);

		expect(report.expired).toBe(1);
		expect(report.reclaimed).toBe(0);
		const [after] = store.listCaptureRequests();
		expect(after.status).toBe("expired");
		expect(after.reclaimCount).toBe(0);
		store.close();
	});

	it("a stale claim inside its creation TTL is reclaimed and reported", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(telemetryFinding());
		seedOccurrences(store, id, 3);

		const cfg = {
			...DEFAULT_LIFECYCLE_CONFIG,
			captureRequests: {
				...DEFAULT_LIFECYCLE_CONFIG.captureRequests,
				claimTtlMinutes: 60,
			},
		};
		expect(processCaptureTriggers(store, cfg, NOW).created).toBe(1);
		const [row] = store.listCaptureRequests();
		store.claimCaptureRequest(row.id, "executor-1", NOW);

		// Past the 60-minute claim TTL, well inside the 14-day creation TTL.
		const pastClaimTtlOnly = new Date(
			Date.parse(NOW) + 61 * 60_000,
		).toISOString();
		const report = processCaptureTriggers(store, cfg, pastClaimTtlOnly);

		expect(report.reclaimed).toBe(1);
		expect(report.expired).toBe(0);
		expect(store.listCaptureRequests()[0].status).toBe("pending");
		store.close();
	});
});
