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
	applyIdentityUpgrades,
	evaluateRun,
	type RunMetadata,
} from "../../src/lifecycle/evaluate.js";
import {
	computePatternFingerprint,
	formatFingerprint,
	parseFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import { LifecycleStore } from "../../src/lifecycle/store.js";
import { fingerprintPatterns } from "../../src/lifecycle/wire.js";
import type { AnalysisResult } from "../../src/output/types.js";
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

/** Minimal AnalysisResult wrapping one pattern + its methods, for evaluateRun. */
function makeAnalysisResult(
	pattern: DetectedPattern,
	methods: MethodBreakdown[],
): AnalysisResult {
	return {
		meta: {
			profilePath: "p.alcpuprofile",
			profileType: "sampling",
			totalDuration: 10_000,
			totalSelfTime: 10_000,
			idleSelfTime: 0,
			totalNodes: 10,
			maxDepth: 3,
			sourceAvailable: false,
			confidenceScore: 90,
			confidenceFactors: {
				sampleCount: { value: 100, score: 90 },
				duration: { value: 10_000, score: 90 },
				incompleteMeasurements: { value: 0, score: 100 },
			},
			analyzedAt: "2026-07-01T10:00:00Z",
		},
		summary: {
			oneLiner: "x",
			topApp: null,
			topMethod: null,
			patternCount: { critical: 1, warning: 0, info: 0 },
			healthScore: 80,
		},
		criticalPath: [],
		hotspots: methods,
		patterns: [pattern],
		appBreakdown: [],
		objectBreakdown: [
			{
				objectType: "Codeunit",
				objectName: "StubCodeunit",
				objectId: 50000,
				appName: "StubApp",
				selfTime: 10_000,
				selfTimePercent: 100,
				totalTime: 10_000,
				methodCount: methods.length,
				methods,
			},
		],
	};
}

function makeRun(
	overrides: Partial<RunMetadata> &
		Pick<RunMetadata, "profileId" | "captureTime">,
): RunMetadata {
	return {
		tenant: "wf-payoff",
		stream: "nightly",
		captureKind: "sampling",
		...overrides,
	};
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

// ---------------------------------------------------------------------------
// Task 3 payoff: applying identity upgrades before evaluateRun (fpwire
// phase-2). The whole point of the plan — a confidently-matched anchor
// upgrade must CONTINUE a finding's history, not fork it.
// ---------------------------------------------------------------------------

describe("apply identity upgrades before evaluateRun (Task 3 payoff)", () => {
	test("a confidently-matched anchor upgrade CONTINUES the finding's history — one finding, not a duplicate — and capture requests / sink mappings follow", async () => {
		const stubBin = makeStubBinary("findings");
		const tenant = "wf-payoff";
		const methods = makeMethodBreakdowns();
		const store = new LifecycleStore(":memory:");
		try {
			// Run 1: non-fused evaluate — the fallback fingerprint analyzeProfile
			// itself would mint (fingerprintPatterns with no attributions).
			const pattern1 = makePattern();
			fingerprintPatterns([pattern1], methods);
			const F1 = pattern1.fingerprint as string;
			expect(F1).toMatch(/^pattern:[0-9a-f]{16}$/);

			const outcome1 = evaluateRun(
				store,
				makeAnalysisResult(pattern1, methods),
				makeRun({
					tenant,
					profileId: "run-1",
					captureTime: "2026-07-01T00:00:00Z",
				}),
			);
			expect(outcome1.transitions).toHaveLength(1);
			expect(outcome1.transitions[0]?.event).toBe("first-seen");
			const findingId = store.getActiveFinding(tenant, F1)?.id;
			expect(findingId).toBeDefined();
			expect(store.countOccurrences(findingId as number)).toBe(1);

			// Seed a capture request and a sink issue mapping under F1 — both must
			// follow the finding when its identity is upgraded (ties Task 1's
			// capture_requests rekey into this end-to-end story).
			store.putIssueMapping({
				tenant,
				sink: "github",
				fingerprint: F1,
				externalId: "101",
				createdAt: "2026-07-01T00:00:00Z",
			});
			store.createCaptureRequest({
				tenant,
				fingerprint: F1,
				findingId: findingId as number,
				appId: "",
				appName: null,
				objectType: "codeunit",
				objectId: 50000,
				methodName: "processline",
				reason: "test capture ask",
				requestedAt: "2026-07-01T00:00:00Z",
				expiresAt: "2026-07-15T00:00:00Z",
			});

			// Run 2: fused evaluate — the anchor now confidently matches, so
			// fuseProfile re-mints pattern2's fingerprint IN PLACE to the stable
			// identity and surfaces the {F1 -> F2} identityUpgrade. The migration
			// is applied BEFORE evaluateRun consumes the upgraded fingerprint —
			// order is the entire point.
			const pattern2 = makePattern();
			fingerprintPatterns([pattern2], methods); // fresh mint always starts at the fallback
			expect(pattern2.fingerprint).toBe(F1);

			const fuseResult2 = await fuseProfile(methods, WS_MIN, {
				engine: stubBin,
				patterns: [pattern2],
			});
			if (!isFusedModel(fuseResult2)) throw new Error("expected FusedModel");
			expect(fuseResult2.identityUpgrades).toHaveLength(1);
			const F2 = pattern2.fingerprint as string;
			expect(F2).not.toBe(F1);

			const outcomes2 = applyIdentityUpgrades(
				store,
				tenant,
				fuseResult2.identityUpgrades ?? [],
				"2026-07-02T00:00:00Z",
			);
			expect(outcomes2).toEqual(["renamed"]);

			const outcome2 = evaluateRun(
				store,
				makeAnalysisResult(pattern2, methods),
				makeRun({
					tenant,
					profileId: "run-2",
					captureTime: "2026-07-02T00:00:00Z",
				}),
			);
			// A CONTINUATION (state advances new -> open), never a fresh "first-seen".
			expect(outcome2.transitions).toHaveLength(1);
			expect(outcome2.transitions[0]?.event).not.toBe("first-seen");
			expect(outcome2.transitions[0]?.findingId).toBe(findingId as number);

			// ONE finding total: renamed to F2, none left behind at F1.
			expect(store.getActiveFinding(tenant, F1)).toBeNull();
			expect(store.getActiveFinding(tenant, F2)?.id).toBe(findingId);
			expect(store.countOccurrences(findingId as number)).toBe(2);
			expect(store.listFindings({ tenant, limit: 100 })).toHaveLength(1);

			// The capture request and sink mapping followed the rename.
			expect(store.getIssueMapping(tenant, "github", F1)).toBeNull();
			const rekeyedMapping = store.getIssueMapping(tenant, "github", F2);
			expect(rekeyedMapping?.externalId).toBe("101");

			const requests = store.listCaptureRequests(tenant);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.fingerprint).toBe(F2);

			// Idempotency: a THIRD run repeats the same fused-evaluate sequence —
			// a FRESH pattern object minted to the same fallback F1, exactly as a
			// real subsequent `lifecycle evaluate` invocation would produce (each
			// invocation re-analyzes from scratch; nothing persists the upgrade
			// on the pattern object itself). The migration record already exists,
			// so applying it again is a no-op (F1 has no active finding anymore);
			// the finding is simply seen again under F2, not duplicated.
			const pattern3 = makePattern();
			fingerprintPatterns([pattern3], methods);
			expect(pattern3.fingerprint).toBe(F1);

			const fuseResult3 = await fuseProfile(methods, WS_MIN, {
				engine: stubBin,
				patterns: [pattern3],
			});
			if (!isFusedModel(fuseResult3)) throw new Error("expected FusedModel");
			expect(fuseResult3.identityUpgrades).toEqual([
				{
					patternId: "repeated-siblings",
					from: parseFingerprint(F1),
					to: parseFingerprint(F2),
				},
			]);

			const outcomes3 = applyIdentityUpgrades(
				store,
				tenant,
				fuseResult3.identityUpgrades ?? [],
				"2026-07-03T00:00:00Z",
			);
			expect(outcomes3).toEqual(["no-op"]);

			const outcome3 = evaluateRun(
				store,
				makeAnalysisResult(pattern3, methods),
				makeRun({
					tenant,
					profileId: "run-3",
					captureTime: "2026-07-03T00:00:00Z",
				}),
			);
			expect(outcome3.skipped).toBeUndefined();
			expect(store.countOccurrences(findingId as number)).toBe(3);
			expect(store.listFindings({ tenant, limit: 100 })).toHaveLength(1);
			expect(store.getActiveFinding(tenant, F1)).toBeNull();
			expect(store.getActiveFinding(tenant, F2)?.id).toBe(findingId);
		} finally {
			store.close();
		}
	}, 30_000);

	test("no-store path: fusion computes identityUpgrades without any LifecycleStore in scope — nothing to apply, nothing breaks (mirrors plain `analyze --source`, which never touches the lifecycle store)", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();
		const pattern = makePattern();
		fingerprintPatterns([pattern], methods);
		const fallbackFp = pattern.fingerprint;

		const fuseResult = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			patterns: [pattern],
		});
		if (!isFusedModel(fuseResult)) throw new Error("expected FusedModel");

		// The upgrade is fully computed and available to a caller that wants to
		// apply it — or, as here, a caller (the plain `analyze` CLI path) that
		// never constructs a LifecycleStore at all. Nothing in fuseProfile's
		// contract requires one.
		expect(fuseResult.identityUpgrades).toEqual([
			{
				patternId: "repeated-siblings",
				from: parseFingerprint(fallbackFp as string),
				to: parseFingerprint(pattern.fingerprint as string),
			},
		]);
	}, 30_000);
});
