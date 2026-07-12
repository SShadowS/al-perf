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

import { sha256Hex16 } from "../fingerprint.js";
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

/**
 * Fold ≥ threshold pending creates per tenant into one create-epic row.
 *
 * The whole scan — every tenant's epic-enqueue plus its originals'
 * delivered-with-note writes — runs inside ONE `store.db.transaction()`
 * (mirroring triggers.ts's scan and store.ts's applyFingerprintMigration).
 * A crash partway through must never leave a bucket half-collapsed: with
 * separate autocommit statements, a crash between the epic insert and the
 * last original's `markOutboxDelivered` would leave those trailing
 * originals still pending, and a later drain — now under threshold — would
 * deliver them individually as duplicate issues alongside the epic that
 * already claims them as children.
 */
function collapseCreates(
	store: LifecycleStore,
	sink: string,
	threshold: number,
	now: string,
): number {
	const collapse = store.db.transaction((): number => {
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
			// INVARIANT (cross-referenced in github.ts's create-issue/create-epic
			// pre-check): `finding` is deliberately payloads[0].finding, the SAME
			// finding that also appears as children[0] below (children maps every
			// payload, including the first). The adapter's crash-mid-drain guard
			// relies on this aliasing — it only checks the mapping for
			// `finding.fingerprint` and treats that as covering the whole epic. If
			// this ever changes to a synthetic/non-aliased primary finding, that
			// guard must change too.
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
				// Hash, not concatenate: a 300-finding storm produced a ~2 KB key
				// in a UNIQUE TEXT column. Sorted so the key is a property of the
				// row-SET, not of the order listPendingOutbox happened to return.
				// Still row-set-scoped, so two separate storms in one tenant still
				// mint two distinct epics.
				dedupeKey: `${sink}:epic:${tenant}:${sha256Hex16(
					rows
						.map((r) => r.id)
						.sort((a, b) => a - b)
						.map(String),
				)}`,
				nextAttemptAt: now,
				createdAt: now,
			});
			for (const r of rows) {
				store.markOutboxDelivered(r.id, now, "collapsed-into-epic");
			}
			collapsed++;
		}
		return collapsed;
	});
	return collapse();
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
			// backoffAt(now, row.attempts) — the CURRENT attempts count, not
			// +1: the first retry (attempts=0 going in) must land on the
			// documented 30s rung, not skip straight to 60s.
			store.markOutboxRetry(row.id, result.error, backoffAt(now, row.attempts));
			report.retried++;
		}
	}
	return report;
}
