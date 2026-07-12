/**
 * config.ts — Lifecycle engine thresholds (umbrella spec §4 trigger rules).
 * All values are configurable; the defaults are the spec's "sensible defaults"
 * as resolved in the plan's Design Decisions (D11).
 */

export interface LifecycleConfig {
	/** Consecutive compatible absent runs before a finding resolves (spec: "absent N compatible runs"). */
	resolveAfterRuns: number;
	/** How many prior runs feed a baseline (within one version segment). */
	baselineWindow: number;
	/** Minimum same-segment samples before regression/improvement claims. */
	baselineMinRuns: number;
	/** Regressed when current > baselineMedian * regressionFactor (and past the absolute floor). */
	regressionFactor: number;
	/** Absolute floor (µs) — deltas smaller than this are never regressions/improvements. */
	regressionMinDeltaUs: number;
	/** Improved when current < baselineMedian * improvementFactor (and past the floor). */
	improvementFactor: number;
	/** Per-run cap on routine-metric rows (top N methods by selfTime). */
	routineMetricsPerRunCap: number;
	/** Raw routine-metric retention before daily rollup (spec: 90 days). */
	rawMetricsRetentionDays: number;
	/** telemetry-batch ingestion thresholds (umbrella spec: telemetry-ingest plan). */
	telemetry: {
		/** Reject telemetry-batch documents with more signals than this (payload budget). */
		maxSignalsPerBatch: number;
		/** Per-signalId severity thresholds (ms) on maxDurationMs; "default" covers unknown signalIds. */
		severity: Record<string, { warningMs: number; criticalMs: number }>;
		/** Multi-tenant split (pull-telemetry --split-by-customer): AAD tenant GUID → al-perf tenant code. Values are lowercased by the loader (config-file.ts) so a case-varying spelling never splits one customer's history across two SQLite tenants. */
		tenantMap: Record<string, string>;
		/** What to do with telemetry from AAD tenants absent from tenantMap: skip (default, loud) or bucket under the --tenant value. */
		unmappedTenantPolicy: "skip" | "fleet";
	};
	/** Deep-capture request queue trigger thresholds (capture-requests plan). */
	captureRequests: {
		/** Master switch — `lifecycle sync` skips the scan entirely when false. */
		enabled: boolean;
		/** Minimum recorded occurrences on a candidate finding before it qualifies. */
		minOccurrences: number;
		/** Minimum finding severity before it qualifies. */
		minSeverity: "critical" | "warning" | "info";
		/** Request lifetime in days before `expireCaptureRequests` reaps it. */
		ttlDays: number;
		/** Per-tenant cap on ACTIVE (pending/claimed) requests — further candidates are skipped, not queued. */
		maxPending: number;
		/**
		 * Minutes after which a CLAIMED request whose executor never reported back
		 * is returned to `pending` for another worker. The claim is advisory (see
		 * docs/capture-request-contract.md); this is the engine-side backstop for
		 * an executor that died mid-capture. Generous by default: a slow-but-alive
		 * executor that gets reclaimed causes a duplicate capture — wasteful, not
		 * corrupting, since both fulfil the same finding.
		 */
		claimTtlMinutes: number;
	};
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
	resolveAfterRuns: 3,
	baselineWindow: 10,
	baselineMinRuns: 3,
	regressionFactor: 1.5,
	regressionMinDeltaUs: 100_000,
	improvementFactor: 0.67,
	routineMetricsPerRunCap: 500,
	rawMetricsRetentionDays: 90,
	telemetry: {
		maxSignalsPerBatch: 10_000,
		severity: {
			RT0018: { warningMs: 10_000, criticalMs: 30_000 },
			RT0005: { warningMs: 10_000, criticalMs: 60_000 },
			default: { warningMs: 10_000, criticalMs: 60_000 },
		},
		tenantMap: {},
		unmappedTenantPolicy: "skip",
	},
	captureRequests: {
		enabled: true,
		minOccurrences: 3,
		minSeverity: "warning" as "critical" | "warning" | "info",
		ttlDays: 14,
		maxPending: 20,
		claimTtlMinutes: 60,
	},
};

/** Current lifecycle SQLite schema version (PRAGMA user_version target). See store.ts LIFECYCLE_MIGRATIONS. */
export const LIFECYCLE_SCHEMA_VERSION = 7;
