import { describe, expect, it } from "bun:test";
import type {
	CoverageEntry,
	FindingSummary,
	RoutineIdentity,
} from "../../src/semantic/contracts.js";
import { correlate } from "../../src/semantic/correlate.js";
import { corroborate } from "../../src/semantic/corroborate.js";
import type { EngineAnalysis } from "../../src/semantic/engine-runner.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const APP_GUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const APP_NAME = "CorroborateTest";
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
	selfTimePercent = 50,
	totalTimePercent = 50,
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

/**
 * Build a DetectedPattern with `involvedMethods` as direct strings.
 * Mirrors the format emitted by formatMethodRef: "${functionName} (${objectType} ${objectId})".
 */
function makePattern(id: string, involvedMethods: string[]): DetectedPattern {
	return {
		id,
		severity: "warning",
		title: `Pattern ${id}`,
		description: "test pattern",
		impact: 1000,
		involvedMethods,
		evidence: "test evidence",
	};
}

/** Format a method ref the same way formatMethodRef does in src/core/patterns.ts */
function fmt(
	functionName: string,
	objectType: string,
	objectId: number,
): string {
	return `${functionName} (${objectType} ${objectId})`;
}

describe("corroborate", () => {
	it("matched + anchored repeated-siblings + d1 finding → corroborated", () => {
		// ProcessRecords (Codeunit 50100) is the parent (loop owner) in repeated-siblings.
		// involvedMethods[0] = parent = ProcessRecords
		const parentMethod = makeMethod("ProcessRecords", "Codeunit", 50100);
		const childMethod = makeMethod("Get", "Codeunit", 50101);
		const methods = [parentMethod, childMethod];

		const engine = makeEngine(
			[makeRoutine("ProcessRecords", 50100, "Codeunit", "r0")],
			[
				makeFinding(
					"F1",
					"fp1",
					"d1-db-op-in-loop",
					"ProcessRecords",
					"Codeunit",
					50100,
				),
			],
		);
		const fused = correlate(methods, engine);

		// repeated-siblings: involvedMethods = [parent, representativeChild]
		const patterns = [
			makePattern("repeated-siblings", [
				fmt("ProcessRecords", "Codeunit", 50100), // anchorIndex 0 = parent
				fmt("Get", "Codeunit", 50101),
			]),
		];

		corroborate(fused, methods, patterns);

		const attr = fused.attributions.get("ProcessRecords_Codeunit_50100");
		expect(attr).toBeDefined();
		expect(attr?.status).toBe("matched");
		expect(attr?.corroboratingPatterns).toEqual(["repeated-siblings"]);
	});

	it("unmapped detector (d14-dead-routine) → not corroborated", () => {
		const method = makeMethod("MyProc", "Codeunit", 50100);
		const methods = [method];

		const engine = makeEngine(
			[makeRoutine("MyProc", 50100, "Codeunit", "r0")],
			[
				makeFinding(
					"F1",
					"fp1",
					"d14-dead-routine",
					"MyProc",
					"Codeunit",
					50100,
				),
			],
		);
		const fused = correlate(methods, engine);

		const patterns = [
			makePattern("repeated-siblings", [
				fmt("MyProc", "Codeunit", 50100),
				fmt("Child", "Codeunit", 50101),
			]),
		];

		corroborate(fused, methods, patterns);

		const attr = fused.attributions.get("MyProc_Codeunit_50100");
		expect(attr?.corroboratingPatterns).toBeUndefined();
	});

	it("pattern anchored to a DIFFERENT routine → not corroborated on this routine", () => {
		const parentMethod = makeMethod("OtherProc", "Codeunit", 50200);
		const targetMethod = makeMethod("TargetProc", "Codeunit", 50100);
		const methods = [targetMethod, parentMethod];

		const engine = makeEngine(
			[
				makeRoutine("TargetProc", 50100, "Codeunit", "r0"),
				makeRoutine("OtherProc", 50200, "Codeunit", "r1"),
			],
			[
				makeFinding(
					"F1",
					"fp1",
					"d1-db-op-in-loop",
					"TargetProc",
					"Codeunit",
					50100,
				),
				makeFinding(
					"F2",
					"fp2",
					"d1-db-op-in-loop",
					"OtherProc",
					"Codeunit",
					50200,
				),
			],
		);
		const fused = correlate(methods, engine);

		// Pattern is anchored to OtherProc (anchorIndex 0 = parent), not TargetProc
		const patterns = [
			makePattern("repeated-siblings", [
				fmt("OtherProc", "Codeunit", 50200), // anchorIndex 0 = parent = OtherProc
				fmt("Child", "Codeunit", 50101),
			]),
		];

		corroborate(fused, methods, patterns);

		const attrTarget = fused.attributions.get("TargetProc_Codeunit_50100");
		expect(attrTarget?.corroboratingPatterns).toBeUndefined();

		const attrOther = fused.attributions.get("OtherProc_Codeunit_50200");
		expect(attrOther?.corroboratingPatterns).toEqual(["repeated-siblings"]);
	});

	it("ambiguous attribution → NOT corroborated (matched-only gate, R3-7)", () => {
		// Two universe routines share the same join key (objectType=Table, objectNumber=50100,
		// routineName=OnValidate) → both field triggers normalize to "OnValidate" → ambiguous.
		// This is the overload/field-trigger-collision case that correlate.ts honestly marks ambiguous.
		const methods = [
			makeMethod("Field A - OnValidate", "Table", 50100),
			makeMethod("Field B - OnValidate", "Table", 50100),
		];
		// Two routines with the SAME (objectType, objectNumber, routineName) → collide → ambiguous
		const engine = makeEngine(
			[
				makeRoutine("OnValidate", 50100, "Table", "rt1"),
				makeRoutine("OnValidate", 50100, "Table", "rt2"),
			],
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
		const fused = correlate(methods, engine);

		// Anchor repeated-siblings to "Field A - OnValidate (Table 50100)"
		const patterns = [
			makePattern("repeated-siblings", [
				fmt("Field A - OnValidate", "Table", 50100), // parent
				fmt("Child", "Codeunit", 50101),
			]),
		];

		corroborate(fused, methods, patterns);

		// Both methods are ambiguous — neither should get corroborated
		for (const m of methods) {
			const key = `${m.functionName}_${m.objectType}_${m.objectId}`;
			const attr = fused.attributions.get(key);
			if (attr) {
				expect(attr.status).toBe("ambiguous");
				expect(attr.corroboratingPatterns).toBeUndefined();
			}
		}
	});

	it("high-hit-count: parent (involvedMethods[1]) corroborates; child-only match does NOT", () => {
		// high-hit-count: involvedMethods = [child, parent]; anchorIndex = 1 → parent
		const parentMethod = makeMethod("ParentLoop", "Codeunit", 50100);
		const childMethod = makeMethod("GetRecord", "Codeunit", 50101);
		const methods = [parentMethod, childMethod];

		const engine = makeEngine(
			[
				makeRoutine("ParentLoop", 50100, "Codeunit", "r0"),
				makeRoutine("GetRecord", 50101, "Codeunit", "r1"),
			],
			[
				makeFinding(
					"FP",
					"fpP",
					"d1-db-op-in-loop",
					"ParentLoop",
					"Codeunit",
					50100,
				),
				makeFinding(
					"FC",
					"fpC",
					"d1-db-op-in-loop",
					"GetRecord",
					"Codeunit",
					50101,
				),
			],
		);
		const fused = correlate(methods, engine);

		// high-hit-count: involvedMethods = [child, parent]; anchorIndex 1 = parent
		const patterns = [
			makePattern("high-hit-count", [
				fmt("GetRecord", "Codeunit", 50101), // involvedMethods[0] = child
				fmt("ParentLoop", "Codeunit", 50100), // involvedMethods[1] = parent (anchor)
			]),
		];

		corroborate(fused, methods, patterns);

		// Parent gets corroborated (anchor is parent)
		const attrParent = fused.attributions.get("ParentLoop_Codeunit_50100");
		expect(attrParent?.corroboratingPatterns).toEqual(["high-hit-count"]);

		// Child does NOT get corroborated (anchor is the parent, not child)
		const attrChild = fused.attributions.get("GetRecord_Codeunit_50101");
		expect(attrChild?.corroboratingPatterns).toBeUndefined();
	});

	it("determinism: multiple corroborating patterns are sorted", () => {
		const method = makeMethod("ProcessRecords", "Codeunit", 50100);
		const methods = [method];

		const engine = makeEngine(
			[makeRoutine("ProcessRecords", 50100, "Codeunit", "r0")],
			[
				makeFinding(
					"F1",
					"fp1",
					"d7-recursive-event-expansion",
					"ProcessRecords",
					"Codeunit",
					50100,
				),
			],
		);
		// Add a second finding for d1 so both repeated-siblings and recursive-call can match
		engine.findings.push(
			makeFinding(
				"F2",
				"fp2",
				"d1-db-op-in-loop",
				"ProcessRecords",
				"Codeunit",
				50100,
			),
		);
		// Re-correlate with the updated findings
		const fused2 = correlate(methods, engine);

		// Both patterns anchor to ProcessRecords
		const patterns = [
			makePattern("recursive-call", [
				fmt("ProcessRecords", "Codeunit", 50100), // anchorIndex 0 = self
			]),
			makePattern("repeated-siblings", [
				fmt("ProcessRecords", "Codeunit", 50100), // anchorIndex 0 = parent
				fmt("Child", "Codeunit", 50101),
			]),
		];

		corroborate(fused2, methods, patterns);

		const attr = fused2.attributions.get("ProcessRecords_Codeunit_50100");
		expect(attr?.corroboratingPatterns).toBeDefined();
		// Must be sorted
		const patterns2 = attr?.corroboratingPatterns ?? [];
		expect(patterns2).toEqual([...patterns2].sort());
	});

	it("empty patterns → no corroborating patterns set", () => {
		const method = makeMethod("ProcessRecords", "Codeunit", 50100);
		const methods = [method];

		const engine = makeEngine(
			[makeRoutine("ProcessRecords", 50100, "Codeunit", "r0")],
			[
				makeFinding(
					"F1",
					"fp1",
					"d1-db-op-in-loop",
					"ProcessRecords",
					"Codeunit",
					50100,
				),
			],
		);
		const fused = correlate(methods, engine);

		corroborate(fused, methods, []);

		const attr = fused.attributions.get("ProcessRecords_Codeunit_50100");
		expect(attr?.corroboratingPatterns).toBeUndefined();
	});

	it("deduplication: same pattern anchored twice to the same method → only one entry", () => {
		const method = makeMethod("ProcessRecords", "Codeunit", 50100);
		const methods = [method];

		const engine = makeEngine(
			[makeRoutine("ProcessRecords", 50100, "Codeunit", "r0")],
			[
				makeFinding(
					"F1",
					"fp1",
					"d1-db-op-in-loop",
					"ProcessRecords",
					"Codeunit",
					50100,
				),
			],
		);
		const fused = correlate(methods, engine);

		// Same pattern id appearing twice (e.g. two sibling groups under the same parent)
		const patterns = [
			makePattern("repeated-siblings", [
				fmt("ProcessRecords", "Codeunit", 50100),
				fmt("GetA", "Codeunit", 50101),
			]),
			makePattern("repeated-siblings", [
				fmt("ProcessRecords", "Codeunit", 50100),
				fmt("GetB", "Codeunit", 50102),
			]),
		];

		corroborate(fused, methods, patterns);

		const attr = fused.attributions.get("ProcessRecords_Codeunit_50100");
		expect(attr?.corroboratingPatterns).toEqual(["repeated-siblings"]); // deduplicated
	});
});
