import { describe, expect, it } from "bun:test";
import { resolve } from "path";
import { formatBatch } from "../../../src/cli/formatters/index.js";
import { analyzeProfile } from "../../../src/core/analyzer.js";
import {
	aggregateResults,
	analyzeBatch,
} from "../../../src/core/batch-analyzer.js";
import type { ProfileMetadata } from "../../../src/types/batch.js";

const BATCH_DIR = resolve(import.meta.dir, "../../fixtures/batch");

describe("formatBatch markdown", () => {
	it("produces markdown output with all sections", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatch(result, "markdown");

		expect(output).toContain("# Batch Analysis");
		expect(output).toContain("## Recurring Patterns");
		expect(output).toContain("## Cumulative Hotspots");
		expect(output).toContain("## Activity Breakdown");
		expect(output).toContain("|");
	});
});

// ---------------------------------------------------------------------------
// sqlActivity batch section tests (Task 7)
// ---------------------------------------------------------------------------

describe("formatBatch markdown — sqlActivity section (Task 7)", () => {
	it("renders one row per profile carrying sqlActivity", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);
		result.profiles[0].sqlActivity = {
			measuredSqlCount: 1381,
			measuredSqlDurationMs: 382,
			sampledAttributedCostUs: 15000,
		};

		const output = formatBatch(result, "markdown");

		expect(output).toContain("## SQL Activity (measured vs sampled)");
		expect(output).toContain("1381");
	});

	it("omits sqlActivity section when no profile carries it", async () => {
		const result = await analyzeBatch([
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		]);

		const output = formatBatch(result, "markdown");

		expect(output).not.toContain("SQL Activity");
	});

	it("pairs sqlActivity by profilePath, not array index, when the duration sort inverts order", async () => {
		const resultA = await analyzeProfile(
			resolve(BATCH_DIR, "profile-1.alcpuprofile"),
		);
		const resultB = await analyzeProfile(
			resolve(BATCH_DIR, "profile-2.alcpuprofile"),
		);
		resultA.meta.totalSelfTime = 1000;
		resultB.meta.totalSelfTime = 999999;

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
		expect(result.activityBreakdown[0].metadata?.activityDescription).toBe(
			"Activity-B-Long",
		);
		expect(result.activityBreakdown[1].metadata?.activityDescription).toBe(
			"Activity-A-Short",
		);

		const out = formatBatch(result, "markdown");
		const sqlSectionStart = out.indexOf(
			"## SQL Activity (measured vs sampled)",
		);
		expect(sqlSectionStart).toBeGreaterThan(-1);
		const sqlLines = out.slice(sqlSectionStart).split("\n");
		const lineA = sqlLines.find((l) => l.includes("Activity-A-Short"));
		const lineB = sqlLines.find((l) => l.includes("Activity-B-Long"));
		expect(lineA).toBeDefined();
		expect(lineA).toContain("1381");
		expect(lineB).toBeUndefined();
	});
});
