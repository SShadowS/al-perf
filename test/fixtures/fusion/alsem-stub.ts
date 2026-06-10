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
 *                   Schema 1.1.0: inventory includes a field-trigger row
 *                   (enclosingMember + originatingObject); analyze findings include
 *                   evidencePath + primaryLocation.enclosingMember.
 *   old-findings  — same as `findings` but schema 1.0.0 and NO new fields
 *                   (enclosingMember / evidencePath). Tests that an old engine
 *                   still parses gracefully (majorMatches 1.x → ok, fields absent).
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

// Stable ids for the field-trigger row (Table 72100, OnValidate for "Quantity").
const FINDINGS_TABLE_GUID = "00000000-0000-0000-0000-000000007210";

function findingsInventory() {
	return {
		kind: "routine-inventory",
		schemaVersion: "1.1.0",
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
				displayNames: ["ProcessLine", "OnRun", "OnValidate"],
				stableIds: [
					`${FINDINGS_APP_GUID}:Codeunit:50000#proc`,
					`${FINDINGS_APP_GUID}:Codeunit:50000#onrun`,
					`${FINDINGS_TABLE_GUID}:Table:72100#onval`,
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
				// Schema 1.1.0: a field-trigger row with enclosingMember + originatingObject.
				// Represents Table 72100's "Quantity" field OnValidate trigger.
				{
					enclosingMember: "Quantity",
					objectNumber: 72100,
					objectType: "Table",
					originatingObject: `${FINDINGS_TABLE_GUID}:Table:72100`,
					routineName: "OnValidate",
					stableRoutineId: `${FINDINGS_TABLE_GUID}:Table:72100#onval`,
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
	const procFinding = makeStubFinding(
		"F-PROC",
		"fp-proc",
		"d1-db-op-in-loop",
		"DB operation inside a loop",
		"ProcessLine",
	);
	// Schema 1.1.0: add evidencePath (with sourceAnchor as the engine emits it)
	// to the ProcessLine finding. Two steps: the outer caller and the inner op.
	const procFindingWithEvidence = {
		...procFinding,
		evidencePath: [
			{
				routineId: `${FINDINGS_APP_GUID}:Codeunit:50000#onrun`,
				sourceAnchor: {
					file: "ws:src/Cod50000.al",
					line: 5,
					startColumn: 3,
					endColumn: 20,
				},
				note: "calls",
				callsiteId: `${FINDINGS_APP_GUID}:Codeunit:50000#onrun/cs1`,
			},
			{
				routineId: `${FINDINGS_APP_GUID}:Codeunit:50000#proc`,
				sourceAnchor: {
					file: "ws:src/Cod50000.al",
					line: 10,
					startColumn: 5,
					endColumn: 40,
				},
				note: "DB read inside loop",
				operationId: `${FINDINGS_APP_GUID}:Codeunit:50000#proc/op1`,
				loopId: `${FINDINGS_APP_GUID}:Codeunit:50000#proc/loop1`,
			},
		],
	};

	const onrunFinding = makeStubFinding(
		"F-ONRUN",
		"fp-onrun",
		"d2-orchestrator",
		"Orchestrator dispatch",
		"OnRun",
	);
	// Schema 1.1.0: add primaryLocation.enclosingMember to a field-trigger finding.
	const onvalidateFinding = {
		...makeStubFinding(
			"F-ONVAL",
			"fp-onval",
			"d1-db-op-in-loop",
			"DB operation inside a field trigger",
			"OnValidate",
		),
		primaryLocation: {
			file: "ws:src/Tab72100.al",
			line: 20,
			column: 1,
			objectId: `${FINDINGS_TABLE_GUID}/Table/72100`,
			objectName: "StubTable",
			routineName: "OnValidate",
			enclosingMember: "Quantity",
			originatingObject: `${FINDINGS_TABLE_GUID}:Table:72100`,
		},
	};

	const findings = [
		// Lands on the hot leaf (ProcessLine, self 100%) → weighted.
		procFindingWithEvidence,
		// Lands on the zero-self orchestrator (OnRun, self 0%) → R2-12 drops it
		// from weighted; it remains in hotspotAnnotations + correlationSummary.
		onrunFinding,
		// A field-trigger finding with primaryLocation.enclosingMember.
		onvalidateFinding,
	];
	return {
		kind: "analyze-report",
		schemaVersion: "1.1.0",
		alsemVersion: "0.0.0-stub",
		deterministic: true,
		generatedAt: "1970-01-01T00:00:00Z",
		diagnostics: [],
		payload: {
			findings,
			summary: {
				byDetector: {
					"d1-db-op-in-loop": 2,
					"d2-orchestrator": 1,
				},
				bySeverity: { high: 3 },
				detectorStats: [],
				opaqueApps: [],
				routinesAnalyzed: 3,
				sourceUnitsParsed: 1,
				totalFindings: 3,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// "old-findings" mode — schema 1.0.0 stub, NO new fields.
// Tests that majorMatches(1.0.0, 1.1.0) → still parses; new fields absent → undefined.
// ---------------------------------------------------------------------------

function oldFindingsInventory() {
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
				displayNames: ["ProcessLine"],
				stableIds: [`${FINDINGS_APP_GUID}:Codeunit:50000#proc`],
			},
			rootClassifications: [],
			routineInventory: [
				// NO enclosingMember / originatingObject — old engine shape.
				{
					objectNumber: 50000,
					objectType: "Codeunit",
					routineName: "ProcessLine",
					stableRoutineId: `${FINDINGS_APP_GUID}:Codeunit:50000#proc`,
				},
			],
		},
	};
}

function oldFindingsAnalyze() {
	// NO evidencePath / NO primaryLocation.enclosingMember — old engine shape.
	const findings = [
		makeStubFinding(
			"F-PROC",
			"fp-proc",
			"d1-db-op-in-loop",
			"DB operation inside a loop",
			"ProcessLine",
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
				byDetector: { "d1-db-op-in-loop": 1 },
				bySeverity: { high: 1 },
				detectorStats: [],
				opaqueApps: [],
				routinesAnalyzed: 1,
				sourceUnitsParsed: 1,
				totalFindings: 1,
			},
		},
	};
}

function emitOldFindings() {
	const doc =
		subcommand === "analyze" ? oldFindingsAnalyze() : oldFindingsInventory();
	process.stdout.write(JSON.stringify(doc));
	process.exit(0);
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
		emit("1.1.0", true);
		break;
	case "findings":
		emitFindings();
		break;
	case "old-findings":
		emitOldFindings();
		break;
	default:
		emit("1.1.0", false);
		break;
}
