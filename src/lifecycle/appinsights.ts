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
import {
	attachEvidenceToSignals,
	parseAlStackFrame,
	type StatementRow,
} from "./telemetry-sql.js";

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
 * The statement-level RT0005 query's own availability/error label (Task 9,
 * Fix Round 1) — distinct from the plain `"RT0005"` signalId the aggregate
 * query reports under, so a `signalAvailability.find(a => a.signalId ===
 * "RT0005")` lookup can never silently pick up (or be shadowed by) the
 * statement query's own outcome, and vice versa. Reused as both the
 * runKqlQuery error-message label and the signalAvailability entry's
 * signalId, so the two always agree.
 *
 * Exported (Task 10, Fix Round 1) so telemetry-parser.ts's incompleteness
 * gating imports this SAME constant instead of carrying its own copy of the
 * literal — a rename here previously could silently break that gate with no
 * test failure on either side.
 */
export const STATEMENT_QUERY_LABEL = "RT0005 statements";

/**
 * The App Insights v1 Analytics REST API (`/v1/apps/{id}/query`, used here)
 * caps a single query's result at this many rows — Microsoft's documented
 * default. A statement-query response landing AT this boundary is evidence
 * rows were cut off server-side, separate from this module's own deliberate
 * per-routine top-5 cap (`buildStatementKqlQuery`). NOT independently
 * verified against live telemetry the way the query shape itself was
 * (`verified-statement-kql.md`) — this threshold is Microsoft's documented
 * figure, not a Gate-0-style live measurement, so treat it as best-effort
 * until confirmed against a real truncated response.
 */
const APPINSIGHTS_QUERY_ROW_CAP = 500_000;

/**
 * Case-insensitive membership check for a requested signal id list — matches
 * SIGNAL_ID_RE's own case tolerance (`rt0005` passes it, same as `RT0005`).
 * Used to gate the statement-query enrichment: without this, `--signals
 * rt0005` would silently skip SQL evidence while still pulling RT0005 rows
 * under the lowercase id.
 */
function hasSignalId(signalIds: readonly string[], target: string): boolean {
	return signalIds.some((id) => id.toUpperCase() === target.toUpperCase());
}

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
 * mode) — except RT0005, which additionally groups by `stackTrace` (see
 * below).
 *
 * `ms` is derived from `customDimensions.executionTime`, a .NET timespan
 * string ("00:11:06.3140000"; ticks/10000 = ms) — NOT the `executionTimeInMs`
 * alias the pre-fix query read. Gate 0 measured that alias non-null on 0 of
 * 17,045 RT0018 rows and 6 of 15,957 RT0005 rows against real telemetry, so
 * `max(ms)`/`avg(ms)` came back null and `asDurationMs` threw on every real
 * pull — the shipped puller could not work against real telemetry until this
 * was fixed.
 *
 * RT0005 carries no `alMethod` (Gate 0), so grouping by `methodName` alone
 * collapsed every statement under one object into a single row with one
 * arbitrary `stackTrace` (the old `any()`). RT0005 groups by `stackTrace`
 * directly instead — `buildSignalFromRow` derives `methodName` from the AL
 * frame in that exact stack via `parseAlStackFrame`, so each (routine, stack)
 * pair arrives as its own row (Gate 0: 841 distinct stacks across 15,987
 * RT0005 rows, ~19 rows/stack — fragmentation is not a per-row-dust risk).
 * Every other signal keeps the pre-existing shape: grouped by `methodName`,
 * `stackTrace` carried through via `any()` (not grouped on) so the TS
 * normalizer can still fall back to it when `alMethod` is empty. Non-RT0005
 * signals also aggregate `sqlExecutes`/`sqlRowsRead` (RT0018, BC v22.0+;
 * absent on older rows). These are guarded with `iff(countif(isnotnull(...))
 * == 0, real(null), ...)` rather than a bare `sum(toint(...))`: Kusto's
 * aggregates fold over the empty set, so `sum()` of an all-null column
 * returns `0`, not `null` (the opposite of SQL) — verified against live
 * telemetry (RT0005 groups, which never carry these columns, summed to a
 * real `0`). An unguarded `sum()` would hand `asOptionalCount` a real `0` for
 * an environment that has never emitted these counters (BC < v22.0), minting
 * a false "confirmed zero SQL statements" for exactly the rows this field
 * exists to mark unknown.
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
export function buildKqlQuery(
	signalId: string,
	sinceIso: string,
	clientTypes?: readonly string[],
	split = false,
): string {
	const isSqlSignal = signalId === "RT0005";
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
		// executionTime is a .NET timespan ("00:11:06.3140000"); ticks/10000 = ms.
		// The executionTimeInMs alias is absent on effectively every real row
		// (Gate 0: 0/17,045 RT0018, 6/15,957 RT0005), which is why the shipped
		// query returned nulls and asDurationMs threw.
		split
			? "         ms = toreal(totimespan(customDimensions.executionTime)) / 10000,"
			: "         ms = toreal(totimespan(customDimensions.executionTime)) / 10000",
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
	if (isSqlSignal) {
		lines.push(
			"| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms)",
			split
				? "    by appId, appName, objectType, objectId, objectName, methodName, stackTrace, clientType, aadTenantId, environmentName"
				: "    by appId, appName, objectType, objectId, objectName, methodName, stackTrace, clientType",
		);
	} else {
		lines.push(
			"| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms), stackTrace = any(stackTrace),",
			// sum() over an all-null column returns 0 in Kusto (fold-over-empty-set
			// — the opposite of SQL's sum(NULL) = NULL), so this guards explicitly:
			// countif(isnotnull(...)) == 0 means the column was never present in the
			// group, and the aggregate reports real(null) (unknown) rather than a
			// false 0. todouble(...) on the sum branch is required — KQL rejects an
			// iff() whose two branches are real vs long.
			"    sqlExecutes = iff(countif(isnotnull(customDimensions.sqlExecutes)) == 0, real(null), todouble(sum(toint(customDimensions.sqlExecutes)))),",
			"    sqlRowsRead = iff(countif(isnotnull(customDimensions.sqlRowsRead)) == 0, real(null), todouble(sum(toint(customDimensions.sqlRowsRead))))",
			split
				? "    by appId, appName, objectType, objectId, objectName, methodName, clientType, aadTenantId, environmentName"
				: "    by appId, appName, objectType, objectId, objectName, methodName, clientType",
		);
	}
	return lines.join("\n");
}

/**
 * Statement-level RT0005 query (telemetry-sql-evidence plan, Task 9) — a
 * query SEPARATE from `buildKqlQuery`'s per-signal aggregate above: grouped
 * by the stack AND the statement text itself (never `any()`), so a routine's
 * individual statements survive into TypeScript instead of collapsing under
 * one arbitrary statement per object.
 *
 * Fix Round 1 (CRITICAL): `top-nested` returns ONLY its own clause columns —
 * `<Expr>` plus `aggregated_<Expr>` per level — never the summarize's own
 * columns un-nested. The first version of this query read
 * occurrences/measuredTotalMs/thresholdMs straight off the summarize and got
 * `NaN` in production; verified live
 * (`.superpowers/sdd/2026-07-25-telemetry-sql-evidence/verified-statement-kql.md`,
 * corrected 2026-07-25) that those three columns must ALSO ride their own
 * uncapped `top-nested of X by Ignore<N> = max(1)` pass-through level —
 * Microsoft's documented idiom for carrying a column through `top-nested`
 * without capping on it — same as every other non-capped dimension.
 * `sqlStatement` is the only CAPPED level (top 5 by `measuredTotalMs`); every
 * level above and below it stays uncapped, which is what makes that cap
 * per-ROUTINE (and, in split mode, per-TENANT/per-clientType — see below)
 * rather than global. The trailing `project` whitelists exactly the columns
 * the normalizer reads (rather than `project-away`ing the Ignore names) —
 * "safer, and makes the contract between query and normalizer explicit"
 * (verified-statement-kql.md); it also drops `aggregated_sqlStatement`, the
 * capped level's own extra aggregate column, which `project-away` alone
 * would have left behind.
 *
 * Fix Round 1 also adds `clientType`: the aggregate SIGNAL query
 * (`buildKqlQuery`) groups BY clientType, so a routine with several
 * clientType constituents mints one `TelemetrySignal` per constituent.
 * Without `clientType` here too, every constituent would match the exact
 * same statement rows and a later summing merge (Task 10) would double- (or
 * N-)count. `--client-types` filters this query the same way it filters the
 * aggregate one, or evidence measured in an unfiltered session could attach
 * to a `--client-types`-filtered finding.
 *
 * Split mode extends `aadTenantId`/`environmentName` into the summarize `by`
 * list and their own uncapped top-nested levels, above the `sqlStatement`
 * cap — the same two dimensions `pullTelemetrySplit` groups signal rows on.
 * `attachEvidenceToSignals` (telemetry-sql.ts) joins per split group, never
 * globally: a statement row without these dimensions could never be routed
 * back to the right group.
 */
export function buildStatementKqlQuery(
	sinceIso: string,
	split: boolean,
	clientTypes?: readonly string[],
): string {
	const by = split
		? "extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement, clientType, aadTenantId, environmentName"
		: "extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement, clientType";

	let ignoreIndex = 0;
	const passThrough = (col: string) =>
		`top-nested of ${col} by Ignore${ignoreIndex++} = max(1)`;

	const outerLevels = [
		"extensionId",
		"alObjectType",
		"alObjectId",
		"alStackTrace",
		"clientType",
		...(split ? ["aadTenantId", "environmentName"] : []),
	];
	const topNested = [
		...outerLevels.map(passThrough),
		"top-nested 5 of sqlStatement by max(measuredTotalMs)",
		passThrough("occurrences"),
		passThrough("measuredTotalMs"),
		passThrough("thresholdMs"),
	].join(",\n  ");

	const projected = [
		"extensionId",
		"alObjectType",
		"alObjectId",
		"alStackTrace",
		"sqlStatement",
		"clientType",
		...(split ? ["aadTenantId", "environmentName"] : []),
		"occurrences",
		"measuredTotalMs",
		"thresholdMs",
	].join(", ");

	const lines = [
		"traces",
		`| where timestamp > datetime(${sinceIso})`,
		'| where customDimensions.eventId == "RT0005"',
		"| extend extensionId = tostring(customDimensions.extensionId),",
		"         alObjectType = tostring(customDimensions.alObjectType),",
		"         alObjectId = toint(customDimensions.alObjectId),",
		"         alStackTrace = tostring(customDimensions.alStackTrace),",
		"         sqlStatement = tostring(customDimensions.sqlStatement),",
		"         clientType = tostring(customDimensions.clientType),",
		// Both are .NET timespans; the *InMs aliases are absent on real rows
		// (Gate 0). RT0005's threshold measured a uniform 750ms.
		"         thresholdMs = toreal(totimespan(customDimensions.longRunningThreshold)) / 10000,",
		split
			? "         ms = toreal(totimespan(customDimensions.executionTime)) / 10000,"
			: "         ms = toreal(totimespan(customDimensions.executionTime)) / 10000",
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
		`| summarize occurrences = count(), measuredTotalMs = sum(ms), thresholdMs = min(thresholdMs) by ${by}`,
		`| ${topNested}`,
		`| project ${projected}`,
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

/** null/undefined => unknown (BC < v22.0 does not emit these), never 0. */
function asOptionalCount(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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
 * empty (methodName after the AL-frame fallback, appId, objectType) — such
 * rows are SKIPPED by the caller rather than emitted, since the parser
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
	// RT0005 carries no alMethod, so the method comes from the AL frame. The
	// pre-fix fallback took stack line 0, which is the `AppObjectType:` header
	// — a non-method string that then became the finding's routine identity.
	const methodName =
		rawMethodName.trim() !== ""
			? rawMethodName
			: (parseAlStackFrame(stackTrace) ?? "");

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
		sqlExecutes: asOptionalCount(cell(row, "sqlExecutes")),
		sqlRowsRead: asOptionalCount(cell(row, "sqlRowsRead")),
	};
}

export function normalizeTable(
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
// Statement-row normalization (telemetry-sql-evidence plan, Task 9): the
// response shape for buildStatementKqlQuery. Carries aadTenantId/
// environmentName alongside every row (empty/absent in non-split mode,
// simply unused there) so pullTelemetrySplit can group statement rows by the
// exact same key it groups signal rows by, before handing each group's rows
// to attachEvidenceToSignals — the join must never run globally (see that
// function's doc comment in telemetry-sql.ts).
// ---------------------------------------------------------------------------

interface NormalizedStatementRow {
	row: StatementRow;
	aadTenantId: string;
	/** null when absent/empty — mirrors NormalizedSplitRow's environmentName (D2). */
	environmentName: string | null;
}

interface NormalizedStatementRows {
	rows: NormalizedStatementRow[];
	skipped: number;
}

/**
 * Row -> StatementRow, or dropped when identity fields are empty. Mirrors
 * buildSignalFromRow's skip-not-crash posture: a malformed statement row
 * degrades the evidence for one routine, never the pull. `occurrences` and
 * `measuredTotalMs` come straight from the KQL summarize (never absent by
 * construction of that query), unlike the guarded sqlExecutes/sqlRowsRead
 * counters on RT0018 rows.
 */
function normalizeStatementTable(
	table: AppInsightsTable,
): NormalizedStatementRows {
	const cell = makeCellReader(table);
	const rows: NormalizedStatementRow[] = [];
	let skipped = 0;
	for (const raw of table.rows) {
		const appId = asDisplayString(cell(raw, "extensionId"));
		const objectType = asDisplayString(cell(raw, "alObjectType"));
		const stackTrace = asDisplayString(cell(raw, "alStackTrace"));
		const sqlStatement = asDisplayString(cell(raw, "sqlStatement"));
		if (
			appId === "" ||
			objectType === "" ||
			stackTrace === "" ||
			sqlStatement === ""
		) {
			skipped++;
			continue;
		}
		const thresholdRaw = cell(raw, "thresholdMs");
		const environmentNameRaw = asDisplayString(cell(raw, "environmentName"));
		const clientTypeRaw = asDisplayString(cell(raw, "clientType"));
		rows.push({
			row: {
				appId,
				objectType,
				objectId: Number(cell(raw, "alObjectId")),
				stackTrace,
				sqlStatement,
				occurrences: Number(cell(raw, "occurrences")),
				measuredTotalMs: Number(cell(raw, "measuredTotalMs")),
				thresholdMs:
					typeof thresholdRaw === "number" && Number.isFinite(thresholdRaw)
						? thresholdRaw
						: undefined,
				// Fix Round 1: undefined, not "" -- matches TelemetrySignal.clientType's
				// own convention, and evidenceKey (telemetry-sql.ts) treats the two
				// differently by design.
				clientType: clientTypeRaw !== "" ? clientTypeRaw : undefined,
			},
			aadTenantId: asDisplayString(cell(raw, "aadTenantId")),
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

/**
 * True when the raw JSON response body carries a partial-query-failure
 * marker (Fix Round 2) — the App Insights REST API's ACTUAL truncation
 * signal for `/v1/apps/{id}/query`: a genuinely truncated response arrives
 * as HTTP 200 with an `error` property alongside `tables`, not as a row
 * count landing at any particular cap (with `top-nested 5` per routine and
 * ~604 statement rows/day measured live, APPINSIGHTS_QUERY_ROW_CAP alone
 * would never fire on a real response). Detected defensively — any
 * non-empty `error` object is treated as a marker, since the exact
 * error/innererror code for a truncation-specific partial failure isn't
 * independently live-verified (same caveat as the row-cap constant below).
 */
function hasPartialFailureMarker(json: unknown): boolean {
	if (typeof json !== "object" || json === null) return false;
	const err = (json as { error?: unknown }).error;
	return typeof err === "object" && err !== null;
}

/**
 * Fetch + classify HTTP errors for one already-built KQL string — shared by
 * fetchSignalTable and fetchStatementTable (Task 9) so the URL construction,
 * network-error wrapping and HTTP classification exist exactly once. `label`
 * is spliced into any thrown error message only — a real signalId for the
 * per-signal queries, "RT0005 statements" for the statement query, so the two
 * never collide in an operator-facing message. Returns the parsed JSON
 * alongside the extracted table (Fix Round 2) so a caller that cares about
 * truncation (fetchStatementTable) can inspect it for the partial-failure
 * marker above — fetchSignalTable's callers don't need it and just discard it.
 */
async function runKqlQuery(
	appId: string,
	apiKey: string,
	kql: string,
	label: string,
	fetchImpl: typeof fetch,
): Promise<{ json: unknown; table: AppInsightsTable }> {
	const url = `${APPINSIGHTS_API_BASE}/v1/apps/${encodeURIComponent(appId)}/query?query=${encodeURIComponent(kql)}`;

	let res: Response;
	try {
		res = await fetchImpl(url, { headers: { "x-api-key": apiKey } });
	} catch (err) {
		throw new Error(
			`pull-telemetry: network error querying App Insights for ${label}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		throw new Error(httpErrorMessage(res.status, res.statusText, label));
	}
	const json = await res.json();
	return { json, table: selectPrimaryTable(json, label) };
}

/** Build the per-signal URL/KQL, fetch, and classify HTTP errors — identical for both modes. */
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
	const { table } = await runKqlQuery(appId, apiKey, kql, signalId, fetchImpl);
	return table;
}

/**
 * Statement-level RT0005 fetch (Task 9) — a query separate from
 * fetchSignalTable's per-signal aggregate, always issued as its own request
 * (never folded into the RT0005 aggregate query above: buildKqlQuery and
 * buildStatementKqlQuery group on different dimensions and serve different
 * consumers). `clientTypes` is threaded through the same as the aggregate
 * query's own filter (Fix Round 1) — otherwise evidence measured in an
 * unfiltered session could attach to a `--client-types`-filtered finding.
 * STATEMENT_QUERY_LABEL keeps its error messages distinguishable from the
 * aggregate RT0005 query's. Returns `partialFailure` (Fix Round 2) so the
 * caller can fold it into the `"RT0005 statements"` availability entry's
 * `truncated` flag alongside the row-cap constant.
 */
async function fetchStatementTable(
	appId: string,
	apiKey: string,
	sinceIso: string,
	split: boolean,
	clientTypes: readonly string[] | undefined,
	fetchImpl: typeof fetch,
): Promise<{ table: AppInsightsTable; partialFailure: boolean }> {
	const kql = buildStatementKqlQuery(sinceIso, split, clientTypes);
	const { json, table } = await runKqlQuery(
		appId,
		apiKey,
		kql,
		STATEMENT_QUERY_LABEL,
		fetchImpl,
	);
	return { table, partialFailure: hasPartialFailureMarker(json) };
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
	// Per-signal failure capture (telemetry-sql-evidence plan, Task 9): a
	// failing signal — an HTTP error OR a normalization throw (asDurationMs
	// can throw mid-row) — degrades ONE signal, recorded here, rather than
	// aborting the whole pull. Only "every signal failed" still throws (a bad
	// API key or app id must stay loud); that thrown message concatenates
	// each signal's own captured error so the status/retryability an operator
	// needs still surfaces.
	const availability: NonNullable<
		TelemetryBatchDocument["signalAvailability"]
	> = [];
	let succeeded = 0;
	for (const signalId of signalIds) {
		try {
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
			availability.push({ signalId, queried: true, rows: signals.length });
			succeeded++;
		} catch (err) {
			availability.push({
				signalId,
				queried: true,
				rows: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (succeeded === 0) {
		throw new Error(
			`pull-telemetry: every signal query failed — ${availability
				.map((a) => `${a.signalId}: ${a.error}`)
				.join("; ")}`,
		);
	}

	if (skippedTotal > 0) {
		console.error(
			`pull-telemetry: skipped ${skippedTotal} row(s) with empty identity fields (methodName/appId/objectType) after normalization`,
		);
	}

	// Statement-level SQL evidence (Task 9): a query SEPARATE from the
	// per-signal aggregates above, best-effort — its own failure never aborts
	// the pull (evidence is enrichment, not identity) and never counts toward
	// the total-failure throw above. Fix Round 1: its outcome DOES get its own
	// signalAvailability entry (STATEMENT_QUERY_LABEL, distinct from the plain
	// "RT0005" the aggregate query reports under) — without one, a total
	// statement-query outage was indistinguishable from "queried, genuinely no
	// slow SQL", which would render every RT0005 finding as falsely clean.
	if (hasSignalId(signalIds, "RT0005")) {
		try {
			const { table, partialFailure } = await fetchStatementTable(
				opts.appId,
				apiKey,
				sinceIso,
				false,
				clientTypes,
				fetchImpl,
			);
			const { rows, skipped } = normalizeStatementTable(table);
			if (skipped > 0) {
				console.error(
					`pull-telemetry: skipped ${skipped} RT0005 statement row(s) with empty identity fields after normalization`,
				);
			}
			// Fix Round 2: strict clientType matching is intentionally correct
			// (SQL measured in one client session must not annotate another's
			// finding), but a systematic mismatch silently drops ALL evidence
			// for a routine while looking identical to a genuine "no slow SQL"
			// result — surface the count rather than let it stay invisible.
			const unmatchedRows = attachEvidenceToSignals(
				allSignals,
				rows.map((r) => r.row),
			);
			if (unmatchedRows > 0) {
				console.error(
					`pull-telemetry: ${unmatchedRows} RT0005 statement row(s) matched no signal (routine/clientType mismatch) — SQL evidence coverage may be incomplete`,
				);
			}
			availability.push({
				signalId: STATEMENT_QUERY_LABEL,
				queried: true,
				rows: rows.length,
				truncated:
					partialFailure || table.rows.length >= APPINSIGHTS_QUERY_ROW_CAP,
				unmatchedRows,
			});
		} catch (err) {
			availability.push({
				signalId: STATEMENT_QUERY_LABEL,
				queried: true,
				rows: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return {
		schemaVersion: TELEMETRY_BATCH_SCHEMA_VERSION,
		payloadType: "telemetry-batch",
		windowStart: sinceIso,
		windowEnd,
		source: opts.source ?? "appinsights-api",
		signals: allSignals,
		signalAvailability: availability,
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
 * The ONE grouping key expression for the (aadTenantId, environmentName)
 * pair — used to group both signal rows and statement rows into the same
 * split groups. Extracted to a single function (Fix Round 1, minor) so
 * tenant isolation is structural: signals and statements can never drift
 * onto two subtly different key computations, which two independently
 * hand-written `JSON.stringify([...])` call sites would risk.
 */
function splitGroupKey(
	aadTenantId: string,
	environmentName: string | null,
): string {
	return JSON.stringify([aadTenantId, environmentName]);
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
	// Per-signal failure capture — same rule as pullTelemetry (Task 9): a
	// failing signal degrades, the pull only throws if every signal failed.
	const availability: NonNullable<
		TelemetryBatchDocument["signalAvailability"]
	> = [];
	let succeeded = 0;
	for (const signalId of signalIds) {
		try {
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
			availability.push({ signalId, queried: true, rows: rows.length });
			succeeded++;
		} catch (err) {
			availability.push({
				signalId,
				queried: true,
				rows: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (succeeded === 0) {
		throw new Error(
			`pull-telemetry: every signal query failed — ${availability
				.map((a) => `${a.signalId}: ${a.error}`)
				.join("; ")}`,
		);
	}

	if (skippedTotal > 0) {
		console.error(
			`pull-telemetry: skipped ${skippedTotal} row(s) with empty identity fields (methodName/appId/objectType) after normalization`,
		);
	}

	const groupsByKey = new Map<string, SplitGroupAccumulator>();
	for (const row of allRows) {
		const key = splitGroupKey(row.aadTenantId, row.environmentName);
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

	// Statement-level SQL evidence (Task 9), split mode: the join must run
	// PER SPLIT GROUP, never globally — a global join keyed on the routine
	// alone would attach one tenant's redacted SQL onto another tenant's
	// finding whose app/object/method happen to match, shipping it straight
	// into that tenant's issue tracker. Statement rows are grouped by
	// splitGroupKey, the SAME function used for signals above, then joined
	// only within each already-formed group — never across. Best-effort like
	// the non-split path: a failure here degrades to "no SQL evidence this
	// pull", never the pull itself, but DOES get its own signalAvailability
	// entry (see the non-split path's comment for why).
	if (hasSignalId(signalIds, "RT0005")) {
		try {
			const { table, partialFailure } = await fetchStatementTable(
				opts.appId,
				apiKey,
				sinceIso,
				true,
				clientTypes,
				fetchImpl,
			);
			const { rows, skipped } = normalizeStatementTable(table);
			if (skipped > 0) {
				console.error(
					`pull-telemetry: skipped ${skipped} RT0005 statement row(s) with empty identity fields after normalization`,
				);
			}
			const statementsByGroupKey = new Map<string, StatementRow[]>();
			for (const r of rows) {
				const key = splitGroupKey(r.aadTenantId, r.environmentName);
				const list = statementsByGroupKey.get(key) ?? [];
				list.push(r.row);
				statementsByGroupKey.set(key, list);
			}
			// Fix Round 2: summed across every group this pull touched — see the
			// non-split path's comment for why this count matters.
			let unmatchedRows = 0;
			for (const [key, acc] of groupsByKey) {
				const statementRows = statementsByGroupKey.get(key);
				if (statementRows) {
					unmatchedRows += attachEvidenceToSignals(acc.signals, statementRows);
				}
			}
			// Fix Round 3: a statementsByGroupKey entry whose (aadTenantId,
			// environmentName) key has NO signal group at all is never passed to
			// attachEvidenceToSignals above — the loop only iterates
			// groupsByKey — so those rows would otherwise go uncounted. This
			// happens for real: an orphan tenant with statements but no signals,
			// or an environmentName present on one query's rows but not the
			// other's (the exact case this round exists to make visible).
			for (const [key, statementRows] of statementsByGroupKey) {
				if (!groupsByKey.has(key)) unmatchedRows += statementRows.length;
			}
			if (unmatchedRows > 0) {
				console.error(
					`pull-telemetry: ${unmatchedRows} RT0005 statement row(s) matched no signal (routine/clientType mismatch) — SQL evidence coverage may be incomplete`,
				);
			}
			availability.push({
				signalId: STATEMENT_QUERY_LABEL,
				queried: true,
				rows: rows.length,
				truncated:
					partialFailure || table.rows.length >= APPINSIGHTS_QUERY_ROW_CAP,
				unmatchedRows,
			});
		} catch (err) {
			availability.push({
				signalId: STATEMENT_QUERY_LABEL,
				queried: true,
				rows: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		}
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
				// Availability is per PULL, not per tenant row (a failed signal
				// returns no tenant dimensions, so there's nothing to attribute it
				// to) — every group emitted from this pull carries the SAME array.
				signalAvailability: availability,
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
