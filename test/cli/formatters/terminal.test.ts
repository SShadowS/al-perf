import { describe, expect, test } from "bun:test";
import {
	formatAnalysisTerminal,
	formatComparisonTerminal,
} from "../../../src/cli/formatters/terminal.js";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";
import type {
	FusionViews,
	HotspotAnnotation,
} from "../../../src/semantic/views.js";

const FIXTURES = "test/fixtures";

describe("formatAnalysisTerminal", () => {
	test("includes profile summary", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisTerminal(result);
		expect(output).toContain("sampling");
		expect(output).toContain("3 nodes");
	});

	test("includes hotspots section", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisTerminal(result);
		expect(output).toContain("ProcessLine");
		expect(output).toContain("My Processor");
	});

	test("includes app breakdown", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisTerminal(result);
		expect(output).toContain("My Extension");
	});

	test("includes detected patterns", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisTerminal(result);
		expect(output).toContain("dominates");
	});

	test("includes explanation section when present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.explanation = "This profile shows significant time in ProcessLine.";
		const output = formatAnalysisTerminal(result);
		expect(output).toContain("AI Analysis");
		expect(output).toContain(
			"This profile shows significant time in ProcessLine.",
		);
	});

	test("includes pattern suggestion when present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisTerminal(result);
		if (result.patterns.some((p) => p.suggestion)) {
			expect(output).toContain("Suggestion:");
		}
	});

	test("includes object breakdown section", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisTerminal(result);
		expect(output).toContain("Object Breakdown");
		expect(output).toContain("My Processor");
		expect(output).toContain("50000");
		expect(output).toContain("ProcessLine");
	});

	test("omits explanation section when not present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisTerminal(result);
		expect(output).not.toContain("AI Analysis");
	});
});

describe("formatComparisonTerminal", () => {
	test("includes delta summary", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatComparisonTerminal(result);
		expect(output).toContain("Before");
		expect(output).toContain("After");
	});
});

// ---------------------------------------------------------------------------
// Fusion section tests (R2-2, R2-4, R2-5, R2-9/R2-10)
// ---------------------------------------------------------------------------

const SAMPLE_FUSION_VIEWS: FusionViews = {
	hotspotAnnotations: [],
	prioritizedFindings: [
		{
			finding: {
				id: "F1",
				fingerprint: "fp1",
				detector: "n-plus-one",
				title: "N+1 query",
				rootCause: "loop",
				severity: "high",
				confidence: { level: "likely" },
				primaryLocation: {
					file: "src/X.al",
					line: 5,
					column: 1,
					objectId: "g/Codeunit/1",
					objectName: "X",
				},
				affectedObjects: [],
				affectedTables: [],
			},
			functionName: "ProcessLine",
			objectType: "Codeunit",
			objectId: 1,
			appName: "App",
			selfTimePercent: 42,
			totalTimePercent: 50,
			efficiencyScore: 0.84,
			frameCount: 1,
			status: "matched",
			attributionConfidence: "exact",
		},
	],
	unweightedFindings: [],
	correlationSummary: {
		matched: 1,
		matchedClean: 0,
		ambiguous: 0,
		blindSpot: 0,
		coldCount: 0,
		unkeyableCount: 0,
		orphanCount: 0,
	},
};

describe("formatAnalysisTerminal — fusion section", () => {
	test("fusion section renders prioritized findings", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.fusionViews = SAMPLE_FUSION_VIEWS;
		const out = formatAnalysisTerminal(result);
		expect(out).toContain("Runtime-Prioritized Static Findings");
		expect(out).toContain("N+1 query");
	});

	test("fusion section absent => output byte-unchanged", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.fusionViews).toBeUndefined();
		const out = formatAnalysisTerminal(result);
		expect(out).not.toContain("Runtime-Prioritized");
	});

	test("result.hotspots[i] schema unchanged when fusion is on (R2-5)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const snapshotBefore = JSON.stringify(result.hotspots);
		result.fusionViews = SAMPLE_FUSION_VIEWS;
		formatAnalysisTerminal(result);
		// hotspots must not have been mutated
		expect(JSON.stringify(result.hotspots)).toBe(snapshotBefore);
	});

	test("matched, zero findings, degraded coverage => not 'clean' (R2-9/R2-10)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const h = result.hotspots[0];
		const degradedAnnotation: HotspotAnnotation = {
			attrKey: `${h.functionName}_${h.objectType}_${h.objectId}`,
			status: "matched",
			attributionConfidence: "exact",
			findings: [],
			matchedClean: undefined,
			reason: "matched; coverage incomplete",
		};
		result.fusionViews = {
			hotspotAnnotations: [degradedAnnotation],
			prioritizedFindings: [],
			unweightedFindings: [],
			correlationSummary: {
				matched: 1,
				matchedClean: 0,
				ambiguous: 0,
				blindSpot: 0,
				coldCount: 0,
				unkeyableCount: 0,
				orphanCount: 0,
			},
		};
		const out = formatAnalysisTerminal(result);
		expect(out).toContain("coverage incomplete");
		expect(out).not.toContain("no static findings");
	});
});
