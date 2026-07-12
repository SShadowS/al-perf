/**
 * triggers.ts — scan unprocessed finding_events and enqueue outbox rows
 * per the trigger policy (umbrella spec §4).
 *
 * Digest-first: with autoFile off (the default) NOTHING is ever filed —
 * only comments on already-mapped issues flow. Auto-filing requires
 * severity ≥ threshold AND hysteresis (observed in ≥ M QUALIFYING runs —
 * incomplete captures never count toward hysteresis, matching the umbrella
 * spec's exclusion of incomplete captures from lifecycle run-counting —
 * currently present). viaMigration events never reach sinks (mass-transition
 * guard).
 *
 * Decoupling invariant: evaluation (Plan A) logs events with no sink
 * knowledge; this scan runs at `lifecycle sync` time. Each ENABLED sink block
 * (github, azureDevOps, ...) tracks its OWN watermark (`sink_progress`), so
 * the scan loops sinks on the outside and, for each, walks only the events
 * that sink hasn't seen yet — a finding qualifying for one sink but not
 * another enqueues rows only for the qualifying sink. A sink enabled after a
 * tenant has accrued history starts at watermark 0 and replays everything;
 * a sink that has already scanned resumes exactly where it left off. If NO
 * sink is enabled, nothing is scanned and no watermark advances, which is
 * fine — a sink enabled later still has its own watermark starting at 0.
 *
 * Recurrence after close: `filed-fresh` on a finding with an existing issue
 * mapping always enqueues comment-recurred (the visibility mechanism) for
 * that sink. That sink's `reopenOnRecurrence` (default false) additionally
 * enqueues a reopen-issue delivery on the same event.
 *
 * The entire scan (every enqueue decision plus every sink's watermark
 * advance) runs inside one enclosing `store.db.transaction()`, mirroring
 * evaluate.ts's discipline: a mid-scan throw rolls back everything, so a
 * crash never strands an event as "enqueued but watermark not advanced"
 * (which would re-fire it) or "watermark advanced but not enqueued" (which
 * would silently drop it). A retry re-scans cleanly.
 */

import type { FindingRow, LifecycleStore, UnprocessedEvent } from "../store.js";
import {
	type LifecycleSinksConfig,
	resolveAzureDevOpsConfig,
	resolveGitHubConfig,
	type SinkDeliveryKind,
	type SinkDeliveryPayload,
	type SinkFindingContext,
	severityRank,
} from "./types.js";

/**
 * Per-sink runtime: the resolved trigger-rule values plus the destination's
 * validated tag/label set, in the shape the scan needs regardless of which
 * destination (GitHub issues, Azure DevOps work items, ...) they came from.
 * D2 — the scan builds one of these per ENABLED sink block and evaluates the
 * same rule logic once per sink, so `name === "github"` is the only place
 * destination identity matters (the dedupe grammar).
 */
interface SinkRuntime {
	name: string;
	labels: string[];
	autoFile: boolean;
	autoFileMinSeverity: string;
	autoFileAfterRuns: number;
	autoClose: boolean;
	reopenOnRecurrence: boolean;
}

function buildSinkRuntimes(config: LifecycleSinksConfig): SinkRuntime[] {
	const runtimes: SinkRuntime[] = [];
	const gh = config.sinks.github;
	if (gh?.enabled) {
		const cfg = resolveGitHubConfig(gh);
		runtimes.push({
			name: "github",
			labels: cfg.labels.filter((l) => cfg.labelsAllowList.includes(l)),
			autoFile: cfg.autoFile,
			autoFileMinSeverity: cfg.autoFileMinSeverity,
			autoFileAfterRuns: cfg.autoFileAfterRuns,
			autoClose: cfg.autoClose,
			reopenOnRecurrence: cfg.reopenOnRecurrence,
		});
	}
	const ado = config.sinks.azureDevOps;
	if (ado?.enabled) {
		const cfg = resolveAzureDevOpsConfig(ado);
		runtimes.push({
			name: "azureDevOps",
			labels: cfg.tags.filter((t) => cfg.tagsAllowList.includes(t)),
			autoFile: cfg.autoFile,
			autoFileMinSeverity: cfg.autoFileMinSeverity,
			autoFileAfterRuns: cfg.autoFileAfterRuns,
			autoClose: cfg.autoClose,
			reopenOnRecurrence: cfg.reopenOnRecurrence,
		});
	}
	return runtimes;
}

const PRESENCE_EVENTS = new Set([
	"first-seen",
	"filed-fresh",
	"seen-normal",
	"seen-regressed",
	"seen-improved",
	"reopened",
]);

export interface TriggerReport {
	processed: number;
	/**
	 * The distinct event ids counted in `processed`, sorted ascending. A
	 * caller draining a backlog over several scans (each capped at a batch
	 * per sink) must union these across scans rather than sum `processed` —
	 * sinks at different watermarks can each see the same event in
	 * successive scans, so summing double-counts it.
	 */
	processedIds: number[];
	enqueued: number;
	skippedMigration: number;
	/**
	 * The distinct event ids counted in `skippedMigration`, sorted ascending.
	 * Same caveat as `processedIds`: a caller draining several scans must
	 * union these rather than sum `skippedMigration`.
	 */
	skippedIds: number[];
}

function safeParse(json: string | null): Record<string, unknown> | null {
	if (!json) return null;
	try {
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function contextOf(
	store: LifecycleStore,
	row: FindingRow,
	event: UnprocessedEvent,
): SinkFindingContext {
	const detail = safeParse(event.detail);
	const occDetails = safeParse(store.getLatestOccurrenceDetails(row.id));
	return {
		fingerprint: row.fingerprint,
		title: row.title,
		severity: row.severity,
		state: row.state,
		patternId: row.patternId,
		appName: row.appName,
		firstSeenAt: row.firstSeenAt,
		lastSeenAt: row.lastSeenAt,
		occurrenceCount: store.countOccurrences(row.id),
		event: event.event,
		metricClass:
			typeof detail?.metricClass === "string" ? detail.metricClass : null,
		resolvedAt: row.resolvedAt,
		evidence:
			typeof occDetails?.evidence === "string" ? occDetails.evidence : null,
	};
}

export function processEventsForSinks(
	store: LifecycleStore,
	config: LifecycleSinksConfig,
	now = new Date().toISOString(),
): TriggerReport {
	const sinks = buildSinkRuntimes(config);
	if (sinks.length === 0) {
		// No enabled sink: nothing to scan and no watermark to advance. Each
		// sink's watermark is its own, so a sink enabled later still sees the
		// backlog — that no longer depends on leaving events unprocessed.
		return {
			processed: 0,
			processedIds: [],
			enqueued: 0,
			skippedMigration: 0,
			skippedIds: [],
		};
	}

	const enqueue = (
		sink: SinkRuntime,
		row: FindingRow,
		event: UnprocessedEvent,
		kind: SinkDeliveryKind,
		dedupeKey: string,
	): boolean => {
		const payload: SinkDeliveryPayload = {
			finding: contextOf(store, row, event),
			labels: sink.labels,
		};
		return store.enqueueOutbox({
			tenant: row.tenant,
			sink: sink.name,
			kind,
			findingId: row.id,
			payload: JSON.stringify(payload),
			dedupeKey,
			nextAttemptAt: now,
			createdAt: now,
		});
	};

	const scan = store.db.transaction((): TriggerReport => {
		let enqueued = 0;
		// Sets, not counters: with two sinks enabled the same event is scanned
		// twice, but TriggerReport.processed/skippedMigration have always meant
		// DISTINCT events. Counting per-sink would silently double the numbers.
		const processedIds = new Set<number>();
		const skippedIds = new Set<number>();

		for (const sink of sinks) {
			const events = store.listUnprocessedEvents(sink.name);
			if (events.length === 0) continue;

			for (const event of events) {
				processedIds.add(event.id);
				const detail = safeParse(event.detail);
				if (detail?.viaMigration === true) {
					skippedIds.add(event.id);
					continue;
				}
				const row = store.getFinding(event.findingId);
				if (!row) continue;

				const mapping = store.getIssueMapping(
					row.tenant,
					sink.name,
					row.fingerprint,
				);

				if (
					(event.event === "seen-regressed" || event.event === "reopened") &&
					mapping
				) {
					if (
						enqueue(
							sink,
							row,
							event,
							"comment-regressed",
							`${sink.name}:comment-regressed:${event.id}`,
						)
					) {
						enqueued++;
					}
				}

				if (event.event === "filed-fresh" && mapping) {
					if (
						enqueue(
							sink,
							row,
							event,
							"comment-recurred",
							`${sink.name}:comment-recurred:${event.id}`,
						)
					) {
						enqueued++;
					}
					// reopenOnRecurrence: comment-recurred above is the visibility
					// mechanism regardless of this flag; when true, also PATCH the
					// mapped issue back open (see github.ts's reopen-issue kind).
					if (sink.reopenOnRecurrence) {
						if (
							enqueue(
								sink,
								row,
								event,
								"reopen-issue",
								`${sink.name}:reopen:${event.id}`,
							)
						) {
							enqueued++;
						}
					}
				}

				if (event.event === "resolved" && mapping) {
					if (
						enqueue(
							sink,
							row,
							event,
							"comment-resolved",
							`${sink.name}:comment-resolved:${event.id}`,
						)
					) {
						enqueued++;
					}
					if (sink.autoClose) {
						if (
							enqueue(
								sink,
								row,
								event,
								"close-issue",
								`${sink.name}:close:${event.id}`,
							)
						) {
							enqueued++;
						}
					}
				}

				// The liveness guard for replay: a newly-enabled sink walking a
				// tenant's whole history must file the LIVE backlog and nothing
				// else. absenceCount/state pin the finding to its state NOW, not
				// its state when the event fired, so a long-dead finding files
				// nothing no matter how many presence events it once had.
				if (
					PRESENCE_EVENTS.has(event.event) &&
					sink.autoFile &&
					!mapping &&
					severityRank(row.severity) >=
						severityRank(sink.autoFileMinSeverity) &&
					store.countQualifyingOccurrences(row.id) >= sink.autoFileAfterRuns &&
					row.absenceCount === 0 &&
					row.state !== "resolved" &&
					row.state !== "closed"
				) {
					if (
						enqueue(
							sink,
							row,
							event,
							"create-issue",
							`${sink.name}:create:${row.tenant}:${row.fingerprint}`,
						)
					) {
						enqueued++;
					}
				}
			}

			// Events come back ORDER BY id, so the last one is the high-water mark
			// for this sink's batch. A backlog larger than the batch limit drains
			// over successive scans — `lifecycle sync` loops until a scan is empty.
			store.advanceSinkProgress(sink.name, events[events.length - 1].id);
		}

		return {
			processed: processedIds.size,
			processedIds: [...processedIds].sort((a, b) => a - b),
			enqueued,
			skippedMigration: skippedIds.size,
			skippedIds: [...skippedIds].sort((a, b) => a - b),
		};
	});

	return scan();
}
