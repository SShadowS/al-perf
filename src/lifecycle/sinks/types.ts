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

export interface GitHubSinkConfig {
	enabled: boolean;
	/** "owner/name" — never a URL. */
	repo: string;
	/** Env var holding the token — tokens NEVER live in the config file. */
	tokenEnv?: string;
	/** Digest-first: OFF by default; only high-confidence auto-filing. */
	autoFile?: boolean;
	autoFileMinSeverity?: "critical" | "warning" | "info";
	/** Hysteresis M: observed in at least this many runs before filing. */
	autoFileAfterRuns?: number;
	autoClose?: boolean;
	/** Labels applied to created issues (filtered by the allow-list). */
	labels?: string[];
	labelsAllowList?: string[];
	minMillisBetweenCalls?: number;
	maxPerDrain?: number;
	collapseThreshold?: number;
}

export interface LifecycleSinksConfig {
	sinks: { github?: GitHubSinkConfig };
}

export const SINK_DEFAULTS = {
	tokenEnv: "GITHUB_TOKEN",
	autoFile: false,
	autoFileMinSeverity: "critical" as const,
	autoFileAfterRuns: 2,
	autoClose: false,
	labels: ["al-perf"],
	labelsAllowList: ["al-perf", "performance", "regression"],
	minMillisBetweenCalls: 1000,
	maxPerDrain: 20,
	collapseThreshold: 5,
};

export function resolveGitHubConfig(
	cfg: GitHubSinkConfig,
): Required<GitHubSinkConfig> {
	return { ...SINK_DEFAULTS, ...cfg };
}

/**
 * Load `.al-perf/lifecycle.config.json` (or an explicit path). Missing file
 * → null (the caller points the user at the gh recipe). Invalid content
 * throws — a misconfigured sink must fail loudly, not silently no-op.
 */
export function loadSinksConfig(path: string): LifecycleSinksConfig | null {
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		throw new Error(`${path} is not valid JSON: ${err}`);
	}
	const cfg = parsed as LifecycleSinksConfig;
	const gh = cfg?.sinks?.github;
	if (gh && !/^[\w.-]+\/[\w.-]+$/.test(gh.repo ?? "")) {
		throw new Error(
			`${path}: sinks.github.repo must be "owner/name" (got ${JSON.stringify(gh?.repo)})`,
		);
	}
	return cfg;
}

export function severityRank(s: string): number {
	if (s === "critical") return 3;
	if (s === "warning") return 2;
	if (s === "info") return 1;
	return 0;
}
