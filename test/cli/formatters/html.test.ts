import { describe, expect, test } from "bun:test";
import { formatAnalysisHtml } from "../../../src/cli/formatters/html.js";
import { analyzeProfile } from "../../../src/core/analyzer.js";
import type {
	FusionViews,
	HotspotAnnotation,
} from "../../../src/semantic/views.js";

const FIXTURES = "test/fixtures";

describe("formatAnalysisHtml", () => {
	test("includes HTML document structure", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).toContain("<!DOCTYPE html>");
		expect(output).toContain("<html");
		expect(output).toContain("</html>");
	});

	test("includes BC theme styles", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).toContain("#00B7C3");
		expect(output).toContain("Segoe UI");
		expect(output).toContain("13.5pt");
	});

	test("includes summary section", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).toContain(result.summary.oneLiner);
	});

	test("includes hotspots table", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).toContain("Top Hotspots");
		expect(output).toContain("ProcessLine");
	});

	test("includes detected patterns with severity", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).toContain("Detected Patterns");
		expect(output).toMatch(/CRITICAL|WARNING|INFO/);
	});

	test("includes app breakdown", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).toContain("App Breakdown");
		expect(output).toContain("My Extension");
	});

	test("includes suggestion when pattern has one", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		if (result.patterns.some((p) => p.suggestion)) {
			expect(output).toContain("Suggestion:");
		}
	});

	test("includes confidence and health scores", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).toContain("Confidence");
		expect(output).toContain("Health");
	});

	test("includes object breakdown section", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).toContain("Object Breakdown");
		expect(output).toContain("My Processor");
		expect(output).toContain("50000");
	});

	test("includes AI explanation when present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.explanation = "This profile shows significant time in ProcessLine.";
		const output = formatAnalysisHtml(result);
		expect(output).toContain("section explanation");
		expect(output).toContain(
			"This profile shows significant time in ProcessLine.",
		);
	});

	test("omits explanation when not present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).not.toContain("section explanation");
	});

	test("escapes HTML in dynamic content", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		// Inject XSS into a hotspot function name
		if (result.hotspots.length > 0) {
			result.hotspots[0].functionName = '<script>alert("xss")</script>';
		}
		const output = formatAnalysisHtml(result);
		expect(output).not.toContain('<script>alert("xss")</script>');
		expect(output).toContain("&lt;script&gt;");
	});

	test("is self-contained with no external resource links", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisHtml(result);
		expect(output).not.toMatch(/href="https?:\/\//);
		expect(output).not.toMatch(/src="https?:\/\//);
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

describe("formatAnalysisHtml — fusion section", () => {
	test("fusion section renders prioritized findings", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.fusionViews = SAMPLE_FUSION_VIEWS;
		const out = formatAnalysisHtml(result);
		expect(out).toContain("Runtime-Prioritized Static Findings");
		expect(out).toContain("N+1 query");
	});

	test("fusion section absent => output byte-unchanged", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.fusionViews).toBeUndefined();
		const out = formatAnalysisHtml(result);
		expect(out).not.toContain("Runtime-Prioritized");
	});

	test("result.hotspots[i] schema unchanged when fusion is on (R2-5)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const snapshotBefore = JSON.stringify(result.hotspots);
		result.fusionViews = SAMPLE_FUSION_VIEWS;
		formatAnalysisHtml(result);
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
		const out = formatAnalysisHtml(result);
		expect(out).toContain("coverage incomplete");
		expect(out).not.toContain("no static findings");
	});

	test("escapes HTML in fusion finding content", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const xssFusionViews: FusionViews = {
			hotspotAnnotations: [],
			prioritizedFindings: [
				{
					finding: {
						id: "FX",
						fingerprint: "fpx",
						detector: "<evil>",
						title: '<script>alert("xss")</script>',
						rootCause: "xss",
						severity: "high",
						confidence: { level: "certain" },
						primaryLocation: {
							file: "src/X.al",
							line: 1,
							column: 1,
							objectId: "g/Codeunit/1",
							objectName: "X",
						},
						affectedObjects: [],
						affectedTables: [],
					},
					functionName: "Fn",
					objectType: "Codeunit",
					objectId: 1,
					appName: "App",
					selfTimePercent: 10,
					totalTimePercent: 10,
					efficiencyScore: 1,
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
		result.fusionViews = xssFusionViews;
		const out = formatAnalysisHtml(result);
		expect(out).not.toContain('<script>alert("xss")</script>');
		expect(out).toContain("&lt;script&gt;");
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
		let out = formatAnalysisHtml(result);
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
		out = formatAnalysisHtml(result);
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
		out = formatAnalysisHtml(result);
		expect(out).toContain("no static findings");
		expect(out).not.toContain("coverage incomplete");
	});
});
