import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { formatBatchTerminal } from "../../../src/cli/formatters/batch-terminal.js";
import { formatBatch } from "../../../src/cli/formatters/index.js";
import { analyzeProfile } from "../../../src/core/analyzer.js";
import {
	aggregateResults,
	analyzeBatch,
} from "../../../src/core/batch-analyzer.js";
import type { ProfileMetadata } from "../../../src/types/batch.js";

const BATCH_DIR = resolve(import.meta.dir, "../../fixtures/batch");

describe("formatBatch terminal", () => {
	test("produces terminal output with all sections", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatch(result, "terminal");

		expect(output).toContain("Batch Analysis");
		expect(output).toContain("profiles");
		expect(output).toContain("Health");
	});

	test("includes batch summary section", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatchTerminal(result);

		expect(output).toContain("Batch Summary");
		expect(output).toContain("Profiles: 2");
		expect(output).toContain("/100");
	});

	test("includes activity breakdown section", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatchTerminal(result);

		expect(output).toContain("Activity Breakdown");
	});

	test("includes cumulative hotspots section", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatchTerminal(result);

		expect(output).toContain("Cumulative Hotspots");
	});

	test("includes app breakdown section", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatchTerminal(result);

		expect(output).toContain("App Breakdown");
	});

	test("includes explanation section when present", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);
		result.explanation = "This batch shows recurring performance issues.";

		const output = formatBatchTerminal(result);

		expect(output).toContain("AI Analysis");
		expect(output).toContain("This batch shows recurring performance issues.");
	});

	test("omits explanation section when not present", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatchTerminal(result);

		expect(output).not.toContain("AI Analysis");
	});

	test("uses metadata descriptions when available", async () => {
		const metadata = [
			{
				activityId: "a1",
				activityType: "WebClient" as const,
				activityDescription: "Sales Order List",
				startTime: "2026-03-01T08:00:00Z",
				activityDuration: 5000,
				alExecutionDuration: 3200,
				sqlCallDuration: 1200,
				sqlCallCount: 45,
				httpCallDuration: 0,
				httpCallCount: 0,
				userName: "admin",
				clientSessionId: 101,
			},
			{
				activityId: "a2",
				activityType: "Background" as const,
				activityDescription: "Job Queue: Calc Inventory",
				startTime: "2026-03-01T09:00:00Z",
				activityDuration: 8000,
				alExecutionDuration: 6100,
				sqlCallDuration: 3400,
				sqlCallCount: 120,
				httpCallDuration: 200,
				httpCallCount: 2,
				userName: "admin",
				clientSessionId: 102,
			},
		];

		const result = await analyzeBatch(
			[
				resolve(BATCH_DIR, "profile-1.alcpuprofile"),
				resolve(BATCH_DIR, "profile-2.alcpuprofile"),
			],
			{ metadata },
		);

		const output = formatBatchTerminal(result);

		expect(output).toContain("Sales Order List");
		expect(output).toContain("Job Queue: Calc Inventory");
	});

	test("formatBatch with json format returns valid JSON", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatch(result, "json");
		const parsed = JSON.parse(output);

		expect(parsed.meta.profileCount).toBe(2);
		expect(parsed.summary).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// sqlActivity batch section tests (Task 7)
// ---------------------------------------------------------------------------

describe("formatBatchTerminal — sqlActivity section (Task 7)", () => {
	test("renders one row per profile carrying sqlActivity", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);
		result.profiles[0].sqlActivity = {
			measuredSqlCount: 1381,
			measuredSqlDurationMs: 382,
			sampledAttributedCostUs: 15000,
		};

		const output = formatBatchTerminal(result);

		expect(output).toContain("SQL Activity (measured vs sampled)");
		expect(output).toContain("1381");
	});

	test("omits sqlActivity section when no profile carries it", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatchTerminal(result);

		expect(output).not.toContain("SQL Activity");
	});

	test("pairs sqlActivity by profilePath, not array index, when the duration sort inverts order", async () => {
		// buildActivityBreakdown (src/core/batch-analyzer.ts) sorts by duration
		// descending, but BatchAnalysisResult.profiles stays in original
		// (submission) order. Force asymmetric durations so the two orders
		// actually diverge — profile A (short) submitted first, profile B
		// (long) submitted second, so after the sort B lands at index 0 and A
		// at index 1, INVERTING the original [A, B] submission order.
		const resultA = await analyzeProfile(
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
		);
		const resultB = await analyzeProfile(
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		);
		resultA.meta.totalSelfTime = 1000;
		resultB.meta.totalSelfTime = 999999;

		// Only A carries measured SQL activity.
		resultA.sqlActivity = {
			measuredSqlCount: 1381,
			measuredSqlDurationMs: 382,
			sampledAttributedCostUs: 15000,
		};
		resultB.sqlActivity = undefined;

		const metadata: ProfileMetadata[] = [
			{
				activityId: "a",
				activityType: "WebClient",
				activityDescription: "Activity-A-Short",
				startTime: "2026-03-01T08:00:00Z",
				activityDuration: 1000,
				alExecutionDuration: 500,
				sqlCallDuration: 382,
				sqlCallCount: 1381,
				httpCallDuration: 0,
				httpCallCount: 0,
				userName: "admin",
				clientSessionId: 1,
			},
			{
				activityId: "b",
				activityType: "WebClient",
				activityDescription: "Activity-B-Long",
				startTime: "2026-03-01T09:00:00Z",
				activityDuration: 999999,
				alExecutionDuration: 500000,
				sqlCallDuration: 0,
				sqlCallCount: 0,
				httpCallDuration: 0,
				httpCallCount: 0,
				userName: "admin",
				clientSessionId: 2,
			},
		];

		const result = aggregateResults([resultA, resultB], [], metadata);

		// Sanity: confirm the sort actually inverted order — else this test
		// would pin nothing.
		expect(result.activityBreakdown[0].metadata?.activityDescription).toBe(
			"Activity-B-Long",
		);
		expect(result.activityBreakdown[1].metadata?.activityDescription).toBe(
			"Activity-A-Short",
		);

		const out = formatBatchTerminal(result);
		// Scope to the SQL Activity table specifically — both activity
		// descriptions also appear (without SQL numbers) in the earlier
		// Activity Breakdown table, so a whole-output line search would match
		// the wrong table.
		const sqlSectionStart = out.indexOf("SQL Activity (measured vs sampled)");
		expect(sqlSectionStart).toBeGreaterThan(-1);
		const sqlLines = out.slice(sqlSectionStart).split("\n");
		const lineA = sqlLines.find((l) => l.includes("Activity-A-Short"));
		const lineB = sqlLines.find((l) => l.includes("Activity-B-Long"));
		// A (the true owner of the 1381 measured calls) must get the row, with
		// its numbers. B carries no sqlActivity at all, so it must get NO row
		// in this table — under the old index-paired bug, the two are swapped:
		// A's row vanishes and "1381" appears glued to B's label instead.
		expect(lineA).toBeDefined();
		expect(lineA).toContain("1381");
		expect(lineB).toBeUndefined();
	});
});
