/**
 * sync-cli.test.ts — `lifecycle sync` as a security boundary. In-process
 * (createLifecycleCommand + commander), not a subprocess, so globalThis.fetch
 * can be patched with a recorder that throws if invoked where zero calls are
 * expected: --dry-run must never touch the network, and a missing sink token
 * must fail closed without ever calling out or leaking the token's value.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLifecycleCommand } from "../../src/cli/commands/lifecycle.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";

const TENANT = "t1";
const FP = "pattern:sync0000000000001";
const DECOY_VALUE = "super-secret-should-never-appear-in-output";

/**
 * Windows-only flake guard: three sequential open/close cycles against the
 * same WAL-mode sqlite file (seed store, the CLI action's own store, this
 * file's post-assertion store) can leave the `-shm` mapping transiently
 * locked for a beat after the last `.close()` returns. `fs.rmSync`'s
 * built-in `maxRetries`/`retryDelay` do NOT paper over this under Bun on
 * Windows (verified empirically — they don't actually delay between
 * attempts), so retry by hand with a real await between tries.
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

function finding(overrides?: Partial<NewFinding>): NewFinding {
	return {
		tenant: TENANT,
		fingerprint: FP,
		algoVersion: 1,
		state: "open",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "CalcFields inside loop",
		severity: "critical",
		appId: "",
		appName: "My App",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-05T00:00:00Z",
		lastEventAt: "2026-07-05T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
		...overrides,
	};
}

/**
 * Seed a finding with an existing issue mapping plus an unprocessed
 * "seen-regressed" event — the simplest path that reliably enqueues one
 * outbox row via processEventsForSinks (comment-regressed routes on the
 * issue map alone; no autoFile/hysteresis config needed).
 */
function seedPendingDelivery(dbPath: string): void {
	const store = new LifecycleStore(dbPath);
	const id = store.insertFinding(finding());
	store.putIssueMapping({
		tenant: TENANT,
		sink: "github",
		fingerprint: FP,
		externalId: "42",
		createdAt: "2026-07-01T00:00:00Z",
	});
	store.logEvent({
		findingId: id,
		event: "seen-regressed",
		fromState: "open",
		toState: "regressed",
		at: "2026-07-05T00:00:00Z",
	});
	store.close();
}

/** A telemetry-namespaced finding with 3+ occurrences — qualifies for a capture request under the default config. */
const TELEMETRY_FP = "telemetry:sync000000000cap1";
function seedQualifyingTelemetryFinding(
	dbPath: string,
	overrides?: { fingerprint?: string; routineKey?: string },
): void {
	const fingerprint = overrides?.fingerprint ?? TELEMETRY_FP;
	const routineKey = overrides?.routineKey ?? "abc123|Codeunit|50100|postorder";
	const store = new LifecycleStore(dbPath);
	const id = store.insertFinding(
		finding({
			fingerprint,
			source: "telemetry",
			patternId: "telemetry-rt0018",
			title: "RT0018: PostOrder (Codeunit 50100) slow — max 42000ms × 3",
			severity: "warning",
			appId: "abc123",
			routineKey,
			state: "open",
		}),
	);
	for (let i = 0; i < 3; i++) {
		const { runId } = store.recordRun({
			tenant: TENANT,
			stream: "telemetry",
			profileId: `p-cap-${fingerprint}-${i}`,
			captureKind: "telemetry",
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			versionStamp: "",
			incomplete: false,
			exercisedApps: { ids: [], names: [] },
		});
		store.recordOccurrence({
			findingId: id,
			runId,
			captureTime: `2026-07-0${i + 1}T00:00:00Z`,
			severity: "warning",
		});
	}
	store.close();
}

/** Seed a dead-lettered outbox row directly (no live drain needed). */
const DEAD_FP = "pattern:sync0000000000dead";
function seedDeadLetter(dbPath: string): void {
	const store = new LifecycleStore(dbPath);
	const id = store.insertFinding(finding({ fingerprint: DEAD_FP }));
	store.enqueueOutbox({
		tenant: TENANT,
		sink: "github",
		kind: "create-issue",
		findingId: id,
		payload: JSON.stringify({ secret: DECOY_VALUE }),
		dedupeKey: `github:create:${TENANT}:${DEAD_FP}`,
		nextAttemptAt: "2026-07-01T00:00:00Z",
		createdAt: "2026-07-01T00:00:00Z",
	});
	const row = store.listPendingOutbox("github", "create-issue")[0];
	store.markOutboxDead(row.id, "422 Unprocessable Entity");
	store.close();
}

describe("lifecycle sync — security boundary", () => {
	let dir: string;
	let dbPath: string;
	let configPath: string;
	let originalFetch: typeof fetch;
	let originalExitCode: number | string | null | undefined;
	let fetchCalls: unknown[][];
	let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;
	let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-sync-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		configPath = join(dir, "lifecycle.config.json");
		originalFetch = globalThis.fetch;
		originalExitCode = process.exitCode;
		// Bun quirk (verified empirically): `process.exitCode = undefined` does
		// NOT clear a previously-set numeric value — only assigning 0 does. Using
		// `undefined` here would leak a nonzero exitCode from an earlier test
		// file (alphabetically-prior test files run in the same process).
		process.exitCode = 0;
		fetchCalls = [];
		// Recorder that throws: any accidental call both fails loudly (a
		// swallowed throw inside drainOutbox/github.ts would otherwise just
		// look like a retryable delivery failure) AND is captured in
		// fetchCalls for a direct "zero calls" assertion either way.
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls.push(args);
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		process.exitCode = originalExitCode ?? 0;
		errorSpy.mockRestore();
		logSpy.mockRestore();
		stdoutSpy.mockRestore();
		delete process.env.AL_PERF_SYNC_TEST_DECOY;
		await rmSyncRetrying(dir);
	});

	// --config moved from a sync-level option to the lifecycle parent (Task 2 of
	// the telemetry-config-clienttype plan): it must precede the subcommand name.
	async function runSync(args: string[], config = configPath): Promise<void> {
		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(["--db", dbPath, "--config", config, ...args], {
			from: "user",
		});
	}

	it("--dry-run enqueues outbox rows, makes zero fetch calls, leaves them pending, exits 0", async () => {
		seedPendingDelivery(dbPath);
		writeFileSync(
			configPath,
			JSON.stringify({
				sinks: { github: { enabled: true, repo: "owner/repo" } },
			}),
		);

		await runSync(["sync", "--dry-run"]);

		expect(fetchCalls).toHaveLength(0);
		expect(process.exitCode ?? 0).toBe(0);

		const store = new LifecycleStore(dbPath);
		const pending = store.listPendingOutbox("github", "comment-regressed");
		expect(pending).toHaveLength(1);
		store.close();

		const summary = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(summary).toContain("(dry run)");
		// No dead-lettered rows exist — the section must not appear.
		expect(summary).not.toContain("Dead letters:");
	});

	it("text format prints a Dead letters: section listing lastError when a dead row exists", async () => {
		seedDeadLetter(dbPath);
		writeFileSync(
			configPath,
			JSON.stringify({
				sinks: { github: { enabled: true, repo: "owner/repo" } },
			}),
		);

		await runSync(["sync", "--dry-run"]);

		expect(fetchCalls).toHaveLength(0);
		const summary = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(summary).toContain("Dead letters:");
		expect(summary).toContain("422 Unprocessable Entity");
		expect(summary).not.toContain(DECOY_VALUE);
	});

	it("-f json output includes a deadLetters array with id/kind/dedupeKey/attempts/lastError, never payload", async () => {
		seedDeadLetter(dbPath);
		writeFileSync(
			configPath,
			JSON.stringify({
				sinks: { github: { enabled: true, repo: "owner/repo" } },
			}),
		);

		await runSync(["sync", "--dry-run", "-f", "json"]);

		expect(fetchCalls).toHaveLength(0);
		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const summary = JSON.parse(output);
		expect(summary.deadLetters).toHaveLength(1);
		const dl = summary.deadLetters[0];
		expect(Object.keys(dl).sort()).toEqual(
			["attempts", "dedupeKey", "id", "kind", "lastError"].sort(),
		);
		expect(dl.kind).toBe("create-issue");
		expect(dl.dedupeKey).toBe(`github:create:${TENANT}:${DEAD_FP}`);
		expect(dl.attempts).toBe(1);
		expect(dl.lastError).toBe("422 Unprocessable Entity");
		expect(output).not.toContain(DECOY_VALUE);
		expect(output).not.toContain("payload");
	});

	it("missing token env var: exits nonzero, names the env var but never leaks a value, no drain occurs, zero fetch calls", async () => {
		seedPendingDelivery(dbPath);
		// A decoy secret living under a DIFFERENT env var than the one the
		// config names — proves the error path doesn't dump process.env or
		// any other credential, not just the (genuinely absent) configured one.
		process.env.AL_PERF_SYNC_TEST_DECOY = DECOY_VALUE;
		writeFileSync(
			configPath,
			JSON.stringify({
				sinks: {
					github: {
						enabled: true,
						repo: "owner/repo",
						tokenEnv: "AL_PERF_SYNC_TEST_TOKEN_UNSET",
					},
				},
			}),
		);
		delete process.env.AL_PERF_SYNC_TEST_TOKEN_UNSET;

		await runSync(["sync"]);

		expect(fetchCalls).toHaveLength(0);
		expect(process.exitCode).toBe(1);

		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("AL_PERF_SYNC_TEST_TOKEN_UNSET");
		expect(errText).not.toContain(DECOY_VALUE);

		const store = new LifecycleStore(dbPath);
		const pending = store.listPendingOutbox("github", "comment-regressed");
		expect(pending).toHaveLength(1); // still pending — never drained
		store.close();
	});

	it("no sinks config file present: capture-request scan still runs, exits 0, json reports captureRequests.created", async () => {
		seedQualifyingTelemetryFinding(dbPath);
		// Deliberately no writeFileSync(configPath, ...) — the sinks config file
		// does not exist at all.

		await runSync(["sync", "-f", "json"]);

		expect(fetchCalls).toHaveLength(0);
		expect(process.exitCode ?? 0).toBe(0);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const summary = JSON.parse(output);
		expect(summary.captureRequests.created).toBe(1);

		const store = new LifecycleStore(dbPath);
		expect(store.listCaptureRequests(TENANT, "pending")).toHaveLength(1);
		store.close();
	});

	it("telemetry-only config file (no sinks key, per telemetry-recipe §10/§11): capture-request scan still runs, exits 0, delivery gracefully skipped", async () => {
		seedQualifyingTelemetryFinding(dbPath);
		// Exactly the file shape telemetry-recipe.md §10/§11 documents as legal
		// ("every block optional") — a config file that only tunes telemetry
		// severity, with no `sinks` key at all.
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					severity: {
						"RT0018@Background": { warningMs: 300000, criticalMs: 1800000 },
					},
				},
			}),
		);

		await runSync(["sync", "-f", "json"]);

		expect(fetchCalls).toHaveLength(0);
		expect(process.exitCode ?? 0).toBe(0);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const summary = JSON.parse(output);
		expect(summary.captureRequests.created).toBe(1);

		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("sink delivery skipped");

		const store = new LifecycleStore(dbPath);
		expect(store.listCaptureRequests(TENANT, "pending")).toHaveLength(1);
		store.close();
	});

	it("--dry-run still scans and creates a capture request (local DB state, not delivery)", async () => {
		seedQualifyingTelemetryFinding(dbPath);
		writeFileSync(
			configPath,
			JSON.stringify({
				sinks: { github: { enabled: true, repo: "owner/repo" } },
			}),
		);

		await runSync(["sync", "--dry-run", "-f", "json"]);

		expect(fetchCalls).toHaveLength(0);
		expect(process.exitCode ?? 0).toBe(0);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const summary = JSON.parse(output);
		expect(summary.captureRequests.created).toBe(1);

		const store = new LifecycleStore(dbPath);
		expect(store.listCaptureRequests(TENANT, "pending")).toHaveLength(1);
		store.close();
	});

	it("--config file lowering captureRequests.maxPending caps how many requests a scan creates (Task 2: config file reaches the trigger scan)", async () => {
		seedQualifyingTelemetryFinding(dbPath);
		seedQualifyingTelemetryFinding(dbPath, {
			fingerprint: "telemetry:sync000000000cap2",
			routineKey: "abc123|Codeunit|50100|postline",
		});
		writeFileSync(
			configPath,
			JSON.stringify({ captureRequests: { maxPending: 1 } }),
		);

		await runSync(["sync", "-f", "json"]);

		expect(fetchCalls).toHaveLength(0);
		expect(process.exitCode ?? 0).toBe(0);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const summary = JSON.parse(output);
		expect(summary.captureRequests.created).toBe(1);
		expect(summary.captureRequests.skippedMaxPending).toBe(1);

		const store = new LifecycleStore(dbPath);
		expect(store.listCaptureRequests(TENANT, "pending")).toHaveLength(1);
		store.close();
	});
});
