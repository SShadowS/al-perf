import { describe, expect, test } from "bun:test";
import {
	formatAnalysisMarkdown,
	formatComparisonMarkdown,
} from "../../../src/cli/formatters/markdown.js";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";
import type {
	FusionViews,
	HotspotAnnotation,
	PrioritizedFinding,
} from "../../../src/semantic/views.js";

const FIXTURES = "test/fixtures";

describe("formatAnalysisMarkdown", () => {
	test("includes markdown header", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisMarkdown(result);
		expect(output).toContain("# AL Profile Analysis");
	});

	test("includes summary section", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisMarkdown(result);
		expect(output).toContain("## Summary");
		expect(output).toContain("sampling");
	});

	test("includes hotspots as markdown table", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisMarkdown(result);
		expect(output).toContain("## Top Hotspots");
		expect(output).toContain("| # |");
		expect(output).toContain("ProcessLine");
	});

	test("includes detected patterns with severity badges", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisMarkdown(result);
		expect(output).toContain("## Detected Patterns");
		expect(output).toMatch(/\*\*(CRITICAL|WARNING|INFO)\*\*/);
	});

	test("includes app breakdown", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisMarkdown(result);
		expect(output).toContain("## App Breakdown");
		expect(output).toContain("My Extension");
	});

	test("includes suggestion when pattern has one", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisMarkdown(result);
		if (result.patterns.some((p) => p.suggestion)) {
			expect(output).toContain("**Suggestion:**");
		}
	});

	test("includes confidence and health scores", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisMarkdown(result);
		expect(output).toContain("Confidence");
		expect(output).toContain("Health");
	});

	test("includes object breakdown section", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisMarkdown(result);
		expect(output).toContain("## Object Breakdown");
		expect(output).toContain("My Processor");
		expect(output).toContain("50000");
	});

	test("includes explanation section when present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.explanation = "This profile shows significant time in ProcessLine.";
		const output = formatAnalysisMarkdown(result);
		expect(output).toContain("## AI Analysis");
		expect(output).toContain(
			"This profile shows significant time in ProcessLine.",
		);
	});

	test("omits explanation section when not present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisMarkdown(result);
		expect(output).not.toContain("## AI Analysis");
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

describe("formatAnalysisMarkdown — fusion section", () => {
	test("fusion section renders prioritized findings", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.fusionViews = SAMPLE_FUSION_VIEWS;
		const out = formatAnalysisMarkdown(result);
		expect(out).toContain("## Runtime-Prioritized Static Findings");
		expect(out).toContain("N+1 query");
	});

	test("fusion section absent => output byte-unchanged", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.fusionViews).toBeUndefined();
		const out = formatAnalysisMarkdown(result);
		expect(out).not.toContain("Runtime-Prioritized");
	});

	test("result.hotspots[i] schema unchanged when fusion is on (R2-5)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const snapshotBefore = JSON.stringify(result.hotspots);
		result.fusionViews = SAMPLE_FUSION_VIEWS;
		formatAnalysisMarkdown(result);
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
		const out = formatAnalysisMarkdown(result);
		expect(out).toContain("coverage incomplete");
		expect(out).not.toContain("no static findings");
	});

	test("locks ambiguous / blind-spot / matched-clean honesty states (R2-9/R2-10)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const h = result.hotspots[0];
		const attrKey = `${h.functionName}_${h.objectType}_${h.objectId}`;
		const summary = {
			matched: 1,
			matchedClean: 0,
			ambiguous: 0,
			blindSpot: 0,
			coldCount: 0,
			unkeyableCount: 0,
			orphanCount: 0,
		};
		const makeFinding = (id: string) => ({
			id,
			fingerprint: `fp-${id}`,
			detector: "n-plus-one",
			title: `Finding ${id}`,
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
		});

		// ambiguous: 2 findings → "ambiguous"/"possible", never "caused by"
		const ambiguous: HotspotAnnotation = {
			attrKey,
			status: "ambiguous",
			attributionConfidence: "exact",
			findings: [makeFinding("A1"), makeFinding("A2")],
		};
		result.fusionViews = {
			hotspotAnnotations: [ambiguous],
			prioritizedFindings: [],
			unweightedFindings: [],
			correlationSummary: summary,
		};
		let out = formatAnalysisMarkdown(result);
		expect(out).toContain("ambiguous");
		expect(out).toContain("possible");
		expect(out).not.toContain("caused by");

		// blind-spot: reason surfaced verbatim
		const blindSpot: HotspotAnnotation = {
			attrKey,
			status: "blind-spot",
			attributionConfidence: "exact",
			findings: [],
			reason: "not statically analyzed (opaque dependency)",
		};
		result.fusionViews = {
			hotspotAnnotations: [blindSpot],
			prioritizedFindings: [],
			unweightedFindings: [],
			correlationSummary: summary,
		};
		out = formatAnalysisMarkdown(result);
		expect(out).toContain("not statically analyzed");

		// matched-clean: findings [], matchedClean true → "no static findings", not degraded
		const matchedClean: HotspotAnnotation = {
			attrKey,
			status: "matched",
			attributionConfidence: "exact",
			findings: [],
			matchedClean: true,
		};
		result.fusionViews = {
			hotspotAnnotations: [matchedClean],
			prioritizedFindings: [],
			unweightedFindings: [],
			correlationSummary: summary,
		};
		out = formatAnalysisMarkdown(result);
		expect(out).toContain("no static findings");
		expect(out).not.toContain("coverage incomplete");
	});
});

describe("formatComparisonMarkdown", () => {
	test("includes comparison header", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatComparisonMarkdown(result);
		expect(output).toContain("# AL Profile Comparison");
	});

	test("includes before/after paths", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatComparisonMarkdown(result);
		expect(output).toContain("**Before:**");
		expect(output).toContain("**After:**");
	});

	test("includes delta summary with direction", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatComparisonMarkdown(result);
		expect(output).toContain("## Delta Summary");
		expect(output).toMatch(/SLOWER|FASTER|UNCHANGED/);
	});

	test("includes regressions table if present", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatComparisonMarkdown(result);
		if (result.regressions.length > 0) {
			expect(output).toContain("## Regressions");
			expect(output).toContain("| Function |");
		}
	});
});

// ---------------------------------------------------------------------------
// runtime-correlated badge tests (P3.1, R3-6)
// ---------------------------------------------------------------------------

const BASE_FINDING_MD: PrioritizedFinding = {
	finding: {
		id: "F1",
		fingerprint: "fp1",
		detector: "d1-db-op-in-loop",
		title: "DB op in loop",
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
};

describe("formatAnalysisMarkdown — runtime-correlated badge (P3.1)", () => {
	test("badge present in prioritized findings row when corroboratingPatterns is set", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.fusionViews = {
			hotspotAnnotations: [],
			prioritizedFindings: [
				{ ...BASE_FINDING_MD, corroboratingPatterns: ["repeated-siblings"] },
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
		const out = formatAnalysisMarkdown(result);
		expect(out).toContain("runtime-correlated");
		expect(out).toContain("repeated-siblings");
	});

	test("badge absent when corroboratingPatterns not set", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.fusionViews = {
			hotspotAnnotations: [],
			prioritizedFindings: [BASE_FINDING_MD],
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
		const out = formatAnalysisMarkdown(result);
		expect(out).not.toContain("runtime-correlated");
	});

	test("NEVER uses the word 'runtime-confirmed' (R3-6 honesty guard)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.fusionViews = {
			hotspotAnnotations: [],
			prioritizedFindings: [
				{ ...BASE_FINDING_MD, corroboratingPatterns: ["repeated-siblings"] },
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
		const out = formatAnalysisMarkdown(result);
		expect(out).not.toContain("runtime-confirmed");
	});

	test("badge present in in-place hotspot annotation when annotation has corroboratingPatterns", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const h = result.hotspots[0];
		const annotationWithBadge: HotspotAnnotation = {
			attrKey: `${h.functionName}_${h.objectType}_${h.objectId}`,
			status: "matched",
			attributionConfidence: "exact",
			findings: [
				{
					id: "F1",
					fingerprint: "fp1",
					detector: "d1-db-op-in-loop",
					title: "DB op in loop",
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
			],
			corroboratingPatterns: ["repeated-siblings"],
		};
		result.fusionViews = {
			hotspotAnnotations: [annotationWithBadge],
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
		const out = formatAnalysisMarkdown(result);
		expect(out).toContain("runtime-correlated");
		expect(out).toContain("repeated-siblings");
		expect(out).not.toContain("runtime-confirmed");
	});
});
