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

/**
 * clientType enters severity-key composition (`${signalId}@${clientType}`,
 * config-file.ts D3) — same injection posture as signalId. Letters-only by
 * construction: rejects "", whitespace, digits/punctuation, and "__proto__"
 * (underscores are not letters) without a separate reserved-key check.
 */
const CLIENT_TYPE_RE = /^[A-Za-z]+$/;

function optionalClientType(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): string | undefined {
	const v = obj[field];
	if (v === undefined) return undefined;
	if (typeof v !== "string" || !CLIENT_TYPE_RE.test(v)) {
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
		clientType: optionalClientType(obj, "clientType", context),
	};
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * D3 severity ladder: `${signalId}@${clientType}` → signalId → default.
 * Object.hasOwn at every rung — guards against signalId/clientType values
 * like "__proto__" or "constructor" resolving through the prototype chain to
 * an inherited object (thresholds.criticalMs/warningMs then undefined, every
 * comparison false, severity silently "info" instead of falling through to
 * the next rung). An unrecognized clientType simply has no composite-key
 * entry and falls through to the plain signalId rung.
 */
function severityFor(
	signalId: string,
	clientType: string | undefined,
	maxDurationMs: number,
	config: LifecycleConfig,
): PatternSeverity {
	const severity = config.telemetry.severity;
	let thresholds = severity.default;
	if (Object.hasOwn(severity, signalId)) {
		thresholds = severity[signalId];
	}
	if (clientType !== undefined) {
		const compositeKey = `${signalId}@${clientType}`;
		if (Object.hasOwn(severity, compositeKey)) {
			thresholds = severity[compositeKey];
		}
	}
	if (maxDurationMs >= thresholds.criticalMs) return "critical";
	if (maxDurationMs >= thresholds.warningMs) return "warning";
	return "info";
}

// ---------------------------------------------------------------------------
// Stub hotspots (exercised-apps signal for evaluateRun's absence gating)
// ---------------------------------------------------------------------------

/**
 * One hotspot PER SIGNAL, carrying the signal's REAL routine identity
 * (functionName = methodName, objectType, objectId) rather than a deduped
 * placeholder — plan amendment (2026-07-11-telemetry-ingest.md, Task 2 stub
 * rules), made in Task 3 once the absence-gating tests proved the
 * placeholder broke D3. `collectFindings` (lifecycle/evaluate.ts) resolves a
 * finding's appId by matching a pattern's `involvedMethods[0]` — the exact
 * string `"${methodName} (${objectType} ${objectId})"` built below in the
 * pattern loop — against the method index built from `result.hotspots`; a
 * placeholder entry (`"<telemetry>"`/`""`/`0`) never matches a real signal's
 * involvedMethods string, so every telemetry finding's stored appId ended up
 * `""` and `appWasExercised`'s "unknown app = exercised" fallback (D7) made
 * every finding accrue absence on every later batch regardless of which app
 * it actually covered. Real per-signal identity fixes that lookup.
 *
 * This still satisfies the original exercised-apps role: `exercisedAppsOf`
 * (evaluate.ts) dedupes by normalized appId itself, so the exercised set a
 * run reports is unchanged whether these hotspots are deduped here or not —
 * no dedup is done, matching "one hotspot per signal" literally.
 */
function buildExercisedHotspots(
	signals: readonly TelemetrySignal[],
): MethodBreakdown[] {
	return signals.map((s) => ({
		functionName: s.methodName,
		objectType: s.objectType,
		objectName: s.objectName ?? "",
		objectId: s.objectId,
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
	}));
}

// ---------------------------------------------------------------------------
// Pattern construction + same-fingerprint merge (D4)
//
// Two signals mint the SAME `telemetry:` fingerprint exactly when they share
// the same (signalId, appId, objectType, objectId, methodName) routine
// identity — computeTelemetryFingerprint never takes clientType as an input,
// so clientType can never split or collide an identity. That is what makes
// "group signals by fingerprint" the correct operationalization of "same
// routine, different clientType" (D4): a group of size 1 is the untouched
// pre-Task-3 shape (see the pinned contract test), a group of size >1 is a
// same-fingerprint merge.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<PatternSeverity, number> = {
	info: 0,
	warning: 1,
	critical: 2,
};

interface SignalSeverity {
	signal: TelemetrySignal;
	severity: PatternSeverity;
	fingerprint: string;
}

/** Group size 1 — byte-identical to the pre-clientType pattern shape. */
function buildSinglePattern(
	item: SignalSeverity,
	windowStart: string,
	windowEnd: string,
): DetectedPattern {
	const { signal: s, severity, fingerprint } = item;
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
}

/**
 * Group size >1 — D4 merge. `involvedMethods`/title use the group's shared
 * identity (identical by construction: same fingerprint requires the same
 * normalized routine identity) with the SAME title/description formula as
 * the single-signal case, substituting the merged aggregates (max severity,
 * summed count, max maxDurationMs, count-weighted mean avgDurationMs — absent
 * on any constituent omits the average). Evidence keeps the original
 * "N occurrence(s) in window A..B, max Xms, avg Yms" shape (window
 * unchanged) and appends one clientType-labeled line per constituent
 * ("unspecified" when a constituent has no clientType).
 */
function buildMergedPattern(
	group: readonly SignalSeverity[],
	windowStart: string,
	windowEnd: string,
): DetectedPattern {
	const first = group[0].signal;
	const fingerprint = group[0].fingerprint;

	let severity: PatternSeverity = "info";
	let totalCount = 0;
	let maxDurationMs = 0;
	let weightedAvgSum = 0;
	let avgMissing = false;

	for (const { signal: s, severity: sev } of group) {
		if (SEVERITY_RANK[sev] > SEVERITY_RANK[severity]) severity = sev;
		totalCount += s.count;
		if (s.maxDurationMs > maxDurationMs) maxDurationMs = s.maxDurationMs;
		if (s.avgDurationMs === undefined) {
			avgMissing = true;
		} else {
			weightedAvgSum += s.avgDurationMs * s.count;
		}
	}
	const avgDurationMs =
		!avgMissing && totalCount > 0 ? weightedAvgSum / totalCount : undefined;

	const constituentLines = group.map(
		({ signal: s }) =>
			`${s.clientType ?? "unspecified"}: ${s.count} × max ${s.maxDurationMs}ms`,
	);

	const title = `${first.signalId}: ${first.methodName} (${first.objectType} ${first.objectId}) slow — max ${maxDurationMs}ms × ${totalCount}`;
	return {
		id: `telemetry-${first.signalId.toLowerCase()}`,
		severity,
		title,
		description: `Telemetry signal ${first.signalId} recorded ${totalCount} occurrence(s) of ${first.methodName} (${first.objectType} ${first.objectId}) at or above the ${severity} threshold, up to ${maxDurationMs}ms.`,
		impact: maxDurationMs * 1000,
		involvedMethods: [
			`${first.methodName} (${first.objectType} ${first.objectId})`,
		],
		evidence: `${totalCount} occurrence(s) in window ${windowStart}..${windowEnd}, max ${maxDurationMs}ms, avg ${avgDurationMs ?? "n/a"}ms — ${constituentLines.join("; ")}`,
		fingerprint,
	};
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
	// Fail closed here, not downstream: windowEnd becomes RunMetadata.captureTime
	// (telemetry.ts), and evaluateRun's canonicalCaptureTime throws on an
	// unparseable value AFTER the web ingest path has already stored the batch
	// (its lifecycle hook swallows evaluation errors) — a garbage windowEnd
	// would otherwise leave the batch permanently stored-but-never-evaluated,
	// with no re-evaluate API and a duplicate-run guard blocking any re-POST.
	if (Number.isNaN(new Date(windowEnd).getTime())) {
		throw new Error(
			`telemetry-batch document: invalid field 'windowEnd' (not a parseable timestamp: "${windowEnd}")`,
		);
	}
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

	// Severity assignment (D3) happens per-signal, BEFORE the D4 merge below —
	// each constituent's severity is resolved against its own clientType.
	const withSeverity: SignalSeverity[] = signals.map((s) => ({
		signal: s,
		severity: severityFor(s.signalId, s.clientType, s.maxDurationMs, config),
		fingerprint: formatFingerprint(
			computeTelemetryFingerprint({
				signalId: s.signalId,
				appId: s.appId,
				objectType: s.objectType,
				objectNumber: s.objectId,
				routineName: s.methodName,
			}),
		),
	}));

	// D4: group by fingerprint (insertion order = first-occurrence order, so a
	// batch with no duplicate routines produces patterns in the original
	// signal order, unchanged from pre-Task-3 behavior).
	const groups = new Map<string, SignalSeverity[]>();
	for (const item of withSeverity) {
		const existing = groups.get(item.fingerprint);
		if (existing) {
			existing.push(item);
		} else {
			groups.set(item.fingerprint, [item]);
		}
	}

	const patterns: DetectedPattern[] = Array.from(groups.values()).map(
		(group) =>
			group.length === 1
				? buildSinglePattern(group[0], windowStart, windowEnd)
				: buildMergedPattern(group, windowStart, windowEnd),
	);

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
