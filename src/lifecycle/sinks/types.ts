/**
 * types.ts — the SinkAdapter contract (umbrella spec §4).
 *
 * A SinkAdapter delivers ONE outbox row to an external system. Everything
 * around it — enqueueing (triggers.ts), retry/backoff/rate-limit/collapse
 * (outbox.ts), idempotency (dedupe keys + the issue map) — is owned by the
 * outbox machinery, so later sinks (ADO, Slack, email digest) are additive
 * files implementing this interface.
 *
 * Payloads carry RAW structured finding fields; escaping/fencing is owned
 * by the adapter — the last hand to touch the text (plan D7).
 */

import { existsSync, readFileSync } from "fs";
import type { SinkIssueMapping } from "../store.js";

export interface SinkFindingContext {
	fingerprint: string;
	title: string;
	severity: string;
	state: string;
	patternId: string;
	appName: string;
	firstSeenAt: string;
	lastSeenAt: string;
	occurrenceCount: number;
	/** The lifecycle event that produced this delivery (e.g. "seen-regressed"). */
	event: string;
	metricClass: string | null;
	resolvedAt: string | null;
	/** Free-form finding evidence — rendered ONLY inside a fenced block. */
	evidence: string | null;
}

export type SinkDeliveryKind =
	| "create-issue"
	| "create-epic"
	| "comment-regressed"
	| "comment-resolved"
	| "comment-recurred"
	| "reopen-issue"
	| "close-issue";

export interface SinkDeliveryPayload {
	finding: SinkFindingContext;
	/** Already validated against the allow-list by the triggers. */
	labels: string[];
	/** create-epic only: the collapsed findings. */
	children?: SinkFindingContext[];
}

export interface SinkDelivery {
	id: number;
	tenant: string;
	sink: string;
	kind: SinkDeliveryKind;
	findingId: number;
	payload: SinkDeliveryPayload;
	dedupeKey: string;
}

export type SinkResult =
	| { ok: true; externalId?: string; externalUrl?: string }
	| { ok: false; retryable: boolean; error: string };

/** LifecycleStore satisfies this structurally — adapters never see SQL. */
export interface SinkIssueMapPort {
	getIssueMapping(
		tenant: string,
		sink: string,
		fingerprint: string,
	): SinkIssueMapping | null;
	putIssueMapping(m: {
		tenant: string;
		sink: string;
		fingerprint: string;
		externalId: string;
		externalUrl?: string;
		createdAt: string;
	}): void;
}

export interface SinkAdapter {
	readonly name: string;
	deliver(
		delivery: SinkDelivery,
		issueMap: SinkIssueMapPort,
	): Promise<SinkResult>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The trigger-rule fields every sink shares, independent of destination
 * (GitHub issues, Azure DevOps work items, ...). Extracted so a new sink
 * only has to add its own destination/auth fields on top of this — the
 * digest-first posture (`autoFile`/`autoClose` off by default), severity
 * gating, hysteresis, and rate/collapse controls are identical everywhere.
 */
export interface SinkTriggerConfig {
	enabled: boolean;
	/** Digest-first: OFF by default; only high-confidence auto-filing. */
	autoFile?: boolean;
	autoFileMinSeverity?: "critical" | "warning" | "info";
	/** Hysteresis M: observed in at least this many runs before filing. */
	autoFileAfterRuns?: number;
	autoClose?: boolean;
	/**
	 * Recurrence-after-close visibility. A `filed-fresh` event on a finding
	 * with an existing (presumably closed) issue mapping ALWAYS enqueues
	 * comment-recurred — that is today's behavior and stays true regardless
	 * of this flag. With this true, the same event ALSO enqueues a
	 * reopen-issue delivery (state -> open); harmless no-op if the mapped
	 * issue is already open, since this store never tracks the mapped
	 * issue's actual open/closed state. Default false preserves today's
	 * comment-only behavior byte-for-byte.
	 */
	reopenOnRecurrence?: boolean;
	minMillisBetweenCalls?: number;
	maxPerDrain?: number;
	collapseThreshold?: number;
}

export interface GitHubSinkConfig extends SinkTriggerConfig {
	/** "owner/name" — never a URL. */
	repo: string;
	/** Env var holding the token — tokens NEVER live in the config file. */
	tokenEnv?: string;
	/** Labels applied to created issues (filtered by the allow-list). */
	labels?: string[];
	labelsAllowList?: string[];
}

export interface AzureDevOpsSinkConfig extends SinkTriggerConfig {
	/** dev.azure.com/{org} */
	org: string;
	project: string;
	/** Env var holding the PAT — never lives in the config file. */
	tokenEnv?: string;
	workItemType?: string;
	/** Optional /fields/System.AreaPath. No default — unset means unset. */
	areaPath?: string;
	/** System.Tags applied to created work items (filtered by the allow-list). */
	tags?: string[];
	tagsAllowList?: string[];
	/** Work-item state a close transitions to. Process templates differ. */
	closedState?: string;
	/** Work-item state a reopen transitions to. Process templates differ. */
	reopenState?: string;
}

export interface LifecycleSinksConfig {
	sinks: { github?: GitHubSinkConfig; azureDevOps?: AzureDevOpsSinkConfig };
}

/** Trigger-rule defaults shared by every sink (see {@link SinkTriggerConfig}). */
export const SHARED_TRIGGER_DEFAULTS = {
	autoFile: false,
	autoFileMinSeverity: "critical" as const,
	autoFileAfterRuns: 2,
	autoClose: false,
	reopenOnRecurrence: false,
	minMillisBetweenCalls: 1000,
	maxPerDrain: 20,
	collapseThreshold: 5,
};

export const SINK_DEFAULTS = {
	...SHARED_TRIGGER_DEFAULTS,
	tokenEnv: "GITHUB_TOKEN",
	labels: ["al-perf"],
	labelsAllowList: ["al-perf", "performance", "regression"],
};

export const AZURE_DEVOPS_SINK_DEFAULTS = {
	...SHARED_TRIGGER_DEFAULTS,
	tokenEnv: "AZDO_PAT",
	workItemType: "Bug",
	closedState: "Closed",
	reopenState: "Active",
	tags: ["al-perf"],
	tagsAllowList: ["al-perf", "performance", "regression"],
};

export function resolveGitHubConfig(
	cfg: GitHubSinkConfig,
): Required<GitHubSinkConfig> {
	return { ...SINK_DEFAULTS, ...cfg };
}

/**
 * `areaPath` has no meaningful default (unset means "don't set one" — it
 * isn't a trust-posture flag), so the resolved shape keeps it optional
 * instead of forcing it into `Required<...>` like every other field.
 */
export type ResolvedAzureDevOpsConfig = Required<
	Omit<AzureDevOpsSinkConfig, "areaPath">
> &
	Pick<AzureDevOpsSinkConfig, "areaPath">;

export function resolveAzureDevOpsConfig(
	cfg: AzureDevOpsSinkConfig,
): ResolvedAzureDevOpsConfig {
	return { ...AZURE_DEVOPS_SINK_DEFAULTS, ...cfg };
}

const AUTO_FILE_MIN_SEVERITIES = ["critical", "warning", "info"] as const;

function requireBoolean(
	path: string,
	sinkName: string,
	field: string,
	value: unknown,
): void {
	if (value !== undefined && typeof value !== "boolean") {
		throw new Error(
			`${path}: sinks.${sinkName}.${field} must be a boolean (got ${JSON.stringify(value)})`,
		);
	}
}

function requireNumber(
	path: string,
	sinkName: string,
	field: string,
	value: unknown,
): void {
	if (value !== undefined && typeof value !== "number") {
		throw new Error(
			`${path}: sinks.${sinkName}.${field} must be a number (got ${JSON.stringify(value)})`,
		);
	}
}

function requireNonEmptyString(
	path: string,
	sinkName: string,
	field: string,
	value: unknown,
): void {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(
			`${path}: sinks.${sinkName}.${field} must be a non-empty string (got ${JSON.stringify(value)})`,
		);
	}
}

function requireNonEmptyStringIfPresent(
	path: string,
	sinkName: string,
	field: string,
	value: unknown,
): void {
	if (value !== undefined) requireNonEmptyString(path, sinkName, field, value);
}

function requireStringArrayIfPresent(
	path: string,
	sinkName: string,
	field: string,
	value: unknown,
): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		throw new Error(
			`${path}: sinks.${sinkName}.${field} must be an array of strings (got ${JSON.stringify(value)})`,
		);
	}
}

/**
 * Fail closed on a hand-edited config with the wrong JSON type for a
 * trust-posture field (e.g. `"autoFile": "false"` — a quoted boolean is
 * truthy in JS and would silently flip digest-first into auto-file-everything
 * once a consumer does `cfg.autoFile && ...`). Every field below is optional
 * in `SinkTriggerConfig`, so `undefined` is always allowed; only a present,
 * wrongly-typed value throws. Shared by every sink block (github,
 * azureDevOps, ...) so the same mistakes are caught regardless of
 * destination.
 */
function validateSharedTriggerShape(
	path: string,
	sinkName: string,
	obj: Record<string, unknown>,
): void {
	requireBoolean(path, sinkName, "enabled", obj.enabled);
	requireBoolean(path, sinkName, "autoFile", obj.autoFile);
	requireBoolean(path, sinkName, "autoClose", obj.autoClose);
	requireBoolean(path, sinkName, "reopenOnRecurrence", obj.reopenOnRecurrence);
	if (
		obj.autoFileMinSeverity !== undefined &&
		!(AUTO_FILE_MIN_SEVERITIES as readonly unknown[]).includes(
			obj.autoFileMinSeverity,
		)
	) {
		throw new Error(
			`${path}: sinks.${sinkName}.autoFileMinSeverity must be one of ${AUTO_FILE_MIN_SEVERITIES.map((v) => `"${v}"`).join(", ")} (got ${JSON.stringify(obj.autoFileMinSeverity)})`,
		);
	}
	requireNumber(path, sinkName, "autoFileAfterRuns", obj.autoFileAfterRuns);
	requireNumber(path, sinkName, "minMillisBetweenCalls", obj.minMillisBetweenCalls);
	requireNumber(path, sinkName, "maxPerDrain", obj.maxPerDrain);
	requireNumber(path, sinkName, "collapseThreshold", obj.collapseThreshold);
}

function validateGitHubSinkShape(
	path: string,
	gh: Record<string, unknown>,
): void {
	if (!/^[\w.-]+\/[\w.-]+$/.test(String(gh.repo ?? ""))) {
		throw new Error(
			`${path}: sinks.github.repo must be "owner/name" (got ${JSON.stringify(gh.repo)})`,
		);
	}
	validateSharedTriggerShape(path, "github", gh);
}

function validateAzureDevOpsSinkShape(
	path: string,
	ado: Record<string, unknown>,
): void {
	requireNonEmptyString(path, "azureDevOps", "org", ado.org);
	requireNonEmptyString(path, "azureDevOps", "project", ado.project);
	requireNonEmptyStringIfPresent(
		path,
		"azureDevOps",
		"workItemType",
		ado.workItemType,
	);
	requireNonEmptyStringIfPresent(
		path,
		"azureDevOps",
		"closedState",
		ado.closedState,
	);
	requireNonEmptyStringIfPresent(
		path,
		"azureDevOps",
		"reopenState",
		ado.reopenState,
	);
	requireStringArrayIfPresent(path, "azureDevOps", "tags", ado.tags);
	requireStringArrayIfPresent(
		path,
		"azureDevOps",
		"tagsAllowList",
		ado.tagsAllowList,
	);
	validateSharedTriggerShape(path, "azureDevOps", ado);
}

/**
 * Load `.al-perf/lifecycle.config.json` (or an explicit path). Missing file,
 * OR a file present but with no `sinks` key at all (a telemetry-only or
 * captureRequests-only config — telemetry-recipe.md §10/§11 documents this
 * shape as legal, since `loadLifecycleConfigFile` reads those blocks
 * separately) → null; the caller (`lifecycle sync`) already treats null as
 * "no delivery configured" and skips sink delivery gracefully while still
 * running the capture-request scan. A PRESENT but malformed `sinks` block
 * still throws — a misconfigured sink must fail loudly, not silently no-op.
 *
 * Shape is validated field-by-field (not just JSON-ness + repo format): a
 * malformed config must fail closed here, not surface as a downstream
 * TypeError or — worse — a silently misinterpreted trust-posture flag.
 */
export function loadSinksConfig(path: string): LifecycleSinksConfig | null {
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		throw new Error(`${path} is not valid JSON: ${err}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(
			`${path}: root must be an object (got ${JSON.stringify(parsed)})`,
		);
	}
	const cfg = parsed as Record<string, unknown>;
	const sinks = cfg.sinks;
	if (sinks === undefined) {
		return null;
	}
	if (typeof sinks !== "object" || sinks === null || Array.isArray(sinks)) {
		throw new Error(
			`${path}: sinks must be an object (got ${JSON.stringify(sinks)})`,
		);
	}
	const sinksObj = sinks as Record<string, unknown>;
	const gh = sinksObj.github;
	if (gh !== undefined) {
		if (typeof gh !== "object" || gh === null || Array.isArray(gh)) {
			throw new Error(
				`${path}: sinks.github must be an object (got ${JSON.stringify(gh)})`,
			);
		}
		validateGitHubSinkShape(path, gh as Record<string, unknown>);
	}
	const ado = sinksObj.azureDevOps;
	if (ado !== undefined) {
		if (typeof ado !== "object" || ado === null || Array.isArray(ado)) {
			throw new Error(
				`${path}: sinks.azureDevOps must be an object (got ${JSON.stringify(ado)})`,
			);
		}
		validateAzureDevOpsSinkShape(path, ado as Record<string, unknown>);
	}
	return cfg as unknown as LifecycleSinksConfig;
}

export function severityRank(s: string): number {
	if (s === "critical") return 3;
	if (s === "warning") return 2;
	if (s === "info") return 1;
	return 0;
}
