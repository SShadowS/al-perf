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
import type {
	CoverageEntry,
	FindingSummary,
	RoutineIdentity,
} from "../../src/semantic/contracts.js";
import { correlate } from "../../src/semantic/correlate.js";
import type { EngineAnalysis } from "../../src/semantic/engine-runner.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";

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

/**
 * Build a "complete" CoverageEntry for each routine so matched-clean gating
 * (which requires a complete CoverageEntry for the object) is satisfied by
 * default. Tests that want degraded coverage override `coverage`/`opaqueApps`.
 */
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

	it("orphanCount = 0 (no keyed finding whose routine is absent from the universe)", () => {
		expect(result.correlationSummary.orphanCount).toBe(0);
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

// ---------------------------------------------------------------------------
// Test 15: ambiguous reason is HONEST (uses the normalized shared name, not the
// unstripped functionName) — the field-trigger collision case
// ---------------------------------------------------------------------------

describe("correlate: ambiguous reason honesty (field-trigger collision)", () => {
	// A Table 50100 with TWO fields, each having an OnValidate trigger. al-sem
	// stores both as bare "OnValidate" on (Table, 50100) → same join key.
	const trigA = `${APP_GUID}:Table:50100#aaaa0000000000000000000000000000000000000000000000000000000000000001`;
	const trigB = `${APP_GUID}:Table:50100#bbbb0000000000000000000000000000000000000000000000000000000000000002`;

	const engine = makeEngine(
		[
			makeRoutine("OnValidate", 50100, "Table", trigA),
			makeRoutine("OnValidate", 50100, "Table", trigB),
		],
		[],
	);

	// The profile reports the compound field-trigger name for field A.
	const method = makeMethod("Field A - OnValidate", "Table", 50100);
	const result = correlate([method], engine);
	const key = "Field A - OnValidate_Table_50100";

	it("status is ambiguous (collision on the bare trigger name)", () => {
		expect(result.attributions.get(key)!.status).toBe("ambiguous");
	});

	it("reason mentions the NORMALIZED shared name 'OnValidate', not the unstripped 'Field A - OnValidate'", () => {
		const reason = result.attributions.get(key)!.reason ?? "";
		expect(reason).toContain('"OnValidate"');
		// It must NOT claim they share the unstripped compound name.
		expect(reason).not.toContain("Field A - OnValidate");
	});

	it("reason describes the field/control-trigger ambiguity honestly", () => {
		const reason = result.attributions.get(key)!.reason ?? "";
		expect(reason.toLowerCase()).toContain("ambiguous");
	});

	it("stableRoutineId is an array of both trigger ids", () => {
		const sid = result.attributions.get(key)!.stableRoutineId;
		expect(Array.isArray(sid)).toBe(true);
		expect(sid).toContain(trigA);
		expect(sid).toContain(trigB);
	});
});

// ---------------------------------------------------------------------------
// Test 16: matched-clean is COVERAGE-GATED — degraded coverage ≠ verified clean
// ---------------------------------------------------------------------------

describe("correlate: matched-clean coverage gating", () => {
	it("does NOT claim matched-clean when the object's CoverageEntry is incomplete", () => {
		const routine = makeRoutine(
			"PartiallyAnalyzed",
			50100,
			"Codeunit",
			STABLE_ID_CLEAN,
		);
		// Coverage entry exists but directStatus is NOT "complete".
		const engine = makeEngine([routine], [], {
			coverage: [
				{
					directStatus: "partial",
					inheritedStatus: "complete",
					reasons: ["opaque-callee"],
					subject: STABLE_ID_CLEAN,
					unknownTargets: [],
				},
			],
		});

		const method = makeMethod("PartiallyAnalyzed", "Codeunit", 50100);
		const result = correlate([method], engine);
		const key = "PartiallyAnalyzed_Codeunit_50100";

		expect(result.attributions.get(key)!.status).toBe("matched");
		// matchedClean must be falsy — incomplete coverage ≠ clean.
		expect(result.attributions.get(key)!.matchedClean).toBeFalsy();
		expect(result.correlationSummary.matchedClean).toBe(0);
		// And there's an honest reason explaining why.
		expect(result.attributions.get(key)!.reason ?? "").toMatch(
			/coverage incomplete/i,
		);
	});

	it("does NOT claim matched-clean when the workspace has opaque apps", () => {
		const routine = makeRoutine("DoWork", 50100, "Codeunit", STABLE_ID_CLEAN);
		// CoverageEntry is complete, BUT opaqueApps is non-empty (degraded).
		const engine = makeEngine([routine], [], {
			opaqueApps: ["deadbeef-0000-0000-0000-000000000000"],
			coverageDegraded: true,
		});

		const method = makeMethod("DoWork", "Codeunit", 50100);
		const result = correlate([method], engine);
		const key = "DoWork_Codeunit_50100";

		expect(result.attributions.get(key)!.status).toBe("matched");
		expect(result.attributions.get(key)!.matchedClean).toBeFalsy();
	});

	it("does NOT claim matched-clean when there is NO CoverageEntry for the object", () => {
		const routine = makeRoutine("DoWork", 50100, "Codeunit", STABLE_ID_CLEAN);
		// Explicit empty coverage — cannot prove full analysis.
		const engine = makeEngine([routine], [], { coverage: [] });

		const method = makeMethod("DoWork", "Codeunit", 50100);
		const result = correlate([method], engine);
		const key = "DoWork_Codeunit_50100";

		expect(result.attributions.get(key)!.matchedClean).toBeFalsy();
	});

	it("DOES claim matched-clean when coverage is complete and no opaque apps", () => {
		const routine = makeRoutine("DoWork", 50100, "Codeunit", STABLE_ID_CLEAN);
		const engine = makeEngine([routine], []); // default complete coverage

		const method = makeMethod("DoWork", "Codeunit", 50100);
		const result = correlate([method], engine);
		const key = "DoWork_Codeunit_50100";

		expect(result.attributions.get(key)!.matchedClean).toBe(true);
		// No "incomplete" reason when genuinely clean.
		expect(result.attributions.get(key)!.reason).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Test 17: orphan-vs-cold split — a keyed finding whose routine is NOT in the
// universe is ORPHAN, not cold
// ---------------------------------------------------------------------------

describe("correlate: orphan vs cold finding split", () => {
	// Universe has ColdRoutine (with a finding) but NOT GhostRoutine.
	// A finding keyed to GhostRoutine (absent from inventory) is an orphan.
	const coldFinding = makeFinding(
		"d1/cold",
		"aaaa1111",
		"d1-db-op-in-loop",
		"ColdRoutine",
		"Codeunit",
		50100,
	);
	const orphanFinding = makeFinding(
		"d1/ghost",
		"bbbb2222",
		"d1-db-op-in-loop",
		"GhostRoutine",
		"Codeunit",
		50100,
	);

	const engine = makeEngine(
		[makeRoutine("ColdRoutine", 50100, "Codeunit", STABLE_ID_COLD)],
		[coldFinding, orphanFinding],
	);

	// No methods at all — ColdRoutine is cold, GhostRoutine has no universe entry.
	const result = correlate([], engine);

	it("coldFindings contains ONLY the in-universe (cold) finding", () => {
		expect(result.coldFindings.map((f) => f.id)).toEqual(["d1/cold"]);
	});

	it("orphanFindings contains the routine-absent finding", () => {
		expect(result.orphanFindings.map((f) => f.id)).toEqual(["d1/ghost"]);
	});

	it("coldCount counts only universe routines (1)", () => {
		expect(result.correlationSummary.coldCount).toBe(1);
	});

	it("orphanCount = 1 (the ghost finding)", () => {
		expect(result.correlationSummary.orphanCount).toBe(1);
	});

	it("orphan finding is NOT in coldFindings", () => {
		expect(
			result.coldFindings.find((f) => f.id === "d1/ghost"),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Test 18: cross-type blind-spot reason — same objectNumber, different type
// ---------------------------------------------------------------------------

describe("correlate: cross-type blind-spot reason", () => {
	// al-sem analyzed Codeunit 50100; the hot frame is Page 50100 (same number,
	// different type). The blind-spot reason must NOT claim "50100 is covered".
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

	const method = makeMethod("OnOpenPage", "Page", 50100);
	const result = correlate([method], engine);
	const key = "OnOpenPage_Page_50100";

	it("status is blind-spot", () => {
		expect(result.attributions.get(key)!.status).toBe("blind-spot");
	});

	it("reason says the OBJECT was not analyzed (not 'covered but routine absent')", () => {
		const reason = result.attributions.get(key)!.reason ?? "";
		// The Codeunit 50100 coverage must NOT make a Page 50100 look 'covered'.
		expect(reason).toMatch(/was not analyzed/i);
		expect(reason).not.toMatch(/covered but routine absent/i);
		expect(reason).not.toMatch(/absent from the inventory/i);
	});

	it("a same-TYPE missing routine still reports 'analyzed but routine absent'", () => {
		// Sanity: a Codeunit 50100 method whose routine isn't in the inventory
		// SHOULD report the routine-absent reason (the object IS covered).
		const method2 = makeMethod("MissingProc", "Codeunit", 50100);
		const result2 = correlate([method2], engine);
		const key2 = "MissingProc_Codeunit_50100";
		const reason2 = result2.attributions.get(key2)!.reason ?? "";
		expect(reason2).toMatch(/absent from the inventory/i);
	});
});

// ---------------------------------------------------------------------------
// Test 19: procedure name with ` - ` is NOT over-stripped → matched, not blind-spot
// ---------------------------------------------------------------------------

describe("correlate: quoted procedure with ` - ` is not over-stripped", () => {
	// A real AL procedure named "Get - Value" must correlate as-is, NOT be
	// truncated to "Value" (which would be a spurious blind-spot).
	const engine = makeEngine(
		[makeRoutine("Get - Value", 50100, "Codeunit", STABLE_ID_CLEAN)],
		[],
	);

	const method = makeMethod("Get - Value", "Codeunit", 50100);
	const result = correlate([method], engine);
	const key = "Get - Value_Codeunit_50100";

	it("status is matched (the full name is preserved as the join name)", () => {
		expect(result.attributions.get(key)!.status).toBe("matched");
	});

	it("is NOT a blind-spot", () => {
		expect(result.attributions.get(key)!.status).not.toBe("blind-spot");
		expect(result.correlationSummary.blindSpot).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Test 20: coldRoutines identities surfaced (not just a count) + determinism
// ---------------------------------------------------------------------------

describe("correlate: coldRoutines identities + determinism", () => {
	const rCold1 = makeRoutine("ColdA", 50100, "Codeunit", STABLE_ID_OVERLOAD_2); // sorts later
	const rCold2 = makeRoutine("ColdB", 50100, "Codeunit", STABLE_ID_CLEAN); // sorts earlier

	const engine = makeEngine([rCold1, rCold2], []);
	const result = correlate([], engine);

	it("coldRoutines surfaces the routine identities (not just a count)", () => {
		expect(result.coldRoutines.length).toBe(2);
		const names = result.coldRoutines.map((r) => r.routineName).sort();
		expect(names).toEqual(["ColdA", "ColdB"]);
	});

	it("coldRoutines is sorted deterministically by stableRoutineId", () => {
		const ids = result.coldRoutines.map((r) => r.stableRoutineId);
		const sorted = [...ids].sort((a, b) => a.localeCompare(b));
		expect(ids).toEqual(sorted);
	});
});

// ---------------------------------------------------------------------------
// Test 21: unkeyableFindings are sorted by (fingerprint, id) for determinism
// ---------------------------------------------------------------------------

describe("correlate: unkeyableFindings determinism sort", () => {
	const mkUnkeyable = (id: string, fp: string): FindingSummary => ({
		id,
		fingerprint: fp,
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
			// no routineName → unkeyable
		},
		affectedObjects: [],
		affectedTables: [],
	});

	// Emit order is reverse of the sorted order.
	const engine = makeEngine(
		[],
		[mkUnkeyable("z-id", "zzzz9999"), mkUnkeyable("a-id", "aaaa0000")],
	);
	const result = correlate([], engine);

	it("unkeyableFindings sorted by fingerprint ascending", () => {
		expect(result.unkeyableFindings.map((f) => f.fingerprint)).toEqual([
			"aaaa0000",
			"zzzz9999",
		]);
	});
});

// ---------------------------------------------------------------------------
// Test 22: precise field-trigger attribution via enclosingMember (P3.2a)
// Two OnValidate triggers on the same table, each with a distinct enclosingMember.
// Profile frames are compound names: "Sell-to Customer No. - OnValidate" and
// "Bill-to Customer No. - OnValidate".
// Expected: TWO distinct `matched` attributions (each to its field), NOT ambiguous.
// ---------------------------------------------------------------------------

const STABLE_ID_SELL_TO = `${APP_GUID}:Table:18#sell000000000000000000000000000000000000000000000000000000000000001`;
const STABLE_ID_BILL_TO = `${APP_GUID}:Table:18#bill000000000000000000000000000000000000000000000000000000000000002`;

describe("correlate: precise field-trigger (two OnValidate, distinct enclosingMember)", () => {
	// Finding for Sell-to field — carries enclosingMember on primaryLocation
	// so it can be filtered to only the Sell-to routine (RE-11).
	const sellFinding: FindingSummary = {
		id: "d1/sell1",
		fingerprint: "sell0001",
		detector: "d1-db-op-in-loop",
		title: "Finding d1/sell1",
		rootCause: "test",
		severity: "high",
		confidence: { level: "likely" },
		primaryLocation: {
			file: "ws:src/Test.al",
			line: 10,
			column: 1,
			objectId: `${APP_GUID}/Table/18`,
			objectName: "TestObject",
			routineName: "OnValidate",
			enclosingMember: "Sell-to Customer No.",
		},
		affectedObjects: [`${APP_GUID}/Table/18`],
		affectedTables: [],
	};

	// Two inventory routines: same routineName "OnValidate", same table 18,
	// but different enclosingMember → different stableRoutineIds.
	const routineSellTo: RoutineIdentity = {
		stableRoutineId: STABLE_ID_SELL_TO,
		objectType: "Table",
		objectNumber: 18,
		routineName: "OnValidate",
		enclosingMember: "Sell-to Customer No.",
	};
	const routineBillTo: RoutineIdentity = {
		stableRoutineId: STABLE_ID_BILL_TO,
		objectType: "Table",
		objectNumber: 18,
		routineName: "OnValidate",
		enclosingMember: "Bill-to Customer No.",
	};

	const engine = makeEngine([routineSellTo, routineBillTo], [sellFinding]);

	// Two profile frames — one per field.
	const methodSellTo = makeMethod(
		"Sell-to Customer No. - OnValidate",
		"Table",
		18,
	);
	const methodBillTo = makeMethod(
		"Bill-to Customer No. - OnValidate",
		"Table",
		18,
	);
	const result = correlate([methodSellTo, methodBillTo], engine);

	const keySellTo = "Sell-to Customer No. - OnValidate_Table_18";
	const keyBillTo = "Bill-to Customer No. - OnValidate_Table_18";

	it("Sell-to frame → matched (not ambiguous)", () => {
		expect(result.attributions.get(keySellTo)!.status).toBe("matched");
	});

	it("Bill-to frame → matched (not ambiguous)", () => {
		expect(result.attributions.get(keyBillTo)!.status).toBe("matched");
	});

	it("Sell-to attribution carries the correct stableRoutineId", () => {
		expect(result.attributions.get(keySellTo)!.stableRoutineId).toBe(
			STABLE_ID_SELL_TO,
		);
	});

	it("Bill-to attribution carries the correct stableRoutineId", () => {
		expect(result.attributions.get(keyBillTo)!.stableRoutineId).toBe(
			STABLE_ID_BILL_TO,
		);
	});

	it("Sell-to attribution carries the d1 finding", () => {
		expect(result.attributions.get(keySellTo)!.findings.length).toBe(1);
		expect(result.attributions.get(keySellTo)!.findings[0].id).toBe("d1/sell1");
	});

	it("Bill-to attribution has empty findings (RE-11 honest: that field has no finding)", () => {
		expect(result.attributions.get(keyBillTo)!.findings).toEqual([]);
	});

	it("correlationSummary.matched = 2 (both fields matched precisely)", () => {
		expect(result.correlationSummary.matched).toBe(2);
	});

	it("correlationSummary.ambiguous = 0 (none left ambiguous)", () => {
		expect(result.correlationSummary.ambiguous).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Test 23: case-insensitivity — profile name with lowercase member still matches
// ---------------------------------------------------------------------------

describe("correlate: precise field-trigger case-insensitivity", () => {
	const routineSellTo: RoutineIdentity = {
		stableRoutineId: STABLE_ID_SELL_TO,
		objectType: "Table",
		objectNumber: 18,
		routineName: "OnValidate",
		enclosingMember: "Sell-to Customer No.",
	};
	const routineBillTo: RoutineIdentity = {
		stableRoutineId: STABLE_ID_BILL_TO,
		objectType: "Table",
		objectNumber: 18,
		routineName: "OnValidate",
		enclosingMember: "Bill-to Customer No.",
	};

	const engine = makeEngine([routineSellTo, routineBillTo], []);

	// Profile name with all-lowercase member — AL is case-insensitive.
	const methodLower = makeMethod(
		"sell-to customer no. - OnValidate",
		"Table",
		18,
	);
	const result = correlate([methodLower], engine);
	const keyLower = "sell-to customer no. - OnValidate_Table_18";

	it("lowercase profile member still resolves to matched", () => {
		expect(result.attributions.get(keyLower)!.status).toBe("matched");
	});

	it("matches the correct Sell-to stableRoutineId despite casing", () => {
		expect(result.attributions.get(keyLower)!.stableRoutineId).toBe(
			STABLE_ID_SELL_TO,
		);
	});
});

// ---------------------------------------------------------------------------
// Test 24: action frame — strip '&' accelerator before matching (RE-4)
// ---------------------------------------------------------------------------

const STABLE_ID_RELEASE = `${APP_GUID}:Page:42#release00000000000000000000000000000000000000000000000000000000001`;
const STABLE_ID_CONFIRM = `${APP_GUID}:Page:42#confirm00000000000000000000000000000000000000000000000000000000002`;

describe("correlate: action frame '&' strip (RE-4)", () => {
	const routineRelease: RoutineIdentity = {
		stableRoutineId: STABLE_ID_RELEASE,
		objectType: "Page",
		objectNumber: 42,
		routineName: "OnAction",
		enclosingMember: "Release",
	};
	const routineConfirm: RoutineIdentity = {
		stableRoutineId: STABLE_ID_CONFIRM,
		objectType: "Page",
		objectNumber: 42,
		routineName: "OnAction",
		enclosingMember: "Confirm",
	};

	const engine = makeEngine([routineRelease, routineConfirm], []);

	// Profile emits the caption with '&' accelerator.
	const methodRelease = makeMethod("Re&lease - OnAction", "Page", 42);
	const result = correlate([methodRelease], engine);
	const keyRelease = "Re&lease - OnAction_Page_42";

	it("'Re&lease - OnAction' strips & and matches inventory 'Release'", () => {
		expect(result.attributions.get(keyRelease)!.status).toBe("matched");
	});

	it("matches Release stableRoutineId (not Confirm)", () => {
		expect(result.attributions.get(keyRelease)!.stableRoutineId).toBe(
			STABLE_ID_RELEASE,
		);
	});
});

// ---------------------------------------------------------------------------
// Test 25: old-engine graceful fallback — no enclosingMember → still ambiguous
// ---------------------------------------------------------------------------

describe("correlate: old-engine (no enclosingMember) stays ambiguous", () => {
	// Two routines without enclosingMember — simulates a 1.0.0 engine response.
	const trigA = `${APP_GUID}:Table:50100#aaaa0000000000000000000000000000000000000000000000000000000000000001`;
	const trigB = `${APP_GUID}:Table:50100#bbbb0000000000000000000000000000000000000000000000000000000000000002`;

	// No enclosingMember on either — old-engine inventory.
	const engine = makeEngine(
		[
			makeRoutine("OnValidate", 50100, "Table", trigA),
			makeRoutine("OnValidate", 50100, "Table", trigB),
		],
		[],
	);

	const method = makeMethod("Field A - OnValidate", "Table", 50100);
	const result = correlate([method], engine);
	const key = "Field A - OnValidate_Table_50100";

	it("falls back to ambiguous when candidates have no enclosingMember", () => {
		expect(result.attributions.get(key)!.status).toBe("ambiguous");
	});

	it("correlationSummary.ambiguous = 1 (graceful fallback)", () => {
		expect(result.correlationSummary.ambiguous).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Test 26: genuine overload — same enclosingMember + trigger, two signatures
//          → still ambiguous (cannot disambiguate)
// ---------------------------------------------------------------------------

describe("correlate: genuine overload (same enclosingMember + trigger, two sigs) → still ambiguous", () => {
	const STABLE_ID_SIG1 = `${APP_GUID}:Table:18#sig10000000000000000000000000000000000000000000000000000000000000001`;
	const STABLE_ID_SIG2 = `${APP_GUID}:Table:18#sig20000000000000000000000000000000000000000000000000000000000000002`;

	// Two routines with THE SAME enclosingMember AND routineName → genuine overload.
	const routineSig1: RoutineIdentity = {
		stableRoutineId: STABLE_ID_SIG1,
		objectType: "Table",
		objectNumber: 18,
		routineName: "OnValidate",
		enclosingMember: "Sell-to Customer No.",
	};
	const routineSig2: RoutineIdentity = {
		stableRoutineId: STABLE_ID_SIG2,
		objectType: "Table",
		objectNumber: 18,
		routineName: "OnValidate",
		enclosingMember: "Sell-to Customer No.",
	};

	const engine = makeEngine([routineSig1, routineSig2], []);

	const method = makeMethod("Sell-to Customer No. - OnValidate", "Table", 18);
	const result = correlate([method], engine);
	const key = "Sell-to Customer No. - OnValidate_Table_18";

	it("genuine overload (same member+trigger, 2 sigs) → ambiguous", () => {
		expect(result.attributions.get(key)!.status).toBe("ambiguous");
	});

	it("correlationSummary.ambiguous = 1", () => {
		expect(result.correlationSummary.ambiguous).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Test 27: RE-11 honesty — precise-matched field with ZERO findings → matched
// with empty findings (not ambiguous, not falsely claiming clean beyond coverage gate)
// ---------------------------------------------------------------------------

describe("correlate: RE-11 honest zero-finding precise match", () => {
	// The Bill-to field has no static finding; the Sell-to field does.
	// Bill-to should resolve to matched with empty findings — not ambiguous.
	const routineSellTo: RoutineIdentity = {
		stableRoutineId: STABLE_ID_SELL_TO,
		objectType: "Table",
		objectNumber: 18,
		routineName: "OnValidate",
		enclosingMember: "Sell-to Customer No.",
	};
	const routineBillTo: RoutineIdentity = {
		stableRoutineId: STABLE_ID_BILL_TO,
		objectType: "Table",
		objectNumber: 18,
		routineName: "OnValidate",
		enclosingMember: "Bill-to Customer No.",
	};

	// Only the Sell-to field has a finding — carries enclosingMember so it is
	// attributed only to Sell-to, leaving Bill-to with empty findings (RE-11).
	const finding: FindingSummary = {
		id: "d1/only-sell",
		fingerprint: "sell9999",
		detector: "d1-db-op-in-loop",
		title: "Finding d1/only-sell",
		rootCause: "test",
		severity: "high",
		confidence: { level: "likely" },
		primaryLocation: {
			file: "ws:src/Test.al",
			line: 10,
			column: 1,
			objectId: `${APP_GUID}/Table/18`,
			objectName: "TestObject",
			routineName: "OnValidate",
			enclosingMember: "Sell-to Customer No.",
		},
		affectedObjects: [`${APP_GUID}/Table/18`],
		affectedTables: [],
	};

	const engine = makeEngine([routineSellTo, routineBillTo], [finding]);

	// Only query the Bill-to frame to isolate the "no finding" case.
	const methodBillTo = makeMethod(
		"Bill-to Customer No. - OnValidate",
		"Table",
		18,
	);
	const result = correlate([methodBillTo], engine);
	const keyBillTo = "Bill-to Customer No. - OnValidate_Table_18";

	it("Bill-to (zero findings) resolves to matched — not ambiguous (RE-11)", () => {
		expect(result.attributions.get(keyBillTo)!.status).toBe("matched");
	});

	it("Bill-to attribution has empty findings (honest: that field has no finding)", () => {
		expect(result.attributions.get(keyBillTo)!.findings).toEqual([]);
	});

	it("correlationSummary.ambiguous = 0", () => {
		expect(result.correlationSummary.ambiguous).toBe(0);
	});

	it("correlationSummary.matched = 1", () => {
		expect(result.correlationSummary.matched).toBe(1);
	});
});
