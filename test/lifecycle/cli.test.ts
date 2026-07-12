/**
 * cli.test.ts — lifecycle CLI: close guard (only from resolved), triage
 * toggling helper path, command registration. The evaluate/digest logic is
 * covered by evaluate.test.ts / digest.test.ts; here we test the CLI-owned
 * glue that isn't just commander wiring.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	applyClose,
	createLifecycleCommand,
	DEFAULT_DB_PATH,
} from "../../src/cli/commands/lifecycle.js";
import { DEFAULT_API_KEY_ENV } from "../../src/lifecycle/appinsights.js";
import { FINGERPRINT_ALGO_VERSION } from "../../src/lifecycle/fingerprint.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";

/**
 * Fusion-branch fixtures (mirrors test/lifecycle/wire-fuse.integration.test.ts
 * — not imported from there since bun test files aren't modules other tests
 * should reach into). Drives `lifecycle evaluate --source`'s al-sem fusion
 * branch via the stub `alsem` binary in "findings" mode, which is purpose-built
 * to correlate with test/fixtures/sampling-minimal.alcpuprofile's hot frames
 * (ProcessLine / OnRun on Codeunit 50000).
 */
const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");
const STUB_TS = resolve(FIXTURE_DIR, "alsem-stub.ts");
const BUN_EXE = process.execPath;

let fusionCleanups: Array<() => void> = [];
afterEach(() => {
	for (const fn of fusionCleanups) {
		try {
			fn();
		} catch {
			// ignore
		}
	}
	fusionCleanups = [];
});

/** Platform-appropriate launcher for alsem-stub.ts in "findings" mode. */
function makeStubBinary(): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-cli-fuse-stub-"));
	fusionCleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
	if (process.platform === "win32") {
		const cmdPath = join(tmpDir, "alsem-stub.cmd");
		writeFileSync(
			cmdPath,
			`@echo off\r\nset "ALSEM_STUB_MODE=findings"\r\n"${BUN_EXE}" "${STUB_TS}" %*\r\n`,
		);
		return cmdPath;
	}
	const shPath = join(tmpDir, "alsem-stub.sh");
	writeFileSync(
		shPath,
		`#!/bin/sh\nexport ALSEM_STUB_MODE='findings'\nexec "${BUN_EXE}" "${STUB_TS}" "$@"\n`,
	);
	chmodSync(shPath, 0o755);
	return shPath;
}

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

// ---------------------------------------------------------------------------
// lifecycle --tenant normalization (debt-closure plan D1): `--tenant Pilot2`
// and `--tenant pilot2` used to create two case-distinct SQLite tenants that
// silently split a finding's history.
// ---------------------------------------------------------------------------

describe("lifecycle --tenant normalization", () => {
	let dir: string;
	let dbPath: string;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;
	let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
	let originalExitCode: number | string | null | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-tenant-norm-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		originalExitCode = process.exitCode;
		process.exitCode = 0;
	});
	afterEach(async () => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = originalExitCode ?? 0;
		await rmSyncRetrying(dir);
	});

	async function run(args: string[]): Promise<void> {
		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(["--db", dbPath, ...args], { from: "user" });
	}

	it("two --tenant casings land on one finding, not two", async () => {
		const batchPath = join(dir, "batch.json");
		writeFileSync(batchPath, JSON.stringify(telemetryBatchFixture()));

		await run([
			"telemetry",
			batchPath,
			"--tenant",
			"ACME",
			"--profile-id",
			"p1",
		]);
		await run([
			"telemetry",
			batchPath,
			"--tenant",
			"acme",
			"--profile-id",
			"p2",
		]);

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "acme" });
		expect(findings.length).toBe(1);
		expect(store.getActiveFinding("ACME", findings[0].fingerprint)).toBeNull();
		store.close();
	});

	it("existing lowercase --tenant invocations are byte-unchanged", async () => {
		const batchPath = join(dir, "batch.json");
		writeFileSync(batchPath, JSON.stringify(telemetryBatchFixture()));

		await run(["telemetry", batchPath, "--tenant", "local"]);

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "local" });
		expect(findings.length).toBe(1);
		store.close();
	});

	it("rejects a blank --tenant as a CLI usage error (exit 2)", async () => {
		await run(["status", "--tenant", "   "]);
		expect(process.exitCode).toBe(2);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("evaluate: two --tenant casings converge on one finding end-to-end (evaluateRun's internal normalization is a second line of defense)", async () => {
		// This pins the end-state only: evaluateRun normalizes the tenant itself,
		// so it passes even if resolveTenantOpt were stripped from the CLI
		// action. The "evaluate --source" fusion test below (which spies on
		// applyFingerprintMigration) is what actually guards the CLI boundary
		// for evaluate.
		await run([
			"evaluate",
			"test/fixtures/sampling-minimal.alcpuprofile",
			"--tenant",
			"ACME",
			"--profile-id",
			"p1",
			"--capture-time",
			"2026-07-01T00:00:00Z",
		]);
		await run([
			"evaluate",
			"test/fixtures/sampling-minimal.alcpuprofile",
			"--tenant",
			"acme",
			"--profile-id",
			"p2",
			"--capture-time",
			"2026-07-02T00:00:00Z",
		]);

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "acme" });
		expect(findings.length).toBeGreaterThan(0);
		// Every finding was seen twice — one row per problem, not two.
		for (const f of findings) {
			expect(store.countOccurrences(f.id)).toBe(2);
		}
		expect(store.listFindings({ tenant: "ACME" }).length).toBe(0);
		store.close();
	});

	it("evaluate --source: identity upgrades land in the normalized tenant", async () => {
		const stubBin = makeStubBinary();
		const prevBin = process.env.AL_SEM_BIN;
		process.env.AL_SEM_BIN = stubBin;
		const migrateSpy = spyOn(
			LifecycleStore.prototype,
			"applyFingerprintMigration",
		);
		try {
			await run([
				"evaluate",
				"test/fixtures/sampling-minimal.alcpuprofile",
				"--tenant",
				"ACME",
				"--source",
				WS_MIN,
				"--profile-id",
				"p1",
				"--capture-time",
				"2026-07-01T00:00:00Z",
			]);

			// Whatever fingerprint migrations the fusion branch applied, every one
			// of them must have been written under the NORMALIZED tenant. A raw
			// "ACME" here means applyIdentityUpgrades got the un-normalized value
			// and the finding will fork on the next run.
			expect(migrateSpy.mock.calls.length).toBeGreaterThan(0);
			for (const call of migrateSpy.mock.calls) {
				expect(call[0]).toBe("acme");
			}
		} finally {
			migrateSpy.mockRestore();
			if (prevBin === undefined) delete process.env.AL_SEM_BIN;
			else process.env.AL_SEM_BIN = prevBin;
		}

		const store = new LifecycleStore(dbPath);
		expect(store.listFindings({ tenant: "ACME" }).length).toBe(0);
		expect(store.listFindings({ tenant: "acme" }).length).toBeGreaterThan(0);
		store.close();
	});

	it("digest/status/close/triage resolve mixed-case --tenant to one bucket", async () => {
		const store = new LifecycleStore(dbPath);
		const fp = "pattern:0123456789abcdef";
		store.insertFinding({
			tenant: "acme",
			fingerprint: fp,
			algoVersion: 1,
			state: "resolved",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Seeded finding",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);
		store.close();

		// `digest` writes via process.stdout.write on both format branches (not
		// console.log), so it needs its own spy rather than the block's logSpy.
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
			() => true,
		);
		await run(["digest", "--tenant", "ACME", "-f", "json"]);
		const digestOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		stdoutSpy.mockRestore();
		const digest = JSON.parse(digestOutput);
		expect(digest.tenant).toBe("acme");
		expect(
			digest.resolved.map((f: { fingerprint: string }) => f.fingerprint),
		).toContain(fp);

		// `triage` is only legal against an active (non-closed) finding — the
		// seed above is resolved, so an uppercase --tenant that resolves
		// correctly will find it and flip needs-triage.
		await run(["triage", fp, "--tenant", "ACME"]);
		const midway = new LifecycleStore(dbPath);
		expect(midway.getActiveFinding("acme", fp)?.needsTriage).toBe(true);
		midway.close();

		// `close` is only legal from `resolved` — the seed above is resolved, so
		// an uppercase --tenant that resolves correctly will find and close it.
		await run(["close", fp, "--tenant", "ACME"]);

		const after = new LifecycleStore(dbPath);
		const row = after.listFindings({ tenant: "acme" })[0];
		expect(row.state).toBe("closed");
		after.close();
	});

	it("status with mixed-case --tenant reads the lowercase bucket", async () => {
		const store = new LifecycleStore(dbPath);
		store.insertFinding({
			tenant: "acme",
			fingerprint: "pattern:fedcba9876543210",
			algoVersion: 1,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Seeded open finding",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);
		store.close();

		// `-f json` writes via process.stdout.write, not console.log — it would
		// never reach logSpy, so this asserts on the plain-text (table) format,
		// which does route through console.log.
		logSpy.mockClear();
		await run(["status", "--tenant", "ACME"]);

		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Seeded open finding");
	});
});

// ---------------------------------------------------------------------------
// lifecycle --config (telemetry-config-clienttype plan Task 2): the parent
// --config flag threads mergeLifecycleConfig(DEFAULT, loadLifecycleConfigFile)
// into evaluate/telemetry/pull-telemetry/sync.
// ---------------------------------------------------------------------------

/** Same 2-node shape as sampling-minimal.alcpuprofile but with an alternating
 * samples[] array (self-time is derived from samples/timeDeltas, not the
 * hitCount field) so neither node exceeds detectSingleMethodDominance's >50%
 * threshold — same app/object identity so absence gating (appWasExercised)
 * still matches the finding created from sampling-minimal.alcpuprofile. */
function balancedSamplingProfile() {
	return {
		nodes: [
			{
				id: 1,
				callFrame: {
					functionName: "OnRun",
					scriptId: "CodeUnit_50000",
					url: "al-preview://allang/Codeunit/50000/Codeunit_50000.dal",
					lineNumber: 10,
					columnNumber: 8,
				},
				hitCount: 10,
				children: [2],
				declaringApplication: {
					appName: "My Extension",
					appPublisher: "Me",
					appVersion: "1.0.0.0",
				},
				applicationDefinition: {
					objectType: "CodeUnit",
					objectName: "My Processor",
					objectId: 50000,
				},
				frameIdentifier: 12345,
			},
			{
				id: 2,
				callFrame: {
					functionName: "ProcessLine",
					scriptId: "CodeUnit_50000",
					url: "al-preview://allang/Codeunit/50000/Codeunit_50000.dal",
					lineNumber: 25,
					columnNumber: 8,
				},
				hitCount: 10,
				children: [],
				declaringApplication: {
					appName: "My Extension",
					appPublisher: "Me",
					appVersion: "1.0.0.0",
				},
				applicationDefinition: {
					objectType: "CodeUnit",
					objectName: "My Processor",
					objectId: 50000,
				},
				frameIdentifier: 67890,
			},
		],
		startTime: 63793000000000000,
		endTime: 63793000000400000,
		samples: [1, 2, 1, 2],
		timeDeltas: [0, 100000, 100000, 100000],
		kind: 1,
	};
}

describe("lifecycle --config (config-file wiring)", () => {
	let dir: string;
	let dbPath: string;
	let configPath: string;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-config-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		configPath = join(dir, "lifecycle.config.json");
		logSpy = spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(async () => {
		logSpy.mockRestore();
		await rmSyncRetrying(dir);
	});

	it("telemetry: a --config file raising RT0018 thresholds downgrades a would-be-critical finding to warning", async () => {
		const batchPath = join(dir, "batch.json");
		const fixture = telemetryBatchFixture();
		// Default RT0018 thresholds (warningMs 10_000 / criticalMs 30_000): 35s
		// is critical. Raise both thresholds so 35s lands in the warning band.
		fixture.signals[0].maxDurationMs = 35_000;
		writeFileSync(batchPath, JSON.stringify(fixture));
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					severity: { RT0018: { warningMs: 20_000, criticalMs: 50_000 } },
				},
			}),
		);

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			["--db", dbPath, "--config", configPath, "telemetry", batchPath],
			{ from: "user" },
		);

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "local" });
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe("warning");
		store.close();
	});

	it("telemetry: without --config the same 35s signal is critical (control)", async () => {
		const batchPath = join(dir, "batch.json");
		const fixture = telemetryBatchFixture();
		fixture.signals[0].maxDurationMs = 35_000;
		writeFileSync(batchPath, JSON.stringify(fixture));

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(["--db", dbPath, "telemetry", batchPath], {
			from: "user",
		});

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "local" });
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe("critical");
		store.close();
	});

	it("evaluate: --resolve-after wins over the merged file config (which cannot set resolveAfterRuns at all)", async () => {
		// The file patch has no resolveAfterRuns field — this proves the CLI
		// flag still reaches evaluateRun after the merge, not that the file
		// itself sets resolveAfterRuns (it structurally can't, see
		// LifecycleConfigFilePatch). Unrelated field present so the file is
		// demonstrably loaded, not just ignored.
		writeFileSync(
			configPath,
			JSON.stringify({ captureRequests: { maxPending: 5 } }),
		);

		const fixtureBPath = join(dir, "balanced.alcpuprofile");
		writeFileSync(fixtureBPath, JSON.stringify(balancedSamplingProfile()));

		const cmd1 = createLifecycleCommand();
		cmd1.exitOverride();
		await cmd1.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"evaluate",
				"test/fixtures/sampling-minimal.alcpuprofile",
				"--resolve-after",
				"1",
				"--capture-time",
				"2026-07-01T00:00:00Z",
				"--stream",
				"cfgtest",
			],
			{ from: "user" },
		);

		const store1 = new LifecycleStore(dbPath);
		const before = store1
			.listFindings({ tenant: "local" })
			.find((f) => f.patternId === "single-method-dominance");
		expect(before?.state).toBe("new");
		store1.close();

		// Second run: the balanced profile reproduces no pattern at all, so the
		// single-method-dominance finding goes absent. With resolveAfterRuns=1
		// (from the flag — default is 3) a single absent run resolves it.
		const cmd2 = createLifecycleCommand();
		cmd2.exitOverride();
		await cmd2.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"evaluate",
				fixtureBPath,
				"--resolve-after",
				"1",
				"--capture-time",
				"2026-07-02T00:00:00Z",
				"--stream",
				"cfgtest",
			],
			{ from: "user" },
		);

		const store2 = new LifecycleStore(dbPath);
		const after = store2
			.listFindings({ tenant: "local" })
			.find((f) => f.patternId === "single-method-dominance");
		expect(after?.state).toBe("resolved");
		store2.close();
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

	it("--client-types splices a comma-separated list into the KQL filter clause", async () => {
		process.env[DEFAULT_API_KEY_ENV] = PULL_DECOY_KEY;
		const calls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			calls.push(url);
			return new Response(JSON.stringify(appInsightsResponse()), {
				status: 200,
			});
		}) as typeof fetch;

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
				"--client-types",
				"Background,WebClient",
			],
			{ from: "user" },
		);

		expect(calls).toHaveLength(1);
		const decoded = decodeURIComponent(calls[0]);
		expect(decoded).toContain(
			'| where clientType in ("Background", "WebClient")',
		);
	});

	it("an invalid --client-types value exits 1 with zero fetch calls (usage error, same posture as an invalid signal id)", async () => {
		process.env[DEFAULT_API_KEY_ENV] = PULL_DECOY_KEY;
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls++;
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--client-types",
				"Background;drop",
			],
			{ from: "user" },
		);

		expect(fetchCalls).toBe(0);
		expect(process.exitCode).toBe(1);
		expect(existsSync(dbPath)).toBe(false);

		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("client-types");
	});
});

// ---------------------------------------------------------------------------
// lifecycle pull-telemetry --split-by-customer (telemetry-multitenant plan,
// Task 3): fans one pull into one batch per (aadTenantId, environmentName)
// group via pullTelemetrySplit (Task 2), then either evaluates N batches or
// writes N --out files.
// ---------------------------------------------------------------------------

const SPLIT_GUID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SPLIT_GUID_B = "bbbbbbbb-1111-2222-3333-444444444444";

function splitRow(overrides: {
	aadTenantId?: string;
	environmentName?: string;
	methodName?: string;
	/** Override to a non-integer to produce a row that fails telemetry-batch
	 * validation (requireInteger) — used to test per-group failure isolation
	 * without monkey-patching evaluateTelemetryBatch itself. */
	objectId?: number;
}) {
	return [
		"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", // appId
		"My App", // appName
		"Codeunit", // objectType
		overrides.objectId ?? 50100, // objectId
		"Sales Post", // objectName
		overrides.methodName ?? "ProcessLine", // methodName
		3, // count
		12_000, // maxDurationMs
		9_500, // avgDurationMs
		"", // stackTrace
		overrides.aadTenantId ?? "",
		overrides.environmentName ?? "",
	];
}

function appInsightsSplitResponse(rows: unknown[][]) {
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
					{ name: "aadTenantId", type: "string" },
					{ name: "environmentName", type: "string" },
				],
				rows,
			},
		],
	};
}

describe("lifecycle pull-telemetry --split-by-customer", () => {
	let dir: string;
	let dbPath: string;
	let configPath: string;
	let originalFetch: typeof fetch;
	let originalExitCode: number | string | null | undefined;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;
	let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
	let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-pull-split-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		configPath = join(dir, "lifecycle.config.json");
		originalFetch = globalThis.fetch;
		originalExitCode = process.exitCode;
		process.exitCode = 0;
		process.env[DEFAULT_API_KEY_ENV] = PULL_DECOY_KEY;
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	});
	afterEach(async () => {
		globalThis.fetch = originalFetch;
		process.exitCode = originalExitCode ?? 0;
		logSpy.mockRestore();
		errorSpy.mockRestore();
		stdoutSpy.mockRestore();
		delete process.env[DEFAULT_API_KEY_ENV];
		await rmSyncRetrying(dir);
	});

	it("without a tenantMap or fleet policy: exit 2, names both outs, zero fetches", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls++;
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--split-by-customer",
			],
			{ from: "user" },
		);

		expect(fetchCalls).toBe(0);
		expect(process.exitCode).toBe(2);
		expect(existsSync(dbPath)).toBe(false);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("tenantMap");
		expect(errText).toContain("fleet");
	});

	it("evaluate mode fans out one group per mapped (tenant, stream) into separate DB tenants, and reports skipped tenants with '(none)' for an empty aadTenantId", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					tenantMap: {
						[SPLIT_GUID_A]: "acme-inc",
						[SPLIT_GUID_B]: "widgets-co",
					},
				},
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production" }),
			splitRow({ aadTenantId: SPLIT_GUID_B, environmentName: "Sandbox" }),
			splitRow({ aadTenantId: "", environmentName: "OnPrem" }),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
			],
			{ from: "user" },
		);

		const store = new LifecycleStore(dbPath);
		const acmeFindings = store.listFindings({ tenant: "acme-inc" });
		const widgetsFindings = store.listFindings({ tenant: "widgets-co" });
		expect(acmeFindings.length).toBeGreaterThan(0);
		expect(widgetsFindings.length).toBeGreaterThan(0);
		expect(acmeFindings[0].observedStreams).toContain("Production");
		expect(widgetsFindings[0].observedStreams).toContain("Sandbox");
		store.close();

		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain("acme-inc/Production:");
		expect(output).toContain("widgets-co/Sandbox:");
		expect(output).toContain("(none)");
		expect(output).not.toContain(PULL_DECOY_KEY);
	});

	it("json evaluate output keeps the raw empty aadTenantId in skippedTenants (only text substitutes '(none)')", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: { tenantMap: { [SPLIT_GUID_A]: "acme-inc" } },
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production" }),
			splitRow({ aadTenantId: "", environmentName: "OnPrem" }),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
				"-f",
				"json",
			],
			{ from: "user" },
		);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const parsed = JSON.parse(output);
		expect(parsed.groups).toHaveLength(1);
		expect(parsed.groups[0]).toMatchObject({
			tenant: "acme-inc",
			stream: "Production",
			aadTenantId: SPLIT_GUID_A,
			environmentName: "Production",
		});
		expect(parsed.skippedTenants).toEqual([
			{ aadTenantId: "", signalCount: 1 },
		]);
	});

	it("--out writes one suffixed file per group with the stream sanitized, and never touches the DB", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					tenantMap: {
						[SPLIT_GUID_A]: "acme-inc",
						[SPLIT_GUID_B]: "widgets-co",
					},
				},
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production/EU" }),
			splitRow({ aadTenantId: SPLIT_GUID_B, environmentName: "Sandbox" }),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;
		const outPath = join(dir, "out-batch.json");

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
				"--out",
				outPath,
			],
			{ from: "user" },
		);

		expect(existsSync(dbPath)).toBe(false);
		const acmePath = join(dir, "out-batch.acme-inc.Production_EU.json");
		const widgetsPath = join(dir, "out-batch.widgets-co.Sandbox.json");
		expect(existsSync(acmePath)).toBe(true);
		expect(existsSync(widgetsPath)).toBe(true);
		const acmeWritten = JSON.parse(readFileSync(acmePath, "utf8"));
		expect(acmeWritten.payloadType).toBe("telemetry-batch");
		expect(acmeWritten.signals).toHaveLength(1);

		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain(acmePath);
		expect(output).toContain(widgetsPath);
	});

	const SPLIT_GUID_C = "cccccccc-1111-2222-3333-444444444444";

	it("evaluate mode isolates a failing group: earlier/later groups still evaluate, the failure is reported, exit code 1", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					tenantMap: {
						[SPLIT_GUID_A]: "acme-inc",
						[SPLIT_GUID_B]: "widgets-co",
						[SPLIT_GUID_C]: "carco",
					},
				},
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production" }),
			// Poison row: a non-integer objectId fails telemetry-batch validation
			// (requireInteger) inside evaluateTelemetryBatch, AFTER pullTelemetrySplit
			// has already normalized it into a batch — this group must not block
			// the groups around it.
			splitRow({
				aadTenantId: SPLIT_GUID_B,
				environmentName: "Staging",
				objectId: 50100.5,
			}),
			splitRow({ aadTenantId: SPLIT_GUID_C, environmentName: "Production" }),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
			],
			{ from: "user" },
		);

		const store = new LifecycleStore(dbPath);
		expect(store.listFindings({ tenant: "acme-inc" }).length).toBeGreaterThan(
			0,
		);
		expect(store.listFindings({ tenant: "carco" }).length).toBeGreaterThan(0);
		expect(store.listFindings({ tenant: "widgets-co" })).toHaveLength(0);
		store.close();

		expect(process.exitCode).toBe(1);
		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain("acme-inc/Production:");
		expect(output).toContain("carco/Production:");
		expect(output).toContain("widgets-co/Staging: failed");
		expect(output).toContain("objectId");
	});

	it("json evaluate output reports a failing group in failedGroups without dropping the successful ones", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					tenantMap: {
						[SPLIT_GUID_A]: "acme-inc",
						[SPLIT_GUID_B]: "widgets-co",
					},
				},
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production" }),
			splitRow({
				aadTenantId: SPLIT_GUID_B,
				environmentName: "Staging",
				objectId: 50100.5,
			}),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
				"-f",
				"json",
			],
			{ from: "user" },
		);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const parsed = JSON.parse(output);
		expect(parsed.groups).toHaveLength(1);
		expect(parsed.groups[0]).toMatchObject({
			tenant: "acme-inc",
			stream: "Production",
		});
		expect(parsed.failedGroups).toHaveLength(1);
		expect(parsed.failedGroups[0].tenant).toBe("widgets-co");
		expect(parsed.failedGroups[0].stream).toBe("Staging");
		expect(parsed.failedGroups[0].error).toContain("objectId");
		expect(process.exitCode).toBe(1);
	});

	it("unmappedTenantPolicy fleet: unmapped rows evaluate under --tenant, stream stays per-environment (happy path)", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: { tenantMap: {}, unmappedTenantPolicy: "fleet" },
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production" }),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
				"--tenant",
				"fleetco",
			],
			{ from: "user" },
		);

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "fleetco" });
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0].observedStreams).toContain("Production");
		store.close();

		expect(process.exitCode ?? 0).toBe(0);
		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain("fleetco/Production:");
	});

	it("--out + split-by-customer: an invalid --tenant value is a usage error naming the value, zero fetches", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls++;
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;
		writeFileSync(
			configPath,
			JSON.stringify({ telemetry: { unmappedTenantPolicy: "fleet" } }),
		);
		const outPath = join(dir, "out-batch.json");

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--split-by-customer",
				"--out",
				outPath,
				"--tenant",
				"bad tenant!",
			],
			{ from: "user" },
		);

		expect(fetchCalls).toBe(0);
		expect(process.exitCode).toBe(2);
		expect(existsSync(outPath)).toBe(false);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("bad tenant!");
	});

	it("--out sanitized-stream filename collisions get -2/-3 suffixes instead of a silent overwrite", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: { tenantMap: { [SPLIT_GUID_A]: "acme-inc" } },
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Prod/EU" }),
			splitRow({
				aadTenantId: SPLIT_GUID_A,
				environmentName: "Prod_EU",
				methodName: "OtherMethod",
			}),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;
		const outPath = join(dir, "out-batch.json");

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
				"--out",
				outPath,
			],
			{ from: "user" },
		);

		const firstPath = join(dir, "out-batch.acme-inc.Prod_EU.json");
		const secondPath = join(dir, "out-batch.acme-inc.Prod_EU-2.json");
		expect(existsSync(firstPath)).toBe(true);
		expect(existsSync(secondPath)).toBe(true);
		const firstWritten = JSON.parse(readFileSync(firstPath, "utf8"));
		const secondWritten = JSON.parse(readFileSync(secondPath, "utf8"));
		expect(firstWritten.signals[0].methodName).toBe("ProcessLine");
		expect(secondWritten.signals[0].methodName).toBe("OtherMethod");

		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain(firstPath);
		expect(output).toContain(secondPath);
	});

	it("evaluate mode: identical-content groups under the same tenant but different streams get distinct profileIds (no false duplicate-run)", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: { tenantMap: { [SPLIT_GUID_A]: "acme-inc" } },
			}),
		);
		// Same mapped tenant, two different environments, byte-identical signal
		// content — the store's duplicate-run guard keys off (tenant, profileId)
		// alone (no stream column in that UNIQUE constraint), so hashing the
		// batch alone would make these two groups collide.
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production" }),
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Sandbox" }),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
			],
			{ from: "user" },
		);

		const store = new LifecycleStore(dbPath);
		const runs = store.db
			.query<{ stream: string }, [string]>(
				"SELECT stream FROM runs WHERE tenant = ?",
			)
			.all("acme-inc");
		store.close();
		// A false duplicate-run collision would leave only one run row.
		expect(runs).toHaveLength(2);
		expect(runs.map((r) => r.stream).sort()).toEqual(["Production", "Sandbox"]);

		expect(process.exitCode ?? 0).toBe(0);
		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain("acme-inc/Production:");
		expect(output).toContain("acme-inc/Sandbox:");
		expect(output).not.toContain("duplicate-run");
	});

	it("--stream and --profile-id print a one-line stderr warning each under --split-by-customer, and the derived values win", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: { tenantMap: { [SPLIT_GUID_A]: "acme-inc" } },
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production" }),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
				"--stream",
				"custom-stream",
				"--profile-id",
				"custom-id",
			],
			{ from: "user" },
		);

		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("--stream is ignored");
		expect(errText).toContain("--profile-id is ignored");

		const store = new LifecycleStore(dbPath);
		const findings = store.listFindings({ tenant: "acme-inc" });
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0].observedStreams).toContain("Production");
		expect(findings[0].observedStreams).not.toContain("custom-stream");
		store.close();
	});

	it("no warning prints when --stream/--profile-id are left at their defaults under --split-by-customer", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: { tenantMap: { [SPLIT_GUID_A]: "acme-inc" } },
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production" }),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
			],
			{ from: "user" },
		);

		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).not.toContain("is ignored");
	});

	it("--out lowercases --tenant before filename embedding: a fleet-bucketed 'Acme-Inc' and a mapped 'acme-inc' group on the same stream don't collide", async () => {
		const UNMAPPED_GUID = "dddddddd-1111-2222-3333-444444444444";
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					tenantMap: { [SPLIT_GUID_A]: "acme-inc" },
					unmappedTenantPolicy: "fleet",
				},
			}),
		);
		const response = appInsightsSplitResponse([
			splitRow({ aadTenantId: SPLIT_GUID_A, environmentName: "Production" }),
			splitRow({
				aadTenantId: UNMAPPED_GUID,
				environmentName: "Production",
				methodName: "FleetMethod",
			}),
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;
		const outPath = join(dir, "out-batch.json");

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--signals",
				"RT0018",
				"--split-by-customer",
				"--out",
				outPath,
				"--tenant",
				"Acme-Inc",
			],
			{ from: "user" },
		);

		const firstPath = join(dir, "out-batch.acme-inc.Production.json");
		const secondPath = join(dir, "out-batch.acme-inc.Production-2.json");
		expect(existsSync(firstPath)).toBe(true);
		expect(existsSync(secondPath)).toBe(true);
		const firstWritten = JSON.parse(readFileSync(firstPath, "utf8"));
		const secondWritten = JSON.parse(readFileSync(secondPath, "utf8"));
		const methodNames = [
			firstWritten.signals[0].methodName,
			secondWritten.signals[0].methodName,
		].sort();
		expect(methodNames).toEqual(["FleetMethod", "ProcessLine"]);
	});
});

// ---------------------------------------------------------------------------
// lifecycle pull-telemetry --list-tenants (list-tenants plan, Task 1):
// discovery mode for --split-by-customer onboarding — prints the AAD
// tenants emitting the requested signals plus a paste-ready tenantMap stub,
// instead of evaluating or writing anything.
// ---------------------------------------------------------------------------

function listTenantsAppInsightsResponse(rows: unknown[][]) {
	return {
		tables: [
			{
				name: "PrimaryTable",
				columns: [
					{ name: "aadTenantId", type: "string" },
					{ name: "rows", type: "long" },
					{ name: "environments", type: "dynamic" },
				],
				rows,
			},
		],
	};
}

describe("lifecycle pull-telemetry --list-tenants", () => {
	let dir: string;
	let dbPath: string;
	let configPath: string;
	let originalFetch: typeof fetch;
	let originalExitCode: number | string | null | undefined;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;
	let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
	let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>;

	const GUID_MAPPED = "aaaaaaaa-1111-2222-3333-444444444444";
	const GUID_UNMAPPED = "bbbbbbbb-1111-2222-3333-444444444444";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-pull-list-tenants-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		configPath = join(dir, "lifecycle.config.json");
		originalFetch = globalThis.fetch;
		originalExitCode = process.exitCode;
		process.exitCode = 0;
		process.env[DEFAULT_API_KEY_ENV] = PULL_DECOY_KEY;
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	});
	afterEach(async () => {
		globalThis.fetch = originalFetch;
		process.exitCode = originalExitCode ?? 0;
		logSpy.mockRestore();
		errorSpy.mockRestore();
		stdoutSpy.mockRestore();
		delete process.env[DEFAULT_API_KEY_ENV];
		await rmSyncRetrying(dir);
	});

	it("text: renders the table ((none) for empty id, mapped code vs (unmapped) — D4 lowercase lookup) and a valid-JSON stub AFTER the table with only unmapped GUID-shaped ids", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: { tenantMap: { [GUID_MAPPED.toUpperCase()]: "acme-inc" } },
			}),
		);
		const response = listTenantsAppInsightsResponse([
			[GUID_MAPPED, 5, JSON.stringify(["Production"])],
			[GUID_UNMAPPED, 2, JSON.stringify(["Sandbox"])],
			["", 1, JSON.stringify([""])],
			["common", 3, JSON.stringify(["Sandbox"])],
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--list-tenants",
			],
			{ from: "user" },
		);

		expect(process.exitCode ?? 0).toBe(0);
		expect(existsSync(dbPath)).toBe(false);

		// Last console.log call is the stub — everything before it is the table.
		const stubText = String(logSpy.mock.calls.at(-1)?.[0]);
		const tableText = logSpy.mock.calls
			.slice(0, -1)
			.map((c) => String(c[0]))
			.join("\n");

		expect(tableText).toContain("(none)");
		expect(tableText).toContain("acme-inc");
		expect(tableText).toContain("(unmapped)");
		expect(tableText).toContain(GUID_UNMAPPED);
		expect(tableText).toContain("common");

		const stub = JSON.parse(stubText);
		expect(stub).toEqual({
			telemetry: { tenantMap: { [GUID_UNMAPPED]: "" } },
		});

		const fullOutput = tableText + "\n" + stubText;
		expect(fullOutput).not.toContain(PULL_DECOY_KEY);
	});

	it("json: exact shape { tenants (each with mappedTo), tenantMapStub }", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: { tenantMap: { [GUID_MAPPED]: "acme-inc" } },
			}),
		);
		const response = listTenantsAppInsightsResponse([
			[GUID_MAPPED, 5, JSON.stringify(["Production"])],
			[GUID_UNMAPPED, 2, JSON.stringify(["Sandbox"])],
		]);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"--config",
				configPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--list-tenants",
				"-f",
				"json",
			],
			{ from: "user" },
		);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const parsed = JSON.parse(output);
		expect(parsed).toEqual({
			tenants: [
				{
					aadTenantId: GUID_MAPPED,
					rows: 5,
					environments: ["Production"],
					mappedTo: "acme-inc",
				},
				{
					aadTenantId: GUID_UNMAPPED,
					rows: 2,
					environments: ["Sandbox"],
					mappedTo: null,
				},
			],
			tenantMapStub: { telemetry: { tenantMap: { [GUID_UNMAPPED]: "" } } },
		});
	});

	it("missing API key env var: exits 1, names the env var, zero fetches, never touches the DB", async () => {
		delete process.env[DEFAULT_API_KEY_ENV];
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls++;
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			["--db", dbPath, "pull-telemetry", "--app-id", APP_ID, "--list-tenants"],
			{ from: "user" },
		);

		expect(fetchCalls).toBe(0);
		expect(process.exitCode).toBe(1);
		expect(existsSync(dbPath)).toBe(false);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain(DEFAULT_API_KEY_ENV);
		expect(errText).not.toContain(PULL_DECOY_KEY);
	});

	it("--list-tenants + --split-by-customer: exit 2, zero fetches, names the conflict", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls++;
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--list-tenants",
				"--split-by-customer",
			],
			{ from: "user" },
		);

		expect(fetchCalls).toBe(0);
		expect(process.exitCode).toBe(2);
		expect(existsSync(dbPath)).toBe(false);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("--split-by-customer");
	});

	it("--list-tenants + --out: exit 2, zero fetches, names the conflict, never writes the file", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls++;
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;
		const outPath = join(dir, "out.json");

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--list-tenants",
				"--out",
				outPath,
			],
			{ from: "user" },
		);

		expect(fetchCalls).toBe(0);
		expect(process.exitCode).toBe(2);
		expect(existsSync(outPath)).toBe(false);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("--out");
	});

	it("--list-tenants + --stream (explicit): exit 2, zero fetches, names the conflict", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls++;
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--list-tenants",
				"--stream",
				"custom-stream",
			],
			{ from: "user" },
		);

		expect(fetchCalls).toBe(0);
		expect(process.exitCode).toBe(2);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("--stream");
	});

	it("--list-tenants + --profile-id (explicit): exit 2, zero fetches, names the conflict", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async (...args: unknown[]) => {
			fetchCalls++;
			throw new Error(`unexpected fetch call: ${JSON.stringify(args[0])}`);
		}) as typeof fetch;

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"pull-telemetry",
				"--app-id",
				APP_ID,
				"--list-tenants",
				"--profile-id",
				"custom-id",
			],
			{ from: "user" },
		);

		expect(fetchCalls).toBe(0);
		expect(process.exitCode).toBe(2);
		const errText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errText).toContain("--profile-id");
	});
});

// ---------------------------------------------------------------------------
// lifecycle status -f json — triage note surfacing (agent-triage plan Task 1,
// D6): triageNote/triagedAt/triagedBy appear ONLY once a finding has been
// triaged (recordTriage clears needs_triage in the same write, so an
// untriaged row must show none of the three keys — not even null).
// ---------------------------------------------------------------------------

function statusFinding(overrides?: Partial<NewFinding>): NewFinding {
	return {
		tenant: "local",
		fingerprint: "pattern:statuscli000001",
		algoVersion: 1,
		state: "open",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "CalcFields inside loop",
		severity: "warning",
		appId: "",
		appName: "",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-01T00:00:00Z",
		lastEventAt: "2026-07-01T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
		...overrides,
	};
}

describe("lifecycle status -f json", () => {
	let dir: string;
	let dbPath: string;
	let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>;
	let originalExitCode: number | string | null | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-status-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		originalExitCode = process.exitCode;
		process.exitCode = 0;
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	});
	afterEach(async () => {
		process.exitCode = originalExitCode ?? 0;
		stdoutSpy.mockRestore();
		await rmSyncRetrying(dir);
	});

	async function run(args: string[]): Promise<void> {
		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(["--db", dbPath, ...args], { from: "user" });
	}

	it("omits triageNote/triagedAt/triagedBy entirely for an untriaged finding", async () => {
		const store = new LifecycleStore(dbPath);
		store.insertFinding(statusFinding({ needsTriage: true }));
		store.close();

		await run(["status", "-f", "json"]);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const rows = JSON.parse(output);
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toHaveProperty("triageNote");
		expect(rows[0]).not.toHaveProperty("triagedAt");
		expect(rows[0]).not.toHaveProperty("triagedBy");
	});

	it("includes triageNote/triagedAt/triagedBy once the finding has been triaged", async () => {
		const store = new LifecycleStore(dbPath);
		const id = store.insertFinding(statusFinding({ needsTriage: true }));
		store.recordTriage(
			id,
			"benign — scheduled batch job",
			"agent-triage v1",
			"2026-07-12T09:00:00Z",
		);
		store.close();

		await run(["status", "-f", "json"]);

		const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const rows = JSON.parse(output);
		expect(rows).toHaveLength(1);
		expect(rows[0].triageNote).toBe("benign — scheduled batch job");
		expect(rows[0].triagedBy).toBe("agent-triage v1");
		expect(rows[0].triagedAt).toBe("2026-07-12T09:00:00Z");
		expect(rows[0].needsTriage).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// lifecycle status — stale-algo guard visibility (Task 3): an operator
// querying a tenant blocked by the guard must be warned, naming the count,
// versions, and remedy command. Table format prints the banner above the
// table via console.log; json format must keep stdout a bare parseable
// array (piping `-f json | jq` must keep working) with the warning routed
// to stderr instead.
// ---------------------------------------------------------------------------

function staleStatusFinding(tenant: string): NewFinding {
	return {
		tenant,
		fingerprint: "pattern:stalestatuscli0001",
		algoVersion: FINGERPRINT_ALGO_VERSION + 1,
		state: "open",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "Stale finding",
		severity: "critical",
		appId: "",
		appName: "",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-01T00:00:00Z",
		lastEventAt: "2026-07-01T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
	};
}

describe("lifecycle status — stale-algo guard visibility", () => {
	let dir: string;
	let dbPath: string;
	let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>;
	let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, "write">>;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-status-stale-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
		logSpy = spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(async () => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		logSpy.mockRestore();
		await rmSyncRetrying(dir);
	});

	async function run(args: string[]): Promise<void> {
		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(["--db", dbPath, ...args], { from: "user" });
	}

	it("--format table: prints a warning banner above the table naming count, versions, and the remedy", async () => {
		const store = new LifecycleStore(dbPath);
		store.insertFinding(staleStatusFinding("acme"));
		store.close();

		await run(["status", "--tenant", "acme"]);

		const calls = logSpy.mock.calls.map((c) => String(c[0]));
		const printed = calls.join("\n");
		expect(printed).toContain("acme");
		expect(printed).toContain(`v${FINGERPRINT_ALGO_VERSION + 1}`);
		expect(printed).toContain(
			`lifecycle maintain --purge-stale-fingerprints --tenant acme`,
		);
		// Pin "above the table" (the test's own claim): the banner call must
		// precede the table's console.log call, not just land somewhere in the
		// combined output. table format never touches process.stdout directly
		// (both banner and table go through console.log), so a stdout-call-count
		// assertion here would hold even if the banner were dropped entirely —
		// this ordering check on the console.log capture is what actually fails
		// if the banner is misrouted or omitted.
		const bannerIndex = calls.findIndex((c) => c.includes("acme"));
		const tableIndex = calls.findIndex((c) => c.includes("Stale finding"));
		expect(bannerIndex).toBeGreaterThanOrEqual(0);
		expect(tableIndex).toBeGreaterThan(bannerIndex);
	});

	it("--format json: warning goes to stderr; stdout stays a bare parseable JSON array", async () => {
		const store = new LifecycleStore(dbPath);
		store.insertFinding(staleStatusFinding("acme"));
		store.close();

		await run(["status", "--tenant", "acme", "-f", "json"]);

		const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		const rows = JSON.parse(stdoutText); // must not throw: stdout is a bare array
		expect(Array.isArray(rows)).toBe(true);
		expect(rows).toHaveLength(1);

		const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(stderrText).toContain("acme");
		expect(stderrText).toContain(`v${FINGERPRINT_ALGO_VERSION + 1}`);
		expect(stderrText).toContain(
			`lifecycle maintain --purge-stale-fingerprints --tenant acme`,
		);
	});

	it("clean tenant: no warning on either stream", async () => {
		const store = new LifecycleStore(dbPath);
		store.close();

		await run(["status", "--tenant", "acme"]);

		expect(stderrSpy.mock.calls).toHaveLength(0);
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).not.toContain("stale-algo");
		expect(printed).toContain("No findings.");
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
	if (!row)
		throw new Error(`seedCaptureRequest: no pending row for ${fingerprint}`);
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
		store.cancelCaptureRequest(cancelId);
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
		store.cancelCaptureRequest(id);
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

describe("lifecycle maintain --purge-stale-fingerprints", () => {
	let dir: string;
	let dbPath: string;
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "alperf-purge-cli-"));
		dbPath = join(dir, "lifecycle.sqlite");
		logSpy = spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(async () => {
		logSpy.mockRestore();
		await rmSyncRetrying(dir);
	});

	it("purges the tenant's stale-algo findings and reports the count", async () => {
		const store = new LifecycleStore(dbPath);
		store.insertFinding({
			tenant: "acme",
			fingerprint: "pattern:1111111111111111",
			algoVersion: FINGERPRINT_ALGO_VERSION + 1,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Stale",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);
		store.close();

		const cmd = createLifecycleCommand();
		cmd.exitOverride();
		await cmd.parseAsync(
			[
				"--db",
				dbPath,
				"maintain",
				"--purge-stale-fingerprints",
				"--tenant",
				"ACME",
			],
			{ from: "user" },
		);

		const after = new LifecycleStore(dbPath);
		expect(after.listFindings({ tenant: "acme" }).length).toBe(0);
		after.close();

		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("Purged 1 finding(s)");
	});
});
