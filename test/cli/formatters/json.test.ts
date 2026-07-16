import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import {
	formatAnalysisJson,
	formatComparisonJson,
} from "../../../src/cli/formatters/json.js";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";
import type { SqlActivityCorroboration } from "../../../src/output/types.js";
import type { RegressionFusion } from "../../../src/semantic/regression-correlate.js";
import type { SqlEvidence } from "../../../src/types/patterns.js";

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

	test("passes pattern fingerprints and fingerprintAlgoVersion through verbatim", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		expect(result.patterns.length).toBeGreaterThan(0);
		const parsed = JSON.parse(formatAnalysisJson(result));
		expect(parsed.meta.fingerprintAlgoVersion).toBe(1);
		expect(parsed.patterns[0].fingerprint).toBe(result.patterns[0].fingerprint);
		expect(parsed.patterns[0].fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
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

// ---------------------------------------------------------------------------
// SQL evidence / SQL activity JSON pass-through tests (Task 7)
// ---------------------------------------------------------------------------

const SAMPLE_SQL_ACTIVITY: SqlActivityCorroboration = {
	measuredSqlCount: 1381,
	measuredSqlDurationMs: 382,
	sampledAttributedCostUs: 15000,
	activityDurationMs: 11945,
	alExecutionDurationMs: 7023,
};

const SAMPLE_SQL_EVIDENCE: SqlEvidence = {
	statements: [
		{
			text: "SELECT * FROM Customer WHERE No_ = @0",
			operation: "SELECT",
			table: "Customer",
			extensionAppId: null,
			readUncommitted: false,
			sampledHitCount: 42,
			sampledCostUs: 15000,
			attribution: "object-method",
		},
	],
	totalSampledCostUs: 15000,
	totalSampledHitCount: 42,
	provenance: "sampled-estimate",
	attribution: "object-method",
};

describe("formatAnalysisJson — sqlActivity / sqlEvidence (Task 7)", () => {
	test("passes result.sqlActivity through when present", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		result.sqlActivity = SAMPLE_SQL_ACTIVITY;
		const parsed = JSON.parse(formatAnalysisJson(result));
		expect(parsed.sqlActivity).toEqual(SAMPLE_SQL_ACTIVITY);
		expect(parsed.sqlActivity.measuredSqlCount).toBe(1381);
	});

	test("omits sqlActivity when absent", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.sqlActivity).toBeUndefined();
		const parsed = JSON.parse(formatAnalysisJson(result));
		expect(parsed.sqlActivity).toBeUndefined();
	});

	test("pattern sqlEvidence rides on patterns[] — not duplicated elsewhere", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.patterns.length).toBeGreaterThan(0);
		result.patterns[0].sqlEvidence = SAMPLE_SQL_EVIDENCE;
		result.patterns[0].sqlRank = SAMPLE_SQL_EVIDENCE.totalSampledCostUs;
		const parsed = JSON.parse(formatAnalysisJson(result));
		expect(parsed.patterns[0].sqlEvidence).toEqual(SAMPLE_SQL_EVIDENCE);
		expect(parsed.patterns[0].sqlEvidence.provenance).toBe("sampled-estimate");
		expect(parsed.patterns[0].sqlRank).toBe(15000);
		// No separate top-level "sqlEvidence" key was introduced.
		expect(parsed.sqlEvidence).toBeUndefined();
	});

	test("omits pattern sqlEvidence/sqlRank when absent", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const parsed = JSON.parse(formatAnalysisJson(result));
		expect(parsed.patterns[0].sqlEvidence).toBeUndefined();
		expect(parsed.patterns[0].sqlRank).toBeUndefined();
	});
});

describe("formatAnalysisJson — sqlActivity/sqlEvidence with real batch-recorded fixture", () => {
	const PROFILE = "test/fixtures/batch-recorded/profile-1.alcpuprofile";
	const MANIFEST = "test/fixtures/batch-recorded/manifest.json";

	test.skipIf(!existsSync(PROFILE) || !existsSync(MANIFEST))(
		"sqlActivity.measuredSqlCount reflects the manifest entry",
		async () => {
			const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
			const result = await analyzeProfile(PROFILE, { metadata: manifest[0] });
			const parsed = JSON.parse(formatAnalysisJson(result));
			expect(parsed.sqlActivity.measuredSqlCount).toBe(1381);
		},
	);

	test.skipIf(!existsSync(PROFILE))(
		"real findings' sqlEvidence provenance is sampled-estimate",
		async () => {
			const result = await analyzeProfile(PROFILE);
			const parsed = JSON.parse(formatAnalysisJson(result));
			const withEvidence = parsed.patterns.filter(
				(p: { sqlEvidence?: unknown }) => p.sqlEvidence,
			);
			expect(withEvidence.length).toBeGreaterThan(0);
			for (const p of withEvidence) {
				expect(p.sqlEvidence.provenance).toBe("sampled-estimate");
			}
		},
	);
});
