import { describe, expect, it } from "bun:test";
import { resolve } from "path";
import { formatBatch } from "../../../src/cli/formatters/index.js";
import { analyzeBatch } from "../../../src/core/batch-analyzer.js";

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
});
