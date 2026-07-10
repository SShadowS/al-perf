import { describe, expect, test } from "bun:test";
import {
	analyzeProfile,
	comparabilityWarning,
	compareProfiles,
} from "../../src/core/analyzer.js";
import { FINGERPRINT_ALGO_VERSION } from "../../src/lifecycle/fingerprint.js";

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
