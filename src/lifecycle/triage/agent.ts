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
 * model (the opening prompt, and every tool result) is wrapped in
 * `<finding-data>...</finding-data>` by `wrapFindingData` below — the SINGLE
 * framing point promised by tools.ts's module docstring.
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
// D5 framing helper — the ONE place finding-derived text gets wrapped.
// ---------------------------------------------------------------------------

/** Wraps arbitrary (potentially finding-derived) text in the non-instruction delimiter SYSTEM_PROMPT tells the model to treat as data, never commands. */
export function wrapFindingData(text: string): string {
	return `<finding-data>\n${text}\n</finding-data>`;
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

function buildOpeningMessage(row: FindingRow): string {
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
	return [
		`Triage finding #${row.id} for tenant "${row.tenant}". Investigate using your tools as needed, then call record_triage exactly once.`,
		"",
		wrapFindingData(JSON.stringify(summary, null, 2)),
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
/**
 * Carry-over hardening (Task 2 review): a huge finding — a large report_file
 * write, a verbose occurrence-details blob — must not balloon either the
 * audit log OR the model's context. The SAME bounded string is used for
 * both: computed once per tool call and reused for the audit resultSummary
 * and the <finding-data>-wrapped tool_result content sent back to the model.
 */
const RESULT_SUMMARY_MAX_CHARS = 500;

function summarizeToolResult(result: ToolResult<unknown>): string {
	const raw = result.ok
		? JSON.stringify(result.result)
		: `error: ${result.error}`;
	if (raw.length <= RESULT_SUMMARY_MAX_CHARS) return raw;
	return `${raw.slice(0, RESULT_SUMMARY_MAX_CHARS)}…[truncated]`;
}

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
): Promise<FindingOutcome> {
	// Fresh messages array PER FINDING (D3) — nothing from a prior finding's
	// conversation is ever referenced here.
	const messages: TriageClientMessage[] = [
		{ role: "user", content: buildOpeningMessage(row) },
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
			// Computed once, reused for both sinks — see RESULT_SUMMARY_MAX_CHARS.
			const resultSummary = summarizeToolResult(result);
			auditLog.logToolCall({
				findingId: row.id,
				tool: block.name,
				input: block.input,
				resultSummary,
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
				// wrapping point tools.ts's docstring defers to here. Bounded
				// (resultSummary), not the raw JSON.stringify(result) — see
				// RESULT_SUMMARY_MAX_CHARS.
				content: wrapFindingData(resultSummary),
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
