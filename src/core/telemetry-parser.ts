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
import type {
	DetectedPattern,
	PatternSeverity,
	TelemetrySqlEvidence,
	TelemetrySqlStatementEvidence,
} from "../types/patterns.js";
import {
	STATEMENT_QUERY_LABEL,
	TELEMETRY_BATCH_SCHEMA_VERSION,
	type TelemetryBatchDocument,
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
	/** Validated signalAvailability entries (Task 9); absent when the document carries none. */
	signalAvailability?: SignalAvailabilityEntry[];
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

function optionalNonNegativeInteger(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): number | undefined {
	const v = obj[field];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new Error(
			`telemetry-batch ${context}: invalid field '${field}' (expected a non-negative integer)`,
		);
	}
	return v;
}

function requireNonNegativeInteger(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): number {
	const v = requireInteger(obj, field, context);
	if (v < 0) {
		throw new Error(
			`telemetry-batch ${context}: missing/invalid field '${field}'`,
		);
	}
	return v;
}

function requireBoolean(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): boolean {
	const v = obj[field];
	if (typeof v !== "boolean") {
		throw new Error(
			`telemetry-batch ${context}: missing/invalid field '${field}'`,
		);
	}
	return v;
}

function optionalBoolean(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): boolean | undefined {
	const v = obj[field];
	if (v === undefined) return undefined;
	if (typeof v !== "boolean") {
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

/**
 * Fail-closed shape check. An unknown `provenance` is REJECTED rather than
 * passed through: the discriminant is what every renderer narrows on, so an
 * unrecognized value would render measured data under sampled labels.
 */
function optionalTelemetrySqlEvidence(
	obj: Record<string, unknown>,
	field: string,
	context: string,
): TelemetrySqlEvidence | undefined {
	const v = obj[field];
	if (v === undefined) return undefined;
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		throw new Error(`telemetry-batch ${context}: invalid field '${field}'`);
	}
	const e = v as Record<string, unknown>;
	if (e.provenance !== "measured-threshold-gated") {
		throw new Error(
			`telemetry-batch ${context}: invalid field '${field}.provenance' (expected "measured-threshold-gated")`,
		);
	}
	if (!Array.isArray(e.statements)) {
		throw new Error(
			`telemetry-batch ${context}: invalid field '${field}.statements'`,
		);
	}
	return v as TelemetrySqlEvidence;
}

/**
 * Exported for direct unit testing (test/core/telemetry-contract.test.ts,
 * Task 7): `parseTelemetryBatch`'s stub result does not yet surface
 * `sqlExecutes`/`sqlRowsRead`/`sqlEvidence` anywhere observable — that wiring
 * (evidence-string formatting into `DetectedPattern.evidence`) is a later
 * task's job. Testing the validator directly is the only way to pin "these
 * fields survive validation onto `TelemetrySignal`" without reaching ahead
 * into that task's scope.
 */
export function validateSignal(raw: unknown, index: number): TelemetrySignal {
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
		sqlExecutes: optionalNonNegativeInteger(obj, "sqlExecutes", context),
		sqlRowsRead: optionalNonNegativeInteger(obj, "sqlRowsRead", context),
		sqlEvidence: optionalTelemetrySqlEvidence(obj, "sqlEvidence", context),
	};
}

// ---------------------------------------------------------------------------
// signalAvailability validation (telemetry-sql-evidence plan, Task 9).
//
// TelemetryBatchDocument.signalAvailability was typed on the wire (Task 7)
// but never validated here — a malformed entry silently passed through as an
// ignored unknown key, same as any other additive field. Unlike a genuinely
// unknown future field, this one is a KNOWN, currently-producible shape
// (appinsights.ts's pullTelemetry/pullTelemetrySplit populate it), so a
// present-but-malformed entry is a real bug in whatever produced the batch
// and should fail closed the same way validateSignal's per-field checks do,
// not be silently dropped.
//
// A later task wires the validated array into meta.incompleteInvocations /
// the evidence string's availability note (evaluate.ts's absence gating
// reads meta.incompleteInvocations) — this task only validates and surfaces
// it on ParsedTelemetryBatch, so that consumer doesn't have to re-validate
// raw.signalAvailability itself.
// ---------------------------------------------------------------------------

type SignalAvailabilityEntry = NonNullable<
	TelemetryBatchDocument["signalAvailability"]
>[number];

function validateSignalAvailabilityEntry(
	raw: unknown,
	index: number,
): SignalAvailabilityEntry {
	const context = `signalAvailability[${index}]`;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`telemetry-batch ${context}: not an object`);
	}
	const obj = raw as Record<string, unknown>;
	return {
		signalId: requireNonEmptyString(obj, "signalId", context),
		queried: requireBoolean(obj, "queried", context),
		rows: requireNonNegativeInteger(obj, "rows", context),
		truncated: optionalBoolean(obj, "truncated", context),
		error: optionalString(obj, "error", context),
		// Fix Round 2: reuses the same optionalNonNegativeInteger validator as
		// sqlExecutes/sqlRowsRead — no new helper needed.
		unmatchedRows: optionalNonNegativeInteger(obj, "unmatchedRows", context),
	};
}

/**
 * Exported for direct unit testing, matching validateSignal's own rationale.
 * Absent entirely -> undefined (not "unavailable", just "not reported by
 * this producer") so a signalAvailability-free document still parses to a
 * ParsedTelemetryBatch with the key omitted rather than an empty array —
 * keeps `ParsedTelemetryBatch` JSON-stringify byte-identical for every batch
 * that predates this field (see the pinned golden in telemetry-contract.test.ts).
 */
export function validateSignalAvailability(
	raw: unknown,
): SignalAvailabilityEntry[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		throw new Error(
			"telemetry-batch document: invalid field 'signalAvailability' (expected an array)",
		);
	}
	return raw.map((entry, i) => validateSignalAvailabilityEntry(entry, i));
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

// ---------------------------------------------------------------------------
// SQL evidence rendering (telemetry-sql-evidence plan, Task 10).
// ---------------------------------------------------------------------------

/**
 * The block appended to `DetectedPattern.evidence`. That string is the ONLY
 * thing that survives to the lifecycle store (evaluate.ts collectFindings) and
 * therefore to a GitHub/Azure DevOps issue body. PLAIN TEXT ONLY: GitHub fences
 * the string and Azure DevOps escapes it into <pre>, so markdown would render
 * literally in one of the two.
 */
function renderEvidenceSqlBlock(
	e: TelemetrySqlEvidence,
	availabilityNote: string | null,
): string {
	const gate = e.threshold
		? e.threshold.minMs === e.threshold.maxMs
			? `above ${e.threshold.minMs}ms`
			: `above ${e.threshold.minMs}-${e.threshold.maxMs}ms`
		: "above the configured threshold";
	const lines = [
		`SQL (measured, ${gate} only): ${e.totalMeasuredMs}ms across ${e.totalOccurrences} occurrence(s)`,
	];
	for (const s of e.statements.slice(0, 3)) {
		const text = s.text.length > 200 ? `${s.text.slice(0, 200)}…` : s.text;
		lines.push(
			`  ${s.operation} ${s.table ?? "(unparsed)"} — ${s.measuredTotalMs}ms x${s.occurrences}${s.truncated ? " (truncated)" : ""}: ${text}`,
		);
	}
	if (availabilityNote) lines.push(availabilityNote);
	return lines.join("\n");
}

/** RT0018's measured counts. Absent means unknown, never zero — never rendered as "0". */
function renderCountsLine(s: TelemetrySignal): string | null {
	if (s.sqlExecutes === undefined && s.sqlRowsRead === undefined) return null;
	const parts: string[] = [];
	if (s.sqlExecutes !== undefined)
		parts.push(`${s.sqlExecutes} SQL statement(s)`);
	if (s.sqlRowsRead !== undefined) parts.push(`${s.sqlRowsRead} row(s) read`);
	return `Measured: ${parts.join(", ")}`;
}

/** Group size 1 — byte-identical to the pre-clientType pattern shape when no SQL fields are present. */
function buildSinglePattern(
	item: SignalSeverity,
	windowStart: string,
	windowEnd: string,
	availabilityNote: string | null,
): DetectedPattern {
	const { signal: s, severity, fingerprint } = item;
	const title = `${s.signalId}: ${s.methodName} (${s.objectType} ${s.objectId}) slow — max ${s.maxDurationMs}ms × ${s.count}`;
	const baseEvidence = `${s.count} occurrence(s) in window ${windowStart}..${windowEnd}, max ${s.maxDurationMs}ms, avg ${s.avgDurationMs ?? "n/a"}ms`;

	const extras: string[] = [];
	const counts = renderCountsLine(s);
	if (counts) extras.push(counts);
	if (s.sqlEvidence) {
		extras.push(renderEvidenceSqlBlock(s.sqlEvidence, availabilityNote));
	} else if (availabilityNote) {
		// No evidence to attach the note to, but a failed query still needs to
		// say so: §9 requires a finding may claim "no slow SQL" only when the
		// signal was queried without error — otherwise it must name the actual
		// reason. Without this branch, a statement-query failure (which leaves
		// sqlEvidence undefined on every signal in the window, since
		// attachEvidenceToSignals only sets it when a row actually matched)
		// would drop the note entirely, and meta.incompleteInvocations never
		// reaches an issue body.
		extras.push(availabilityNote);
	}

	return {
		id: `telemetry-${s.signalId.toLowerCase()}`,
		severity,
		title,
		description: `Telemetry signal ${s.signalId} recorded ${s.count} occurrence(s) of ${s.methodName} (${s.objectType} ${s.objectId}) at or above the ${severity} threshold, up to ${s.maxDurationMs}ms.`,
		impact: s.maxDurationMs * 1000,
		involvedMethods: [`${s.methodName} (${s.objectType} ${s.objectId})`],
		evidence: [baseEvidence, ...extras].join("\n"),
		sqlEvidence: s.sqlEvidence,
		sqlRank: s.sqlEvidence ? s.sqlEvidence.totalMeasuredMs * 1000 : undefined,
		fingerprint,
	};
}

/**
 * Union constituent SQL evidence by redacted text; sum occurrences and ms;
 * widen the threshold range. Evidence now arrives scoped per clientType, so
 * two constituents of one merge genuinely carry DIFFERENT statements — a
 * shared-text match means the SAME normalized statement was measured under
 * more than one clientType, which is a real total, not double-counting.
 */
function mergeEvidence(
	group: readonly SignalSeverity[],
): TelemetrySqlEvidence | undefined {
	const byText = new Map<string, TelemetrySqlStatementEvidence>();
	let threshold: { minMs: number; maxMs: number } | undefined;
	for (const { signal } of group) {
		const e = signal.sqlEvidence;
		if (!e) continue;
		for (const s of e.statements) {
			const prev = byText.get(s.text);
			byText.set(
				s.text,
				prev
					? {
							...prev,
							occurrences: prev.occurrences + s.occurrences,
							measuredTotalMs: prev.measuredTotalMs + s.measuredTotalMs,
							truncated: prev.truncated || s.truncated,
						}
					: { ...s },
			);
		}
		if (e.threshold) {
			threshold = threshold
				? {
						minMs: Math.min(threshold.minMs, e.threshold.minMs),
						maxMs: Math.max(threshold.maxMs, e.threshold.maxMs),
					}
				: e.threshold;
		}
	}
	if (byText.size === 0) return undefined;
	const statements = Array.from(byText.values()).sort(
		(a, b) =>
			b.measuredTotalMs - a.measuredTotalMs || a.text.localeCompare(b.text),
	);
	return {
		statements: statements.slice(0, 5),
		totalMeasuredMs: statements.reduce((n, s) => n + s.measuredTotalMs, 0),
		totalOccurrences: statements.reduce((n, s) => n + s.occurrences, 0),
		provenance: "measured-threshold-gated",
		attribution: "telemetry-stack",
		threshold,
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
	availabilityNote: string | null,
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
	const baseEvidence = `${totalCount} occurrence(s) in window ${windowStart}..${windowEnd}, max ${maxDurationMs}ms, avg ${avgDurationMs ?? "n/a"}ms — ${constituentLines.join("; ")}`;

	// Counts (sqlExecutes/sqlRowsRead) are per-constituent, never summed: an
	// absent count on one constituent means unknown for THAT constituent, not
	// zero, so a sum would misrepresent partial data as a complete total. One
	// line per constituent that reports counts, labeled the same way the
	// occurrence breakdown above is.
	const extras: string[] = [];
	for (const { signal: s } of group) {
		const counts = renderCountsLine(s);
		if (counts) extras.push(`${counts} (${s.clientType ?? "unspecified"})`);
	}
	const mergedSqlEvidence = mergeEvidence(group);
	if (mergedSqlEvidence) {
		extras.push(renderEvidenceSqlBlock(mergedSqlEvidence, availabilityNote));
	} else if (availabilityNote) {
		// Same rationale as buildSinglePattern: no merged evidence to attach the
		// note to (e.g. the statement query failed, so no constituent carries
		// sqlEvidence), but a failed query must still say so somewhere in the
		// persisted string.
		extras.push(availabilityNote);
	}

	return {
		id: `telemetry-${first.signalId.toLowerCase()}`,
		severity,
		title,
		description: `Telemetry signal ${first.signalId} recorded ${totalCount} occurrence(s) of ${first.methodName} (${first.objectType} ${first.objectId}) at or above the ${severity} threshold, up to ${maxDurationMs}ms.`,
		impact: maxDurationMs * 1000,
		involvedMethods: [
			`${first.methodName} (${first.objectType} ${first.objectId})`,
		],
		evidence: [baseEvidence, ...extras].join("\n"),
		sqlEvidence: mergedSqlEvidence,
		sqlRank: mergedSqlEvidence
			? mergedSqlEvidence.totalMeasuredMs * 1000
			: undefined,
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

	// Fail closed on a malformed signalAvailability entry (Task 9) — see the
	// section doc comment above validateSignalAvailability for why this
	// wasn't a silently-ignored unknown key before.
	const signalAvailability = validateSignalAvailability(raw.signalAvailability);

	// TWO derived sets from the one signalAvailability array — the split is
	// deliberate (telemetry-sql-evidence plan §9, Task 10 amendment).
	//
	// `failedSignals` drives the note text appended to evidence: an operator
	// wants to see every query that failed, enrichment included.
	//
	// `failedSignalQueries` drives meta.incompleteInvocations below, and
	// EXCLUDES the statement query (STATEMENT_QUERY_LABEL, from
	// types/telemetry.ts — the wire contract's own constant, not a second copy
	// of the literal, so a rename on one side can't silently break this gate).
	// §9's incompleteness rule exists so a failed SIGNAL query cannot falsely
	// resolve findings — absent signal data means routines genuinely went
	// unobserved. The statement query is enrichment: its failure does not
	// mean those routines went unobserved, so letting it suppress the absence
	// pass would needlessly delay resolving findings that are actually
	// fixed. Do not collapse these two sets back together.
	const failedSignals = (signalAvailability ?? []).filter(
		(a) => a.error !== undefined,
	);
	const failedSignalQueries = failedSignals.filter(
		(a) => a.signalId !== STATEMENT_QUERY_LABEL,
	);
	// Note text: signalId + error only. Never rows/unmatchedRows — those two
	// integers are PULL-WIDE (every group emitted from one pull carries the
	// same signalAvailability array, so they may describe another tenant's
	// rows) and must never be rendered as tenant-specific text or gate a
	// per-tenant "clean" claim.
	const availabilityNote =
		failedSignals.length > 0
			? `Signal(s) unavailable this window: ${failedSignals.map((a) => `${a.signalId} (${a.error})`).join("; ")} — absence not counted.`
			: null;

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
				? buildSinglePattern(group[0], windowStart, windowEnd, availabilityNote)
				: buildMergedPattern(group, windowStart, windowEnd, availabilityNote),
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
			// A window in which a signal failed is an INCOMPLETE run: evaluateRun
			// reads meta.incompleteInvocations (evaluate.ts:353) and skips the
			// absence pass entirely (evaluate.ts:610-611). Without this, an
			// RT0018-only batch would accrue absence against every RT0005 finding
			// of the same app and eventually resolve them.
			// failedSignalQueries, NOT failedSignals — a failed enrichment query
			// must not suppress the absence pass (see the derivation above).
			incompleteInvocations: failedSignalQueries.length,
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

	return {
		result,
		windowEnd,
		signalCount: signals.length,
		signalAvailability,
	};
}
