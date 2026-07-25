import { describe, expect, test } from "bun:test";
import {
	isTelemetryBatchDocument,
	parseTelemetryBatch,
	validateSignal,
} from "../../src/core/telemetry-parser.js";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/lifecycle/config.js";
import { TELEMETRY_BATCH_SCHEMA_VERSION } from "../../src/types/telemetry.js";

function minimalBatch() {
	return {
		schemaVersion: 1,
		payloadType: "telemetry-batch",
		windowStart: "2026-07-11T00:00:00.000Z",
		windowEnd: "2026-07-11T01:00:00.000Z",
		signals: [
			{
				signalId: "RT0018",
				appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				appName: "My ISV App",
				objectType: "Codeunit",
				objectId: 50100,
				objectName: "Order Processor",
				methodName: "ProcessLine",
				count: 3,
				maxDurationMs: 12_000,
				avgDurationMs: 9_500,
			},
		],
	};
}

describe("telemetry-batch schemaVersion contract pin", () => {
	test("the pin is schemaVersion 1", () => {
		expect(TELEMETRY_BATCH_SCHEMA_VERSION).toBe(1);
	});
});

describe("isTelemetryBatchDocument", () => {
	test("recognizes a telemetry-batch document by raw text", () => {
		expect(isTelemetryBatchDocument(JSON.stringify(minimalBatch()))).toBe(true);
	});

	test("rejects raw text without the discriminant", () => {
		expect(isTelemetryBatchDocument(JSON.stringify({ schemaVersion: 1 }))).toBe(
			false,
		);
		expect(isTelemetryBatchDocument("")).toBe(false);
		expect(isTelemetryBatchDocument("not json at all")).toBe(false);
	});
});

describe("parseTelemetryBatch — unknown-key tolerance (additive evolution)", () => {
	test("ignores unknown top-level keys", () => {
		const doc = { ...minimalBatch(), futureTopLevelField: 123 };
		expect(() =>
			parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});

	test("ignores unknown per-signal keys", () => {
		const doc = minimalBatch();
		(doc.signals[0] as Record<string, unknown>).futureSignalField = "x";
		expect(() =>
			parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});
});

describe("parseTelemetryBatch — fail-closed on shape", () => {
	test("rejects a foreign schemaVersion, naming the version", () => {
		const doc = { ...minimalBatch(), schemaVersion: 2 };
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/schemaVersion 2/,
		);
	});

	test("rejects a missing required top-level field, naming the field", () => {
		const doc = minimalBatch() as Record<string, unknown>;
		delete doc.windowStart;
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/windowStart/,
		);
	});

	test("rejects a missing required signal field, naming the field and index", () => {
		const doc = minimalBatch();
		delete (doc.signals[0] as Record<string, unknown>).objectId;
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*objectId/,
		);
	});
});

describe("library API surface", () => {
	test("telemetry parser and pin are exported from the package root", async () => {
		const api = await import("../../src/index.js");
		expect(typeof api.parseTelemetryBatch).toBe("function");
		expect(typeof api.isTelemetryBatchDocument).toBe("function");
		expect(api.TELEMETRY_BATCH_SCHEMA_VERSION).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Additive-change proof (Task 3): the clientType dimension must not alter
// parsing of any clientType-free batch. This snapshot was captured by running
// parseTelemetryBatch against the fixture below BEFORE clientType existed
// anywhere in the parser (2026-07-12, pre-Task-3 commit). analyzedAt is the
// only non-deterministic field in the output and is normalized to "<PINNED>"
// before comparison — everything else must match byte-for-byte.
//
// Re-baselined for Task 10 (telemetry-sql-evidence plan): meta now always
// carries `incompleteInvocations` (0 here — the fixture has no
// signalAvailability, so nothing failed). Deliberately unconditional per the
// brief's meta block (§9/§10 gating) — see telemetry-parser.ts's
// parseTelemetryBatch. Neither fixture signal carries SQL fields, so the two
// patterns below are otherwise untouched: no sqlEvidence/sqlRank, no evidence
// text appended, confirming the evidence-string wiring is scoped to
// SQL-bearing signals only.
// ---------------------------------------------------------------------------

function pinnedFixtureBatch() {
	return {
		schemaVersion: 1,
		payloadType: "telemetry-batch",
		windowStart: "2026-07-11T00:00:00.000Z",
		windowEnd: "2026-07-11T01:00:00.000Z",
		signals: [
			{
				signalId: "RT0018",
				appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				appName: "My ISV App",
				objectType: "Codeunit",
				objectId: 50100,
				objectName: "Order Processor",
				methodName: "ProcessLine",
				count: 3,
				maxDurationMs: 12_000,
				avgDurationMs: 9_500,
			},
			{
				signalId: "RT0005",
				appId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
				objectType: "Table",
				objectId: 200,
				methodName: "OnValidate",
				count: 7,
				maxDurationMs: 45_000,
			},
		],
	};
}

const PINNED_GOLDEN_SNAPSHOT = `{
	"result": {
		"meta": {
			"profilePath": "telemetry-batch",
			"profileType": "instrumentation",
			"totalDuration": 0,
			"totalSelfTime": 0,
			"idleSelfTime": 0,
			"totalNodes": 0,
			"maxDepth": 0,
			"incompleteInvocations": 0,
			"sourceAvailable": false,
			"confidenceScore": 0,
			"confidenceFactors": {
				"sampleCount": {
					"value": 0,
					"score": 0
				},
				"duration": {
					"value": 0,
					"score": 0
				},
				"incompleteMeasurements": {
					"value": 0,
					"score": 0
				}
			},
			"analyzedAt": "<PINNED>"
		},
		"summary": {
			"oneLiner": "telemetry-batch: 2 signal(s)",
			"topApp": null,
			"topMethod": null,
			"patternCount": {
				"critical": 0,
				"warning": 2,
				"info": 0
			},
			"healthScore": 0
		},
		"criticalPath": [],
		"hotspots": [
			{
				"functionName": "ProcessLine",
				"objectType": "Codeunit",
				"objectName": "Order Processor",
				"objectId": 50100,
				"appName": "My ISV App",
				"appId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				"selfTime": 0,
				"selfTimePercent": 0,
				"totalTime": 0,
				"totalTimePercent": 0,
				"hitCount": 0,
				"calledBy": [],
				"calls": [],
				"costPerHit": 0,
				"efficiencyScore": 0
			},
			{
				"functionName": "OnValidate",
				"objectType": "Table",
				"objectName": "",
				"objectId": 200,
				"appName": "",
				"appId": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
				"selfTime": 0,
				"selfTimePercent": 0,
				"totalTime": 0,
				"totalTimePercent": 0,
				"hitCount": 0,
				"calledBy": [],
				"calls": [],
				"costPerHit": 0,
				"efficiencyScore": 0
			}
		],
		"patterns": [
			{
				"id": "telemetry-rt0018",
				"severity": "warning",
				"title": "RT0018: ProcessLine (Codeunit 50100) slow — max 12000ms × 3",
				"description": "Telemetry signal RT0018 recorded 3 occurrence(s) of ProcessLine (Codeunit 50100) at or above the warning threshold, up to 12000ms.",
				"impact": 12000000,
				"involvedMethods": [
					"ProcessLine (Codeunit 50100)"
				],
				"evidence": "3 occurrence(s) in window 2026-07-11T00:00:00.000Z..2026-07-11T01:00:00.000Z, max 12000ms, avg 9500ms",
				"fingerprint": "telemetry:a5e401d497088975"
			},
			{
				"id": "telemetry-rt0005",
				"severity": "warning",
				"title": "RT0005: OnValidate (Table 200) slow — max 45000ms × 7",
				"description": "Telemetry signal RT0005 recorded 7 occurrence(s) of OnValidate (Table 200) at or above the warning threshold, up to 45000ms.",
				"impact": 45000000,
				"involvedMethods": [
					"OnValidate (Table 200)"
				],
				"evidence": "7 occurrence(s) in window 2026-07-11T00:00:00.000Z..2026-07-11T01:00:00.000Z, max 45000ms, avg n/ams",
				"fingerprint": "telemetry:ff8634a53eb3f355"
			}
		],
		"appBreakdown": [],
		"objectBreakdown": []
	},
	"windowEnd": "2026-07-11T01:00:00.000Z",
	"signalCount": 2
}`;

describe("clientType additive-change contract (Task 3)", () => {
	test("schemaVersion pin is still 1", () => {
		expect(TELEMETRY_BATCH_SCHEMA_VERSION).toBe(1);
	});

	test("a clientType-free batch parses byte-identically to the pre-clientType golden snapshot", () => {
		const parsed = parseTelemetryBatch(
			pinnedFixtureBatch(),
			DEFAULT_LIFECYCLE_CONFIG,
		);
		const normalized = JSON.stringify(
			parsed,
			(key, value) => (key === "analyzedAt" ? "<PINNED>" : value),
			"\t",
		);
		expect(normalized).toBe(PINNED_GOLDEN_SNAPSHOT);
	});
});

// ---------------------------------------------------------------------------
// SQL evidence wire contract (Task 7): sqlExecutes/sqlRowsRead/sqlEvidence on
// TelemetrySignal, validated fail-closed by validateSignal.
//
// Deviation from the original task brief: the brief's Step 1 test asserted
// the new fields reach `DetectedPattern.evidence` as formatted text
// ("12 SQL statement(s)", "3400 row(s) read"). That formatting is a LATER
// task's job (the parser's pattern builders) — parseTelemetryBatch's stub
// result does not yet surface sqlExecutes/sqlRowsRead/sqlEvidence anywhere
// observable. This suite instead asserts the fields survive validation onto
// the parsed TelemetrySignal directly (validateSignal is exported for this),
// plus the fail-closed rejection tests from the brief unchanged (those go
// through the public parseTelemetryBatch entry point since a throw during
// signal validation propagates as-is).
// ---------------------------------------------------------------------------

const baseSignal = {
	signalId: "RT0018",
	appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	objectType: "Codeunit",
	objectId: 50100,
	methodName: "ProcessLine",
	count: 3,
	maxDurationMs: 12_000,
};

function makeBatch(signals: unknown[]) {
	return {
		schemaVersion: 1,
		payloadType: "telemetry-batch",
		windowStart: "2026-07-11T00:00:00.000Z",
		windowEnd: "2026-07-11T01:00:00.000Z",
		signals,
	};
}

describe("SQL evidence wire contract (Task 7)", () => {
	test("schemaVersion stays 1 with the new fields present", () => {
		expect(TELEMETRY_BATCH_SCHEMA_VERSION).toBe(1);
	});

	test("validateSignal carries sqlExecutes/sqlRowsRead through", () => {
		const parsed = validateSignal(
			{ ...baseSignal, sqlExecutes: 12, sqlRowsRead: 3400 },
			0,
		);
		expect(parsed.sqlExecutes).toBe(12);
		expect(parsed.sqlRowsRead).toBe(3400);
	});

	test("validateSignal carries sqlEvidence through", () => {
		const evidence = {
			statements: [],
			totalMeasuredMs: 0,
			totalOccurrences: 0,
			provenance: "measured-threshold-gated" as const,
			attribution: "telemetry-stack" as const,
		};
		const parsed = validateSignal({ ...baseSignal, sqlEvidence: evidence }, 0);
		expect(parsed.sqlEvidence).toEqual(evidence);
	});

	test("a batch carrying the new fields still parses without throwing", () => {
		const batch = makeBatch([
			{ ...baseSignal, sqlExecutes: 12, sqlRowsRead: 3400 },
		]);
		expect(() =>
			parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});

	test("a batch carrying signalAvailability still parses without throwing", () => {
		const batch = {
			...makeBatch([baseSignal]),
			signalAvailability: [{ signalId: "RT0018", queried: true, rows: 12 }],
		};
		expect(() =>
			parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});

	test("rejects a negative sqlExecutes fail-closed", () => {
		const batch = makeBatch([{ ...baseSignal, sqlExecutes: -1 }]);
		expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/sqlExecutes/,
		);
	});

	test("rejects a non-integer sqlRowsRead fail-closed", () => {
		const batch = makeBatch([{ ...baseSignal, sqlRowsRead: 3.5 }]);
		expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/sqlRowsRead/,
		);
	});

	test("rejects an unknown evidence provenance", () => {
		const batch = makeBatch([
			{ ...baseSignal, sqlEvidence: { provenance: "made-up", statements: [] } },
		]);
		expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/provenance/,
		);
	});

	// attribution is present and valid here so this test isolates the ONE
	// field under test (statements) — F4 fix (final review) added its own
	// attribution check, covered separately below.
	test("rejects sqlEvidence missing a statements array", () => {
		const batch = makeBatch([
			{
				...baseSignal,
				sqlEvidence: {
					provenance: "measured-threshold-gated",
					attribution: "telemetry-stack",
				},
			},
		]);
		expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/statements/,
		);
	});

	// F4 fix (final review): optionalTelemetrySqlEvidence used to trust every
	// statement field verbatim once `provenance` and `Array.isArray(statements)`
	// passed — a wire-supplied statement missing `text` threw a TypeError deep
	// in the renderer instead of failing closed here, at the parse boundary.
	test("rejects an unknown evidence attribution", () => {
		const batch = makeBatch([
			{
				...baseSignal,
				sqlEvidence: {
					provenance: "measured-threshold-gated",
					attribution: "made-up",
					statements: [],
				},
			},
		]);
		expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/attribution/,
		);
	});

	test("rejects a statement missing text, fail-closed instead of throwing deep in the renderer", () => {
		const batch = makeBatch([
			{
				...baseSignal,
				sqlEvidence: {
					provenance: "measured-threshold-gated",
					attribution: "telemetry-stack",
					totalMeasuredMs: 100,
					totalOccurrences: 1,
					statements: [
						{
							operation: "SELECT",
							table: "Sales Line",
							extensionAppId: null,
							occurrences: 1,
							measuredTotalMs: 100,
							truncated: false,
							// text deliberately omitted
						},
					],
				},
			},
		]);
		expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/statements\[0\].*text/,
		);
	});

	test("rejects a statement with a non-numeric measuredTotalMs, fail-closed instead of rendering 'undefinedms'", () => {
		const batch = makeBatch([
			{
				...baseSignal,
				sqlEvidence: {
					provenance: "measured-threshold-gated",
					attribution: "telemetry-stack",
					totalMeasuredMs: 100,
					totalOccurrences: 1,
					statements: [
						{
							text: "SELECT * FROM [Sales Line]",
							operation: "SELECT",
							table: "Sales Line",
							extensionAppId: null,
							occurrences: 1,
							measuredTotalMs: "not-a-number",
							truncated: false,
						},
					],
				},
			},
		]);
		expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/statements\[0\].*measuredTotalMs/,
		);
	});

	test("rejects a statement with an unknown operation", () => {
		const batch = makeBatch([
			{
				...baseSignal,
				sqlEvidence: {
					provenance: "measured-threshold-gated",
					attribution: "telemetry-stack",
					totalMeasuredMs: 100,
					totalOccurrences: 1,
					statements: [
						{
							text: "SELECT * FROM [Sales Line]",
							operation: "UPSERT",
							table: "Sales Line",
							extensionAppId: null,
							occurrences: 1,
							measuredTotalMs: 100,
							truncated: false,
						},
					],
				},
			},
		]);
		expect(() => parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/statements\[0\].*operation/,
		);
	});
});
