/**
 * outbox.ts — asynchronous sink delivery (umbrella spec §4).
 *
 * State transitions commit locally in the lifecycle store; this worker
 * drains pending outbox rows to a SinkAdapter with:
 *  - exponential backoff (min(30s × 2^attempts, 1h)), dead-letter after
 *    MAX_ATTEMPTS or on a non-retryable error;
 *  - per-sink rate limiting (sequential, minMillisBetweenCalls between
 *    calls, maxPerDrain per invocation);
 *  - collapse-to-epic: ≥ collapseThreshold pending create-issue rows for
 *    one tenant become a single create-epic delivery (alert-storm guard).
 *
 * The lifecycle NEVER blocks on a sink: a GitHub outage just leaves rows
 * pending for the next `lifecycle sync`.
 */

import type { LifecycleStore, OutboxRow } from "../store.js";
import type {
	SinkAdapter,
	SinkDelivery,
	SinkDeliveryPayload,
	SinkResult,
} from "./types.js";

export const MAX_ATTEMPTS = 8;

export function backoffAt(now: string, attempts: number): string {
	const delay = Math.min(30_000 * 2 ** attempts, 3_600_000);
	return new Date(new Date(now).getTime() + delay).toISOString();
}

export interface DrainRuntime {
	minMillisBetweenCalls: number;
	maxPerDrain: number;
	collapseThreshold: number;
}

export interface DrainOptions {
	now?: string;
	/** Injectable for tests; defaults to Bun.sleep. */
	sleep?: (ms: number) => Promise<void>;
}

export interface DrainReport {
	delivered: number;
	retried: number;
	dead: number;
	collapsed: number;
}

function toDelivery(row: OutboxRow): SinkDelivery {
	return {
		id: row.id,
		tenant: row.tenant,
		sink: row.sink,
		kind: row.kind as SinkDelivery["kind"],
		findingId: row.findingId,
		payload: JSON.parse(row.payload) as SinkDeliveryPayload,
		dedupeKey: row.dedupeKey,
	};
}

/** Fold ≥ threshold pending creates per tenant into one create-epic row. */
function collapseCreates(
	store: LifecycleStore,
	sink: string,
	threshold: number,
	now: string,
): number {
	const pending = store.listPendingOutbox(sink, "create-issue");
	const byTenant = new Map<string, OutboxRow[]>();
	for (const row of pending) {
		const bucket = byTenant.get(row.tenant);
		if (bucket) bucket.push(row);
		else byTenant.set(row.tenant, [row]);
	}
	let collapsed = 0;
	for (const [tenant, rows] of byTenant) {
		if (rows.length < threshold) continue;
		const payloads = rows.map(
			(r) => JSON.parse(r.payload) as SinkDeliveryPayload,
		);
		const epic: SinkDeliveryPayload = {
			finding: payloads[0].finding,
			labels: payloads[0].labels,
			children: payloads.map((p) => p.finding),
		};
		store.enqueueOutbox({
			tenant,
			sink,
			kind: "create-epic",
			findingId: rows[0].findingId,
			payload: JSON.stringify(epic),
			dedupeKey: `${sink}:epic:${tenant}:${rows.map((r) => r.id).join(",")}`,
			nextAttemptAt: now,
			createdAt: now,
		});
		for (const r of rows) {
			store.markOutboxDelivered(r.id, now, "collapsed-into-epic");
		}
		collapsed++;
	}
	return collapsed;
}

export async function drainOutbox(
	store: LifecycleStore,
	adapter: SinkAdapter,
	runtime: DrainRuntime,
	opts?: DrainOptions,
): Promise<DrainReport> {
	const now = opts?.now ?? new Date().toISOString();
	const sleep = opts?.sleep ?? ((ms: number) => Bun.sleep(ms));
	const report: DrainReport = {
		delivered: 0,
		retried: 0,
		dead: 0,
		collapsed: collapseCreates(
			store,
			adapter.name,
			runtime.collapseThreshold,
			now,
		),
	};

	const due = store.listDueOutbox(adapter.name, now, runtime.maxPerDrain);
	let first = true;
	for (const row of due) {
		if (!first) await sleep(runtime.minMillisBetweenCalls);
		first = false;

		let result: SinkResult;
		try {
			result = await adapter.deliver(toDelivery(row), store);
		} catch (err) {
			result = { ok: false, retryable: true, error: String(err) };
		}

		if (result.ok) {
			store.markOutboxDelivered(row.id, now);
			report.delivered++;
			continue;
		}
		if (!result.retryable || row.attempts + 1 >= MAX_ATTEMPTS) {
			store.markOutboxDead(row.id, result.error);
			report.dead++;
		} else {
			store.markOutboxRetry(
				row.id,
				result.error,
				backoffAt(now, row.attempts + 1),
			);
			report.retried++;
		}
	}
	return report;
}
