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
};

/** Current lifecycle SQLite schema version (PRAGMA user_version target). See store.ts LIFECYCLE_MIGRATIONS. */
export const LIFECYCLE_SCHEMA_VERSION = 3;
