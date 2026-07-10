/**
 * baselines.test.ts — routine keys, version stamps, metric recording (cap +
 * builtin filter), median baselines, version segmentation
 * ("environment-changed", spec §4), and the 90-day rollup.
 */

import { describe, expect, it } from "bun:test";
import {
	classifyObservation,
	computeBaseline,
	recordRoutineMetrics,
	rollupRoutineMetrics,
	routineKeyFor,
	versionStampFrom,
} from "../../src/lifecycle/baselines.js";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/lifecycle/config.js";
import { LifecycleStore } from "../../src/lifecycle/store.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";

function method(overrides: Partial<MethodBreakdown>): MethodBreakdown {
	return {
		functionName: "PostOrder",
		objectType: "codeunit",
		objectName: "Order Post",
		objectId: 50100,
		appName: "My App",
		appId: "ABC-123",
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

const KEY = {
	tenant: "t1",
	stream: "nightly",
	captureKind: "sampling" as const,
	routineKey: routineKeyFor({
		appId: "ABC-123",
		objectType: "codeunit",
		objectId: 50100,
		functionName: "PostOrder",
	}),
};

function seedRun(
	store: LifecycleStore,
	profileId: string,
	captureTime: string,
	selfTime: number,
	versionStamp = "",
) {
	recordRoutineMetrics(
		store,
		{ ...KEY, profileId, captureTime, versionStamp },
		[method({ selfTime })],
		500,
	);
}

describe("routineKeyFor / versionStampFrom", () => {
	it("normalizes app guid, object type casing, and routine name casing", () => {
		expect(
			routineKeyFor({
				appId: "ABC-123",
				objectType: "CODEUNIT",
				objectId: 50100,
				functionName: "PostOrder",
			}),
		).toBe(
			routineKeyFor({
				appId: "abc123",
				objectType: "Codeunit",
				objectId: 50100,
				functionName: "POSTORDER",
			}),
		);
	});

	it("versionStampFrom is canonical (app order irrelevant) and empty when absent", () => {
		expect(versionStampFrom(undefined)).toBe("");
		expect(versionStampFrom({})).toBe("");
		const a = versionStampFrom({
			platform: "26.0",
			apps: [
				{ id: "b", version: "2.0" },
				{ id: "a", version: "1.0" },
			],
		});
		const b = versionStampFrom({
			platform: "26.0",
			apps: [
				{ id: "a", version: "1.0" },
				{ id: "b", version: "2.0" },
			],
		});
		expect(a).toBe(b);
	});
});

describe("recordRoutineMetrics", () => {
	it("caps rows by selfTime and skips builtins; idempotent per profile", () => {
		const store = new LifecycleStore(":memory:");
		const methods = [
			method({ functionName: "A", selfTime: 300 }),
			method({ functionName: "B", selfTime: 200 }),
			method({ functionName: "C", selfTime: 100 }),
			method({ functionName: "Sys", selfTime: 999, isBuiltin: true }),
		];
		const run = {
			tenant: "t1",
			stream: "nightly",
			captureKind: "sampling" as const,
			profileId: "p1",
			captureTime: "2026-07-01T00:00:00Z",
			versionStamp: "",
		};
		expect(recordRoutineMetrics(store, run, methods, 2)).toBe(2);
		// Re-recording the same profile writes nothing (INSERT OR IGNORE).
		expect(recordRoutineMetrics(store, run, methods, 2)).toBe(0);
		const names = store.db
			.query<{ routine_key: string }, []>(
				"SELECT routine_key FROM routine_metrics ORDER BY self_time DESC",
			)
			.all()
			.map((r) => r.routine_key);
		expect(names.length).toBe(2);
		expect(names[0]).toContain("|a"); // top selfTime first, builtin excluded
		store.close();
	});
});

describe("computeBaseline / classifyObservation", () => {
	it("returns null with no prior rows, then the same-segment median", () => {
		const store = new LifecycleStore(":memory:");
		expect(computeBaseline(store, KEY, "2026-07-05T00:00:00Z", 10)).toBeNull();
		seedRun(store, "p1", "2026-07-01T00:00:00Z", 1_000_000);
		seedRun(store, "p2", "2026-07-02T00:00:00Z", 1_200_000);
		seedRun(store, "p3", "2026-07-03T00:00:00Z", 1_100_000);
		const b = computeBaseline(store, KEY, "2026-07-05T00:00:00Z", 10);
		expect(b?.median).toBe(1_100_000);
		expect(b?.sameStampCount).toBe(3);
		store.close();
	});

	it("classifies regressed/improved with factor AND absolute floor", () => {
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		const base = { median: 1_000_000, sameStampCount: 3, latestPriorStamp: "" };
		expect(classifyObservation(2_000_000, base, "", cfg)).toBe("regressed");
		expect(classifyObservation(500_000, base, "", cfg)).toBe("improved");
		expect(classifyObservation(1_100_000, base, "", cfg)).toBe("normal");
		// Below the absolute floor a tiny routine can never regress (D11).
		const tiny = { median: 10_000, sameStampCount: 3, latestPriorStamp: "" };
		expect(classifyObservation(50_000, tiny, "", cfg)).toBe("normal");
		expect(classifyObservation(null as never, null, "", cfg)).toBe(
			"no-baseline",
		);
	});

	it("a shift coinciding with a version change is environment-changed, not regressed", () => {
		const store = new LifecycleStore(":memory:");
		const v1 = versionStampFrom({ platform: "25.0" });
		const v2 = versionStampFrom({ platform: "26.0" });
		seedRun(store, "p1", "2026-07-01T00:00:00Z", 1_000_000, v1);
		seedRun(store, "p2", "2026-07-02T00:00:00Z", 1_000_000, v1);
		seedRun(store, "p3", "2026-07-03T00:00:00Z", 1_000_000, v1);
		const b = computeBaseline(store, KEY, "2026-07-04T00:00:00Z", 10);
		expect(
			classifyObservation(9_000_000, b, v2, DEFAULT_LIFECYCLE_CONFIG),
		).toBe("environment-changed");
		// Same stamp would have been a regression.
		expect(
			classifyObservation(9_000_000, b, v1, DEFAULT_LIFECYCLE_CONFIG),
		).toBe("regressed");
		store.close();
	});

	it("baselines never cross the version boundary once the segment has enough runs", () => {
		const store = new LifecycleStore(":memory:");
		const v1 = versionStampFrom({ platform: "25.0" });
		const v2 = versionStampFrom({ platform: "26.0" });
		seedRun(store, "p1", "2026-07-01T00:00:00Z", 100_000, v1);
		seedRun(store, "p2", "2026-07-02T00:00:00Z", 5_000_000, v2);
		seedRun(store, "p3", "2026-07-03T00:00:00Z", 5_100_000, v2);
		seedRun(store, "p4", "2026-07-04T00:00:00Z", 5_200_000, v2);
		const b = computeBaseline(store, KEY, "2026-07-05T00:00:00Z", 10);
		// Median over the v2 segment only — the old 100ms row is excluded.
		expect(b?.median).toBe(5_100_000);
		expect(b?.sameStampCount).toBe(3);
		store.close();
	});

	it("filters by version segment BEFORE windowing, so a reappeared stamp (e.g. a point-in-time restore) still sees its full same-segment history", () => {
		const store = new LifecycleStore(":memory:");
		const a = versionStampFrom({ platform: "25.0" });
		const b2 = versionStampFrom({ platform: "26.0" });
		seedRun(store, "p1", "2026-01-01T00:00:00Z", 1_000_000, a);
		seedRun(store, "p2", "2026-01-02T00:00:00Z", 1_200_000, a);
		seedRun(store, "p3", "2026-01-03T00:00:00Z", 1_100_000, a);
		seedRun(store, "p4", "2026-01-04T00:00:00Z", 5_000_000, b2);
		seedRun(store, "p5", "2026-01-05T00:00:00Z", 5_200_000, b2);
		// A reappears (e.g. a restore rolled the environment back to platform 25.0).
		seedRun(store, "p6", "2026-01-06T00:00:00Z", 1_050_000, a);
		// window=3: a raw window-then-filter would fetch [p6(A), p5(B), p4(B)]
		// and filter down to just p6 — undercounting the segment.
		const baseline = computeBaseline(store, KEY, "2026-01-07T00:00:00Z", 3);
		expect(baseline?.latestPriorStamp).toBe(a);
		expect(baseline?.sameStampCount).toBe(3);
		// Median of the 3 most recent A rows (p6, p3, p2): 1_050_000, 1_100_000, 1_200_000.
		expect(baseline?.median).toBe(1_100_000);
		store.close();
	});

	it("computes an even-count same-segment median as the average of the two middle values", () => {
		const store = new LifecycleStore(":memory:");
		seedRun(store, "p1", "2026-02-01T00:00:00Z", 1_000_000);
		seedRun(store, "p2", "2026-02-02T00:00:00Z", 2_000_000);
		seedRun(store, "p3", "2026-02-03T00:00:00Z", 3_000_000);
		seedRun(store, "p4", "2026-02-04T00:00:00Z", 4_000_000);
		const baseline = computeBaseline(store, KEY, "2026-02-05T00:00:00Z", 10);
		expect(baseline?.sameStampCount).toBe(4);
		expect(baseline?.median).toBe(2_500_000);
		store.close();
	});

	it("classifyObservation returns no-baseline when sameStampCount is below baselineMinRuns", () => {
		const tooFew = {
			median: 1_000_000,
			sameStampCount: 2,
			latestPriorStamp: "",
		};
		// baselineMinRuns is 3 by default; a huge delta must still not classify
		// as regressed/improved with only 2 same-segment samples.
		expect(
			classifyObservation(9_000_000, tooFew, "", DEFAULT_LIFECYCLE_CONFIG),
		).toBe("no-baseline");
	});
});

describe("rollupRoutineMetrics", () => {
	it("folds raw rows older than retention into daily rollups and deletes them", () => {
		const store = new LifecycleStore(":memory:");
		seedRun(store, "old1", "2026-01-01T06:00:00Z", 1_000_000);
		seedRun(store, "old2", "2026-01-01T18:00:00Z", 3_000_000);
		seedRun(store, "recent", "2026-07-01T00:00:00Z", 2_000_000);
		const res = rollupRoutineMetrics(store, "2026-07-09T00:00:00Z", 90);
		expect(res.deleted).toBe(2);
		expect(res.rolledUp).toBe(1);
		const rollup = store.db
			.query<Record<string, unknown>, []>(
				"SELECT * FROM routine_metrics_rollup",
			)
			.get();
		expect(rollup?.day).toBe("2026-01-01");
		expect(rollup?.run_count).toBe(2);
		expect(rollup?.self_time_median).toBe(2_000_000);
		const rawLeft = store.db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM routine_metrics")
			.get();
		expect(rawLeft?.n).toBe(1);
		store.close();
	});
});
