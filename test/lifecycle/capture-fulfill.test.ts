/**
 * capture-fulfill.test.ts — the deep-capture request fulfillment hook inside
 * `evaluateRun` (capture-requests plan, Task 3): a non-telemetry, complete,
 * non-duplicate run whose method index covers a pending/claimed request's
 * routine closes that request out via `store.fulfillMatchingCaptureRequests`.
 */

import { describe, expect, it } from "bun:test";
import { processCaptureTriggers } from "../../src/lifecycle/capture-triggers.js";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/lifecycle/config.js";
import { evaluateRun, type RunMetadata } from "../../src/lifecycle/evaluate.js";
import {
	type CaptureRequestRow,
	LifecycleStore,
	type NewFinding,
} from "../../src/lifecycle/store.js";
import { evaluateTelemetryBatch } from "../../src/lifecycle/telemetry.js";
import type { AnalysisResult } from "../../src/output/types.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { DetectedPattern } from "../../src/types/patterns.js";
import type {
	TelemetryBatchDocument,
	TelemetrySignal,
} from "../../src/types/telemetry.js";

const NOW = "2026-07-11T00:00:00Z";

function makeMethod(overrides?: Partial<MethodBreakdown>): MethodBreakdown {
	return {
		functionName: "PostOrder",
		objectType: "codeunit",
		objectName: "Order Post",
		objectId: 50100,
		appName: "My App",
		appId: "abc123",
		selfTime: 1_000_000,
		selfTimePercent: 50,
		totalTime: 1_200_000,
		totalTimePercent: 60,
		hitCount: 10,
		calledBy: [],
		calls: [],
		costPerHit: 100_000,
		efficiencyScore: 0.8,
		...overrides,
	};
}

function makeResult(args?: {
	patterns?: DetectedPattern[];
	methods?: MethodBreakdown[];
	incompleteInvocations?: number;
}): AnalysisResult {
	const methods = args?.methods ?? [makeMethod()];
	return {
		meta: {
			profilePath: "p.alcpuprofile",
			profileType: "sampling",
			totalDuration: 2_000_000,
			totalSelfTime: 2_000_000,
			idleSelfTime: 0,
			totalNodes: 10,
			maxDepth: 3,
			incompleteInvocations: args?.incompleteInvocations,
			sourceAvailable: false,
			confidenceScore: 90,
			confidenceFactors: {
				sampleCount: { value: 100, score: 90 },
				duration: { value: 2_000_000, score: 90 },
				incompleteMeasurements: { value: 0, score: 100 },
			},
			analyzedAt: "2026-07-11T10:00:00Z",
		},
		summary: {
			oneLiner: "x",
			topApp: null,
			topMethod: null,
			patternCount: { critical: 0, warning: 0, info: 0 },
			healthScore: 80,
		},
		criticalPath: [],
		hotspots: methods,
		patterns: args?.patterns ?? [],
		appBreakdown: [],
		objectBreakdown: [
			{
				objectType: "codeunit",
				objectName: "Order Post",
				objectId: 50100,
				appName: "My App",
				selfTime: 1_000_000,
				selfTimePercent: 50,
				totalTime: 1_200_000,
				methodCount: methods.length,
				methods,
			},
		],
	};
}

function makeRun(overrides?: Partial<RunMetadata>): RunMetadata {
	return {
		tenant: "t1",
		stream: "nightly",
		profileId: `p-${Math.random().toString(36).slice(2)}`,
		captureKind: "sampling",
		captureTime: "2026-07-11T10:00:00Z",
		...overrides,
	};
}

function seedFinding(
	store: LifecycleStore,
	overrides?: Partial<NewFinding>,
): number {
	return store.insertFinding({
		tenant: "t1",
		fingerprint: "telemetry:deadbeef00000001",
		algoVersion: 1,
		state: "open",
		source: "telemetry",
		patternId: "telemetry-rt0018",
		title: "RT0018: PostOrder (Codeunit 50100) slow",
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
	});
}

/** Seed a pending capture request keyed to match makeMethod()'s default routine. */
function seedCaptureRequest(
	store: LifecycleStore,
	overrides?: Partial<
		Omit<
			CaptureRequestRow,
			| "id"
			| "status"
			| "claimedAt"
			| "claimedBy"
			| "fulfilledAt"
			| "fulfilledByProfileId"
		>
	>,
): { findingId: number } {
	const findingId = seedFinding(store);
	store.createCaptureRequest({
		tenant: "t1",
		fingerprint: "telemetry:deadbeef00000001",
		findingId,
		appId: "abc123",
		appName: "My App",
		objectType: "Codeunit",
		objectId: 50100,
		methodName: "postorder",
		reason: "RT0018 x 3 runs",
		requestedAt: "2026-07-01T00:00:00Z",
		expiresAt: "2026-08-01T00:00:00Z",
		...overrides,
	});
	return { findingId };
}

describe("evaluateRun — capture request fulfillment", () => {
	it("a matching routine fulfills the request with the run's profileId + captureTime", () => {
		const store = new LifecycleStore(":memory:");
		seedCaptureRequest(store);

		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p1", captureTime: NOW }),
		);

		const [row] = store.listCaptureRequests();
		expect(row.status).toBe("fulfilled");
		expect(row.fulfilledByProfileId).toBe("p1");
		expect(row.fulfilledAt).toBe(new Date(NOW).toISOString());
		store.close();
	});

	it("a non-matching routine leaves the request pending", () => {
		const store = new LifecycleStore(":memory:");
		seedCaptureRequest(store, { objectId: 99999, methodName: "othermethod" });

		evaluateRun(store, makeResult(), makeRun({ profileId: "p1" }));

		const [row] = store.listCaptureRequests();
		expect(row.status).toBe("pending");
		store.close();
	});

	it("a telemetry-kind run never fulfills, even when its method index covers the routine (guard)", () => {
		const store = new LifecycleStore(":memory:");
		seedCaptureRequest(store);

		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p1", captureKind: "telemetry" }),
		);

		const [row] = store.listCaptureRequests();
		expect(row.status).toBe("pending");
		store.close();
	});

	it("an incomplete run does not fulfill", () => {
		const store = new LifecycleStore(":memory:");
		seedCaptureRequest(store);

		evaluateRun(
			store,
			makeResult({ incompleteInvocations: 2 }),
			makeRun({ profileId: "p1" }),
		);

		const [row] = store.listCaptureRequests();
		expect(row.status).toBe("pending");
		store.close();
	});

	it("a duplicate run does not fulfill twice and does not error", () => {
		const store = new LifecycleStore(":memory:");
		seedCaptureRequest(store);

		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p1", captureTime: NOW }),
		);
		const [firstRow] = store.listCaptureRequests();
		expect(firstRow.status).toBe("fulfilled");

		const outcome = evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p1", captureTime: NOW }),
		);

		expect(outcome.skipped).toBe("duplicate-run");
		const [row] = store.listCaptureRequests();
		expect(row.status).toBe("fulfilled");
		expect(row.fulfilledByProfileId).toBe("p1");
		store.close();
	});

	it("a claimed request is also fulfillable (D5)", () => {
		const store = new LifecycleStore(":memory:");
		const { findingId } = seedCaptureRequest(store);
		const [req] = store.listCaptureRequests();
		expect(
			store.claimCaptureRequest(req.id, "agent-x", "2026-07-02T00:00:00Z"),
		).toBe(true);
		expect(store.listCaptureRequests()[0].status).toBe("claimed");

		evaluateRun(store, makeResult(), makeRun({ profileId: "p1" }));

		const [row] = store.listCaptureRequests();
		expect(row.status).toBe("fulfilled");
		expect(row.findingId).toBe(findingId);
		store.close();
	});
});

describe("evaluateRun — capture request fulfillment, end-to-end from telemetry", () => {
	it("a real telemetry batch creates a capture request via processCaptureTriggers, and a matching profile run fulfills it — proving creation-side and fulfillment-side keys are byte-identical", () => {
		const store = new LifecycleStore(":memory:");

		const signal: TelemetrySignal = {
			signalId: "RT0018",
			appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			appName: "My ISV App",
			objectType: "Codeunit",
			objectId: 50100,
			methodName: "ProcessLine",
			count: 3,
			maxDurationMs: 12_000, // >= RT0018 warningMs (10000), < criticalMs (30000) → "warning"
			avgDurationMs: 9_500,
		};
		function batch(windowEnd: string): TelemetryBatchDocument {
			return {
				schemaVersion: 1,
				payloadType: "telemetry-batch",
				windowStart: "2026-07-11T00:00:00.000Z",
				windowEnd,
				signals: [signal],
			};
		}

		// 3 batches → 3 occurrences, clearing captureRequests.minOccurrences (3)
		// at severity "warning", clearing captureRequests.minSeverity ("warning").
		const runArgs = (profileId: string) => ({
			tenant: "t1",
			stream: "telemetry",
			profileId,
		});
		evaluateTelemetryBatch(
			store,
			batch("2026-07-11T01:00:00.000Z"),
			runArgs("batch-1"),
		);
		evaluateTelemetryBatch(
			store,
			batch("2026-07-11T02:00:00.000Z"),
			runArgs("batch-2"),
		);
		evaluateTelemetryBatch(
			store,
			batch("2026-07-11T03:00:00.000Z"),
			runArgs("batch-3"),
		);

		const triggerReport = processCaptureTriggers(
			store,
			DEFAULT_LIFECYCLE_CONFIG,
			NOW,
		);
		expect(triggerReport.created).toBe(1);
		const [request] = store.listCaptureRequests("t1", "pending");
		expect(request).toBeDefined();
		expect(request.objectId).toBe(50100);

		// A profile-shaped AnalysisResult whose hotspots+patterns cover the same
		// routine — no hand-seeded routineKey anywhere in this test.
		const method: MethodBreakdown = {
			functionName: "ProcessLine",
			objectType: "codeunit",
			objectName: "Sales Line Handler",
			objectId: 50100,
			appName: "My ISV App",
			appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			selfTime: 2_000_000,
			selfTimePercent: 80,
			totalTime: 2_200_000,
			totalTimePercent: 85,
			hitCount: 20,
			calledBy: [],
			calls: [],
			costPerHit: 100_000,
			efficiencyScore: 0.6,
		};
		const profileResult: AnalysisResult = {
			meta: {
				profilePath: "profile-1.alcpuprofile",
				profileType: "sampling",
				totalDuration: 2_500_000,
				totalSelfTime: 2_500_000,
				idleSelfTime: 0,
				totalNodes: 12,
				maxDepth: 4,
				sourceAvailable: false,
				confidenceScore: 90,
				confidenceFactors: {
					sampleCount: { value: 100, score: 90 },
					duration: { value: 2_500_000, score: 90 },
					incompleteMeasurements: { value: 0, score: 100 },
				},
				analyzedAt: "2026-07-11T04:00:00Z",
			},
			summary: {
				oneLiner: "x",
				topApp: null,
				topMethod: null,
				patternCount: { critical: 0, warning: 0, info: 0 },
				healthScore: 70,
			},
			criticalPath: [],
			hotspots: [method],
			patterns: [],
			appBreakdown: [],
			objectBreakdown: [
				{
					objectType: "codeunit",
					objectName: "Sales Line Handler",
					objectId: 50100,
					appName: "My ISV App",
					selfTime: 2_000_000,
					selfTimePercent: 80,
					totalTime: 2_200_000,
					methodCount: 1,
					methods: [method],
				},
			],
		};

		evaluateRun(store, profileResult, {
			tenant: "t1",
			stream: "nightly",
			profileId: "profile-1",
			captureKind: "sampling",
			captureTime: "2026-07-11T04:00:00Z",
		} satisfies RunMetadata);

		const [fulfilled] = store.listCaptureRequests("t1", "fulfilled");
		expect(fulfilled).toBeDefined();
		expect(fulfilled.id).toBe(request.id);
		expect(fulfilled.fulfilledByProfileId).toBe("profile-1");
		store.close();
	});
});
