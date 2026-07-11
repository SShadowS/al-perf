/**
 * appinsights.ts — App Insights REST API v1 puller (telemetry-ingest plan,
 * Task 5). The ONLY KQL-aware code in the platform: the server and CLI stay
 * KQL-ignorant (umbrella spec: "Adding a source is an adapter, not a
 * redesign") — this module queries App Insights and normalizes rows into
 * the `telemetry-batch` v1 contract (src/types/telemetry.ts); everything
 * downstream (lifecycle, sinks) is unaware App Insights exists.
 *
 * Plain fetch, no SDK — fetchImpl is injectable for mocked-HTTP tests.
 *
 * CREDENTIAL DISCIPLINE (matches the GitHub sink, sinks/github.ts): the API
 * key is read ONLY from `process.env[apiKeyEnv]` at call time, sent ONLY as
 * the `x-api-key` header (never a query parameter, never logged, never
 * interpolated into any thrown error). A missing env var fails BEFORE any
 * fetch call and names the env var's NAME, never a value.
 *
 * V1 DOES NOT RETRY — it is cron-driven; a caller re-runs the whole pull on
 * the next schedule tick. HTTP errors are classified (permanent vs
 * retryable) only to inform the operator's own retry/alerting, not to
 * trigger retries here.
 */

import {
	TELEMETRY_BATCH_SCHEMA_VERSION,
	type TelemetryBatchDocument,
	type TelemetrySignal,
} from "../types/telemetry.js";

/** Default env var holding the App Insights API key (CLI default, overridable via --api-key-env). */
export const DEFAULT_API_KEY_ENV = "APPINSIGHTS_API_KEY";

/** Default signals pulled when `--signals` is not given. */
export const DEFAULT_SIGNALS: readonly string[] = ["RT0018", "RT0005"];

/** Default `--since` window when not given: last hour (cron-driven, frequent polling). */
export const DEFAULT_SINCE = "1h";

const APPINSIGHTS_API_BASE = "https://api.applicationinsights.io";

/** Signal ids are spliced into the KQL string literal — restrict to a safe identifier shape. */
const SIGNAL_ID_RE = /^[A-Za-z0-9_]+$/;

export interface PullTelemetryOptions {
	/** Application Insights application id (GUID). */
	appId: string;
	/** Env var NAME holding the API key. Never the value itself. */
	apiKeyEnv?: string;
	/** ISO 8601 timestamp, or a relative duration like "4h", "30m", "1d". */
	since?: string;
	/** Signal (event) ids to pull. Defaults to RT0018 + RT0005. */
	signals?: readonly string[];
	/** `TelemetryBatchDocument.source` override. */
	source?: string;
	/** Injectable clock for deterministic `--since` resolution and windowEnd in tests. */
	now?: () => Date;
}

// ---------------------------------------------------------------------------
// --since resolution
// ---------------------------------------------------------------------------

const RELATIVE_SINCE_RE = /^(\d+)(ms|s|m|h|d)$/i;
const RELATIVE_UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** Resolve `--since` (ISO 8601 or relative duration) to a canonical ISO 8601 UTC string. */
export function resolveSince(since: string, now: Date): string {
	const trimmed = since.trim();
	const rel = RELATIVE_SINCE_RE.exec(trimmed);
	if (rel) {
		const amount = Number(rel[1]);
		const unitMs = RELATIVE_UNIT_MS[rel[2].toLowerCase()];
		return new Date(now.getTime() - amount * unitMs).toISOString();
	}
	const parsed = new Date(trimmed);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(
			`pull-telemetry: invalid --since value '${since}' (expected ISO 8601 or a relative duration like '4h')`,
		);
	}
	return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Timespan parsing (.NET TimeSpan wire format, e.g. "00:00:12.3450000")
// ---------------------------------------------------------------------------

const TIMESPAN_RE = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/** Parse a .NET-style timespan string ("[d.]hh:mm:ss[.fraction]") into milliseconds. */
export function parseTimespanMs(value: string): number {
	const m = TIMESPAN_RE.exec(value.trim());
	if (!m) {
		throw new Error(`pull-telemetry: invalid timespan value '${value}'`);
	}
	const days = m[1] ? Number(m[1]) : 0;
	const hours = Number(m[2]);
	const minutes = Number(m[3]);
	const seconds = Number(m[4]);
	const fracMs = m[5] ? Math.round(Number(`0.${m[5]}`) * 1000) : 0;
	return (
		days * 86_400_000 +
		hours * 3_600_000 +
		minutes * 60_000 +
		seconds * 1_000 +
		fracMs
	);
}

// ---------------------------------------------------------------------------
// KQL — the only place App Insights schema knowledge lives
// ---------------------------------------------------------------------------

/**
 * Build the per-signal KQL query. Aggregation happens server-side so the
 * batch arrives pre-aggregated (one row per appId/object/method). `ms` stays
 * a double from `executionTimeInMs` when present; `stackTrace` is carried
 * through (via `any()`, not grouped on) so the TS normalizer — never KQL —
 * can fall back to its first line when `alMethod` is empty.
 */
function buildKqlQuery(signalId: string, sinceIso: string): string {
	return [
		"traces",
		`| where timestamp > datetime(${sinceIso})`,
		`| where customDimensions.eventId == "${signalId}"`,
		"| extend appId = tostring(customDimensions.extensionId),",
		"         appName = tostring(customDimensions.extensionName),",
		"         objectType = tostring(customDimensions.alObjectType),",
		"         objectId = toint(customDimensions.alObjectId),",
		"         objectName = tostring(customDimensions.alObjectName),",
		"         methodName = tostring(customDimensions.alMethod),",
		"         stackTrace = tostring(customDimensions.alStackTrace),",
		"         ms = todouble(customDimensions.executionTimeInMs)",
		"| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms), stackTrace = any(stackTrace)",
		"    by appId, appName, objectType, objectId, objectName, methodName",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Response shape + row normalization
// ---------------------------------------------------------------------------

interface AppInsightsTable {
	name?: string;
	columns: Array<{ name: string; type?: string }>;
	rows: unknown[][];
}

function selectPrimaryTable(json: unknown, signalId: string): AppInsightsTable {
	if (
		typeof json !== "object" ||
		json === null ||
		!Array.isArray((json as { tables?: unknown }).tables)
	) {
		throw new Error(
			`pull-telemetry: unexpected App Insights response shape for ${signalId} (missing 'tables')`,
		);
	}
	const tables = (json as { tables: AppInsightsTable[] }).tables;
	const primary =
		tables.find((t) => t.name === "PrimaryTable") ??
		(tables.length === 1 ? tables[0] : undefined);
	if (!primary) {
		throw new Error(
			`pull-telemetry: no PrimaryTable in App Insights response for ${signalId}`,
		);
	}
	return primary;
}

function asDisplayString(v: unknown): string {
	if (typeof v === "string") return v;
	if (v === null || v === undefined) return "";
	return String(v);
}

/** Accepts both a plain ms number and a .NET timespan string (BC emits either across event schema versions). */
function asDurationMs(v: unknown, context: string): number {
	if (typeof v === "number") return v;
	if (typeof v === "string") return parseTimespanMs(v);
	throw new Error(`pull-telemetry: unexpected duration value for ${context}`);
}

interface NormalizedRows {
	signals: TelemetrySignal[];
	skipped: number;
}

/**
 * Row -> TelemetrySignal. Rows whose identity fields end up empty (methodName
 * after the stack-trace fallback, appId, objectType) are SKIPPED rather than
 * emitted — the parser (telemetry-parser.ts) fail-closed rejects empty
 * identity strings, and a single malformed row must not fail the whole pull.
 */
function normalizeTable(
	table: AppInsightsTable,
	signalId: string,
): NormalizedRows {
	const colIndex = new Map(table.columns.map((c, i) => [c.name, i] as const));
	const cell = (row: unknown[], name: string): unknown => {
		const i = colIndex.get(name);
		return i === undefined ? undefined : row[i];
	};

	const signals: TelemetrySignal[] = [];
	let skipped = 0;
	for (const row of table.rows) {
		const rawMethodName = asDisplayString(cell(row, "methodName"));
		const stackTrace = asDisplayString(cell(row, "stackTrace"));
		const methodName =
			rawMethodName.trim() !== ""
				? rawMethodName
				: (stackTrace.split(/\r?\n/)[0] ?? "").trim();

		const appId = asDisplayString(cell(row, "appId"));
		const objectType = asDisplayString(cell(row, "objectType"));

		if (methodName === "" || appId === "" || objectType === "") {
			skipped++;
			continue;
		}

		const appName = asDisplayString(cell(row, "appName"));
		const objectName = asDisplayString(cell(row, "objectName"));
		const avgRaw = cell(row, "avgDurationMs");

		signals.push({
			signalId,
			appId,
			appName: appName !== "" ? appName : undefined,
			objectType,
			objectId: Number(cell(row, "objectId")),
			objectName: objectName !== "" ? objectName : undefined,
			methodName,
			count: Number(cell(row, "count")),
			maxDurationMs: asDurationMs(
				cell(row, "maxDurationMs"),
				`${signalId} maxDurationMs`,
			),
			avgDurationMs:
				avgRaw === undefined || avgRaw === null
					? undefined
					: asDurationMs(avgRaw, `${signalId} avgDurationMs`),
		});
	}
	return { signals, skipped };
}

// ---------------------------------------------------------------------------
// HTTP error classification (v1 does not retry — classification is for the
// operator's own alerting/retry cadence, not automatic retry here)
// ---------------------------------------------------------------------------

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function httpErrorMessage(
	status: number,
	statusText: string,
	signalId: string,
): string {
	const label = statusText ? ` ${statusText}` : "";
	if (isRetryableStatus(status)) {
		return (
			`pull-telemetry: App Insights query for ${signalId} failed with ${status}${label} ` +
			`(retryable — the puller does not retry in v1; re-run on the next schedule tick)`
		);
	}
	return (
		`pull-telemetry: App Insights query for ${signalId} failed with ${status}${label} ` +
		`(permanent — check --app-id and the API key; will not succeed on retry)`
	);
}

// ---------------------------------------------------------------------------
// pullTelemetry
// ---------------------------------------------------------------------------

export async function pullTelemetry(
	opts: PullTelemetryOptions,
	fetchImpl: typeof fetch = fetch,
): Promise<TelemetryBatchDocument> {
	const apiKeyEnv = opts.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
	const apiKey = process.env[apiKeyEnv];
	if (!apiKey) {
		throw new Error(
			`pull-telemetry: environment variable ${apiKeyEnv} is not set (App Insights API key)`,
		);
	}

	const signalIds =
		opts.signals && opts.signals.length > 0 ? opts.signals : DEFAULT_SIGNALS;
	for (const signalId of signalIds) {
		if (!SIGNAL_ID_RE.test(signalId)) {
			throw new Error(`pull-telemetry: invalid signal id '${signalId}'`);
		}
	}

	const now = (opts.now ?? (() => new Date()))();
	const sinceIso = resolveSince(opts.since ?? DEFAULT_SINCE, now);
	const windowEnd = now.toISOString();

	const allSignals: TelemetrySignal[] = [];
	let skippedTotal = 0;
	for (const signalId of signalIds) {
		const kql = buildKqlQuery(signalId, sinceIso);
		const url = `${APPINSIGHTS_API_BASE}/v1/apps/${encodeURIComponent(opts.appId)}/query?query=${encodeURIComponent(kql)}`;

		let res: Response;
		try {
			res = await fetchImpl(url, { headers: { "x-api-key": apiKey } });
		} catch (err) {
			throw new Error(
				`pull-telemetry: network error querying App Insights for ${signalId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (!res.ok) {
			throw new Error(httpErrorMessage(res.status, res.statusText, signalId));
		}
		const json = await res.json();
		const table = selectPrimaryTable(json, signalId);
		const { signals, skipped } = normalizeTable(table, signalId);
		allSignals.push(...signals);
		skippedTotal += skipped;
	}

	if (skippedTotal > 0) {
		console.error(
			`pull-telemetry: skipped ${skippedTotal} row(s) with empty identity fields (methodName/appId/objectType) after normalization`,
		);
	}

	return {
		schemaVersion: TELEMETRY_BATCH_SCHEMA_VERSION,
		payloadType: "telemetry-batch",
		windowStart: sinceIso,
		windowEnd,
		source: opts.source ?? "appinsights-api",
		signals: allSignals,
	};
}
