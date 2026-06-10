import { describe, expect, test } from "bun:test";
import {
	formatAnalysisJson,
	formatComparisonJson,
} from "../../../src/cli/formatters/json.js";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";
import type { RegressionFusion } from "../../../src/semantic/regression-correlate.js";

const FIXTURES = "test/fixtures";

describe("formatAnalysisJson", () => {
	test("returns valid JSON string", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisJson(result);
		const parsed = JSON.parse(output);
		expect(parsed.meta.profileType).toBe("sampling");
		expect(parsed.hotspots).toBeArray();
		expect(parsed.patterns).toBeArray();
	});

	test("is pretty-printed with 2-space indent", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisJson(result);
		expect(output).toContain("\n  ");
	});

	test("includes explanation field when present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.explanation = "Test explanation text.";
		const output = formatAnalysisJson(result);
		const parsed = JSON.parse(output);
		expect(parsed.explanation).toBe("Test explanation text.");
	});

	test("omits explanation field when not present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatAnalysisJson(result);
		const parsed = JSON.parse(output);
		expect(parsed.explanation).toBeUndefined();
	});
});

describe("formatComparisonJson", () => {
	test("returns valid JSON string", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const output = formatComparisonJson(result);
		const parsed = JSON.parse(output);
		expect(parsed.meta.beforePath).toBeTruthy();
		expect(parsed.summary.deltaTime).toBeDefined();
	});

	test("regressionFusion absent => field not present in JSON (byte-unchanged, PR2-8)", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.regressionFusion).toBeUndefined();
		const output = formatComparisonJson(result);
		const parsed = JSON.parse(output);
		expect(parsed.regressionFusion).toBeUndefined();
	});

	test("regressionFusion present => serialised in JSON when set", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const fusion: RegressionFusion = {
			annotatedRegressions: [],
			newMethodCorrelations: [],
			removedMethodCorrelations: [],
			staticOnlyChanges: [],
			correlationSummary: {
				correlated: 0,
				weaklyCorrelated: 0,
				unexplained: 0,
			},
		};
		result.regressionFusion = fusion;
		const output = formatComparisonJson(result);
		const parsed = JSON.parse(output);
		expect(parsed.regressionFusion).toBeDefined();
		expect(parsed.regressionFusion.annotatedRegressions).toBeArray();
		expect(parsed.regressionFusion.correlationSummary.correlated).toBe(0);
	});
});
