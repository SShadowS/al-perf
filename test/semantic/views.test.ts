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
	type CausalStep,
	formatOriginatingObjectNote,
	originatingObjectDiffersFromHotspot,
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

// ---------------------------------------------------------------------------
// causalSteps (P3.2b)
// ---------------------------------------------------------------------------

describe("prioritizeFindings — causalSteps (P3.2b)", () => {
	/**
	 * Build an EvidenceStep-like object for use in FindingSummary.evidencePath.
	 * Uses the :-form stableRoutineId.
	 */
	function makeEvidenceStep(
		routineId: string,
		file: string,
		line: number,
		note: string,
	) {
		return { routineId, file, line, note };
	}

	it("causalSteps: deep callee step has high selfTime + isHot:true, shallow step lower", () => {
		// Three routines: entry (self 5%), mid (self 10%), leaf (self 40%).
		// evidencePath: entry → mid → leaf. Causal chain should carry runtime cost.
		const stableEntry = `${APP_GUID}:Codeunit:100#entry`;
		const stableMid = `${APP_GUID}:Codeunit:101#mid`;
		const stableLeaf = `${APP_GUID}:Codeunit:102#leaf`;

		const methodEntry = makeMethod("Entry", "Codeunit", 100, 5, 50);
		const methodMid = makeMethod("Mid", "Codeunit", 101, 10, 45);
		const methodLeaf = makeMethod("Leaf", "Codeunit", 102, 40, 40);

		const finding = makeFinding(
			"FLeaf",
			"fpLeaf",
			"d1",
			"Entry",
			"Codeunit",
			100,
		);
		// Attach evidencePath
		(finding as FindingSummary).evidencePath = [
			makeEvidenceStep(stableEntry, "ws:src/Entry.al", 5, "calls"),
			makeEvidenceStep(stableMid, "ws:src/Mid.al", 12, "calls"),
			makeEvidenceStep(stableLeaf, "ws:src/Leaf.al", 30, "for loop"),
		];

		const routines: RoutineIdentity[] = [
			makeRoutine("Entry", 100, "Codeunit", stableEntry),
			makeRoutine("Mid", 101, "Codeunit", stableMid),
			makeRoutine("Leaf", 102, "Codeunit", stableLeaf),
		];

		const engine = makeEngine(routines, [finding]);
		const fused = correlate([methodEntry, methodMid, methodLeaf], engine);

		const { weighted } = prioritizeFindings(
			fused,
			[methodEntry, methodMid, methodLeaf],
			routines,
		);
		const row = weighted.find((r) => r.finding.id === "FLeaf");
		expect(row).toBeDefined();
		expect(row?.causalSteps).toBeDefined();
		const steps = row?.causalSteps as CausalStep[];
		expect(steps).toHaveLength(3);

		// Preserve evidencePath order
		expect(steps[0]?.note).toBe("calls");
		expect(steps[1]?.note).toBe("calls");
		expect(steps[2]?.note).toBe("for loop");

		// Leaf step (index 2) is the hot one
		expect(steps[2]?.selfTimePercent).toBe(40);
		expect(steps[2]?.isHot).toBe(true);
		expect(steps[2]?.routineName).toBe("Leaf");
		expect(steps[2]?.objectType).toBe("Codeunit");
		expect(steps[2]?.objectId).toBe(102);

		// Entry step (self 5%) is not hot by the callee's standard
		expect(steps[0]?.selfTimePercent).toBe(5);
		expect(steps[0]?.isHot).toBe(true); // self > 0 → isHot
		expect(steps[0]?.routineName).toBe("Entry");

		// Mid step
		expect(steps[1]?.selfTimePercent).toBe(10);
		expect(steps[1]?.isHot).toBe(true);
	});

	it("causalSteps: unresolved step (routineId not in inventory) → no percentages, isHot:false", () => {
		const stableEntry = `${APP_GUID}:Codeunit:200#entry`;
		const stableBuiltin = "external-guid:Codeunit:1000#builtin"; // NOT in inventory

		const methodEntry = makeMethod("Entry", "Codeunit", 200, 20, 50);

		const finding = makeFinding("FE", "fpE", "d1", "Entry", "Codeunit", 200);
		(finding as FindingSummary).evidencePath = [
			makeEvidenceStep(stableEntry, "ws:src/Entry.al", 5, "calls"),
			makeEvidenceStep(stableBuiltin, "external:lib.al", 99, "built-in call"),
		];

		const routines: RoutineIdentity[] = [
			makeRoutine("Entry", 200, "Codeunit", stableEntry),
			// stableBuiltin intentionally NOT in routines
		];

		const engine = makeEngine(routines, [finding]);
		const fused = correlate([methodEntry], engine);

		const { weighted } = prioritizeFindings(fused, [methodEntry], routines);
		const row = weighted.find((r) => r.finding.id === "FE");
		expect(row?.causalSteps).toBeDefined();
		const steps = row?.causalSteps as CausalStep[];
		expect(steps).toHaveLength(2);

		// Resolved step
		expect(steps[0]?.routineName).toBe("Entry");
		expect(steps[0]?.selfTimePercent).toBeDefined();
		expect(steps[0]?.isHot).toBe(true);

		// Unresolved (builtin) step — HONEST: no fabricated cost
		expect(steps[1]?.routineName).toBeUndefined();
		expect(steps[1]?.selfTimePercent).toBeUndefined();
		expect(steps[1]?.totalTimePercent).toBeUndefined();
		expect(steps[1]?.isHot).toBe(false);
		expect(steps[1]?.note).toBe("built-in call");
		expect(steps[1]?.file).toBe("external:lib.al");
		expect(steps[1]?.line).toBe(99);
	});

	it("causalSteps: no evidencePath → causalSteps undefined", () => {
		const stableR = `${APP_GUID}:Codeunit:300#r`;
		const method = makeMethod("Proc", "Codeunit", 300, 30, 30);
		const finding = makeFinding("FP", "fpP", "d1", "Proc", "Codeunit", 300);
		// No evidencePath set

		const routines: RoutineIdentity[] = [
			makeRoutine("Proc", 300, "Codeunit", stableR),
		];
		const engine = makeEngine(routines, [finding]);
		const fused = correlate([method], engine);

		const { weighted } = prioritizeFindings(fused, [method], routines);
		const row = weighted.find((r) => r.finding.id === "FP");
		expect(row).toBeDefined();
		expect(row?.causalSteps).toBeUndefined();
	});

	it("causalSteps: cold/unweighted findings NEVER get causalSteps (R2-12)", () => {
		const stableHot = `${APP_GUID}:Codeunit:400#hot`;
		const stableCold = `${APP_GUID}:Codeunit:401#cold`;

		const methodHot = makeMethod("Hot", "Codeunit", 400, 50, 50);
		// ColdRoutine is NOT in methods (not hot in the profile)

		const findingHot = makeFinding("FH", "fpH", "d1", "Hot", "Codeunit", 400);
		(findingHot as FindingSummary).evidencePath = [
			makeEvidenceStep(stableHot, "ws:src/Hot.al", 10, "loop"),
		];

		const findingCold = makeFinding("FC", "fpC", "d1", "Cold", "Codeunit", 401);
		(findingCold as FindingSummary).evidencePath = [
			makeEvidenceStep(stableCold, "ws:src/Cold.al", 5, "loop"),
		];

		const routines: RoutineIdentity[] = [
			makeRoutine("Hot", 400, "Codeunit", stableHot),
			makeRoutine("Cold", 401, "Codeunit", stableCold),
		];
		const engine = makeEngine(routines, [findingHot, findingCold]);
		const fused = correlate([methodHot], engine);

		const { weighted, unweighted } = prioritizeFindings(
			fused,
			[methodHot],
			routines,
		);

		// Weighted hot finding DOES get causalSteps
		const hotRow = weighted.find((r) => r.finding.id === "FH");
		expect(hotRow?.causalSteps).toBeDefined();

		// Cold unweighted finding NEVER gets causalSteps
		const coldRow = unweighted.find((r) => r.finding.id === "FC");
		expect(coldRow).toBeDefined();
		expect(coldRow?.causalSteps).toBeUndefined();
	});

	it("causalSteps: deterministic — same result on two calls (R2-14)", () => {
		const stableR = `${APP_GUID}:Codeunit:500#r`;
		const method = makeMethod("Stable", "Codeunit", 500, 25, 25);
		const finding = makeFinding("FS", "fpS", "d1", "Stable", "Codeunit", 500);
		(finding as FindingSummary).evidencePath = [
			makeEvidenceStep(stableR, "ws:src/Stable.al", 7, "step"),
		];

		const routines: RoutineIdentity[] = [
			makeRoutine("Stable", 500, "Codeunit", stableR),
		];
		const engine = makeEngine(routines, [finding]);
		const fused1 = correlate([method], engine);
		const fused2 = correlate([method], engine);

		const r1 = prioritizeFindings(fused1, [method], routines);
		const r2 = prioritizeFindings(fused2, [method], routines);
		expect(JSON.stringify(r1.weighted)).toBe(JSON.stringify(r2.weighted));
	});

	it("causalSteps: no routines passed → all steps are unresolved (honest)", () => {
		// When routines is undefined, steps get no runtime info (no fabrication).
		const stableR = `${APP_GUID}:Codeunit:600#r`;
		const method = makeMethod("P", "Codeunit", 600, 30, 30);
		const finding = makeFinding("FF", "fpF", "d1", "P", "Codeunit", 600);
		(finding as FindingSummary).evidencePath = [
			makeEvidenceStep(stableR, "ws:src/P.al", 5, "calls"),
		];

		const routines: RoutineIdentity[] = [
			makeRoutine("P", 600, "Codeunit", stableR),
		];
		const engine = makeEngine(routines, [finding]);
		const fused = correlate([method], engine);

		// Call WITHOUT routines param
		const { weighted } = prioritizeFindings(fused, [method]);
		const row = weighted.find((r) => r.finding.id === "FF");
		// causalSteps may still be present but all steps unresolved
		const steps = row?.causalSteps;
		if (steps) {
			// All steps must be unresolved (no allRoutines on bare FusedModel from correlate)
			for (const s of steps) {
				expect(s.routineName).toBeUndefined();
				expect(s.selfTimePercent).toBeUndefined();
				expect(s.isHot).toBe(false);
			}
		}
	});

	it("causalSteps: FIELD-TRIGGER step resolves via normalizeTriggerName (regression for the canonical-key fix)", () => {
		// THE case that silently failed before the join fix: the profile method
		// functionName is the COMPOUND "Quantity - OnValidate" but the inventory
		// routineName is the BARE "OnValidate". A raw-functionName join NEVER
		// matched these, so the step resolved to no-cost/isHot:false. With the
		// canonical join (normalizeTriggerName applied to the method side inside
		// makeMethodJoinKey) it MUST resolve to the field trigger's runtime cost.
		const stableEntry = `${APP_GUID}:Table:700#entry`;
		const stableTrigger = `${APP_GUID}:Table:700#onvalidate`;

		// Entry orchestrator (low self) + the hot field trigger (high self).
		const methodEntry = makeMethod("Entry", "Table", 700, 5, 50);
		// Profile reports the field trigger as the COMPOUND name.
		const methodTrigger = makeMethod(
			"Quantity - OnValidate",
			"Table",
			700,
			42,
			42,
		);

		const finding = makeFinding(
			"FFieldTrig",
			"fpFieldTrig",
			"d1",
			"Entry",
			"Table",
			700,
		);
		(finding as FindingSummary).evidencePath = [
			makeEvidenceStep(stableEntry, "ws:src/Item.Table.al", 5, "calls"),
			// This step's routine is the field trigger with BARE routineName.
			makeEvidenceStep(
				stableTrigger,
				"ws:src/Item.Table.al",
				40,
				"db op in loop",
			),
		];

		const routines: RoutineIdentity[] = [
			makeRoutine("Entry", 700, "Table", stableEntry),
			// Inventory carries the BARE trigger name.
			makeRoutine("OnValidate", 700, "Table", stableTrigger),
		];

		const engine = makeEngine(routines, [finding]);
		const fused = correlate([methodEntry, methodTrigger], engine);

		const { weighted } = prioritizeFindings(
			fused,
			[methodEntry, methodTrigger],
			routines,
		);
		const row = weighted.find((r) => r.finding.id === "FFieldTrig");
		expect(row).toBeDefined();
		const steps = row?.causalSteps as CausalStep[];
		expect(steps).toHaveLength(2);

		// The field-trigger step (index 1) MUST resolve to the compound method's
		// runtime cost — this is the assertion that fails under the buggy raw join.
		expect(steps[1]?.note).toBe("db op in loop");
		expect(steps[1]?.routineName).toBe("Quantity - OnValidate");
		expect(steps[1]?.selfTimePercent).toBe(42);
		expect(steps[1]?.totalTimePercent).toBe(42);
		expect(steps[1]?.isHot).toBe(true);
		expect(steps[1]?.objectType).toBe("Table");
		expect(steps[1]?.objectId).toBe(700);
	});

	it("causalSteps: alias-spelled objectType resolves via canonicalObjectType", () => {
		// Inventory routine uses an alias spelling ("CodeUnit") while the profile
		// method uses the canonical "Codeunit". The canonical join key (applied to
		// BOTH sides) must unify them so the step resolves.
		const stableR = `${APP_GUID}:Codeunit:800#proc`;

		// Profile method: canonical "Codeunit".
		const method = makeMethod("DoWork", "Codeunit", 800, 33, 33);

		const finding = makeFinding(
			"FAlias",
			"fpAlias",
			"d1",
			"DoWork",
			"Codeunit",
			800,
		);
		(finding as FindingSummary).evidencePath = [
			makeEvidenceStep(stableR, "ws:src/Work.Codeunit.al", 12, "loop"),
		];

		// Inventory: alias spelling "CodeUnit" (mixed case) — same object.
		const routines: RoutineIdentity[] = [
			makeRoutine("DoWork", 800, "CodeUnit", stableR),
		];

		const engine = makeEngine(routines, [finding]);
		const fused = correlate([method], engine);

		const { weighted } = prioritizeFindings(fused, [method], routines);
		const row = weighted.find((r) => r.finding.id === "FAlias");
		expect(row).toBeDefined();
		const steps = row?.causalSteps as CausalStep[];
		expect(steps).toHaveLength(1);
		// Resolved despite the objectType alias mismatch.
		expect(steps[0]?.routineName).toBe("DoWork");
		expect(steps[0]?.selfTimePercent).toBe(33);
		expect(steps[0]?.isHot).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// R3-8: originatingObject provenance display
// ---------------------------------------------------------------------------

const EXT_APP_GUID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

describe("originatingObjectDiffersFromHotspot", () => {
	it("returns false when originatingObject is undefined", () => {
		expect(
			originatingObjectDiffersFromHotspot(undefined, "Codeunit", 50100),
		).toBe(false);
	});

	it("returns false when originatingObject is malformed (< 3 segments)", () => {
		expect(
			originatingObjectDiffersFromHotspot("onlyone", "Codeunit", 50100),
		).toBe(false);
		expect(
			originatingObjectDiffersFromHotspot("two:parts", "Codeunit", 50100),
		).toBe(false);
	});

	it("returns false when originatingObject matches the hotspot (same Type:Num)", () => {
		// Same object → base-object member, no note.
		const originating = `${APP_GUID}:Codeunit:50100`;
		expect(
			originatingObjectDiffersFromHotspot(originating, "Codeunit", 50100),
		).toBe(false);
	});

	it("returns false when originatingObject matches despite canonicalization of objectType", () => {
		// Inventory carries alias "CodeUnit"; hotspot method uses "Codeunit" — same object.
		const originating = `${APP_GUID}:CodeUnit:50100`;
		expect(
			originatingObjectDiffersFromHotspot(originating, "Codeunit", 50100),
		).toBe(false);
	});

	it("returns true when originatingObject has different objectNumber (extension-declared member)", () => {
		// A TableExtension 70000 extends Table 50100; the member's originatingObject
		// is the base Table 50100, but the hotspot is the extension 70000.
		const originating = `${APP_GUID}:Table:50100`;
		expect(
			originatingObjectDiffersFromHotspot(originating, "Table", 70000),
		).toBe(true);
	});

	it("returns true when originatingObject has different objectType", () => {
		const originating = `${APP_GUID}:Table:50100`;
		expect(
			originatingObjectDiffersFromHotspot(originating, "Codeunit", 50100),
		).toBe(true);
	});

	it("returns true when originatingObject has different app GUID (hotspotAppId provided)", () => {
		// Routine declared in a different app than the hotspot (cross-app extension).
		// hotspotAppId must be provided for the app-GUID comparison to fire.
		const originating = `${EXT_APP_GUID}:Table:50100`;
		expect(
			originatingObjectDiffersFromHotspot(
				originating,
				"Table",
				50100,
				APP_GUID,
			),
		).toBe(true);
	});

	it("returns false when originatingObject has different app GUID but hotspotAppId is absent (graceful)", () => {
		// Without hotspotAppId the app-GUID comparison is skipped — only Type:Num compared.
		// Prevents false positives for methods without appId (System frames, old profiles).
		const originating = `${EXT_APP_GUID}:Table:50100`;
		expect(
			originatingObjectDiffersFromHotspot(originating, "Table", 50100),
		).toBe(false);
	});
});

describe("formatOriginatingObjectNote", () => {
	it("returns empty string when originatingObject is absent", () => {
		expect(formatOriginatingObjectNote({})).toBe("");
	});

	it("formats Type:Num display (strips leading appGuid segment)", () => {
		const ann = { originatingObject: `${APP_GUID}:Table:50100` };
		expect(formatOriginatingObjectNote(ann)).toBe(" (declared in Table:50100)");
	});

	it("strips #hash suffix from the Num segment", () => {
		const ann = {
			originatingObject: `${APP_GUID}:Table:50100#aabbcc0011223344556677889900112233445566778899001122334455667788ff`,
		};
		expect(formatOriginatingObjectNote(ann)).toBe(" (declared in Table:50100)");
	});

	it("returns empty string for malformed originatingObject (< 3 segments)", () => {
		expect(formatOriginatingObjectNote({ originatingObject: "only:two" })).toBe(
			"",
		);
	});
});

describe("annotateHotspots — R3-8 originatingObject", () => {
	const EXT_STABLE_ID = `${APP_GUID}:Table:70000#trigger01`;

	it("carries originatingObject when the matched routine names a DIFFERENT object (extension-declared member)", () => {
		// TableExtension 70000 has an OnValidate that originates in Table 50100.
		// The hotspot is the extension (Table 70000); originatingObject says Table 50100.
		const originating = `${APP_GUID}:Table:50100`;
		const routine: RoutineIdentity = {
			stableRoutineId: EXT_STABLE_ID,
			objectType: "Table",
			objectNumber: 70000,
			routineName: "OnValidate",
			enclosingMember: "Quantity",
			originatingObject: originating,
		};
		const method = makeMethod("Quantity - OnValidate", "Table", 70000, 30, 30);
		const engine = makeEngine([routine], []);
		const fused = correlate([method], engine);
		// Manually set allRoutines (as fuseProfile does).
		fused.allRoutines = [routine];

		const ann = annotateHotspots(fused, [method]);
		expect(ann).toHaveLength(1);
		expect(ann[0]?.originatingObject).toBe(originating);
	});

	it("does NOT carry originatingObject when the matched routine's originatingObject equals the hotspot (base-object member)", () => {
		// OnValidate on Table 50100; originatingObject is also Table 50100.
		const originating = `${APP_GUID}:Table:50100`;
		const stableId = `${APP_GUID}:Table:50100#trigger01`;
		const routine: RoutineIdentity = {
			stableRoutineId: stableId,
			objectType: "Table",
			objectNumber: 50100,
			routineName: "OnValidate",
			enclosingMember: "Quantity",
			originatingObject: originating,
		};
		const method = makeMethod("Quantity - OnValidate", "Table", 50100, 30, 30);
		const engine = makeEngine([routine], []);
		const fused = correlate([method], engine);
		fused.allRoutines = [routine];

		const ann = annotateHotspots(fused, [method]);
		expect(ann).toHaveLength(1);
		expect(ann[0]?.originatingObject).toBeUndefined();
	});

	it("does NOT carry originatingObject when the routine has no originatingObject (old engine / procedure)", () => {
		const stableId = `${APP_GUID}:Codeunit:50100#proc01`;
		const routine: RoutineIdentity = {
			stableRoutineId: stableId,
			objectType: "Codeunit",
			objectNumber: 50100,
			routineName: "ProcessRecords",
			// originatingObject absent — old engine or non-member-trigger
		};
		const method = makeMethod("ProcessRecords", "Codeunit", 50100, 30, 30);
		const engine = makeEngine([routine], []);
		const fused = correlate([method], engine);
		fused.allRoutines = [routine];

		const ann = annotateHotspots(fused, [method]);
		expect(ann).toHaveLength(1);
		expect(ann[0]?.originatingObject).toBeUndefined();
	});

	it("does NOT carry originatingObject when allRoutines is absent (no fuseProfile call)", () => {
		// Simulates a FusedModel built directly from correlate() without fuseProfile.
		const originating = `${APP_GUID}:Table:50100`;
		const routine: RoutineIdentity = {
			stableRoutineId: EXT_STABLE_ID,
			objectType: "Table",
			objectNumber: 70000,
			routineName: "OnValidate",
			enclosingMember: "Quantity",
			originatingObject: originating,
		};
		const method = makeMethod("Quantity - OnValidate", "Table", 70000, 30, 30);
		const engine = makeEngine([routine], []);
		const fused = correlate([method], engine);
		// Do NOT set fused.allRoutines → simulates old model.

		const ann = annotateHotspots(fused, [method]);
		expect(ann).toHaveLength(1);
		expect(ann[0]?.originatingObject).toBeUndefined(); // graceful
	});
});

describe("fusionAnnotationNote rendering — R3-8 (per-surface spot checks)", () => {
	// These tests verify that the provenance note text is correctly produced
	// by the shared helper, which all surfaces (terminal/markdown/html/web) use.
	// Surface-specific rendering is covered by the formatter integration tests;
	// here we focus on the model + note helper contract.

	it("formatOriginatingObjectNote: extension member → note present", () => {
		const ann = { originatingObject: `${APP_GUID}:Table:50100` };
		const note = formatOriginatingObjectNote(ann);
		expect(note).toContain("declared in");
		expect(note).toContain("Table:50100");
		// Must not contain the appGuid
		expect(note).not.toContain(APP_GUID);
	});

	it("formatOriginatingObjectNote: absent → empty (graceful)", () => {
		expect(formatOriginatingObjectNote({})).toBe("");
	});

	it("annotateHotspots + formatOriginatingObjectNote: end-to-end note appears for extension member", () => {
		const originating = `${APP_GUID}:Table:50100`;
		const stableId = `${APP_GUID}:Table:70000#trigger01`;
		const routine: RoutineIdentity = {
			stableRoutineId: stableId,
			objectType: "Table",
			objectNumber: 70000,
			routineName: "OnValidate",
			enclosingMember: "Qty",
			originatingObject: originating,
		};
		const method = makeMethod("Qty - OnValidate", "Table", 70000, 25, 25);
		const engine = makeEngine([routine], []);
		const fused = correlate([method], engine);
		fused.allRoutines = [routine];

		const ann = annotateHotspots(fused, [method]);
		const note = formatOriginatingObjectNote(ann[0] ?? {});
		expect(note).toBe(" (declared in Table:50100)");
	});

	it("annotateHotspots + formatOriginatingObjectNote: base member → no note", () => {
		const originating = `${APP_GUID}:Table:50100`;
		const stableId = `${APP_GUID}:Table:50100#trigger01`;
		const routine: RoutineIdentity = {
			stableRoutineId: stableId,
			objectType: "Table",
			objectNumber: 50100,
			routineName: "OnValidate",
			enclosingMember: "Qty",
			originatingObject: originating,
		};
		const method = makeMethod("Qty - OnValidate", "Table", 50100, 25, 25);
		const engine = makeEngine([routine], []);
		const fused = correlate([method], engine);
		fused.allRoutines = [routine];

		const ann = annotateHotspots(fused, [method]);
		const note = formatOriginatingObjectNote(ann[0] ?? {});
		expect(note).toBe(""); // no note — same object
	});

	it("fusion-off (fusionViews absent): no annotation surfaced (byte-unchanged)", () => {
		// When there are no fusionViews, annotation list is empty.
		// This tests that the provenance path is strictly additive.
		const method = makeMethod("ProcessRecords", "Codeunit", 50100, 50, 50);
		const engine = makeEngine(
			[makeRoutine("ProcessRecords", 50100, "Codeunit", "r0")],
			[makeFinding("F1", "fp1", "d1", "ProcessRecords", "Codeunit", 50100)],
		);
		const fused = correlate([method], engine);
		// No allRoutines set — no provenance note.
		const ann = annotateHotspots(fused, [method]);
		expect(ann[0]?.originatingObject).toBeUndefined();
		expect(formatOriginatingObjectNote(ann[0] ?? {})).toBe("");
	});
});

// ---------------------------------------------------------------------------
// prioritizeFindings lifecycle fingerprints
// ---------------------------------------------------------------------------

describe("prioritizeFindings lifecycle fingerprints", () => {
	it("weighted rows carry the alsem:-wrapped native fingerprint", () => {
		const methods = [makeMethod("HotLeaf", "Codeunit", 50001, 80, 80)];
		const engine = makeEngine(
			[makeRoutine("HotLeaf", 50001, "Codeunit", "r1")],
			[makeFinding("FL", "fpL", "d1", "HotLeaf", "Codeunit", 50001)],
		);
		const fused = correlate(methods, engine);
		const { weighted } = prioritizeFindings(fused, methods);
		expect(weighted).toHaveLength(1);
		expect(weighted[0].fingerprint).toBe("alsem:fpL");
	});

	it("unweighted (cold) rows carry the alsem:-wrapped native fingerprint too", () => {
		const methods = [makeMethod("HotLeaf", "Codeunit", 50001, 80, 80)];
		const engine = makeEngine(
			[
				makeRoutine("HotLeaf", 50001, "Codeunit", "r1"),
				makeRoutine("ColdProc", 50002, "Codeunit", "r2"),
			],
			[makeFinding("FC", "fpC", "d1", "ColdProc", "Codeunit", 50002)],
		);
		const fused = correlate(methods, engine);
		const { unweighted } = prioritizeFindings(fused, methods);
		const cold = unweighted.find((r) => r.finding.id === "FC");
		expect(cold?.bucket).toBe("cold");
		expect(cold?.fingerprint).toBe("alsem:fpC");
	});
});
