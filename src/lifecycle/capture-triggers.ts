/**
 * capture-triggers.ts — deep-capture request queue trigger scan (umbrella
 * spec's capture-requests plan, Task 2). Files a `capture_requests` row for
 * a recurring TELEMETRY finding so an operator/agent knows which routine is
 * worth an instrumentation capture — telemetry only ever gives coarse
 * routine-level signal (no call tree), so a deep capture is how the platform
 * gets line-level evidence for it.
 *
 * Namespace guard: only `telemetry:`-fingerprinted findings ever qualify.
 * `pattern:`/`alsem:` findings already carry (or can be re-run for) rich
 * call-tree evidence from a profile — they never need a capture request.
 *
 * Routine key fields (appId/objectType/objectId/methodName) come from the
 * finding's `routineKey` column — STRUCTURED data written at finding-
 * creation time (evaluate.ts's collectFindings → routineKeyFor), already
 * normalized with the D3 functions (normalizeAppGuid/canonicalObjectType/
 * normalizeTriggerName). This is deliberately NOT parsed out of the title —
 * routineKey is the one column guaranteed to carry it pre-normalized, so
 * splitting it keeps the capture-request's key fields byte-identical to
 * what a later deep capture's own routineKeyFor computation will produce,
 * making fulfillment (fulfillMatchingCaptureRequests) a plain string-equality
 * join.
 */

import type { LifecycleConfig } from "./config.js";
import type { FindingRow, LifecycleStore } from "./store.js";

export interface CaptureTriggerReport {
	/** Candidate findings considered (telemetry-namespaced, state new/open/regressed). */
	scanned: number;
	created: number;
	expired: number;
	/** Stale claims returned to `pending` for another worker (executor died mid-capture). */
	reclaimed: number;
	/** Candidates that qualified but were skipped because the tenant was already at maxPending. */
	skippedMaxPending: number;
}

const SEVERITY_RANK: Record<"critical" | "warning" | "info", number> = {
	info: 0,
	warning: 1,
	critical: 2,
};

const CANDIDATE_STATES = new Set(["new", "open", "regressed"]);

/** "telemetry-rt0018" → "RT0018" — the signal id embedded in the pattern id. */
function signalIdFromPatternId(patternId: string): string {
	return patternId.replace(/^telemetry-/, "").toUpperCase();
}

/**
 * routineKey is `${appId}|${objectType}|${objectId}|${methodName}`
 * (routineKeyFor, baselines.ts) — every segment already D3-normalized.
 * Returns null when the column isn't the expected 4-segment shape (e.g. a
 * defensive guard against a finding whose method never resolved at
 * collection time, which leaves routineKey "").
 */
function parseRoutineKey(routineKey: string): {
	appId: string;
	objectType: string;
	objectId: number;
	methodName: string;
} | null {
	const parts = routineKey.split("|");
	if (parts.length !== 4) return null;
	const [appId, objectType, objectIdStr, methodName] = parts;
	const objectId = Number(objectIdStr);
	if (!Number.isInteger(objectId)) return null;
	return { appId, objectType, objectId, methodName };
}

function isCandidate(f: FindingRow): boolean {
	return (
		f.fingerprint.startsWith("telemetry:") && CANDIDATE_STATES.has(f.state)
	);
}

/**
 * Run the trigger scan: expire stale requests, then walk telemetry findings
 * in `id` order, filing a capture request for each one that clears the
 * severity/occurrence thresholds and isn't already actively requested. The
 * whole scan (expiry sweep + candidate walk + creates) is one transaction —
 * a mid-scan throw rolls back everything rather than leaving a partial scan
 * that a retry could double-count.
 */
export function processCaptureTriggers(
	store: LifecycleStore,
	config: LifecycleConfig,
	now: string = new Date().toISOString(),
): CaptureTriggerReport {
	const scan = store.db.transaction((): CaptureTriggerReport => {
		const cfg = config.captureRequests;
		const expired = store.expireCaptureRequests(now);
		// Order matters: expireCaptureRequests also matches 'claimed' rows, so
		// a request past its creation TTL dies either way, regardless of order.
		// Expiring first means a dying request never touches reclaim_count —
		// reclaiming it first would flip it to 'pending' and increment
		// reclaim_count for a row that's about to expire anyway, corrupting the
		// exact signal reclaim_count exists to carry (a dead executor produces
		// many requests with one reclaim each; a poison request produces one
		// request with many reclaims).
		const reclaimed = store.reclaimStaleClaims(now, cfg.claimTtlMinutes);

		const minRank = SEVERITY_RANK[cfg.minSeverity];
		const candidates = store
			.listFindings()
			.filter(isCandidate)
			.sort((a, b) => a.id - b.id);

		let created = 0;
		let skippedMaxPending = 0;
		const expiresAt = new Date(
			Date.parse(now) + cfg.ttlDays * 86_400_000,
		).toISOString();

		for (const finding of candidates) {
			if (SEVERITY_RANK[finding.severity] < minRank) continue;
			const occurrenceCount = store.countOccurrences(finding.id);
			if (occurrenceCount < cfg.minOccurrences) continue;

			const key = parseRoutineKey(finding.routineKey);
			if (!key) continue;

			if (store.countActiveCaptureRequests(finding.tenant) >= cfg.maxPending) {
				skippedMaxPending++;
				continue;
			}

			const signalId = signalIdFromPatternId(finding.patternId);
			const wasCreated = store.createCaptureRequest({
				tenant: finding.tenant,
				fingerprint: finding.fingerprint,
				findingId: finding.id,
				appId: finding.appId || key.appId,
				appName: finding.appName || null,
				objectType: key.objectType,
				objectId: key.objectId,
				methodName: key.methodName,
				reason: `${signalId}: ${occurrenceCount} runs, severity ${finding.severity}`,
				requestedAt: now,
				expiresAt,
			});
			if (wasCreated) created++;
		}

		return {
			scanned: candidates.length,
			created,
			expired,
			reclaimed,
			skippedMaxPending,
		};
	});

	return scan();
}
