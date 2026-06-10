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
 *
 * The subcommand (argv[2] = "fingerprint" | "analyze") selects which envelope
 * the "ok"/"wrong-schema"/"opaque" modes emit.
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

function emit(schemaVersion: string, opaque: boolean) {
	const doc =
		subcommand === "analyze"
			? analyzeEnvelope(schemaVersion, opaque)
			: inventoryEnvelope(schemaVersion, opaque);
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
	default:
		emit("1.0.0", false);
		break;
}
