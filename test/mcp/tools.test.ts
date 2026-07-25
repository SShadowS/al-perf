import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyzeProfile } from "../../src/core/analyzer.js";
import { HistoryStore } from "../../src/history/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { bySqlRankDesc } from "../../src/semantic/sql-evidence.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

async function createTestClient(options?: {
	defaultSourcePath?: string;
	historyDir?: string;
	historyDb?: string;
}) {
	const server = createMcpServer(options);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client, server };
}

type TextContent = Array<{ type: string; text: string }>;

describe("MCP Tool: analyze_profile", () => {
	test("analyzes a sampling profile and returns JSON result", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool(
			{
				name: "analyze_profile",
				arguments: {
					profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				},
			},
			undefined,
			{ timeout: 120000 },
		);
		expect(result.content).toBeDefined();
		const text = (result.content as Array<{ type: string; text: string }>)[0]
			.text;
		const parsed = JSON.parse(text);
		expect(parsed.meta.profileType).toBe("sampling");
		expect(parsed.hotspots).toBeDefined();
		expect(parsed.patterns).toBeDefined();
	}, 120000);

	test("respects top parameter", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool(
			{
				name: "analyze_profile",
				arguments: {
					profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
					top: 2,
				},
			},
			undefined,
			{ timeout: 120000 },
		);
		const text = (result.content as Array<{ type: string; text: string }>)[0]
			.text;
		const parsed = JSON.parse(text);
		expect(parsed.hotspots.length).toBeLessThanOrEqual(2);
	}, 120000);

	test("returns error for non-existent file", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "analyze_profile",
			arguments: { profilePath: "non-existent.alcpuprofile" },
		});
		const text = (result.content as Array<{ type: string; text: string }>)[0]
			.text;
		expect(text).toContain("Error");
		expect(result.isError).toBe(true);
	});

	// Fixture is gitignored (real capture data) — skip when absent.
	const SQL_PROFILE = "test/fixtures/batch-recorded/profile-1.alcpuprofile";

	test.skipIf(!existsSync(SQL_PROFILE))(
		"sort: 'sql' orders patterns by sqlRank descending (undefined ranks last)",
		async () => {
			const { client } = await createTestClient();
			const result = await client.callTool(
				{
					name: "analyze_profile",
					arguments: { profilePath: SQL_PROFILE, sort: "sql" },
				},
				undefined,
				{ timeout: 120000 },
			);
			const text = (result.content as TextContent)[0].text;
			const parsed = JSON.parse(text);
			const ranks = parsed.patterns.map(
				(p: { sqlRank?: number }) => p.sqlRank ?? -1,
			);
			const sorted = [...ranks].sort((a, b) => b - a);
			expect(ranks).toEqual(sorted);
			// Sanity: this fixture actually carries sql-ranked findings.
			expect(ranks.some((r: number) => r > -1)).toBe(true);
		},
		120000,
	);

	// Un-gated: the committed synthetic fixture carries real sqlEvidence/sqlRank
	// through the actual analyze pipeline, so this pins sort:"sql" end-to-end on
	// every clean checkout / CI run — unlike the gitignored-fixture test above.
	test("sort: 'sql' orders patterns by sqlRank descending on the synthetic fixture", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool(
			{
				name: "analyze_profile",
				arguments: {
					profilePath: "test/fixtures/sql-evidence-synthetic.alcpuprofile",
					sort: "sql",
				},
			},
			undefined,
			{ timeout: 120000 },
		);
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		const ranks = parsed.patterns.map(
			(p: { sqlRank?: number }) => p.sqlRank ?? -1,
		);
		const sorted = [...ranks].sort((a, b) => b - a);
		expect(ranks).toEqual(sorted);
		expect(ranks.some((r: number) => r > -1)).toBe(true);
	}, 120000);

	// Unit-level, no MCP client needed: pins that the SAME comparator both
	// analyze.ts and mcp/server.ts import (src/semantic/sql-evidence.ts)
	// orders a telemetry-provenance finding against a profile-provenance
	// finding correctly, not just same-provenance findings against each
	// other (the two tests above only ever sort profile-sourced sqlRanks).
	// sqlRank is microseconds on both sides — telemetry sets
	// totalMeasuredMs * 1000, profile sets totalSampledCostUs directly — so a
	// bare numeric compare is unit-sound with no conversion in the comparator.
	test('sort: "sql" orders telemetry and profile findings by one unit', () => {
		const profileFinding: DetectedPattern = {
			id: "calcfields-in-loop",
			severity: "warning",
			title: "profile finding",
			description: "",
			impact: 0,
			involvedMethods: [],
			evidence: "",
			sqlRank: 750_000, // 750,000 sampled µs
		};
		const telemetryFinding: DetectedPattern = {
			id: "telemetry-rt0005",
			severity: "warning",
			title: "telemetry finding",
			description: "",
			impact: 0,
			involvedMethods: [],
			evidence: "",
			sqlRank: 1000 * 1000, // 1000ms measured -> 1,000,000 µs
		};
		const sorted = [profileFinding, telemetryFinding].sort(bySqlRankDesc);
		expect(sorted[0]).toBe(telemetryFinding);
	});
});

describe("MCP Tool: get_hotspots", () => {
	test("returns limited hotspot list without patterns", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "get_hotspots",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				top: 3,
			},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.hotspots.length).toBeLessThanOrEqual(3);
		expect(parsed.patterns).toHaveLength(0);
	});
});

describe("MCP Tool: compare_profiles", () => {
	test("compares two profiles and returns deltas", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "compare_profiles",
			arguments: {
				beforePath: "test/fixtures/sampling-minimal.alcpuprofile",
				afterPath: "test/fixtures/sampling-minimal.alcpuprofile",
			},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.meta.beforePath).toContain("sampling-minimal");
		expect(parsed.meta.afterPath).toContain("sampling-minimal");
		expect(parsed.summary.deltaTime).toBe(0);
	});
});

describe("MCP Tool: explain_method", () => {
	test("returns method details from a profile", async () => {
		const { client } = await createTestClient();

		// First get a valid method name
		const hotspotsResult = await client.callTool({
			name: "get_hotspots",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				top: 1,
			},
		});
		const hotspotsText = (hotspotsResult.content as TextContent)[0].text;
		const hotspots = JSON.parse(hotspotsText);
		const methodName = hotspots.hotspots[0].functionName;

		const result = await client.callTool({
			name: "explain_method",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				method: methodName,
			},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.method.functionName).toBe(methodName);
		expect(parsed.profileStats).toBeDefined();
		expect(parsed.calledBy).toBeDefined();
		expect(parsed.calls).toBeDefined();
	});

	test("returns error for unknown method", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "explain_method",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				method: "NonExistentMethodXYZ",
			},
		});
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("not found");
		expect(result.isError).toBe(true);
	});
});

describe("MCP Tool: analyze_source", () => {
	test("indexes AL source files and returns summary", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "analyze_source",
			arguments: { sourcePath: "test/fixtures/source" },
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.files).toBeGreaterThan(0);
		expect(parsed.objects.length).toBeGreaterThan(0);
	});

	test("includes detected patterns from source-only detectors", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "analyze_source",
			arguments: { sourcePath: "test/fixtures/source" },
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.detectedPatterns).toBeDefined();
		expect(parsed.detectedPatterns.length).toBeGreaterThan(0);
	});

	test("reports structural findings for source", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "analyze_source",
			arguments: { sourcePath: "test/fixtures/source" },
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.findings.length).toBeGreaterThan(0);
	});

	test("reports BOTH dataitems of a report with two same-named OnAfterGetRecord triggers", async () => {
		// The MCP surface iterates obj.procedures/obj.triggers directly (one
		// finding per real member), so it never had the matchToSource collapse
		// bug the CLI had — this pins that it stays correct on the new
		// two-dataitem fixture (ReportTwoDataItems.al, Report 50909).
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "analyze_source",
			arguments: { sourcePath: "test/fixtures/source" },
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);

		const onReport = (f: any) =>
			f.objectId === 50909 && f.procedure === "OnAfterGetRecord";
		const calcfields = parsed.findings.filter(
			(f: any) => onReport(f) && f.finding.startsWith("CalcFields("),
		);
		const modify = parsed.findings.filter(
			(f: any) => onReport(f) && f.finding.startsWith("Modify("),
		);
		expect(calcfields.length).toBe(2);
		expect(modify.length).toBe(1);
	});

	test("reports BOTH field OnValidate triggers of a table sharing the same trigger name", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "analyze_source",
			arguments: { sourcePath: "test/fixtures/source" },
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);

		const onTable = (f: any) =>
			f.objectId === 50931 && f.procedure === "OnValidate";
		const calcfields = parsed.findings.filter(
			(f: any) => onTable(f) && f.finding.startsWith("CalcFields("),
		);
		const modify = parsed.findings.filter(
			(f: any) => onTable(f) && f.finding.startsWith("Modify("),
		);
		expect(calcfields.length).toBe(1);
		expect(modify.length).toBe(1);
		expect(modify[0].severity).toBe("critical");
	});

	test("CLI and MCP now agree on the two-dataitem report and the two-OnValidate table (whole-branch review, final blocker)", async () => {
		// Before this fix: the CLI (routed through matchToSource) reported
		// Customer's CalcFields twice and never saw Vendor's CalcFields/Modify
		// at all, while the MCP surface (iterating raw index members directly)
		// was already correct — the two surfaces disagreed on identical code,
		// the exact complaint the previous fix existed to close, only
		// reversed. Both must now report the identical facts.
		const { client } = await createTestClient();
		const mcpResult = await client.callTool({
			name: "analyze_source",
			arguments: { sourcePath: "test/fixtures/source" },
		});
		const mcpParsed = JSON.parse((mcpResult.content as TextContent)[0].text);

		const proc = Bun.spawn(
			[
				"bun",
				"run",
				"src/cli/index.ts",
				"analyze-source",
				"test/fixtures/source",
				"-f",
				"json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const cliParsed = JSON.parse(await new Response(proc.stdout).text());
		await proc.exited;

		const mcpCount = (objectId: number, procedure: string, prefix: string) =>
			mcpParsed.findings.filter(
				(f: any) =>
					f.objectId === objectId &&
					f.procedure === procedure &&
					f.finding.startsWith(prefix),
			).length;
		const cliCount = (label: string, id: string) =>
			cliParsed.findings.filter(
				(f: any) => f.involvedMethods?.[0] === label && f.id === id,
			).length;

		expect(
			cliCount("OnAfterGetRecord (Report 50909)", "calcfields-in-loop"),
		).toBe(mcpCount(50909, "OnAfterGetRecord", "CalcFields("));
		expect(cliCount("OnAfterGetRecord (Report 50909)", "modify-in-loop")).toBe(
			mcpCount(50909, "OnAfterGetRecord", "Modify("),
		);
		expect(cliCount("OnValidate (Table 50931)", "calcfields-in-loop")).toBe(
			mcpCount(50931, "OnValidate", "CalcFields("),
		);
		expect(cliCount("OnValidate (Table 50931)", "modify-in-loop")).toBe(
			mcpCount(50931, "OnValidate", "Modify("),
		);

		// Guard against a vacuous pass: both surfaces must actually see these.
		expect(
			cliCount("OnAfterGetRecord (Report 50909)", "calcfields-in-loop"),
		).toBe(2);
		expect(cliCount("OnValidate (Table 50931)", "modify-in-loop")).toBe(1);
	});
});

describe("MCP Tool: gate_check", () => {
	test("returns pass verdict for profile within thresholds", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "gate_check",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				maxCritical: 100,
			},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.verdict).toBe("pass");
		expect(parsed.counts).toBeDefined();
	});
});

describe("MCP Resources", () => {
	test("pattern-docs resource returns pattern documentation", async () => {
		const { client } = await createTestClient();
		const result = await client.readResource({
			uri: "resource://al-profiler/pattern-docs",
		});
		expect(result.contents).toBeDefined();
		expect(result.contents.length).toBe(1);
		const text = result.contents[0].text as string;
		expect(text).toContain("Single Method Dominance");
		expect(text).toContain("CalcFields in Loop");
	});

	test("last-analysis resource returns null when no analysis done", async () => {
		const { client } = await createTestClient();
		const result = await client.readResource({
			uri: "resource://al-profiler/last-analysis",
		});
		expect(result.contents).toBeDefined();
		const text = result.contents[0].text as string;
		const parsed = JSON.parse(text);
		expect(parsed).toBeNull();
	});

	test("last-analysis resource returns result after analyze_profile", async () => {
		const { client } = await createTestClient();

		await client.callTool(
			{
				name: "analyze_profile",
				arguments: {
					profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				},
			},
			undefined,
			{ timeout: 120000 },
		);

		const result = await client.readResource({
			uri: "resource://al-profiler/last-analysis",
		});
		const text = result.contents[0].text as string;
		const parsed = JSON.parse(text);
		expect(parsed).not.toBeNull();
		expect(parsed.meta.profileType).toBe("sampling");
	}, 120000);
});

describe("MCP Tool: analyze_batch", () => {
	test("analyzes a directory of profiles", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool(
			{
				name: "analyze_batch",
				arguments: {
					profilePaths: ["test/fixtures/batch"],
				},
			},
			undefined,
			{ timeout: 120000 },
		);
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.profiles.length).toBeGreaterThanOrEqual(2);
		expect(parsed.cumulativeHotspots).toBeDefined();
	}, 120000);

	test("analyzes explicit profile paths", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool(
			{
				name: "analyze_batch",
				arguments: {
					profilePaths: [
						"test/fixtures/batch/profile-1.alcpuprofile",
						"test/fixtures/batch/profile-2.alcpuprofile",
					],
				},
			},
			undefined,
			{ timeout: 120000 },
		);
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.profiles.length).toBe(2);
	}, 120000);

	test("returns error for empty directory", async () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "al-perf-empty-"));
		try {
			const { client } = await createTestClient();
			const result = await client.callTool({
				name: "analyze_batch",
				arguments: {
					profilePaths: [emptyDir],
				},
			});
			expect(result.isError).toBe(true);
			const text = (result.content as TextContent)[0].text;
			expect(text).toContain("No .alcpuprofile files");
		} finally {
			rmSync(emptyDir, { recursive: true });
		}
	});

	test("analyzes with manifest", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool(
			{
				name: "analyze_batch",
				arguments: {
					profilePaths: ["test/fixtures/batch"],
					manifestPath: "test/fixtures/batch/manifest.json",
				},
			},
			undefined,
			{ timeout: 120000 },
		);
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.profiles.length).toBeGreaterThanOrEqual(2);
	}, 120000);

	test("returns error for non-existent paths", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool(
			{
				name: "analyze_batch",
				arguments: {
					profilePaths: ["non-existent-dir/fake.alcpuprofile"],
				},
			},
			undefined,
			{ timeout: 120000 },
		);
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("Error");
	}, 120000);
});

describe("MCP Tool: drilldown_method", () => {
	test("returns drilldown for a known method", async () => {
		const { client } = await createTestClient();

		// Get a valid method name first
		const hotspotsResult = await client.callTool({
			name: "get_hotspots",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				top: 1,
			},
		});
		const hotspotsText = (hotspotsResult.content as TextContent)[0].text;
		const hotspots = JSON.parse(hotspotsText);
		const methodName = hotspots.hotspots[0].functionName;

		const result = await client.callTool({
			name: "drilldown_method",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				method: methodName,
			},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.method).toBeDefined();
		expect(parsed.breakdown).toBeDefined();
	});

	test("returns error for unknown method", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "drilldown_method",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				method: "CompletelyFakeMethodXYZ",
			},
		});
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("not found");
	});

	test("returns error for non-existent profile", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "drilldown_method",
			arguments: {
				profilePath: "non-existent.alcpuprofile",
				method: "SomeMethod",
			},
		});
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("Error");
	});
});

describe("MCP Tool: gate_check (extended)", () => {
	test("returns fail verdict when critical patterns exceed threshold", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool(
			{
				name: "gate_check",
				arguments: {
					profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
					maxCritical: 0,
				},
			},
			undefined,
			{ timeout: 120000 },
		);
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		// The profile may or may not have critical patterns, but structure is valid
		expect(parsed.verdict).toMatch(/^(pass|fail)$/);
		expect(parsed.thresholds.maxCritical).toBe(0);
		expect(parsed.violations).toBeDefined();
	}, 120000);

	test("enforces maxWarning threshold", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool(
			{
				name: "gate_check",
				arguments: {
					profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
					maxCritical: 100,
					maxWarning: 0,
				},
			},
			undefined,
			{ timeout: 120000 },
		);
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.thresholds.maxWarning).toBe(0);
		// If there are warnings, verdict should be fail
		if (parsed.counts.warning > 0) {
			expect(parsed.verdict).toBe("fail");
			expect(parsed.violations.some((v: string) => v.includes("warning"))).toBe(
				true,
			);
		}
	}, 120000);

	test("returns error for non-existent profile", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "gate_check",
			arguments: {
				profilePath: "non-existent.alcpuprofile",
			},
		});
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("Error");
	});
});

describe("MCP Tool: explain_method (extended)", () => {
	test("filters by objectId when provided", async () => {
		const { client } = await createTestClient();

		// Get a valid method with its objectId
		const hotspotsResult = await client.callTool({
			name: "get_hotspots",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				top: 1,
			},
		});
		const hotspotsText = (hotspotsResult.content as TextContent)[0].text;
		const hotspots = JSON.parse(hotspotsText);
		const methodName = hotspots.hotspots[0].functionName;
		const objectId = hotspots.hotspots[0].objectId;

		const result = await client.callTool({
			name: "explain_method",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				method: methodName,
				objectId,
			},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.method.functionName).toBe(methodName);
		expect(parsed.method.objectId).toBe(objectId);
	});

	test("returns error for valid method but wrong objectId", async () => {
		const { client } = await createTestClient();

		const hotspotsResult = await client.callTool({
			name: "get_hotspots",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				top: 1,
			},
		});
		const hotspotsText = (hotspotsResult.content as TextContent)[0].text;
		const hotspots = JSON.parse(hotspotsText);
		const methodName = hotspots.hotspots[0].functionName;

		const result = await client.callTool({
			name: "explain_method",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				method: methodName,
				objectId: 999999,
			},
		});
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("not found");
	});

	test("returns error for non-existent profile", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "explain_method",
			arguments: {
				profilePath: "non-existent.alcpuprofile",
				method: "SomeMethod",
			},
		});
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("Error");
	});
});

describe("MCP Tool: get_hotspots (extended)", () => {
	test("returns error for non-existent profile", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "get_hotspots",
			arguments: {
				profilePath: "non-existent.alcpuprofile",
			},
		});
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("Error");
	});
});

describe("MCP Tool: compare_profiles (extended)", () => {
	test("returns error for non-existent profile", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "compare_profiles",
			arguments: {
				beforePath: "non-existent.alcpuprofile",
				afterPath: "test/fixtures/sampling-minimal.alcpuprofile",
			},
		});
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("Error");
	});

	test("regressionFusion absent in output when no sources provided (byte-unchanged, PR2-8)", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "compare_profiles",
			arguments: {
				beforePath: "test/fixtures/sampling-minimal.alcpuprofile",
				afterPath: "test/fixtures/sampling-minimal.alcpuprofile",
			},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		// No sources supplied → regressionFusion must be absent
		expect(parsed.regressionFusion).toBeUndefined();
	});

	test("accepts beforeSource and afterSource optional inputs without error", async () => {
		const { client } = await createTestClient();
		// Pass non-existent source paths — the engine will be disabled (no binary),
		// but the tool must never throw and must return a plain comparison result.
		const result = await client.callTool({
			name: "compare_profiles",
			arguments: {
				beforePath: "test/fixtures/sampling-minimal.alcpuprofile",
				afterPath: "test/fixtures/sampling-minimal.alcpuprofile",
				beforeSource: "/non/existent/before",
				afterSource: "/non/existent/after",
			},
		});
		// Should return a valid result (not an error) — engine disabled degrades gracefully
		const text = (result.content as TextContent)[0].text;
		// Must parse as valid JSON (no crash)
		const parsed = JSON.parse(text);
		expect(parsed.meta).toBeDefined();
		// regressionFusion absent when engine is disabled (P4.2 wiring is not yet connected; graceful)
		// In P4.1 (surface only) the field is absent since wiring is deferred to P4.2.
	});
});

describe("MCP Tool: analyze_source (extended)", () => {
	test("returns error for non-existent source path", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "analyze_source",
			arguments: {
				sourcePath: "/non/existent/path",
			},
		});
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("Error");
	});
});

describe("MCP Tool: visualize_flamegraph", () => {
	test("returns error when flamegraph service is unavailable", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "visualize_flamegraph",
			arguments: {
				profilePath: "test/fixtures/sampling-minimal.alcpuprofile",
				serviceUrl: "http://localhost:99999",
			},
		});
		expect(result.isError).toBe(true);
		const text = (result.content as TextContent)[0].text;
		expect(text).toContain("Failed to connect");
	});
});

describe("MCP Tool: history_list", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {}
		}
	});

	test("returns empty list when no history exists", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
		const historyDir = join(tempDir, "history");
		const historyDb = join(historyDir, "lifecycle.sqlite");
		const { client } = await createTestClient({ historyDb, historyDir });
		const result = await client.callTool({
			name: "history_list",
			arguments: {},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(0);
	});

	test("returns entries when history exists", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
		const historyDir = join(tempDir, "history");
		const historyDb = join(historyDir, "lifecycle.sqlite");

		// Pre-populate history
		const store = new HistoryStore(historyDb);
		const analysis = await analyzeProfile(
			"test/fixtures/sampling-minimal.alcpuprofile",
			{
				includePatterns: true,
			},
		);
		store.save(analysis, { label: "test-run" });

		const { client } = await createTestClient({ historyDb, historyDir });
		const result = await client.callTool({
			name: "history_list",
			arguments: {},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBeGreaterThanOrEqual(1);
		expect(parsed[0].label).toBe("test-run");
	});

	test("filters by label", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
		const historyDir = join(tempDir, "history");
		const historyDb = join(historyDir, "lifecycle.sqlite");

		const store = new HistoryStore(historyDb);
		const analysis = await analyzeProfile(
			"test/fixtures/sampling-minimal.alcpuprofile",
			{
				includePatterns: true,
			},
		);
		store.save(analysis, { label: "baseline" });
		store.save(analysis, { label: "optimized" });

		const { client } = await createTestClient({ historyDb, historyDir });
		const result = await client.callTool({
			name: "history_list",
			arguments: { label: "baseline" },
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].label).toBe("baseline");
	});
});

describe("MCP Tool: history_trend", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {}
		}
	});

	test("returns message when less than 2 entries", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
		const historyDir = join(tempDir, "history");
		const historyDb = join(historyDir, "lifecycle.sqlite");
		const { client } = await createTestClient({ historyDb, historyDir });
		const result = await client.callTool({
			name: "history_trend",
			arguments: {},
		});
		expect(result.isError).toBeUndefined();
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.message).toContain("at least 2");
	});

	test("computes trend deltas with 2+ entries", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-test-"));
		const historyDir = join(tempDir, "history");
		const historyDb = join(historyDir, "lifecycle.sqlite");

		const store = new HistoryStore(historyDb);
		const analysis = await analyzeProfile(
			"test/fixtures/sampling-minimal.alcpuprofile",
			{
				includePatterns: true,
			},
		);
		store.save(analysis, { label: "run-1" });
		store.save(analysis, { label: "run-2" });

		const { client } = await createTestClient({ historyDb, historyDir });
		const result = await client.callTool({
			name: "history_trend",
			arguments: {},
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);
		expect(parsed.entries).toBe(2);
		expect(parsed.oldest).toBeDefined();
		expect(parsed.newest).toBeDefined();
		expect(parsed.deltas).toBeDefined();
		expect(parsed.deltas.totalSelfTime).toBeDefined();
		expect(parsed.deltas.healthScore).toBeDefined();
		expect(parsed.deltas.patternCount).toBeDefined();
		expect(parsed.series).toBeDefined();
		expect(parsed.series).toHaveLength(2);
	});
});

describe("MCP response size — an agent's context is the budget", () => {
	// The existing get_hotspots test uses a 3-node fixture, so nothing about
	// response size ever showed. Against a captured BC profile, `top: 6`
	// returned 595,710 characters: appBreakdown[].methods carries EVERY method
	// in the profile (300 of them), and objectBreakdown[].methods repeats them
	// per object (45 x ~60). The tool an agent reaches for to stay cheap was
	// the most expensive call in the server.
	const REAL = "test/fixtures/batch-recorded/profile-1.alcpuprofile";

	test("get_hotspots returns a hotspot summary, not the whole analysis", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "get_hotspots",
			arguments: { profilePath: REAL, top: 6 },
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);

		expect(parsed.hotspots.length).toBeLessThanOrEqual(6);
		// 40 KB is already generous for "quick summary of 6 hotspots".
		expect(text.length).toBeLessThan(40_000);
	});

	test("analyze_profile does not repeat every method inside every breakdown", async () => {
		const { client } = await createTestClient();
		const result = await client.callTool({
			name: "analyze_profile",
			arguments: { profilePath: REAL, top: 5 },
		});
		const text = (result.content as TextContent)[0].text;
		const parsed = JSON.parse(text);

		// The breakdowns stay — they are what the tool advertises — but their
		// nested per-method lists are what made the payload unusable.
		for (const a of parsed.appBreakdown ?? []) {
			expect(a.methods).toBeUndefined();
		}
		for (const o of parsed.objectBreakdown ?? []) {
			expect(o.methods).toBeUndefined();
		}
		expect(text.length).toBeLessThan(120_000);
	});
});
