import { describe, expect, it } from "bun:test";
import type {
	CoverageEntry,
	FindingSummary,
	RoutineIdentity,
} from "../../src/semantic/contracts.js";
import { correlate } from "../../src/semantic/correlate.js";
import type { EngineAnalysis } from "../../src/semantic/engine-runner.js";
import {
	annotateHotspots,
	prioritizeFindings,
} from "../../src/semantic/views.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { SemanticAttribution } from "../../src/types/fused.js";

const APP_GUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const APP_NAME = "FusionMinimal";
const APP_PUBLISHER = "al-perf-test";

function makeRoutine(
	routineName: string,
	objectNumber: number,
	objectType: string,
	stableRoutineId: string,
): RoutineIdentity {
	return { stableRoutineId, objectType, objectNumber, routineName };
}

function makeFinding(
	id: string,
	fingerprint: string,
	detector: string,
	routineName: string | undefined,
	objectType: string,
	objectNumber: number,
): FindingSummary {
	return {
		id,
		fingerprint,
		detector,
		title: `Finding ${id}`,
		rootCause: "test",
		severity: "high",
		confidence: { level: "likely" },
		primaryLocation: {
			file: "ws:src/Test.al",
			line: 10,
			column: 1,
			objectId: `${APP_GUID}/${objectType}/${objectNumber}`,
			objectName: "TestObject",
			routineName,
		},
		affectedObjects: [`${APP_GUID}/${objectType}/${objectNumber}`],
		affectedTables: [],
	};
}

function makeMethod(
	functionName: string,
	objectType: string,
	objectId: number,
	selfTimePercent: number,
	totalTimePercent: number,
	opts?: Partial<MethodBreakdown>,
): MethodBreakdown {
	return {
		functionName,
		objectType,
		objectName: "TestObject",
		objectId,
		appName: APP_NAME,
		selfTime: selfTimePercent * 10,
		selfTimePercent,
		totalTime: totalTimePercent * 10,
		totalTimePercent,
		hitCount: 5,
		calledBy: [],
		calls: [],
		costPerHit: 100,
		efficiencyScore:
			totalTimePercent > 0 ? selfTimePercent / totalTimePercent : 1,
		...opts,
	};
}

function makeCompleteCoverage(routines: RoutineIdentity[]): CoverageEntry[] {
	return routines.map((r) => ({
		directStatus: "complete",
		inheritedStatus: "complete",
		reasons: [],
		subject: r.stableRoutineId,
		unknownTargets: [],
	}));
}

function makeEngine(
	routines: RoutineIdentity[],
	findings: FindingSummary[],
	overrides: Partial<EngineAnalysis> = {},
): EngineAnalysis {
	const coverage = overrides.coverage ?? makeCompleteCoverage(routines);
	return {
		routines,
		findings,
		apps: [
			{
				appGuid: APP_GUID,
				name: APP_NAME,
				publisher: APP_PUBLISHER,
				version: "1.0.0.0",
			},
		],
		coverage,
		coverageSubjects: coverage.map((c) => c.subject),
		primaryApp: {
			appGuid: APP_GUID,
			name: APP_NAME,
			publisher: APP_PUBLISHER,
			version: "1.0.0.0",
		},
		alsemVersion: "0.0.12",
		diagnostics: [],
		coverageDegraded: false,
		opaqueApps: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// prioritizeFindings
// ---------------------------------------------------------------------------

describe("prioritizeFindings", () => {
	it("ranks by selfTimePercent desc, not totalTimePercent (R2-3)", () => {
		// leaf: high self, low total. orchestrator: low self, high total.
		const methods = [
			makeMethod("Orchestrator", "Codeunit", 50000, 5, 90),
			makeMethod("HotLeaf", "Codeunit", 50001, 80, 80),
		];
		const engine = makeEngine(
			[
				makeRoutine("Orchestrator", 50000, "Codeunit", "r0"),
				makeRoutine("HotLeaf", 50001, "Codeunit", "r1"),
			],
			[
				makeFinding("FO", "fpO", "d1", "Orchestrator", "Codeunit", 50000),
				makeFinding("FL", "fpL", "d1", "HotLeaf", "Codeunit", 50001),
			],
		);
		const fused = correlate(methods, engine);
		const { weighted } = prioritizeFindings(fused, methods);
		expect(weighted[0].finding.id).toBe("FL"); // hot leaf outranks orchestrator
		expect(weighted[0].efficiencyScore).toBeGreaterThan(
			weighted[1].efficiencyScore,
		);
	});

	it("sums CPU across ambiguous frames sharing one finding (R2-8)", () => {
		// Two field triggers normalize to one key/finding; selfTime must SUM.
		const methods = [
			makeMethod("Field A - OnValidate", "Table", 50100, 10, 10),
			makeMethod("Field B - OnValidate", "Table", 50100, 8, 8),
		];
		const engine = makeEngine(
			[makeRoutine("OnValidate", 50100, "Table", "rt")],
			[makeFinding("FT", "fpT", "d1", "OnValidate", "Table", 50100)],
		);
		const fused = correlate(methods, engine);
		const { weighted } = prioritizeFindings(fused, methods);
		const ft = weighted.find((r) => r.finding.id === "FT");
		expect(ft?.selfTimePercent).toBe(18); // 10 + 8 summed, not max(10)
		expect(ft?.frameCount).toBe(2);
	});

	it("excludes a matched zero-self frame's finding from weighted, but keeps an ambiguous SUM>0 (R2-12)", () => {
		// Orchestrator: matched, selfTime 0 (all cost in callees) carrying a finding
		//   → must NOT appear in weighted.
		// Ambiguous OnValidate: two frames selfTime 0 + 5 → sum 5 → must STAY.
		const methods = [
			makeMethod("Orchestrator", "Codeunit", 50000, 0, 90),
			makeMethod("Field A - OnValidate", "Table", 50100, 0, 0),
			makeMethod("Field B - OnValidate", "Table", 50100, 5, 5),
		];
		const engine = makeEngine(
			[
				makeRoutine("Orchestrator", 50000, "Codeunit", "r0"),
				makeRoutine("OnValidate", 50100, "Table", "rt"),
			],
			[
				makeFinding("FO", "fpO", "d1", "Orchestrator", "Codeunit", 50000),
				makeFinding("FT", "fpT", "d1", "OnValidate", "Table", 50100),
			],
		);
		const fused = correlate(methods, engine);
		const { weighted } = prioritizeFindings(fused, methods);
		// The zero-self orchestrator finding is dropped from weighted.
		expect(weighted.map((r) => r.finding.id)).not.toContain("FO");
		// The ambiguous SUM>0 finding stays, with summed selfTime 0 + 5 = 5.
		const ft = weighted.find((r) => r.finding.id === "FT");
		expect(ft).toBeDefined();
		expect(ft?.selfTimePercent).toBe(5);
		expect(ft?.frameCount).toBe(2);
		// Every weighted row is strictly self-time>0.
		expect(weighted.every((r) => r.selfTimePercent > 0)).toBe(true);
	});

	it("puts cold/blind/unkeyable findings in unweighted, never weighted (R2-12)", () => {
		const methods = [makeMethod("Hot", "Codeunit", 50000, 50, 50)];
		const engine = makeEngine(
			[
				makeRoutine("Hot", 50000, "Codeunit", "r0"),
				makeRoutine("ColdRoutine", 50002, "Codeunit", "r2"),
			],
			[
				makeFinding("FH", "fpH", "d1", "Hot", "Codeunit", 50000),
				makeFinding("FC", "fpC", "d1", "ColdRoutine", "Codeunit", 50002), // not in methods → cold
			],
		);
		const fused = correlate(methods, engine);
		const { weighted, unweighted } = prioritizeFindings(fused, methods);
		expect(weighted.map((r) => r.finding.id)).toEqual(["FH"]);
		expect(weighted.every((r) => r.selfTimePercent > 0)).toBe(true);
		// The cold finding must appear in unweighted AND honestly carry its bucket.
		const fc = unweighted.find((r) => r.finding.id === "FC");
		expect(fc).toBeDefined();
		expect(fc?.bucket).toBe("cold");
	});

	it("is byte-stable across two runs (R2-14)", () => {
		const methods = [
			makeMethod("A", "Codeunit", 1, 10, 10),
			makeMethod("B", "Codeunit", 2, 10, 10),
		];
		const engine = makeEngine(
			[
				makeRoutine("A", 1, "Codeunit", "ra"),
				makeRoutine("B", 2, "Codeunit", "rb"),
			],
			[
				makeFinding("FA", "fpA", "d1", "A", "Codeunit", 1),
				makeFinding("FB", "fpB", "d1", "B", "Codeunit", 2),
			],
		);
		const f1 = correlate(methods, engine);
		const f2 = correlate(methods, engine);
		expect(JSON.stringify(prioritizeFindings(f1, methods))).toBe(
			JSON.stringify(prioritizeFindings(f2, methods)),
		);
	});

	it("total ordering resolves ties by totalTimePercent desc then fingerprint (R2-14)", () => {
		// Same selfTime — must sort by totalTime desc, then fingerprint
		const methods = [
			makeMethod("A", "Codeunit", 1, 10, 30),
			makeMethod("B", "Codeunit", 2, 10, 20),
		];
		const engine = makeEngine(
			[
				makeRoutine("A", 1, "Codeunit", "ra"),
				makeRoutine("B", 2, "Codeunit", "rb"),
			],
			[
				makeFinding("FA", "fpA", "d1", "A", "Codeunit", 1),
				makeFinding("FB", "fpB", "d1", "B", "Codeunit", 2),
			],
		);
		const fused = correlate(methods, engine);
		const { weighted } = prioritizeFindings(fused, methods);
		// A has higher totalTime → should rank first
		expect(weighted[0].finding.id).toBe("FA");
	});
});

// ---------------------------------------------------------------------------
// annotateHotspots
// ---------------------------------------------------------------------------

describe("annotateHotspots", () => {
	it("carries matched-clean + reason verbatim, never upgrades a degraded match (R2-9/R2-10)", () => {
		const methods = [makeMethod("Clean", "Codeunit", 50000, 30, 30)];
		const engine = makeEngine(
			[makeRoutine("Clean", 50000, "Codeunit", "r0")],
			[], // no findings
			{ coverage: [] }, // empty coverage → not fully analyzed
		);
		const fused = correlate(methods, engine);
		const ann = annotateHotspots(fused, methods);
		expect(ann).toHaveLength(1);
		expect(ann[0].status).toBe("matched");
		expect(ann[0].matchedClean).toBeUndefined();
		expect(ann[0].reason).toContain("coverage incomplete");
	});

	it("preserves the methods[] order (R2-14)", () => {
		const methods = [
			makeMethod("First", "Codeunit", 1, 50, 50),
			makeMethod("Second", "Codeunit", 2, 40, 40),
		];
		const engine = makeEngine(
			[
				makeRoutine("First", 1, "Codeunit", "r1"),
				makeRoutine("Second", 2, "Codeunit", "r2"),
			],
			[],
		);
		const ann = annotateHotspots(correlate(methods, engine), methods);
		expect(ann.map((a) => a.attrKey)).toEqual([
			"First_Codeunit_1",
			"Second_Codeunit_2",
		]);
	});

	it("omits non-AL / unjoined frames (blind-spot still included, SQL frames omitted)", () => {
		// A SQL frame is filtered by isAlRoutineFrame in correlate — no attribution entry.
		// A blind-spot AL frame DOES get an entry with status=blind-spot.
		const methods = [
			makeMethod("Hot", "Codeunit", 50000, 50, 50),
			makeMethod("SELECT TOP 1 * FROM [Customer]", "Codeunit", 18, 5, 5), // SQL — no attribution
		];
		const engine = makeEngine(
			[makeRoutine("Hot", 50000, "Codeunit", "r0")],
			[makeFinding("FH", "fpH", "d1", "Hot", "Codeunit", 50000)],
		);
		const fused = correlate(methods, engine);
		const ann = annotateHotspots(fused, methods);
		// Only "Hot" gets an annotation; SQL frame has no attribution entry → skipped
		expect(ann.length).toBe(1);
		expect(ann[0].attrKey).toBe("Hot_Codeunit_50000");
	});

	it("surfaces findings on a matched method", () => {
		const methods = [makeMethod("ProcessRecords", "Codeunit", 50100, 50, 50)];
		const engine = makeEngine(
			[makeRoutine("ProcessRecords", 50100, "Codeunit", "r0")],
			[makeFinding("F1", "fp1", "d1", "ProcessRecords", "Codeunit", 50100)],
		);
		const fused = correlate(methods, engine);
		const ann = annotateHotspots(fused, methods);
		expect(ann).toHaveLength(1);
		expect(ann[0].findings).toHaveLength(1);
		expect(ann[0].findings[0].id).toBe("F1");
		expect(ann[0].status).toBe("matched");
		expect(ann[0].attributionConfidence).toBe("exact");
	});

	it("sets matchedClean=true when coverage is complete and findings are empty", () => {
		const methods = [makeMethod("CleanProc", "Codeunit", 50100, 30, 30)];
		// Use a properly formatted stableRoutineId so parseCoverageSubject can extract
		// the objectType+number from the coverage subject (the subject is the stableRoutineId).
		const stableId = `${APP_GUID}:Codeunit:50100#aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd01`;
		const engine = makeEngine(
			[makeRoutine("CleanProc", 50100, "Codeunit", stableId)],
			[], // no findings, complete coverage via default makeEngine
		);
		const fused = correlate(methods, engine);
		const ann = annotateHotspots(fused, methods);
		expect(ann[0].matchedClean).toBe(true);
		expect(ann[0].reason).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Per-finding corroboratingPatterns (P3.1, R3-6 / R2-12)
// ---------------------------------------------------------------------------

describe("prioritizeFindings — per-finding corroboratingPatterns (P3.1)", () => {
	/**
	 * Build a minimal fused model with a single matched attribution that already
	 * has corroboratingPatterns set (as corroborate.ts would do in production).
	 * We inject via attributions.set after correlate(), then override the field.
	 */
	function makeFusedWithCorroboration(
		method: MethodBreakdown,
		_findings: FindingSummary[],
		corroboratingPatterns: string[],
		engine: EngineAnalysis,
	) {
		const fused = correlate([method], engine);
		const key = `${method.functionName}_${method.objectType}_${method.objectId}`;
		const existing = fused.attributions.get(key);
		if (existing) {
			// Inject attribution-level corroborating patterns (as corroborate.ts would)
			(existing as SemanticAttribution).corroboratingPatterns =
				corroboratingPatterns;
		}
		return fused;
	}

	it("a finding whose detector is corroborated carries the pattern id (per-finding precision)", () => {
		const method = makeMethod("ProcessItems", "Codeunit", 50100, 40, 50);
		const findingD1 = makeFinding(
			"FD1",
			"fpD1",
			"d1-db-op-in-loop",
			"ProcessItems",
			"Codeunit",
			50100,
		);
		const engine = makeEngine(
			[makeRoutine("ProcessItems", 50100, "Codeunit", "r0")],
			[findingD1],
		);
		const fused = makeFusedWithCorroboration(
			method,
			[findingD1],
			["repeated-siblings"],
			engine,
		);
		const { weighted } = prioritizeFindings(fused, [method]);
		const row = weighted.find((r) => r.finding.id === "FD1");
		expect(row).toBeDefined();
		expect(row?.corroboratingPatterns).toEqual(["repeated-siblings"]);
	});

	it("a sibling finding on the same routine with an unmapped detector does NOT carry corroboratingPatterns", () => {
		const method = makeMethod("ProcessItems", "Codeunit", 50100, 40, 50);
		const findingD1 = makeFinding(
			"FD1",
			"fpD1",
			"d1-db-op-in-loop",
			"ProcessItems",
			"Codeunit",
			50100,
		);
		const findingD14 = makeFinding(
			"FD14",
			"fpD14",
			"d14-dead-routine",
			"ProcessItems",
			"Codeunit",
			50100,
		);
		const engine = makeEngine(
			[makeRoutine("ProcessItems", 50100, "Codeunit", "r0")],
			[findingD1, findingD14],
		);
		const fused = makeFusedWithCorroboration(
			method,
			[findingD1, findingD14],
			["repeated-siblings"],
			engine,
		);
		const { weighted } = prioritizeFindings(fused, [method]);

		// d1 → corroborated (repeated-siblings maps to d1-db-op-in-loop)
		const rowD1 = weighted.find((r) => r.finding.id === "FD1");
		expect(rowD1?.corroboratingPatterns).toEqual(["repeated-siblings"]);

		// d14 → NOT corroborated (repeated-siblings does NOT map to d14-dead-routine)
		const rowD14 = weighted.find((r) => r.finding.id === "FD14");
		expect(rowD14?.corroboratingPatterns).toBeUndefined();
	});

	it("cold / unweighted findings NEVER carry corroboratingPatterns (R2-12)", () => {
		// Method is in the profile (hot), but the cold finding is on a routine NOT in methods[]
		const hotMethod = makeMethod("Hot", "Codeunit", 50000, 50, 50);
		const findingHot = makeFinding(
			"FH",
			"fpH",
			"d1-db-op-in-loop",
			"Hot",
			"Codeunit",
			50000,
		);
		const findingCold = makeFinding(
			"FC",
			"fpC",
			"d1-db-op-in-loop",
			"ColdRoutine",
			"Codeunit",
			50002,
		);
		const engine = makeEngine(
			[
				makeRoutine("Hot", 50000, "Codeunit", "r0"),
				makeRoutine("ColdRoutine", 50002, "Codeunit", "r2"),
			],
			[findingHot, findingCold],
		);
		const fused = correlate([hotMethod], engine);
		// Inject corroboratingPatterns on the hot attribution
		const hotKey = "Hot_Codeunit_50000";
		const hotAttr = fused.attributions.get(hotKey);
		if (hotAttr)
			(hotAttr as SemanticAttribution).corroboratingPatterns = [
				"repeated-siblings",
			];

		const { weighted, unweighted } = prioritizeFindings(fused, [hotMethod]);

		// Hot finding has corroboratingPatterns (it's weighted, detector is corroborated)
		const hotRow = weighted.find((r) => r.finding.id === "FH");
		expect(hotRow?.corroboratingPatterns).toEqual(["repeated-siblings"]);

		// Cold finding is in unweighted and NEVER has corroboratingPatterns
		const coldRow = unweighted.find((r) => r.finding.id === "FC");
		expect(coldRow).toBeDefined();
		expect(coldRow?.corroboratingPatterns).toBeUndefined();
	});

	it("is deterministic across two runs (R2-14)", () => {
		const method = makeMethod("ProcessItems", "Codeunit", 50100, 40, 50);
		const findingD1 = makeFinding(
			"FD1",
			"fpD1",
			"d1-db-op-in-loop",
			"ProcessItems",
			"Codeunit",
			50100,
		);
		const engine = makeEngine(
			[makeRoutine("ProcessItems", 50100, "Codeunit", "r0")],
			[findingD1],
		);
		const fused1 = makeFusedWithCorroboration(
			method,
			[findingD1],
			["repeated-siblings"],
			engine,
		);
		const fused2 = makeFusedWithCorroboration(
			method,
			[findingD1],
			["repeated-siblings"],
			engine,
		);
		const r1 = prioritizeFindings(fused1, [method]);
		const r2 = prioritizeFindings(fused2, [method]);
		expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
	});

	it("TRUE UNION: one fingerprint on TWO attributions with divergent corroborating sets carries BOTH, sorted (R2-8 cross-frame)", () => {
		// Two field triggers normalize to ONE routine/finding (OnValidate) but have
		// DISTINCT methodAttrKeys → two separate attributions carrying the SAME
		// finding fingerprint. Each attribution gets a DIFFERENT corroborating set;
		// the prioritized finding must union BOTH (not just the first frame's).
		// repeated-siblings AND high-hit-count both corroborate d1-db-op-in-loop.
		const methodA = makeMethod("Field A - OnValidate", "Table", 50100, 10, 10);
		const methodB = makeMethod("Field B - OnValidate", "Table", 50100, 8, 8);
		const engine = makeEngine(
			[makeRoutine("OnValidate", 50100, "Table", "rt")],
			[
				makeFinding(
					"FT",
					"fpT",
					"d1-db-op-in-loop",
					"OnValidate",
					"Table",
					50100,
				),
			],
		);
		const fused = correlate([methodA, methodB], engine);

		// Inject DIVERGENT corroborating sets on the two distinct attributions.
		const attrA = fused.attributions.get("Field A - OnValidate_Table_50100");
		const attrB = fused.attributions.get("Field B - OnValidate_Table_50100");
		expect(attrA).toBeDefined();
		expect(attrB).toBeDefined();
		(attrA as SemanticAttribution).corroboratingPatterns = [
			"repeated-siblings",
		];
		(attrB as SemanticAttribution).corroboratingPatterns = ["high-hit-count"];

		const { weighted } = prioritizeFindings(fused, [methodA, methodB]);
		const ft = weighted.find((r) => r.finding.id === "FT");
		expect(ft).toBeDefined();
		expect(ft?.frameCount).toBe(2); // both frames carry the finding
		// TRUE UNION: both patterns present, sorted (high-hit-count < repeated-siblings).
		expect(ft?.corroboratingPatterns).toEqual([
			"high-hit-count",
			"repeated-siblings",
		]);
	});

	it("cross-frame union is order-independent + deterministic (frame order does not change the result)", () => {
		const methodA = makeMethod("Field A - OnValidate", "Table", 50100, 10, 10);
		const methodB = makeMethod("Field B - OnValidate", "Table", 50100, 8, 8);
		const engine = makeEngine(
			[makeRoutine("OnValidate", 50100, "Table", "rt")],
			[
				makeFinding(
					"FT",
					"fpT",
					"d1-db-op-in-loop",
					"OnValidate",
					"Table",
					50100,
				),
			],
		);
		const fused1 = correlate([methodA, methodB], engine);
		(
			fused1.attributions.get(
				"Field A - OnValidate_Table_50100",
			) as SemanticAttribution
		).corroboratingPatterns = ["repeated-siblings"];
		(
			fused1.attributions.get(
				"Field B - OnValidate_Table_50100",
			) as SemanticAttribution
		).corroboratingPatterns = ["high-hit-count"];
		// Reverse the methods[] order → same finding, frames visited in opposite order.
		const r1 = prioritizeFindings(fused1, [methodA, methodB]);
		const r2 = prioritizeFindings(fused1, [methodB, methodA]);
		const ft1 = r1.weighted.find((r) => r.finding.id === "FT");
		const ft2 = r2.weighted.find((r) => r.finding.id === "FT");
		expect(ft1?.corroboratingPatterns).toEqual([
			"high-hit-count",
			"repeated-siblings",
		]);
		expect(ft2?.corroboratingPatterns).toEqual(ft1?.corroboratingPatterns);
	});
});
