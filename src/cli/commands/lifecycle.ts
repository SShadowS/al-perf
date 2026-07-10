import chalk from "chalk";
import Table from "cli-table3";
import { Command } from "commander";
import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { analyzeProfile } from "../../core/analyzer.js";
import { rollupRoutineMetrics } from "../../lifecycle/baselines.js";
import {
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig,
} from "../../lifecycle/config.js";
import { buildDigest, renderDigestMarkdown } from "../../lifecycle/digest.js";
import { evaluateRun } from "../../lifecycle/evaluate.js";
import { transition } from "../../lifecycle/states.js";
import { LifecycleStore } from "../../lifecycle/store.js";

/** CLI default DB location (plan decision: dot-dir in cwd, one file). */
export const DEFAULT_DB_PATH = ".al-perf/lifecycle.sqlite";

/**
 * Close a resolved finding (human confirmation). Exported for tests; the
 * `lifecycle close` subcommand is a thin wrapper. Close is only legal from
 * `resolved` — the state machine enforces it.
 */
export function applyClose(
	store: LifecycleStore,
	tenant: string,
	fingerprint: string,
	now: string,
): { ok: boolean; message: string } {
	const row = store.getActiveFinding(tenant, fingerprint);
	if (!row) {
		return { ok: false, message: `No active finding for ${fingerprint}` };
	}
	const res = transition(
		row.state,
		{ type: "close" },
		{
			absenceCount: row.absenceCount,
			resolveAfterRuns: DEFAULT_LIFECYCLE_CONFIG.resolveAfterRuns,
		},
	);
	if (!res.ok) return { ok: false, message: res.reason };
	store.updateFindingState(row.id, { state: "closed", closedAt: now });
	store.logEvent({
		findingId: row.id,
		event: "closed",
		fromState: row.state,
		toState: "closed",
		at: now,
	});
	return { ok: true, message: `Closed ${fingerprint}` };
}

export function createLifecycleCommand(): Command {
	const cmd = new Command("lifecycle")
		.description(
			"Finding lifecycle engine — durable finding state across profile runs",
		)
		.option("--db <path>", "Lifecycle database file", DEFAULT_DB_PATH);

	cmd
		.command("evaluate <profile>")
		.description("Analyze a profile and evaluate finding lifecycle state")
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--stream <stream>", "Capture stream (schedule/job id)", "adhoc")
		.option(
			"--profile-id <id>",
			"Idempotency key (default: sha256 of the file content)",
		)
		.option(
			"--capture-time <iso>",
			"Profile capture time, ISO 8601 (default: file mtime)",
		)
		.option("-s, --source <path>", "AL source directory")
		.option("--resolve-after <n>", "Absent runs before a finding resolves")
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action(async (profilePath: string, opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const result = await analyzeProfile(profilePath, {
					includePatterns: true,
					sourcePath: opts.source,
				});
				const profileId =
					opts.profileId ??
					createHash("sha256")
						.update(readFileSync(profilePath))
						.digest("hex")
						.slice(0, 32);
				const captureTime =
					opts.captureTime ?? statSync(profilePath).mtime.toISOString();
				const configPatch: Partial<LifecycleConfig> = {};
				if (opts.resolveAfter !== undefined) {
					configPatch.resolveAfterRuns = parseInt(opts.resolveAfter, 10);
				}
				const outcome = evaluateRun(
					store,
					result,
					{
						tenant: opts.tenant,
						stream: opts.stream,
						profileId,
						captureKind: result.meta.captureKind ?? result.meta.profileType,
						captureTime,
					},
					configPatch,
				);
				if (opts.format === "json") {
					process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
					return;
				}
				const skipped = outcome.skipped ? ` (${outcome.skipped})` : "";
				console.log(
					`Run ${outcome.runId}${skipped}: ${outcome.findingsSeen} findings seen, ` +
						`${outcome.transitions.length} transitions, ${outcome.unfingerprinted} unfingerprinted` +
						(outcome.incomplete
							? " [incomplete capture — absence not counted]"
							: ""),
				);
				for (const t of outcome.transitions) {
					console.log(
						`  ${t.fingerprint}: ${t.from ?? "-"} -> ${t.to} (${t.event})`,
					);
				}
			} finally {
				store.close();
			}
		});

	cmd
		.command("digest")
		.description("Render the finding digest (digest-first reporting posture)")
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--since <iso>", "Only activity at/after this time")
		.option("-f, --format <format>", "Output format: markdown|json", "markdown")
		.action((opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const digest = buildDigest(store, {
					tenant: opts.tenant,
					since: opts.since,
				});
				process.stdout.write(
					opts.format === "json"
						? JSON.stringify(digest, null, 2) + "\n"
						: renderDigestMarkdown(digest),
				);
			} finally {
				store.close();
			}
		});

	cmd
		.command("status")
		.description("List findings and their lifecycle state")
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--state <state>", "Filter by state")
		.option("--triage", "Only needs-triage findings")
		.option("-n, --limit <n>", "Maximum findings to show", "50")
		.option("-f, --format <format>", "Output format: table|json", "table")
		.action((opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const rows = store.listFindings({
					tenant: opts.tenant,
					state: opts.state,
					needsTriage: opts.triage ? true : undefined,
					limit: parseInt(opts.limit, 10),
				});
				if (opts.format === "json") {
					process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
					return;
				}
				if (rows.length === 0) {
					console.log("No findings.");
					return;
				}
				const table = new Table({
					head: [
						chalk.gray("State"),
						chalk.gray("Sev"),
						chalk.gray("Title"),
						chalk.gray("Fingerprint"),
						chalk.gray("Last seen"),
						chalk.gray("Absent"),
						chalk.gray("Triage"),
					],
					style: { head: [], border: [] },
				});
				for (const r of rows) {
					table.push([
						r.state,
						r.severity,
						r.title.slice(0, 40),
						r.fingerprint,
						r.lastSeenAt.slice(0, 19),
						String(r.absenceCount),
						r.needsTriage ? "yes" : "",
					]);
				}
				console.log(table.toString());
			} finally {
				store.close();
			}
		});

	cmd
		.command("close <fingerprint>")
		.description("Close a RESOLVED finding (human confirmation)")
		.option("--tenant <tenant>", "Tenant key", "local")
		.action((fingerprint: string, opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const res = applyClose(
					store,
					opts.tenant,
					fingerprint,
					new Date().toISOString(),
				);
				if (!res.ok) {
					console.error(res.message);
					process.exitCode = 1;
					return;
				}
				console.log(res.message);
			} finally {
				store.close();
			}
		});

	cmd
		.command("triage <fingerprint>")
		.description("Set or clear the needs-triage flag")
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--clear", "Clear the flag instead of setting it")
		.action((fingerprint: string, opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const row = store.getActiveFinding(opts.tenant, fingerprint);
				if (!row) {
					console.error(`No active finding for ${fingerprint}`);
					process.exitCode = 1;
					return;
				}
				store.setNeedsTriage(row.id, !opts.clear);
				console.log(
					`${opts.clear ? "Cleared" : "Set"} needs-triage on ${fingerprint}`,
				);
			} finally {
				store.close();
			}
		});

	cmd
		.command("maintain")
		.description(
			"Run store maintenance: roll up routine metrics older than the retention window",
		)
		.option(
			"--retention-days <n>",
			"Raw metric retention in days",
			String(DEFAULT_LIFECYCLE_CONFIG.rawMetricsRetentionDays),
		)
		.action((opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const res = rollupRoutineMetrics(
					store,
					new Date().toISOString(),
					parseInt(opts.retentionDays, 10),
				);
				console.log(
					`Rolled up ${res.rolledUp} day-buckets, deleted ${res.deleted} raw rows.`,
				);
			} finally {
				store.close();
			}
		});

	return cmd;
}
