import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import Table from "cli-table3";
import { Command } from "commander";
import { createHash } from "crypto";
import { readFileSync, statSync, writeFileSync } from "fs";
import { extname } from "path";
import { analyzeProfile } from "../../core/analyzer.js";
import { type ExplainModel, MODEL_IDS } from "../../explain/explainer.js";
import {
	DEFAULT_API_KEY_ENV,
	DEFAULT_SIGNALS,
	DEFAULT_SINCE,
	listTenants,
	type PullSplitResult,
	pullTelemetry,
	pullTelemetrySplit,
	type TenantDiscovery,
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
import {
	loadLifecycleConfigFile,
	mergeLifecycleConfig,
} from "../../lifecycle/config-file.js";
import { buildDigest, renderDigestMarkdown } from "../../lifecycle/digest.js";
import {
	applyIdentityUpgrades,
	type EvaluationOutcome,
	evaluateRun,
} from "../../lifecycle/evaluate.js";
import { createAzureDevOpsSink } from "../../lifecycle/sinks/azuredevops.js";
import { createGitHubSink } from "../../lifecycle/sinks/github.js";
import {
	type DrainReport,
	type DrainRuntime,
	drainOutbox,
} from "../../lifecycle/sinks/outbox.js";
import { processEventsForSinks } from "../../lifecycle/sinks/triggers.js";
import {
	loadSinksConfig,
	resolveAzureDevOpsConfig,
	resolveGitHubConfig,
	type SinkAdapter,
} from "../../lifecycle/sinks/types.js";
import { transition } from "../../lifecycle/states.js";
import { LifecycleStore } from "../../lifecycle/store.js";
import { evaluateTelemetryBatch } from "../../lifecycle/telemetry.js";
import { normalizeTenantCode } from "../../lifecycle/tenant.js";
import {
	renderTriageAgentSummary,
	runTriageAgent,
	type TriageClient,
	type TriageClientCreateParams,
	type TriageClientResponse,
	type TriageContentBlock,
} from "../../lifecycle/triage/agent.js";
import { isAlWorkspaceDir } from "../../semantic/engine-runner.js";
import { type FuseResult, fuseProfile } from "../../semantic/fuse.js";
import type { MethodBreakdown } from "../../types/aggregated.js";
import type { TelemetryBatchDocument } from "../../types/telemetry.js";

/** CLI default DB location (plan decision: dot-dir in cwd, one file). */
export const DEFAULT_DB_PATH = ".al-perf/lifecycle.sqlite";

/** D1 default `--report-dir` for `triage-agent` — both its written reports and its audit JSONL land here. */
export const DEFAULT_TRIAGE_REPORT_DIR = ".al-perf/triage-reports";

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

/**
 * Build the effective LifecycleConfig for a subcommand: DEFAULT_LIFECYCLE_CONFIG
 * deep-merged with the parent `--config` file's telemetry/captureRequests
 * blocks (missing file → defaults; malformed file throws, uncaught — same
 * fail-closed posture as every other CLI file-read error in this command).
 */
function resolveLifecycleConfig(configPath: string): LifecycleConfig {
	return mergeLifecycleConfig(
		DEFAULT_LIFECYCLE_CONFIG,
		loadLifecycleConfigFile(configPath) ?? {},
	);
}

/**
 * Normalize `--tenant` at the CLI boundary (debt-closure plan D1), before it
 * reaches any store call — `evaluateRun` also normalizes internally (for
 * programmatic/non-CLI callers), so this is belt-and-suspenders for the
 * subcommands that route through it, and the ONLY normalization point for
 * the subcommands that talk to the store directly (status/close/triage/
 * triage-agent/digest/captures list). `normalizeTenantCode` throws on
 * blank input; caught here and reported as a plain usage error (exit 2, no
 * stack trace) — same shape as this file's other CLI-side validation
 * failures (see `listTenantsConflict`). Returns `null` on failure; callers
 * must return immediately without opening a store.
 */
function resolveTenantOpt(raw: string): string | null {
	try {
		return normalizeTenantCode(raw);
	} catch (err) {
		console.error(
			`--tenant: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exitCode = 2;
		return null;
	}
}

/**
 * Adapts a real `Anthropic` client to the triage agent loop's minimal,
 * self-owned `TriageClient` interface (agent.ts deliberately never imports
 * `@anthropic-ai/sdk` — this is the ONE place that boundary is crossed, per
 * the plan's "client constructed only here"). Content blocks the triage
 * agent never uses (server tool use, thinking, etc.) are dropped rather than
 * mapped — the agent's own tool set never provokes them.
 */
function wrapAnthropicClient(anthropic: Anthropic): TriageClient {
	return {
		messages: {
			async create(
				params: TriageClientCreateParams,
			): Promise<TriageClientResponse> {
				const response = await anthropic.messages.create({
					model: params.model,
					max_tokens: params.max_tokens,
					system: params.system,
					messages: params.messages as Anthropic.MessageParam[],
					tools: params.tools as Anthropic.Tool[],
				});
				const content: TriageContentBlock[] = [];
				for (const block of response.content) {
					if (block.type === "text") {
						content.push({ type: "text", text: block.text });
					} else if (block.type === "tool_use") {
						content.push({
							type: "tool_use",
							id: block.id,
							name: block.name,
							input: block.input,
						});
					}
				}
				return {
					content,
					stop_reason: response.stop_reason,
					usage: {
						input_tokens: response.usage.input_tokens,
						output_tokens: response.usage.output_tokens,
					},
				};
			},
		},
	};
}

/**
 * `run-<digits from now()><random suffix>` — same charset as report_file
 * names (sanitizeReportFileName / TriageAuditLog's constructor enforce it),
 * built from the injected `now()` rather than `Date.now()` directly so a
 * fixed clock in tests produces a fixed, assertable id.
 */
function randomTriageRunId(now: () => string): string {
	const stamp = now()
		.replace(/[^0-9]/g, "")
		.slice(0, 17);
	const suffix = Math.random().toString(36).slice(2, 8);
	return `run-${stamp}-${suffix}`;
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

// ---------------------------------------------------------------------------
// pull-telemetry --split-by-customer (telemetry-multitenant plan, Task 3)
// ---------------------------------------------------------------------------

/**
 * D4: `<out-without-ext>.<tenant>.<sanitized-stream>.json` — stream
 * characters outside `[A-Za-z0-9-]` become `_` (a raw `environmentName` is
 * untrusted and would otherwise land in a path segment, e.g. `"Prod/EU"`).
 * `--tenant` is now normalized (lowercased+trimmed) at the CLI boundary
 * before it reaches this function, so the `.toLowerCase()` on `tenant`
 * below is redundant defense-in-depth, not the primary safeguard — kept
 * because it's harmless and guards any future caller that passes a raw,
 * unnormalized tenant string directly.
 */
function splitOutPath(outPath: string, tenant: string, stream: string): string {
	const ext = extname(outPath);
	const base = ext ? outPath.slice(0, -ext.length) : outPath;
	const sanitizedStream = stream.replace(/[^A-Za-z0-9-]/g, "_");
	return `${base}.${tenant.toLowerCase()}.${sanitizedStream}${ext}`;
}

/**
 * Mirrors `TENANT_CODE_RE` in src/lifecycle/config-file.ts, duplicated per
 * that module's own precedent (cross-module tenant-shape checks are copied,
 * not imported, so each boundary stays self-contained). Mapped `tenantMap`
 * values are already validated at config-load time; only the raw `--tenant`
 * flag value is unchecked, and it only needs checking here — where it can
 * land in a written filename as the fleet-policy bucket (D3/D4).
 */
const TENANT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

/**
 * Two distinct groups can sanitize to the same `<tenant>.<stream>` filename
 * (e.g. streams `"Prod/EU"` and `"Prod_EU"` both become `Prod_EU`) — assign
 * each colliding group after the first a `-2`, `-3`, ... suffix rather than
 * silently overwriting an earlier group's file.
 */
function assignUniqueOutPaths(
	outPath: string,
	groups: PullSplitResult["groups"],
): Array<{ group: PullSplitResult["groups"][number]; path: string }> {
	const assigned = new Set<string>();
	return groups.map((group) => {
		const basePath = splitOutPath(outPath, group.tenant, group.stream);
		const ext = extname(basePath);
		const stem = ext ? basePath.slice(0, -ext.length) : basePath;
		let path = basePath;
		let suffix = 2;
		while (assigned.has(path)) {
			path = `${stem}-${suffix}${ext}`;
			suffix++;
		}
		assigned.add(path);
		return { group, path };
	});
}

/**
 * One summary line for tenants skipped by the "skip" unmapped-tenant policy.
 * CONTROLLER-PINNED (Task 2 review): an empty `aadTenantId` (on-prem/
 * old-schema rows that never carried an AAD tenant id) must render visibly
 * as "(none)" here — never an invisible empty string. JSON output (the
 * `skippedTenants` array itself) keeps the raw `""`; only this text summary
 * substitutes the placeholder.
 */
function formatSkippedTenantsSummary(
	skipped: PullSplitResult["skippedTenants"],
): string | null {
	if (skipped.length === 0) return null;
	const totalSignals = skipped.reduce((sum, s) => sum + s.signalCount, 0);
	const detail = skipped
		.map(
			(s) =>
				`${s.aadTenantId === "" ? "(none)" : s.aadTenantId} (${s.signalCount})`,
		)
		.join(", ");
	return `Skipped ${skipped.length} tenant(s) not in tenantMap (${totalSignals} signal(s) total): ${detail}`;
}

/**
 * `--stream`/`--profile-id` are meaningless once split derives both per
 * group (D2 stream=environmentName, D5 profileId=content hash) — commander
 * still applies their defaults, so `opts.stream`/`opts.profileId` are
 * truthy either way; `getOptionValueSource` is the only way to tell "the
 * operator typed this flag" apart from "this is just the default value".
 */
function warnIgnoredSplitFlags(splitCommand: Command): void {
	if (splitCommand.getOptionValueSource("stream") === "cli") {
		console.error(
			"pull-telemetry --split-by-customer: --stream is ignored — each group's " +
				"stream is derived from environmentName instead (docs/telemetry-recipe.md §10).",
		);
	}
	if (splitCommand.getOptionValueSource("profileId") === "cli") {
		console.error(
			"pull-telemetry --split-by-customer: --profile-id is ignored — each group " +
				"gets its own content-hash profileId instead (docs/telemetry-recipe.md §10).",
		);
	}
}

// ---------------------------------------------------------------------------
// pull-telemetry --list-tenants (list-tenants plan, Task 1): discovery mode
// for --split-by-customer onboarding — prints the AAD tenants emitting the
// requested signals plus a paste-ready tenantMap stub, instead of
// evaluating or writing anything.
// ---------------------------------------------------------------------------

/**
 * Mirrors TENANT_GUID_RE in src/lifecycle/config-file.ts, duplicated per
 * that module's own precedent (cross-module tenant-shape checks are copied,
 * not imported). Used to decide which discovered aadTenantId values are
 * even candidates for a tenantMap entry — a non-GUID id (e.g. "common", an
 * on-prem placeholder) can never pass the config loader's own GUID
 * validation, so it's never proposed in the stub even though it still shows
 * up in the table for operator awareness.
 */
const AAD_TENANT_GUID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `--list-tenants` is a discovery-only mode: it never evaluates a run or
 * writes a file, so every flag that implies one of those is meaningless
 * alongside it. Unlike warnIgnoredSplitFlags this is a hard guard (exit 2,
 * zero fetches) rather than a warning — discovery's contract is "nothing
 * but the report", so silently ignoring a conflicting flag would surprise
 * an operator who thought it took effect.
 */
function listTenantsConflict(opts: any, pullCommand: Command): string | null {
	if (opts.splitByCustomer) {
		return "pull-telemetry --list-tenants cannot be combined with --split-by-customer — run one mode at a time.";
	}
	if (opts.out) {
		return "pull-telemetry --list-tenants cannot be combined with --out — discovery only prints to stdout.";
	}
	if (pullCommand.getOptionValueSource("stream") === "cli") {
		return "pull-telemetry --list-tenants cannot be combined with --stream — discovery does not evaluate a run.";
	}
	if (pullCommand.getOptionValueSource("profileId") === "cli") {
		return "pull-telemetry --list-tenants cannot be combined with --profile-id — discovery does not evaluate a run.";
	}
	return null;
}

/**
 * Paste-ready `tenantMap` stub: only aadTenantId values that (a) are GUID-
 * shaped, so the config loader's own TENANT_GUID_RE would accept them as a
 * key, and (b) aren't already in the merged tenantMap (D4: lowercase
 * lookup, same as pullTelemetrySplit's tenantMapLower). Values are left ""
 * for the operator to fill in — never guessed.
 */
function buildTenantMapStub(
	discoveries: TenantDiscovery[],
	tenantMap: Record<string, string>,
): { telemetry: { tenantMap: Record<string, string> } } {
	const mappedLower = new Set(
		Object.keys(tenantMap).map((guid) => guid.toLowerCase()),
	);
	const stub: Record<string, string> = {};
	for (const d of discoveries) {
		if (!AAD_TENANT_GUID_RE.test(d.aadTenantId)) continue;
		if (mappedLower.has(d.aadTenantId.toLowerCase())) continue;
		stub[d.aadTenantId] = "";
	}
	return { telemetry: { tenantMap: stub } };
}

/**
 * D4: lowercased-GUID → tenant-code lookup, shared by the text table's
 * "Mapped to" column and the JSON `tenants[].mappedTo` field so both
 * formats resolve the exact same mapping (same lookup as
 * pullTelemetrySplit's tenantMapLower).
 */
function buildTenantMapLookup(
	tenantMap: Record<string, string>,
): Map<string, string> {
	return new Map(
		Object.entries(tenantMap).map(([guid, tenant]) => [
			guid.toLowerCase(),
			tenant,
		]),
	);
}

/**
 * Text rendering: table first, stub JSON last (docs §10 onboarding flow —
 * scan the table, then copy the stub straight off the bottom of the
 * output). "(none)" for an empty aadTenantId mirrors
 * formatSkippedTenantsSummary's placeholder; "(unmapped)" marks a
 * GUID-shaped or non-GUID id with no tenantMap entry.
 */
function renderListTenantsText(
	discoveries: TenantDiscovery[],
	tenantMap: Record<string, string>,
): void {
	const tenantMapLower = buildTenantMapLookup(tenantMap);
	if (discoveries.length === 0) {
		console.log("No tenants observed in the requested window.");
	} else {
		const table = new Table({
			head: [
				chalk.gray("AAD Tenant"),
				chalk.gray("Rows"),
				chalk.gray("Environments"),
				chalk.gray("Mapped to"),
			],
			style: { head: [], border: [] },
		});
		for (const d of discoveries) {
			const mapped = tenantMapLower.get(d.aadTenantId.toLowerCase());
			table.push([
				d.aadTenantId === "" ? "(none)" : d.aadTenantId,
				String(d.rows),
				d.environments.length > 0 ? d.environments.join(", ") : "(none)",
				mapped ?? "(unmapped)",
			]);
		}
		console.log(table.toString());
	}
	console.log(
		JSON.stringify(buildTenantMapStub(discoveries, tenantMap), null, 2),
	);
}

async function runListTenants(cmd: Command, opts: any): Promise<void> {
	let discoveries: TenantDiscovery[];
	try {
		const signals = String(opts.signals)
			.split(",")
			.map((s: string) => s.trim())
			.filter((s: string) => s.length > 0);
		discoveries = await listTenants({
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

	const config = resolveLifecycleConfig(cmd.opts().config);

	if (opts.format === "json") {
		// mappedTo is carried per row (D4 lowercase lookup) so a JSON consumer
		// can tell "mapped" from "unmapped" directly — the stub alone is
		// ambiguous (a non-GUID id is also absent from it, but isn't mapped).
		const tenantMapLower = buildTenantMapLookup(config.telemetry.tenantMap);
		const tenants = discoveries.map((d) => ({
			...d,
			mappedTo: tenantMapLower.get(d.aadTenantId.toLowerCase()) ?? null,
		}));
		process.stdout.write(
			JSON.stringify(
				{
					tenants,
					tenantMapStub: buildTenantMapStub(
						discoveries,
						config.telemetry.tenantMap,
					),
				},
				null,
				2,
			) + "\n",
		);
		return;
	}

	renderListTenantsText(discoveries, config.telemetry.tenantMap);
}

/**
 * `pull-telemetry --split-by-customer`: fans one App Insights pull into one
 * batch per (customer AAD tenant, environment) via `pullTelemetrySplit`,
 * then either evaluates N batches into the lifecycle DB or writes N `--out`
 * files. Kept as a standalone function (not inlined into the main
 * `pull-telemetry` action) so the non-split path stays byte-identical to
 * before this flag existed.
 */
async function runSplitByCustomer(
	cmd: Command,
	opts: any,
	splitCommand: Command,
): Promise<void> {
	warnIgnoredSplitFlags(splitCommand);

	const config = resolveLifecycleConfig(cmd.opts().config);
	const tenantMapNonEmpty = Object.keys(config.telemetry.tenantMap).length > 0;
	const fleetPolicy = config.telemetry.unmappedTenantPolicy === "fleet";
	if (!tenantMapNonEmpty && !fleetPolicy) {
		console.error(
			"pull-telemetry --split-by-customer requires the --config file's " +
				"telemetry.tenantMap to contain at least one AAD-tenant-GUID entry, " +
				'or telemetry.unmappedTenantPolicy to be "fleet" — with an empty ' +
				'tenantMap and the default "skip" policy every tenant would be ' +
				"skipped (100% of the pull lost). Add customers to " +
				'telemetry.tenantMap, or set unmappedTenantPolicy: "fleet" to bucket ' +
				"everything unmapped under --tenant.",
		);
		process.exitCode = 2;
		return;
	}

	// The fleet-policy bucket is --tenant verbatim; in --out mode that value
	// lands in a written filename (splitOutPath), so it needs the same shape
	// check tenantMap VALUES already get at config-load time. Only checked in
	// --out mode (evaluate mode passes it through to the store as an ordinary
	// tenant key, same as every other subcommand's unchecked --tenant).
	if (opts.out && !TENANT_CODE_RE.test(opts.tenant)) {
		console.error(
			`pull-telemetry --split-by-customer --out: --tenant value ${JSON.stringify(opts.tenant)} ` +
				`is not a valid tenant code (must match ${TENANT_CODE_RE}) — it can end up ` +
				"in a written filename as the fleet-policy bucket.",
		);
		process.exitCode = 2;
		return;
	}

	let splitResult: PullSplitResult;
	try {
		const signals = String(opts.signals)
			.split(",")
			.map((s: string) => s.trim())
			.filter((s: string) => s.length > 0);
		const clientTypes = opts.clientTypes
			? String(opts.clientTypes)
					.split(",")
					.map((s: string) => s.trim())
					.filter((s: string) => s.length > 0)
			: undefined;
		splitResult = await pullTelemetrySplit({
			appId: opts.appId,
			apiKeyEnv: opts.apiKeyEnv,
			since: opts.since,
			signals,
			clientTypes,
			tenantMap: config.telemetry.tenantMap,
			unmappedTenantPolicy: config.telemetry.unmappedTenantPolicy,
			fleetTenant: opts.tenant,
		});
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
		return;
	}

	const skippedSummary = formatSkippedTenantsSummary(
		splitResult.skippedTenants,
	);

	if (opts.out) {
		const written = assignUniqueOutPaths(opts.out, splitResult.groups).map(
			({ group, path }) => {
				writeFileSync(path, JSON.stringify(group.batch, null, 2) + "\n");
				return {
					tenant: group.tenant,
					stream: group.stream,
					path,
					signalCount: group.batch.signals.length,
				};
			},
		);
		if (opts.format === "json") {
			process.stdout.write(
				JSON.stringify(
					{ written, skippedTenants: splitResult.skippedTenants },
					null,
					2,
				) + "\n",
			);
		} else {
			for (const w of written) {
				console.log(
					`Wrote telemetry batch (${w.signalCount} signal(s)) for ${w.tenant}/${w.stream} to ${w.path}`,
				);
			}
			if (skippedSummary) console.log(skippedSummary);
		}
		return;
	}

	const store = new LifecycleStore(cmd.opts().db);
	try {
		// Per-group isolation: one customer's poison batch (e.g. a bad row that
		// fails telemetry-batch validation) must not block every OTHER
		// customer's evaluation in the same pull — that's exactly the
		// cross-tenant coupling this plan exists to remove. A failing group is
		// recorded and the loop continues; the run still exits nonzero so the
		// failure isn't silently swallowed.
		const groups: Array<{
			tenant: string;
			stream: string;
			aadTenantId: string;
			environmentName: string | null;
			outcome: EvaluationOutcome;
		}> = [];
		const failedGroups: Array<{
			tenant: string;
			stream: string;
			error: string;
		}> = [];
		for (const group of splitResult.groups) {
			// The store's duplicate-run guard keys off (tenant, profileId) alone
			// — stream isn't part of that uniqueness constraint (store.ts) — so
			// hashing the batch alone lets two same-tenant streams with
			// byte-identical signal sets (e.g. Production/Sandbox both quiet
			// this window) collide and the second silently skips as
			// duplicate-run. Folding tenant+stream into the hash input keeps
			// each group's idempotency key distinct even when their content is
			// identical.
			const profileId = createHash("sha256")
				.update(JSON.stringify([group.tenant, group.stream, group.batch]))
				.digest("hex")
				.slice(0, 32);
			try {
				const outcome = evaluateTelemetryBatch(
					store,
					group.batch,
					{ tenant: group.tenant, stream: group.stream, profileId },
					config,
				);
				groups.push({
					tenant: group.tenant,
					stream: group.stream,
					aadTenantId: group.aadTenantId,
					environmentName: group.environmentName,
					outcome,
				});
				if (opts.format !== "json") {
					console.log(
						`${group.tenant}/${group.stream}: ${outcome.findingsSeen} findings seen`,
					);
				}
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				failedGroups.push({
					tenant: group.tenant,
					stream: group.stream,
					error,
				});
				if (opts.format !== "json") {
					console.log(`${group.tenant}/${group.stream}: failed — ${error}`);
				}
			}
		}
		if (opts.format === "json") {
			process.stdout.write(
				JSON.stringify(
					{ groups, skippedTenants: splitResult.skippedTenants, failedGroups },
					null,
					2,
				) + "\n",
			);
		} else if (skippedSummary) {
			console.log(skippedSummary);
		}
		if (failedGroups.length > 0) process.exitCode = 1;
	} finally {
		store.close();
	}
}

export function createLifecycleCommand(): Command {
	const cmd = new Command("lifecycle")
		.description(
			"Finding lifecycle engine — durable finding state across profile runs",
		)
		.option("--db <path>", "Lifecycle database file", DEFAULT_DB_PATH)
		.option(
			"--config <path>",
			"Lifecycle config file (telemetry severity, capture-request thresholds, sinks)",
			".al-perf/lifecycle.config.json",
		);

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
			const tenant = resolveTenantOpt(opts.tenant);
			if (tenant === null) return;
			const store = new LifecycleStore(cmd.opts().db);
			try {
				let allMethods: MethodBreakdown[] = [];
				const result = await analyzeProfile(profilePath, {
					includePatterns: true,
					sourcePath: opts.source,
					onAllMethods: (m: MethodBreakdown[]) => {
						allMethods = m;
					},
				});

				// al-sem fusion (fpwire phase-2 payoff): when a confident anchor
				// match upgrades a pattern's fingerprint from its fallback identity
				// to a stable one, the migration must be APPLIED to the store
				// before evaluateRun below — otherwise the existing finding is
				// left behind under its old fingerprint and evaluateRun files a
				// fresh duplicate under the new one. fuseProfile re-mints
				// result.patterns[].fingerprint IN PLACE, so evaluateRun always
				// reads whatever fingerprint ends up on each pattern here.
				if (opts.source && isAlWorkspaceDir(opts.source)) {
					let fuseResult: FuseResult | undefined;
					try {
						// fuseProfile itself never throws (degrades to {disabled}),
						// but this catch stays defensive and matches the `analyze`
						// command's fusion error handling — it must NOT also cover
						// applyIdentityUpgrades below (see that call's comment).
						fuseResult = await fuseProfile(allMethods, opts.source, {
							patterns: result.patterns,
						});
					} catch (err: unknown) {
						// Never crash `lifecycle evaluate` over fusion — log silently.
						const msg = err instanceof Error ? err.message : String(err);
						process.stderr.write(`al-sem fusion: unexpected error: ${msg}\n`);
					}
					if (
						fuseResult &&
						!("disabled" in fuseResult) &&
						fuseResult.identityUpgrades
					) {
						// Deliberately OUTSIDE the try/catch above: a store failure
						// here must abort the run, not be swallowed and fall through
						// to evaluateRun with patterns already re-minted to their
						// upgraded fingerprints but the migration only partially (or
						// not at all) applied — that half-applied state is exactly
						// the duplicate-finding bug this wiring exists to prevent.
						applyIdentityUpgrades(
							store,
							tenant,
							fuseResult.identityUpgrades,
							new Date().toISOString(),
						);
					}
				}

				const profileId =
					opts.profileId ??
					createHash("sha256")
						.update(readFileSync(profilePath))
						.digest("hex")
						.slice(0, 32);
				const captureTime =
					opts.captureTime ?? statSync(profilePath).mtime.toISOString();
				// File merge first, then the --resolve-after flag on top — the flag
				// always wins (the file can't set resolveAfterRuns at all; see
				// LifecycleConfigFilePatch).
				const config = resolveLifecycleConfig(cmd.opts().config);
				if (opts.resolveAfter !== undefined) {
					config.resolveAfterRuns = parseInt(opts.resolveAfter, 10);
				}
				const outcome = evaluateRun(
					store,
					result,
					{
						tenant,
						stream: opts.stream,
						profileId,
						captureKind: result.meta.captureKind ?? result.meta.profileType,
						captureTime,
					},
					config,
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
			const tenant = resolveTenantOpt(opts.tenant);
			if (tenant === null) return;
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const digest = buildDigest(store, {
					tenant,
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
			const tenant = resolveTenantOpt(opts.tenant);
			if (tenant === null) return;
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const rows = store.listFindings({
					tenant,
					state: opts.state,
					needsTriage: opts.triage ? true : undefined,
					limit: parseInt(opts.limit, 10),
				});
				if (opts.format === "json") {
					// Only surface triageNote/triagedAt/triagedBy once a finding has
					// actually been triaged — an untriaged row shows none of the
					// three keys (not even null), keeping the common case terse.
					const withTriage = rows.map((r) => {
						const { triageNote, triagedAt, triagedBy, ...rest } = r;
						return {
							...rest,
							...(triageNote !== null ? { triageNote } : {}),
							...(triagedAt !== null ? { triagedAt } : {}),
							...(triagedBy !== null ? { triagedBy } : {}),
						};
					});
					process.stdout.write(JSON.stringify(withTriage, null, 2) + "\n");
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
			const tenant = resolveTenantOpt(opts.tenant);
			if (tenant === null) return;
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const res = applyClose(
					store,
					tenant,
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
			const tenant = resolveTenantOpt(opts.tenant);
			if (tenant === null) return;
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const row = store.getActiveFinding(tenant, fingerprint);
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
		.command("triage-agent")
		.description(
			"Scheduled LLM triage pass over needs-triage findings — read-mostly tools, one mutation (record_triage), fully audited (see docs/triage-agent-recipe.md)",
		)
		.option("--tenant <tenant>", "Tenant key", "local")
		.option("--max-findings <n>", "Maximum findings to triage this run", "5")
		.option(
			"--max-turns <n>",
			"Tool-use turns allowed per finding before it's skipped as a runaway loop",
			"8",
		)
		.option(
			"--budget-tokens <n>",
			"Cumulative input+output token budget for the whole run",
			"200000",
		)
		.option(
			"--report-dir <path>",
			"Report + audit-log directory",
			DEFAULT_TRIAGE_REPORT_DIR,
		)
		.option("--model <model>", "sonnet|opus", "sonnet")
		.option(
			"--dry-run",
			"Investigate and log as usual, but record_triage makes zero writes",
		)
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action(async (opts: any) => {
			// Kill-switch checked FIRST, before even looking at the key — the
			// brief's contract is zero client construction when disabled,
			// regardless of whether a key happens to be present in env.
			if (process.env.AI_DISABLED === "1") {
				console.log(
					"triage-agent: AI_DISABLED=1 — agent disabled, exiting without contacting the API.",
				);
				return;
			}
			const apiKey = process.env.ANTHROPIC_API_KEY;
			if (!apiKey) {
				console.error(
					"triage-agent requires the ANTHROPIC_API_KEY environment variable " +
						"(bring-your-own-key — see docs/triage-agent-recipe.md).",
				);
				process.exitCode = 1;
				return;
			}
			const tenant = resolveTenantOpt(opts.tenant);
			if (tenant === null) return;
			const model =
				MODEL_IDS[opts.model === "opus" ? "opus" : ("sonnet" as ExplainModel)];
			const client = wrapAnthropicClient(new Anthropic({ apiKey }));
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const lifecycleConfig = resolveLifecycleConfig(cmd.opts().config);
				const now = () => new Date().toISOString();
				const result = await runTriageAgent(
					store,
					{
						tenant,
						reportDir: opts.reportDir,
						maxFindings: parseInt(opts.maxFindings, 10),
						maxTurnsPerFinding: parseInt(opts.maxTurns, 10),
						budgetTokens: parseInt(opts.budgetTokens, 10),
						model,
						dryRun: Boolean(opts.dryRun),
					},
					{ now, runId: randomTriageRunId(now), lifecycleConfig },
					client,
				);
				process.stdout.write(renderTriageAgentSummary(result, opts.format));
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
			"--dry-run",
			"Scan and enqueue locally (capture requests + outbox), but do not deliver to sinks",
		)
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action(async (opts: any) => {
			const store = new LifecycleStore(cmd.opts().db);
			const configPath = cmd.opts().config;
			try {
				const now = new Date().toISOString();
				const lifecycleConfig = resolveLifecycleConfig(configPath);
				// Independent of any sink being configured: capture-request filing
				// is local DB state, not delivery, so it must not depend on — or be
				// blocked by — a missing/absent sinks config.
				let captureRequests: CaptureTriggerReport = {
					scanned: 0,
					created: 0,
					expired: 0,
					skippedMaxPending: 0,
				};
				if (lifecycleConfig.captureRequests.enabled) {
					captureRequests = processCaptureTriggers(store, lifecycleConfig, now);
				}

				// Sinks live under the same config file's `sinks` block, but
				// loadSinksConfig owns that read separately (config-file.ts
				// deliberately ignores `sinks`).
				const config = loadSinksConfig(configPath);
				const triggers = { processed: 0, enqueued: 0, skippedMigration: 0 };
				const drains: Array<{ sink: string } & DrainReport> = [];
				let deadLetters: Array<{
					id: number;
					kind: string;
					dedupeKey: string;
					attempts: number;
					lastError: string | null;
				}> = [];

				if (!config) {
					console.error(
						`No sink config at ${configPath} — sink delivery skipped (capture-request scan still ran). Zero-custody alternative: drive 'gh issue create' from 'lifecycle digest -f json' — see docs/lifecycle-gh-recipe.md.`,
					);
				} else {
					// Drain the whole backlog in one sync. Each scan is capped at a
					// batch of events per sink so the enclosing transaction stays
					// bounded; a newly-enabled sink replaying a long history therefore
					// needs several scans. The loop terminates because every non-empty
					// scan advances at least one sink's watermark.
					//
					// triggers.processed must count DISTINCT events across the whole
					// drain, not the sum of each scan's count: sinks sitting at
					// different watermarks (e.g. a newly-enabled sink replaying a
					// backlog another sink has already passed) can each see the same
					// event in a later scan, so summing scan.processed double-counts
					// it. Union the per-scan id sets instead.
					const processedEventIds = new Set<number>();
					for (;;) {
						const scan = processEventsForSinks(store, config);
						if (scan.processed === 0) break;
						for (const id of scan.processedIds) processedEventIds.add(id);
						triggers.enqueued += scan.enqueued;
						triggers.skippedMigration += scan.skippedMigration;
					}
					triggers.processed = processedEventIds.size;

					// D2 sink registry: one plan per ENABLED sink block, built here
					// (not in triggers.ts) because only sync needs live adapters —
					// the trigger scan only needs each sink's rule config.
					interface SinkDrainPlan {
						name: string;
						tokenEnv: string;
						runtime: DrainRuntime;
						createAdapter: (token: string) => SinkAdapter;
					}
					const drainPlans: SinkDrainPlan[] = [];
					const gh = config.sinks.github;
					if (gh?.enabled) {
						const resolved = resolveGitHubConfig(gh);
						drainPlans.push({
							name: "github",
							tokenEnv: resolved.tokenEnv,
							runtime: {
								minMillisBetweenCalls: resolved.minMillisBetweenCalls,
								maxPerDrain: resolved.maxPerDrain,
								collapseThreshold: resolved.collapseThreshold,
							},
							createAdapter: (token) =>
								createGitHubSink({ repo: resolved.repo, token }),
						});
					}
					const ado = config.sinks.azureDevOps;
					if (ado?.enabled) {
						const resolved = resolveAzureDevOpsConfig(ado);
						drainPlans.push({
							name: "azureDevOps",
							tokenEnv: resolved.tokenEnv,
							runtime: {
								minMillisBetweenCalls: resolved.minMillisBetweenCalls,
								maxPerDrain: resolved.maxPerDrain,
								collapseThreshold: resolved.collapseThreshold,
							},
							createAdapter: (token) =>
								createAzureDevOpsSink({
									org: resolved.org,
									project: resolved.project,
									workItemType: resolved.workItemType,
									areaPath: resolved.areaPath,
									tags: resolved.tags,
									closedState: resolved.closedState,
									reopenState: resolved.reopenState,
									token,
								}),
						});
					}

					if (!opts.dryRun) {
						for (const plan of drainPlans) {
							const token = process.env[plan.tokenEnv];
							if (!token) {
								// Per-sink token isolation: this sink's drain is skipped
								// loudly, but the loop continues — a misconfigured sink
								// must never block another sink's delivery.
								console.error(
									`sinks.${plan.name} is enabled but the ${plan.tokenEnv} environment variable is not set — ${plan.name} drain skipped.`,
								);
								process.exitCode = 1;
								continue;
							}
							const report = await drainOutbox(
								store,
								plan.createAdapter(token),
								plan.runtime,
							);
							drains.push({ sink: plan.name, ...report });
						}
					}
					// Operator observability for dead-lettered rows: lastError is
					// operator-trusted local data, printed verbatim, but payload is
					// NEVER surfaced — it may embed profile-derived (attacker-influenceable) text.
					deadLetters = drainPlans.flatMap((plan) =>
						store.listDeadOutbox(plan.name).map((row) => ({
							id: row.id,
							kind: row.kind,
							dedupeKey: row.dedupeKey,
							attempts: row.attempts,
							lastError: row.lastError,
						})),
					);
				}
				const summary = {
					triggers,
					// SHAPE CHANGE (Task 4 of the multi-sink plan): the old singular
					// `drain` object is now a per-sink array, one entry per sink that
					// actually attempted a drain this run (dry-run and token-missing
					// sinks are absent, not zeroed).
					drains,
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
						`${triggers.skippedMigration} migration-skipped.${opts.dryRun ? " (dry run)" : ""}`,
				);
				for (const d of drains) {
					console.log(
						`${d.sink}: ${d.delivered} delivered, ${d.retried} retried, ${d.dead} dead, ` +
							`${d.collapsed} collapsed.`,
					);
				}
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
			const tenant = resolveTenantOpt(opts.tenant);
			if (tenant === null) return;
			const store = new LifecycleStore(cmd.opts().db);
			try {
				const raw = readFileSync(batchPath, "utf8");
				const batchJson = JSON.parse(raw);
				const profileId =
					opts.profileId ??
					createHash("sha256").update(raw).digest("hex").slice(0, 32);
				const config = resolveLifecycleConfig(cmd.opts().config);
				const outcome = evaluateTelemetryBatch(
					store,
					batchJson,
					{
						tenant,
						stream: opts.stream,
						profileId,
					},
					config,
				);
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
			"--client-types <list>",
			"Comma-separated BC client types to filter (e.g. Background,WebClient); default: no filter",
		)
		.option(
			"--out <path>",
			"Write the normalized batch JSON here instead of evaluating (does not touch the DB)",
		)
		.option(
			"--split-by-customer",
			'Fan out into one batch per (customer AAD tenant, environment) via the --config file\'s telemetry.tenantMap; requires a non-empty tenantMap or unmappedTenantPolicy: "fleet" (see docs/telemetry-recipe.md)',
		)
		.option(
			"--list-tenants",
			"Discovery mode: print the AAD tenants emitting the requested signals since the window start, plus a paste-ready tenantMap stub, instead of evaluating or writing anything; conflicts with --split-by-customer, --out, --stream, --profile-id (see docs/telemetry-recipe.md §10)",
		)
		.option(
			"--tenant <tenant>",
			'Tenant key (also the fleet bucket for --split-by-customer\'s unmapped-tenant "fleet" policy)',
			"local",
		)
		.option(
			"--stream <stream>",
			"Capture stream (ignored under --split-by-customer, which derives one stream per group from environmentName)",
			"telemetry",
		)
		.option(
			"--profile-id <id>",
			"Idempotency key, default: sha256 of the normalized batch (ignored under --split-by-customer, which derives one content-hash profileId per group)",
		)
		.option("-f, --format <format>", "Output format: text|json", "text")
		.action(async (opts: any, pullCommand: Command) => {
			// Normalized once here, in place: runSplitByCustomer reads opts.tenant
			// directly (D1's fleet-bucket value, TENANT_CODE_RE check) and so does
			// the main non-split evaluate path below — mutating opts.tenant here
			// means every downstream branch sees the normalized value without a
			// separate normalization call at each read site.
			const tenant = resolveTenantOpt(opts.tenant);
			if (tenant === null) return;
			opts.tenant = tenant;

			if (opts.listTenants) {
				const conflict = listTenantsConflict(opts, pullCommand);
				if (conflict) {
					console.error(conflict);
					process.exitCode = 2;
					return;
				}
				await runListTenants(cmd, opts);
				return;
			}

			if (opts.splitByCustomer) {
				await runSplitByCustomer(cmd, opts, pullCommand);
				return;
			}

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
				const clientTypes = opts.clientTypes
					? String(opts.clientTypes)
							.split(",")
							.map((s: string) => s.trim())
							.filter((s: string) => s.length > 0)
					: undefined;
				batch = await pullTelemetry({
					appId: opts.appId,
					apiKeyEnv: opts.apiKeyEnv,
					since: opts.since,
					signals,
					clientTypes,
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
				const config = resolveLifecycleConfig(cmd.opts().config);
				const outcome = evaluateTelemetryBatch(
					store,
					batch,
					{
						tenant: opts.tenant,
						stream: opts.stream,
						profileId,
					},
					config,
				);
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
			// --tenant is optional here (all tenants if omitted) — only normalize
			// when the operator actually passed one.
			if (opts.tenant !== undefined) {
				const tenant = resolveTenantOpt(opts.tenant);
				if (tenant === null) return;
				opts.tenant = tenant;
			}
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
				const ok = store.cancelCaptureRequest(id);
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
