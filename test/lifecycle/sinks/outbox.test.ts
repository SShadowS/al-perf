/**
 * outbox.test.ts — drain semantics with a fake adapter: delivery, retryable
 * backoff, non-retryable dead-letter, attempt cap, rate-limit spacing,
 * collapse-to-epic.
 */

import { describe, expect, it } from "bun:test";
import {
	backoffAt,
	drainOutbox,
	MAX_ATTEMPTS,
} from "../../../src/lifecycle/sinks/outbox.js";
import type {
	SinkAdapter,
	SinkDelivery,
	SinkFindingContext,
	SinkResult,
} from "../../../src/lifecycle/sinks/types.js";
import {
	LifecycleStore,
	type NewFinding,
} from "../../../src/lifecycle/store.js";

const NOW = "2026-07-09T00:00:00Z";
const RUNTIME = {
	minMillisBetweenCalls: 100,
	maxPerDrain: 20,
	collapseThreshold: 5,
};

function fakeAdapter(
	script: SinkResult[],
): SinkAdapter & { seen: SinkDelivery[] } {
	const seen: SinkDelivery[] = [];
	return {
		name: "github",
		seen,
		async deliver(delivery) {
			seen.push(delivery);
			return script[Math.min(seen.length - 1, script.length - 1)];
		},
	};
}

function seedFinding(store: LifecycleStore, n: number): number {
	return store.insertFinding({
		tenant: "t1",
		fingerprint: `pattern:outbox0000000${String(n).padStart(3, "0")}`,
		algoVersion: 1,
		state: "open",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: `Finding ${n}`,
		severity: "critical",
		appId: "",
		appName: "",
		routineKey: "",
		firstSeenAt: NOW,
		lastSeenAt: NOW,
		lastEventAt: NOW,
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
	} satisfies NewFinding);
}

function contextFor(n: number): SinkFindingContext {
	return {
		fingerprint: `pattern:outbox0000000${String(n).padStart(3, "0")}`,
		title: `Finding ${n}`,
		severity: "critical",
		state: "open",
		patternId: "calcfields-in-loop",
		appName: "",
		firstSeenAt: NOW,
		lastSeenAt: NOW,
		occurrenceCount: 2,
		event: "seen-normal",
		metricClass: null,
		resolvedAt: null,
		evidence: null,
	};
}

function enqueueCreate(store: LifecycleStore, n: number): void {
	store.enqueueOutbox({
		tenant: "t1",
		sink: "github",
		kind: "create-issue",
		findingId: seedFinding(store, n),
		payload: JSON.stringify({ finding: contextFor(n), labels: ["al-perf"] }),
		dedupeKey: `github:create:t1:${n}`,
		nextAttemptAt: NOW,
		createdAt: NOW,
	});
}

describe("backoffAt", () => {
	it("doubles up to the one-hour cap", () => {
		expect(backoffAt(NOW, 0)).toBe("2026-07-09T00:00:30.000Z");
		expect(backoffAt(NOW, 1)).toBe("2026-07-09T00:01:00.000Z");
		expect(backoffAt(NOW, 10)).toBe("2026-07-09T01:00:00.000Z"); // capped
	});
});

describe("drainOutbox", () => {
	it("delivers due rows and marks them delivered", async () => {
		const store = new LifecycleStore(":memory:");
		enqueueCreate(store, 1);
		const adapter = fakeAdapter([{ ok: true, externalId: "10" }]);
		const report = await drainOutbox(store, adapter, RUNTIME, {
			now: NOW,
			sleep: async () => {},
		});
		expect(report.delivered).toBe(1);
		expect(store.listPendingOutbox("github")).toHaveLength(0);
		store.close();
	});

	it("retryable failure backs off with incremented attempts; dead after MAX_ATTEMPTS", async () => {
		const store = new LifecycleStore(":memory:");
		enqueueCreate(store, 1);
		const failing = fakeAdapter([{ ok: false, retryable: true, error: "503" }]);
		let report = await drainOutbox(store, failing, RUNTIME, {
			now: NOW,
			sleep: async () => {},
		});
		expect(report.retried).toBe(1);
		const later = "2026-07-10T00:00:00Z";
		const row = store.listDueOutbox("github", later, 10)[0];
		expect(row.attempts).toBe(1);
		// First retry lands on the documented 30s rung (attempts was 0 going
		// in) — not 60s, which would mean the exponent got shifted by one.
		expect(row.nextAttemptAt).toBe(backoffAt(NOW, 0));

		// Push attempts to the cap: it dead-letters instead of retrying forever.
		for (let i = 1; i < MAX_ATTEMPTS - 1; i++) {
			store.markOutboxRetry(row.id, "503", later);
		}
		report = await drainOutbox(store, failing, RUNTIME, {
			now: "2026-07-11T00:00:00Z",
			sleep: async () => {},
		});
		expect(report.dead).toBe(1);
		store.close();
	});

	it("non-retryable failure dead-letters immediately", async () => {
		const store = new LifecycleStore(":memory:");
		enqueueCreate(store, 1);
		const adapter = fakeAdapter([
			{ ok: false, retryable: false, error: "422 bad payload" },
		]);
		const report = await drainOutbox(store, adapter, RUNTIME, {
			now: NOW,
			sleep: async () => {},
		});
		expect(report.dead).toBe(1);
		expect(store.listPendingOutbox("github")).toHaveLength(0);
		store.close();
	});

	it("spaces deliveries by minMillisBetweenCalls (sleep injected)", async () => {
		const store = new LifecycleStore(":memory:");
		enqueueCreate(store, 1);
		enqueueCreate(store, 2);
		enqueueCreate(store, 3);
		const sleeps: number[] = [];
		const adapter = fakeAdapter([{ ok: true }]);
		await drainOutbox(store, adapter, RUNTIME, {
			now: NOW,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(sleeps).toEqual([100, 100]); // n-1 gaps
		store.close();
	});

	it("collapses >= threshold pending creates into one epic; children noted", async () => {
		const store = new LifecycleStore(":memory:");
		for (let n = 1; n <= 5; n++) enqueueCreate(store, n);
		const adapter = fakeAdapter([{ ok: true, externalId: "99" }]);
		const report = await drainOutbox(store, adapter, RUNTIME, {
			now: NOW,
			sleep: async () => {},
		});
		expect(report.collapsed).toBe(1);
		expect(report.delivered).toBe(1); // the epic itself
		expect(adapter.seen).toHaveLength(1);
		expect(adapter.seen[0].kind).toBe("create-epic");
		expect(adapter.seen[0].payload.children).toHaveLength(5);
		// Originals were closed out with a collapse note, not delivered to GitHub.
		const collapsedNote = store.db
			.query<{ n: number }, []>(
				"SELECT count(*) AS n FROM outbox WHERE status = 'delivered' AND last_error = 'collapsed-into-epic'",
			)
			.get();
		expect(collapsedNote?.n).toBe(5);
		store.close();
	});

	it("two separate collapse storms produce two distinct epics (dedupe key is row-set-scoped, not just tenant); a single storm still produces one", async () => {
		const store = new LifecycleStore(":memory:");
		const adapter = fakeAdapter([{ ok: true, externalId: "1" }]);

		// Storm A: 5 pending creates for t1, collapsed+delivered in one drain.
		for (let n = 1; n <= 5; n++) enqueueCreate(store, n);
		const reportA = await drainOutbox(store, adapter, RUNTIME, {
			now: NOW,
			sleep: async () => {},
		});
		expect(reportA.collapsed).toBe(1); // one storm -> one epic

		// Storm B: 5 MORE pending creates for the SAME tenant, arriving after
		// storm A already drained clean (no rows from A still pending).
		for (let n = 6; n <= 10; n++) enqueueCreate(store, n);
		const reportB = await drainOutbox(store, adapter, RUNTIME, {
			now: NOW,
			sleep: async () => {},
		});
		expect(reportB.collapsed).toBe(1); // second storm -> its own epic

		const epicRows = store.db
			.query<{ dedupe_key: string }, []>(
				"SELECT dedupe_key FROM outbox WHERE kind = 'create-epic' ORDER BY id",
			)
			.all();
		// Distinct storms produce distinct epic rows, not one collapsed-together
		// row: the dedupe key embeds the collapsed rows' own ids, so storm A's
		// key and storm B's key can never collide even though both are the same
		// tenant/sink pair.
		expect(epicRows).toHaveLength(2);
		expect(new Set(epicRows.map((r) => r.dedupe_key)).size).toBe(2);
		store.close();
	});

	it("collapse is atomic: a crash mid-batch rolls back the whole collapse; a clean re-drain collapses once", async () => {
		const store = new LifecycleStore(":memory:");
		for (let n = 1; n <= 5; n++) enqueueCreate(store, n);

		// Force the THIRD markOutboxDelivered call (mid-way through folding
		// the 5 originals into the epic) to throw, simulating a crash
		// between the epic insert and the last originals being closed out.
		let calls = 0;
		const originalMarkDelivered = store.markOutboxDelivered.bind(store);
		store.markOutboxDelivered = (id: number, at: string, note?: string) => {
			calls++;
			if (calls === 3) throw new Error("simulated crash");
			return originalMarkDelivered(id, at, note);
		};

		const adapter = fakeAdapter([{ ok: true, externalId: "99" }]);
		await expect(
			drainOutbox(store, adapter, RUNTIME, { now: NOW, sleep: async () => {} }),
		).rejects.toThrow("simulated crash");

		// Nothing from the failed collapse persisted: no epic row, and every
		// original is still pending (none stranded as a lone straggler that
		// would deliver individually — alongside the epic — next drain).
		expect(store.listPendingOutbox("github", "create-issue")).toHaveLength(5);
		const epicRows = store.db
			.query<{ n: number }, []>(
				"SELECT count(*) AS n FROM outbox WHERE kind = 'create-epic'",
			)
			.get();
		expect(epicRows?.n).toBe(0);

		// Retry with the real markOutboxDelivered — collapses cleanly, once.
		store.markOutboxDelivered = originalMarkDelivered;
		const report = await drainOutbox(store, adapter, RUNTIME, {
			now: NOW,
			sleep: async () => {},
		});
		expect(report.collapsed).toBe(1);
		expect(report.delivered).toBe(1);
		expect(store.listPendingOutbox("github")).toHaveLength(0);
		store.close();
	});
});
