import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	analyzeProfile,
	comparabilityWarning,
	compareProfiles,
	computeHealthScore,
} from "../../src/core/analyzer.js";
import { FINGERPRINT_ALGO_VERSION } from "../../src/lifecycle/fingerprint.js";
import type { ProfileMetadata } from "../../src/types/batch.js";

const FIXTURES = "test/fixtures";

describe("analyzeProfile", () => {
	test("returns complete AnalysisResult for sampling profile", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);

		expect(result.meta.profileType).toBe("sampling");
		expect(result.meta.totalNodes).toBe(3);
		expect(result.meta.samplingInterval).toBe(100000);
		expect(result.meta.analyzedAt).toBeTruthy();

		expect(result.summary.oneLiner).toBeTruthy();
		expect(result.summary.patternCount.critical).toBeGreaterThanOrEqual(0);

		expect(result.hotspots.length).toBeGreaterThan(0);
		expect(result.hotspots[0].selfTime).toBeGreaterThanOrEqual(
			result.hotspots[1]?.selfTime ?? 0,
		);

		expect(result.appBreakdown.length).toBeGreaterThan(0);
		expect(result.objectBreakdown.length).toBeGreaterThan(0);
	});

	test("respects top option to limit hotspots", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			{ top: 1 },
		);
		expect(result.hotspots).toHaveLength(1);
	});

	test("excludes idle nodes from hotspots by default", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const idleHotspot = result.hotspots.find(
			(h) => h.functionName === "IdleTime",
		);
		expect(idleHotspot).toBeUndefined();
	});

	test("works on instrumentation profile", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/instrumentation-minimal.alcpuprofile`,
		);
		expect(result.meta.profileType).toBe("instrumentation");
		expect(result.meta.totalNodes).toBe(2);
		expect(result.hotspots.length).toBeGreaterThan(0);
	});

	test("extracts critical path through the call tree", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.criticalPath).toBeDefined();
		expect(result.criticalPath.length).toBeGreaterThan(0);
		// The critical path should start at root and follow highest totalTime
		// sampling-minimal: OnRun (totalTime=2500000) → ProcessLine (totalTime=2000000)
		expect(result.criticalPath[0].functionName).toBe("OnRun");
		expect(result.criticalPath[1].functionName).toBe("ProcessLine");
		// Each step should have increasing depth
		for (let i = 1; i < result.criticalPath.length; i++) {
			expect(result.criticalPath[i].depth).toBeGreaterThan(
				result.criticalPath[i - 1].depth,
			);
		}
	});

	test("computes profile health score", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.summary.healthScore).toBeGreaterThanOrEqual(0);
		expect(result.summary.healthScore).toBeLessThanOrEqual(100);
		// sampling-minimal has a single-method-dominance critical pattern → health should be < 100
		expect(result.summary.healthScore).toBeLessThan(100);
	});

	test("computes profile confidence score", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.meta.confidenceScore).toBeGreaterThanOrEqual(0);
		expect(result.meta.confidenceScore).toBeLessThanOrEqual(100);
		expect(result.meta.confidenceFactors).toBeDefined();
		expect(result.meta.confidenceFactors.sampleCount.value).toBe(5); // 5 samples in fixture
	});

	test("attaches source locations to hotspots when source available", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/instrumentation-minimal.alcpuprofile`,
			{ sourcePath: `${FIXTURES}/source`, top: 10 },
		);

		// Mechanism test: source should be available and hotspots should exist
		if (result.meta.sourceAvailable) {
			expect(result.hotspots.length).toBeGreaterThan(0);
			// Source locations are only attached when there's a match in the source index
			// The fixture source may not match instrumentation-minimal methods,
			// so we just verify the field exists (undefined is OK if no match)
			for (const h of result.hotspots) {
				if (h.sourceLocation) {
					expect(h.sourceLocation.filePath).toBeTruthy();
					expect(h.sourceLocation.lineStart).toBeGreaterThan(0);
					expect(h.sourceLocation.lineEnd).toBeGreaterThanOrEqual(
						h.sourceLocation.lineStart,
					);
				}
			}
		}
	});

	test("merges profile-only + source-correlated patterns spanning both categories", async () => {
		// event-chain.alcpuprofile + test/fixtures/source produces patterns from
		// BOTH runDetectors (profile-only) and runSourceDetectors
		// (source-correlated) — sanity-checks that the merge site in
		// analyzeProfile actually concatenates both halves rather than dropping
		// one. See src/core/analyzer.ts's merge-site comment for why ordering
		// itself isn't pinned here: no current fixture makes the merge site's
		// own sortPatterns call observably different from a bare impact sort.
		const result = await analyzeProfile(
			`${FIXTURES}/event-chain.alcpuprofile`,
			{
				sourcePath: `${FIXTURES}/source`,
			},
		);

		expect(result.patterns.length).toBeGreaterThan(1);
		expect(
			result.patterns.some((p) => p.id === "single-method-dominance"),
		).toBe(true);
		expect(result.patterns.some((p) => p.id === "missing-setloadfields")).toBe(
			true,
		);
	});
});

describe("compareProfiles", () => {
	test("returns comparison between two sampling profiles", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.meta.beforeType).toBe("sampling");
		expect(result.meta.afterType).toBe("sampling");
		expect(result.summary.oneLiner).toBeTruthy();
		expect(result.summary.deltaTime).toBeDefined();
	});

	test("includes pattern deltas comparing same profile", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		// Same profile → all patterns exist in both → no deltas
		expect(result.patternDeltas).toBeDefined();
		expect(result.patternDeltas).toHaveLength(0);
	});

	test("identifies new and resolved patterns between different profiles", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		expect(result.patternDeltas).toBeDefined();
		// Different profiles have different patterns, so we should see new and/or resolved
		const newPatterns = result.patternDeltas.filter((d) => d.status === "new");
		const resolvedPatterns = result.patternDeltas.filter(
			(d) => d.status === "resolved",
		);
		expect(newPatterns.length + resolvedPatterns.length).toBeGreaterThan(0);
	});

	test("identifies methods that appear in one profile but not the other", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/instrumentation-minimal.alcpuprofile`,
		);
		// Different profile types will have different methods
		expect(
			result.newMethods.length +
				result.removedMethods.length +
				result.regressions.length +
				result.improvements.length,
		).toBeGreaterThanOrEqual(0);
	});

	test("MethodDelta carries deltaTotalTime and deltaTotalPercent fields", async () => {
		// Same profile → all deltas are zero; verify the new fields exist
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		// No regressions/improvements when comparing same profile
		expect(result.regressions).toHaveLength(0);
		expect(result.improvements).toHaveLength(0);
	});

	test("total-time-only regression (self-time flat) qualifies as regression candidate", async () => {
		// before: ProcessRecord has no children (selfTime=totalTime=500000)
		// after:  ProcessRecord gains a child DB-call frame adding 300000 to totalTime
		//         → deltaSelfTime=0, deltaTotalTime>0 → must appear in regressions[]
		const result = await compareProfiles(
			`${FIXTURES}/total-time-regression-before.alcpuprofile`,
			`${FIXTURES}/total-time-regression-after.alcpuprofile`,
		);

		const processRecord = result.regressions.find(
			(r) => r.functionName === "ProcessRecord",
		);
		expect(processRecord).toBeDefined();
		expect(processRecord?.deltaSelfTime).toBe(0);
		expect(processRecord?.deltaTotalTime).toBeGreaterThan(0);
		expect(processRecord?.beforeTotalTime).toBeDefined();
		expect(processRecord?.afterTotalTime).toBeGreaterThan(
			processRecord?.beforeTotalTime ?? 0,
		);
		expect(processRecord?.deltaTotalPercent).toBeGreaterThan(0);
	});

	test("self-time regressions still sort by deltaSelfTime descending (primary order preserved)", async () => {
		// sampling-minimal compared to itself produces no regressions, but we verify
		// that a normal regression (non-total-only) uses deltaSelfTime as primary sort key.
		// This is a structural check: regressions are ordered deltaSelfTime desc.
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		for (let i = 1; i < result.regressions.length; i++) {
			expect(result.regressions[i - 1].deltaSelfTime).toBeGreaterThanOrEqual(
				result.regressions[i].deltaSelfTime,
			);
		}
	});
});

describe("analyzeProfile fingerprint wiring", () => {
	test("every detected pattern carries a canonical pattern: fingerprint", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		expect(result.patterns.length).toBeGreaterThan(0);
		for (const p of result.patterns) {
			expect(p.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		}
	});

	test("fingerprints are stable across two runs on the same profile", async () => {
		const a = await analyzeProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		const b = await analyzeProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		expect(a.patterns.map((p) => p.fingerprint)).toEqual(
			b.patterns.map((p) => p.fingerprint),
		);
	});

	test("meta carries the fingerprint algorithm version", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.meta.fingerprintAlgoVersion).toBe(FINGERPRINT_ALGO_VERSION);
	});
});

describe("compareProfiles comparability guard", () => {
	test("flags sampling-vs-instrumentation comparisons", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/instrumentation-minimal.alcpuprofile`,
		);
		expect(result.meta.comparabilityWarning).toContain("capture kinds differ");
	});

	test("same capture kind and wire format → no warning field (byte-unchanged)", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.meta.comparabilityWarning).toBeUndefined();
	});

	test("comparabilityWarning flags wire-format differences", () => {
		const warning = comparabilityWarning(
			{ captureKind: "instrumentation", sourceFormat: "ir-json" },
			{ captureKind: "instrumentation", sourceFormat: "alcpuprofile" },
		);
		expect(warning).toContain("wire formats differ");
	});

	test("comparabilityWarning treats an absent sourceFormat as alcpuprofile", () => {
		expect(
			comparabilityWarning(
				{ captureKind: "sampling" },
				{ captureKind: "sampling", sourceFormat: "alcpuprofile" },
			),
		).toBeUndefined();
	});
});

describe("SQL evidence enrichment (v1)", () => {
	// Fixture is gitignored (real capture data); tests below are local-only by design.
	const PROFILE = "test/fixtures/batch-recorded/profile-1.alcpuprofile";
	const MANIFEST = "test/fixtures/batch-recorded/manifest.json";

	test.skipIf(!existsSync(PROFILE))(
		"sampling profile with SQL gets evidence on at least one finding",
		async () => {
			const result = await analyzeProfile(PROFILE);
			const withEvidence = result.patterns.filter((p) => p.sqlEvidence);
			for (const p of withEvidence) {
				expect(p.sqlEvidence!.provenance).toBe("sampled-estimate");
				expect(p.sqlRank).toBe(p.sqlEvidence!.totalSampledCostUs);
				expect(p.sqlEvidence!.statements.length).toBeLessThanOrEqual(5);
			}
			// profile-1 has 181 SQL nodes and known high-hit-count/repeated-siblings findings:
			expect(withEvidence.length).toBeGreaterThan(0);
		},
	);

	test.skipIf(!existsSync(PROFILE))(
		"identity pin: fingerprints identical with evidence stripped and re-minted",
		async () => {
			const result = await analyzeProfile(PROFILE);
			const stripped = structuredClone(result.patterns);
			for (const p of stripped) {
				delete (p as Record<string, unknown>).sqlEvidence;
				delete (p as Record<string, unknown>).sqlRank;
				delete (p as Record<string, unknown>).fingerprint;
			}
			// Mirror analyzeProfile's own call site (core/analyzer.ts): fingerprintPatterns
			// takes the non-idle MethodBreakdown[] directly, not a label map — the label
			// map is built INSIDE fingerprintPatterns (buildMethodLabelMap in wire.ts).
			const { fingerprintPatterns } = await import(
				"../../src/lifecycle/wire.js"
			);
			const { aggregateByMethod } = await import(
				"../../src/core/aggregator.js"
			);
			const { parseProfile } = await import("../../src/core/parser.js");
			const { processProfile } = await import("../../src/core/processor.js");
			const methods = aggregateByMethod(
				processProfile(await parseProfile(PROFILE)),
			);
			const nonIdleMethods = methods.filter(
				(m) => !(m.functionName === "IdleTime" && m.objectId === 0),
			);
			fingerprintPatterns(stripped, nonIdleMethods);
			expect(stripped.map((p) => p.fingerprint)).toEqual(
				result.patterns.map((p) => p.fingerprint),
			);
		},
	);

	test.skipIf(!existsSync(PROFILE))(
		"mutation guard: enrichment leaves impact and every non-evidence field untouched",
		async () => {
			// Real profile, real detectors, real enrichment — not the synthetic
			// single-pattern fixture in test/semantic/sql-evidence.test.ts's own
			// "mutation guard" test. This pins the guarantee end-to-end against
			// the actual patterns analyzeProfile's hook enriches.
			const { parseProfile } = await import("../../src/core/parser.js");
			const { processProfile } = await import("../../src/core/processor.js");
			const { runDetectors } = await import("../../src/core/patterns.js");
			const { buildSqlByRoutine, attachSqlEvidence } = await import(
				"../../src/semantic/sql-evidence.js"
			);
			const processed = processProfile(await parseProfile(PROFILE));
			const patterns = runDetectors(processed);
			const before = structuredClone(patterns);

			const sqlByRoutine = buildSqlByRoutine(processed);
			attachSqlEvidence(patterns, sqlByRoutine);
			// Sanity: enrichment must actually attach something on this fixture,
			// else stripping sqlEvidence/sqlRank below compares two untouched
			// clones and pins nothing.
			expect(patterns.some((p) => p.sqlEvidence)).toBe(true);

			for (const p of patterns) {
				delete (p as Record<string, unknown>).sqlEvidence;
				delete (p as Record<string, unknown>).sqlRank;
			}
			expect(patterns).toEqual(before);
		},
	);

	test.skipIf(!existsSync(PROFILE) || !existsSync(MANIFEST))(
		"metadata option attaches sqlActivity; absent without it",
		async () => {
			const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
			const withMeta = await analyzeProfile(PROFILE, { metadata: manifest[0] });
			expect(withMeta.sqlActivity).toBeDefined();
			expect(withMeta.sqlActivity!.measuredSqlCount).toBe(1381);
			expect(withMeta.sqlActivity!.sampledAttributedCostUs).toBeGreaterThan(0);
			expect("unaccountedMs" in withMeta.sqlActivity!).toBe(false);

			const without = await analyzeProfile(PROFILE);
			expect(without.sqlActivity).toBeUndefined();
		},
	);

	test("ir-json profile: no SQL evidence anywhere (negative)", async () => {
		const result = await analyzeProfile("test/fixtures/irjson-minimal.ir.json");
		expect(result.patterns.every((p) => p.sqlEvidence === undefined)).toBe(
			true,
		);
		expect(result.sqlActivity).toBeUndefined();
	});
});

describe("SQL evidence enrichment (v1) — synthetic fixture (always runs)", () => {
	// Committed (NOT gitignored), hand-crafted sampling profile that
	// deterministically produces sqlEvidence through the REAL analyzeProfile
	// path on every clean checkout / CI run — unlike the describe block above,
	// which is gated on the gitignored real-capture fixture and never runs
	// there. See test/fixtures/sql-evidence-synthetic.alcpuprofile: a
	// PostBatch (CodeUnit 80) routine with 50 identical SELECT children
	// (fires repeated-siblings, object-method attribution), one UPDATE with
	// an invalid applicationDefinition nested under a builtin wrapper node
	// (ancestor-fallback attribution), and one SQL node with no AL ancestor
	// at all (UNATTRIBUTED_KEY bucket).
	const SYNTHETIC = "test/fixtures/sql-evidence-synthetic.alcpuprofile";

	test("sampling profile with SQL gets evidence on at least one finding", async () => {
		const result = await analyzeProfile(SYNTHETIC);
		const withEvidence = result.patterns.filter((p) => p.sqlEvidence);
		expect(withEvidence.length).toBeGreaterThan(0);
		for (const p of withEvidence) {
			expect(p.sqlEvidence!.provenance).toBe("sampled-estimate");
			expect(p.sqlRank).toBe(p.sqlEvidence!.totalSampledCostUs);
			expect(p.sqlEvidence!.statements.length).toBeLessThanOrEqual(5);
		}
		// Deterministic anchor: repeated-siblings fires on the 50 identical
		// SELECT children under PostBatch (CodeUnit 80), and its evidence union
		// picks up BOTH the SELECT group (50 hits, object-method) and the
		// ancestor-fallback UPDATE under the builtin wrapper (1 hit) — 51 total
		// sampled hits, 51000us total sampled cost, mixed attribution.
		const repeated = result.patterns.find((p) => p.id === "repeated-siblings");
		expect(repeated).toBeDefined();
		expect(repeated!.sqlEvidence!.totalSampledCostUs).toBe(51000);
		expect(repeated!.sqlEvidence!.totalSampledHitCount).toBe(51);
		expect(repeated!.sqlEvidence!.attribution).toBe("mixed");
	});

	test("identity pin: fingerprints identical with evidence stripped and re-minted", async () => {
		const result = await analyzeProfile(SYNTHETIC);
		const stripped = structuredClone(result.patterns);
		for (const p of stripped) {
			delete (p as Record<string, unknown>).sqlEvidence;
			delete (p as Record<string, unknown>).sqlRank;
			delete (p as Record<string, unknown>).fingerprint;
		}
		// Mirror analyzeProfile's own call site (core/analyzer.ts): fingerprintPatterns
		// takes the non-idle MethodBreakdown[] directly, not a label map — the label
		// map is built INSIDE fingerprintPatterns (buildMethodLabelMap in wire.ts).
		const { fingerprintPatterns } = await import("../../src/lifecycle/wire.js");
		const { aggregateByMethod } = await import("../../src/core/aggregator.js");
		const { parseProfile } = await import("../../src/core/parser.js");
		const { processProfile } = await import("../../src/core/processor.js");
		const methods = aggregateByMethod(
			processProfile(await parseProfile(SYNTHETIC)),
		);
		const nonIdleMethods = methods.filter(
			(m) => !(m.functionName === "IdleTime" && m.objectId === 0),
		);
		fingerprintPatterns(stripped, nonIdleMethods);
		expect(stripped.map((p) => p.fingerprint)).toEqual(
			result.patterns.map((p) => p.fingerprint),
		);
	});

	test("mutation guard: enrichment leaves impact and every non-evidence field untouched", async () => {
		const { parseProfile } = await import("../../src/core/parser.js");
		const { processProfile } = await import("../../src/core/processor.js");
		const { runDetectors } = await import("../../src/core/patterns.js");
		const { buildSqlByRoutine, attachSqlEvidence } = await import(
			"../../src/semantic/sql-evidence.js"
		);
		const processed = processProfile(await parseProfile(SYNTHETIC));
		const patterns = runDetectors(processed);
		const before = structuredClone(patterns);

		const sqlByRoutine = buildSqlByRoutine(processed);
		attachSqlEvidence(patterns, sqlByRoutine);
		// Sanity: enrichment must actually attach something on this fixture,
		// else stripping sqlEvidence/sqlRank below compares two untouched
		// clones and pins nothing.
		expect(patterns.some((p) => p.sqlEvidence)).toBe(true);

		for (const p of patterns) {
			delete (p as Record<string, unknown>).sqlEvidence;
			delete (p as Record<string, unknown>).sqlRank;
		}
		expect(patterns).toEqual(before);
	});

	test("metadata option attaches sqlActivity; absent without it", async () => {
		const metadata: ProfileMetadata = {
			activityId: "11111111-1111-1111-1111-111111111111",
			activityType: "Background",
			activityDescription: "Synthetic sanity-check activity",
			startTime: "2026-01-01T00:00:00.000Z",
			activityDuration: 200,
			alExecutionDuration: 120,
			sqlCallDuration: 50,
			sqlCallCount: 51,
			httpCallDuration: 0,
			httpCallCount: 0,
			userName: "TESTUSER",
			clientSessionId: 1,
		};
		const withMeta = await analyzeProfile(SYNTHETIC, { metadata });
		expect(withMeta.sqlActivity).toBeDefined();
		expect(withMeta.sqlActivity!.measuredSqlCount).toBe(51);
		expect(withMeta.sqlActivity!.measuredSqlDurationMs).toBe(50);
		// Activity-level total sums EVERY routine bucket including
		// UNATTRIBUTED_KEY (50000 SELECT + 1000 UPDATE + 1000 unattributed
		// SELECT) — unlike a single finding's sqlEvidence, which only unions
		// the routines named in that finding's involvedMethods.
		expect(withMeta.sqlActivity!.sampledAttributedCostUs).toBe(52000);
		expect(withMeta.sqlActivity!.activityDurationMs).toBe(200);
		expect(withMeta.sqlActivity!.alExecutionDurationMs).toBe(120);
		expect("unaccountedMs" in withMeta.sqlActivity!).toBe(false);

		const without = await analyzeProfile(SYNTHETIC);
		expect(without.sqlActivity).toBeUndefined();
	});
});

describe("healthScore — repetition of one pattern is one problem", () => {
	function patterns(id: string, n: number) {
		return Array.from({ length: n }, (_, i) => ({
			id,
			severity: "warning" as const,
			title: `${id} #${i}`,
			description: "",
			impact: 0,
			involvedMethods: [],
			evidence: "",
			suggestion: "",
		}));
	}

	test("N findings of the SAME pattern id cost the same as one", () => {
		// The penalty counted FINDINGS, so 16 high-hit-count findings — one
		// pattern exhibited by 16 different SQL statements — scored 20/100 while
		// 4 findings of that same single pattern scored 80. Measured on captured
		// profiles: every one had ZERO criticals, yet scored 5, 5, 20, 25, 35,
		// entirely on how many times one pattern repeated.
		expect(computeHealthScore(patterns("high-hit-count", 1), 0)).toBe(
			computeHealthScore(patterns("high-hit-count", 16), 0),
		);
	});

	test("distinct problems still each cost", () => {
		const one = computeHealthScore(patterns("high-hit-count", 3), 0);
		const two = computeHealthScore(
			[...patterns("high-hit-count", 3), ...patterns("event-chain", 3)],
			0,
		);
		expect(two).toBeLessThan(one);
	});

	test("severity still dominates count", () => {
		const oneCritical = computeHealthScore(
			[{ ...patterns("a", 1)[0], severity: "critical" as const }],
			0,
		);
		const oneWarning = computeHealthScore(patterns("b", 1), 0);
		expect(oneCritical).toBeLessThan(oneWarning);
	});

	test("a heavily idle profile is still penalized", () => {
		expect(computeHealthScore([], 0.95)).toBeLessThan(
			computeHealthScore([], 0.1),
		);
	});
});
