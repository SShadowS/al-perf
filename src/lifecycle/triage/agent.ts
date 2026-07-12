/**
 * agent.ts — the triage agent loop (plan D1/D3/D4/D5, Task 3). Drives a
 * fresh tool-use conversation per needs-triage finding against an injected,
 * Anthropic-shaped `client` — no import of `@anthropic-ai/sdk` here at all,
 * so this module (and its tests) never touch the real SDK or a live API.
 * The CLI (src/cli/commands/lifecycle.ts) owns constructing the real
 * `Anthropic` client and adapting it to `TriageClient`.
 *
 * D3 — one finding at a time, each in a FRESH conversation: a hostile
 * finding's text can only ever appear in the ONE conversation that
 * investigates it, never bleed into the next finding's messages array.
 *
 * D5 — data-not-instructions: every finding-derived string handed to the
 * model (the opening prompt, and every tool result) is wrapped by
 * `wrapFindingData` below — the SINGLE framing point promised by tools.ts's
 * module docstring — in a delimiter that carries a per-RUN nonce
 * (`<finding-data id="...">...</finding-data id="...">`) AND has any
 * literal delimiter-lookalike text inside it neutralized. Both are needed:
 * a fixed, nonce-less delimiter is forgeable by finding text containing a
 * literal `</finding-data>` (closes the block early, everything after reads
 * as harness-authored); the nonce alone stops that but a defense-in-depth
 * escape also blocks a lookalike from ever appearing in the raw text at
 * all. See `wrapFindingData`'s docstring for the full reasoning.
 */

import type { LifecycleConfig } from "../config.js";
import type { FindingRow, LifecycleStore } from "../store.js";
import { TriageAuditLog } from "./audit.js";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt.js";
import type { ToolResult } from "./tools.js";
import { TriageTools } from "./tools.js";

// ---------------------------------------------------------------------------
// Client shape — the "Anthropic-shaped" injectable boundary. Deliberately a
// small, self-owned interface (not `import type Anthropic from
// "@anthropic-ai/sdk"`) so a scripted fake in tests satisfies it exactly,
// and so the real SDK's much larger content-block union never needs to be
// reasoned about here.
// ---------------------------------------------------------------------------

export interface TriageTextBlock {
	type: "text";
	text: string;
}

export interface TriageToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

export type TriageContentBlock = TriageTextBlock | TriageToolUseBlock;

export interface TriageToolResultBlockParam {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

export type TriageMessageContentParam =
	| TriageTextBlock
	| TriageToolUseBlock
	| TriageToolResultBlockParam;

export interface TriageClientMessage {
	role: "user" | "assistant";
	content: string | TriageMessageContentParam[];
}

export interface TriageToolDef {
	name: string;
	description: string;
	input_schema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
}

export interface TriageClientUsage {
	input_tokens: number;
	output_tokens: number;
}

export interface TriageClientResponse {
	content: TriageContentBlock[];
	stop_reason: string | null;
	usage: TriageClientUsage;
}

export interface TriageClientCreateParams {
	model: string;
	max_tokens: number;
	system: string;
	messages: TriageClientMessage[];
	tools: TriageToolDef[];
}

/** The full injectable client shape — an `Anthropic` instance is adapted to this at the CLI boundary, not passed in directly. */
export interface TriageClient {
	messages: {
		create(params: TriageClientCreateParams): Promise<TriageClientResponse>;
	};
}

// ---------------------------------------------------------------------------
// D4 tool definitions — the exact five, described for the model.
// ---------------------------------------------------------------------------

export const TRIAGE_TOOL_DEFS: TriageToolDef[] = [
	{
		name: "findings_list",
		description:
			"List findings for the current tenant (read-only). Optionally filter by state or severity; capped at 50 rows regardless of the requested limit.",
		input_schema: {
			type: "object",
			properties: {
				state: {
					type: "string",
					enum: ["new", "open", "regressed", "improving", "resolved", "closed"],
				},
				severity: { type: "string", enum: ["critical", "warning", "info"] },
				limit: { type: "number" },
			},
		},
	},
	{
		name: "findings_get",
		description:
			"Get full detail for one finding by id (read-only), including occurrence count, the latest occurrence's details, and recent lifecycle events.",
		input_schema: {
			type: "object",
			properties: { id: { type: "number" } },
			required: ["id"],
		},
	},
	{
		name: "baseline_query",
		description:
			"Query rollup baseline stats (median, spread, sample count) for a routine (read-only).",
		input_schema: {
			type: "object",
			properties: {
				routineKey: { type: "string" },
				captureKind: {
					type: "string",
					enum: ["sampling", "instrumentation", "telemetry"],
				},
			},
			required: ["routineKey", "captureKind"],
		},
	},
	{
		name: "record_triage",
		description:
			"Record your triage assessment and recommendation for the finding under investigation. The ONLY way to complete work on a finding — call it exactly once, when you are done investigating.",
		input_schema: {
			type: "object",
			properties: {
				id: { type: "number" },
				assessment: { type: "string" },
				recommendation: { type: "string" },
			},
			required: ["id", "assessment", "recommendation"],
		},
	},
	{
		name: "report_file",
		description:
			"Write a supplementary write-up for a human into the report directory. Optional — most findings don't need one.",
		input_schema: {
			type: "object",
			properties: {
				name: { type: "string" },
				content: { type: "string" },
			},
			required: ["name", "content"],
		},
	},
];

// ---------------------------------------------------------------------------
// D5 framing + bounding — the ONE place finding-derived text gets wrapped,
// and the ONE place it gets size-capped, before it reaches the model or the
// audit log (Task 3 review fixes).
// ---------------------------------------------------------------------------

/**
 * D5 belt-and-suspenders: even with `wrapFindingData`'s per-run nonce making
 * a MATCHING close tag unguessable to text authored before this run
 * started, finding-derived text must never be able to even superficially
 * resemble a `<finding-data>` delimiter. Neutralizes `<finding-data` /
 * `</finding-data` (case-insensitive) by swapping the leading `<` for a
 * lookalike character, so the text stays legible (the model can still see
 * something was there) rather than being silently deleted — and so this
 * defense holds even if a future refactor ever drops the nonce.
 */
function escapeDelimiterLookalikes(text: string): string {
	return text.replace(/<(\/?finding-data)/gi, "‹$1");
}

/**
 * Wraps arbitrary (potentially finding-derived) text in the non-instruction
 * delimiter SYSTEM_PROMPT tells the model to treat as data, never commands.
 *
 * `nonce` is unique per RUN (the CLI's already-random, already-sanitized
 * runId — see `runTriageAgent`) and unknown to whatever authored the
 * finding text, since that text was written before this run existed. A
 * literal `</finding-data>` inside a hostile title can therefore never
 * match the harness's actual closing tag, `</finding-data id="<nonce>">` —
 * closing the block early would require guessing the nonce in advance.
 * `escapeDelimiterLookalikes` is the second, independent layer: it
 * neutralizes any literal delimiter-shaped text before the real tags are
 * even added, so the defense doesn't rest on the nonce alone.
 */
export function wrapFindingData(text: string, nonce: string): string {
	const escaped = escapeDelimiterLookalikes(text);
	return `<finding-data id="${nonce}">\n${escaped}\n</finding-data id="${nonce}">`;
}

/**
 * Mints an operator-safe runId (carry-over hardening, Task 2 review):
 * TriageAuditLog's constructor now throws on a runId outside
 * `[A-Za-z0-9._-]+` (it's interpolated into a filename). No `Date.now` in
 * this library module — the CLI calls `mintRunId(new Date())`, a pure
 * formatting function over a caller-supplied Date. An ISO timestamp's only
 * disallowed character is `:`; replacing it keeps the id readable and
 * sortable (e.g. `2026-07-12T12-00-00.000Z`).
 */
export function mintRunId(date: Date): string {
	return date.toISOString().replace(/:/g, "-");
}

/**
 * Two DIFFERENT bounds (Task 3 review fix — a single shared 500-char bound
 * starved the model of usable tool output), not one shared number:
 *   - MODEL_TOOL_RESULT_MAX_CHARS: generous — the model needs enough of a
 *     findings_get/findings_list result (or the opening finding summary) to
 *     actually do its job; a single finding row easily exceeds a tight
 *     bound on its own.
 *   - AUDIT_RESULT_SUMMARY_MAX_CHARS: tight — the audit log is a
 *     human-skimmed, local file; a one-line resultSummary is enough to know
 *     what happened, not a full replay.
 * Both still cap a hostile blob's worst case (carry-over hardening, Task 2
 * review) — only the "how much does the model see" tradeoff differs.
 */
const MODEL_TOOL_RESULT_MAX_CHARS = 8000;
const AUDIT_RESULT_SUMMARY_MAX_CHARS = 500;
const TRUNCATION_MARKER = "…[truncated]";

/**
 * Truncates to at most `maxChars` UTF-16 code units, backing off one further
 * unit if the cut would otherwise land inside a surrogate pair (Task 3
 * review fix) — plain `.slice()` is code-unit-based and can split a pair,
 * leaving an unpaired surrogate (e.g. half of an emoji) in the output.
 */
function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	let end = maxChars;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}

function rawToolResultText(result: ToolResult<unknown>): string {
	return result.ok ? JSON.stringify(result.result) : `error: ${result.error}`;
}

/**
 * Bounds a tool call's `input` before it's written to the audit log (Task 3
 * review minor: symmetry with resultSummary — an unbounded input could
 * balloon the audit file same as an unbounded result). Kept as the original
 * structured object (readable JSONL) in the common case; only degrades to a
 * truncated string when the serialized input is itself oversized.
 */
function boundedAuditInput(input: unknown): unknown {
	const raw = JSON.stringify(input) ?? "undefined";
	if (raw.length <= AUDIT_RESULT_SUMMARY_MAX_CHARS) return input;
	return truncate(raw, AUDIT_RESULT_SUMMARY_MAX_CHARS);
}

function buildOpeningMessage(row: FindingRow, nonce: string): string {
	const summary = {
		id: row.id,
		fingerprint: row.fingerprint,
		title: row.title,
		severity: row.severity,
		state: row.state,
		source: row.source,
		patternId: row.patternId,
		appId: row.appId,
		appName: row.appName,
		routineKey: row.routineKey,
		absenceCount: row.absenceCount,
	};
	// Task 3 review fix: bounded through the SAME model-facing limit as tool
	// results — an oversized title/appName/routineKey must not balloon the
	// very first turn of every finding's conversation. The cumulative budget
	// check only runs BETWEEN findings (see runTriageAgent below), so it
	// can't catch an oversized opening message on its own.
	const serialized = truncate(
		JSON.stringify(summary, null, 2),
		MODEL_TOOL_RESULT_MAX_CHARS,
	);
	return [
		`Triage finding #${row.id} for tenant "${row.tenant}". Investigate using your tools as needed, then call record_triage exactly once.`,
		"",
		wrapFindingData(serialized, nonce),
	].join("\n");
}

// ---------------------------------------------------------------------------
// Config / options / result types.
// ---------------------------------------------------------------------------

export interface TriageAgentConfig {
	tenant: string;
	reportDir: string;
	/** How many needs-triage findings this run considers, at most. */
	maxFindings: number;
	/** Tool-use turns allowed per finding before it's skipped as a runaway loop. */
	maxTurnsPerFinding: number;
	/** Cumulative usage (input+output tokens) across the whole run; checked BEFORE starting each finding. */
	budgetTokens: number;
	model: string;
	dryRun: boolean;
}

export interface TriageAgentRunOptions {
	/** No Date.now in library code — every timestamp this loop writes comes from here. */
	now: () => string;
	/** Sanitized by TriageAuditLog's constructor (same charset as report_file names). */
	runId: string;
	/** Passed through to TriageTools for baseline_query; defaults if omitted. */
	lifecycleConfig?: LifecycleConfig;
	/** Cap on tokens sent per model turn; defaults to a generous fixed value — not currently CLI-configurable. */
	maxTokensPerTurn?: number;
}

export type TriageFindingSkipReason = "max-turns" | "no-action";

export interface TriageAgentRunResult {
	tenant: string;
	findingsConsidered: number;
	findingsTriaged: number;
	findingsSkipped: number;
	skipped: Array<{ findingId: number; reason: TriageFindingSkipReason }>;
	tokenUsage: { inputTokens: number; outputTokens: number };
	/** Set when the run stopped early because the cumulative budget was hit before starting the next finding. */
	stoppedForBudget: boolean;
	auditPath: string;
}

const DEFAULT_MAX_TOKENS_PER_TURN = 2048;

interface FindingOutcome {
	triaged: boolean;
	skipReason?: TriageFindingSkipReason;
	usage: { inputTokens: number; outputTokens: number };
}

/** Drives ONE finding's fresh conversation to completion (record_triage called), a skip (max-turns / no-action), or a text-only give-up. */
async function triageOneFinding(
	row: FindingRow,
	tools: TriageTools,
	auditLog: TriageAuditLog,
	client: TriageClient,
	config: TriageAgentConfig,
	maxTokensPerTurn: number,
	/** Per-run D5 nonce — see wrapFindingData's docstring and runTriageAgent below. */
	nonce: string,
): Promise<FindingOutcome> {
	// Fresh messages array PER FINDING (D3) — nothing from a prior finding's
	// conversation is ever referenced here.
	const messages: TriageClientMessage[] = [
		{ role: "user", content: buildOpeningMessage(row, nonce) },
	];

	let inputTokens = 0;
	let outputTokens = 0;
	let triaged = false;
	// Distinguishes the two skip reasons: the model ran out of turns still
	// trying (max-turns), vs. the model stopped acting on its own, before the
	// turn cap, without ever calling record_triage (no-action).
	let gaveUpWithoutActing = false;

	for (let turn = 1; turn <= config.maxTurnsPerFinding; turn++) {
		const response = await client.messages.create({
			model: config.model,
			max_tokens: maxTokensPerTurn,
			system: SYSTEM_PROMPT,
			messages,
			tools: TRIAGE_TOOL_DEFS,
		});
		inputTokens += response.usage.input_tokens;
		outputTokens += response.usage.output_tokens;

		messages.push({ role: "assistant", content: response.content });

		const toolUseBlocks = response.content.filter(
			(b): b is TriageToolUseBlock => b.type === "tool_use",
		);
		if (toolUseBlocks.length === 0) {
			// The model gave a final text reply without invoking any tool —
			// nothing left for this loop to drive.
			gaveUpWithoutActing = true;
			break;
		}

		const toolResults: TriageMessageContentParam[] = [];
		for (const block of toolUseBlocks) {
			const result = tools.dispatch(block.name, block.input);
			// Raw text computed once; two DIFFERENT bounds applied to it — see
			// MODEL_TOOL_RESULT_MAX_CHARS/AUDIT_RESULT_SUMMARY_MAX_CHARS's
			// docstring for why they're no longer the same number.
			const raw = rawToolResultText(result);
			const auditSummary = truncate(raw, AUDIT_RESULT_SUMMARY_MAX_CHARS);
			const modelText = truncate(raw, MODEL_TOOL_RESULT_MAX_CHARS);
			auditLog.logToolCall({
				findingId: row.id,
				tool: block.name,
				// Task 3 review minor: bounded for the same reason resultSummary
				// is — an oversized tool_use input must not balloon the audit file.
				input: boundedAuditInput(block.input),
				resultSummary: auditSummary,
			});
			if (block.name === "record_triage" && result.ok) {
				// Structural success (the call was well-formed and dispatched),
				// not "the DB row actually flipped" — dry-run and the race guard
				// both return ok:true with recorded:false in RecordTriageResult,
				// and both still count as "the agent did its job" for this run.
				triaged = true;
			}
			toolResults.push({
				type: "tool_result",
				tool_use_id: block.id,
				// D5: tool results echo store data back to the model — the single
				// wrapping point tools.ts's docstring defers to here. Bounded to
				// the generous model-facing limit (modelText), not the raw
				// JSON.stringify(result) and not the tighter audit bound.
				content: wrapFindingData(modelText, nonce),
				is_error: !result.ok,
			});
		}
		messages.push({ role: "user", content: toolResults });

		if (triaged) break;
	}

	if (triaged) {
		return { triaged: true, usage: { inputTokens, outputTokens } };
	}
	return {
		triaged: false,
		skipReason: gaveUpWithoutActing ? "no-action" : "max-turns",
		usage: { inputTokens, outputTokens },
	};
}

export async function runTriageAgent(
	store: LifecycleStore,
	config: TriageAgentConfig,
	options: TriageAgentRunOptions,
	client: TriageClient,
): Promise<TriageAgentRunResult> {
	const auditLog = new TriageAuditLog({
		reportDir: config.reportDir,
		runId: options.runId,
		now: options.now,
	});
	const tools = new TriageTools({
		store,
		tenant: config.tenant,
		reportDir: config.reportDir,
		now: options.now,
		dryRun: config.dryRun,
		config: options.lifecycleConfig,
	});

	auditLog.logRunStart({
		model: config.model,
		promptVersion: PROMPT_VERSION,
		tenant: config.tenant,
		dryRun: config.dryRun,
	});

	const candidates = store.listFindings({
		tenant: config.tenant,
		needsTriage: true,
		limit: config.maxFindings,
	});

	// D5 nonce (Task 3 review fix): reuse the run's already-random,
	// already-sanitized runId — minted at the CLI boundary BEFORE any
	// finding is read, so no finding's stored text (however old) could ever
	// have been crafted to match it. One nonce per RUN, not per finding, is
	// enough: the same unpredictability property holds for every finding
	// investigated in this run. See wrapFindingData's docstring.
	const nonce = options.runId;

	let triagedCount = 0;
	const skipped: Array<{ findingId: number; reason: TriageFindingSkipReason }> =
		[];
	let inputTokens = 0;
	let outputTokens = 0;
	let stoppedForBudget = false;
	const maxTokensPerTurn =
		options.maxTokensPerTurn ?? DEFAULT_MAX_TOKENS_PER_TURN;

	for (const row of candidates) {
		// D3: budget is checked BEFORE starting a finding, using cumulative
		// usage so far — a finding already in progress is allowed to finish;
		// remaining findings after the cutoff are left completely untouched
		// (not even attempted, let alone counted as skipped).
		if (inputTokens + outputTokens >= config.budgetTokens) {
			stoppedForBudget = true;
			break;
		}

		const outcome = await triageOneFinding(
			row,
			tools,
			auditLog,
			client,
			config,
			maxTokensPerTurn,
			nonce,
		);
		inputTokens += outcome.usage.inputTokens;
		outputTokens += outcome.usage.outputTokens;

		if (outcome.triaged) {
			triagedCount++;
		} else {
			const reason = outcome.skipReason ?? "no-action";
			skipped.push({ findingId: row.id, reason });
			auditLog.logToolCall({
				findingId: row.id,
				tool: "_agent",
				input: {},
				resultSummary: `skipped: ${reason}`,
			});
		}
	}

	auditLog.logRunEnd({
		findingsTriaged: triagedCount,
		findingsSkipped: skipped.length,
		tokenUsage: { inputTokens, outputTokens },
		stoppedReason: stoppedForBudget ? "budget" : undefined,
	});

	return {
		tenant: config.tenant,
		findingsConsidered: candidates.length,
		findingsTriaged: triagedCount,
		findingsSkipped: skipped.length,
		skipped,
		tokenUsage: { inputTokens, outputTokens },
		stoppedForBudget,
		auditPath: auditLog.filePath(),
	};
}

// ---------------------------------------------------------------------------
// Output rendering — pure, so it's testable without the CLI or a client.
// ---------------------------------------------------------------------------

export function renderTriageAgentSummary(
	result: TriageAgentRunResult,
	format: "text" | "json",
): string {
	if (format === "json") {
		return `${JSON.stringify(result, null, 2)}\n`;
	}
	const lines = [
		`triage-agent (${result.tenant}): ${result.findingsTriaged} triaged, ${result.findingsSkipped} skipped, ` +
			`${result.tokenUsage.inputTokens + result.tokenUsage.outputTokens} tokens used ` +
			`(${result.tokenUsage.inputTokens} in / ${result.tokenUsage.outputTokens} out)` +
			(result.stoppedForBudget ? " — stopped: budget exhausted" : ""),
	];
	for (const s of result.skipped) {
		lines.push(`  skipped #${s.findingId}: ${s.reason}`);
	}
	lines.push(`Audit log: ${result.auditPath}`);
	return `${lines.join("\n")}\n`;
}
