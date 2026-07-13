import { describe, expect, test } from "bun:test";

const CLI = "src/cli/index.ts";

describe("CLI analyze-source command", () => {
	test("analyzes source directory and returns JSON", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"run",
				CLI,
				"analyze-source",
				"test/fixtures/source",
				"-f",
				"json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		const text = await new Response(proc.stdout).text();
		const result = JSON.parse(text);
		expect(proc.exitCode).toBe(0);
		expect(result.files).toBeGreaterThan(0);
		expect(result.objects).toBeDefined();
		expect(result.findings).toBeDefined();
		expect(result.findings.length).toBeGreaterThan(0);
	});

	test("includes nested loop findings", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"run",
				CLI,
				"analyze-source",
				"test/fixtures/source",
				"-f",
				"json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		const text = await new Response(proc.stdout).text();
		const result = JSON.parse(text);

		const nestedLoop = result.findings.find(
			(f: any) => f.id === "nested-loops",
		);
		expect(nestedLoop).toBeDefined();
	});

	test("orders findings by severity when impact ties at zero", async () => {
		// analyze-source has no profile, so every finding — the detected
		// patterns AND the inline record-ops-in-loop findings — carries
		// impact: 0. Without a severity fallback, the entire findings list
		// ties at zero and keeps whatever arbitrary order the array happened
		// to have.
		const proc = Bun.spawn(
			[
				"bun",
				"run",
				CLI,
				"analyze-source",
				"test/fixtures/source",
				"-f",
				"json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		const text = await new Response(proc.stdout).text();
		const result = JSON.parse(text);

		expect(result.findings.every((f: any) => f.impact === 0)).toBe(true);

		const rank: Record<string, number> = { critical: 3, warning: 2, info: 1 };
		for (let i = 1; i < result.findings.length; i++) {
			expect(rank[result.findings[i].severity]).toBeLessThanOrEqual(
				rank[result.findings[i - 1].severity],
			);
			// Within the same severity, ids break ties deterministically.
			if (result.findings[i].severity === result.findings[i - 1].severity) {
				expect(
					String(result.findings[i - 1].id).localeCompare(
						result.findings[i].id,
					),
				).toBeLessThanOrEqual(0);
			}
		}

		// Guard against a vacuous pass: the fixture must produce more than one
		// severity level.
		const severities = new Set(result.findings.map((f: any) => f.severity));
		expect(severities.size).toBeGreaterThan(1);
	});

	test("includes table clusters when present", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"run",
				CLI,
				"analyze-source",
				"test/fixtures/source",
				"-f",
				"json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		const text = await new Response(proc.stdout).text();
		const result = JSON.parse(text);

		expect(result.tableClusters).toBeDefined();
		expect(Array.isArray(result.tableClusters)).toBe(true);
	});

	test("--help lists analyze-source command", async () => {
		const proc = Bun.spawn(["bun", "run", CLI, "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const text = await new Response(proc.stdout).text();
		expect(text).toContain("analyze-source");
	});
});
