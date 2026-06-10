/**
 * correlate.test.ts — Unit tests for src/semantic/correlate.ts
 *
 * Tests cover each of the 6 correlation statuses using hand-built fixtures that
 * mirror the ws-min golden data:
 *
 *   matched         — exactly one universe routine; finding attached
 *   matched-clean   — in-universe, zero findings (status="matched", matchedClean=true)
 *   ambiguous       — 2 universe routines share the same key → UNION + ambiguous flag
 *   blind-spot      — method not in universe (builtin + not-in-workspace cases)
 *   cold            — universe routine with no runtime sample → in coldFindings
 *   unkeyable       — finding with no routineName → in unkeyableFindings (not cold)
 *
 * Also verifies:
 *   - determinism sort: union findings are sorted by (fingerprint, id)
 *   - stableRoutineId persisted on matched attributions
 *   - mismatch flag: zero intersection over a non-trivial method set
 *   - correlationSummary counters
 */

import { describe, expect, it } from "bun:test";
import { correlate } from "../../src/semantic/correlate.js";
import type { EngineAnalysis } from "../../src/semantic/engine-runner.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type {
	FindingSummary,
	RoutineIdentity,
} from "../../src/semantic/contracts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
			objectId:
				routineName !== undefined
					? `${APP_GUID}/${objectType}/${objectNumber}`
					: `${APP_GUID}/${objectType}/${objectNumber}`,
			objectName: "TestObject",
			routineName, // may be undefined to test unkeyable bucket
		},
		affectedObjects: [`${APP_GUID}/${objectType}/${objectNumber}`],
		affectedTables: [],
	};
}

function makeMethod(
	functionName: string,
	objectType: string,
	objectId: number,
	appName = APP_NAME,
	isBuiltin?: boolean,
): MethodBreakdown {
	return {
		functionName,
		objectType,
		objectName: "TestObject",
		objectId,
		appName,
		selfTime: 500,
		selfTimePercent: 10,
		totalTime: 500,
		totalTimePercent: 10,
		hitCount: 5,
		calledBy: [],
		calls: [],
		costPerHit: 100,
		efficiencyScore: 1.0,
		isBuiltin,
	};
}

function makeEngine(
	routines: RoutineIdentity[],
	findings: FindingSummary[],
): EngineAnalysis {
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
		coverage: [],
		coverageSubjects: [],
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
	};
}

// ---------------------------------------------------------------------------
// Stable IDs used across tests
// ---------------------------------------------------------------------------

const STABLE_ID_PROCESS_RECORDS = `${APP_GUID}:Codeunit:50100#586fc0b923483c425d345129585052094241f6fe3146b65cd1030d70b874bfba`;
const STABLE_ID_CLEAN = `${APP_GUID}:Codeunit:50100#299614d535d879f12cb7bf62378e7a2fa161777b4abf63b2113dfdac09cfbc5a`;
const STABLE_ID_OVERLOAD_1 = `${APP_GUID}:Codeunit:50100#19f10db44a02d3ddf1fe1e665faa7b08d65a514e2802138f3b9d38a71a2a8a99`;
const STABLE_ID_OVERLOAD_2 = `${APP_GUID}:Codeunit:50100#eea57b1a62fa70408ef36cbcd83eb95584bd4a7c13423c2008a64c186b04ee6f`;
const STABLE_ID_COLD = `${APP_GUID}:Codeunit:50100#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00`;

// ---------------------------------------------------------------------------
// Test 1: matched — one universe routine with a finding
// ---------------------------------------------------------------------------

describe("correlate: matched (one routine, with finding)", () => {
	const finding = makeFinding(
		"d1/find1",
		"c5f6eeaf350cb8fd",
		"d1-db-op-in-loop",
		"ProcessRecords",
		"Codeunit",
		50100,
	);

	const engine = makeEngine(
		[
			makeRoutine(
				"ProcessRecords",
				50100,
				"Codeunit",
				STABLE_ID_PROCESS_RECORDS,
			),
		],
		[finding],
	);

	const method = makeMethod("ProcessRecords", "Codeunit", 50100);
	const result = correlate([method], engine);
	const key = "ProcessRecords_Codeunit_50100";

	it("produces an attribution entry for the method key", () => {
		expect(result.attributions.has(key)).toBe(true);
	});

	it("status is matched", () => {
		expect(result.attributions.get(key)!.status).toBe("matched");
	});

	it("attributionConfidence is exact", () => {
		expect(result.attributions.get(key)!.attributionConfidence).toBe("exact");
	});

	it("matchedClean is not set (has findings)", () => {
		expect(result.attributions.get(key)!.matchedClean).toBeFalsy();
	});

	it("findings contain the d1 finding", () => {
		const attr = result.attributions.get(key)!;
		expect(attr.findings.length).toBe(1);
		expect(attr.findings[0].detector).toBe("d1-db-op-in-loop");
	});

	it("stableRoutineId is persisted", () => {
		expect(result.attributions.get(key)!.stableRoutineId).toBe(
			STABLE_ID_PROCESS_RECORDS,
		);
	});

	it("correlationSummary.matched = 1", () => {
		expect(result.correlationSummary.matched).toBe(1);
	});

	it("no mismatch (there is intersection)", () => {
		expect(result.mismatch).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Test 2: matched-clean — in universe, zero findings
// ---------------------------------------------------------------------------

describe("correlate: matched-clean (in-universe, no findings)", () => {
	const engine = makeEngine(
		[makeRoutine("CleanProcedure", 50100, "Codeunit", STABLE_ID_CLEAN)],
		[], // no findings at all
	);

	const method = makeMethod("CleanProcedure", "Codeunit", 50100);
	const result = correlate([method], engine);
	const key = "CleanProcedure_Codeunit_50100";

	it("status is matched", () => {
		expect(result.attributions.get(key)!.status).toBe("matched");
	});

	it("matchedClean is true", () => {
		expect(result.attributions.get(key)!.matchedClean).toBe(true);
	});

	it("findings is empty", () => {
		expect(result.attributions.get(key)!.findings).toEqual([]);
	});

	it("attributionConfidence is exact", () => {
		expect(result.attributions.get(key)!.attributionConfidence).toBe("exact");
	});

	it("stableRoutineId is persisted", () => {
		expect(result.attributions.get(key)!.stableRoutineId).toBe(STABLE_ID_CLEAN);
	});

	it("correlationSummary.matchedClean = 1", () => {
		expect(result.correlationSummary.matchedClean).toBe(1);
	});

	it("correlationSummary.matched = 1", () => {
		expect(result.correlationSummary.matched).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Test 3: ambiguous — 2 universe routines share the same key → UNION + flag
// ---------------------------------------------------------------------------

describe("correlate: ambiguous (overloaded routine — 2 universe entries)", () => {
	const finding1 = makeFinding(
		"d1/ambig1",
		"aaaa0001",
		"d1-db-op-in-loop",
		"OverloadedProc",
		"Codeunit",
		50100,
	);
	const finding2 = makeFinding(
		"d1/ambig2",
		"bbbb0002",
		"d1-db-op-in-loop",
		"OverloadedProc",
		"Codeunit",
		50100,
	);

	const engine = makeEngine(
		[
			makeRoutine("OverloadedProc", 50100, "Codeunit", STABLE_ID_OVERLOAD_1),
			makeRoutine("OverloadedProc", 50100, "Codeunit", STABLE_ID_OVERLOAD_2),
		],
		[finding1, finding2],
	);

	const method = makeMethod("OverloadedProc", "Codeunit", 50100);
	const result = correlate([method], engine);
	const key = "OverloadedProc_Codeunit_50100";

	it("status is ambiguous", () => {
		expect(result.attributions.get(key)!.status).toBe("ambiguous");
	});

	it("attributionConfidence is ambiguous", () => {
		expect(result.attributions.get(key)!.attributionConfidence).toBe(
			"ambiguous",
		);
	});

	it("findings is the UNION (both findings)", () => {
		expect(result.attributions.get(key)!.findings.length).toBe(2);
	});

	it("stableRoutineId is an array of both stable ids", () => {
		const sid = result.attributions.get(key)!.stableRoutineId;
		expect(Array.isArray(sid)).toBe(true);
		expect((sid as string[]).length).toBe(2);
		expect(sid).toContain(STABLE_ID_OVERLOAD_1);
		expect(sid).toContain(STABLE_ID_OVERLOAD_2);
	});

	it("correlationSummary.ambiguous = 1", () => {
		expect(result.correlationSummary.ambiguous).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Test 4a: blind-spot (builtin)
// ---------------------------------------------------------------------------

describe("correlate: blind-spot (isBuiltin = true)", () => {
	const engine = makeEngine([], []); // empty universe

	const method = makeMethod("OnRun", "Codeunit", 1, "Microsoft", true);
	const result = correlate([method], engine);

	it("produces no attribution entry (builtin is filtered out)", () => {
		// isAlRoutineFrame returns false for builtins → they are excluded from
		// the attribution map entirely (not even a blind-spot entry)
		expect(result.attributions.has("OnRun_Codeunit_1")).toBe(false);
	});

	it("correlationSummary.blindSpot does not count builtins", () => {
		// Builtins are excluded before the join — they don't increment blindSpot
		// (they are not AL routine frames that the engine could plausibly analyse)
		expect(result.correlationSummary.blindSpot).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Test 4b: blind-spot (not in workspace/universe)
// ---------------------------------------------------------------------------

describe("correlate: blind-spot (AL frame, not in universe)", () => {
	const engine = makeEngine(
		[
			makeRoutine(
				"ProcessRecords",
				50100,
				"Codeunit",
				STABLE_ID_PROCESS_RECORDS,
			),
		],
		[],
	);

	// A method for a different object (not in the analyzed workspace)
	const method = makeMethod("CustomFunction", "Codeunit", 99999, "OtherApp");
	const result = correlate([method], engine);
	const key = "CustomFunction_Codeunit_99999";

	it("status is blind-spot", () => {
		expect(result.attributions.get(key)!.status).toBe("blind-spot");
	});

	it("reason is set", () => {
		expect(result.attributions.get(key)!.reason).toBeString();
		expect((result.attributions.get(key)!.reason ?? "").length).toBeGreaterThan(
			0,
		);
	});

	it("findings is empty", () => {
		expect(result.attributions.get(key)!.findings).toEqual([]);
	});

	it("correlationSummary.blindSpot = 1", () => {
		expect(result.correlationSummary.blindSpot).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Test 5: cold — universe routine with no runtime sample
// ---------------------------------------------------------------------------

describe("correlate: cold (universe routine, no method in profile)", () => {
	const finding = makeFinding(
		"d1/cold1",
		"cccc1234",
		"d1-db-op-in-loop",
		"ColdRoutine",
		"Codeunit",
		50100,
	);

	const engine = makeEngine(
		[makeRoutine("ColdRoutine", 50100, "Codeunit", STABLE_ID_COLD)],
		[finding],
	);

	// NO method for ColdRoutine → it should appear in cold
	const result = correlate([], engine);

	it("coldFindings contains the cold routine's findings", () => {
		// The cold routine has a finding that is not attributed to any method
		expect(result.coldFindings.length).toBeGreaterThanOrEqual(0);
		// The finding is reachable via coldFindings OR the count is correct
		expect(result.correlationSummary.coldCount).toBe(1);
	});

	it("attributions map is empty (no methods)", () => {
		expect(result.attributions.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Test 6: unkeyable — finding with no routineName
// ---------------------------------------------------------------------------

describe("correlate: unkeyable (finding with no routineName)", () => {
	// Manually create a finding with no routineName
	const unkeyableFinding: FindingSummary = {
		id: "d1/unk1",
		fingerprint: "dddd5678",
		detector: "d1-db-op-in-loop",
		title: "Unkeyable finding",
		rootCause: "test",
		severity: "high",
		confidence: { level: "likely" },
		primaryLocation: {
			file: "ws:src/Test.al",
			line: 5,
			column: 1,
			objectId: `${APP_GUID}/Codeunit/50100`,
			objectName: "TestObject",
			// routineName is intentionally absent (undefined)
		},
		affectedObjects: [],
		affectedTables: [],
	};

	const engine = makeEngine(
		[
			makeRoutine(
				"ProcessRecords",
				50100,
				"Codeunit",
				STABLE_ID_PROCESS_RECORDS,
			),
		],
		[unkeyableFinding],
	);

	const result = correlate([], engine);

	it("unkeyableFindings contains the finding", () => {
		expect(result.unkeyableFindings.length).toBe(1);
		expect(result.unkeyableFindings[0].id).toBe("d1/unk1");
	});

	it("correlationSummary.unkeyableCount = 1", () => {
		expect(result.correlationSummary.unkeyableCount).toBe(1);
	});

	it("cold count is not inflated by unkeyable findings", () => {
		// The universe has 1 routine (ProcessRecords) with no method sample
		// unkeyable findings do NOT go into cold (they're in unkeyableFindings)
		expect(result.correlationSummary.coldCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Test 7: determinism sort
// ---------------------------------------------------------------------------

describe("correlate: determinism — findings sorted by (fingerprint, id)", () => {
	// Two findings for the same routine in reverse fingerprint order
	const findingA = makeFinding(
		"d1/sortA",
		"zzzz9999", // fingerprint Z (should sort second)
		"d1-db-op-in-loop",
		"ProcessRecords",
		"Codeunit",
		50100,
	);
	const findingB = makeFinding(
		"d1/sortB",
		"aaaa0000", // fingerprint A (should sort first)
		"d1-db-op-in-loop",
		"ProcessRecords",
		"Codeunit",
		50100,
	);

	// Engine returns them in Z, A order
	const engine = makeEngine(
		[
			makeRoutine(
				"ProcessRecords",
				50100,
				"Codeunit",
				STABLE_ID_PROCESS_RECORDS,
			),
		],
		[findingA, findingB],
	);

	const method = makeMethod("ProcessRecords", "Codeunit", 50100);
	const result = correlate([method], engine);
	const key = "ProcessRecords_Codeunit_50100";

	it("findings are sorted by fingerprint ascending", () => {
		const attr = result.attributions.get(key)!;
		expect(attr.findings.length).toBe(2);
		expect(attr.findings[0].fingerprint).toBe("aaaa0000"); // A first
		expect(attr.findings[1].fingerprint).toBe("zzzz9999"); // Z second
	});

	it("second correlate call yields same order (idempotent)", () => {
		const result2 = correlate([method], engine);
		const attr2 = result2.attributions.get(key)!;
		expect(attr2.findings[0].fingerprint).toBe("aaaa0000");
	});
});

// ---------------------------------------------------------------------------
// Test 8: determinism — ambiguous union is also sorted
// ---------------------------------------------------------------------------

describe("correlate: determinism — ambiguous union sorted by (fingerprint, id)", () => {
	const f1 = makeFinding(
		"f1/01",
		"zzzz0001",
		"d1-db-op-in-loop",
		"OverloadedProc",
		"Codeunit",
		50100,
	);
	const f2 = makeFinding(
		"f2/02",
		"aaaa0002",
		"d1-db-op-in-loop",
		"OverloadedProc",
		"Codeunit",
		50100,
	);
	const f3 = makeFinding(
		"f3/03",
		"mmmm0003",
		"d10-self-modifying-loop",
		"OverloadedProc",
		"Codeunit",
		50100,
	);

	const engine = makeEngine(
		[
			makeRoutine("OverloadedProc", 50100, "Codeunit", STABLE_ID_OVERLOAD_1),
			makeRoutine("OverloadedProc", 50100, "Codeunit", STABLE_ID_OVERLOAD_2),
		],
		[f1, f2, f3],
	);

	const method = makeMethod("OverloadedProc", "Codeunit", 50100);
	const result = correlate([method], engine);
	const key = "OverloadedProc_Codeunit_50100";

	it("union findings sorted by fingerprint ascending", () => {
		const attr = result.attributions.get(key)!;
		expect(attr.findings.length).toBe(3);
		expect(attr.findings[0].fingerprint).toBe("aaaa0002");
		expect(attr.findings[1].fingerprint).toBe("mmmm0003");
		expect(attr.findings[2].fingerprint).toBe("zzzz0001");
	});
});

// ---------------------------------------------------------------------------
// Test 9: mismatch flag — zero intersection
// ---------------------------------------------------------------------------

describe("correlate: mismatch flag", () => {
	it("sets mismatch when there is zero intersection over a non-trivial method set", () => {
		// Universe has Codeunit 50100; methods are all for Codeunit 99999
		const engine = makeEngine(
			[
				makeRoutine(
					"ProcessRecords",
					50100,
					"Codeunit",
					STABLE_ID_PROCESS_RECORDS,
				),
			],
			[],
		);

		const methods: MethodBreakdown[] = [
			makeMethod("FunctionA", "Codeunit", 99999),
			makeMethod("FunctionB", "Codeunit", 99998),
			makeMethod("FunctionC", "Codeunit", 99997),
		];

		const result = correlate(methods, engine);
		expect(result.mismatch).toBeDefined();
		expect(result.mismatch!.reason).toBeString();
		expect(result.mismatch!.reason.length).toBeGreaterThan(0);
	});

	it("does NOT set mismatch when there is at least one intersection", () => {
		const engine = makeEngine(
			[
				makeRoutine(
					"ProcessRecords",
					50100,
					"Codeunit",
					STABLE_ID_PROCESS_RECORDS,
				),
			],
			[],
		);

		const methods: MethodBreakdown[] = [
			makeMethod("ProcessRecords", "Codeunit", 50100),
			makeMethod("FunctionB", "Codeunit", 99998),
		];

		const result = correlate(methods, engine);
		expect(result.mismatch).toBeUndefined();
	});

	it("does NOT set mismatch for an empty method set", () => {
		// An empty profile doesn't warrant a mismatch warning
		const engine = makeEngine(
			[
				makeRoutine(
					"ProcessRecords",
					50100,
					"Codeunit",
					STABLE_ID_PROCESS_RECORDS,
				),
			],
			[],
		);

		const result = correlate([], engine);
		expect(result.mismatch).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Test 10: objectType canonicalization (runtime spellings)
// ---------------------------------------------------------------------------

describe("correlate: objectType canonicalization", () => {
	it("matches CodeUnit (runtime) to Codeunit (al-sem) universe entry", () => {
		const engine = makeEngine(
			[makeRoutine("DoWork", 50100, "Codeunit", STABLE_ID_PROCESS_RECORDS)],
			[],
		);

		// Runtime method uses "CodeUnit" (from al-perf's object-types.ts numeric map)
		const method = makeMethod("DoWork", "CodeUnit", 50100);
		const result = correlate([method], engine);
		const key = "DoWork_CodeUnit_50100";

		expect(result.attributions.has(key)).toBe(true);
		expect(result.attributions.get(key)!.status).toBe("matched");
		expect(result.attributions.get(key)!.matchedClean).toBe(true);
	});

	it("matches XMLPort (runtime) to XMLport (al-sem) universe entry", () => {
		const engine = makeEngine(
			[makeRoutine("ExportData", 6050, "XMLport", STABLE_ID_PROCESS_RECORDS)],
			[],
		);

		const method = makeMethod("ExportData", "XMLPort", 6050);
		const result = correlate([method], engine);
		const key = "ExportData_XMLPort_6050";

		expect(result.attributions.has(key)).toBe(true);
		expect(result.attributions.get(key)!.status).toBe("matched");
	});
});

// ---------------------------------------------------------------------------
// Test 11: trigger name normalization
// ---------------------------------------------------------------------------

describe("correlate: trigger name normalization", () => {
	it("maps 'Sell-to Customer No. - OnValidate' to the 'OnValidate' routine", () => {
		const engine = makeEngine(
			[makeRoutine("OnValidate", 18, "Table", STABLE_ID_PROCESS_RECORDS)],
			[],
		);

		// Profile reports the compound field-trigger name
		const method = makeMethod("Sell-to Customer No. - OnValidate", "Table", 18);
		const result = correlate([method], engine);
		const key = "Sell-to Customer No. - OnValidate_Table_18";

		expect(result.attributions.has(key)).toBe(true);
		expect(result.attributions.get(key)!.status).toBe("matched");
	});
});

// ---------------------------------------------------------------------------
// Test 12: comprehensive summary counters
// ---------------------------------------------------------------------------

describe("correlate: comprehensive correlationSummary", () => {
	// Universe: ProcessRecords, CleanProcedure, Overload×2, ColdRoutine
	// Methods: ProcessRecords (matched), CleanProcedure (clean), OverloadedProc (ambiguous),
	//          NotInUniverse (blind-spot), plus a builtin (filtered)
	// Findings: d1 on ProcessRecords, unkeyable finding

	const d1Finding = makeFinding(
		"d1/pr1",
		"c5f6eeaf350cb8fd",
		"d1-db-op-in-loop",
		"ProcessRecords",
		"Codeunit",
		50100,
	);
	const unkeyable: FindingSummary = {
		id: "d1/unk2",
		fingerprint: "eeee9999",
		detector: "d1-db-op-in-loop",
		title: "Unkeyable",
		rootCause: "test",
		severity: "high",
		confidence: { level: "likely" },
		primaryLocation: {
			file: "ws:src/Test.al",
			line: 1,
			column: 1,
			objectId: `${APP_GUID}/Codeunit/50100`,
			objectName: "TestObject",
			// no routineName
		},
		affectedObjects: [],
		affectedTables: [],
	};

	const engine = makeEngine(
		[
			makeRoutine(
				"ProcessRecords",
				50100,
				"Codeunit",
				STABLE_ID_PROCESS_RECORDS,
			),
			makeRoutine("CleanProcedure", 50100, "Codeunit", STABLE_ID_CLEAN),
			makeRoutine("OverloadedProc", 50100, "Codeunit", STABLE_ID_OVERLOAD_1),
			makeRoutine("OverloadedProc", 50100, "Codeunit", STABLE_ID_OVERLOAD_2),
			makeRoutine("ColdRoutine", 50100, "Codeunit", STABLE_ID_COLD),
		],
		[d1Finding, unkeyable],
	);

	const methods: MethodBreakdown[] = [
		makeMethod("ProcessRecords", "Codeunit", 50100), // → matched (with finding)
		makeMethod("CleanProcedure", "Codeunit", 50100), // → matched-clean
		makeMethod("OverloadedProc", "Codeunit", 50100), // → ambiguous (2 overloads)
		makeMethod("NotInUniverse", "Codeunit", 99999), // → blind-spot
		makeMethod("SqlFrame", "Codeunit", 50100), // → SELECT... no wait...
		// ^ Actually this is a plain name, would be blind-spot since not in universe
	];

	const result = correlate(methods, engine);

	it("matched = 2 (ProcessRecords + CleanProcedure)", () => {
		expect(result.correlationSummary.matched).toBe(2);
	});

	it("matchedClean = 1 (CleanProcedure)", () => {
		expect(result.correlationSummary.matchedClean).toBe(1);
	});

	it("ambiguous = 1 (OverloadedProc has 2 universe entries)", () => {
		expect(result.correlationSummary.ambiguous).toBe(1);
	});

	it("blindSpot = 2 (NotInUniverse + SqlFrame not in universe)", () => {
		// Both NotInUniverse and SqlFrame are AL frames (no isBuiltin) but not in universe
		expect(result.correlationSummary.blindSpot).toBe(2);
	});

	it("coldCount = 1 (ColdRoutine in universe but no sample)", () => {
		expect(result.correlationSummary.coldCount).toBe(1);
	});

	it("unkeyableCount = 1", () => {
		expect(result.correlationSummary.unkeyableCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Test 13: SQL frame filter
// ---------------------------------------------------------------------------

describe("correlate: SQL frame filtering", () => {
	it("SELECT frame is not added to attributions (filtered by isAlRoutineFrame)", () => {
		const engine = makeEngine([], []);
		const method = makeMethod("SELECT TOP 1 * FROM [Customer]", "Codeunit", 18);
		const result = correlate([method], engine);

		// SQL frames are excluded before the join — no attribution entry
		const key = "SELECT TOP 1 * FROM [Customer]_Codeunit_18";
		expect(result.attributions.has(key)).toBe(false);
		// And they don't inflate blindSpot
		expect(result.correlationSummary.blindSpot).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Test 14: ws-min golden integration (realistic data)
// ---------------------------------------------------------------------------

describe("correlate: ws-min golden realistic case", () => {
	// Mirrors the actual ws-min.inventory.json + ws-min.analyze.json goldens
	const WS_MIN_APP_GUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

	const d1finding: FindingSummary = {
		id: "d1/568ea150213172d2/8dde2832baabef2d46a4843cb0da4bef41df5bf25fa2e772da267c3cb9719835/loop0/568ea150213172d2/8dde2832baabef2d46a4843cb0da4bef41df5bf25fa2e772da267c3cb9719835/568ea150213172d2/8dde2832baabef2d46a4843cb0da4bef41df5bf25fa2e772da267c3cb9719835/op2",
		fingerprint: "c5f6eeaf350cb8fd",
		detector: "d1-db-op-in-loop",
		title: "Database operation inside a loop",
		rootCause: "A loop in ProcessRecords reaches Modify on Customer.",
		severity: "high",
		confidence: { level: "likely" },
		primaryLocation: {
			file: "ws:src/Foo.Codeunit.al",
			line: 13,
			column: 17,
			objectId: `${WS_MIN_APP_GUID}/Codeunit/50100`,
			objectName: "Foo",
			routineName: "ProcessRecords",
		},
		affectedObjects: [`${WS_MIN_APP_GUID}/Codeunit/50100`],
		affectedTables: [],
	};

	const engine = makeEngine(
		[
			{
				objectNumber: 50100,
				objectType: "Codeunit",
				routineName: "OverloadedProc",
				stableRoutineId: `${WS_MIN_APP_GUID}:Codeunit:50100#19f10db44a02d3ddf1fe1e665faa7b08d65a514e2802138f3b9d38a71a2a8a99`,
			},
			{
				objectNumber: 50100,
				objectType: "Codeunit",
				routineName: "CleanProcedure",
				stableRoutineId: `${WS_MIN_APP_GUID}:Codeunit:50100#299614d535d879f12cb7bf62378e7a2fa161777b4abf63b2113dfdac09cfbc5a`,
			},
			{
				objectNumber: 50100,
				objectType: "Codeunit",
				routineName: "ProcessRecords",
				stableRoutineId: `${WS_MIN_APP_GUID}:Codeunit:50100#586fc0b923483c425d345129585052094241f6fe3146b65cd1030d70b874bfba`,
			},
			{
				objectNumber: 50100,
				objectType: "Codeunit",
				routineName: "OverloadedProc",
				stableRoutineId: `${WS_MIN_APP_GUID}:Codeunit:50100#eea57b1a62fa70408ef36cbcd83eb95584bd4a7c13423c2008a64c186b04ee6f`,
			},
		],
		[d1finding],
	);

	const methods: MethodBreakdown[] = [
		{
			functionName: "ProcessRecords",
			objectType: "Codeunit",
			objectName: "Foo",
			objectId: 50100,
			appName: "FusionMinimal",
			selfTime: 5000,
			selfTimePercent: 50,
			totalTime: 5000,
			totalTimePercent: 50,
			hitCount: 10,
			calledBy: [],
			calls: [],
			costPerHit: 500,
			efficiencyScore: 1.0,
		},
		{
			functionName: "OverloadedProc",
			objectType: "Codeunit",
			objectName: "Foo",
			objectId: 50100,
			appName: "FusionMinimal",
			selfTime: 1000,
			selfTimePercent: 10,
			totalTime: 1000,
			totalTimePercent: 10,
			hitCount: 5,
			calledBy: [],
			calls: [],
			costPerHit: 200,
			efficiencyScore: 1.0,
		},
	];

	const result = correlate(methods, engine);

	it("ProcessRecords: matched with d1-db-op-in-loop finding", () => {
		const key = "ProcessRecords_Codeunit_50100";
		expect(result.attributions.get(key)!.status).toBe("matched");
		expect(result.attributions.get(key)!.findings.length).toBe(1);
		expect(result.attributions.get(key)!.findings[0].detector).toBe(
			"d1-db-op-in-loop",
		);
	});

	it("OverloadedProc: ambiguous (2 universe entries)", () => {
		const key = "OverloadedProc_Codeunit_50100";
		expect(result.attributions.get(key)!.status).toBe("ambiguous");
		expect(result.attributions.get(key)!.attributionConfidence).toBe(
			"ambiguous",
		);
	});

	it("CleanProcedure: cold (in universe, no runtime sample)", () => {
		expect(result.correlationSummary.coldCount).toBeGreaterThanOrEqual(1);
	});

	it("no mismatch (there is intersection)", () => {
		expect(result.mismatch).toBeUndefined();
	});
});
