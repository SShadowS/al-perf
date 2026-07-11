// === telemetry-batch parser (App Insights telemetry ingestion) ===
//
// Mirrors irjson-parser.ts's shape: a cheap payload sniff + a fail-closed
// validating parser. Unlike ir-json (which is a lossless per-invocation IR),
// a telemetry batch is ALREADY aggregated per routine by the adapter — there
// is no call tree, so the parser's job is validation + fingerprint minting +
// synthesizing a stub `AnalysisResult` that `evaluateRun` (lifecycle/evaluate.ts)
// can consume directly. The stub never reaches formatters.

import type { LifecycleConfig } from "../lifecycle/config.js";
import {
	computeTelemetryFingerprint,
	formatFingerprint,
} from "../lifecycle/fingerprint.js";
import type { AnalysisResult } from "../output/types.js";
import { normalizeAppGuid } from "../semantic/identity.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern, PatternSeverity } from "../types/patterns.js";
import {
	TELEMETRY_BATCH_SCHEMA_VERSION,
	type TelemetrySignal,
} from "../types/telemetry.js";

const TELEMETRY_BATCH_MARKER = /"payloadType"\s*:\s*"telemetry-batch"/;

/**
 * Cheap textual sniff for the raw-text ingestion boundary: true when the wire
 * text carries the telemetry-batch discriminant. Deliberately does NOT
 * JSON.parse (that cost belongs to the caller, once it has decided this is
 * worth parsing) — mirrors isIrJsonDocument's "sniff before you commit to a
 * parse" role, adapted to a string signature for this ingestion path.
 */
export function isTelemetryBatchDocument(text: string): boolean {
	return TELEMETRY_BATCH_MARKER.test(text);
}

export interface ParsedTelemetryBatch {
	result: AnalysisResult; // stub: patterns[] + minimal hotspots + meta
	windowEnd: string; // canonical captureTime for RunMetadata
	signalCount: number;
}

// ---------------------------------------------------------------------------
// Shape validation (fail-closed; unknown keys ignored by construction — only
// named fields are ever read)
// ---------------------------------------------------------------------------

function requireString(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): string {
	const v = obj[field];
	if (typeof v !== "string") {
		throw new Error(
			`telemetry-batch ${context}: missing/invalid field '${field}'`,
		);
	}
	return v;
}

/** Identity-bearing strings (fingerprint inputs): "" and whitespace-only are "missing", not merely empty. */
function requireNonEmptyString(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): string {
	const v = requireString(obj, field, context);
	if (v.trim() === "") {
		throw new Error(
			`telemetry-batch ${context}: missing/invalid field '${field}'`,
		);
	}
	return v;
}

function optionalString(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): string | undefined {
	const v = obj[field];
	if (v === undefined) return undefined;
	if (typeof v !== "string") {
		throw new Error(`telemetry-batch ${context}: invalid field '${field}'`);
	}
	return v;
}

/** Number.isFinite (not just !isNaN) — Infinity would otherwise flow into impact = maxDurationMs * 1000. */
function requireNumber(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): number {
	const v = obj[field];
	if (typeof v !== "number" || !Number.isFinite(v)) {
		throw new Error(
			`telemetry-batch ${context}: missing/invalid field '${field}'`,
		);
	}
	return v;
}

function requireNonNegativeNumber(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): number {
	const v = requireNumber(obj, field, context);
	if (v < 0) {
		throw new Error(
			`telemetry-batch ${context}: missing/invalid field '${field}'`,
		);
	}
	return v;
}

function requireInteger(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): number {
	const v = requireNumber(obj, field, context);
	if (!Number.isInteger(v)) {
		throw new Error(
			`telemetry-batch ${context}: missing/invalid field '${field}'`,
		);
	}
	return v;
}

function optionalNumber(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): number | undefined {
	const v = obj[field];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v)) {
		throw new Error(`telemetry-batch ${context}: invalid field '${field}'`);
	}
	return v;
}

function optionalNonNegativeNumber(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): number | undefined {
	const v = optionalNumber(obj, field, context);
	if (v !== undefined && v < 0) {
		throw new Error(`telemetry-batch ${context}: invalid field '${field}'`);
	}
	return v;
}

function validateSignal(raw: unknown, index: number): TelemetrySignal {
	const context = `signal[${index}]`;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`telemetry-batch ${context}: not an object`);
	}
	const obj = raw as Record<string, unknown>;
	return {
		signalId: requireNonEmptyString(obj, "signalId", context),
		appId: requireNonEmptyString(obj, "appId", context),
		appName: optionalString(obj, "appName", context),
		objectType: requireNonEmptyString(obj, "objectType", context),
		objectId: requireInteger(obj, "objectId", context),
		objectName: optionalString(obj, "objectName", context),
		methodName: requireNonEmptyString(obj, "methodName", context),
		count: requireNonNegativeNumber(obj, "count", context),
		maxDurationMs: requireNonNegativeNumber(obj, "maxDurationMs", context),
		avgDurationMs: optionalNonNegativeNumber(obj, "avgDurationMs", context),
	};
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

function severityFor(
	signalId: string,
	maxDurationMs: number,
	config: LifecycleConfig,
): PatternSeverity {
	const thresholds =
		config.telemetry.severity[signalId] ?? config.telemetry.severity.default;
	if (maxDurationMs >= thresholds.criticalMs) return "critical";
	if (maxDurationMs >= thresholds.warningMs) return "warning";
	return "info";
}

// ---------------------------------------------------------------------------
// Stub hotspots (exercised-apps signal for evaluateRun's absence gating)
// ---------------------------------------------------------------------------

/**
 * One hotspot per distinct app in the batch, so `exercisedAppsOf`
 * (lifecycle/evaluate.ts) marks every app this telemetry batch touched as
 * "exercised" this run. Deduped by normalized appId — not appName — because
 * `appWasExercised` checks `row.appId` FIRST when a pre-existing finding
 * carries one (the common case for profile-sourced findings): an appId-less
 * stub would leave `exercised.ids` permanently empty for telemetry-only runs,
 * so those findings would count spurious absences even though the batch did
 * cover their app. appName is carried alongside for the appId-less fallback
 * path (`exercised.names`).
 */
function buildExercisedHotspots(
	signals: readonly TelemetrySignal[],
): MethodBreakdown[] {
	const seen = new Map<string, MethodBreakdown>();
	for (const s of signals) {
		const key = normalizeAppGuid(s.appId);
		if (seen.has(key)) continue;
		seen.set(key, {
			functionName: "<telemetry>",
			objectType: "",
			objectName: "",
			objectId: 0,
			appName: s.appName ?? "",
			appId: s.appId,
			selfTime: 0,
			selfTimePercent: 0,
			totalTime: 0,
			totalTimePercent: 0,
			hitCount: 0,
			calledBy: [],
			calls: [],
			costPerHit: 0,
			efficiencyScore: 0,
		});
	}
	return [...seen.values()];
}

// ---------------------------------------------------------------------------
// parseTelemetryBatch
// ---------------------------------------------------------------------------

export function parseTelemetryBatch(
	json: unknown,
	config: LifecycleConfig,
): ParsedTelemetryBatch {
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		throw new Error("telemetry-batch: document is not an object");
	}
	const raw = json as Record<string, unknown>;

	if (raw.schemaVersion !== TELEMETRY_BATCH_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported telemetry-batch schemaVersion ${raw.schemaVersion} (this build expects ${TELEMETRY_BATCH_SCHEMA_VERSION})`,
		);
	}
	if (raw.payloadType !== "telemetry-batch") {
		throw new Error(
			`telemetry-batch: missing/invalid field 'payloadType' (expected "telemetry-batch")`,
		);
	}
	const windowStart = requireString(raw, "windowStart", "document");
	const windowEnd = requireString(raw, "windowEnd", "document");
	if (!Array.isArray(raw.signals)) {
		throw new Error(
			"telemetry-batch document: missing/invalid field 'signals'",
		);
	}

	const maxSignalsPerBatch = config.telemetry.maxSignalsPerBatch;
	if (raw.signals.length > maxSignalsPerBatch) {
		throw new Error(
			`telemetry-batch exceeds signal budget: ${raw.signals.length} signals > ${maxSignalsPerBatch}`,
		);
	}

	const signals: TelemetrySignal[] = raw.signals.map((s, i) =>
		validateSignal(s, i),
	);

	const patterns: DetectedPattern[] = signals.map((s) => {
		const severity = severityFor(s.signalId, s.maxDurationMs, config);
		const fingerprint = formatFingerprint(
			computeTelemetryFingerprint({
				signalId: s.signalId,
				appId: s.appId,
				objectType: s.objectType,
				objectNumber: s.objectId,
				routineName: s.methodName,
			}),
		);
		const title = `${s.signalId}: ${s.methodName} (${s.objectType} ${s.objectId}) slow — max ${s.maxDurationMs}ms × ${s.count}`;
		return {
			id: `telemetry-${s.signalId.toLowerCase()}`,
			severity,
			title,
			description: `Telemetry signal ${s.signalId} recorded ${s.count} occurrence(s) of ${s.methodName} (${s.objectType} ${s.objectId}) at or above the ${severity} threshold, up to ${s.maxDurationMs}ms.`,
			impact: s.maxDurationMs * 1000,
			involvedMethods: [`${s.methodName} (${s.objectType} ${s.objectId})`],
			evidence: `${s.count} occurrence(s) in window ${windowStart}..${windowEnd}, max ${s.maxDurationMs}ms, avg ${s.avgDurationMs ?? "n/a"}ms`,
			fingerprint,
		};
	});

	const patternCount = { critical: 0, warning: 0, info: 0 };
	for (const p of patterns) patternCount[p.severity]++;

	const result: AnalysisResult = {
		meta: {
			profilePath: (raw.source as string | undefined) ?? "telemetry-batch",
			profileType: "instrumentation",
			totalDuration: 0,
			totalSelfTime: 0,
			idleSelfTime: 0,
			totalNodes: 0,
			maxDepth: 0,
			sourceAvailable: false,
			confidenceScore: 0,
			confidenceFactors: {
				sampleCount: { value: 0, score: 0 },
				duration: { value: 0, score: 0 },
				incompleteMeasurements: { value: 0, score: 0 },
			},
			analyzedAt: new Date().toISOString(),
		},
		summary: {
			oneLiner: `telemetry-batch: ${signals.length} signal(s)`,
			topApp: null,
			topMethod: null,
			patternCount,
			healthScore: 0,
		},
		criticalPath: [],
		hotspots: buildExercisedHotspots(signals),
		patterns,
		appBreakdown: [],
		objectBreakdown: [],
	};

	return { result, windowEnd, signalCount: signals.length };
}
