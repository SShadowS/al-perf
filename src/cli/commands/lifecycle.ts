import chalk from "chalk";
import Table from "cli-table3";
import { Command } from "commander";
import { createHash } from "crypto";
import { readFileSync, statSync, writeFileSync } from "fs";
import { analyzeProfile } from "../../core/analyzer.js";
import {
	DEFAULT_API_KEY_ENV,
	DEFAULT_SIGNALS,
	DEFAULT_SINCE,
	pullTelemetry,
} from "../../lifecycle/appinsights.js";
import { rollupRoutineMetrics } from "../../lifecycle/baselines.js";
import {
	type CaptureTriggerReport,
	processCaptureTriggers,
} from "../../lifecycle/capture-triggers.js";
import {
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig,
} from "../../lifecycle/config.js";
import { buildDigest, renderDigestMarkdown } from "../../lifecycle/digest.js";
import {
	type EvaluationOutcome,
	evaluateRun,
} from "../../lifecycle/evaluate.js";
import { createGitHubSink } from "../../lifecycle/sinks/github.js";
import { drainOutbox } from "../../lifecycle/sinks/outbox.js";
import { processEventsForSinks } from "../../lifecycle/sinks/triggers.js";
import {
	loadSinksConfig,
	resolveGitHubConfig,
} from "../../lifecycle/sinks/types.js";
import { transition } from "../../lifecycle/states.js";
import { LifecycleStore } from "../../lifecycle/store.js";
import { evaluateTelemetryBatch } from "../../lifecycle/telemetry.js";
import type { TelemetryBatchDocument } from "../../types/telemetry.js";

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

/**
 * Shared claim/cancel failure message (capture-requests plan Task 4): names
 * the row's CURRENT status, not just "failed" — an executor needs to tell
 * "already claimed by someone else" from "already fulfilled" from "no such
 * id" apart without a second query. Unknown id gets its own wording.
 */
function captureRequestFailureMessage(
	store: LifecycleStore,
	id: number,
	verb: "claimed" | "cancelled",
): string {
	const row = store.listCaptureRequests().find((r) => r.id === id);
	if (!row) return `No capture request with id ${id}.`;
	return `Capture request #${id} cannot be ${verb} — status is ${row.status}.`;
}

/** Shared by `evaluate`, `telemetry`, and `pull-telemetry` (non---out path) — same outcome shape, same print rules. */
function printEvaluationOutcome(
	outcome: EvaluationOutcome,
	format: string,
): void {
	if (format === "json") {
		process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
		return;
	}
	const skipped = outcome.skipped ? ` (${outcome.skipped})` : "";
	console.log(
		`Run ${outcome.runId}${skipped}: ${outcome.findingsSeen} findings seen, ` +
			`${outcome.transitions.length} transitions, ${outcome.unfingerprinted} unfingerprinted` +
			(outcome.incomplete ? " [incomplete capture — absence not counted]" : ""),
	);
	for (const t of outcome.transitions) {
		console.log(`  ${t.fingerprint}: ${t.from ?? "-"} -> ${t.to} (${t.event})`);
	}
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
				printEvaluationOutcome(outcome, opts.format);
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

	cmd
		.command("sync")
		.description(
			"Run the capture-request scan, apply sink trigger rules, and drain the delivery outbox",
		)
		.option(
			"--config <path>",
			"Sinks config file",
			".al-perf/lifecycle.config.json",
		)
		.option(
			"--dry-run",
			"Scan and enqueue locally (capture requests + outbox), but do not deliver to sinks",
		)
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action(async (opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const now = new Date().toISOString();
				// Independent of any sink being configured: capture-request filing
				// is local DB state, not delivery, so it must not depend on — or be
				// blocked by — a missing/absent sinks config.
				let captureRequests: CaptureTriggerReport = {
					scanned: 0,
					created: 0,
					expired: 0,
					skippedMaxPending: 0,
				};
				if (DEFAULT_LIFECYCLE_CONFIG.captureRequests.enabled) {
					captureRequests = processCaptureTriggers(
						store,
						DEFAULT_LIFECYCLE_CONFIG,
						now,
					);
				}

				const config = loadSinksConfig(opts.config);
				let triggers = { processed: 0, enqueued: 0, skippedMigration: 0 };
				let drain = { delivered: 0, retried: 0, dead: 0, collapsed: 0 };
				let deadLetters: Array<{
					id: number;
					kind: string;
					dedupeKey: string;
					attempts: number;
					lastError: string | null;
				}> = [];

				if (!config) {
					console.error(
						`No sink config at ${opts.config} — sink delivery skipped (capture-request scan still ran). Zero-custody alternative: drive 'gh issue create' from 'lifecycle digest -f json' — see docs/lifecycle-gh-recipe.md.`,
					);
				} else {
					triggers = processEventsForSinks(store, config);
					const gh = config.sinks.github;
					if (!opts.dryRun && gh?.enabled) {
						const resolved = resolveGitHubConfig(gh);
						const token = process.env[resolved.tokenEnv];
						if (!token) {
							console.error(
								`sinks.github is enabled but the ${resolved.tokenEnv} environment variable is not set.`,
							);
							process.exitCode = 1;
							return;
						}
						drain = await drainOutbox(
							store,
							createGitHubSink({ repo: resolved.repo, token }),
							{
								minMillisBetweenCalls: resolved.minMillisBetweenCalls,
								maxPerDrain: resolved.maxPerDrain,
								collapseThreshold: resolved.collapseThreshold,
							},
						);
					}
					// Operator observability for dead-lettered rows: lastError is
					// operator-trusted local data, printed verbatim, but payload is
					// NEVER surfaced — it may embed profile-derived (attacker-influenceable) text.
					deadLetters = store.listDeadOutbox("github").map((row) => ({
						id: row.id,
						kind: row.kind,
						dedupeKey: row.dedupeKey,
						attempts: row.attempts,
						lastError: row.lastError,
					}));
				}
				const summary = {
					triggers,
					drain,
					dryRun: Boolean(opts.dryRun),
					deadLetters,
					captureRequests: {
						created: captureRequests.created,
						expired: captureRequests.expired,
						skippedMaxPending: captureRequests.skippedMaxPending,
					},
				};
				if (opts.format === "json") {
					process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
					return;
				}
				console.log(
					`Triggers: ${triggers.processed} events processed, ${triggers.enqueued} enqueued, ` +
						`${triggers.skippedMigration} migration-skipped. ` +
						`Drain: ${drain.delivered} delivered, ${drain.retried} retried, ${drain.dead} dead, ` +
						`${drain.collapsed} collapsed.${opts.dryRun ? " (dry run)" : ""}`,
				);
				if (captureRequests.created > 0 || captureRequests.expired > 0) {
					console.log(
						`Capture requests: ${captureRequests.created} created, ${captureRequests.expired} expired.`,
					);
				}
				if (deadLetters.length > 0) {
					console.log("Dead letters:");
					for (const dl of deadLetters) {
						console.log(
							`  #${dl.id} ${dl.kind} (${dl.dedupeKey}) attempts=${dl.attempts} lastError=${dl.lastError ?? ""}`,
						);
					}
				}
			} finally {
				store.close();
			}
		});

	cmd
		.command("telemetry <batch>")
		.description(
			"Evaluate a local telemetry-batch JSON file into the lifecycle DB",
		)
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--stream <stream>", "Capture stream", "telemetry")
		.option(
			"--profile-id <id>",
			"Idempotency key (default: sha256 of the file content)",
		)
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action((batchPath: string, opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const raw = readFileSync(batchPath, "utf8");
				const batchJson = JSON.parse(raw);
				const profileId =
					opts.profileId ??
					createHash("sha256").update(raw).digest("hex").slice(0, 32);
				const outcome = evaluateTelemetryBatch(store, batchJson, {
					tenant: opts.tenant,
					stream: opts.stream,
					profileId,
				});
				printEvaluationOutcome(outcome, opts.format);
			} finally {
				store.close();
			}
		});

	cmd
		.command("pull-telemetry")
		.description(
			"Pull BC telemetry signals from Application Insights, then evaluate locally or write --out (does not retry — cron-driven)",
		)
		.requiredOption("--app-id <guid>", "Application Insights app id")
		.option(
			"--api-key-env <name>",
			"Environment variable holding the App Insights API key",
			DEFAULT_API_KEY_ENV,
		)
		.option(
			"--since <isoOrDuration>",
			"Window start: ISO 8601 timestamp or relative duration (e.g. 4h, 30m)",
			DEFAULT_SINCE,
		)
		.option(
			"--signals <list>",
			"Comma-separated signal ids to pull",
			DEFAULT_SIGNALS.join(","),
		)
		.option(
			"--out <path>",
			"Write the normalized batch JSON here instead of evaluating (does not touch the DB)",
		)
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--stream <stream>", "Capture stream", "telemetry")
		.option(
			"--profile-id <id>",
			"Idempotency key (default: sha256 of the normalized batch)",
		)
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action(async (opts: any) => {
			// The API key check inside pullTelemetry happens before any fetch —
			// deliberately caught here (not rethrown) so a missing key never
			// opens the lifecycle store either, matching --out's "no side effects
			// beyond the requested one" contract.
			let batch: TelemetryBatchDocument;
			try {
				const signals = String(opts.signals)
					.split(",")
					.map((s: string) => s.trim())
					.filter((s: string) => s.length > 0);
				batch = await pullTelemetry({
					appId: opts.appId,
					apiKeyEnv: opts.apiKeyEnv,
					since: opts.since,
					signals,
				});
			} catch (err) {
				console.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
				return;
			}

			if (opts.out) {
				writeFileSync(opts.out, JSON.stringify(batch, null, 2) + "\n");
				if (opts.format === "json") {
					process.stdout.write(
						JSON.stringify(
							{ written: opts.out, signalCount: batch.signals.length },
							null,
							2,
						) + "\n",
					);
				} else {
					console.log(
						`Wrote telemetry batch (${batch.signals.length} signal(s)) to ${opts.out}`,
					);
				}
				return;
			}

			const store = new LifecycleStore(cmd.opts().db);
			try {
				const profileId =
					opts.profileId ??
					createHash("sha256")
						.update(JSON.stringify(batch))
						.digest("hex")
						.slice(0, 32);
				const outcome = evaluateTelemetryBatch(store, batch, {
					tenant: opts.tenant,
					stream: opts.stream,
					profileId,
				});
				printEvaluationOutcome(outcome, opts.format);
			} finally {
				store.close();
			}
		});

	const captures = cmd
		.command("captures")
		.description(
			"Deep-capture request queue — operator visibility, claim, and cancel (see docs/capture-request-contract.md)",
		);

	captures
		.command("list")
		.description("List capture requests")
		.option("--tenant <tenant>", "Tenant key (all tenants if omitted)")
		.option(
			"--status <status>",
			"Filter by status: pending|claimed|fulfilled|expired|cancelled",
		)
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action((opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const rows = store.listCaptureRequests(opts.tenant, opts.status);
				if (opts.format === "json") {
					process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
					return;
				}
				if (rows.length === 0) {
					console.log("No capture requests.");
					return;
				}
				const table = new Table({
					head: [
						chalk.gray("ID"),
						chalk.gray("Status"),
						chalk.gray("Tenant"),
						chalk.gray("App"),
						chalk.gray("Object"),
						chalk.gray("Method"),
						chalk.gray("Reason"),
						chalk.gray("Requested"),
						chalk.gray("Expires"),
						chalk.gray("Claimed by"),
					],
					style: { head: [], border: [] },
				});
				for (const r of rows) {
					table.push([
						String(r.id),
						r.status,
						r.tenant,
						r.appName ?? r.appId,
						`${r.objectType} ${r.objectId}`,
						r.methodName,
						r.reason.slice(0, 40),
						r.requestedAt.slice(0, 19),
						r.expiresAt.slice(0, 19),
						r.claimedBy ?? "",
					]);
				}
				console.log(table.toString());
			} finally {
				store.close();
			}
		});

	captures
		.command("claim <id>")
		.description("Claim a pending capture request for an executor")
		.requiredOption(
			"--by <executor>",
			"Stable executor name claiming the request",
		)
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action((idArg: string, opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const id = parseInt(idArg, 10);
				const now = new Date().toISOString();
				const ok = store.claimCaptureRequest(id, opts.by, now);
				const message = ok
					? `Claimed capture request #${id} for ${opts.by}`
					: captureRequestFailureMessage(store, id, "claimed");
				if (opts.format === "json") {
					process.stdout.write(JSON.stringify({ ok, message }, null, 2) + "\n");
				} else if (ok) {
					console.log(message);
				} else {
					console.error(message);
				}
				if (!ok) process.exitCode = 1;
			} finally {
				store.close();
			}
		});

	captures
		.command("cancel <id>")
		.description("Cancel a pending or claimed capture request")
		.action((idArg: string) => {
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const id = parseInt(idArg, 10);
				const now = new Date().toISOString();
				const ok = store.cancelCaptureRequest(id, now);
				if (!ok) {
					console.error(captureRequestFailureMessage(store, id, "cancelled"));
					process.exitCode = 1;
					return;
				}
				console.log(`Cancelled capture request #${id}`);
			} finally {
				store.close();
			}
		});

	return cmd;
}
