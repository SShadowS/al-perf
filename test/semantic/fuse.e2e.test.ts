/**
 * fuse.e2e.test.ts — End-to-end tests for fuseProfile (Phase P1c).
 *
 * Groups:
 *   (a) Committed-golden path (no binary): parse the committed ws-min goldens,
 *       call correlate directly → assert expected FusedModel.
 *   (b) Fusion-off / binary-absent: fuseProfile with {fusion:false} → {disabled};
 *       verify the existing profile-only output path is byte-unchanged.
 *   (c) GATED real-binary (AL_SEM_BIN set): fuseProfile end-to-end over ws-min →
 *       FusedModel matching the committed-golden expectation.
 *   (d) CLI wiring: invoke fuseProfile with --no-fusion equivalent → no summary
 *       produced; with fusion on (gated) → summary line present.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type {
	AnalyzeReport,
	CoverageEntry,
	InventoryDoc,
} from "../../src/semantic/contracts.js";
import { correlate } from "../../src/semantic/correlate.js";
import type { EngineAnalysis } from "../../src/semantic/engine-runner.js";
import { clearEngineCache } from "../../src/semantic/engine-runner.js";
import { formatFusionSummary, fuseProfile } from "../../src/semantic/fuse.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { FusedModel } from "../../src/types/fused.js";

// ---------------------------------------------------------------------------
// Constants + paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");
const STUB_TS = resolve(FIXTURE_DIR, "alsem-stub.ts");
const CLI = resolve(import.meta.dir, "../../src/cli/index.ts");
const SAMPLE_PROFILE = resolve(
	import.meta.dir,
	"../fixtures/sampling-minimal.alcpuprofile",
);
const BUN_EXE = process.execPath;

const AL_SEM_BIN = process.env.AL_SEM_BIN;

const WS_MIN_APP_GUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFusedModel(result: unknown): result is FusedModel {
	return (
		typeof result === "object" &&
		result !== null &&
		"attributions" in result &&
		"correlationSummary" in result
	);
}

function isDisabled(
	result: unknown,
): result is { disabled: true; reason: string } {
	return (
		typeof result === "object" &&
		result !== null &&
		"disabled" in result &&
		(result as { disabled: unknown }).disabled === true
	);
}

// Temp dirs created for stub launchers; cleaned up after each test.
let cleanups: Array<() => void> = [];
afterEach(() => {
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
 * Build a platform-appropriate launcher that runs the committed `alsem-stub.ts`
 * via the current bun executable in "ok" mode, forwarding all args. Returns the
 * launcher path — a single resolvable binary the analyze CLI will spawn when we
 * point AL_SEM_BIN at it (binary-free fusion-on).
 */
function makeStubBinary(): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-fuse-stub-"));
	cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
	if (process.platform === "win32") {
		const cmdPath = join(tmpDir, "alsem-stub.cmd");
		writeFileSync(
			cmdPath,
			`@echo off\r\nset "ALSEM_STUB_MODE=ok"\r\n"${BUN_EXE}" "${STUB_TS}" %*\r\n`,
		);
		return cmdPath;
	}
	const shPath = join(tmpDir, "alsem-stub.sh");
	writeFileSync(
		shPath,
		`#!/bin/sh\nexport ALSEM_STUB_MODE='ok'\nexec "${BUN_EXE}" "${STUB_TS}" "$@"\n`,
	);
	chmodSync(shPath, 0o755);
	return shPath;
}

/** Spawn the analyze CLI; return { stdout, stderr, exitCode }. */
async function runAnalyzeCli(
	args: string[],
	env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn([BUN_EXE, "run", CLI, "analyze", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { stdout, stderr, exitCode: proc.exitCode ?? -1 };
}

/**
 * Normalize the analyze JSON stdout for a byte-diff: strip the per-run
 * `meta.analyzedAt` timestamp and the P2.0 `fusionViews` block (which is
 * intentionally additive when fusion runs) so the diff reflects ONLY
 * fusion's effect on the core profile analysis (which must be: none).
 */
function normalizeProfileStdout(stdout: string): string {
	let s = stdout.replace(
		/"analyzedAt":\s*"[^"]*"/g,
		'"analyzedAt": "<normalized>"',
	);
	// P2.0: strip the fusionViews block (present only when fusion ran) so the
	// core-analysis byte-identity assertion is not perturbed by the new field.
	try {
		const parsed = JSON.parse(s);
		delete parsed.fusionViews;
		s = JSON.stringify(parsed, null, 2);
	} catch {
		// not valid JSON — fall through with original string
	}
	return s;
}

/** The canonical method key for a method (mirrors aggregator.ts:63). */
const BLIND_SPOT_KEY = "DanglingProc_Codeunit_50199";

/**
 * Build a realistic set of MethodBreakdowns matching the ws-min fixture:
 *  - ProcessRecords: the hot db-op-in-loop method        → matched (with findings)
 *  - CleanProcedure: a clean routine                     → matched-clean
 *  - OverloadedProc: two universe routines               → ambiguous
 *  - DanglingProc:   an AL routine ABSENT from the universe (Codeunit 50199 is
 *                    NOT in the ws-min inventory)         → blind-spot (positive)
 *  - OnRun (builtin): isBuiltin=true                      → filtered out entirely
 */
function makeWsMinMethods(): MethodBreakdown[] {
	const base = {
		objectType: "Codeunit",
		objectName: "Foo",
		objectId: 50100,
		appName: "FusionMinimal",
		calledBy: [],
		calls: [],
		costPerHit: 100,
		efficiencyScore: 1.0,
	};
	return [
		{
			...base,
			functionName: "ProcessRecords",
			selfTime: 5000,
			selfTimePercent: 50,
			totalTime: 5000,
			totalTimePercent: 50,
			hitCount: 10,
		},
		{
			...base,
			functionName: "CleanProcedure",
			selfTime: 1000,
			selfTimePercent: 10,
			totalTime: 1000,
			totalTimePercent: 10,
			hitCount: 5,
		},
		{
			...base,
			functionName: "OverloadedProc",
			selfTime: 800,
			selfTimePercent: 8,
			totalTime: 800,
			totalTimePercent: 8,
			hitCount: 4,
		},
		{
			// A genuine AL routine (not builtin, not SQL) on an object that al-sem
			// never analyzed (Codeunit 50199 is absent from the ws-min universe).
			// → positive blind-spot.
			functionName: "DanglingProc",
			objectType: "Codeunit",
			objectName: "Ghost",
			objectId: 50199,
			appName: "FusionMinimal",
			selfTime: 300,
			selfTimePercent: 3,
			totalTime: 300,
			totalTimePercent: 3,
			hitCount: 3,
			calledBy: [],
			calls: [],
			costPerHit: 100,
			efficiencyScore: 1.0,
		},
		{
			// Builtin — should be excluded (isBuiltin=true)
			functionName: "OnRun",
			objectType: "Codeunit",
			objectName: "System",
			objectId: 1,
			appName: "Microsoft",
			selfTime: 200,
			selfTimePercent: 2,
			totalTime: 200,
			totalTimePercent: 2,
			hitCount: 2,
			calledBy: [],
			calls: [],
			costPerHit: 100,
			efficiencyScore: 1.0,
			isBuiltin: true,
		},
	];
}

/**
 * Parse the committed golden files and build an EngineAnalysis, mirroring what
 * runEngine would produce (without invoking a binary).
 */
async function loadGoldenEngineAnalysis(): Promise<EngineAnalysis> {
	const invRaw = await Bun.file(
		resolve(FIXTURE_DIR, "ws-min.inventory.json"),
	).text();
	const anaRaw = await Bun.file(
		resolve(FIXTURE_DIR, "ws-min.analyze.json"),
	).text();

	const inv = JSON.parse(invRaw) as InventoryDoc;
	const ana = JSON.parse(anaRaw) as AnalyzeReport;

	const opaqueApps: string[] = ana.payload.summary.opaqueApps ?? [];

	// Sort findings by (fingerprint, id) as the runner would.
	const findings = [...ana.payload.findings].sort((a, b) => {
		const fp = a.fingerprint.localeCompare(b.fingerprint);
		if (fp !== 0) return fp;
		return a.id.localeCompare(b.id);
	});

	return {
		routines: inv.payload.routineInventory,
		findings,
		apps: inv.payload.apps,
		coverage: inv.payload.coverage,
		coverageSubjects: inv.payload.coverage.map((c: CoverageEntry) => c.subject),
		primaryApp: inv.payload.apps[0],
		alsemVersion: inv.alsemVersion,
		diagnostics: [...inv.diagnostics, ...ana.diagnostics],
		coverageDegraded: opaqueApps.length > 0,
		opaqueApps,
	};
}

// ---------------------------------------------------------------------------
// (a) Committed-golden path (no binary required)
// ---------------------------------------------------------------------------

describe("fuseProfile: committed-golden path (no binary)", () => {
	test("correlate with ws-min goldens produces expected FusedModel", async () => {
		const methods = makeWsMinMethods();
		const engine = await loadGoldenEngineAnalysis();
		const model = correlate(methods, engine);

		// ProcessRecords: matched with findings (d1 + 2×d10)
		const prKey = "ProcessRecords_Codeunit_50100";
		expect(model.attributions.has(prKey)).toBe(true);
		const prAttr = model.attributions.get(prKey)!;
		expect(prAttr.status).toBe("matched");
		expect(prAttr.attributionConfidence).toBe("exact");
		expect(prAttr.findings.length).toBeGreaterThanOrEqual(1);
		const d1 = prAttr.findings.find((f) => f.detector === "d1-db-op-in-loop");
		expect(d1).toBeDefined();
		expect(prAttr.stableRoutineId).toBeString();
		// Not matched-clean (has findings)
		expect(prAttr.matchedClean).toBeFalsy();

		// CleanProcedure: matched-clean (in universe, no findings for this routine)
		const cleanKey = "CleanProcedure_Codeunit_50100";
		expect(model.attributions.has(cleanKey)).toBe(true);
		const cleanAttr = model.attributions.get(cleanKey)!;
		expect(cleanAttr.status).toBe("matched");
		// Coverage is complete in ws-min goldens → matchedClean=true
		expect(cleanAttr.matchedClean).toBe(true);
		expect(cleanAttr.findings).toEqual([]);

		// OverloadedProc: ambiguous (2 universe entries)
		const ovKey = "OverloadedProc_Codeunit_50100";
		expect(model.attributions.has(ovKey)).toBe(true);
		const ovAttr = model.attributions.get(ovKey)!;
		expect(ovAttr.status).toBe("ambiguous");
		expect(ovAttr.attributionConfidence).toBe("ambiguous");
		expect(Array.isArray(ovAttr.stableRoutineId)).toBe(true);
		expect((ovAttr.stableRoutineId as string[]).length).toBe(2);

		// DanglingProc on Codeunit 50199: a real AL routine NOT in the ws-min
		// universe → POSITIVELY assert status="blind-spot" + a reason (the 4th
		// status, otherwise unverified).
		expect(model.attributions.has(BLIND_SPOT_KEY)).toBe(true);
		const bsAttr = model.attributions.get(BLIND_SPOT_KEY)!;
		expect(bsAttr.status).toBe("blind-spot");
		expect(bsAttr.findings).toEqual([]);
		expect(bsAttr.reason).toBeString();
		expect((bsAttr.reason ?? "").length).toBeGreaterThan(0);
		// 50199 was never analyzed → reason names the un-analyzed object, NOT a
		// "routine absent from inventory" (which would imply the object WAS covered).
		expect(bsAttr.reason ?? "").toMatch(/was not analyzed/i);

		// Builtin (OnRun) must NOT appear in the attribution map
		expect(model.attributions.has("OnRun_Codeunit_1")).toBe(false);

		// No mismatch (there is intersection)
		expect(model.mismatch).toBeUndefined();

		// Correlation summary sanity
		const s = model.correlationSummary;
		expect(s.matched).toBeGreaterThanOrEqual(1); // ProcessRecords + CleanProcedure
		expect(s.ambiguous).toBeGreaterThanOrEqual(1); // OverloadedProc
		expect(s.blindSpot).toBeGreaterThanOrEqual(1); // DanglingProc (positive)
	});

	test("correlate findings are byte-stable (determinism)", async () => {
		const methods = makeWsMinMethods();
		const engine = await loadGoldenEngineAnalysis();

		const run1 = correlate(methods, engine);
		const run2 = correlate(methods, engine);

		// The maps are separate objects but encode identically.
		const toSortedPairs = (m: Map<string, unknown>) =>
			JSON.stringify([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));

		expect(toSortedPairs(run1.attributions)).toBe(
			toSortedPairs(run2.attributions),
		);
		expect(JSON.stringify(run1.correlationSummary)).toBe(
			JSON.stringify(run2.correlationSummary),
		);
		expect(run1.coldFindings.map((f) => f.id)).toEqual(
			run2.coldFindings.map((f) => f.id),
		);
	});

	test("ProcessRecords findings are sorted by (fingerprint, id)", async () => {
		const methods = makeWsMinMethods();
		const engine = await loadGoldenEngineAnalysis();
		const model = correlate(methods, engine);

		const prAttr = model.attributions.get("ProcessRecords_Codeunit_50100")!;
		const fps = prAttr.findings.map((f) => f.fingerprint);
		const sorted = [...fps].sort((a, b) => a.localeCompare(b));
		expect(fps).toEqual(sorted);
	});
});

// ---------------------------------------------------------------------------
// (b) Fusion-off / binary-absent
// ---------------------------------------------------------------------------

describe("fuseProfile: fusion-off / binary-absent", () => {
	test("{fusion:false} returns disabled immediately without touching the engine", async () => {
		const methods = makeWsMinMethods();
		// Pass a nonexistent binary path — must NOT be invoked because fusion=false.
		const result = await fuseProfile(methods, WS_MIN, {
			fusion: false,
			engine: "/nonexistent/alsem",
		});
		expect(isDisabled(result)).toBe(true);
		if (isDisabled(result)) {
			expect(result.reason).toContain("fusion disabled");
		}
	});

	test("binary-absent → disabled gracefully", async () => {
		const methods = makeWsMinMethods();
		const result = await fuseProfile(methods, WS_MIN, {
			engine: "/nonexistent/alsem.exe",
		});
		expect(isDisabled(result)).toBe(true);
		if (isDisabled(result)) {
			expect(result.reason).toMatch(/not found/i);
		}
	});

	test("existing profile-only output is unchanged when fusion is off", async () => {
		// Verify that fuseProfile with fusion=false returns {disabled} and does not
		// modify or side-effect anything used by the existing formatAnalysis path.
		// The fusedModel itself is the sidecar — it has no reference back into
		// AnalysisResult. This is a smoke-check of the additive nature.
		const methods = makeWsMinMethods();
		const result = await fuseProfile(methods, WS_MIN, { fusion: false });
		// The result is purely the disabled sentinel; nothing else changed.
		expect(isDisabled(result)).toBe(true);
		expect(isFusedModel(result)).toBe(false);
		// The methods array is untouched (no mutation by fuseProfile).
		expect(methods.length).toBe(makeWsMinMethods().length);
		expect(methods[0].functionName).toBe("ProcessRecords");
	});

	test("fuseProfile never throws even with an invalid workspace path", async () => {
		const methods = makeWsMinMethods();
		let threw = false;
		try {
			await fuseProfile(methods, "/nonexistent/workspace/dir", {
				engine: "/nonexistent/alsem",
			});
		} catch {
			threw = true;
		}
		// Must degrade gracefully, never throw.
		expect(threw).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (c) GATED real-binary (AL_SEM_BIN set)
// ---------------------------------------------------------------------------

describe("fuseProfile: real-binary end-to-end (gated: AL_SEM_BIN)", () => {
	test.skipIf(!AL_SEM_BIN)(
		"fuseProfile over ws-min returns a FusedModel matching the golden expectation",
		async () => {
			clearEngineCache();
			const methods = makeWsMinMethods();
			const result = await fuseProfile(methods, WS_MIN, {
				engine: AL_SEM_BIN,
				timeoutMs: 60_000,
			});

			expect(isFusedModel(result)).toBe(true);
			if (!isFusedModel(result)) return;

			// ProcessRecords: matched with d1 finding
			const prAttr = result.attributions.get("ProcessRecords_Codeunit_50100");
			expect(prAttr).toBeDefined();
			expect(prAttr!.status).toBe("matched");
			expect(prAttr!.findings.length).toBeGreaterThanOrEqual(1);
			const d1 = prAttr!.findings.find(
				(f) => f.detector === "d1-db-op-in-loop",
			);
			expect(d1).toBeDefined();

			// OverloadedProc: ambiguous
			const ovAttr = result.attributions.get("OverloadedProc_Codeunit_50100");
			expect(ovAttr).toBeDefined();
			expect(ovAttr!.status).toBe("ambiguous");

			// Engine metadata present
			expect(result.engine.alsemVersion).toBeString();
			expect(result.engine.alsemVersion.length).toBeGreaterThan(0);
		},
	);

	test.skipIf(!AL_SEM_BIN)(
		"real-binary FusedModel matches the committed-golden correlate output",
		async () => {
			clearEngineCache();
			const methods = makeWsMinMethods();

			// Live run via the real binary
			const liveResult = await fuseProfile(methods, WS_MIN, {
				engine: AL_SEM_BIN,
				timeoutMs: 60_000,
			});
			expect(isFusedModel(liveResult)).toBe(true);
			if (!isFusedModel(liveResult)) return;

			// Golden run via the committed JSON files
			const goldenEngine = await loadGoldenEngineAnalysis();
			const goldenModel = correlate(methods, goldenEngine);

			// Both should agree on the same correlation summary
			expect(liveResult.correlationSummary.matched).toBe(
				goldenModel.correlationSummary.matched,
			);
			expect(liveResult.correlationSummary.ambiguous).toBe(
				goldenModel.correlationSummary.ambiguous,
			);
			expect(liveResult.correlationSummary.blindSpot).toBe(
				goldenModel.correlationSummary.blindSpot,
			);

			// ProcessRecords: same detector set
			const livePr = liveResult.attributions.get(
				"ProcessRecords_Codeunit_50100",
			)!;
			const goldPr = goldenModel.attributions.get(
				"ProcessRecords_Codeunit_50100",
			)!;
			const liveDetectors = livePr.findings.map((f) => f.detector).sort();
			const goldDetectors = goldPr.findings.map((f) => f.detector).sort();
			expect(liveDetectors).toEqual(goldDetectors);
		},
	);
});

// ---------------------------------------------------------------------------
// (d) formatFusionSummary — the exact one-line summary string (unit-testable)
// ---------------------------------------------------------------------------

describe("formatFusionSummary: exact one-line string", () => {
	test("renders matched/ambiguous/clean/blind-spot counts in the documented format", async () => {
		const methods = makeWsMinMethods();
		const engine = await loadGoldenEngineAnalysis();
		const model = correlate(methods, engine);

		const line = formatFusionSummary(model);
		const s = model.correlationSummary;
		const findingsCount = [...model.attributions.values()].reduce(
			(sum, a) => sum + a.findings.length,
			0,
		);

		// Byte-exact format check.
		expect(line).toBe(
			`al-sem fusion: ${s.matched + s.ambiguous} hotspots correlated` +
				` (${findingsCount} findings),` +
				` ${s.matchedClean} clean,` +
				` ${s.ambiguous} ambiguous,` +
				` ${s.blindSpot} blind-spots`,
		);
		// And the literal prefix/structure is present (catches a silent regression).
		expect(line).toStartWith("al-sem fusion: ");
		expect(line).toContain("hotspots correlated");
		expect(line).toContain("clean,");
		expect(line).toContain("ambiguous,");
		expect(line).toContain("blind-spots");
	});

	test("N = matched + ambiguous (the correlated headline)", async () => {
		const methods = makeWsMinMethods();
		const engine = await loadGoldenEngineAnalysis();
		const model = correlate(methods, engine);
		const s = model.correlationSummary;

		const line = formatFusionSummary(model);
		expect(line).toContain(`${s.matched + s.ambiguous} hotspots correlated`);
	});
});

// ---------------------------------------------------------------------------
// (d') CLI wiring: real `analyze` command spawns (the actual stdout byte-diff)
// ---------------------------------------------------------------------------

describe("analyze CLI: fusion wiring (real spawn)", () => {
	test("--no-fusion → no fusion line on stderr; clean exit", async () => {
		const { stdout, stderr, exitCode } = await runAnalyzeCli(
			[SAMPLE_PROFILE, "-f", "json", "--source", WS_MIN, "--no-fusion"],
			// Even with a binary configured, --no-fusion must short-circuit.
			{ AL_SEM_BIN: makeStubBinary() },
		);
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("al-sem fusion:");
		// stdout is the profile JSON.
		expect(() => JSON.parse(stdout)).not.toThrow();
	});

	test("fusion-on (stub binary) → summary line on STDERR; core stdout byte-IDENTICAL to --no-fusion; fusionViews added (P2.0)", async () => {
		const stubBin = makeStubBinary();

		// Run 1: fusion OFF (explicit --no-fusion).
		const off = await runAnalyzeCli(
			[SAMPLE_PROFILE, "-f", "json", "--source", WS_MIN, "--no-fusion"],
			{ AL_SEM_BIN: stubBin },
		);
		// Run 2: fusion ON (binary present via AL_SEM_BIN, no --no-fusion).
		const on = await runAnalyzeCli(
			[SAMPLE_PROFILE, "-f", "json", "--source", WS_MIN],
			{ AL_SEM_BIN: stubBin },
		);

		expect(off.exitCode).toBe(0);
		expect(on.exitCode).toBe(0);

		// (i) Core profile analysis is byte-identical (modulo analyzedAt and the P2.0
		// additive fusionViews field). normalizeProfileStdout strips both.
		expect(normalizeProfileStdout(on.stdout)).toBe(
			normalizeProfileStdout(off.stdout),
		);

		// (i-b) P2.0: fusionViews IS present in fusion-on output, absent in fusion-off.
		const onParsed = JSON.parse(on.stdout);
		const offParsed = JSON.parse(off.stdout);
		expect(onParsed.fusionViews).toBeDefined();
		expect(offParsed.fusionViews).toBeUndefined();

		// (ii) The summary line appears on STDERR ONLY when fusion ran.
		expect(off.stderr).not.toContain("al-sem fusion:");
		expect(on.stderr).toContain("al-sem fusion:");
		// The stub emits a valid (empty-findings) envelope → a "correlated" line,
		// never a "disabled" line.
		expect(on.stderr).toContain("hotspots correlated");
		expect(on.stderr).not.toContain("al-sem fusion: disabled");
	});

	test("zip/non-app.json --source → no fusion attempt, no crash, clean stdout", async () => {
		// FIXTURE_DIR is a directory WITHOUT an app.json (the goldens live there,
		// not an AL workspace) → isAlWorkspaceDir() is false → fusion not attempted.
		const { stdout, stderr, exitCode } = await runAnalyzeCli(
			[SAMPLE_PROFILE, "-f", "json", "--source", FIXTURE_DIR],
			{ AL_SEM_BIN: makeStubBinary() },
		);
		expect(exitCode).toBe(0);
		// No fusion line at all (neither summary nor disabled) — the guard skipped it.
		expect(stderr).not.toContain("al-sem fusion:");
		expect(() => JSON.parse(stdout)).not.toThrow();
	});

	test("fusion-on but binary ABSENT → single quiet 'disabled' note on stderr; stdout unchanged", async () => {
		// No --no-fusion, --source IS a workspace, but the configured binary path
		// does not exist → fuseProfile returns {disabled} → one stderr note.
		const off = await runAnalyzeCli(
			[SAMPLE_PROFILE, "-f", "json", "--source", WS_MIN, "--no-fusion"],
			{ AL_SEM_BIN: "/nonexistent/alsem-binary" },
		);
		const on = await runAnalyzeCli(
			[SAMPLE_PROFILE, "-f", "json", "--source", WS_MIN],
			{ AL_SEM_BIN: "/nonexistent/alsem-binary" },
		);
		expect(on.exitCode).toBe(0);
		// stdout still byte-identical (binary-absent must not perturb output;
		// modulo the per-run analyzedAt timestamp).
		expect(normalizeProfileStdout(on.stdout)).toBe(
			normalizeProfileStdout(off.stdout),
		);
		// A single quiet disabled note, not a crash.
		expect(on.stderr).toContain("al-sem fusion: disabled");
	});
});

// ---------------------------------------------------------------------------
// (d'') CLI wiring: library-level integration points
// ---------------------------------------------------------------------------

describe("fuseProfile: CLI wiring behaviour (library level)", () => {
	test("--no-fusion equivalent: {fusion:false} → no FusedModel produced", async () => {
		const methods = makeWsMinMethods();
		const result = await fuseProfile(methods, WS_MIN, { fusion: false });

		// The disabled sentinel is returned; no FusedModel
		expect(isDisabled(result)).toBe(true);
		expect(isFusedModel(result)).toBe(false);
	});

	test("non-workspace source → disabled (engine would fail/be skipped)", async () => {
		const methods = makeWsMinMethods();
		// A dir without app.json → the CLI guard would skip; at the library level
		// a missing binary yields disabled.
		const result = await fuseProfile(methods, FIXTURE_DIR, {
			engine: "/nonexistent/alsem",
		});
		expect(isDisabled(result)).toBe(true);
	});

	test.skipIf(!AL_SEM_BIN)(
		"with fusion on and workspace present → FusedModel with summary data",
		async () => {
			clearEngineCache();
			const methods = makeWsMinMethods();
			const result = await fuseProfile(methods, WS_MIN, {
				engine: AL_SEM_BIN,
				timeoutMs: 60_000,
			});

			expect(isFusedModel(result)).toBe(true);
			if (!isFusedModel(result)) return;

			// All the summary fields needed for the one-line CLI summary are present
			const s = result.correlationSummary;
			expect(typeof s.matched).toBe("number");
			expect(typeof s.matchedClean).toBe("number");
			expect(typeof s.ambiguous).toBe("number");
			expect(typeof s.blindSpot).toBe("number");
			expect(typeof s.coldCount).toBe("number");

			// The total correlated count (matched + ambiguous) is reported in the CLI line
			const correlated = s.matched + s.ambiguous;
			expect(correlated).toBeGreaterThanOrEqual(1);
		},
	);
});

// ---------------------------------------------------------------------------
// (e) FusedModel structure: the side-map contract (not a MethodBreakdown intersection)
// ---------------------------------------------------------------------------

describe("fuseProfile: FusedModel is a side-map (additive sidecar)", () => {
	test("attributions is a Map keyed by the canonical method key", async () => {
		const methods = makeWsMinMethods();
		const engine = await loadGoldenEngineAnalysis();
		const model = correlate(methods, engine);

		// Map<string, SemanticAttribution>
		expect(model.attributions instanceof Map).toBe(true);

		// Keys follow the ${functionName}_${objectType}_${objectId} pattern
		for (const key of model.attributions.keys()) {
			expect(key).toMatch(/^.+_.+_\d+$/);
		}
	});

	test("input methods array is not mutated by correlate", async () => {
		const methods = makeWsMinMethods();
		const methodsBefore = JSON.stringify(methods);

		const engine = await loadGoldenEngineAnalysis();
		correlate(methods, engine);

		expect(JSON.stringify(methods)).toBe(methodsBefore);
	});

	test("FusedModel carries engine metadata", async () => {
		const methods = makeWsMinMethods();
		const engine = await loadGoldenEngineAnalysis();
		const model = correlate(methods, engine);

		expect(model.engine.alsemVersion).toBe("0.0.12");
		expect(model.engine.primaryApp?.appGuid).toBe(WS_MIN_APP_GUID);
		expect(model.engine.primaryApp?.name).toBe("FusionMinimal");
	});
});
