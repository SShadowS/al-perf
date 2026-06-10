/**
 * regression-correlate.test.ts — Tests for classifyDelta + correlateRegressions.
 *
 * Coverage (per plan Task 2, Step 6):
 *  - classifyDelta drift-guard: full PR2-2 matrix pinned.
 *  - total-time regression + capability-gained-write → correlated (basis: total).
 *  - capability-gained-telemetry only → weakly-correlated.
 *  - regression with no matching delta → unexplained-static.
 *  - {total} delta, but regression is self-only (deltaTotalTime=0) → NOT annotated → unexplained.
 *  - event-publish delta → staticOnlyChanges (cross-boundary, not local annotation).
 *  - new hot method + procedure-added → newMethodCorrelations.
 *  - overload / field-trigger key collision → union with ambiguous marker.
 *  - version mismatch → versionMismatch set in correlationSummary.
 *  - determinism: same output for two identical calls.
 *
 * Also covers diff-runner with stub:
 *  - ALSEM_STUB_MODE=diff → DiffAnalysis with expected findings + inventory.
 *  - binary-absent → { disabled }.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { MethodDelta } from "../../src/output/types.js";
import type { RoutineIdentity } from "../../src/semantic/contracts.js";
import type {
	DiffAnalysis,
	DiffDelta,
} from "../../src/semantic/diff-runner.js";
import { runEngineDiff } from "../../src/semantic/diff-runner.js";
import {
	classifyDelta,
	correlateRegressions,
} from "../../src/semantic/regression-correlate.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import {
	DIFF_CU_NEW_STABLE,
	DIFF_CU_STABLE,
} from "../../test/fixtures/fusion/alsem-stub.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_GUID = "00000000-1111-2222-3333-000000000001";

/** Build a minimal MethodDelta for a regression. */
function makeMethodDelta(
	functionName: string,
	objectType: string,
	objectId: number,
	deltaSelfTime: number,
	deltaTotalTime: number,
): MethodDelta {
	return {
		functionName,
		objectType,
		objectName: "TestObject",
		objectId,
		appName: "TestApp",
		beforeSelfTime: 1000,
		afterSelfTime: 1000 + deltaSelfTime,
		deltaSelfTime,
		deltaPercent: deltaSelfTime > 0 ? (deltaSelfTime / 1000) * 100 : 0,
		beforeTotalTime: 2000,
		afterTotalTime: 2000 + deltaTotalTime,
		deltaTotalTime,
		deltaTotalPercent: deltaTotalTime > 0 ? (deltaTotalTime / 2000) * 100 : 0,
		beforeHitCount: 10,
		afterHitCount: 10,
	};
}

/** Build a minimal MethodBreakdown. */
function makeMethodBreakdown(
	functionName: string,
	objectType: string,
	objectId: number,
): MethodBreakdown {
	return {
		functionName,
		objectType,
		objectName: "TestObject",
		objectId,
		appName: "TestApp",
		selfTime: 500,
		selfTimePercent: 10,
		totalTime: 1000,
		totalTimePercent: 20,
		hitCount: 5,
		calledBy: [],
		calls: [],
		costPerHit: 100,
		efficiencyScore: 0.5,
	};
}

/** Build a RoutineIdentity. */
function makeRoutine(
	routineName: string,
	objectNumber: number,
	objectType: string,
	stableRoutineId: string,
): RoutineIdentity {
	return { stableRoutineId, objectType, objectNumber, routineName };
}

/** Build a DiffDelta. */
function makeDelta(
	id: string,
	category: string,
	kind: string,
	normalizedStableId: string,
	opts: Partial<DiffDelta> = {},
): DiffDelta {
	return {
		id,
		category,
		kind,
		severity: "medium",
		normalizedStableId,
		newStableId: normalizedStableId,
		displayName: "TestRoutine",
		...opts,
	};
}

// ---------------------------------------------------------------------------
// classifyDelta drift-guard
// ---------------------------------------------------------------------------

describe("classifyDelta drift-guard (PR2-2 matrix)", () => {
	test("capability-gained-commit → total / strong", () => {
		expect(classifyDelta("capabilities", "capability-gained-commit")).toEqual({
			basis: "total",
			strength: "strong",
		});
	});
	test("capability-gained-write → total / strong", () => {
		expect(classifyDelta("capabilities", "capability-gained-write")).toEqual({
			basis: "total",
			strength: "strong",
		});
	});
	test("capability-gained-read → total / strong", () => {
		expect(classifyDelta("capabilities", "capability-gained-read")).toEqual({
			basis: "total",
			strength: "strong",
		});
	});
	test("capability-gained-http → total / moderate", () => {
		expect(classifyDelta("capabilities", "capability-gained-http")).toEqual({
			basis: "total",
			strength: "moderate",
		});
	});
	test("capability-gained-file → total / moderate", () => {
		expect(classifyDelta("capabilities", "capability-gained-file")).toEqual({
			basis: "total",
			strength: "moderate",
		});
	});
	test("procedure-signature-changed → self / moderate", () => {
		expect(classifyDelta("abi", "procedure-signature-changed")).toEqual({
			basis: "self",
			strength: "moderate",
		});
	});
	test("capability-gained-dynamic-dispatch → self / moderate", () => {
		expect(
			classifyDelta("capabilities", "capability-gained-dynamic-dispatch"),
		).toEqual({ basis: "self", strength: "moderate" });
	});
	test("procedure-added → self / strong", () => {
		expect(classifyDelta("abi", "procedure-added")).toEqual({
			basis: "self",
			strength: "strong",
		});
	});
	test("capability-gained-telemetry → self / weak", () => {
		expect(
			classifyDelta("capabilities", "capability-gained-telemetry"),
		).toEqual({ basis: "self", strength: "weak" });
	});
	test("capability-gained-isolated-storage → self / weak", () => {
		expect(
			classifyDelta("capabilities", "capability-gained-isolated-storage"),
		).toEqual({ basis: "self", strength: "weak" });
	});
	test("capability-gained-event-publish → none / weak (cross-boundary PR2-7)", () => {
		expect(
			classifyDelta("capabilities", "capability-gained-event-publish"),
		).toEqual({ basis: "none", strength: "weak" });
	});
	test("events category → none / weak regardless of kind (PR2-7)", () => {
		expect(classifyDelta("events", "event-subscriber-added")).toEqual({
			basis: "none",
			strength: "weak",
		});
		expect(classifyDelta("events", "event-publisher-changed")).toEqual({
			basis: "none",
			strength: "weak",
		});
	});
	test("unknown kind defaults to self / weak", () => {
		expect(classifyDelta("abi", "procedure-removed")).toEqual({
			basis: "self",
			strength: "weak",
		});
		expect(classifyDelta("schema", "table-field-added")).toEqual({
			basis: "self",
			strength: "weak",
		});
		expect(classifyDelta("permissions", "permission-target-added")).toEqual({
			basis: "self",
			strength: "weak",
		});
	});
});

// ---------------------------------------------------------------------------
// correlateRegressions
// ---------------------------------------------------------------------------

describe("correlateRegressions", () => {
	// ---- Test 1: total-time regression + capability-gained-write → correlated ----
	test("total-time regression + capability-gained-write → correlated (basis: total)", () => {
		// Regression: self flat, total regressed.
		const method = makeMethodDelta("ProcessWrite", "Codeunit", 51000, 0, 500);
		const stableId = `${APP_GUID}:Codeunit:51000#hashA`;
		const routine = makeRoutine("ProcessWrite", 51000, "Codeunit", stableId);
		const delta = makeDelta(
			"d1",
			"capabilities",
			"capability-gained-write",
			stableId,
			{
				newStableId: stableId,
				resourceKind: "table",
			},
		);

		const diff: DiffAnalysis = {
			findings: [delta],
			afterInventory: [routine],
			beforeAppVersion: "1.0.0.0",
			afterAppVersion: "2.0.0.0",
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [method], newMethods: [], removedMethods: [] },
			diff,
		);

		expect(result.annotatedRegressions).toHaveLength(1);
		const ar = result.annotatedRegressions[0];
		expect(ar.status).toBe("correlated");
		expect(ar.staticDeltas).toHaveLength(1);
		expect(ar.staticDeltas[0].kind).toBe("capability-gained-write");
		expect(ar.staticDeltas[0].basis).toBe("total");
		expect(ar.staticDeltas[0].strength).toBe("strong");
		expect(result.correlationSummary.correlated).toBe(1);
		expect(result.correlationSummary.weaklyCorrelated).toBe(0);
		expect(result.correlationSummary.unexplained).toBe(0);
		// The write delta was consumed → no staticOnlyChanges.
		expect(result.staticOnlyChanges).toHaveLength(0);
	});

	// ---- Test 2: capability-gained-telemetry only → weakly-correlated ----
	test("capability-gained-telemetry only → weakly-correlated (self-time regression)", () => {
		const method = makeMethodDelta(
			"ProcessTelemetry",
			"Codeunit",
			51001,
			200,
			0,
		);
		const stableId = `${APP_GUID}:Codeunit:51001#hashB`;
		const routine = makeRoutine(
			"ProcessTelemetry",
			51001,
			"Codeunit",
			stableId,
		);
		const delta = makeDelta(
			"d2",
			"capabilities",
			"capability-gained-telemetry",
			stableId,
			{
				newStableId: stableId,
			},
		);

		const diff: DiffAnalysis = {
			findings: [delta],
			afterInventory: [routine],
			beforeAppVersion: undefined,
			afterAppVersion: undefined,
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [method], newMethods: [], removedMethods: [] },
			diff,
		);

		const ar = result.annotatedRegressions[0];
		expect(ar.status).toBe("weakly-correlated");
		expect(ar.staticDeltas[0].strength).toBe("weak");
		expect(result.correlationSummary.weaklyCorrelated).toBe(1);
	});

	// ---- Test 3: regression with no matching delta → unexplained-static ----
	test("regression with no matching-basis delta → unexplained-static", () => {
		const method = makeMethodDelta("OrphanRoutine", "Codeunit", 52000, 300, 0);
		const stableId = `${APP_GUID}:Codeunit:52000#hashC`;
		// Routine in inventory but no corresponding finding.
		const routine = makeRoutine("OrphanRoutine", 52000, "Codeunit", stableId);

		const diff: DiffAnalysis = {
			findings: [],
			afterInventory: [routine],
			beforeAppVersion: undefined,
			afterAppVersion: undefined,
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [method], newMethods: [], removedMethods: [] },
			diff,
		);

		const ar = result.annotatedRegressions[0];
		expect(ar.status).toBe("unexplained-static");
		expect(ar.staticDeltas).toHaveLength(0);
		expect(result.correlationSummary.unexplained).toBe(1);
	});

	// ---- Test 4: total-basis delta but regression is self-only (deltaTotalTime=0) → unexplained ----
	test("total-basis delta with deltaTotalTime=0 regression → NOT annotated (unexplained)", () => {
		// deltaSelfTime > 0 but deltaTotalTime = 0.
		const method = makeMethodDelta(
			"SelfOnlyRegressor",
			"Codeunit",
			53000,
			200,
			0,
		);
		const stableId = `${APP_GUID}:Codeunit:53000#hashD`;
		const routine = makeRoutine(
			"SelfOnlyRegressor",
			53000,
			"Codeunit",
			stableId,
		);
		// capability-gained-write → total basis — but deltaTotalTime=0 → basis mismatch.
		const delta = makeDelta(
			"d4",
			"capabilities",
			"capability-gained-write",
			stableId,
			{
				newStableId: stableId,
			},
		);

		const diff: DiffAnalysis = {
			findings: [delta],
			afterInventory: [routine],
			beforeAppVersion: undefined,
			afterAppVersion: undefined,
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [method], newMethods: [], removedMethods: [] },
			diff,
		);

		const ar = result.annotatedRegressions[0];
		// No matching-basis delta (write delta needs deltaTotalTime>0, but it's 0).
		expect(ar.status).toBe("unexplained-static");
		expect(ar.staticDeltas).toHaveLength(0);
		// The write delta goes to staticOnlyChanges (not consumed).
		expect(result.staticOnlyChanges).toHaveLength(1);
		expect(result.staticOnlyChanges[0].kind).toBe("capability-gained-write");
	});

	// ---- Test 5: event-publish delta → staticOnlyChanges cross-boundary ----
	test("event-publish delta → staticOnlyChanges (cross-boundary, not local annotation, PR2-7)", () => {
		const method = makeMethodDelta(
			"PublishRoutine",
			"Codeunit",
			54000,
			100,
			200,
		);
		const stableId = `${APP_GUID}:Codeunit:54000#hashE`;
		const routine = makeRoutine("PublishRoutine", 54000, "Codeunit", stableId);
		const eventDelta = makeDelta(
			"d5",
			"capabilities",
			"capability-gained-event-publish",
			stableId,
			{ newStableId: stableId },
		);

		const diff: DiffAnalysis = {
			findings: [eventDelta],
			afterInventory: [routine],
			beforeAppVersion: undefined,
			afterAppVersion: undefined,
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [method], newMethods: [], removedMethods: [] },
			diff,
		);

		// Event-publish is cross-boundary → NOT in annotated regression's staticDeltas.
		const ar = result.annotatedRegressions[0];
		expect(ar.staticDeltas).toHaveLength(0);
		expect(ar.status).toBe("unexplained-static");

		// Event delta goes to staticOnlyChanges.
		expect(result.staticOnlyChanges).toHaveLength(1);
		expect(result.staticOnlyChanges[0].kind).toBe(
			"capability-gained-event-publish",
		);
		expect(result.staticOnlyChanges[0].basis).toBe("none");
	});

	// ---- Test 6: new hot method + procedure-added → newMethodCorrelations ----
	test("new hot method + procedure-added → newMethodCorrelations (PR2-5 headline)", () => {
		const newMethod = makeMethodBreakdown("NewHotMethod", "Codeunit", 55000);
		const stableId = `${APP_GUID}:Codeunit:55000#hashF`;
		const routine = makeRoutine("NewHotMethod", 55000, "Codeunit", stableId);
		const addedDelta = makeDelta("d6", "abi", "procedure-added", stableId, {
			newStableId: stableId,
		});

		const diff: DiffAnalysis = {
			findings: [addedDelta],
			afterInventory: [routine],
			beforeAppVersion: undefined,
			afterAppVersion: undefined,
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [], newMethods: [newMethod], removedMethods: [] },
			diff,
		);

		expect(result.newMethodCorrelations).toHaveLength(1);
		expect(result.newMethodCorrelations[0].method).toBe(newMethod);
		expect(result.newMethodCorrelations[0].delta.kind).toBe("procedure-added");
		expect(result.newMethodCorrelations[0].delta.basis).toBe("self");
		expect(result.newMethodCorrelations[0].delta.strength).toBe("strong");
	});

	// ---- Test 7: overload / field-trigger key collision → union with ambiguous marker ----
	test("overload / field-trigger collision → union of deltas with ambiguous marker (PR2-3)", () => {
		// Two routines sharing the SAME join key (both Codeunit 56000 routineName "OnValidate").
		const stableA = `${APP_GUID}:Codeunit:56000#hashGA`;
		const stableB = `${APP_GUID}:Codeunit:56000#hashGB`;
		const routineA = makeRoutine("OnValidate", 56000, "Codeunit", stableA);
		const routineB = makeRoutine("OnValidate", 56000, "Codeunit", stableB);

		// One delta for each stableId.
		const deltaA = makeDelta(
			"d7a",
			"capabilities",
			"capability-gained-write",
			stableA,
			{
				newStableId: stableA,
			},
		);
		const deltaB = makeDelta(
			"d7b",
			"capabilities",
			"capability-gained-commit",
			stableB,
			{
				newStableId: stableB,
			},
		);

		// Regression on the bare OnValidate with total-time regression.
		const method = makeMethodDelta("OnValidate", "Codeunit", 56000, 0, 400);

		const diff: DiffAnalysis = {
			findings: [deltaA, deltaB],
			afterInventory: [routineA, routineB],
			beforeAppVersion: undefined,
			afterAppVersion: undefined,
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [method], newMethods: [], removedMethods: [] },
			diff,
		);

		const ar = result.annotatedRegressions[0];
		// Both deltas should be attached (union) and both should be total-basis (deltaTotalTime > 0).
		expect(ar.staticDeltas).toHaveLength(2);
		expect(ar.staticDeltas.every((d) => d.ambiguous === true)).toBe(true);
		expect(ar.status).toBe("correlated");
	});

	// ---- Test 8: version mismatch → versionMismatch set ----
	test("version mismatch → correlationSummary.versionMismatch set (PR2-4)", () => {
		const method = makeMethodDelta("SomeMethod", "Codeunit", 57000, 100, 0);
		const stableId = `${APP_GUID}:Codeunit:57000#hashH`;
		const routine = makeRoutine("SomeMethod", 57000, "Codeunit", stableId);

		const diff: DiffAnalysis = {
			findings: [],
			afterInventory: [routine],
			beforeAppVersion: "1.0.0.0",
			afterAppVersion: "2.0.0.0",
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [method], newMethods: [], removedMethods: [] },
			diff,
			// Profile says before=1.0.0.0 (matches), after=1.9.9.9 (mismatch with ws 2.0.0.0).
			{ before: "1.0.0.0", after: "1.9.9.9" },
		);

		expect(result.correlationSummary.versionMismatch).toBeDefined();
		const vm = result.correlationSummary.versionMismatch!;
		expect(vm.afterProfileVersion).toBe("1.9.9.9");
		expect(vm.afterWorkspaceVersion).toBe("2.0.0.0");
		// Before matches → only after differs.
		expect(vm.beforeProfileVersion).toBe("1.0.0.0");
		expect(vm.beforeWorkspaceVersion).toBe("1.0.0.0");
	});

	test("no version mismatch when versions agree", () => {
		const diff: DiffAnalysis = {
			findings: [],
			afterInventory: [],
			beforeAppVersion: "1.0.0.0",
			afterAppVersion: "2.0.0.0",
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [], newMethods: [], removedMethods: [] },
			diff,
			{ before: "1.0.0.0", after: "2.0.0.0" },
		);
		expect(result.correlationSummary.versionMismatch).toBeUndefined();
	});

	// ---- Test 9: determinism ----
	test("determinism — multi-element ordering is stable across runs", () => {
		// TWO regressions, each carrying MULTIPLE matching-basis deltas, PLUS
		// several static-only + cross-boundary deltas — so annotatedRegressions[],
		// staticDeltas[], and staticOnlyChanges[] are ALL multi-element lists. A
		// 1-element fixture would pass even if the code leaked Map iteration order;
		// this exercises the engine-order filtering that guards PR2-8.

		// Regression 1: ProcessA (total regression) — two total-basis deltas.
		const methodA = makeMethodDelta("ProcessA", "Codeunit", 58000, 0, 300);
		const stableA = `${APP_GUID}:Codeunit:58000#hashA`;
		const routineA = makeRoutine("ProcessA", 58000, "Codeunit", stableA);

		// Regression 2: ProcessB (self regression) — one self-basis delta.
		const methodB = makeMethodDelta("ProcessB", "Codeunit", 58001, 200, 0);
		const stableB = `${APP_GUID}:Codeunit:58001#hashB`;
		const routineB = makeRoutine("ProcessB", 58001, "Codeunit", stableB);

		// A routine with a static-only delta (not regressed).
		const stableC = `${APP_GUID}:Codeunit:58002#hashC`;
		const routineC = makeRoutine("ProcessC", 58002, "Codeunit", stableC);

		// Findings in a deliberate engine order; correlate must preserve it.
		const findings: DiffDelta[] = [
			makeDelta("dA1", "capabilities", "capability-gained-write", stableA, {
				newStableId: stableA,
			}),
			makeDelta("dC1", "capabilities", "capability-gained-http", stableC, {
				newStableId: stableC,
			}),
			makeDelta("dB1", "abi", "procedure-signature-changed", stableB, {
				newStableId: stableB,
			}),
			makeDelta("dA2", "capabilities", "capability-gained-commit", stableA, {
				newStableId: stableA,
			}),
			// A cross-boundary event delta on A — always staticOnlyChanges.
			makeDelta(
				"dA3",
				"capabilities",
				"capability-gained-event-publish",
				stableA,
				{ newStableId: stableA },
			),
		];

		const diff: DiffAnalysis = {
			findings,
			afterInventory: [routineA, routineB, routineC],
			beforeAppVersion: "1.0.0.0",
			afterAppVersion: "2.0.0.0",
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const comp = {
			regressions: [methodA, methodB],
			newMethods: [],
			removedMethods: [],
		};
		const r1 = correlateRegressions(comp, diff, {
			before: "1.0.0.0",
			after: "2.0.0.0",
		});
		const r2 = correlateRegressions(comp, diff, {
			before: "1.0.0.0",
			after: "2.0.0.0",
		});

		// Sanity: the lists are genuinely multi-element so this test has teeth.
		expect(r1.annotatedRegressions).toHaveLength(2);
		expect(r1.annotatedRegressions[0].staticDeltas).toHaveLength(2);
		expect(r1.staticOnlyChanges.length).toBeGreaterThanOrEqual(2);

		// Full structural identity across runs (would break on any Map-order leak).
		expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
	});

	// ---- Test 10: events-category delta → staticOnlyChanges ----
	test("events-category delta → staticOnlyChanges (cross-boundary, PR2-7)", () => {
		const method = makeMethodDelta("EventMethod", "Codeunit", 59000, 100, 0);
		const stableId = `${APP_GUID}:Codeunit:59000#hashJ`;
		const routine = makeRoutine("EventMethod", 59000, "Codeunit", stableId);
		const eventsDelta = makeDelta(
			"d10",
			"events",
			"event-subscriber-added",
			stableId,
			{
				newStableId: stableId,
			},
		);

		const diff: DiffAnalysis = {
			findings: [eventsDelta],
			afterInventory: [routine],
			beforeAppVersion: undefined,
			afterAppVersion: undefined,
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [method], newMethods: [], removedMethods: [] },
			diff,
		);

		// events category → cross-boundary → NOT in regression annotation.
		const ar = result.annotatedRegressions[0];
		expect(ar.staticDeltas).toHaveLength(0);
		expect(ar.status).toBe("unexplained-static");
		expect(result.staticOnlyChanges).toHaveLength(1);
		expect(result.staticOnlyChanges[0].category).toBe("events");
	});

	// ---- Test 11: unmatched regression + unmatched delta → both honest ----
	test("delta on a routine NOT in regression list → staticOnlyChanges", () => {
		// Regression on routine A.
		const methodA = makeMethodDelta("RoutineA", "Codeunit", 60001, 100, 0);
		const stableA = `${APP_GUID}:Codeunit:60001#hashKA`;
		const routineA = makeRoutine("RoutineA", 60001, "Codeunit", stableA);

		// Delta on routine B (not in regression list).
		const stableB = `${APP_GUID}:Codeunit:60002#hashKB`;
		const routineB = makeRoutine("RoutineB", 60002, "Codeunit", stableB);
		const deltaB = makeDelta(
			"d11",
			"capabilities",
			"capability-gained-write",
			stableB,
			{
				newStableId: stableB,
			},
		);

		const diff: DiffAnalysis = {
			findings: [deltaB],
			afterInventory: [routineA, routineB],
			beforeAppVersion: undefined,
			afterAppVersion: undefined,
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [methodA], newMethods: [], removedMethods: [] },
			diff,
		);

		// RoutineA has no delta → unexplained.
		expect(result.annotatedRegressions[0].status).toBe("unexplained-static");
		// DeltaB on RoutineB goes to staticOnlyChanges.
		expect(result.staticOnlyChanges).toHaveLength(1);
		expect(result.staticOnlyChanges[0].kind).toBe("capability-gained-write");
	});

	// ---- Test 12: removed method + procedure-removed → removedMethodCorrelations ----
	test("removed method + procedure-removed → removedMethodCorrelations", () => {
		const removedMethod = makeMethodBreakdown(
			"RemovedRoutine",
			"Codeunit",
			61000,
		);
		const stableId = `${APP_GUID}:Codeunit:61000#hashL`;
		const routine = makeRoutine("RemovedRoutine", 61000, "Codeunit", stableId);
		const removedDelta = makeDelta("d12", "abi", "procedure-removed", stableId);

		const diff: DiffAnalysis = {
			findings: [removedDelta],
			afterInventory: [routine],
			beforeAppVersion: undefined,
			afterAppVersion: undefined,
			beforeAppId: undefined,
			afterAppId: undefined,
			alsemVersion: "0.0.0-test",
		};

		const result = correlateRegressions(
			{ regressions: [], newMethods: [], removedMethods: [removedMethod] },
			diff,
		);

		expect(result.removedMethodCorrelations).toHaveLength(1);
		expect(result.removedMethodCorrelations[0].method).toBe(removedMethod);
		expect(result.removedMethodCorrelations[0].delta.kind).toBe(
			"procedure-removed",
		);
	});
});

// ---------------------------------------------------------------------------
// diff-runner tests (stub-backed)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");
const STUB_TS = resolve(FIXTURE_DIR, "alsem-stub.ts");
const BUN_EXE = process.execPath;

let cleanups: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanups) {
		try {
			fn();
		} catch {
			// ignore cleanup errors
		}
	}
	cleanups = [];
});

function makeDiffStubBinary(tmpDir: string): string {
	if (process.platform === "win32") {
		const cmdPath = join(tmpDir, "alsem-stub.cmd");
		writeFileSync(
			cmdPath,
			`@echo off\r\nset "ALSEM_STUB_MODE=diff"\r\n"${BUN_EXE}" "${STUB_TS}" %*\r\n`,
		);
		return cmdPath;
	}
	const shPath = join(tmpDir, "alsem-stub.sh");
	writeFileSync(
		shPath,
		`#!/bin/sh\nexport ALSEM_STUB_MODE='diff'\nexec "${BUN_EXE}" "${STUB_TS}" "$@"\n`,
	);
	chmodSync(shPath, 0o755);
	return shPath;
}

describe("runEngineDiff (stub-backed)", () => {
	test("ALSEM_STUB_MODE=diff → DiffAnalysis with expected findings + inventory", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-diff-test-"));
		cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));

		const bin = makeDiffStubBinary(tmpDir);

		// Use ws-min as both before and after (stub ignores actual paths).
		const result = await runEngineDiff(WS_MIN, WS_MIN, {
			engine: bin,
			timeoutMs: 30_000,
		});

		expect("disabled" in result).toBe(false);
		if ("disabled" in result) return;

		const analysis = result as DiffAnalysis;

		// 4 findings in the stub diff-report.
		expect(analysis.findings).toHaveLength(4);

		// Finding 0: capability-gained-write
		const f0 = analysis.findings[0];
		expect(f0.kind).toBe("capability-gained-write");
		expect(f0.category).toBe("capabilities");
		expect(f0.newStableId).toBe(DIFF_CU_STABLE);
		expect(f0.resourceKind).toBe("table");
		expect(f0.op).toBe("insert");

		// Finding 1: procedure-added
		const f1 = analysis.findings[1];
		expect(f1.kind).toBe("procedure-added");
		expect(f1.newStableId).toBe(DIFF_CU_NEW_STABLE);

		// After inventory has 2 routines.
		expect(analysis.afterInventory).toHaveLength(2);
		const inv0 = analysis.afterInventory[0];
		expect(inv0.stableRoutineId).toBe(DIFF_CU_STABLE);
		expect(inv0.routineName).toBe("ProcessWrite");
		expect(inv0.objectNumber).toBe(51000);

		// app.json version from ws-min fixture.
		expect(analysis.beforeAppVersion).toBe("1.0.0.0");
		expect(analysis.afterAppVersion).toBe("1.0.0.0");
	});

	test("binary absent → { disabled }", async () => {
		const result = await runEngineDiff(WS_MIN, WS_MIN, {
			engine: "/no/such/binary.exe",
		});
		expect("disabled" in result && result.disabled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// End-to-end: stub diff + correlateRegressions
// ---------------------------------------------------------------------------

describe("correlateRegressions end-to-end with stub diff", () => {
	test("ProcessWrite total regression + capability-gained-write from stub → correlated", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-diff-e2e-"));
		cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
		const bin = makeDiffStubBinary(tmpDir);

		const diff = await runEngineDiff(WS_MIN, WS_MIN, {
			engine: bin,
			timeoutMs: 30_000,
		});
		expect("disabled" in diff).toBe(false);
		if ("disabled" in diff) return;

		const analysis = diff as DiffAnalysis;

		// Build a regression whose join key matches DIFF_CU_STABLE (ProcessWrite, Codeunit 51000).
		const method = makeMethodDelta("ProcessWrite", "Codeunit", 51000, 0, 500);

		// Build new-method matching NewHotMethod (Codeunit 51001).
		const newMethod = makeMethodBreakdown("NewHotMethod", "Codeunit", 51001);

		const result = correlateRegressions(
			{ regressions: [method], newMethods: [newMethod], removedMethods: [] },
			analysis,
		);

		// ProcessWrite total regression + capability-gained-write (total/strong) → correlated.
		expect(result.annotatedRegressions).toHaveLength(1);
		expect(result.annotatedRegressions[0].status).toBe("correlated");
		const deltas = result.annotatedRegressions[0].staticDeltas;
		expect(deltas.some((d) => d.kind === "capability-gained-write")).toBe(true);

		// Telemetry delta on same routine but self-time basis mismatch (deltaSelfTime=0) → NOT annotated.
		// So telemetry goes to staticOnlyChanges.
		expect(
			result.staticOnlyChanges.some(
				(d) => d.kind === "capability-gained-telemetry",
			),
		).toBe(true);

		// Event-publish delta → staticOnlyChanges cross-boundary.
		expect(
			result.staticOnlyChanges.some(
				(d) => d.kind === "capability-gained-event-publish",
			),
		).toBe(true);

		// NewHotMethod + procedure-added → newMethodCorrelations.
		expect(result.newMethodCorrelations).toHaveLength(1);
		expect(result.newMethodCorrelations[0].delta.kind).toBe("procedure-added");
	});
});
