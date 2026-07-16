import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { $ } from "bun";
import { bySqlRankDesc } from "../../src/semantic/sql-evidence.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const CLI = "src/cli/index.ts";
const FIXTURES = "test/fixtures";

/** Minimal but fully-typed DetectedPattern stub — only `sqlRank` varies. */
function makePattern(id: string, sqlRank?: number): DetectedPattern {
	return {
		id,
		severity: "warning",
		title: id,
		description: "",
		impact: 0,
		involvedMethods: [],
		evidence: "",
		sqlRank,
	};
}

describe("CLI E2E", () => {
	test("analyze outputs valid JSON with --format json", async () => {
		const result =
			await $`bun run ${CLI} analyze ${FIXTURES}/sampling-minimal.alcpuprofile -f json`.text();
		const parsed = JSON.parse(result);
		expect(parsed.meta.profileType).toBe("sampling");
		expect(parsed.hotspots.length).toBeGreaterThan(0);
	});

	test("analyze works on instrumentation profile", async () => {
		const result =
			await $`bun run ${CLI} analyze ${FIXTURES}/instrumentation-minimal.alcpuprofile -f json -n 2`.text();
		const parsed = JSON.parse(result);
		expect(parsed.meta.profileType).toBe("instrumentation");
		expect(parsed.hotspots).toHaveLength(2);
	});

	test("hotspots returns limited results", async () => {
		const result =
			await $`bun run ${CLI} hotspots ${FIXTURES}/sampling-minimal.alcpuprofile -f json -n 2`.text();
		const parsed = JSON.parse(result);
		expect(parsed.hotspots.length).toBeLessThanOrEqual(2);
	});

	test("compare outputs valid JSON", async () => {
		const result =
			await $`bun run ${CLI} compare ${FIXTURES}/sampling-minimal.alcpuprofile ${FIXTURES}/sampling-minimal.alcpuprofile -f json`.text();
		const parsed = JSON.parse(result);
		expect(parsed.meta.beforePath).toContain("sampling-minimal");
		expect(parsed.meta.afterPath).toContain("sampling-minimal");
		expect(parsed.summary.deltaTime).toBeDefined();
	});

	test("--help works", async () => {
		const result = await $`bun run ${CLI} --help`.text();
		expect(result).toContain("analyze");
		expect(result).toContain("hotspots");
		expect(result).toContain("compare");
	});

	describe("--sort sql", () => {
		// Unit-level: exercises the REAL production comparator (imported from
		// src/semantic/sql-evidence.ts, the same function both analyze.ts and
		// mcp/server.ts import) directly on hand-built DetectedPattern stubs —
		// no real profile or subprocess needed. Runs everywhere, independent of
		// the gitignored batch-recorded fixture, and — because it calls the
		// production function rather than re-deriving the comparator inline —
		// a regression in bySqlRankDesc itself reddens this test even on a
		// clean checkout with no fixtures at all.
		test("bySqlRankDesc sorts by sqlRank descending, undefined ranks last", () => {
			const patterns = [
				makePattern("a", 100),
				makePattern("b", undefined),
				makePattern("c", 500),
				makePattern("d", 0),
				makePattern("e"), // sqlRank omitted entirely
			];
			const sorted = [...patterns].sort(bySqlRankDesc);
			expect(sorted.map((p) => p.id)).toEqual(["c", "a", "d", "b", "e"]);
		});

		const PROFILE = `${FIXTURES}/batch-recorded/profile-1.alcpuprofile`;

		// Fixture is gitignored (real capture data) — skip when absent.
		test.skipIf(!existsSync(PROFILE))(
			"--sort sql orders findings by sqlRank descending (undefined ranks last)",
			async () => {
				const result =
					await $`bun run ${CLI} analyze ${PROFILE} -f json --sort sql`.text();
				const parsed = JSON.parse(result);
				const ranks = parsed.patterns.map(
					(p: { sqlRank?: number }) => p.sqlRank ?? -1,
				);
				const sorted = [...ranks].sort((a, b) => b - a);
				expect(ranks).toEqual(sorted);
				// Sanity: this fixture actually carries sql-ranked findings, so the
				// assertion above is exercising a real reorder, not a vacuous no-op.
				expect(ranks.some((r: number) => r > -1)).toBe(true);
			},
		);

		// Un-gated: exercises commander's own choices() validation, which needs
		// no SQL-bearing fixture at all — any profile file will do.
		test("--sort bogus is rejected by commander with the allowed choices listed", async () => {
			const proc =
				await $`bun run ${CLI} analyze ${FIXTURES}/sampling-minimal.alcpuprofile -f json --sort bogus`.nothrow();
			expect(proc.exitCode).not.toBe(0);
			const stderr = proc.stderr.toString();
			expect(stderr).toContain("--sort");
			expect(stderr).toContain("impact");
			expect(stderr).toContain("sql");
		});
	});
});
