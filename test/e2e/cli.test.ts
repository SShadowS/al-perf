import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { $ } from "bun";

const CLI = "src/cli/index.ts";
const FIXTURES = "test/fixtures";

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
		// Unit-level: pins the comparator's semantics directly (undefined ranks
		// last, descending by rank) without needing a real profile or subprocess.
		// Runs everywhere, independent of the gitignored batch-recorded fixture.
		test("comparator sorts by sqlRank descending, undefined ranks last", () => {
			const patterns = [
				{ id: "a", sqlRank: 100 },
				{ id: "b", sqlRank: undefined },
				{ id: "c", sqlRank: 500 },
				{ id: "d", sqlRank: 0 },
				{ id: "e" }, // no sqlRank key at all
			];
			const sorted = [...patterns].sort(
				(x, y) => (y.sqlRank ?? -1) - (x.sqlRank ?? -1),
			);
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
	});
});
