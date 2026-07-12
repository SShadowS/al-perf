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
 * knowledge; this scan runs at `lifecycle sync` time. The scan runs once per
 * ENABLED sink block (github, azureDevOps, ...), evaluating each sink's own
 * `SinkTriggerConfig` independently — a finding qualifying for one sink but
 * not another enqueues rows only for the qualifying sink. If NO sink is
 * enabled, events are left unprocessed entirely so enabling one later can
 * see the backlog.
 *
 * Recurrence after close: `filed-fresh` on a finding with an existing issue
 * mapping always enqueues comment-recurred (the visibility mechanism) for
 * that sink. That sink's `reopenOnRecurrence` (default false) additionally
 * enqueues a reopen-issue delivery on the same event.
 *
 * The entire scan (every enqueue decision plus the final sink_processed
 * flip) runs inside one enclosing `store.db.transaction()`, mirroring
 * evaluate.ts's discipline: a mid-scan throw rolls back everything, so a
 * crash never strands an event as "enqueued but not marked processed" (which
 * would re-fire it) or "marked processed but not enqueued" (which would
 * silently drop it). A retry re-scans cleanly. `markEventsProcessed` opens
 * its own nested transaction, which bun:sqlite implements as a SAVEPOINT and
 * composes safely inside the outer one.
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
	enqueued: number;
	skippedMigration: number;
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
		// Leave events unprocessed: a sink enabled later sees the backlog.
		return { processed: 0, enqueued: 0, skippedMigration: 0 };
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
		let skippedMigration = 0;
		const processedIds: number[] = [];

		for (const event of store.listUnprocessedEvents()) {
			processedIds.push(event.id);
			const detail = safeParse(event.detail);
			if (detail?.viaMigration === true) {
				skippedMigration++;
				continue;
			}
			const row = store.getFinding(event.findingId);
			if (!row) continue;

			for (const sink of sinks) {
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
		}

		store.markEventsProcessed(processedIds);
		return { processed: processedIds.length, enqueued, skippedMigration };
	});

	return scan();
}
