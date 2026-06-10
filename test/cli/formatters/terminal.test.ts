import { describe, expect, test } from "bun:test";
import {
	formatAnalysisTerminal,
	formatComparisonTerminal,
} from "../../../src/cli/formatters/terminal.js";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";
import type { RegressionFusion } from "../../../src/semantic/regression-correlate.js";
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
// Regression-fusion render tests (P4.1, PR2-1..PR2-8)
// ---------------------------------------------------------------------------

/**
 * Hand-crafted RegressionFusion fixture covering all tiers:
 * - correlated (strong total-basis delta — capability-gained-write)
 * - weakly-correlated (weak self-basis delta — capability-gained-telemetry)
 * - unexplained-static (no matching delta)
 * - a new-method correlation (procedure-added)
 * - a version mismatch
 */
const SAMPLE_REGRESSION_FUSION: RegressionFusion = {
	annotatedRegressions: [
		{
			// correlated — strong total-basis delta
			method: {
				functionName: "ProcessSales",
				objectType: "Codeunit",
				objectName: "Sales Processor",
				objectId: 50001,
				appName: "My App",
				beforeSelfTime: 100000,
				afterSelfTime: 105000,
				deltaSelfTime: 5000,
				deltaPercent: 5,
				beforeTotalTime: 200000,
				afterTotalTime: 280000,
				deltaTotalTime: 80000,
				deltaTotalPercent: 40,
				beforeHitCount: 10,
				afterHitCount: 10,
			},
			staticDeltas: [
				{
					category: "capabilities",
					kind: "capability-gained-write",
					severity: "warning",
					displayName: "ProcessSales",
					basis: "total",
					strength: "strong",
					resourceKind: "table",
					resourceId: "Sales Header",
					op: "insert",
				},
			],
			status: "correlated",
		},
		{
			// weakly-correlated — only weak delta (telemetry)
			method: {
				functionName: "LogEvent",
				objectType: "Codeunit",
				objectName: "Logger",
				objectId: 50002,
				appName: "My App",
				beforeSelfTime: 50000,
				afterSelfTime: 55000,
				deltaSelfTime: 5000,
				deltaPercent: 10,
				beforeTotalTime: 60000,
				afterTotalTime: 65000,
				deltaTotalTime: 5000,
				deltaTotalPercent: 8.3,
				beforeHitCount: 5,
				afterHitCount: 5,
			},
			staticDeltas: [
				{
					category: "capabilities",
					kind: "capability-gained-telemetry",
					severity: "info",
					displayName: "LogEvent",
					basis: "self",
					strength: "weak",
				},
			],
			status: "weakly-correlated",
		},
		{
			// unexplained-static — no matching delta
			method: {
				functionName: "ValidateItem",
				objectType: "Codeunit",
				objectName: "Item Validator",
				objectId: 50003,
				appName: "My App",
				beforeSelfTime: 30000,
				afterSelfTime: 45000,
				deltaSelfTime: 15000,
				deltaPercent: 50,
				beforeTotalTime: 35000,
				afterTotalTime: 50000,
				deltaTotalTime: 15000,
				deltaTotalPercent: 43,
				beforeHitCount: 3,
				afterHitCount: 3,
			},
			staticDeltas: [],
			status: "unexplained-static",
		},
	],
	newMethodCorrelations: [
		{
			method: {
				functionName: "NewHotProcedure",
				objectType: "Codeunit",
				objectName: "New Logic",
				objectId: 50010,
				appName: "My App",
				selfTime: 80000,
				selfTimePercent: 8,
				totalTime: 80000,
				totalTimePercent: 8,
				hitCount: 4,
				calledBy: [],
				calls: [],
			},
			delta: {
				category: "abi",
				kind: "procedure-added",
				severity: "info",
				displayName: "NewHotProcedure",
				basis: "self",
				strength: "strong",
			},
		},
	],
	removedMethodCorrelations: [],
	staticOnlyChanges: [
		{
			category: "events",
			kind: "capability-gained-event-publish",
			severity: "info",
			displayName: "PublishOrderEvent",
			basis: "none",
			strength: "weak",
		},
	],
	correlationSummary: {
		correlated: 1,
		weaklyCorrelated: 1,
		unexplained: 1,
		versionMismatch: {
			beforeProfileVersion: "1.0.0",
			beforeWorkspaceVersion: "0.9.0",
			afterProfileVersion: "1.0.1",
			afterWorkspaceVersion: "1.0.1",
		},
	},
};

describe("formatComparisonTerminal — regression-fusion annotations (P4.1)", () => {
	test("byte-unchanged when regressionFusion absent", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.regressionFusion).toBeUndefined();
		// Capture the no-fusion output.
		const noFusionOut = formatComparisonTerminal(result);
		// Attach fusion and re-render — must differ (so the gate has teeth).
		const resultWithFusion = {
			...result,
			regressionFusion: SAMPLE_REGRESSION_FUSION,
		};
		const withFusionOut = formatComparisonTerminal(resultWithFusion);
		// Full-equality assertion: the no-fusion render must NOT equal the fusion render.
		expect(noFusionOut).not.toBe(withFusionOut);
		// Fusion-related sections absent from no-fusion render.
		expect(noFusionOut).not.toContain("Regression-Fusion");
		expect(noFusionOut).not.toContain("correlated");
		expect(noFusionOut).not.toContain("unexplained-static");
		expect(noFusionOut).not.toContain("version ≠ source");
		// Confirm the no-fusion output doesn't contain the string "undefined" (optional-field guard).
		expect(noFusionOut).not.toContain("undefined");
	});

	test("version-mismatch warning rendered prominently at the top", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = SAMPLE_REGRESSION_FUSION;
		const out = formatComparisonTerminal(result);
		expect(out).toContain("profile version");
		expect(out).toContain("source version");
		expect(out).toContain("1.0.0");
		expect(out).toContain("0.9.0");
		// The warning must appear in the fusion block (after regressions)
		expect(out).toContain("correlations may be inaccurate");
	});

	test("after-version-mismatch: after profile version mismatch renders correctly", async () => {
		// Variant: before versions agree; ONLY the after profile version mismatches the workspace.
		const afterMismatchFusion: RegressionFusion = {
			...SAMPLE_REGRESSION_FUSION,
			correlationSummary: {
				...SAMPLE_REGRESSION_FUSION.correlationSummary,
				versionMismatch: {
					beforeProfileVersion: "1.0.0",
					beforeWorkspaceVersion: "1.0.0",
					afterProfileVersion: "1.0.1",
					afterWorkspaceVersion: "2.0.0",
				},
			},
		};
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = afterMismatchFusion;
		const out = formatComparisonTerminal(result);
		// The after mismatch must be rendered.
		expect(out).toContain("1.0.1");
		expect(out).toContain("2.0.0");
		expect(out).toContain("correlations may be inaccurate");
		// No "undefined" in the output (optional-field guard).
		expect(out).not.toContain("undefined");
	});

	test("correlated tier rendered prominently with delta info", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = SAMPLE_REGRESSION_FUSION;
		const out = formatComparisonTerminal(result);
		// correlated label
		expect(out).toContain("[correlated]");
		expect(out).toContain("ProcessSales");
		// delta detail
		expect(out).toContain("capability-gained-write");
		expect(out).toContain("Sales Header");
		expect(out).toContain("strong");
		// Optional-field guard: no "undefined" literal in output.
		expect(out).not.toContain("undefined");
	});

	test("weakly-correlated tier rendered muted with runtime-neutral wording", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = SAMPLE_REGRESSION_FUSION;
		const out = formatComparisonTerminal(result);
		expect(out).toContain("[weakly-correlated]");
		expect(out).toContain("runtime-neutral capability");
		expect(out).toContain("unlikely to explain the regression");
		// ensure LogEvent appears
		expect(out).toContain("LogEvent");
	});

	test("unexplained-static tier rendered with honest wording", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = SAMPLE_REGRESSION_FUSION;
		const out = formatComparisonTerminal(result);
		expect(out).toContain("[unexplained-static]");
		expect(out).toContain("no static change in this routine");
		expect(out).toContain("al-sem cannot explain it");
		expect(out).toContain("ValidateItem");
	});

	test("NEVER uses the word 'caused by' (PR2-2 honesty guard)", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = SAMPLE_REGRESSION_FUSION;
		const out = formatComparisonTerminal(result);
		expect(out).not.toContain("caused by");
		expect(out).not.toContain("Caused by");
	});

	test("NEVER uses the word 'runtime-confirmed' (honesty guard)", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = SAMPLE_REGRESSION_FUSION;
		const out = formatComparisonTerminal(result);
		expect(out).not.toContain("runtime-confirmed");
	});

	test("new-method headline rendered", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = SAMPLE_REGRESSION_FUSION;
		const out = formatComparisonTerminal(result);
		expect(out).toContain("New / Removed Hot Methods");
		expect(out).toContain("new hot method");
		expect(out).toContain("NewHotProcedure");
		expect(out).toContain("procedure-added");
	});

	test("static-only changes rendered with cross-boundary note for event deltas", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = SAMPLE_REGRESSION_FUSION;
		const out = formatComparisonTerminal(result);
		expect(out).toContain("Static-Only Changes");
		expect(out).toContain("externalized cost");
		expect(out).toContain("see subscribers");
		expect(out).toContain("capability-gained-event-publish");
	});

	test("oldOriginalStableId rendered as rename provenance when present", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const fusionWithRename: RegressionFusion = {
			annotatedRegressions: [
				{
					method: {
						functionName: "NewName",
						objectType: "Codeunit",
						objectName: "Obj",
						objectId: 50020,
						appName: "My App",
						beforeSelfTime: 10000,
						afterSelfTime: 20000,
						deltaSelfTime: 10000,
						deltaPercent: 100,
						beforeTotalTime: 10000,
						afterTotalTime: 20000,
						deltaTotalTime: 10000,
						deltaTotalPercent: 100,
						beforeHitCount: 1,
						afterHitCount: 1,
					},
					staticDeltas: [
						{
							category: "abi",
							kind: "procedure-signature-changed",
							severity: "warning",
							displayName: "NewName",
							basis: "self",
							strength: "moderate",
							oldOriginalStableId: "OldName:Codeunit:50020:abc123",
						},
					],
					status: "correlated",
				},
			],
			newMethodCorrelations: [],
			removedMethodCorrelations: [],
			staticOnlyChanges: [],
			correlationSummary: {
				correlated: 1,
				weaklyCorrelated: 0,
				unexplained: 0,
			},
		};
		result.regressionFusion = fusionWithRename;
		const out = formatComparisonTerminal(result);
		expect(out).toContain("renamed from");
		expect(out).toContain("OldName:Codeunit:50020:abc123");
	});

	test("ambiguous marker shown when ambiguous flag set", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const fusionWithAmbiguous: RegressionFusion = {
			annotatedRegressions: [
				{
					method: {
						functionName: "PostOrder",
						objectType: "Codeunit",
						objectName: "Order Handler",
						objectId: 50030,
						appName: "My App",
						beforeSelfTime: 20000,
						afterSelfTime: 30000,
						deltaSelfTime: 10000,
						deltaPercent: 50,
						beforeTotalTime: 25000,
						afterTotalTime: 60000,
						deltaTotalTime: 35000,
						deltaTotalPercent: 140,
						beforeHitCount: 2,
						afterHitCount: 2,
					},
					staticDeltas: [
						{
							category: "capabilities",
							kind: "capability-gained-commit",
							severity: "warning",
							displayName: "PostOrder",
							basis: "total",
							strength: "strong",
							ambiguous: true,
						},
					],
					status: "correlated",
				},
			],
			newMethodCorrelations: [],
			removedMethodCorrelations: [],
			staticOnlyChanges: [],
			correlationSummary: {
				correlated: 1,
				weaklyCorrelated: 0,
				unexplained: 0,
			},
		};
		result.regressionFusion = fusionWithAmbiguous;
		const out = formatComparisonTerminal(result);
		expect(out).toContain("ambiguous");
		expect(out).toContain("multiple routines");
	});

	test("correlation summary counts rendered", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.regressionFusion = SAMPLE_REGRESSION_FUSION;
		const out = formatComparisonTerminal(result);
		// correlationSummary has correlated:1, weaklyCorrelated:1, unexplained:1
		expect(out).toContain("correlated: 1");
		expect(out).toContain("weakly-correlated: 1");
		expect(out).toContain("unexplained: 1");
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
