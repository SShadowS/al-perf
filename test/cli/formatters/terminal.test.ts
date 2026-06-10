import { describe, expect, test } from "bun:test";
import {
	formatAnalysisTerminal,
	formatComparisonTerminal,
} from "../../../src/cli/formatters/terminal.js";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";
import type {
	FusionViews,
	HotspotAnnotation,
	PrioritizedFinding,
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
		let out = formatAnalysisTerminal(result);
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
		out = formatAnalysisTerminal(result);
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
		out = formatAnalysisTerminal(result);
		expect(out).toContain("no static findings");
		expect(out).not.toContain("coverage incomplete");
	});
});

// ---------------------------------------------------------------------------
// runtime-correlated badge tests (P3.1, R3-6)
// ---------------------------------------------------------------------------

function makeCorroboratedFinding(
	base: Omit<PrioritizedFinding, "corroboratingPatterns">,
	patterns: string[],
): PrioritizedFinding {
	return { ...base, corroboratingPatterns: patterns };
}

describe("formatAnalysisTerminal — runtime-correlated badge (P3.1)", () => {
	const baseFinding: PrioritizedFinding = {
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

	test("badge present in prioritized findings row when corroboratingPatterns is set", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.fusionViews = {
			hotspotAnnotations: [],
			prioritizedFindings: [
				makeCorroboratedFinding(baseFinding, ["repeated-siblings"]),
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
		const out = formatAnalysisTerminal(result);
		expect(out).toContain("runtime-correlated");
		expect(out).toContain("repeated-siblings");
	});

	test("badge absent when corroboratingPatterns not set", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.fusionViews = {
			hotspotAnnotations: [],
			prioritizedFindings: [baseFinding],
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
		expect(out).not.toContain("runtime-correlated");
	});

	test("NEVER uses the word 'runtime-confirmed' (R3-6 honesty guard)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.fusionViews = {
			hotspotAnnotations: [],
			prioritizedFindings: [
				makeCorroboratedFinding(baseFinding, ["repeated-siblings"]),
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
		const out = formatAnalysisTerminal(result);
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
		const out = formatAnalysisTerminal(result);
		expect(out).toContain("runtime-correlated");
		expect(out).toContain("repeated-siblings");
		expect(out).not.toContain("runtime-confirmed");
	});
});

// ---------------------------------------------------------------------------
// Causal chain render tests (P3.2b)
// ---------------------------------------------------------------------------

describe("formatAnalysisTerminal — causal chain (P3.2b)", () => {
	function makeBaseFinding(): PrioritizedFinding {
		return {
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
	}

	test("causal chain renders when causalSteps is present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const finding = makeBaseFinding();
		finding.causalSteps = [
			{
				note: "calls",
				routineName: "OnRun",
				objectType: "Codeunit",
				objectId: 50000,
				file: "ws:src/Cod50000.al",
				line: 5,
				selfTimePercent: 0,
				totalTimePercent: 90,
				isHot: false,
			},
			{
				note: "for loop",
				routineName: "ProcessLine",
				objectType: "Codeunit",
				objectId: 50000,
				file: "ws:src/Cod50000.al",
				line: 10,
				selfTimePercent: 42,
				totalTimePercent: 42,
				isHot: true,
			},
		];
		result.fusionViews = {
			hotspotAnnotations: [],
			prioritizedFindings: [finding],
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
		expect(out).toContain("causal chain");
		expect(out).toContain("OnRun");
		expect(out).toContain("ProcessLine");
		expect(out).toContain("for loop");
	});

	test("no causal chain rendered when causalSteps absent (byte-unchanged off)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const finding = makeBaseFinding();
		// causalSteps intentionally absent
		result.fusionViews = {
			hotspotAnnotations: [],
			prioritizedFindings: [finding],
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
		// Table still renders but NO causal chain section
		expect(out).toContain("Runtime-Prioritized Static Findings");
		expect(out).not.toContain("causal chain");
	});
});
