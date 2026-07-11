/**
 * telemetry-evaluate.test.ts — `evaluateTelemetryBatch` behavior (telemetry-
 * ingest plan, Task 3): batches flow through the SAME finding lifecycle as
 * profile runs (`evaluateRun` unchanged) — first-seen, recurrence, absence
 * gating, resolve, baseline isolation, duplicate-run, and sink flow-through.
 *
 * D3 (absence gating) depends on `collectFindings` (evaluate.ts) resolving a
 * telemetry finding's real `appId` by matching a pattern's
 * `involvedMethods[0]` against the method index built from
 * `result.hotspots`. This requires the exercised-apps hotspots to carry the
 * signal's REAL routine identity (functionName/objectType/objectId), not a
 * deduped placeholder — a plan amendment to Task 2's stub rules
 * (docs/superpowers/plans/2026-07-11-telemetry-ingest.md), made here once an
 * earlier version of this file proved the placeholder broke D3 (a finding
 * accrued absence from a batch that never mentioned its app). See
 * `buildExercisedHotspots` (src/core/telemetry-parser.ts) for the fix.
 */

import { describe, expect, test } from "bun:test";
import type { LifecycleConfig } from "../../src/lifecycle/config.js";
import { evaluateRun, type RunMetadata } from "../../src/lifecycle/evaluate.js";
import { processEventsForSinks } from "../../src/lifecycle/sinks/triggers.js";
import type { LifecycleSinksConfig } from "../../src/lifecycle/sinks/types.js";
import { LifecycleStore } from "../../src/lifecycle/store.js";
import { evaluateTelemetryBatch } from "../../src/lifecycle/telemetry.js";
import type { AnalysisResult } from "../../src/output/types.js";
import { normalizeAppGuid } from "../../src/semantic/identity.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { DetectedPattern } from "../../src/types/patterns.js";
import type {
	TelemetryBatchDocument,
	TelemetrySignal,
} from "../../src/types/telemetry.js";

const NOW = "2026-07-11T12:00:00.000Z";

function signal(overrides: Partial<TelemetrySignal> = {}): TelemetrySignal {
	return {
		signalId: "RT0018",
		appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		appName: "My ISV App",
		objectType: "Codeunit",
		objectId: 50100,
		methodName: "ProcessLine",
		count: 3,
		maxDurationMs: 12_000,
		avgDurationMs: 9_500,
		...overrides,
	};
}

function batch(
	signals: TelemetrySignal[],
	overrides: Partial<TelemetryBatchDocument> = {},
): TelemetryBatchDocument {
	return {
		schemaVersion: 1,
		payloadType: "telemetry-batch",
		windowStart: "2026-07-11T00:00:00.000Z",
		windowEnd: "2026-07-11T01:00:00.000Z",
		signals,
		...overrides,
	};
}

function runArgs(profileId: string) {
	return { tenant: "t1", stream: "telemetry", profileId };
}

// A minimal profile-sourced AnalysisResult, distinct from the telemetry
// stub — used to prove telemetry runs never pollute a sampling baseline.
function makeProfileResult(): AnalysisResult {
	const method: MethodBreakdown = {
		functionName: "PostOrder",
		objectType: "codeunit",
		objectName: "Order Post",
		objectId: 60100,
		appName: "Other App",
		appId: "other-app-guid",
		selfTime: 1_000_000,
		selfTimePercent: 50,
		totalTime: 1_200_000,
		totalTimePercent: 60,
		hitCount: 10,
		calledBy: [],
		calls: [],
		costPerHit: 100_000,
		efficiencyScore: 0.8,
	};
	const pattern: DetectedPattern = {
		id: "calcfields-in-loop",
		severity: "warning",
		title: "CalcFields inside loop",
		description: "d",
		impact: 500_000,
		involvedMethods: ["PostOrder (codeunit 60100)"],
		evidence: "e",
		fingerprint: "pattern:deadbeef00000099",
	};
	return {
		meta: {
			profilePath: "p.alcpuprofile",
			profileType: "sampling",
			totalDuration: 2_000_000,
			totalSelfTime: 2_000_000,
			idleSelfTime: 0,
			totalNodes: 10,
			maxDepth: 3,
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
			patternCount: { critical: 0, warning: 1, info: 0 },
			healthScore: 80,
		},
		criticalPath: [],
		hotspots: [method],
		patterns: [pattern],
		appBreakdown: [],
		objectBreakdown: [
			{
				objectType: "codeunit",
				objectName: "Order Post",
				objectId: 60100,
				appName: "Other App",
				selfTime: 1_000_000,
				selfTimePercent: 50,
				totalTime: 1_200_000,
				methodCount: 1,
				methods: [method],
			},
		],
	};
}

describe("evaluateTelemetryBatch — first batch", () => {
	test("RT0018 signal creates a new telemetry finding with a telemetry: fingerprint", () => {
		const store = new LifecycleStore(":memory:");
		const outcome = evaluateTelemetryBatch(
			store,
			batch([signal()]),
			runArgs("batch-1"),
		);
		expect(outcome.transitions).toHaveLength(1);
		const t = outcome.transitions[0];
		expect(t.from).toBeNull();
		expect(t.to).toBe("new");
		expect(t.fingerprint).toMatch(/^telemetry:[0-9a-f]{16}$/);

		const finding = store.getFinding(t.findingId);
		expect(finding?.source).toBe("telemetry");
		expect(finding?.state).toBe("new");
		// The finding must carry the signal's REAL appId — not "" — so D3
		// absence gating can tell whether a later batch exercised its app.
		expect(finding?.appId).toBe(normalizeAppGuid(signal().appId));
		expect(finding?.appId).not.toBe("");
		store.close();
	});
});

describe("evaluateTelemetryBatch — recurrence", () => {
	test("a second batch (later windowEnd, same signal) moves the finding to open with 2 occurrences", () => {
		const store = new LifecycleStore(":memory:");
		const s = signal();
		const first = evaluateTelemetryBatch(store, batch([s]), runArgs("batch-1"));
		const findingId = first.transitions[0].findingId;

		const second = evaluateTelemetryBatch(
			store,
			batch([s], { windowEnd: "2026-07-11T02:00:00.000Z" }),
			runArgs("batch-2"),
		);
		expect(second.transitions).toHaveLength(1);
		expect(second.transitions[0].to).toBe("open");
		expect(store.countOccurrences(findingId)).toBe(2);
		store.close();
	});
});

describe("evaluateTelemetryBatch — absence gating (D3)", () => {
	test("a later batch that omits the finding but still exercises its app increments absenceCount", () => {
		const store = new LifecycleStore(":memory:");
		const s = signal({ methodName: "ProcessLine" });
		// Same app, a DIFFERENT routine — keeps the app present in the batch
		// without re-observing the original finding.
		const other = signal({ methodName: "OtherMethod" });

		const first = evaluateTelemetryBatch(store, batch([s]), runArgs("batch-1"));
		const findingId = first.transitions[0].findingId;

		evaluateTelemetryBatch(
			store,
			batch([other], { windowEnd: "2026-07-11T02:00:00.000Z" }),
			runArgs("batch-2"),
		);
		const finding = store.getFinding(findingId);
		expect(finding?.absenceCount).toBe(1);
		store.close();
	});

	test("a later batch that never exercises the finding's app leaves absenceCount unchanged", () => {
		const store = new LifecycleStore(":memory:");
		const s = signal({
			appId: "app-a-guid",
			appName: "App A",
			methodName: "ProcessLine",
		});
		// A completely unrelated app — app A never appears in this batch.
		const otherApp = signal({
			appId: "app-z-guid",
			appName: "App Z",
			methodName: "SomethingElse",
		});

		const first = evaluateTelemetryBatch(store, batch([s]), runArgs("batch-1"));
		const findingId = first.transitions[0].findingId;

		evaluateTelemetryBatch(
			store,
			batch([otherApp], { windowEnd: "2026-07-11T02:00:00.000Z" }),
			runArgs("batch-2"),
		);
		const finding = store.getFinding(findingId);
		expect(finding?.absenceCount).toBe(0);
		store.close();
	});
});

describe("evaluateTelemetryBatch — resolve", () => {
	test("resolveAfterRuns consecutive absences (app exercised each time) resolves the finding", () => {
		const store = new LifecycleStore(":memory:");
		const cfg: Partial<LifecycleConfig> = { resolveAfterRuns: 2 };
		const s = signal({ methodName: "ProcessLine" });
		const other = signal({ methodName: "OtherMethod" });

		const first = evaluateTelemetryBatch(
			store,
			batch([s]),
			runArgs("batch-1"),
			cfg,
		);
		const findingId = first.transitions[0].findingId;

		evaluateTelemetryBatch(
			store,
			batch([other], { windowEnd: "2026-07-11T02:00:00.000Z" }),
			runArgs("batch-2"),
			cfg,
		);
		expect(store.getFinding(findingId)?.state).toBe("new"); // 1st absence, below resolveAfterRuns

		evaluateTelemetryBatch(
			store,
			batch([other], { windowEnd: "2026-07-11T03:00:00.000Z" }),
			runArgs("batch-3"),
			cfg,
		);
		expect(store.getFinding(findingId)?.state).toBe("resolved");
		store.close();
	});
});

describe("evaluateTelemetryBatch — baseline isolation", () => {
	test("telemetry runs never contribute to or are read by a sampling baseline lookup", () => {
		const store = new LifecycleStore(":memory:");
		evaluateTelemetryBatch(store, batch([signal()]), runArgs("batch-1"));
		evaluateTelemetryBatch(
			store,
			batch([signal({ maxDurationMs: 20_000 })], {
				windowEnd: "2026-07-11T02:00:00.000Z",
			}),
			runArgs("batch-2"),
		);

		// No routine_metrics row from a telemetry run is ever tagged
		// sampling/instrumentation — the capture-kind keying that isolates
		// baselines holds regardless of what the telemetry stub itself writes.
		const crossKind = store.db
			.query<{ n: number }, []>(
				"SELECT count(*) AS n FROM routine_metrics WHERE capture_kind IN ('sampling','instrumentation')",
			)
			.get();
		expect(crossKind?.n).toBe(0);

		// A subsequent profile run's baseline lookup for an unrelated finding
		// is untouched: 'no-baseline' (first observation), not polluted by any
		// telemetry-kind row.
		const profileOutcome = evaluateRun(store, makeProfileResult(), {
			tenant: "t1",
			stream: "nightly",
			profileId: "profile-1",
			captureKind: "sampling",
			captureTime: "2026-07-11T03:00:00.000Z",
		} satisfies RunMetadata);
		expect(profileOutcome.transitions[0].metricClass).toBe("no-baseline");
		store.close();
	});
});

describe("evaluateTelemetryBatch — duplicate batch", () => {
	test("re-evaluating the same profileId is skipped as a duplicate run", () => {
		const store = new LifecycleStore(":memory:");
		evaluateTelemetryBatch(store, batch([signal()]), runArgs("batch-1"));
		const outcome = evaluateTelemetryBatch(
			store,
			batch([signal()]),
			runArgs("batch-1"),
		);
		expect(outcome.skipped).toBe("duplicate-run");
		store.close();
	});
});

describe("evaluateTelemetryBatch — sink flow-through", () => {
	test("two batches reaching hysteresis enqueue a create-issue row for the telemetry finding", () => {
		const store = new LifecycleStore(":memory:");
		// >= RT0018's criticalMs (30000) so autoFileMinSeverity's default
		// ("critical") is met without overriding sink config.
		const s = signal({ maxDurationMs: 35_000 });

		const first = evaluateTelemetryBatch(store, batch([s]), runArgs("batch-1"));
		const fp = first.transitions[0].fingerprint;

		const ghConfig: LifecycleSinksConfig = {
			sinks: {
				github: {
					enabled: true,
					repo: "owner/repo",
					autoFile: true,
					autoFileAfterRuns: 2,
				},
			},
		};
		expect(processEventsForSinks(store, ghConfig, NOW).enqueued).toBe(0); // only 1 occurrence — below M

		evaluateTelemetryBatch(
			store,
			batch([s], { windowEnd: "2026-07-11T02:00:00.000Z" }),
			runArgs("batch-2"),
		);
		const report = processEventsForSinks(store, ghConfig, NOW);
		expect(report.enqueued).toBe(1);
		const rows = store.listPendingOutbox("github", "create-issue");
		expect(rows).toHaveLength(1);
		expect(rows[0].dedupeKey).toBe(`github:create:t1:${fp}`);
		store.close();
	});
});
