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
import {
	appVersionForApp,
	compareProfiles,
	normalizeAppGuid,
} from "../../src/core/analyzer.js";
import { parseProfileFromRaw } from "../../src/core/parser.js";
import type { DiffAnalysis } from "../../src/semantic/diff-runner.js";
import { runEngineDiff } from "../../src/semantic/diff-runner.js";
import { correlateRegressions } from "../../src/semantic/regression-correlate.js";
import type { RawProfile } from "../../src/types/profile.js";

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
// Version guard — appVersionForApp matches the WORKSPACE app by appId,
// NOT the globally most-frequent (base/3rd-party) frame (P4.2 soundness fix).
// ---------------------------------------------------------------------------

/**
 * Build a synthetic multi-app sampling profile node.
 * `appId` may be dash-less hex (as real BC profiles emit).
 */
function makeNode(
	id: number,
	appId: string,
	appName: string,
	appVersion: string,
	children: number[] = [],
): RawProfile["nodes"][number] {
	return {
		id,
		callFrame: {
			functionName: `Fn${id}`,
			scriptId: `CodeUnit_${id}`,
			url: `al-preview://allang/Codeunit/${id}/x.dal`,
			lineNumber: 1,
			columnNumber: 1,
		},
		hitCount: 1,
		children,
		declaringApplication: {
			appId,
			appName,
			appPublisher: "pub",
			appVersion,
		},
		applicationDefinition: {
			objectType: "CodeUnit",
			objectName: `Obj${id}`,
			objectId: id,
		},
		frameIdentifier: id,
	};
}

describe("appVersionForApp — version guard matches workspace app by appId", () => {
	// The dashed workspace app.json id and the dash-less profile appId for the
	// SAME app (BC profiles often drop dashes).
	const EXT_ID_DASHED = "437dbf0e-84ff-417a-965d-ed2bb9650972";
	const EXT_ID_DASHLESS = "437dbf0e84ff417a965ded2bb9650972";
	const BASE_APP_ID = "63ca2fa4-4f03-4f2b-a480-172fef340d3f"; // Base Application

	test("multi-app profile: picks the EXTENSION's version, NOT the most-frequent base-app version", () => {
		// Base Application dominates by frequency (3 frames) — the extension is
		// low-frequency (1 frame). The OLD most-frequent logic would have returned
		// the Base Application version ("24.0.0.0"); the appId-matched guard MUST
		// return the extension's version ("2.1.0.0").
		const raw: RawProfile = {
			nodes: [
				makeNode(1, BASE_APP_ID, "Base Application", "24.0.0.0", [2]),
				makeNode(2, BASE_APP_ID, "Base Application", "24.0.0.0", [3]),
				makeNode(3, BASE_APP_ID, "Base Application", "24.0.0.0", [4]),
				// The target extension — low frequency, matches the workspace id.
				makeNode(4, EXT_ID_DASHLESS, "My Extension", "2.1.0.0"),
			],
			startTime: 0,
			endTime: 1000,
		};
		const parsed = parseProfileFromRaw(raw);

		// Match by the dashed workspace app.json id (GUID-normalized on both sides).
		const version = appVersionForApp(parsed, EXT_ID_DASHED);
		expect(version).toBe("2.1.0.0");
		expect(version).not.toBe("24.0.0.0");
	});

	test("GUID normalization: dash-less profile appId matches dashed app.json id", () => {
		const raw: RawProfile = {
			nodes: [makeNode(1, EXT_ID_DASHLESS, "My Extension", "3.0.0.0")],
			startTime: 0,
			endTime: 100,
		};
		const parsed = parseProfileFromRaw(raw);
		// Workspace id has dashes; profile appId does not — normalization bridges them.
		expect(appVersionForApp(parsed, EXT_ID_DASHED)).toBe("3.0.0.0");
		// And the reverse (dashed profile, dash-less workspace id) also matches.
		const raw2: RawProfile = {
			nodes: [makeNode(1, EXT_ID_DASHED, "My Extension", "3.0.0.0")],
			startTime: 0,
			endTime: 100,
		};
		const parsed2 = parseProfileFromRaw(raw2);
		expect(appVersionForApp(parsed2, EXT_ID_DASHLESS)).toBe("3.0.0.0");
	});

	test("no matching frame → undefined (NOT a fallback to most-frequent)", () => {
		const raw: RawProfile = {
			nodes: [
				makeNode(1, BASE_APP_ID, "Base Application", "24.0.0.0", [2]),
				makeNode(2, BASE_APP_ID, "Base Application", "24.0.0.0"),
			],
			startTime: 0,
			endTime: 100,
		};
		const parsed = parseProfileFromRaw(raw);
		// The workspace app simply isn't present in the profile → undefined,
		// NOT the (most-frequent) Base Application version.
		expect(appVersionForApp(parsed, EXT_ID_DASHED)).toBeUndefined();
	});

	test("undefined workspace id → undefined (never matches anything)", () => {
		const raw: RawProfile = {
			nodes: [makeNode(1, EXT_ID_DASHLESS, "My Extension", "3.0.0.0")],
			startTime: 0,
			endTime: 100,
		};
		const parsed = parseProfileFromRaw(raw);
		expect(appVersionForApp(parsed, undefined)).toBeUndefined();
	});

	test("normalizeAppGuid: strips dashes + lowercases; empty for undefined", () => {
		expect(normalizeAppGuid(EXT_ID_DASHED)).toBe(EXT_ID_DASHLESS);
		expect(normalizeAppGuid("ABC-DEF")).toBe("abcdef");
		expect(normalizeAppGuid(undefined)).toBe("");
		expect(normalizeAppGuid("")).toBe("");
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
