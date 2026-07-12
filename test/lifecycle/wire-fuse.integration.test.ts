/**
 * wire-fuse.integration.test.ts — fuseProfile re-mints pattern fingerprints
 * with correlation attributions (lifecycle phase-2 identity upgrade).
 *
 * Uses the committed alsem-stub.ts in "findings" mode via a temp launcher,
 * mirroring test/semantic/corroborate.integration.test.ts. The stub's
 * inventory matches ProcessLine on Codeunit 50000 (single stableRoutineId),
 * so a pattern anchored there must upgrade fallback → stable identity.
 *
 * Also covers graceful degradation: a missing engine leaves the
 * analyzeProfile-minted fallback fingerprint untouched, and that
 * FusedModel.identityUpgrades is surfaced only when a re-mint actually
 * changed a fingerprint (Task 2 of the fpwire identity-upgrade plan).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	computePatternFingerprint,
	formatFingerprint,
	parseFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import { fingerprintPatterns } from "../../src/lifecycle/wire.js";
import { clearEngineCache } from "../../src/semantic/engine-runner.js";
import { fuseProfile } from "../../src/semantic/fuse.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { FusedModel } from "../../src/types/fused.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");
const STUB_TS = resolve(FIXTURE_DIR, "alsem-stub.ts");
const BUN_EXE = process.execPath;

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

/** Platform-appropriate launcher for alsem-stub.ts in "findings" mode. */
function makeStubBinary(mode: "ok" | "findings" = "findings"): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-wire-fuse-stub-"));
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

/** Methods matching the stub's "findings" mode inventory (no appId — stub app). */
function makeMethodBreakdowns(): MethodBreakdown[] {
	const base = {
		objectType: "Codeunit",
		objectName: "StubCodeunit",
		objectId: 50000,
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

function makePattern(): DetectedPattern {
	return {
		id: "repeated-siblings",
		severity: "critical",
		title: "ProcessLine repeated",
		description: "test",
		impact: 1000,
		involvedMethods: ["ProcessLine (Codeunit 50000)", "OnRun (Codeunit 50000)"],
		evidence: "test",
	};
}

function isFusedModel(result: unknown): result is FusedModel {
	return (
		typeof result === "object" &&
		result !== null &&
		"attributions" in result &&
		"correlationSummary" in result
	);
}

describe("fuseProfile fingerprint identity upgrade", () => {
	test("a matched anchor upgrades from the fallback to the stable-identity fingerprint", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();
		const pattern = makePattern();

		// Pre-fusion state (what analyzeProfile mints): a fallback fingerprint.
		fingerprintPatterns([pattern], methods);
		const fallbackFp = pattern.fingerprint;
		expect(fallbackFp).toMatch(/^pattern:[0-9a-f]{16}$/);

		const result = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			patterns: [pattern],
		});
		expect(isFusedModel(result)).toBe(true);
		if (!isFusedModel(result)) return;

		const attr = result.attributions.get("ProcessLine_Codeunit_50000");
		expect(attr?.status).toBe("matched");
		expect(typeof attr?.stableRoutineId).toBe("string");

		// Re-minted with the stable identity — different from the fallback,
		// and exactly reproducible from the attribution.
		expect(pattern.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		expect(pattern.fingerprint).not.toBe(fallbackFp);
		const expected = formatFingerprint(
			computePatternFingerprint(
				{ patternId: "repeated-siblings" },
				{
					kind: "stable",
					stableRoutineId: attr?.stableRoutineId as string,
				},
				"",
			),
		);
		expect(pattern.fingerprint).toBe(expected);

		// The identity upgrade is surfaced on the FusedModel for the lifecycle
		// apply path to rekey (Task 3) instead of duplicating.
		expect(result.identityUpgrades).toEqual([
			{
				patternId: "repeated-siblings",
				from: parseFingerprint(fallbackFp as string),
				to: parseFingerprint(pattern.fingerprint as string),
			},
		]);
	}, 30_000);

	test("a disabled engine leaves the fallback fingerprint untouched (graceful degradation)", async () => {
		const methods = makeMethodBreakdowns();
		const pattern = makePattern();
		fingerprintPatterns([pattern], methods);
		const fallbackFp = pattern.fingerprint;

		const result = await fuseProfile(methods, WS_MIN, {
			engine: "definitely-not-a-real-alsem-binary-xyz",
			patterns: [pattern],
		});

		expect("disabled" in result).toBe(true);
		expect(pattern.fingerprint).toBe(fallbackFp);
	}, 30_000);

	test("no opts.patterns → identityUpgrades is absent, even though the anchor would confidently match", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();

		const result = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			// No `patterns` option — fingerprintPatterns is never called.
		});
		expect(isFusedModel(result)).toBe(true);
		if (!isFusedModel(result)) return;

		expect(result.identityUpgrades).toBeUndefined();
	}, 30_000);

	test("a re-mint that lands on the SAME fingerprint does not surface an identityUpgrade", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();
		const pattern = makePattern();

		// Pre-fingerprint with a fallback key (as analyzeProfile would), so the
		// FIRST fuseProfile call is a genuine identity upgrade (fallback →
		// stable) — then the SECOND call's re-mint is a no-op value-wise.
		fingerprintPatterns([pattern], methods);

		const first = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			patterns: [pattern],
		});
		expect(isFusedModel(first)).toBe(true);
		if (!isFusedModel(first)) return;
		expect(first.identityUpgrades?.length).toBe(1);

		clearEngineCache();
		const second = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			patterns: [pattern],
		});
		expect(isFusedModel(second)).toBe(true);
		if (!isFusedModel(second)) return;

		// Same stable identity both times — the second fusion re-mints to an
		// IDENTICAL value, so nothing is collected.
		expect(second.identityUpgrades).toBeUndefined();
	}, 30_000);
});
