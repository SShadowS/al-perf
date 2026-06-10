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
