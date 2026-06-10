/**
 * corroborate.integration.test.ts — Integration tests for corroboration (P3.1 Task 3
 * + P3.2c Task 4).
 *
 * Section 1: stub-backed fuseProfile integration (P3.1 Task 3).
 * Section 2: real-binary smoke (P3.2c Task 4, gated on AL_SEM_BIN env var).
 *
 * Section 1 uses the committed alsem-stub.ts in "findings" mode (via a temp launcher),
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
 *
 * Section 2: runs the REAL alsem.exe against ws-implicit-trigger (a field-trigger
 * fixture), parses the 1.1.0 output, and confirms al-perf correctly reads
 * enclosingMember on inventory rows and evidencePath on findings.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	clearEngineCache,
	type EngineAnalysis,
	runEngine,
} from "../../src/semantic/engine-runner.js";
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

// ---------------------------------------------------------------------------
// P3.2c Task 4: Real-binary smoke (gated: AL_SEM_BIN env var)
//
// Proves al-perf correctly parses the REAL alsem.exe output — not just the
// hand-crafted stub. We run `runEngine` against the `ws-implicit-trigger`
// corpus fixture (which has a Table 72100 "Quantity" field OnValidate trigger)
// and assert that al-perf reads back:
//   - enclosingMember on the field-trigger inventory row, and
//   - evidencePath on the d1-db-op-in-loop finding (with the REAL sourceAnchor shape).
//
// The real binary lives at U:\Git\alch-engine\target\release\alsem.exe; set
// AL_SEM_BIN to that path (or any rebuilt alsem.exe path) to enable this section.
//
// Fallback path: if AL_SEM_BIN is not set but the alch-engine release binary
// exists at its canonical local path, use it automatically.
// ---------------------------------------------------------------------------

function isEngineAnalysis(result: unknown): result is EngineAnalysis {
	return (
		typeof result === "object" &&
		result !== null &&
		"routines" in result &&
		"findings" in result
	);
}

const ALCH_ENGINE_BIN =
	"U:\\Git\\alch-engine\\target\\release\\alsem.exe".replace(/\\/g, "/");
const REAL_BIN: string | undefined =
	process.env.AL_SEM_BIN ??
	(existsSync(ALCH_ENGINE_BIN) ? ALCH_ENGINE_BIN : undefined);

// ws-implicit-trigger: has a Table 72100 "Quantity" OnValidate trigger and a
// d1-db-op-in-loop finding that traces through it.
const WS_IMPLICIT_TRIGGER =
	"U:\\Git\\alch-engine\\tests\\r0-corpus\\ws-implicit-trigger".replace(
		/\\/g,
		"/",
	);

describe("P3.2c real-binary smoke (gated: AL_SEM_BIN / canonical alch-engine path)", () => {
	test.skipIf(!REAL_BIN || !existsSync(WS_IMPLICIT_TRIGGER))(
		"real alsem.exe on ws-implicit-trigger: enclosingMember on inventory + evidencePath on finding",
		async () => {
			clearEngineCache();
			const result = await runEngine(WS_IMPLICIT_TRIGGER, {
				engine: REAL_BIN,
				timeoutMs: 60_000,
			});

			expect(isEngineAnalysis(result)).toBe(true);
			if (!isEngineAnalysis(result)) return;

			// 1. The routine inventory must contain the field-trigger row with enclosingMember.
			//    ws-implicit-trigger has Table 72100 "Quantity" OnValidate.
			const onValRow = result.routines.find(
				(r) => r.routineName === "OnValidate" && r.objectType === "Table",
			);
			expect(onValRow).toBeDefined();
			expect(onValRow?.enclosingMember).toBe("Quantity");
			expect(onValRow?.objectNumber).toBe(72100);
			expect(onValRow?.originatingObject).toMatch(/Table:72100/);

			// 2. The analyze report must include a d1-db-op-in-loop finding with evidencePath.
			//    The finding's primaryLocation must carry enclosingMember for the field trigger.
			const d1Finding = result.findings.find(
				(f) => f.detector === "d1-db-op-in-loop",
			);
			expect(d1Finding).toBeDefined();

			// evidencePath is present (--with-evidence was passed by engine-runner).
			expect(d1Finding?.evidencePath).toBeDefined();
			expect(Array.isArray(d1Finding?.evidencePath)).toBe(true);
			const path = d1Finding?.evidencePath ?? [];
			expect(path.length).toBeGreaterThanOrEqual(1);

			// Each step has routineId (:-form), file (sourceUnitId), line (startLine), note.
			for (const step of path) {
				expect(step.routineId).toBeString();
				expect(step.routineId).toMatch(/:/); // :-form StableRoutineId
				expect(step.file).toBeString();
				expect(typeof step.line).toBe("number");
				expect(step.note).toBeString();
			}

			// The finding's primaryLocation carries enclosingMember (field trigger discriminator).
			// (The d1 finding in ws-implicit-trigger is on the Quantity OnValidate trigger.)
			expect(d1Finding?.primaryLocation.enclosingMember).toBe("Quantity");

			// 3. Schema version is 1.1.0.
			// (Confirmed via alsemVersion; the schemaVersion is parsed into the EngineAnalysis
			// internally — we verify the data is populated, not the raw schema string.)
			expect(result.alsemVersion).toBeString();
		},
		60_000,
	);
});
