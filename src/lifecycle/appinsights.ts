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

/**
 * `--client-types` values are spliced into the KQL `in (...)` filter clause —
 * same injection posture as SIGNAL_ID_RE, and the same shape the
 * telemetry-parser validates a pulled clientType against
 * (src/core/telemetry-parser.ts CLIENT_TYPE_RE).
 */
const CLIENT_TYPE_RE = /^[A-Za-z]+$/;

export interface PullTelemetryOptions {
	/** Application Insights application id (GUID). */
	appId: string;
	/** Env var NAME holding the API key. Never the value itself. */
	apiKeyEnv?: string;
	/** ISO 8601 timestamp, or a relative duration like "4h", "30m", "1d". */
	since?: string;
	/** Signal (event) ids to pull. Defaults to RT0018 + RT0005. */
	signals?: readonly string[];
	/**
	 * BC session client types to filter on (e.g. "Background", "WebClient").
	 * Default (omitted/empty) pulls every client type — clientType still rides
	 * along in the by-key and each emitted signal either way (D5).
	 */
	clientTypes?: readonly string[];
	/** `TelemetryBatchDocument.source` override. */
	source?: string;
	/** Injectable clock for deterministic `--since` resolution and windowEnd in tests. */
	now?: () => Date;
}

// ---------------------------------------------------------------------------
// Split mode (telemetry-multitenant plan, Task 2): one TelemetryBatchDocument
// per (aadTenantId, environmentName) group instead of one fleet-wide batch.
// The wire contract (TelemetryBatchDocument/TelemetrySignal) is untouched —
// these types live entirely in the puller.
// ---------------------------------------------------------------------------

export interface PullSplitGroup {
	/** al-perf tenant the group maps to (post-tenantMap). */
	tenant: string;
	/** Run stream — environmentName, or "telemetry" when absent (D2). */
	stream: string;
	/** Source dimensions, for logging/filenames. */
	aadTenantId: string;
	environmentName: string | null;
	batch: TelemetryBatchDocument;
}

export interface PullSplitResult {
	groups: PullSplitGroup[];
	/** AAD tenant GUIDs skipped by the "skip" policy, with row counts (loud reporting). */
	skippedTenants: Array<{ aadTenantId: string; signalCount: number }>;
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
 * batch arrives pre-aggregated (one row per appId/object/method/clientType,
 * or per appId/object/method/clientType/aadTenantId/environmentName in split
 * mode). `ms` stays a double from `executionTimeInMs` when present;
 * `stackTrace` is carried through (via `any()`, not grouped on) so the TS
 * normalizer — never KQL — can fall back to its first line when `alMethod`
 * is empty.
 *
 * `clientType` (D5) always rides the extend + summarize by-key, independent
 * of `--client-types` — it's carried through to every emitted signal so the
 * severity ladder (telemetry-parser.ts) can key off it downstream even when
 * the pull itself isn't filtered. `clientTypes` only adds the extra `| where`
 * filter clause; each value is validated by the caller (pullTelemetry /
 * pullTelemetrySplit) BEFORE it reaches this function.
 *
 * `split` (telemetry-multitenant plan, Task 2) additionally extends +
 * groups by `aadTenantId`/`environmentName` — the two dimensions the split
 * puller groups rows on. `split` defaults to false/omitted so existing
 * callers produce the exact pre-Task-2 string (pinned by a snapshot test).
 */
function buildKqlQuery(
	signalId: string,
	sinceIso: string,
	clientTypes?: readonly string[],
	split = false,
): string {
	const lines = [
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
		"         clientType = tostring(customDimensions.clientType),",
		split
			? "         ms = todouble(customDimensions.executionTimeInMs),"
			: "         ms = todouble(customDimensions.executionTimeInMs)",
	];
	if (split) {
		lines.push(
			"         aadTenantId = tostring(customDimensions.aadTenantId),",
			"         environmentName = tostring(customDimensions.environmentName)",
		);
	}
	if (clientTypes && clientTypes.length > 0) {
		const list = clientTypes.map((ct) => `"${ct}"`).join(", ");
		lines.push(`| where clientType in (${list})`);
	}
	lines.push(
		"| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms), stackTrace = any(stackTrace)",
		split
			? "    by appId, appName, objectType, objectId, objectName, methodName, clientType, aadTenantId, environmentName"
			: "    by appId, appName, objectType, objectId, objectName, methodName, clientType",
	);
	return lines.join("\n");
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

type CellReader = (row: unknown[], name: string) => unknown;

function makeCellReader(table: AppInsightsTable): CellReader {
	const colIndex = new Map(table.columns.map((c, i) => [c.name, i] as const));
	return (row, name) => {
		const i = colIndex.get(name);
		return i === undefined ? undefined : row[i];
	};
}

/**
 * Row -> TelemetrySignal, or null when the row's identity fields end up
 * empty (methodName after the stack-trace fallback, appId, objectType) —
 * such rows are SKIPPED by the caller rather than emitted, since the parser
 * (telemetry-parser.ts) fail-closed rejects empty identity strings and a
 * single malformed row must not fail the whole pull. Shared by both the
 * non-split and split-mode normalizers — the signal shape itself never
 * changes between modes (wire contract untouched).
 */
function buildSignalFromRow(
	cell: CellReader,
	row: unknown[],
	signalId: string,
): TelemetrySignal | null {
	const rawMethodName = asDisplayString(cell(row, "methodName"));
	const stackTrace = asDisplayString(cell(row, "stackTrace"));
	const methodName =
		rawMethodName.trim() !== ""
			? rawMethodName
			: (stackTrace.split(/\r?\n/)[0] ?? "").trim();

	const appId = asDisplayString(cell(row, "appId"));
	const objectType = asDisplayString(cell(row, "objectType"));

	if (methodName === "" || appId === "" || objectType === "") {
		return null;
	}

	const appName = asDisplayString(cell(row, "appName"));
	const objectName = asDisplayString(cell(row, "objectName"));
	const clientType = asDisplayString(cell(row, "clientType"));
	const avgRaw = cell(row, "avgDurationMs");

	return {
		signalId,
		appId,
		appName: appName !== "" ? appName : undefined,
		objectType,
		objectId: Number(cell(row, "objectId")),
		objectName: objectName !== "" ? objectName : undefined,
		methodName,
		clientType: clientType !== "" ? clientType : undefined,
		count: Number(cell(row, "count")),
		maxDurationMs: asDurationMs(
			cell(row, "maxDurationMs"),
			`${signalId} maxDurationMs`,
		),
		avgDurationMs:
			avgRaw === undefined || avgRaw === null
				? undefined
				: asDurationMs(avgRaw, `${signalId} avgDurationMs`),
	};
}

function normalizeTable(
	table: AppInsightsTable,
	signalId: string,
): NormalizedRows {
	const cell = makeCellReader(table);
	const signals: TelemetrySignal[] = [];
	let skipped = 0;
	for (const row of table.rows) {
		const signal = buildSignalFromRow(cell, row, signalId);
		if (!signal) {
			skipped++;
			continue;
		}
		signals.push(signal);
	}
	return { signals, skipped };
}

// ---------------------------------------------------------------------------
// Split-mode row normalization (telemetry-multitenant plan, Task 2): same
// identity-skip rule as normalizeTable, plus the two grouping dimensions
// extracted per row. aadTenantId/environmentName never enter TelemetrySignal
// itself (wire contract untouched) — they exist only to drive grouping,
// below.
// ---------------------------------------------------------------------------

interface NormalizedSplitRow {
	signal: TelemetrySignal;
	aadTenantId: string;
	/** null when absent/empty — see D2 (stream falls back to "telemetry"). */
	environmentName: string | null;
}

interface NormalizedSplitRows {
	rows: NormalizedSplitRow[];
	skipped: number;
}

function normalizeSplitTable(
	table: AppInsightsTable,
	signalId: string,
): NormalizedSplitRows {
	const cell = makeCellReader(table);
	const rows: NormalizedSplitRow[] = [];
	let skipped = 0;
	for (const row of table.rows) {
		const signal = buildSignalFromRow(cell, row, signalId);
		if (!signal) {
			skipped++;
			continue;
		}
		const aadTenantId = asDisplayString(cell(row, "aadTenantId"));
		const environmentNameRaw = asDisplayString(cell(row, "environmentName"));
		rows.push({
			signal,
			aadTenantId,
			environmentName: environmentNameRaw !== "" ? environmentNameRaw : null,
		});
	}
	return { rows, skipped };
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
// Shared pull setup (pullTelemetry + pullTelemetrySplit): env-var/signal-id/
// clientType validation and --since resolution are identical in both modes —
// factored here so pullTelemetry's behavior stays byte-identical (pinned by
// a snapshot test) while pullTelemetrySplit reuses the exact same rules.
// ---------------------------------------------------------------------------

interface PullContext {
	apiKey: string;
	signalIds: readonly string[];
	clientTypes: readonly string[] | undefined;
	sinceIso: string;
	windowEnd: string;
}

function resolvePullContext(opts: PullTelemetryOptions): PullContext {
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

	const clientTypes =
		opts.clientTypes && opts.clientTypes.length > 0
			? opts.clientTypes
			: undefined;
	if (clientTypes) {
		for (const clientType of clientTypes) {
			if (!CLIENT_TYPE_RE.test(clientType)) {
				throw new Error(
					`pull-telemetry: invalid --client-types value '${clientType}'`,
				);
			}
		}
	}

	const now = (opts.now ?? (() => new Date()))();
	const sinceIso = resolveSince(opts.since ?? DEFAULT_SINCE, now);
	const windowEnd = now.toISOString();

	return { apiKey, signalIds, clientTypes, sinceIso, windowEnd };
}

/** Build the URL, fetch, and classify HTTP errors — identical for both modes. */
async function fetchSignalTable(
	appId: string,
	apiKey: string,
	signalId: string,
	sinceIso: string,
	clientTypes: readonly string[] | undefined,
	split: boolean,
	fetchImpl: typeof fetch,
): Promise<AppInsightsTable> {
	const kql = buildKqlQuery(signalId, sinceIso, clientTypes, split);
	const url = `${APPINSIGHTS_API_BASE}/v1/apps/${encodeURIComponent(appId)}/query?query=${encodeURIComponent(kql)}`;

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
	return selectPrimaryTable(json, signalId);
}

// ---------------------------------------------------------------------------
// pullTelemetry
// ---------------------------------------------------------------------------

export async function pullTelemetry(
	opts: PullTelemetryOptions,
	fetchImpl: typeof fetch = fetch,
): Promise<TelemetryBatchDocument> {
	const { apiKey, signalIds, clientTypes, sinceIso, windowEnd } =
		resolvePullContext(opts);

	const allSignals: TelemetrySignal[] = [];
	let skippedTotal = 0;
	for (const signalId of signalIds) {
		const table = await fetchSignalTable(
			opts.appId,
			apiKey,
			signalId,
			sinceIso,
			clientTypes,
			false,
			fetchImpl,
		);
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

// ---------------------------------------------------------------------------
// pullTelemetrySplit (telemetry-multitenant plan, Task 2)
// ---------------------------------------------------------------------------

interface SplitGroupAccumulator {
	aadTenantId: string;
	environmentName: string | null;
	signals: TelemetrySignal[];
}

/**
 * Split-mode pull. Non-split pullTelemetry keeps its exact current signature
 * and behavior (see the snapshot-pin tests) — this is a separate entry point,
 * not a mode flag on pullTelemetry, so the two never share mutable state.
 *
 * Grouping is by the RAW (aadTenantId, environmentName) pair returned by
 * Azure — one TelemetryBatchDocument per distinct pair. Tenant mapping is
 * applied AFTER grouping, per group: an aadTenantId absent from tenantMap
 * (including an empty string — old-schema/on-prem rows never carry a GUID)
 * is "unmapped" and the configured policy decides its fate. GUID comparison
 * against tenantMap keys is case-insensitive — tenantMap keys are stored
 * as-authored by the config loader while Azure rows can differ in case, so
 * both sides are lowercased at lookup (CONTROLLER-PINNED, Task 1 review).
 */
export async function pullTelemetrySplit(
	opts: PullTelemetryOptions & {
		tenantMap: Record<string, string>;
		unmappedTenantPolicy: "skip" | "fleet";
		fleetTenant: string;
	},
	fetchImpl: typeof fetch = fetch,
): Promise<PullSplitResult> {
	const { apiKey, signalIds, clientTypes, sinceIso, windowEnd } =
		resolvePullContext(opts);

	const allRows: NormalizedSplitRow[] = [];
	let skippedTotal = 0;
	for (const signalId of signalIds) {
		const table = await fetchSignalTable(
			opts.appId,
			apiKey,
			signalId,
			sinceIso,
			clientTypes,
			true,
			fetchImpl,
		);
		const { rows, skipped } = normalizeSplitTable(table, signalId);
		allRows.push(...rows);
		skippedTotal += skipped;
	}

	if (skippedTotal > 0) {
		console.error(
			`pull-telemetry: skipped ${skippedTotal} row(s) with empty identity fields (methodName/appId/objectType) after normalization`,
		);
	}

	const groupsByKey = new Map<string, SplitGroupAccumulator>();
	for (const row of allRows) {
		const key = JSON.stringify([row.aadTenantId, row.environmentName]);
		let acc = groupsByKey.get(key);
		if (!acc) {
			acc = {
				aadTenantId: row.aadTenantId,
				environmentName: row.environmentName,
				signals: [],
			};
			groupsByKey.set(key, acc);
		}
		acc.signals.push(row.signal);
	}

	const tenantMapLower = new Map(
		Object.entries(opts.tenantMap).map(([guid, tenant]) => [
			guid.toLowerCase(),
			tenant,
		]),
	);

	const groups: PullSplitGroup[] = [];
	const skippedByAad = new Map<string, number>();

	for (const acc of groupsByKey.values()) {
		const mappedTenant = tenantMapLower.get(acc.aadTenantId.toLowerCase());
		let tenant: string;
		if (mappedTenant !== undefined) {
			tenant = mappedTenant;
		} else if (opts.unmappedTenantPolicy === "fleet") {
			tenant = opts.fleetTenant;
		} else {
			skippedByAad.set(
				acc.aadTenantId,
				(skippedByAad.get(acc.aadTenantId) ?? 0) + acc.signals.length,
			);
			continue;
		}
		groups.push({
			tenant,
			stream: acc.environmentName ?? "telemetry",
			aadTenantId: acc.aadTenantId,
			environmentName: acc.environmentName,
			batch: {
				schemaVersion: TELEMETRY_BATCH_SCHEMA_VERSION,
				payloadType: "telemetry-batch",
				windowStart: sinceIso,
				windowEnd,
				source: "appinsights-api-split",
				signals: acc.signals,
			},
		});
	}

	const skippedTenants = Array.from(skippedByAad.entries()).map(
		([aadTenantId, signalCount]) => ({ aadTenantId, signalCount }),
	);

	return { groups, skippedTenants };
}

// ---------------------------------------------------------------------------
// listTenants (list-tenants plan, Task 1): tenant-discovery query for
// --split-by-customer onboarding. One KQL query grouped by aadTenantId alone
// (not by routine, and not one query per signal like buildKqlQuery/
// fetchSignalTable) — discovery only needs "which tenants showed up", so
// every requested signal is folded into a single `eventId in (...)` filter.
// Reuses resolvePullContext for the same env-var/signal-id validation and
// --since canonicalization as pullTelemetry/pullTelemetrySplit.
// ---------------------------------------------------------------------------

export interface TenantDiscovery {
	/** Verbatim aadTenantId from telemetry — may be "" (on-prem/old-schema rows) or non-GUID. */
	aadTenantId: string;
	/** Row count observed for this tenant across the requested signals/window. */
	rows: number;
	/** Distinct environmentName values seen (make_set result) — order not guaranteed. */
	environments: string[];
}

function buildListTenantsKqlQuery(
	signalIds: readonly string[],
	sinceIso: string,
): string {
	const eventList = signalIds.map((id) => `"${id}"`).join(", ");
	return [
		"traces",
		`| where timestamp > datetime(${sinceIso})`,
		`| where customDimensions.eventId in (${eventList})`,
		"| extend aadTenantId = tostring(customDimensions.aadTenantId),",
		"         environmentName = tostring(customDimensions.environmentName)",
		"| summarize rows = count(), environments = make_set(environmentName) by aadTenantId",
	].join("\n");
}

/**
 * `make_set`'s dynamic column can arrive as an already-parsed array (the
 * REST response body is JSON, so a nested array survives `res.json()` as-is)
 * or as a JSON-encoded string cell — parse defensively rather than assume
 * one shape; anything that's neither an array nor parseable JSON falls back
 * to a single-element array of its string form rather than throwing.
 */
function parseEnvironmentsCell(cell: unknown): string[] {
	if (Array.isArray(cell)) return cell.map((v) => String(v));
	if (typeof cell === "string") {
		try {
			const parsed = JSON.parse(cell);
			if (Array.isArray(parsed)) return parsed.map((v) => String(v));
		} catch {
			// not JSON — fall through to the single-element fallback below
		}
		return [String(cell)];
	}
	if (cell === null || cell === undefined) return [];
	return [String(cell)];
}

export async function listTenants(
	opts: Pick<PullTelemetryOptions, "appId" | "apiKeyEnv" | "since" | "signals">,
	fetchImpl: typeof fetch = fetch,
): Promise<TenantDiscovery[]> {
	const { apiKey, signalIds, sinceIso } = resolvePullContext(opts);

	const kql = buildListTenantsKqlQuery(signalIds, sinceIso);
	const url = `${APPINSIGHTS_API_BASE}/v1/apps/${encodeURIComponent(opts.appId)}/query?query=${encodeURIComponent(kql)}`;

	let res: Response;
	try {
		res = await fetchImpl(url, { headers: { "x-api-key": apiKey } });
	} catch (err) {
		throw new Error(
			`pull-telemetry --list-tenants: network error querying App Insights: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		throw new Error(
			httpErrorMessage(res.status, res.statusText, "list-tenants"),
		);
	}
	const json = await res.json();
	const table = selectPrimaryTable(json, "list-tenants");
	const cell = makeCellReader(table);

	return table.rows.map((row) => ({
		aadTenantId: asDisplayString(cell(row, "aadTenantId")),
		rows: Number(cell(row, "rows")),
		environments: parseEnvironmentsCell(cell(row, "environments")),
	}));
}
