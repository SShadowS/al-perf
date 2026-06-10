/**
 * p4-wiring.test.ts — Tests for P4.2: three-tier fusion wiring in compareProfiles.
 *
 * Coverage:
 *  - both-sources tier: compareProfiles with both sources → regressionFusion attached.
 *  - after-only fallback: compareProfiles with only afterSource → afterFusionViews attached.
 *  - neither: compareProfiles with no sources → neither regressionFusion nor afterFusionViews
 *    (byte-unchanged).
 *  - graceful degradation: invalid/non-workspace source paths → no fusion, no throw.
 *  - Real-binary smoke (gated on alsem.exe existing): runEngineDiff against two corpus
 *    fixtures, confirm DiffAnalysis parses + correlateRegressions produces a RegressionFusion.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { compareProfiles } from "../../src/core/analyzer.js";
import type { DiffAnalysis } from "../../src/semantic/diff-runner.js";
import { runEngineDiff } from "../../src/semantic/diff-runner.js";
import { correlateRegressions } from "../../src/semantic/regression-correlate.js";

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");
const STUB_TS = resolve(FIXTURE_DIR, "alsem-stub.ts");
const BUN_EXE = process.execPath;

const FIXTURES = "test/fixtures";
const PROFILE = `${FIXTURES}/sampling-minimal.alcpuprofile`;

// Real-binary paths (for smoke tests).
const REAL_BIN = "U:/Git/alch-engine/target/release/alsem.exe";
const CORPUS_D1 = "U:/Git/alch-engine/tests/r0-corpus/ws-d1";
const CORPUS_D2 = "U:/Git/alch-engine/tests/r0-corpus/ws-d2";

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

function makeStubBinary(tmpDir: string, mode: string): string {
	if (process.platform === "win32") {
		const cmdPath = join(tmpDir, `alsem-stub-${mode}.cmd`);
		writeFileSync(
			cmdPath,
			`@echo off\r\nset "ALSEM_STUB_MODE=${mode}"\r\n"${BUN_EXE}" "${STUB_TS}" %*\r\n`,
		);
		return cmdPath;
	}
	const shPath = join(tmpDir, `alsem-stub-${mode}.sh`);
	writeFileSync(
		shPath,
		`#!/bin/sh\nexport ALSEM_STUB_MODE='${mode}'\nexec "${BUN_EXE}" "${STUB_TS}" "$@"\n`,
	);
	chmodSync(shPath, 0o755);
	return shPath;
}

// ---------------------------------------------------------------------------
// Tier: neither source → plain comparison (byte-unchanged)
// ---------------------------------------------------------------------------

describe("compareProfiles — neither source (byte-unchanged)", () => {
	test("no sources → regressionFusion and afterFusionViews both absent", async () => {
		const result = await compareProfiles(PROFILE, PROFILE);
		expect(result.regressionFusion).toBeUndefined();
		expect(result.afterFusionViews).toBeUndefined();
	});

	test("no sources → base fields present (meta, summary, regressions, etc.)", async () => {
		const result = await compareProfiles(PROFILE, PROFILE);
		expect(result.meta.beforePath).toBeTruthy();
		expect(result.meta.afterPath).toBeTruthy();
		expect(Array.isArray(result.regressions)).toBe(true);
		expect(Array.isArray(result.newMethods)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tier: after-only fallback (stub-backed)
// ---------------------------------------------------------------------------

describe("compareProfiles — after-only fallback (stub-backed)", () => {
	test("afterSource only → afterFusionViews attached (not regressionFusion)", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-p4-after-"));
		cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
		const bin = makeStubBinary(tmpDir, "findings");

		// Set AL_SEM_BIN to the stub (afterSource is ws-min, which is a valid workspace).
		const origBin = process.env.AL_SEM_BIN;
		process.env.AL_SEM_BIN = bin;
		try {
			const result = await compareProfiles(PROFILE, PROFILE, {
				afterSource: WS_MIN,
			});
			// afterFusionViews should be attached (stub emits findings).
			expect(result.afterFusionViews).toBeDefined();
			// regressionFusion must NOT be attached in this tier.
			expect(result.regressionFusion).toBeUndefined();
		} finally {
			if (origBin === undefined) {
				delete process.env.AL_SEM_BIN;
			} else {
				process.env.AL_SEM_BIN = origBin;
			}
		}
	});

	test("afterSource only → afterFusionViews has expected FusionViews shape", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-p4-shape-"));
		cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
		const bin = makeStubBinary(tmpDir, "findings");

		const origBin = process.env.AL_SEM_BIN;
		process.env.AL_SEM_BIN = bin;
		try {
			const result = await compareProfiles(PROFILE, PROFILE, {
				afterSource: WS_MIN,
			});
			expect(result.afterFusionViews).toBeDefined();
			if (result.afterFusionViews) {
				// FusionViews shape: hotspotAnnotations, prioritizedFindings, unweightedFindings, correlationSummary.
				expect(Array.isArray(result.afterFusionViews.hotspotAnnotations)).toBe(
					true,
				);
				expect(Array.isArray(result.afterFusionViews.prioritizedFindings)).toBe(
					true,
				);
				expect(Array.isArray(result.afterFusionViews.unweightedFindings)).toBe(
					true,
				);
				expect(result.afterFusionViews.correlationSummary).toBeDefined();
			}
		} finally {
			if (origBin === undefined) {
				delete process.env.AL_SEM_BIN;
			} else {
				process.env.AL_SEM_BIN = origBin;
			}
		}
	});

	test("afterSource non-workspace → no afterFusionViews, no throw", async () => {
		// Pass a path that is not a workspace (no app.json) — fusion should silently skip.
		const result = await compareProfiles(PROFILE, PROFILE, {
			afterSource: FIXTURES, // test/fixtures has no app.json
		});
		expect(result.afterFusionViews).toBeUndefined();
		expect(result.regressionFusion).toBeUndefined();
	});

	test("afterSource engine absent → no afterFusionViews, no throw", async () => {
		const origBin = process.env.AL_SEM_BIN;
		process.env.AL_SEM_BIN = "/no/such/binary.exe";
		try {
			const result = await compareProfiles(PROFILE, PROFILE, {
				afterSource: WS_MIN,
			});
			// Engine absent → disabled → afterFusionViews stays undefined.
			expect(result.afterFusionViews).toBeUndefined();
			// No throw — returns normally.
			expect(result.meta).toBeDefined();
		} finally {
			if (origBin === undefined) {
				delete process.env.AL_SEM_BIN;
			} else {
				process.env.AL_SEM_BIN = origBin;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Tier: both sources (stub-backed)
// ---------------------------------------------------------------------------

describe("compareProfiles — both sources (stub-backed)", () => {
	test("both sources → regressionFusion attached (not afterFusionViews)", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-p4-both-"));
		cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
		const bin = makeStubBinary(tmpDir, "diff");

		const origBin = process.env.AL_SEM_BIN;
		process.env.AL_SEM_BIN = bin;
		try {
			const result = await compareProfiles(PROFILE, PROFILE, {
				beforeSource: WS_MIN,
				afterSource: WS_MIN,
			});
			// regressionFusion should be attached.
			expect(result.regressionFusion).toBeDefined();
			// afterFusionViews must NOT be attached in the both-sources tier.
			expect(result.afterFusionViews).toBeUndefined();
		} finally {
			if (origBin === undefined) {
				delete process.env.AL_SEM_BIN;
			} else {
				process.env.AL_SEM_BIN = origBin;
			}
		}
	});

	test("both sources → regressionFusion has expected RegressionFusion shape", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-p4-shape2-"));
		cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
		const bin = makeStubBinary(tmpDir, "diff");

		const origBin = process.env.AL_SEM_BIN;
		process.env.AL_SEM_BIN = bin;
		try {
			const result = await compareProfiles(PROFILE, PROFILE, {
				beforeSource: WS_MIN,
				afterSource: WS_MIN,
			});
			expect(result.regressionFusion).toBeDefined();
			if (result.regressionFusion) {
				expect(
					Array.isArray(result.regressionFusion.annotatedRegressions),
				).toBe(true);
				expect(
					Array.isArray(result.regressionFusion.newMethodCorrelations),
				).toBe(true);
				expect(
					Array.isArray(result.regressionFusion.removedMethodCorrelations),
				).toBe(true);
				expect(Array.isArray(result.regressionFusion.staticOnlyChanges)).toBe(
					true,
				);
				expect(result.regressionFusion.correlationSummary).toBeDefined();
			}
		} finally {
			if (origBin === undefined) {
				delete process.env.AL_SEM_BIN;
			} else {
				process.env.AL_SEM_BIN = origBin;
			}
		}
	});

	test("both sources non-workspace → no regressionFusion, no throw", async () => {
		const result = await compareProfiles(PROFILE, PROFILE, {
			beforeSource: FIXTURES,
			afterSource: FIXTURES,
		});
		expect(result.regressionFusion).toBeUndefined();
		expect(result.afterFusionViews).toBeUndefined();
	});

	test("both sources engine absent → no regressionFusion, no throw", async () => {
		const origBin = process.env.AL_SEM_BIN;
		process.env.AL_SEM_BIN = "/no/such/binary.exe";
		try {
			const result = await compareProfiles(PROFILE, PROFILE, {
				beforeSource: WS_MIN,
				afterSource: WS_MIN,
			});
			expect(result.regressionFusion).toBeUndefined();
			expect(result.meta).toBeDefined();
		} finally {
			if (origBin === undefined) {
				delete process.env.AL_SEM_BIN;
			} else {
				process.env.AL_SEM_BIN = origBin;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Real-binary smoke (gated on alsem.exe existing)
// ---------------------------------------------------------------------------

const BINARY_AVAILABLE = existsSync(REAL_BIN);
const CORPUS_D1_AVAILABLE = existsSync(CORPUS_D1);
const CORPUS_D2_AVAILABLE = existsSync(CORPUS_D2);

describe("runEngineDiff — real-binary smoke (P4.2)", {
	skip: !BINARY_AVAILABLE || !CORPUS_D1_AVAILABLE || !CORPUS_D2_AVAILABLE,
}, () => {
	test("runEngineDiff on two corpus fixtures parses to DiffAnalysis", async () => {
		const result = await runEngineDiff(CORPUS_D1, CORPUS_D2, {
			engine: REAL_BIN,
			timeoutMs: 60_000,
		});
		// Must not be disabled.
		expect("disabled" in result).toBe(false);
		if ("disabled" in result) return;

		const analysis = result as DiffAnalysis;
		// DiffAnalysis shape: findings[], afterInventory[], beforeAppVersion?, afterAppVersion?, alsemVersion.
		expect(Array.isArray(analysis.findings)).toBe(true);
		expect(Array.isArray(analysis.afterInventory)).toBe(true);
		expect(typeof analysis.alsemVersion).toBe("string");
		// findings can be empty (ws-d1 vs ws-d2 may have zero diff) — that's a valid parse proof.
		// The key assertion is that the JSON parsed into the typed shape without throwing.
	}, 90_000);

	test("correlateRegressions on real diff output produces a RegressionFusion", async () => {
		const diff = await runEngineDiff(CORPUS_D1, CORPUS_D2, {
			engine: REAL_BIN,
			timeoutMs: 60_000,
		});
		expect("disabled" in diff).toBe(false);
		if ("disabled" in diff) return;

		const analysis = diff as DiffAnalysis;
		// Run correlateRegressions with empty regressions/new/removed (profile-independent).
		const fusion = correlateRegressions(
			{ regressions: [], newMethods: [], removedMethods: [] },
			analysis,
		);

		// RegressionFusion shape must always be produced.
		expect(Array.isArray(fusion.annotatedRegressions)).toBe(true);
		expect(Array.isArray(fusion.newMethodCorrelations)).toBe(true);
		expect(Array.isArray(fusion.removedMethodCorrelations)).toBe(true);
		expect(Array.isArray(fusion.staticOnlyChanges)).toBe(true);
		expect(typeof fusion.correlationSummary.correlated).toBe("number");
		expect(typeof fusion.correlationSummary.weaklyCorrelated).toBe("number");
		expect(typeof fusion.correlationSummary.unexplained).toBe("number");

		// staticOnlyChanges = all findings (no regressions to consume them).
		// This validates that the diff output was parsed and projected correctly.
		expect(fusion.staticOnlyChanges.length).toBe(analysis.findings.length);
	}, 90_000);

	test("same fixture twice → empty findings, valid DiffAnalysis (minimal smoke)", async () => {
		// Using the same fixture as both before and after → empty or near-empty diff.
		// This is the simplest possible real-binary smoke: proves the subprocess
		// invocation and JSON parse path work end-to-end.
		const result = await runEngineDiff(CORPUS_D1, CORPUS_D1, {
			engine: REAL_BIN,
			timeoutMs: 60_000,
		});
		expect("disabled" in result).toBe(false);
		if ("disabled" in result) return;

		const analysis = result as DiffAnalysis;
		// Same-fixture diff: no findings (byte-stable).
		expect(analysis.findings).toHaveLength(0);
		expect(Array.isArray(analysis.afterInventory)).toBe(true);
	}, 90_000);
});
