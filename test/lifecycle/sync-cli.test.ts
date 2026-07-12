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

/**
 * Occupy a tenant's entire capture-request capacity with one active
 * (pending) request against its own finding — the "queue already full"
 * half of the starvation fixture. Paired with `maxPending: 1` in config and
 * one MORE qualifying finding (seedQualifyingTelemetryFinding), this
 * reproduces the exact state where an executor has died: nothing can be
 * created (already at cap) and nothing is due to expire (expiresAt is far in
 * the future), yet a qualifying finding is skipped every scan.
 */
const OCCUPANT_FP = "telemetry:sync000000000cap0";
function seedTenantAtCaptureCapacity(dbPath: string): void {
	const store = new LifecycleStore(dbPath);
	const findingId = store.insertFinding(
		finding({
			fingerprint: OCCUPANT_FP,
			source: "telemetry",
			patternId: "telemetry-rt0018",
			routineKey: "abc123|Codeunit|50100|postvoid",
		}),
	);
	store.createCaptureRequest({
		tenant: TENANT,
		fingerprint: OCCUPANT_FP,
		findingId,
		appId: "abc123",
		appName: null,
		objectType: "Codeunit",
		objectId: 50100,
		methodName: "postvoid",
		reason: "pre-seeded occupant filling maxPending cap",
		requestedAt: "2026-07-01T00:00:00Z",
		expiresAt: "2030-01-01T00:00:00Z",
	});
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

/**
 * Multi-sink variant of seedPendingDelivery: seeds ONE finding with an
 * existing issue mapping under EACH named sink, then logs a single
 * "seen-regressed" event. processEventsForSinks (Task 2's fan-out) evaluates
 * every enabled sink independently against its own mapping, so this enqueues
 * one comment-regressed row PER named sink — the minimal fixture that
 * exercises multi-sink drain without touching autoFile/hysteresis config.
 */
function seedPendingDeliveryForSinks(dbPath: string, sinks: string[]): void {
	const store = new LifecycleStore(dbPath);
	const id = store.insertFinding(finding());
	for (const sink of sinks) {
		store.putIssueMapping({
			tenant: TENANT,
			sink,
			fingerprint: FP,
			externalId: sink === "github" ? "42" : "1042",
			createdAt: "2026-07-01T00:00:00Z",
		});
	}
	store.logEvent({
		findingId: id,
		event: "seen-regressed",
		fromState: "open",
		toState: "regressed",
		at: "2026-07-05T00:00:00Z",
	});
	store.close();
}

/** A fetch mock that responds 200 with an empty JSON body to every call it sees. */
function okFetch(calls: unknown[][]): typeof fetch {
	return (async (...args: unknown[]) => {
		calls.push(args);
		return new Response(JSON.stringify({}), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

const ADO_CONFIG = {
	enabled: true,
	org: "myorg",
	project: "myproject",
	tokenEnv: "AL_PERF_SYNC_TEST_ADO_TOKEN",
};

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
		delete process.env.AL_PERF_SYNC_TEST_GH_TOKEN;
		delete process.env.AL_PERF_SYNC_TEST_ADO_TOKEN;
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

	it("sync warns when findings were skipped at the maxPending cap (the queue is jammed)", async () => {
		// Seed: tenant at maxPending with active requests, plus one MORE qualifying
		// finding that will be skipped. No new requests can be created and nothing
		// is due to expire — created == 0 && expired == 0 && skippedMaxPending > 0.
		seedTenantAtCaptureCapacity(dbPath);
		seedQualifyingTelemetryFinding(dbPath);
		writeFileSync(
			configPath,
			JSON.stringify({ captureRequests: { maxPending: 1 } }),
		);

		logSpy.mockClear();
		await runSync(["sync"]);

		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Capture requests:");
		expect(printed).toMatch(/NOT requested/i);
		expect(printed).toContain("maxPending");
		expect(printed).toContain("captures health");
	});

	describe("multi-sink fan-out (Task 4)", () => {
		it("both sinks configured with tokens present: both drain, JSON reports a per-sink drains array", async () => {
			seedPendingDeliveryForSinks(dbPath, ["github", "azureDevOps"]);
			process.env.AL_PERF_SYNC_TEST_GH_TOKEN = "gh-token";
			process.env.AL_PERF_SYNC_TEST_ADO_TOKEN = "ado-token";
			writeFileSync(
				configPath,
				JSON.stringify({
					sinks: {
						github: {
							enabled: true,
							repo: "owner/repo",
							tokenEnv: "AL_PERF_SYNC_TEST_GH_TOKEN",
						},
						azureDevOps: ADO_CONFIG,
					},
				}),
			);
			globalThis.fetch = okFetch(fetchCalls);

			await runSync(["sync", "-f", "json"]);

			expect(process.exitCode ?? 0).toBe(0);
			const ghCalls = fetchCalls.filter((c) =>
				String(c[0]).includes("api.github.com"),
			);
			const adoCalls = fetchCalls.filter((c) =>
				String(c[0]).includes("dev.azure.com"),
			);
			expect(ghCalls).toHaveLength(1);
			expect(adoCalls).toHaveLength(1);

			const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
			const summary = JSON.parse(output);
			expect(summary.drains).toHaveLength(2);
			const gh = summary.drains.find(
				(d: { sink: string }) => d.sink === "github",
			);
			const ado = summary.drains.find(
				(d: { sink: string }) => d.sink === "azureDevOps",
			);
			expect(gh).toEqual({
				sink: "github",
				delivered: 1,
				retried: 0,
				dead: 0,
				collapsed: 0,
			});
			expect(ado).toEqual({
				sink: "azureDevOps",
				delivered: 1,
				retried: 0,
				dead: 0,
				collapsed: 0,
			});
			expect(output).not.toContain("ado-token");
			expect(output).not.toContain("gh-token");

			const store = new LifecycleStore(dbPath);
			expect(
				store.listPendingOutbox("github", "comment-regressed"),
			).toHaveLength(0);
			expect(
				store.listPendingOutbox("azureDevOps", "comment-regressed"),
			).toHaveLength(0);
			store.close();
		});

		it("ADO token missing: ADO drain is skipped loudly (names AZDO env var), github still drains, other sink unaffected", async () => {
			seedPendingDeliveryForSinks(dbPath, ["github", "azureDevOps"]);
			process.env.AL_PERF_SYNC_TEST_GH_TOKEN = "gh-token";
			// Deliberately not setting AL_PERF_SYNC_TEST_ADO_TOKEN.
			delete process.env.AL_PERF_SYNC_TEST_ADO_TOKEN;
			writeFileSync(
				configPath,
				JSON.stringify({
					sinks: {
						github: {
							enabled: true,
							repo: "owner/repo",
							tokenEnv: "AL_PERF_SYNC_TEST_GH_TOKEN",
						},
						azureDevOps: ADO_CONFIG,
					},
				}),
			);
			globalThis.fetch = okFetch(fetchCalls);

			await runSync(["sync", "-f", "json"]);

			// One misconfigured sink is an operator error (exitCode 1), but it must
			// not have prevented the OTHER sink from draining.
			expect(process.exitCode).toBe(1);

			const ghCalls = fetchCalls.filter((c) =>
				String(c[0]).includes("api.github.com"),
			);
			const adoCalls = fetchCalls.filter((c) =>
				String(c[0]).includes("dev.azure.com"),
			);
			expect(ghCalls).toHaveLength(1);
			expect(adoCalls).toHaveLength(0);

			const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(errText).toContain("AL_PERF_SYNC_TEST_ADO_TOKEN");

			const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
			const summary = JSON.parse(output);
			expect(summary.drains).toHaveLength(1);
			expect(summary.drains[0]).toEqual({
				sink: "github",
				delivered: 1,
				retried: 0,
				dead: 0,
				collapsed: 0,
			});

			// The ADO row is still pending — never drained.
			const store = new LifecycleStore(dbPath);
			expect(
				store.listPendingOutbox("azureDevOps", "comment-regressed"),
			).toHaveLength(1);
			expect(
				store.listPendingOutbox("github", "comment-regressed"),
			).toHaveLength(0);
			store.close();
		});

		it("github token missing: github drain is skipped loudly (names github's token env var), ADO still drains fully, reaches the summary, exits 1", async () => {
			seedPendingDeliveryForSinks(dbPath, ["github", "azureDevOps"]);
			// Deliberately not setting AL_PERF_SYNC_TEST_GH_TOKEN.
			delete process.env.AL_PERF_SYNC_TEST_GH_TOKEN;
			process.env.AL_PERF_SYNC_TEST_ADO_TOKEN = "ado-token";
			writeFileSync(
				configPath,
				JSON.stringify({
					sinks: {
						github: {
							enabled: true,
							repo: "owner/repo",
							tokenEnv: "AL_PERF_SYNC_TEST_GH_TOKEN",
						},
						azureDevOps: ADO_CONFIG,
					},
				}),
			);
			globalThis.fetch = okFetch(fetchCalls);

			await runSync(["sync", "-f", "json"]);

			// The other sink's missing token is an operator error (exitCode 1),
			// but the command still reaches the summary and must not have
			// prevented azureDevOps from draining — the isolation is symmetric
			// regardless of which sink's token is absent or drain plan order.
			expect(process.exitCode).toBe(1);

			const ghCalls = fetchCalls.filter((c) =>
				String(c[0]).includes("api.github.com"),
			);
			const adoCalls = fetchCalls.filter((c) =>
				String(c[0]).includes("dev.azure.com"),
			);
			expect(ghCalls).toHaveLength(0);
			expect(adoCalls).toHaveLength(1);

			const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(errText).toContain("AL_PERF_SYNC_TEST_GH_TOKEN");

			const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
			const summary = JSON.parse(output);
			expect(summary.drains).toHaveLength(1);
			expect(summary.drains[0]).toEqual({
				sink: "azureDevOps",
				delivered: 1,
				retried: 0,
				dead: 0,
				collapsed: 0,
			});

			// The github row is still pending — never drained.
			const store = new LifecycleStore(dbPath);
			expect(
				store.listPendingOutbox("github", "comment-regressed"),
			).toHaveLength(1);
			expect(
				store.listPendingOutbox("azureDevOps", "comment-regressed"),
			).toHaveLength(0);
			store.close();
		});

		it("github-only config (back-compat): drains is a one-entry array for github, no azureDevOps entry", async () => {
			seedPendingDelivery(dbPath);
			process.env.AL_PERF_SYNC_TEST_GH_TOKEN = "gh-token";
			writeFileSync(
				configPath,
				JSON.stringify({
					sinks: {
						github: {
							enabled: true,
							repo: "owner/repo",
							tokenEnv: "AL_PERF_SYNC_TEST_GH_TOKEN",
						},
					},
				}),
			);
			globalThis.fetch = okFetch(fetchCalls);

			await runSync(["sync", "-f", "json"]);

			expect(process.exitCode ?? 0).toBe(0);
			const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
			const summary = JSON.parse(output);
			expect(summary.drains).toEqual([
				{ sink: "github", delivered: 1, retried: 0, dead: 0, collapsed: 0 },
			]);
		});

		it("--dry-run with both sinks configured: enqueues for both, drains nothing, zero fetch calls", async () => {
			seedPendingDeliveryForSinks(dbPath, ["github", "azureDevOps"]);
			process.env.AL_PERF_SYNC_TEST_GH_TOKEN = "gh-token";
			process.env.AL_PERF_SYNC_TEST_ADO_TOKEN = "ado-token";
			writeFileSync(
				configPath,
				JSON.stringify({
					sinks: {
						github: {
							enabled: true,
							repo: "owner/repo",
							tokenEnv: "AL_PERF_SYNC_TEST_GH_TOKEN",
						},
						azureDevOps: ADO_CONFIG,
					},
				}),
			);

			await runSync(["sync", "--dry-run", "-f", "json"]);

			expect(fetchCalls).toHaveLength(0);
			expect(process.exitCode ?? 0).toBe(0);

			const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
			const summary = JSON.parse(output);
			expect(summary.drains).toEqual([]);
			expect(summary.dryRun).toBe(true);

			const store = new LifecycleStore(dbPath);
			expect(
				store.listPendingOutbox("github", "comment-regressed"),
			).toHaveLength(1);
			expect(
				store.listPendingOutbox("azureDevOps", "comment-regressed"),
			).toHaveLength(1);
			store.close();
		});
	});
});
