/**
 * backlog.test.ts — per-sink event watermark: a sink enabled after a tenant has
 * history replays that history and picks up the live backlog, while an existing
 * sink resumes where it left off.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLifecycleCommand } from "../../../src/cli/commands/lifecycle.js";
import { processEventsForSinks } from "../../../src/lifecycle/sinks/triggers.js";
import type { LifecycleSinksConfig } from "../../../src/lifecycle/sinks/types.js";
import {
	LifecycleStore,
	type NewFinding,
} from "../../../src/lifecycle/store.js";

const NOW = "2026-07-09T00:00:00Z";

/**
 * Windows-only flake guard, copied from sync-cli.test.ts: three sequential
 * open/close cycles against the same WAL-mode sqlite file can leave the
 * `-shm` mapping transiently locked for a beat after the last `.close()`
 * returns, and fs.rmSync's own retry options don't paper over it under Bun
 * on Windows.
 */
async function rmSyncRetrying(
	path: string,
	attempts = 10,
	delayMs = 200,
): Promise<void> {
	for (let i = 1; i <= attempts; i++) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (err) {
			if (i === attempts) throw err;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

function seedFinding(store: LifecycleStore, n: number, state = "open"): number {
	return store.insertFinding({
		tenant: "t1",
		fingerprint: `pattern:backlog000000${String(n).padStart(4, "0")}`,
		algoVersion: 1,
		state: state as NewFinding["state"],
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

/**
 * Qualifying occurrences (non-incomplete runs) for the autoFile hysteresis
 * gate (`countQualifyingOccurrences(row.id) >= autoFileAfterRuns`). Shape
 * copied from triggers.test.ts's seedOccurrences.
 */
function seedOccurrences(
	store: LifecycleStore,
	findingId: number,
	n: number,
): void {
	for (let i = 0; i < n; i++) {
		const { runId } = store.recordRun({
			tenant: "t1",
			stream: "nightly",
			profileId: `p-${findingId}-${i}`,
			captureKind: "sampling",
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: [], names: [] },
		});
		store.recordOccurrence({
			findingId,
			runId,
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			severity: "critical",
			details: JSON.stringify({ evidence: "SELECT * repeated 500x" }),
		});
	}
}

/**
 * Config-literal helper, copied in shape from triggers.test.ts's
 * config()/adoConfig()/multiConfig() — parameterized here by which sinks are
 * enabled since the backlog tests turn sinks on and off across scans. github
 * stays digest-first default (autoFile off) unless `githubAutoFile` is set,
 * matching every other github fixture in this suite; azureDevOps opts into
 * autoFile so the backlog-replay test has a sink that actually files on the
 * backlog.
 */
function sinksConfig(opts: {
	github?: boolean;
	githubAutoFile?: boolean;
	azureDevOps?: boolean;
}): LifecycleSinksConfig {
	const sinks: LifecycleSinksConfig["sinks"] = {};
	if (opts.github) {
		sinks.github = opts.githubAutoFile
			? {
					enabled: true,
					repo: "owner/repo",
					autoFile: true,
					autoFileAfterRuns: 2,
				}
			: { enabled: true, repo: "owner/repo" };
	}
	if (opts.azureDevOps) {
		sinks.azureDevOps = {
			enabled: true,
			org: "myorg",
			project: "myproj",
			autoFile: true,
			autoFileAfterRuns: 2,
		};
	}
	return { sinks };
}

describe("sink_progress watermark", () => {
	it("an unknown sink starts at 0 and sees every event", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store, 1);
		store.logEvent({
			findingId: id,
			event: "first-seen",
			fromState: null,
			toState: "new",
			at: NOW,
		});

		expect(store.getSinkProgress("azureDevOps")).toBe(0);
		expect(store.listUnprocessedEvents("azureDevOps").length).toBe(1);
		store.close();
	});

	it("advancing the watermark hides events from that sink only", () => {
		const store = new LifecycleStore(":memory:");
		const id = seedFinding(store, 1);
		store.logEvent({
			findingId: id,
			event: "first-seen",
			fromState: null,
			toState: "new",
			at: NOW,
		});
		const events = store.listUnprocessedEvents("github");
		store.advanceSinkProgress("github", events[events.length - 1].id);

		expect(store.listUnprocessedEvents("github").length).toBe(0);
		expect(store.listUnprocessedEvents("azureDevOps").length).toBe(1);
		store.close();
	});

	it("the watermark never moves backwards", () => {
		const store = new LifecycleStore(":memory:");
		store.advanceSinkProgress("github", 10);
		store.advanceSinkProgress("github", 3);
		expect(store.getSinkProgress("github")).toBe(10);
		store.close();
	});
});

describe("a sink enabled after the tenant has history", () => {
	it("files the LIVE backlog and skips findings that have since died", () => {
		const store = new LifecycleStore(":memory:");

		// Two findings with enough history to auto-file; one of them is dead.
		const live = seedFinding(store, 1, "open");
		const dead = seedFinding(store, 2, "resolved");
		for (const id of [live, dead]) {
			seedOccurrences(store, id, 2);
			store.logEvent({
				findingId: id,
				event: "first-seen",
				fromState: null,
				toState: "new",
				at: NOW,
			});
		}

		// Scan with ONLY github enabled: github advances its watermark past both.
		// github stays digest-first default (autoFile off), so this enqueues
		// nothing — it only drains the backlog off github's own watermark.
		const ghOnly = sinksConfig({ github: true, azureDevOps: false });
		processEventsForSinks(store, ghOnly, NOW);
		expect(store.listUnprocessedEvents("github").length).toBe(0);

		// Now enable azureDevOps AND flip github into auto-file mode too. If
		// github's watermark had NOT actually advanced past the backlog above,
		// this scan would find the "live" event unprocessed again and, with
		// autoFile now on, file it — so the trailing assertion below is no
		// longer trivially true just because github's autoFile happened to be
		// off (it wasn't testing the watermark at all before this change).
		const both = sinksConfig({
			github: true,
			githubAutoFile: true,
			azureDevOps: true,
		});
		const report = processEventsForSinks(store, both, NOW);
		expect(report.processed).toBeGreaterThan(0);

		const adoCreates = store
			.listPendingOutbox("azureDevOps", "create-issue")
			.map((r) => r.findingId);
		expect(adoCreates).toContain(live);
		expect(adoCreates).not.toContain(dead);

		// github, already caught up (no unprocessed events left even with
		// autoFile now on), enqueued nothing new.
		expect(store.listPendingOutbox("github", "create-issue").length).toBe(0);

		store.close();
	});
});

describe("lifecycle sync — backlog drain", () => {
	it("a backlog larger than one batch drains in a single sync", async () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-backlog-drain-"));
		const dbPath = join(dir, "lifecycle.sqlite");
		const configPath = join(dir, "lifecycle.config.json");
		const originalFetch = globalThis.fetch;
		const originalExitCode = process.exitCode;
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
			() => true,
		);
		try {
			// 600 events > the 500-event scan batch: one processEventsForSinks call
			// cannot see them all, so this fails unless `sync` loops.
			const seed = new LifecycleStore(dbPath);
			for (let i = 0; i < 600; i++) {
				const id = seed.insertFinding({
					tenant: "t1",
					fingerprint: `pattern:drain${String(i).padStart(4, "0")}`,
					algoVersion: 1,
					state: "open",
					source: "pattern",
					patternId: "calcfields-in-loop",
					title: `Drain finding ${i}`,
					severity: "info",
					appId: "",
					appName: "",
					routineKey: "",
					firstSeenAt: NOW,
					lastSeenAt: NOW,
					lastEventAt: NOW,
					observedKinds: ["sampling"],
					observedStreams: ["nightly"],
				} satisfies NewFinding);
				seed.logEvent({
					findingId: id,
					event: "seen-normal",
					fromState: "open",
					toState: "open",
					at: NOW,
				});
			}
			seed.close();

			writeFileSync(
				configPath,
				JSON.stringify({
					sinks: { github: { enabled: true, repo: "owner/repo" } },
				}),
			);

			// Recorder that throws: severity "info" against the default
			// autoFileMinSeverity ("critical") means digest-first github never
			// auto-files any of these, so no delivery should ever be attempted —
			// a real fetch call here would mean the gate didn't hold.
			globalThis.fetch = (async (...args: unknown[]) => {
				throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
			}) as typeof fetch;

			const cmd = createLifecycleCommand();
			cmd.exitOverride();
			await cmd.parseAsync(
				["--db", dbPath, "--config", configPath, "sync", "--dry-run"],
				{ from: "user" },
			);

			const store = new LifecycleStore(dbPath);
			expect(store.listUnprocessedEvents("github").length).toBe(0);
			store.close();
		} finally {
			globalThis.fetch = originalFetch;
			process.exitCode = originalExitCode ?? 0;
			errorSpy.mockRestore();
			logSpy.mockRestore();
			stdoutSpy.mockRestore();
			await rmSyncRetrying(dir);
		}
	});

	it("reports the union of distinct events across scans, not the sum of per-scan totals, when sinks sit at different watermarks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-backlog-union-"));
		const dbPath = join(dir, "lifecycle.sqlite");
		const configPath = join(dir, "lifecycle.config.json");
		const originalFetch = globalThis.fetch;
		const originalExitCode = process.exitCode;
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
			() => true,
		);
		try {
			// 600 distinct events. github has already scanned the first 400
			// (simulating a sink enabled well before azureDevOps); azureDevOps
			// starts fresh at watermark 0 and must replay the whole backlog.
			// With the 500-event batch cap, scan 1 has github cover ids 401-600
			// (200 events) while azureDevOps covers ids 1-500 (500 events) — a
			// union of all 600 in that single scan, since both are counted in
			// the same processEventsForSinks call. Scan 2 then has azureDevOps
			// pick up its remaining ids 501-600 (100 events) to finish, which
			// github already covered in scan 1. Summing each scan's distinct
			// count (600 + 100 = 700) double-counts that 501-600 overlap;
			// unioning the id sets across scans correctly reports 600.
			const seed = new LifecycleStore(dbPath);
			for (let i = 0; i < 600; i++) {
				const id = seed.insertFinding({
					tenant: "t1",
					fingerprint: `pattern:union${String(i).padStart(4, "0")}`,
					algoVersion: 1,
					state: "open",
					source: "pattern",
					patternId: "calcfields-in-loop",
					title: `Union finding ${i}`,
					severity: "info",
					appId: "",
					appName: "",
					routineKey: "",
					firstSeenAt: NOW,
					lastSeenAt: NOW,
					lastEventAt: NOW,
					observedKinds: ["sampling"],
					observedStreams: ["nightly"],
				} satisfies NewFinding);
				seed.logEvent({
					findingId: id,
					event: "seen-normal",
					fromState: "open",
					toState: "open",
					at: NOW,
				});
			}
			seed.advanceSinkProgress("github", 400);
			seed.close();

			writeFileSync(
				configPath,
				JSON.stringify({
					sinks: {
						github: { enabled: true, repo: "owner/repo" },
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproj",
						},
					},
				}),
			);

			// Severity "info" against the default autoFileMinSeverity
			// ("critical") means digest-first defaults on both sinks never
			// auto-file any of these — no delivery should ever be attempted.
			globalThis.fetch = (async (...args: unknown[]) => {
				throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
			}) as typeof fetch;

			const cmd = createLifecycleCommand();
			cmd.exitOverride();
			await cmd.parseAsync(
				[
					"--db",
					dbPath,
					"--config",
					configPath,
					"sync",
					"--dry-run",
					"-f",
					"json",
				],
				{ from: "user" },
			);

			const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
			const summary = JSON.parse(output);
			expect(summary.triggers.processed).toBe(600);

			const store = new LifecycleStore(dbPath);
			expect(store.listUnprocessedEvents("github").length).toBe(0);
			expect(store.listUnprocessedEvents("azureDevOps").length).toBe(0);
			store.close();
		} finally {
			globalThis.fetch = originalFetch;
			process.exitCode = originalExitCode ?? 0;
			errorSpy.mockRestore();
			logSpy.mockRestore();
			stdoutSpy.mockRestore();
			await rmSyncRetrying(dir);
		}
	});
});
