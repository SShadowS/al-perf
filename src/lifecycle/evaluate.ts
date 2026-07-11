/**
 * evaluate.ts — turn (AnalysisResult, RunMetadata) into lifecycle state
 * (umbrella spec §4). The orchestration layer over the pure state machine
 * (states.ts), the store (store.ts), and the baselines (baselines.ts).
 *
 * Invariants enforced here:
 *  - Keyed to CAPTURE time (event time), never processing time. `captureTime`
 *    is canonicalized to UTC ISO 8601 on entry (`canonicalCaptureTime`) so
 *    every stored/compared value shares one form — the replay guards below
 *    depend on plain lexicographic `<=` comparison, which a non-UTC-offset
 *    input would silently misorder. An unparseable value throws.
 *  - Idempotent per (fingerprint, profileId): a duplicate run is a no-op;
 *    a late-arriving OLD run records occurrences but never drives state —
 *    including against a CLOSED finding. A stale backfill no newer than the
 *    closed row's `lastEventAt` records an occurrence against that row and
 *    stops; it does NOT file a fresh finding (filing fresh is itself a state
 *    mutation, so it needs the same replay guard as reopen/absence).
 *  - Incomplete captures (meta.incompleteInvocations > 0) process the
 *    presence side only: no absence counting, no baseline rows, and their
 *    metric qualifier is forced to "normal".
 *  - Absence compatibility: same stream + previously-observed capture kind
 *    + the run exercised the finding's app (plan D4/D7).
 *  - The ENTIRE per-run write path (recordRun through the absence pass) is
 *    one enclosing `store.db.transaction()`: a mid-run throw rolls back
 *    everything, including the `runs` row itself, so the run is never left
 *    half-processed — a retry (post-crash) re-evaluates cleanly instead of
 *    being permanently skipped by the duplicate-run guard. The per-finding
 *    mutation+logEvent pairs below open their own nested transactions —
 *    bun:sqlite implements nested `db.transaction()` calls as SAVEPOINTs, so
 *    they compose safely inside the outer one.
 *
 * Fingerprints are CONSUMED, never minted here — patterns carry
 * `fingerprint` from the phase-2 wiring; fusion findings carry the native
 * alsem fingerprint which is namespaced as `alsem:<native>`.
 */

import type { AnalysisResult } from "../output/types.js";
import { normalizeAppGuid } from "../semantic/identity.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import {
	classifyObservation,
	computeBaseline,
	type MetricClass,
	type RunVersions,
	recordRoutineMetrics,
	routineKeyFor,
	versionStampFrom,
} from "./baselines.js";
import { DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from "./config.js";
import { FINGERPRINT_ALGO_VERSION } from "./fingerprint.js";
import { type FindingState, type SeenQualifier, transition } from "./states.js";
import type {
	ExercisedApps,
	FindingRow,
	FindingSeverity,
	FindingSource,
	LifecycleStore,
} from "./store.js";

export interface RunMetadata {
	/** Tenant key (CLI default "local"; web: the authenticated tenant code). */
	tenant: string;
	/** Capture stream — schedule/job id; "adhoc" when uncorrelated (spec: "Run" = same (tenant, schedule/job) stream). */
	stream: string;
	/** Idempotency key: ingest activityId, or a content hash for CLI files. */
	profileId: string;
	captureKind: "sampling" | "instrumentation" | "telemetry";
	/**
	 * Profile CAPTURE time (ISO 8601) — the event time all state is keyed to.
	 * Canonical form is UTC (`evaluateRun` runs every value through
	 * `new Date(captureTime).toISOString()` on entry): a non-UTC-offset
	 * input is accepted and normalized, but the replay guards' `<=` string
	 * comparisons only stay correct because every stored value is ALWAYS
	 * this canonical UTC form. An unparseable value throws.
	 */
	captureTime: string;
	versions?: RunVersions;
}

export interface FindingTransitionRecord {
	findingId: number;
	fingerprint: string;
	from: FindingState | null;
	to: FindingState;
	event: string;
	metricClass?: MetricClass;
}

export interface EvaluationOutcome {
	runId: number;
	skipped?: "duplicate-run";
	incomplete: boolean;
	findingsSeen: number;
	unfingerprinted: number;
	transitions: FindingTransitionRecord[];
}

interface CollectedFinding {
	fingerprint: string;
	algoVersion: number;
	source: FindingSource;
	patternId: string;
	title: string;
	severity: FindingSeverity;
	appId: string;
	appName: string;
	routineKey: string;
	metricValue: number;
	impact: number;
	details: string;
}

/** "FunctionName (ObjectType ObjectId)" — the involvedMethods display form. */
const INVOLVED_METHOD_RE = /^(.+) \((\w+) (\d+)\)$/;

/**
 * Canonicalize a capture time to UTC ISO 8601. The event-time replay guards
 * throughout this module compare timestamps with plain string `<=`, which is
 * only valid when every value shares one canonical form — a `+02:00`-offset
 * input would otherwise sort incorrectly against previously-stored
 * (always-UTC) values without ever raising an error.
 */
function canonicalCaptureTime(raw: string): string {
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(
			`evaluateRun: RunMetadata.captureTime "${raw}" is not a parseable timestamp`,
		);
	}
	return parsed.toISOString();
}

/**
 * KNOWN EDGE: the index key is (objectType, objectId, functionName) alone —
 * no appId. If two apps in the SAME result both produce a method with that
 * exact triple (rare in BC, since object numbers are effectively app-scoped,
 * but possible with shared numbering or an overlapping extension point), the
 * FIRST app's entry wins and the second app's identity is lost. A telemetry
 * finding on that second app's method then resolves its appId here to the
 * first app, so absence gating (appWasExercised) checks it against the wrong
 * app's exercised set. Revisit if this bites in practice.
 */
function buildMethodIndex(
	result: AnalysisResult,
): Map<string, MethodBreakdown> {
	const map = new Map<string, MethodBreakdown>();
	const all = [
		...result.objectBreakdown.flatMap((o) => o.methods),
		...result.hotspots,
	];
	for (const m of all) {
		const key = `${m.objectType}:${m.objectId}:${m.functionName}`.toLowerCase();
		if (!map.has(key)) map.set(key, m);
	}
	return map;
}

function exercisedAppsOf(methods: Iterable<MethodBreakdown>): ExercisedApps {
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const m of methods) {
		const id = normalizeAppGuid(m.appId);
		if (id) ids.add(id);
		if (m.appName) names.add(m.appName.toLowerCase());
	}
	return { ids: [...ids], names: [...names] };
}

function appWasExercised(row: FindingRow, exercised: ExercisedApps): boolean {
	if (row.appId) return exercised.ids.includes(row.appId);
	if (row.appName) return exercised.names.includes(row.appName.toLowerCase());
	return true; // unknown app: treated as exercised (plan D7)
}

function alsemSeverity(s: string): FindingSeverity {
	const v = s.toLowerCase();
	if (v === "error" || v === "critical") return "critical";
	if (v === "warning") return "warning";
	return "info";
}

function sourceOf(fingerprint: string): FindingSource {
	const ns = fingerprint.split(":", 1)[0];
	return ns === "alsem" || ns === "telemetry" ? ns : "pattern";
}

function collectFindings(
	result: AnalysisResult,
	index: Map<string, MethodBreakdown>,
): { collected: CollectedFinding[]; unfingerprinted: number } {
	const byFingerprint = new Map<string, CollectedFinding>();
	let unfingerprinted = 0;
	const algoVersion =
		result.meta.fingerprintAlgoVersion ?? FINGERPRINT_ALGO_VERSION;

	for (const p of result.patterns) {
		if (!p.fingerprint) {
			unfingerprinted++;
			continue;
		}
		const match = p.involvedMethods[0]?.match(INVOLVED_METHOD_RE);
		const method = match
			? index.get(`${match[2]}:${match[3]}:${match[1]}`.toLowerCase())
			: undefined;
		const entry: CollectedFinding = {
			fingerprint: p.fingerprint,
			algoVersion,
			source: sourceOf(p.fingerprint),
			patternId: p.id,
			title: p.title,
			severity: p.severity,
			appId: normalizeAppGuid(method?.appId),
			appName: method?.appName ?? "",
			routineKey: method ? routineKeyFor(method) : "",
			metricValue: method?.selfTime ?? p.impact,
			impact: p.impact,
			details: JSON.stringify({
				evidence: p.evidence,
				suggestion: p.suggestion,
			}),
		};
		if (!byFingerprint.has(entry.fingerprint)) {
			byFingerprint.set(entry.fingerprint, entry);
		}
	}

	const fv = result.fusionViews;
	if (fv) {
		for (const pf of [...fv.prioritizedFindings, ...fv.unweightedFindings]) {
			const native = pf.finding.fingerprint;
			if (!native) {
				unfingerprinted++;
				continue;
			}
			const key =
				`${pf.objectType}:${pf.objectId}:${pf.functionName}`.toLowerCase();
			const method = index.get(key);
			const entry: CollectedFinding = {
				fingerprint: `alsem:${native}`,
				algoVersion,
				source: "alsem",
				patternId: pf.finding.detector,
				title: pf.finding.title,
				severity: alsemSeverity(pf.finding.severity),
				appId: normalizeAppGuid(method?.appId),
				appName: pf.appName || (method?.appName ?? ""),
				routineKey: method ? routineKeyFor(method) : "",
				metricValue: method?.selfTime ?? 0,
				impact: method?.selfTime ?? 0,
				details: JSON.stringify({ rootCause: pf.finding.rootCause }),
			};
			if (!byFingerprint.has(entry.fingerprint)) {
				byFingerprint.set(entry.fingerprint, entry);
			}
		}
	}

	return { collected: [...byFingerprint.values()], unfingerprinted };
}

export function evaluateRun(
	store: LifecycleStore,
	result: AnalysisResult,
	run: RunMetadata,
	configPatch?: Partial<LifecycleConfig>,
): EvaluationOutcome {
	run = { ...run, captureTime: canonicalCaptureTime(run.captureTime) };
	const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, ...configPatch };
	const incomplete = (result.meta.incompleteInvocations ?? 0) > 0;
	const index = buildMethodIndex(result);
	const exercised = exercisedAppsOf(index.values());
	const stamp = versionStampFrom(run.versions);

	// The whole write path is one transaction: a throw anywhere below rolls
	// back recordRun's `runs` insert too, so a crashed run is never left
	// half-applied and permanently invisible to retry (the duplicate-run
	// guard keys off the `runs` row existing at all).
	const runTx = store.db.transaction((): EvaluationOutcome => {
		const rec = store.recordRun({
			tenant: run.tenant,
			stream: run.stream,
			profileId: run.profileId,
			captureKind: run.captureKind,
			captureTime: run.captureTime,
			versionStamp: stamp,
			incomplete,
			exercisedApps: exercised,
		});
		if (rec.duplicate) {
			return {
				runId: rec.runId,
				skipped: "duplicate-run",
				incomplete,
				findingsSeen: 0,
				unfingerprinted: 0,
				transitions: [],
			};
		}

		// Deep-capture request fulfillment (capture-requests plan): a
		// non-telemetry, complete run whose method index covers a
		// pending/claimed request's routine closes that request out.
		// Telemetry-kind runs never fulfill — they're the coarse signal a
		// capture request exists to upgrade FROM, not evidence of a capture.
		// Incomplete captures can't be trusted as proof the routine ran.
		if (run.captureKind !== "telemetry" && !incomplete) {
			const keys = new Set<string>();
			for (const m of index.values()) keys.add(routineKeyFor(m));
			store.fulfillMatchingCaptureRequests(
				run.tenant,
				keys,
				run.profileId,
				run.captureTime,
			);
		}

		if (!incomplete) {
			recordRoutineMetrics(
				store,
				{
					tenant: run.tenant,
					stream: run.stream,
					captureKind: run.captureKind,
					profileId: run.profileId,
					captureTime: run.captureTime,
					versionStamp: stamp,
				},
				[...index.values()],
				cfg.routineMetricsPerRunCap,
			);
		}

		const { collected, unfingerprinted } = collectFindings(result, index);
		const transitions: FindingTransitionRecord[] = [];
		const seenIds = new Set<number>();

		for (const f of collected) {
			const active = store.getActiveFinding(run.tenant, f.fingerprint);
			if (!active) {
				const closed = store.getLatestClosedFinding(run.tenant, f.fingerprint);

				if (closed && run.captureTime <= closed.lastEventAt) {
					// Stale backfill, no newer than what we already know about this
					// (now-closed) finding: record history only. Filing a fresh row
					// here would be a late old run driving state — the same failure
					// mode the seen/absence replay guards below exist to prevent.
					store.recordOccurrence({
						findingId: closed.id,
						runId: rec.runId,
						captureTime: run.captureTime,
						severity: f.severity,
						impact: f.impact,
						metricValue: f.metricValue,
						metricClass: "no-baseline",
						details: f.details,
					});
					continue;
				}

				const event = closed ? "filed-fresh" : "first-seen";
				const id = store.db.transaction(() => {
					const newId = store.insertFinding({
						tenant: run.tenant,
						fingerprint: f.fingerprint,
						algoVersion: f.algoVersion,
						state: "new",
						source: f.source,
						patternId: f.patternId,
						title: f.title,
						severity: f.severity,
						appId: f.appId,
						appName: f.appName,
						routineKey: f.routineKey,
						firstSeenAt: run.captureTime,
						lastSeenAt: run.captureTime,
						lastEventAt: run.captureTime,
						observedKinds: [run.captureKind],
						observedStreams: [run.stream],
						needsTriage: closed !== null,
						supersedes: closed?.id,
					});
					store.recordOccurrence({
						findingId: newId,
						runId: rec.runId,
						captureTime: run.captureTime,
						severity: f.severity,
						impact: f.impact,
						metricValue: f.metricValue,
						metricClass: "no-baseline",
						details: f.details,
					});
					store.logEvent({
						findingId: newId,
						runId: rec.runId,
						event,
						fromState: null,
						toState: "new",
						at: run.captureTime,
						detail: closed
							? JSON.stringify({ supersedes: closed.id })
							: undefined,
					});
					return newId;
				})();
				transitions.push({
					findingId: id,
					fingerprint: f.fingerprint,
					from: null,
					to: "new",
					event,
					metricClass: "no-baseline",
				});
				seenIds.add(id);
				continue;
			}

			seenIds.add(active.id);
			let metricClass: MetricClass = "no-baseline";
			let qualifier: SeenQualifier = "normal";
			if (!incomplete && f.routineKey) {
				const baseline = computeBaseline(
					store,
					{
						tenant: run.tenant,
						stream: run.stream,
						captureKind: run.captureKind,
						routineKey: f.routineKey,
					},
					run.captureTime,
					cfg.baselineWindow,
				);
				metricClass = classifyObservation(f.metricValue, baseline, stamp, cfg);
				if (metricClass === "regressed") qualifier = "regressed";
				else if (metricClass === "improved") qualifier = "improved";
			}

			// recordOccurrence is idempotent (INSERT OR IGNORE) but within a
			// single evaluateRun call runId is always fresh (duplicate runs
			// return early above) and `collected` is deduped by fingerprint, so
			// (findingId, runId) can never already exist here — there's nothing
			// to guard against; the real idempotency check is the duplicate-run
			// short-circuit above.
			store.recordOccurrence({
				findingId: active.id,
				runId: rec.runId,
				captureTime: run.captureTime,
				severity: f.severity,
				impact: f.impact,
				metricValue: f.metricValue,
				metricClass,
				details: f.details,
			});
			if (run.captureTime <= active.lastEventAt) continue; // replay guard (D5)

			const res = transition(
				active.state,
				{ type: "seen", qualifier },
				{
					absenceCount: active.absenceCount,
					resolveAfterRuns: cfg.resolveAfterRuns,
				},
			);
			if (!res.ok) continue; // seen is always valid; defensive

			const willLog =
				res.next !== active.state || res.effects.includes("reopen");
			if (willLog) {
				const event = res.effects.includes("reopen")
					? "reopened"
					: `seen-${qualifier}`;
				store.db.transaction(() => {
					store.markSeen(active.id, {
						state: res.next,
						severity: f.severity,
						captureTime: run.captureTime,
						captureKind: run.captureKind,
						stream: run.stream,
					});
					store.logEvent({
						findingId: active.id,
						runId: rec.runId,
						event,
						fromState: active.state,
						toState: res.next,
						at: run.captureTime,
						detail: JSON.stringify({ metricClass }),
					});
				})();
				transitions.push({
					findingId: active.id,
					fingerprint: f.fingerprint,
					from: active.state,
					to: res.next,
					event,
					metricClass,
				});
			} else {
				// No state transition to log — still record the observation's
				// bookkeeping (resets absence, refreshes last_seen/observed_*).
				store.markSeen(active.id, {
					state: res.next,
					severity: f.severity,
					captureTime: run.captureTime,
					captureKind: run.captureKind,
					stream: run.stream,
				});
			}
		}

		// Absence pass — incomplete captures are excluded from run-counting (D6).
		if (!incomplete) {
			for (const row of store.listAbsenceCandidates(run.tenant)) {
				if (seenIds.has(row.id)) continue;
				if (run.captureTime <= row.lastEventAt) continue; // replay guard
				if (!row.observedStreams.includes(run.stream)) continue;
				if (!row.observedKinds.includes(run.captureKind)) continue;
				if (!appWasExercised(row, exercised)) continue;
				const newCount = row.absenceCount + 1;
				const res = transition(
					row.state,
					{ type: "absent" },
					{ absenceCount: newCount, resolveAfterRuns: cfg.resolveAfterRuns },
				);
				if (!res.ok) continue;

				if (res.next !== row.state) {
					store.db.transaction(() => {
						store.markAbsent(row.id, {
							state: res.next,
							absenceCount: newCount,
							captureTime: run.captureTime,
						});
						store.logEvent({
							findingId: row.id,
							runId: rec.runId,
							event: "resolved",
							fromState: row.state,
							toState: res.next,
							at: run.captureTime,
							detail: JSON.stringify({ absentRuns: newCount }),
						});
					})();
					transitions.push({
						findingId: row.id,
						fingerprint: row.fingerprint,
						from: row.state,
						to: res.next,
						event: "resolved",
					});
				} else {
					store.markAbsent(row.id, {
						state: res.next,
						absenceCount: newCount,
						captureTime: run.captureTime,
					});
				}
			}
		}

		return {
			runId: rec.runId,
			incomplete,
			findingsSeen: collected.length,
			unfingerprinted,
			transitions,
		};
	});

	return runTx();
}
