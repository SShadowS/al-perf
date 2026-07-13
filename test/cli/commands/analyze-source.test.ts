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
			// Within the same severity, ids break ties deterministically by
			// codepoint order — NOT localeCompare(), which resolves the host's
			// ambient locale (e.g. Danish collation sorts "aa" after "z"). The
			// production tiebreak (sortPatterns, core/patterns.ts) compares ids
			// with plain `<`/`>`, so this assertion must use the same comparison
			// or it can fail on a host whose locale disagrees with codepoint order
			// while the production code is perfectly correct.
			if (result.findings[i].severity === result.findings[i - 1].severity) {
				const prevId = String(result.findings[i - 1].id);
				const currId = String(result.findings[i].id);
				const cmp = prevId < currId ? -1 : prevId > currId ? 1 : 0;
				expect(cmp).toBeLessThanOrEqual(0);
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

	test("analyzes BOTH dataitems of a report with two same-named OnAfterGetRecord triggers, without duplicating either", async () => {
		// Whole-branch review, final blocker: matchToSource collapsed all
		// same-named members in an object onto member #1. ReportTwoDataItems.al
		// (Report 50909) has Customer and Vendor dataitems, each with its own
		// OnAfterGetRecord — the single most ordinary BC report shape (header +
		// lines). Before the fix: Customer's CalcFields reported TWICE, Vendor's
		// CalcFields and Modify absent entirely.
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

		const onReport = (f: any) =>
			f.involvedMethods?.[0] === "OnAfterGetRecord (Report 50909)";
		const calcfields = result.findings.filter(
			(f: any) => f.id === "calcfields-in-loop" && onReport(f),
		);
		const modify = result.findings.filter(
			(f: any) => f.id === "modify-in-loop" && onReport(f),
		);
		expect(calcfields.length).toBe(2);
		expect(modify.length).toBe(1);
	});

	test("analyzes BOTH field OnValidate triggers of a table sharing the same trigger name", async () => {
		// TableTwoValidateTriggers.al (Table 50931): field "Customer No." has a
		// for-loop CalcFields; field "Related No." has a genuine repeat...until
		// Modify() — a real critical modify-in-loop, not an implicit-loop edge
		// case (table triggers are not per-row).
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

		const onTable = (f: any) =>
			f.involvedMethods?.[0] === "OnValidate (Table 50931)";
		const calcfields = result.findings.filter(
			(f: any) => f.id === "calcfields-in-loop" && onTable(f),
		);
		const modify = result.findings.filter(
			(f: any) => f.id === "modify-in-loop" && onTable(f),
		);
		expect(calcfields.length).toBe(1);
		expect(modify.length).toBe(1);
		expect(modify[0].severity).toBe("critical");
	});
});
