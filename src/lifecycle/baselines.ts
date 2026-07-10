/**
 * baselines.ts — per-routine, per-run metrics with version-aware rolling
 * baselines (umbrella spec §4 trigger rules).
 *
 * Baselines are keyed (tenant, stream, captureKind, routineKey) — sampling
 * statistical self-time and instrumentation exact ticks are never comparable
 * — and version-stamped: a metric shift that coincides with a version-stamp
 * change classifies as "environment-changed", never "regressed" (monthly BC
 * minor updates must not file false regressions).
 *
 * Retention: raw rows for rawMetricsRetentionDays (default 90), folded into
 * daily rollups by rollupRoutineMetrics — a callable maintenance function
 * (surfaced as `lifecycle maintain`); scheduling is out of scope.
 */

import {
	canonicalObjectType,
	normalizeAppGuid,
	normalizeTriggerName,
} from "../semantic/identity.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { LifecycleConfig } from "./config.js";
import type { LifecycleStore } from "./store.js";

export interface RunVersions {
	platform?: string;
	apps?: Array<{ id: string; version: string }>;
}

/**
 * Canonical version stamp: "" when no version info, else stable JSON with
 * apps sorted by id (so producer ordering can't split segments).
 */
export function versionStampFrom(versions?: RunVersions): string {
	if (!versions || (!versions.platform && !(versions.apps?.length ?? 0))) {
		return "";
	}
	const apps = [...(versions.apps ?? [])].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	return JSON.stringify({ platform: versions.platform ?? "", apps });
}

/**
 * Normalized routine identity for baseline keying — the same normalization
 * family as the fingerprint fallback key (identity must not split on casing
 * or GUID-dash drift between producers).
 */
export function routineKeyFor(m: {
	appId?: string;
	objectType: string;
	objectId: number;
	functionName: string;
}): string {
	return [
		normalizeAppGuid(m.appId),
		canonicalObjectType(m.objectType),
		String(m.objectId),
		normalizeTriggerName(m.functionName).toLowerCase(),
	].join("|");
}

export interface MetricRunKey {
	tenant: string;
	stream: string;
	captureKind: "sampling" | "instrumentation";
	profileId: string;
	captureTime: string;
	versionStamp: string;
}

/**
 * Write per-routine metric rows for one run: top `cap` AL methods by
 * selfTime (builtins excluded — they can't anchor findings). INSERT OR
 * IGNORE keyed (tenant, profileId, routineKey) makes re-recording a no-op.
 * Returns the number of rows actually written.
 */
export function recordRoutineMetrics(
	store: LifecycleStore,
	run: MetricRunKey,
	methods: MethodBreakdown[],
	cap: number,
): number {
	const top = methods
		.filter((m) => !m.isBuiltin)
		.sort((a, b) => b.selfTime - a.selfTime)
		.slice(0, cap);
	const insert = store.db.prepare(
		`INSERT OR IGNORE INTO routine_metrics (tenant, stream, capture_kind, routine_key, profile_id, capture_time, self_time, total_time, hit_count, version_stamp)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	let written = 0;
	const tx = store.db.transaction(() => {
		for (const m of top) {
			const res = insert.run(
				run.tenant,
				run.stream,
				run.captureKind,
				routineKeyFor(m),
				run.profileId,
				run.captureTime,
				m.selfTime,
				m.totalTime,
				m.hitCount,
				run.versionStamp,
			);
			if (res.changes > 0) written++;
		}
	});
	tx();
	return written;
}

export interface BaselineStats {
	/** Median selfTime over prior runs in the CURRENT segment. */
	median: number;
	/** Number of prior runs sharing the latest prior version stamp. */
	sameStampCount: number;
	/** Version stamp of the most recent prior run (segment-boundary detection). */
	latestPriorStamp: string;
}

/** Median of a numeric array (average of the two middle values when even). */
function median(xs: number[]): number {
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Rolling baseline: the last `window` rows strictly before `beforeTime` for
 * the key, restricted to the MOST RECENT prior version stamp. Filter-then-
 * window (not window-then-filter): a first query finds the latest prior
 * row's version stamp, then a second query pulls the last `window` rows
 * sharing that stamp. This matters under a version-stamp reappearance (e.g.
 * a BC point-in-time restore lands back on an older platform version) —
 * windowing across all stamps first would silently truncate the segment to
 * whatever recent rows happen to share the reappeared stamp, undercounting
 * `sameStampCount` and skewing the median toward the wrong rows.
 */
export function computeBaseline(
	store: LifecycleStore,
	key: {
		tenant: string;
		stream: string;
		captureKind: string;
		routineKey: string;
	},
	beforeTime: string,
	window: number,
): BaselineStats | null {
	const latest = store.db
		.query<{ version_stamp: string }, [string, string, string, string, string]>(
			`SELECT version_stamp FROM routine_metrics
			 WHERE tenant = ? AND stream = ? AND capture_kind = ? AND routine_key = ? AND capture_time < ?
			 ORDER BY capture_time DESC LIMIT 1`,
		)
		.get(key.tenant, key.stream, key.captureKind, key.routineKey, beforeTime);
	if (!latest) return null;
	const latestPriorStamp = latest.version_stamp;
	const rows = store.db
		.query<
			{ self_time: number },
			[string, string, string, string, string, string, number]
		>(
			`SELECT self_time FROM routine_metrics
			 WHERE tenant = ? AND stream = ? AND capture_kind = ? AND routine_key = ? AND capture_time < ? AND version_stamp = ?
			 ORDER BY capture_time DESC LIMIT ?`,
		)
		.all(
			key.tenant,
			key.stream,
			key.captureKind,
			key.routineKey,
			beforeTime,
			latestPriorStamp,
			window,
		);
	const selfTimes = rows.map((r) => r.self_time);
	return {
		median: median(selfTimes),
		sameStampCount: selfTimes.length,
		latestPriorStamp,
	};
}

export type MetricClass =
	| "normal"
	| "regressed"
	| "improved"
	| "no-baseline"
	| "environment-changed";

/**
 * Classify a current observation against its baseline:
 *  - no prior rows, or too few same-segment samples → "no-baseline"
 *  - version stamp changed since the baseline → "environment-changed"
 *    (annotated, never a regression — spec §4)
 *  - factor AND absolute-floor guards for regressed/improved (both must
 *    hold, so tiny routines can't flap on noise)
 */
export function classifyObservation(
	current: number,
	baseline: BaselineStats | null,
	currentVersionStamp: string,
	cfg: LifecycleConfig,
): MetricClass {
	if (!baseline) return "no-baseline";
	if (baseline.latestPriorStamp !== currentVersionStamp) {
		return "environment-changed";
	}
	if (baseline.sameStampCount < cfg.baselineMinRuns) return "no-baseline";
	const delta = current - baseline.median;
	if (
		current > baseline.median * cfg.regressionFactor &&
		delta >= cfg.regressionMinDeltaUs
	) {
		return "regressed";
	}
	if (
		current < baseline.median * cfg.improvementFactor &&
		-delta >= cfg.regressionMinDeltaUs
	) {
		return "improved";
	}
	return "normal";
}

/**
 * Maintenance: fold raw routine_metrics rows older than `retentionDays`
 * (relative to `now`) into daily rollups, then delete the raw rows.
 * Idempotent: re-running with no old rows is a no-op; rollup rows are
 * REPLACEd per (tenant, stream, captureKind, routineKey, day).
 */
export function rollupRoutineMetrics(
	store: LifecycleStore,
	now: string,
	retentionDays: number,
): { rolledUp: number; deleted: number } {
	const cutoff = new Date(
		new Date(now).getTime() - retentionDays * 86_400_000,
	).toISOString();
	const rows = store.db
		.query<
			{
				tenant: string;
				stream: string;
				capture_kind: string;
				routine_key: string;
				capture_time: string;
				self_time: number;
				total_time: number;
				hit_count: number;
			},
			[string]
		>(
			`SELECT tenant, stream, capture_kind, routine_key, capture_time, self_time, total_time, hit_count
			 FROM routine_metrics WHERE capture_time < ?`,
		)
		.all(cutoff);
	if (rows.length === 0) return { rolledUp: 0, deleted: 0 };

	const groups = new Map<string, typeof rows>();
	for (const row of rows) {
		const day = row.capture_time.slice(0, 10);
		const key = JSON.stringify([
			row.tenant,
			row.stream,
			row.capture_kind,
			row.routine_key,
			day,
		]);
		const bucket = groups.get(key);
		if (bucket) bucket.push(row);
		else groups.set(key, [row]);
	}

	const upsert = store.db.prepare(
		`INSERT OR REPLACE INTO routine_metrics_rollup (tenant, stream, capture_kind, routine_key, day, run_count, self_time_min, self_time_max, self_time_mean, self_time_median, total_time_mean, hit_count_mean)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	let rolledUp = 0;
	const tx = store.db.transaction(() => {
		for (const [key, bucket] of groups) {
			const [tenant, stream, captureKind, routineKey, day] = JSON.parse(
				key,
			) as string[];
			const selfTimes = bucket.map((r) => r.self_time).sort((a, b) => a - b);
			const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
			upsert.run(
				tenant,
				stream,
				captureKind,
				routineKey,
				day,
				bucket.length,
				selfTimes[0],
				selfTimes[selfTimes.length - 1],
				mean(bucket.map((r) => r.self_time)),
				median(bucket.map((r) => r.self_time)),
				mean(bucket.map((r) => r.total_time)),
				mean(bucket.map((r) => r.hit_count)),
			);
			rolledUp++;
		}
		store.db.run("DELETE FROM routine_metrics WHERE capture_time < ?", [
			cutoff,
		]);
	});
	tx();
	return { rolledUp, deleted: rows.length };
}
