/**
 * tools.ts — allow-listed tool layer over LifecycleStore for the triage
 * agent (umbrella spec §Agentic triage layer, plan D4). Every tool is a
 * method of TriageTools, a class constructed once per (tenant, report dir)
 * — the tenant comes from the constructor and appears in NO tool input
 * type, so a tool call can never structurally name another tenant.
 * `recordTriage` is the sole mutation. `reportFile` is jailed to the report
 * directory (resolve + prefix-check, the zip-extractor precedent —
 * src/source/zip-extractor.ts).
 *
 * `dispatch()` is the allow-list itself: it is the only entry point that
 * takes a raw string tool name (as the model's tool_use.name would be), and
 * anything outside the five D4 names is structurally impossible to route to
 * a mutation — it returns an error result, never throws.
 *
 * Finding-derived strings are returned RAW here; wrapping them in
 * non-instruction delimiters is the agent loop's job (Task 3) — one point
 * of framing, not one per tool.
 */

import { mkdirSync, writeFileSync } from "fs";
import { resolve, sep } from "path";
import { type BaselineStats, computeBaseline } from "../baselines.js";
import { DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from "../config.js";
import type { FindingState } from "../states.js";
import type { FindingRow, FindingSeverity, LifecycleStore } from "../store.js";
import { PROMPT_VERSION } from "./prompt.js";

export type ToolResult<T> =
	| { ok: true; result: T }
	| { ok: false; error: string };

export const TRIAGE_TOOL_NAMES = [
	"findings_list",
	"findings_get",
	"baseline_query",
	"record_triage",
	"report_file",
] as const;
export type TriageToolName = (typeof TRIAGE_TOOL_NAMES)[number];

const MAX_FINDINGS_LIST_LIMIT = 50;
const DEFAULT_FINDINGS_LIST_LIMIT = 20;
/** "recent events" for findings_get — bounded, not the full history (listEvents(id) has no LIMIT). */
const RECENT_EVENTS_LIMIT = 10;
const REPORT_FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const CAPTURE_KINDS = new Set(["sampling", "instrumentation", "telemetry"]);
/**
 * Windows reserved device basenames (CON, PRN, AUX, NUL, COM1-9, LPT1-9) are
 * reserved for the part of the name BEFORE the first '.', regardless of any
 * extension(s) after it — "con.txt" and "con.tar.gz" both resolve to the
 * CON device on Windows, not a regular file. Case-insensitive. The charset
 * check alone lets these through (they're plain letters/digits), so this is
 * a separate, explicit rejection.
 */
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface FindingsListRow {
	id: number;
	fingerprint: string;
	title: string;
	severity: FindingSeverity;
	state: FindingState;
	occurrences: number;
	lastSeenAt: string;
}

export interface FindingsGetResult extends FindingRow {
	occurrenceCount: number;
	/** Only the newest occurrence's details — the store has no bounded "last N" occurrence read (see Task 2 report). */
	latestOccurrenceDetails: string | null;
	recentEvents: Array<{
		event: string;
		fromState: string | null;
		toState: string;
		at: string;
		detail: string | null;
	}>;
}

export interface BaselineQueryResult {
	routineKey: string;
	captureKind: string;
	/** Stream the baseline was computed against — the routine's most recently observed stream for this tenant; null when no metric rows exist yet. */
	stream: string | null;
	baseline: BaselineStats | null;
}

export interface RecordTriageResult {
	recorded: boolean;
	message: string;
}

export interface ReportFileResult {
	path: string;
	bytesWritten: number;
}

export interface TriageToolsOptions {
	store: LifecycleStore;
	tenant: string;
	reportDir: string;
	/** No Date.now in library code — every timestamp this layer writes or queries against comes from here. */
	now: () => string;
	/** When true, record_triage returns "dry-run: not recorded" and makes zero writes. */
	dryRun?: boolean;
	config?: LifecycleConfig;
}

/**
 * report_file name sanitization (D4/D7): allow-list charset only — this
 * alone rejects path separators, drive-letter colons, and leading slashes,
 * since none of those characters are in the allowed set. `.` and `..` pass
 * the charset check (they're just dots) so they're rejected explicitly.
 */
export function sanitizeReportFileName(
	name: string,
): { ok: true; name: string } | { ok: false; error: string } {
	if (typeof name !== "string" || name.length === 0) {
		return { ok: false, error: "report_file: name must be a non-empty string" };
	}
	if (name === "." || name === "..") {
		return { ok: false, error: `report_file: name must not be '${name}'` };
	}
	if (!REPORT_FILE_NAME_RE.test(name)) {
		return {
			ok: false,
			error:
				"report_file: name must match [A-Za-z0-9._-]+ (no path separators, no drive letters)",
		};
	}
	const stem = name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
	if (WINDOWS_RESERVED_BASENAME_RE.test(stem)) {
		return {
			ok: false,
			error: `report_file: name '${name}' is a Windows reserved device name`,
		};
	}
	return { ok: true, name };
}

export class TriageTools {
	private readonly store: LifecycleStore;
	private readonly tenant: string;
	private readonly reportDir: string;
	private readonly now: () => string;
	private readonly dryRun: boolean;
	private readonly config: LifecycleConfig;

	constructor(opts: TriageToolsOptions) {
		this.store = opts.store;
		this.tenant = opts.tenant;
		this.reportDir = resolve(opts.reportDir);
		this.now = opts.now;
		this.dryRun = opts.dryRun ?? false;
		this.config = opts.config ?? DEFAULT_LIFECYCLE_CONFIG;
		mkdirSync(this.reportDir, { recursive: true });
	}

	/**
	 * The allow-list dispatch: routes a raw tool_use-shaped (name, input) pair
	 * to exactly one of the five D4 tools, or returns an error result for
	 * anything else. Never throws — an unknown or malformed call is data the
	 * agent loop (Task 3) can log and continue past, not a crash.
	 */
	dispatch(name: string, input: unknown): ToolResult<unknown> {
		// Blanket backstop for the class docstring's "never throws" contract:
		// every individual tool method is written to return an error result
		// rather than throw (reportFile's writeFileSync catch is the concrete
		// case that needed it — ENAMETOOLONG and friends), but this catch is
		// the guarantee, not the individual methods' discipline alone.
		try {
			const obj = (input && typeof input === "object" ? input : {}) as Record<
				string,
				unknown
			>;
			switch (name as TriageToolName) {
				case "findings_list":
					return this.findingsList({
						state: obj.state as FindingState | undefined,
						severity: obj.severity as FindingSeverity | undefined,
						limit: typeof obj.limit === "number" ? obj.limit : undefined,
					});
				case "findings_get":
					return this.findingsGet({ id: obj.id as number });
				case "baseline_query":
					return this.baselineQuery({
						routineKey: obj.routineKey as string,
						captureKind: obj.captureKind as
							| "sampling"
							| "instrumentation"
							| "telemetry",
					});
				case "record_triage":
					return this.recordTriage({
						id: obj.id as number,
						assessment: obj.assessment as string,
						recommendation: obj.recommendation as string,
					});
				case "report_file":
					return this.reportFile({
						name: obj.name as string,
						content: obj.content as string,
					});
				default:
					return { ok: false, error: `unknown tool: ${name}` };
			}
		} catch (err) {
			return {
				ok: false,
				error: `${name}: unexpected error — ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	findingsList(input: {
		state?: FindingState;
		severity?: FindingSeverity;
		limit?: number;
	}): ToolResult<FindingsListRow[]> {
		const limit = Math.max(
			1,
			Math.min(
				input.limit ?? DEFAULT_FINDINGS_LIST_LIMIT,
				MAX_FINDINGS_LIST_LIMIT,
			),
		);
		// listFindings has no severity filter (no index for it) — fetch by
		// tenant+state (the indexed dimensions) and filter+page in TS.
		const rows = this.store.listFindings({
			tenant: this.tenant,
			state: input.state,
		});
		const filtered = input.severity
			? rows.filter((r) => r.severity === input.severity)
			: rows;
		return {
			ok: true,
			result: filtered.slice(0, limit).map((r) => ({
				id: r.id,
				fingerprint: r.fingerprint,
				title: r.title,
				severity: r.severity,
				state: r.state,
				occurrences: this.store.countOccurrences(r.id),
				lastSeenAt: r.lastSeenAt,
			})),
		};
	}

	findingsGet(input: { id: number }): ToolResult<FindingsGetResult> {
		if (typeof input.id !== "number") {
			return { ok: false, error: "findings_get: id must be a number" };
		}
		const row = this.store.getFinding(input.id);
		// Same "not found" message whether the id is unknown or belongs to
		// another tenant — never confirm that another tenant's finding exists.
		if (!row || row.tenant !== this.tenant) {
			return { ok: false, error: `findings_get: no finding ${input.id}` };
		}
		const events = this.store
			.listEvents(input.id)
			.slice(-RECENT_EVENTS_LIMIT)
			.map((e) => ({
				event: e.event,
				fromState: e.fromState,
				toState: e.toState,
				at: e.at,
				detail: e.detail,
			}));
		return {
			ok: true,
			result: {
				...row,
				occurrenceCount: this.store.countOccurrences(input.id),
				latestOccurrenceDetails: this.store.getLatestOccurrenceDetails(
					input.id,
				),
				recentEvents: events,
			},
		};
	}

	baselineQuery(input: {
		routineKey: string;
		captureKind: "sampling" | "instrumentation" | "telemetry";
	}): ToolResult<BaselineQueryResult> {
		if (typeof input.routineKey !== "string" || input.routineKey.length === 0) {
			return {
				ok: false,
				error: "baseline_query: routineKey must be a non-empty string",
			};
		}
		if (!CAPTURE_KINDS.has(input.captureKind)) {
			return {
				ok: false,
				error:
					"baseline_query: captureKind must be sampling|instrumentation|telemetry",
			};
		}
		// computeBaseline is keyed by (tenant, stream, captureKind, routineKey)
		// but D4's baseline_query input has no `stream` — a finding doesn't
		// carry a single stream either (observedStreams can be plural). Resolve
		// it to the routine's most recently observed stream for this tenant;
		// see the Task 2 report for the alternative (routine_metrics_rollup)
		// considered and rejected because it's typically empty until data ages
		// past rawMetricsRetentionDays.
		const latest = this.store.db
			.query<{ stream: string }, [string, string, string]>(
				`SELECT stream FROM routine_metrics
				 WHERE tenant = ? AND capture_kind = ? AND routine_key = ?
				 ORDER BY capture_time DESC LIMIT 1`,
			)
			.get(this.tenant, input.captureKind, input.routineKey);
		if (!latest) {
			return {
				ok: true,
				result: {
					routineKey: input.routineKey,
					captureKind: input.captureKind,
					stream: null,
					baseline: null,
				},
			};
		}
		const baseline = computeBaseline(
			this.store,
			{
				tenant: this.tenant,
				stream: latest.stream,
				captureKind: input.captureKind,
				routineKey: input.routineKey,
			},
			this.now(),
			this.config.baselineWindow,
		);
		return {
			ok: true,
			result: {
				routineKey: input.routineKey,
				captureKind: input.captureKind,
				stream: latest.stream,
				baseline,
			},
		};
	}

	recordTriage(input: {
		id: number;
		assessment: string;
		recommendation: string;
	}): ToolResult<RecordTriageResult> {
		if (this.dryRun) {
			return {
				ok: true,
				result: { recorded: false, message: "dry-run: not recorded" },
			};
		}
		if (typeof input.id !== "number") {
			return { ok: false, error: "record_triage: id must be a number" };
		}
		const row = this.store.getFinding(input.id);
		if (!row || row.tenant !== this.tenant) {
			return { ok: false, error: `record_triage: no finding ${input.id}` };
		}
		const note = `[by agent-triage v${PROMPT_VERSION}] ${input.assessment}\n\nRecommendation: ${input.recommendation}`;
		const changed = this.store.recordTriage(
			input.id,
			note,
			"agent-triage",
			this.now(),
		);
		return {
			ok: true,
			result: changed
				? { recorded: true, message: "triage recorded" }
				: {
						recorded: false,
						message: "not recorded — finding already triaged",
					},
		};
	}

	reportFile(input: {
		name: string;
		content: string;
	}): ToolResult<ReportFileResult> {
		if (typeof input.content !== "string") {
			return { ok: false, error: "report_file: content must be a string" };
		}
		const sanitized = sanitizeReportFileName(input.name);
		if (!sanitized.ok) return sanitized;
		const target = resolve(this.reportDir, sanitized.name);
		const prefix = this.reportDir.endsWith(sep)
			? this.reportDir
			: this.reportDir + sep;
		// Defense-in-depth beyond the charset check (zip-extractor precedent).
		if (!target.startsWith(prefix)) {
			return {
				ok: false,
				error: "report_file: resolved path escapes the report directory",
			};
		}
		try {
			writeFileSync(target, input.content, "utf8");
		} catch (err) {
			// e.g. ENAMETOOLONG for a name near the filesystem's component-length
			// limit — the charset check has no length cap, so this is reachable.
			// dispatch()'s docstring promises no throw; this is where that
			// promise would otherwise have been broken.
			return {
				ok: false,
				error: `report_file: write failed — ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		return {
			ok: true,
			result: {
				path: target,
				bytesWritten: Buffer.byteLength(input.content, "utf8"),
			},
		};
	}
}
