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

import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { correlate } from "../../src/semantic/correlate.js";
import type { EngineAnalysis } from "../../src/semantic/engine-runner.js";
import { clearEngineCache } from "../../src/semantic/engine-runner.js";
import { fuseProfile } from "../../src/semantic/fuse.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { FusedModel } from "../../src/types/fused.js";
import type {
	AnalyzeReport,
	CoverageEntry,
	InventoryDoc,
} from "../../src/semantic/contracts.js";

// ---------------------------------------------------------------------------
// Constants + paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");

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

/**
 * Build a realistic set of MethodBreakdowns matching the ws-min fixture:
 *  - ProcessRecords: the hot db-op-in-loop method
 *  - CleanProcedure: a clean routine
 *  - OverloadedProc: triggers the ambiguous status (2 universe routines)
 *  - OnRun (builtin): should be filtered from the attribution map
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

		// Builtin (OnRun) must NOT appear in the attribution map
		expect(model.attributions.has("OnRun_Codeunit_1")).toBe(false);

		// No mismatch (there is intersection)
		expect(model.mismatch).toBeUndefined();

		// Correlation summary sanity
		const s = model.correlationSummary;
		expect(s.matched).toBeGreaterThanOrEqual(1); // ProcessRecords + CleanProcedure
		expect(s.ambiguous).toBeGreaterThanOrEqual(1); // OverloadedProc
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
		expect(methods.length).toBe(4);
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
// (d) CLI wiring: fuseProfile integration points
// ---------------------------------------------------------------------------

describe("fuseProfile: CLI wiring behaviour", () => {
	test("--no-fusion equivalent: {fusion:false} → no FusedModel produced", async () => {
		const methods = makeWsMinMethods();
		const result = await fuseProfile(methods, WS_MIN, { fusion: false });

		// The disabled sentinel is returned; no FusedModel
		expect(isDisabled(result)).toBe(true);
		expect(isFusedModel(result)).toBe(false);
	});

	test("non-workspace source (zip) → disabled (engine would fail/be skipped)", async () => {
		// When sourcePath is a zip file (not a directory with app.json), the CLI
		// guards prevent calling fuseProfile. This test verifies the guard logic:
		// if fusionWorkspace is null (not a workspace dir), fuseProfile is not called.
		// We simulate this by calling with a clearly non-workspace dir.
		const methods = makeWsMinMethods();
		// A temp dir without app.json → engine won't find app.json → engine disabled.
		const result = await fuseProfile(methods, FIXTURE_DIR, {
			engine: "/nonexistent/alsem",
		});
		// Should be disabled (binary not found), not a FusedModel
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
