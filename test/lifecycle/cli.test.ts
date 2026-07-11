/**
 * cli.test.ts — lifecycle CLI: close guard (only from resolved), triage
 * toggling helper path, command registration. The evaluate/digest logic is
 * covered by evaluate.test.ts / digest.test.ts; here we test the CLI-owned
 * glue that isn't just commander wiring.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	applyClose,
	createLifecycleCommand,
	DEFAULT_DB_PATH,
} from "../../src/cli/commands/lifecycle.js";
import { DEFAULT_API_KEY_ENV } from "../../src/lifecycle/appinsights.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";

/**
 * Windows-only flake guard (same as sync-cli.test.ts): a WAL-mode sqlite
 * file's `-shm`/`-wal` mapping can stay transiently locked for a beat after
 * `.close()` returns, so `fs.rmSync`'s built-in retry doesn't paper over it
 * under Bun on Windows — retry by hand with a real await between tries.
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

function finding(state: NewFinding["state"]): NewFinding {
	return {
		tenant: "local",
		fingerprint: "pattern:cli0000000000001",
		algoVersion: 1,
		state,
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "x",
		severity: "warning",
		appId: "",
		appName: "",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-01T00:00:00Z",
		lastEventAt: "2026-07-01T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["adhoc"],
	};
}

describe("applyClose", () => {
	it("closes a resolved finding and logs the event", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(finding("resolved"));
		const res = applyClose(
			store,
			"local",
			"pattern:cli0000000000001",
			"2026-07-09T00:00:00Z",
		);
		expect(res.ok).toBe(true);
		expect(store.getFinding(id)?.state).toBe("closed");
		expect(store.getFinding(id)?.closedAt).toBe("2026-07-09T00:00:00Z");
		expect(store.listEvents(id).at(-1)?.event).toBe("closed");
		store.close();
	});

	it("refuses to close a non-resolved finding (spec: close is human confirmation of resolved)", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(finding("open"));
		const res = applyClose(
			store,
			"local",
			"pattern:cli0000000000001",
			"2026-07-09T00:00:00Z",
		);
		expect(res.ok).toBe(false);
		expect(res.message).toContain("resolved");
		store.close();
	});

	it("reports a missing fingerprint", () => {
		const store = new LifecycleStore(":memory:");
		const res = applyClose(
			store,
			"local",
			"pattern:nope",
			"2026-07-09T00:00:00Z",
		);
		expect(res.ok).toBe(false);
		expect(res.message).toContain("No active finding");
		store.close();
	});
});

describe("createLifecycleCommand", () => {
	it("registers the command group with all subcommands", () => {
		const cmd = createLifecycleCommand();
		expect(cmd.name()).toBe("lifecycle");
		const subs = cmd.commands.map((c) => c.name());
		for (const s of [
			"evaluate",
			"digest",
			"status",
			"close",
			"triage",
			"maintain",
			"sync",
			"telemetry",
			"pull-telemetry",
		]) {
			expect(subs).toContain(s);
		}
		expect(DEFAULT_DB_PATH).toBe(".al-perf/lifecycle.sqlite");
	});
});

// ---------------------------------------------------------------------------
// lifecycle telemetry (local batch evaluate) + lifecycle pull-telemetry
// (App Insights puller CLI) — telemetry-ingest plan Task 5.
// ---------------------------------------------------------------------------

const APP_ID = "11111111-2222-3333-4444-555555555555";
const PULL_DECOY_KEY = "super-secret-appinsights-cli-key-should-never-leak";

function telemetryBatchFixture() {
	return {
		schemaVersion: 1,
		payloadType: "telemetry-batch",
		windowStart: "2026-07-11T00:00:00.000Z",
		windowEnd: "2026-07-11T01:00:00.000Z",
		signals: [
			{
				signalId: "RT0018",
				appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				appName: "My App",
				objectType: "Codeunit",
				objectId: 50100,
				methodName: "ProcessLine",
				count: 3,
				maxDurationMs: 12_000,
				avgDurationMs: 9_500,
			},
		],
	};
}

function appInsightsResponse() {
	return {
		tables: [
			{
				name: "PrimaryTable",
				columns: [
					{ name: "appId", type: "string" },
					{ name: "appName", type: "string" },
					{ name: "objectType", type: "string" },
					{ name: "objectId", type: "long" },
					{ name: "objectName", type: "string" },
					{ name: "methodName", type: "string" },
					{ name: "count", type: "long" },
					{ name: "maxDurationMs", type: "real" },
					{ name: "avgDurationMs", type: "real" },
					{ name: "stackTrace", type: "string" },
				],
				rows: [
					[
						"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
						"My App",
						"Codeunit",
						50100,
						"Sales Post",
						"ProcessLine",
						3,
						12_000,
						9_500,
						"",
					],
				],
			},
		],
	};
}

describe("lifecycle telemetry (local batch evaluate)", () => {
	let dir: string;
	let dbPath: string;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-telemetry-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		logSpy = spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(async () => {
		logSpy.mockRestore();
		await rmSyncRetrying(dir);
	});

	it("evaluates a local batch file into the lifecycle DB and findings appear", async () => {
		const batchPath = join(dir, "batch.json");
		writeFileSync(batchPath, JSON.stringify(telemetryBatchFixture()));

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(["--db", dbPath, "telemetry", batchPath], {
			from: "user",
		});

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "local" });
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0].fingerprint).toMatch(/^telemetry:/);
		store.close();
	});
});

describe("lifecycle pull-telemetry — App Insights puller CLI", () => {
	let dir: string;
	let dbPath: string;
	let originalFetch: typeof fetch;
	let originalExitCode: number | string | null | undefined;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;
	let errorSpy: ReturnType<typeof spyOn<Console, "error">>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-pull-telemetry-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		originalFetch = globalThis.fetch;
		originalExitCode = process.exitCode;
		// Bun quirk (verified empirically): `process.exitCode = undefined` does
		// NOT clear a previously-set numeric value — only assigning 0 does. Using
		// `undefined` here would leak exitCode=1 from the "missing API key" test
		// into whichever test/file runs next.
		process.exitCode = 0;
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(async () => {
		globalThis.fetch = originalFetch;
		process.exitCode = originalExitCode ?? 0;
		logSpy.mockRestore();
		errorSpy.mockRestore();
		delete process.env[DEFAULT_API_KEY_ENV];
		delete process.env.AL_PERF_PULL_TEST_DECOY;
		await rmSyncRetrying(dir);
	});

	it("--out writes the normalized batch and never touches the DB", async () => {
		process.env[DEFAULT_API_KEY_ENV] = PULL_DECOY_KEY;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(appInsightsResponse()), {
				status: 200,
			})) as typeof fetch;
		const outPath = join(dir, "out-batch.json");

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--out",
				outPath,
			],
			{ from: "user" },
		);

		expect(existsSync(dbPath)).toBe(false);
		const written = JSON.parse(readFileSync(outPath, "utf8"));
		expect(written.payloadType).toBe("telemetry-batch");
		expect(written.signals).toHaveLength(1);
		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).not.toContain(PULL_DECOY_KEY);
	});

	it("no --out evaluates locally into the lifecycle DB and findings appear", async () => {
		process.env[DEFAULT_API_KEY_ENV] = PULL_DECOY_KEY;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(appInsightsResponse()), {
				status: 200,
			})) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
			],
			{ from: "user" },
		);

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "local" });
		expect(findings.length).toBeGreaterThan(0);
		store.close();

		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).not.toContain(PULL_DECOY_KEY);
	});

	it("missing API key env var: exits 1, names the env var, never leaks a decoy secret, zero fetch calls", async () => {
		delete process.env[DEFAULT_API_KEY_ENV];
		process.env.AL_PERF_PULL_TEST_DECOY = PULL_DECOY_KEY;
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls++;
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			["--db", dbPath, "pull-telemetry", "--app-id", APP_ID],
			{ from: "user" },
		);

		expect(fetchCalls).toBe(0);
		expect(process.exitCode).toBe(1);
		expect(existsSync(dbPath)).toBe(false);

		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain(DEFAULT_API_KEY_ENV);
		expect(errText).not.toContain(PULL_DECOY_KEY);
	});
});

// ---------------------------------------------------------------------------
// lifecycle captures — deep-capture request queue operator CLI
// (capture-requests plan Task 4). Operates on rows filed by
// processCaptureTriggers (Task 2) and closed by evaluateRun's fulfillment
// hook (Task 3); this suite only exercises list/claim/cancel plumbing.
// ---------------------------------------------------------------------------

function captureFinding(overrides?: Partial<NewFinding>): NewFinding {
	return {
		tenant: "t1",
		fingerprint: "telemetry:deadbeef00000001",
		algoVersion: 1,
		state: "open",
		source: "telemetry",
		patternId: "telemetry-rt0018",
		title: "RT0018: PostOrder (Codeunit 50100) slow",
		severity: "warning",
		appId: "abc123",
		appName: "My App",
		routineKey: "abc123|Codeunit|50100|postorder",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-05T00:00:00Z",
		lastEventAt: "2026-07-05T00:00:00Z",
		observedKinds: ["telemetry"],
		observedStreams: ["telemetry"],
		...overrides,
	};
}

/** Seed one pending capture request (with its own backing finding); returns its id. */
function seedCaptureRequest(
	store: LifecycleStore,
	overrides?: Partial<{
		tenant: string;
		fingerprint: string;
		appId: string;
		appName: string | null;
		objectType: string;
		objectId: number;
		methodName: string;
		reason: string;
		requestedAt: string;
		expiresAt: string;
	}>,
): number {
	const tenant = overrides?.tenant ?? "t1";
	const fingerprint = overrides?.fingerprint ?? "telemetry:deadbeef00000001";
	const findingId = store.insertFinding(
		captureFinding({ tenant, fingerprint }),
	);
	store.createCaptureRequest({
		tenant,
		fingerprint,
		findingId,
		appId: "abc123",
		appName: "My App",
		objectType: "Codeunit",
		objectId: 50100,
		methodName: "postorder",
		reason: "RT0018: 3 runs, severity warning",
		requestedAt: "2026-07-01T00:00:00Z",
		expiresAt: "2026-08-01T00:00:00Z",
		...overrides,
	});
	const row = store
		.listCaptureRequests(tenant, "pending")
		.find((r) => r.fingerprint === fingerprint);
	if (!row) throw new Error(`seedCaptureRequest: no pending row for ${fingerprint}`);
	return row.id;
}

describe("lifecycle captures", () => {
	let dir: string;
	let dbPath: string;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;
	let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
	let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>;
	let originalExitCode: number | string | null | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-captures-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		originalExitCode = process.exitCode;
		// Same Bun quirk as the other describe blocks in this file — assigning
		// undefined does not clear a prior nonzero exitCode.
		process.exitCode = 0;
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	});
	afterEach(async () => {
		process.exitCode = originalExitCode ?? 0;
		logSpy.mockRestore();
		errorSpy.mockRestore();
		stdoutSpy.mockRestore();
		await rmSyncRetrying(dir);
	});

	async function run(args: string[]): Promise<void> {
		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(["--db", dbPath, ...args], { from: "user" });
	}

	it("registers captures with list/claim/cancel subcommands", () => {
		const cmd = createLifecycleCommand();
		const captures = cmd.commands.find((c) => c.name() === "captures");
		expect(captures).toBeDefined();
		const subs = captures?.commands.map((c) => c.name()) ?? [];
		expect(subs).toEqual(expect.arrayContaining(["list", "claim", "cancel"]));
	});

	it("list (text) renders a seeded pending row like the status table", async () => {
		const store = new LifecycleStore(dbPath);
		seedCaptureRequest(store);
		store.close();

		await run(["captures", "list"]);

		const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(out).toContain("pending");
		expect(out).toContain("My App");
		expect(out).toContain("Codeunit");
		expect(out).toContain("50100");
		expect(out).toContain("postorder");
	});

	it("list -f json returns the raw CaptureRequestRow array with exact camelCase field names", async () => {
		const store = new LifecycleStore(dbPath);
		const id = seedCaptureRequest(store);
		store.close();

		await run(["captures", "list", "-f", "json"]);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const rows = JSON.parse(output);
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]).sort()).toEqual(
			[
				"id",
				"tenant",
				"fingerprint",
				"findingId",
				"appId",
				"appName",
				"objectType",
				"objectId",
				"methodName",
				"reason",
				"status",
				"requestedAt",
				"expiresAt",
				"claimedAt",
				"claimedBy",
				"fulfilledAt",
				"fulfilledByProfileId",
			].sort(),
		);
		expect(rows[0]).toMatchObject({
			id,
			tenant: "t1",
			status: "pending",
			appName: "My App",
			objectType: "Codeunit",
			objectId: 50100,
			methodName: "postorder",
		});
	});

	it("list --status filters to only the requested status", async () => {
		const store = new LifecycleStore(dbPath);
		const pendingId = seedCaptureRequest(store, {
			fingerprint: "telemetry:deadbeef00000002",
		});
		const cancelId = seedCaptureRequest(store, {
			fingerprint: "telemetry:deadbeef00000003",
		});
		store.cancelCaptureRequest(cancelId, "2026-07-02T00:00:00Z");
		store.close();

		await run(["captures", "list", "-f", "json", "--status", "pending"]);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const rows = JSON.parse(output);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(pendingId);
	});

	it("claim transitions a pending request to claimed and exits 0", async () => {
		const store = new LifecycleStore(dbPath);
		const id = seedCaptureRequest(store);
		store.close();

		await run(["captures", "claim", String(id), "--by", "agent-x"]);

		expect(process.exitCode ?? 0).toBe(0);
		const verify = new LifecycleStore(dbPath);
		const [row] = verify.listCaptureRequests();
		expect(row.status).toBe("claimed");
		expect(row.claimedBy).toBe("agent-x");
		verify.close();
	});

	it("claim on an already-fulfilled row exits 1 and names the current status", async () => {
		const store = new LifecycleStore(dbPath);
		const id = seedCaptureRequest(store);
		store.db.run(
			"UPDATE capture_requests SET status = 'fulfilled', fulfilled_at = ?, fulfilled_by_profile_id = ? WHERE id = ?",
			["2026-07-02T00:00:00Z", "p1", id],
		);
		store.close();

		await run(["captures", "claim", String(id), "--by", "agent-x"]);

		expect(process.exitCode).toBe(1);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain(String(id));
		expect(errText).toContain("fulfilled");
	});

	it("claim on an unknown id exits 1 and says so", async () => {
		await run(["captures", "claim", "999999", "--by", "agent-x"]);

		expect(process.exitCode).toBe(1);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("999999");
		expect(errText.toLowerCase()).toContain("no capture request");
	});

	it("cancel transitions a pending request to cancelled and exits 0", async () => {
		const store = new LifecycleStore(dbPath);
		const id = seedCaptureRequest(store);
		store.close();

		await run(["captures", "cancel", String(id)]);

		expect(process.exitCode ?? 0).toBe(0);
		const verify = new LifecycleStore(dbPath);
		const [row] = verify.listCaptureRequests();
		expect(row.status).toBe("cancelled");
		verify.close();
	});

	it("cancel on an already-cancelled row exits 1 and names the current status", async () => {
		const store = new LifecycleStore(dbPath);
		const id = seedCaptureRequest(store);
		store.cancelCaptureRequest(id, "2026-07-02T00:00:00Z");
		store.close();

		await run(["captures", "cancel", String(id)]);

		expect(process.exitCode).toBe(1);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain(String(id));
		expect(errText).toContain("cancelled");
	});

	it("cancel on an unknown id exits 1 and says so", async () => {
		await run(["captures", "cancel", "999999"]);

		expect(process.exitCode).toBe(1);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("999999");
		expect(errText.toLowerCase()).toContain("no capture request");
	});
});
