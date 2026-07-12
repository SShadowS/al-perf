/**
 * audit.ts — JSONL audit log for the triage agent (plan D7). One line per
 * tool call, plus a run-start/run-end header/footer. Appended atomically
 * (appendFileSync — no buffered writer that could lose lines on a crash).
 *
 * This module has no knowledge of ANTHROPIC_API_KEY or any credential — it
 * only ever writes what callers hand it (tool name, tool input, a result
 * summary string), so the log can never leak a key it never saw.
 *
 * The agent loop (Task 3) drives this: logRunStart once, logToolCall per
 * dispatched tool, logRunEnd once. This module owns only the file format
 * and the append mechanics.
 */

import { appendFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

export interface AuditToolCallEntry {
	findingId?: number;
	tool: string;
	input: unknown;
	resultSummary: string;
}

export interface AuditRunStartInfo {
	model: string;
	promptVersion: number;
	tenant: string;
	dryRun: boolean;
}

export interface AuditRunEndInfo {
	findingsTriaged: number;
	findingsSkipped: number;
	tokenUsage: { inputTokens: number; outputTokens: number };
	stoppedReason?: string;
}

export interface TriageAuditLogOptions {
	reportDir: string;
	runId: string;
	/** No Date.now in library code — every entry's ts comes from here. */
	now: () => string;
}

export class TriageAuditLog {
	private readonly path: string;
	private readonly now: () => string;

	constructor(opts: TriageAuditLogOptions) {
		const dir = resolve(opts.reportDir);
		mkdirSync(dir, { recursive: true });
		this.path = join(dir, `audit-${opts.runId}.jsonl`);
		this.now = opts.now;
	}

	/** Absolute path to the JSONL file this instance writes to. */
	filePath(): string {
		return this.path;
	}

	private append(line: Record<string, unknown>): void {
		appendFileSync(this.path, `${JSON.stringify(line)}\n`, "utf8");
	}

	logRunStart(info: AuditRunStartInfo): void {
		this.append({ ts: this.now(), kind: "run-start", ...info });
	}

	/** D7 shape: {ts, findingId?, tool, input, resultSummary}. */
	logToolCall(entry: AuditToolCallEntry): void {
		this.append({
			ts: this.now(),
			findingId: entry.findingId,
			tool: entry.tool,
			input: entry.input,
			resultSummary: entry.resultSummary,
		});
	}

	logRunEnd(info: AuditRunEndInfo): void {
		this.append({ ts: this.now(), kind: "run-end", ...info });
	}
}
