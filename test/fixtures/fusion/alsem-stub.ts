#!/usr/bin/env bun
/**
 * alsem-stub.ts — a fake `alsem` CLI for binary-free degrade-branch tests.
 *
 * The engine-runner spawns `<bin> fingerprint <ws> --inventory-only …` and
 * `<bin> analyze <ws> --format json …`. This stub mimics that surface and
 * lets each test drive a specific degrade branch via the `ALSEM_STUB_MODE`
 * env var:
 *
 *   ok            — emit valid inventory + analyze envelopes (no findings)
 *   bad-json      — emit garbage to stdout, exit 0   → "JSON parse" degrade
 *   exit2         — emit a stderr line, exit 2        → "failed (exit 2)" degrade
 *   timeout       — sleep past the test's timeoutMs   → "timed out" degrade
 *   wrong-schema  — emit a valid envelope w/ schemaVersion 99.0.0 → schema degrade
 *   opaque        — emit valid envelopes w/ non-empty opaqueApps → coverageDegraded
 *   findings      — emit an inventory + findings that correlate to the
 *                   sampling-minimal fixture's hot frames (ProcessLine, self 100%)
 *                   and its zero-self orchestrator (OnRun, self 0%) on
 *                   Codeunit 50000. Used to exercise the MCP fusion path with REAL
 *                   (non-empty) findings: ProcessLine → a weighted prioritized
 *                   finding; OnRun → matched but self 0% → R2-12 filter drops it
 *                   from `weighted` (stays in hotspotAnnotations).
 *
 * The subcommand (argv[2] = "fingerprint" | "analyze") selects which envelope
 * the "ok"/"wrong-schema"/"opaque"/"findings" modes emit.
 */

const args = process.argv.slice(2);
const subcommand = args[0]; // "fingerprint" | "analyze"
const mode = process.env.ALSEM_STUB_MODE ?? "ok";

const APP = {
	appGuid: "stub-guid-0000-0000-000000000000",
	name: "StubApp",
	publisher: "stub",
	version: "1.0.0.0",
};

function inventoryEnvelope(schemaVersion: string, opaque: boolean) {
	// opaque flag here only affects coverage shape illustratively; opaqueApps
	// lives on the analyze summary. Inventory stays well-formed.
	void opaque;
	return {
		kind: "routine-inventory",
		schemaVersion,
		alsemVersion: "0.0.0-stub",
		deterministic: true,
		generatedAt: "1970-01-01T00:00:00Z",
		diagnostics: [],
		payload: {
			apps: [APP],
			coverage: [
				{
					directStatus: "complete",
					inheritedStatus: "complete",
					reasons: [],
					subject: "stub-guid:Codeunit:50100#abc",
					unknownTargets: [],
				},
			],
			identities: {
				displayNames: ["StubRoutine"],
				stableIds: ["stub-guid:Codeunit:50100#abc"],
			},
			rootClassifications: [],
			routineInventory: [
				{
					objectNumber: 50100,
					objectType: "Codeunit",
					routineName: "StubRoutine",
					stableRoutineId: "stub-guid:Codeunit:50100#abc",
				},
			],
		},
	};
}

function analyzeEnvelope(schemaVersion: string, opaque: boolean) {
	return {
		kind: "analyze-report",
		schemaVersion,
		alsemVersion: "0.0.0-stub",
		deterministic: true,
		generatedAt: "1970-01-01T00:00:00Z",
		diagnostics: [],
		payload: {
			findings: [],
			summary: {
				byDetector: {},
				bySeverity: {},
				detectorStats: [],
				opaqueApps: opaque ? ["opaque-app-guid"] : [],
				routinesAnalyzed: 1,
				sourceUnitsParsed: 1,
				totalFindings: 0,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// "findings" mode — correlate to the sampling-minimal fixture's hot frames.
//
// The fixture profile (test/fixtures/sampling-minimal.alcpuprofile) has exactly
// two AL frames on Codeunit 50000:
//   ProcessLine — selfTimePercent 100 (the hot leaf)
//   OnRun       — selfTimePercent 0   (orchestrator; all cost in its callee)
// We emit an inventory routine for each + a finding on each. After the R2-12
// self-time>0 filter, ProcessLine's finding is weighted; OnRun's is NOT.
// ---------------------------------------------------------------------------

const FINDINGS_APP_GUID = "00000000-0000-0000-0000-000000005000";

function findingsInventory() {
	return {
		kind: "routine-inventory",
		schemaVersion: "1.0.0",
		alsemVersion: "0.0.0-stub",
		deterministic: true,
		generatedAt: "1970-01-01T00:00:00Z",
		diagnostics: [],
		payload: {
			apps: [APP],
			coverage: [
				{
					directStatus: "complete",
					inheritedStatus: "complete",
					reasons: [],
					subject: `${FINDINGS_APP_GUID}:Codeunit:50000#aaaa`,
					unknownTargets: [],
				},
			],
			identities: {
				displayNames: ["ProcessLine", "OnRun"],
				stableIds: [
					`${FINDINGS_APP_GUID}:Codeunit:50000#proc`,
					`${FINDINGS_APP_GUID}:Codeunit:50000#onrun`,
				],
			},
			rootClassifications: [],
			routineInventory: [
				{
					objectNumber: 50000,
					objectType: "Codeunit",
					routineName: "ProcessLine",
					stableRoutineId: `${FINDINGS_APP_GUID}:Codeunit:50000#proc`,
				},
				{
					objectNumber: 50000,
					objectType: "Codeunit",
					routineName: "OnRun",
					stableRoutineId: `${FINDINGS_APP_GUID}:Codeunit:50000#onrun`,
				},
			],
		},
	};
}

function makeStubFinding(
	id: string,
	fingerprint: string,
	detector: string,
	title: string,
	routineName: string,
) {
	return {
		id,
		fingerprint,
		detector,
		title,
		rootCause: "stub-root-cause",
		severity: "high",
		confidence: { level: "likely" },
		primaryLocation: {
			file: "ws:src/Cod50000.al",
			line: 10,
			column: 1,
			objectId: `${FINDINGS_APP_GUID}/Codeunit/50000`,
			objectName: "StubCodeunit",
			routineName,
		},
		affectedObjects: [`${FINDINGS_APP_GUID}/Codeunit/50000`],
		affectedTables: [],
	};
}

function findingsAnalyze() {
	const findings = [
		// Lands on the hot leaf (ProcessLine, self 100%) → weighted.
		makeStubFinding(
			"F-PROC",
			"fp-proc",
			"d1-db-op-in-loop",
			"DB operation inside a loop",
			"ProcessLine",
		),
		// Lands on the zero-self orchestrator (OnRun, self 0%) → R2-12 drops it
		// from weighted; it remains in hotspotAnnotations + correlationSummary.
		makeStubFinding(
			"F-ONRUN",
			"fp-onrun",
			"d2-orchestrator",
			"Orchestrator dispatch",
			"OnRun",
		),
	];
	return {
		kind: "analyze-report",
		schemaVersion: "1.0.0",
		alsemVersion: "0.0.0-stub",
		deterministic: true,
		generatedAt: "1970-01-01T00:00:00Z",
		diagnostics: [],
		payload: {
			findings,
			summary: {
				byDetector: { "d1-db-op-in-loop": 1, "d2-orchestrator": 1 },
				bySeverity: { high: 2 },
				detectorStats: [],
				opaqueApps: [],
				routinesAnalyzed: 2,
				sourceUnitsParsed: 1,
				totalFindings: 2,
			},
		},
	};
}

function emit(schemaVersion: string, opaque: boolean) {
	const doc =
		subcommand === "analyze"
			? analyzeEnvelope(schemaVersion, opaque)
			: inventoryEnvelope(schemaVersion, opaque);
	process.stdout.write(JSON.stringify(doc));
	process.exit(0);
}

function emitFindings() {
	const doc =
		subcommand === "analyze" ? findingsAnalyze() : findingsInventory();
	process.stdout.write(JSON.stringify(doc));
	process.exit(0);
}

switch (mode) {
	case "bad-json":
		process.stdout.write("this-is-not-json{");
		process.exit(0);
		break;
	case "exit2":
		process.stderr.write("al-sem: error: analysis failed\nmore detail\n");
		process.exit(2);
		break;
	case "timeout":
		// Sleep past any short test timeout (tests use ~400-500ms) so the runner
		// kills us first. Kept modest (3s) so that if the kill cannot reach this
		// grandchild through a shell shim, it self-exits quickly rather than
		// lingering as a test artifact.
		setTimeout(() => process.exit(0), 3_000);
		break;
	case "wrong-schema":
		emit("99.0.0", false);
		break;
	case "opaque":
		emit("1.0.0", true);
		break;
	case "findings":
		emitFindings();
		break;
	default:
		emit("1.0.0", false);
		break;
}
