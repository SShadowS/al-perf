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

describe("lifecycle sync — security boundary", () => {
	let dir: string;
	let dbPath: string;
	let configPath: string;
	let originalFetch: typeof fetch;
	let originalExitCode: number | string | null | undefined;
	let fetchCalls: unknown[][];
	let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-sync-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		configPath = join(dir, "lifecycle.config.json");
		originalFetch = globalThis.fetch;
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
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
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		process.exitCode = originalExitCode;
		errorSpy.mockRestore();
		logSpy.mockRestore();
		delete process.env.AL_PERF_SYNC_TEST_DECOY;
		await rmSyncRetrying(dir);
	});

	async function runSync(args: string[]): Promise<void> {
		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(["--db", dbPath, ...args], { from: "user" });
	}

	it("--dry-run enqueues outbox rows, makes zero fetch calls, leaves them pending, exits 0", async () => {
		seedPendingDelivery(dbPath);
		writeFileSync(
			configPath,
			JSON.stringify({
				sinks: { github: { enabled: true, repo: "owner/repo" } },
			}),
		);

		await runSync(["sync", "--config", configPath, "--dry-run"]);

		expect(fetchCalls).toHaveLength(0);
		expect(process.exitCode ?? 0).toBe(0);

		const store = new LifecycleStore(dbPath);
		const pending = store.listPendingOutbox("github", "comment-regressed");
		expect(pending).toHaveLength(1);
		store.close();

		const summary = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(summary).toContain("(dry run)");
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

		await runSync(["sync", "--config", configPath]);

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
});
