/**
 * corroborate.integration.test.ts — Integration test for Task P3.1 Task 3:
 * verifies that `fuseProfile(methods, dir, { patterns })` calls corroborate
 * and yields matched attributions with `corroboratingPatterns` when a mapped
 * runtime pattern is anchored to that routine.
 *
 * Uses the committed alsem-stub.ts in "findings" mode (via a temp launcher),
 * mirroring the approach in fuse.e2e.test.ts and server.test.ts.
 *
 * The stub's "findings" mode emits:
 *   - ProcessLine on Codeunit 50000  (d1-db-op-in-loop)  → hot leaf, self 100%
 *   - OnRun on Codeunit 50000        (d2-orchestrator)   → self 0%
 *
 * We pass a `repeated-siblings` pattern anchored to ProcessLine (anchorIndex 0).
 * repeated-siblings corroborates d1-db-op-in-loop → ProcessLine's attribution
 * should carry corroboratingPatterns: ["repeated-siblings"].
 *
 * No-patterns path: fuseProfile called without patterns (or patterns: []) →
 * corroborating patterns absent → graceful no-op.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { clearEngineCache } from "../../src/semantic/engine-runner.js";
import { fuseProfile } from "../../src/semantic/fuse.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { FusedModel } from "../../src/types/fused.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");
const STUB_TS = resolve(FIXTURE_DIR, "alsem-stub.ts");
const BUN_EXE = process.execPath;

// The stub's "findings" mode uses this object type + id for ProcessLine / OnRun.
const FINDINGS_CODEUNIT_ID = 50000;

// ---------------------------------------------------------------------------
// Stub binary factory (mirrors fuse.e2e.test.ts + server.test.ts)
// ---------------------------------------------------------------------------

let cleanups: Array<() => void> = [];
afterEach(() => {
	clearEngineCache();
	for (const fn of cleanups) {
		try {
			fn();
		} catch {
			// ignore
		}
	}
	cleanups = [];
});

/**
 * Build a platform-appropriate launcher that runs alsem-stub.ts in "findings" mode.
 * "findings" mode emits ProcessLine + OnRun on Codeunit 50000 with a d1 finding.
 */
function makeStubBinary(mode: "ok" | "findings" = "findings"): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-corroborate-int-stub-"));
	cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
	if (process.platform === "win32") {
		const cmdPath = join(tmpDir, "alsem-stub.cmd");
		writeFileSync(
			cmdPath,
			`@echo off\r\nset "ALSEM_STUB_MODE=${mode}"\r\n"${BUN_EXE}" "${STUB_TS}" %*\r\n`,
		);
		return cmdPath;
	}
	const shPath = join(tmpDir, "alsem-stub.sh");
	writeFileSync(
		shPath,
		`#!/bin/sh\nexport ALSEM_STUB_MODE='${mode}'\nexec "${BUN_EXE}" "${STUB_TS}" "$@"\n`,
	);
	chmodSync(shPath, 0o755);
	return shPath;
}

// ---------------------------------------------------------------------------
// Method factories matching the stub's "findings" mode inventory
// ---------------------------------------------------------------------------

/**
 * Build MethodBreakdown entries that match the stub's "findings" mode:
 *   - ProcessLine on Codeunit 50000, self 100% (the hot leaf)
 *   - OnRun on Codeunit 50000, self 0% (the orchestrator)
 *
 * formatMethodRef(m) = "${functionName} (${objectType} ${objectId})"
 */
function makeMethodBreakdowns(): MethodBreakdown[] {
	const base = {
		objectType: "Codeunit",
		objectName: "StubCodeunit",
		objectId: FINDINGS_CODEUNIT_ID,
		appName: "StubApp",
		calledBy: [],
		calls: [],
		costPerHit: 100,
		efficiencyScore: 1.0,
	};
	return [
		{
			...base,
			functionName: "ProcessLine",
			selfTime: 10000,
			selfTimePercent: 100,
			totalTime: 10000,
			totalTimePercent: 100,
			hitCount: 10,
		},
		{
			...base,
			functionName: "OnRun",
			selfTime: 0,
			selfTimePercent: 0,
			totalTime: 10000,
			totalTimePercent: 100,
			hitCount: 10,
		},
	];
}

/** Format a method ref the same way corroborate.ts does: "${functionName} (${objectType} ${objectId})". */
function fmt(fn: string, ot: string, oid: number): string {
	return `${fn} (${ot} ${oid})`;
}

function isFusedModel(result: unknown): result is FusedModel {
	return (
		typeof result === "object" &&
		result !== null &&
		"attributions" in result &&
		"correlationSummary" in result
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fuseProfile + corroborate integration (P3.1 Task 3)", () => {
	test("fuseProfile with patterns=[] → no corroboratingPatterns (graceful no-op)", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();

		const result = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			patterns: [],
		});

		expect(isFusedModel(result)).toBe(true);
		if (!isFusedModel(result)) return;

		// ProcessLine is matched (has a d1 finding from the stub)
		const key = "ProcessLine_Codeunit_50000";
		const attr = result.attributions.get(key);
		expect(attr).toBeDefined();
		expect(attr?.status).toBe("matched");

		// No patterns supplied → no corroboration
		expect(attr?.corroboratingPatterns).toBeUndefined();
	}, 30_000);

	test("fuseProfile without patterns option → no corroboratingPatterns (graceful no-op)", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();

		// No patterns key in opts at all
		const result = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
		});

		expect(isFusedModel(result)).toBe(true);
		if (!isFusedModel(result)) return;

		const attr = result.attributions.get("ProcessLine_Codeunit_50000");
		expect(attr?.status).toBe("matched");
		expect(attr?.corroboratingPatterns).toBeUndefined();
	}, 30_000);

	test("fuseProfile with matched runtime pattern → corroboratingPatterns populated", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();

		// repeated-siblings: involvedMethods[0] = parent (ProcessLine is the loop owner)
		// ProcessLine has a d1-db-op-in-loop finding → repeated-siblings corroborates d1
		const patterns: DetectedPattern[] = [
			{
				id: "repeated-siblings",
				severity: "critical",
				title: "Repeated Siblings",
				description: "Same child called repeatedly under one parent",
				impact: 5000,
				involvedMethods: [
					fmt("ProcessLine", "Codeunit", FINDINGS_CODEUNIT_ID), // anchorIndex 0
					fmt("GetRecord", "Codeunit", 99999), // the representative child
				],
				evidence: "10 sibling calls observed",
			},
		];

		const result = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			patterns,
		});

		expect(isFusedModel(result)).toBe(true);
		if (!isFusedModel(result)) return;

		const key = "ProcessLine_Codeunit_50000";
		const attr = result.attributions.get(key);
		expect(attr).toBeDefined();
		expect(attr?.status).toBe("matched");

		// The d1-db-op-in-loop finding is corroborated by repeated-siblings
		expect(attr?.findings.some((f) => f.detector === "d1-db-op-in-loop")).toBe(
			true,
		);
		expect(attr?.corroboratingPatterns).toEqual(["repeated-siblings"]);
	}, 30_000);

	test("fuseProfile: unmapped pattern id → no corroboration", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();

		// "modify-in-loop" is a source-static pattern — NOT in CORROBORATION_MAP
		const patterns: DetectedPattern[] = [
			{
				id: "modify-in-loop",
				severity: "critical",
				title: "Modify in Loop",
				description: "Modify() inside a loop",
				impact: 3000,
				involvedMethods: [fmt("ProcessLine", "Codeunit", FINDINGS_CODEUNIT_ID)],
				evidence: "static scan",
			},
		];

		const result = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			patterns,
		});

		expect(isFusedModel(result)).toBe(true);
		if (!isFusedModel(result)) return;

		const attr = result.attributions.get("ProcessLine_Codeunit_50000");
		expect(attr?.status).toBe("matched");
		// Source-static pattern → not corroborating
		expect(attr?.corroboratingPatterns).toBeUndefined();
	}, 30_000);

	test("fuseProfile: pattern anchored to a different routine → no corroboration on ProcessLine", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();

		// Anchor to a different routine entirely (not in the stub's inventory)
		const patterns: DetectedPattern[] = [
			{
				id: "repeated-siblings",
				severity: "critical",
				title: "Repeated Siblings",
				description: "Same child called repeatedly under one parent",
				impact: 5000,
				involvedMethods: [
					fmt("SomeOtherProc", "Codeunit", 99998), // NOT ProcessLine
					fmt("GetRecord", "Codeunit", 99999),
				],
				evidence: "10 sibling calls observed",
			},
		];

		const result = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			patterns,
		});

		expect(isFusedModel(result)).toBe(true);
		if (!isFusedModel(result)) return;

		// ProcessLine should NOT be corroborated (pattern anchored elsewhere)
		const attr = result.attributions.get("ProcessLine_Codeunit_50000");
		expect(attr?.status).toBe("matched");
		expect(attr?.corroboratingPatterns).toBeUndefined();
	}, 30_000);
});
