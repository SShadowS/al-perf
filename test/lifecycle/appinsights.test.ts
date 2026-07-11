/**
 * appinsights.test.ts — the App Insights REST puller (telemetry-ingest plan,
 * Task 5): request pinning (URL/headers, key never leaked), missing-env-var
 * fail-closed with zero fetch calls, row normalization across both duration
 * wire shapes (plain ms number vs .NET timespan string) with a stack-trace
 * methodName fallback, HTTP error classification (permanent vs retryable —
 * v1 does not retry), and a pull -> parseTelemetryBatch round-trip proving
 * fingerprints mint cleanly off pulled data.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseTelemetryBatch } from "../../src/core/telemetry-parser.js";
import {
	DEFAULT_API_KEY_ENV,
	parseTimespanMs,
	pullTelemetry,
	pullTelemetrySplit,
} from "../../src/lifecycle/appinsights.js";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/lifecycle/config.js";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const DECOY_KEY = "super-secret-appinsights-key-should-never-leak";

const COLUMNS = [
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
	{ name: "clientType", type: "string" },
];

function primaryTableResponse(rows: unknown[][], extraTables: unknown[] = []) {
	return {
		tables: [...extraTables, { name: "PrimaryTable", columns: COLUMNS, rows }],
	};
}

function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function errorResponse(status: number, statusText: string): Response {
	return new Response("", { status, statusText });
}

describe("parseTimespanMs", () => {
	it("parses a hh:mm:ss.fff timespan into milliseconds", () => {
		expect(parseTimespanMs("00:00:12.345")).toBe(12_345);
	});

	it("parses a whole-second timespan with no fraction", () => {
		expect(parseTimespanMs("00:01:00")).toBe(60_000);
	});

	it("parses a day-prefixed timespan", () => {
		expect(parseTimespanMs("1.00:00:00")).toBe(86_400_000);
	});

	it("throws on garbage input", () => {
		expect(() => parseTimespanMs("not-a-timespan")).toThrow();
	});
});

describe("pullTelemetry — non-split snapshot pin (telemetry-multitenant plan Task 2, behavior 1: captured BEFORE the split-mode refactor, must stay byte-identical after)", () => {
	const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z");

	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	function expectedKql(signalId: string): string {
		return [
			"traces",
			"| where timestamp > datetime(2026-01-01T08:00:00.000Z)",
			`| where customDimensions.eventId == "${signalId}"`,
			"| extend appId = tostring(customDimensions.extensionId),",
			"         appName = tostring(customDimensions.extensionName),",
			"         objectType = tostring(customDimensions.alObjectType),",
			"         objectId = toint(customDimensions.alObjectId),",
			"         objectName = tostring(customDimensions.alObjectName),",
			"         methodName = tostring(customDimensions.alMethod),",
			"         stackTrace = tostring(customDimensions.alStackTrace),",
			"         clientType = tostring(customDimensions.clientType),",
			"         ms = todouble(customDimensions.executionTimeInMs)",
			"| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms), stackTrace = any(stackTrace)",
			"    by appId, appName, objectType, objectId, objectName, methodName, clientType",
		].join("\n");
	}

	it("generated KQL for both default signals is byte-identical to the pre-refactor shape", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetry(
			{
				appId: APP_ID,
				signals: ["RT0018", "RT0005"],
				since: "4h",
				now: () => FIXED_NOW,
			},
			fetchImpl,
		);

		expect(calls).toHaveLength(2);
		const decoded = calls.map((u) =>
			decodeURIComponent(new URL(u).searchParams.get("query") ?? ""),
		);
		expect(decoded[0]).toBe(expectedKql("RT0018"));
		expect(decoded[1]).toBe(expectedKql("RT0005"));
	});

	it("output batch for the row-normalization fixture is byte-identical to the pre-refactor shape", async () => {
		const numericRow = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50100,
			"Sales Post",
			"ProcessLine",
			3,
			12000,
			9500,
			"",
		];
		const fetchImpl = (async () =>
			okResponse(primaryTableResponse([numericRow]))) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018"], since: "4h", now: () => FIXED_NOW },
			fetchImpl,
		);

		expect(batch).toEqual({
			schemaVersion: 1,
			payloadType: "telemetry-batch",
			windowStart: "2026-01-01T08:00:00.000Z",
			windowEnd: "2026-01-01T12:00:00.000Z",
			source: "appinsights-api",
			signals: [
				{
					signalId: "RT0018",
					appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
					appName: "My ISV App",
					objectType: "Codeunit",
					objectId: 50100,
					objectName: "Sales Post",
					methodName: "ProcessLine",
					clientType: undefined,
					count: 3,
					maxDurationMs: 12000,
					avgDurationMs: 9500,
				},
			],
		});
	});
});

describe("pullTelemetry — request pinning", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("URL path carries the app id, query is url-encoded, x-api-key header set, key never leaks into the URL", async () => {
		const calls: Array<[string, RequestInit | undefined]> = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			calls.push([url, init]);
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetry({ appId: APP_ID, signals: ["RT0018"] }, fetchImpl);

		expect(calls).toHaveLength(1);
		const [url, init] = calls[0];
		expect(url.startsWith("https://api.applicationinsights.io/v1/apps/")).toBe(
			true,
		);
		expect(url).toContain(`/v1/apps/${APP_ID}/query?query=`);
		// The raw URL must be percent-encoded, not a literal KQL string with quotes/pipes.
		expect(url).not.toContain('"');
		expect(url).not.toContain("|");
		const decodedQuery = new URL(url).searchParams.get("query") ?? "";
		expect(decodedQuery).toContain('customDimensions.eventId == "RT0018"');
		expect(url).not.toContain(DECOY_KEY);

		const headers = init?.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe(DECOY_KEY);
	});

	it("queries once per requested signal", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018", "RT0005"] },
			fetchImpl,
		);

		expect(calls).toHaveLength(2);
		expect(decodeURIComponent(calls[0])).toContain('eventId == "RT0018"');
		expect(decodeURIComponent(calls[1])).toContain('eventId == "RT0005"');
	});
});

describe("pullTelemetry — missing API key env var", () => {
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
		delete process.env.MY_CUSTOM_KEY_ENV;
		delete process.env.AL_PERF_APPINSIGHTS_TEST_DECOY;
	});

	it("defaults to APPINSIGHTS_API_KEY, names it in the error, and makes zero fetch calls", async () => {
		delete process.env[DEFAULT_API_KEY_ENV];
		let fetchCalled = false;
		const fetchImpl = (async () => {
			fetchCalled = true;
			throw new Error("fetch should not be called");
		}) as typeof fetch;

		await expect(pullTelemetry({ appId: APP_ID }, fetchImpl)).rejects.toThrow(
			/APPINSIGHTS_API_KEY/,
		);
		expect(fetchCalled).toBe(false);
	});

	it("honors --api-key-env override, names the OVERRIDDEN var, never leaks a decoy secret under another var", async () => {
		delete process.env.MY_CUSTOM_KEY_ENV;
		process.env.AL_PERF_APPINSIGHTS_TEST_DECOY = DECOY_KEY;
		let fetchCalled = false;
		const fetchImpl = (async () => {
			fetchCalled = true;
			throw new Error("fetch should not be called");
		}) as typeof fetch;

		let message = "";
		try {
			await pullTelemetry(
				{ appId: APP_ID, apiKeyEnv: "MY_CUSTOM_KEY_ENV" },
				fetchImpl,
			);
			throw new Error("expected pullTelemetry to reject");
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("MY_CUSTOM_KEY_ENV");
		expect(message).not.toContain(DECOY_KEY);
		expect(fetchCalled).toBe(false);
	});
});

describe("pullTelemetry — row normalization", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("normalizes numeric-ms rows and timespan-string rows to the same shape, with stack-trace methodName fallback; round-trips through parseTelemetryBatch", async () => {
		const numericRow = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50100,
			"Sales Post",
			"ProcessLine",
			3,
			12000,
			9500,
			"",
		];
		const timespanRow = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50200,
			"Sales Post",
			"", // alMethod empty -> fall back to stack trace first line
			1,
			"00:00:12.345",
			"00:00:09.500",
			"Codeunit 50200 ProcessLine2\nCodeunit 1 Caller",
		];

		let call = 0;
		const fetchImpl = (async () => {
			call++;
			return okResponse(
				primaryTableResponse(call === 1 ? [numericRow] : [timespanRow]),
			);
		}) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018", "RT0005"] },
			fetchImpl,
		);

		expect(batch.schemaVersion).toBe(1);
		expect(batch.payloadType).toBe("telemetry-batch");
		expect(batch.signals).toHaveLength(2);

		const [s1, s2] = batch.signals;
		expect(s1.maxDurationMs).toBe(12000);
		expect(s1.avgDurationMs).toBe(9500);
		expect(s1.methodName).toBe("ProcessLine");
		expect(s2.maxDurationMs).toBe(12345);
		expect(s2.avgDurationMs).toBe(9500);
		expect(s2.methodName).toBe("Codeunit 50200 ProcessLine2");

		const parsed = parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.signalCount).toBe(2);
		expect(parsed.result.patterns).toHaveLength(2);
		for (const p of parsed.result.patterns) {
			expect(p.fingerprint).toMatch(/^telemetry:[0-9a-f]{16}$/);
		}
	});

	it("selects the PrimaryTable out of a multi-table response", async () => {
		const row = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50100,
			"Sales Post",
			"ProcessLine",
			1,
			1000,
			1000,
			"",
		];
		const fetchImpl = (async () =>
			okResponse(
				primaryTableResponse(
					[row],
					[{ name: "SomeOtherTable", columns: [], rows: [] }],
				),
			)) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018"] },
			fetchImpl,
		);
		expect(batch.signals).toHaveLength(1);
	});

	it("skips rows with empty methodName after stack-trace fallback and logs a stderr summary", async () => {
		const badRow = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50300,
			"Sales Post",
			"",
			1,
			1000,
			1000,
			"", // no stack trace either -> no fallback available
		];
		const fetchImpl = (async () =>
			okResponse(primaryTableResponse([badRow]))) as typeof fetch;

		const errors: string[] = [];
		const originalError = console.error;
		console.error = (msg: unknown) => {
			errors.push(String(msg));
		};
		try {
			const batch = await pullTelemetry(
				{ appId: APP_ID, signals: ["RT0018"] },
				fetchImpl,
			);
			expect(batch.signals).toHaveLength(0);
			expect(errors.join("\n")).toContain("skipped");
		} finally {
			console.error = originalError;
		}
	});
});

describe("pullTelemetry — clientType (D5: telemetry-config-clienttype plan Task 4)", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("KQL always extends + groups by clientType, even without --client-types", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetry({ appId: APP_ID, signals: ["RT0018"] }, fetchImpl);

		const decoded = decodeURIComponent(calls[0]);
		expect(decoded).toContain(
			"clientType = tostring(customDimensions.clientType)",
		);
		expect(decoded).toMatch(/\bby\b[^\n]*clientType/);
		expect(decoded).not.toContain("| where clientType in");
	});

	it("--client-types adds a filter clause before summarize, validated values only", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetry(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				clientTypes: ["Background", "WebClient"],
			},
			fetchImpl,
		);

		const decoded = decodeURIComponent(calls[0]);
		expect(decoded).toContain(
			'| where clientType in ("Background", "WebClient")',
		);
	});

	it("rejects an invalid --client-types value before any fetch call (injection posture)", async () => {
		let fetchCalled = false;
		const fetchImpl = (async () => {
			fetchCalled = true;
			throw new Error("fetch should not be called");
		}) as typeof fetch;

		await expect(
			pullTelemetry(
				{
					appId: APP_ID,
					signals: ["RT0018"],
					clientTypes: ["Background;drop"],
				},
				fetchImpl,
			),
		).rejects.toThrow(/invalid.*client-types/i);
		expect(fetchCalled).toBe(false);
	});

	it("rejects '__proto__' as a --client-types value (letters-only regex, same posture as telemetry-parser)", async () => {
		const fetchImpl = (async () => {
			throw new Error("fetch should not be called");
		}) as typeof fetch;

		await expect(
			pullTelemetry(
				{ appId: APP_ID, signals: ["RT0018"], clientTypes: ["__proto__"] },
				fetchImpl,
			),
		).rejects.toThrow(/invalid.*client-types/i);
	});

	it("normalizes a present clientType column into signal.clientType", async () => {
		const row = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50100,
			"Sales Post",
			"ProcessLine",
			3,
			12000,
			9500,
			"",
			"Background",
		];
		const fetchImpl = (async () =>
			okResponse(primaryTableResponse([row]))) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018"] },
			fetchImpl,
		);

		expect(batch.signals).toHaveLength(1);
		expect(batch.signals[0].clientType).toBe("Background");
	});

	it("omits clientType when the column is absent or empty (old App Insights rows)", async () => {
		const rowWithoutColumn = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50100,
			"Sales Post",
			"ProcessLine",
			3,
			12000,
			9500,
			"",
			// no clientType value at all
		];
		const rowWithEmptyColumn = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50200,
			"Sales Post",
			"ProcessLine2",
			1,
			1000,
			1000,
			"",
			"",
		];
		let call = 0;
		const fetchImpl = (async () => {
			call++;
			return okResponse(
				primaryTableResponse(
					call === 1 ? [rowWithoutColumn] : [rowWithEmptyColumn],
				),
			);
		}) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018", "RT0005"] },
			fetchImpl,
		);

		expect(batch.signals).toHaveLength(2);
		expect(batch.signals[0].clientType).toBeUndefined();
		expect(batch.signals[1].clientType).toBeUndefined();
	});

	it("a pulled batch with clientTypes round-trips through the Task-3 parser", async () => {
		const bgRow = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50100,
			"Sales Post",
			"ProcessLine",
			5,
			76934,
			50000,
			"",
			"Background",
		];
		const fetchImpl = (async () =>
			okResponse(primaryTableResponse([bgRow]))) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018"], clientTypes: ["Background"] },
			fetchImpl,
		);

		expect(batch.signals[0].clientType).toBe("Background");

		const parsed = parseTelemetryBatch(batch, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.signalCount).toBe(1);
		expect(parsed.result.patterns).toHaveLength(1);
		expect(parsed.result.patterns[0].fingerprint).toMatch(
			/^telemetry:[0-9a-f]{16}$/,
		);
	});
});

describe("pullTelemetry — HTTP error classification (v1 does not retry)", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	for (const [status, statusText] of [
		[401, "Unauthorized"],
		[404, "Not Found"],
	] as const) {
		it(`HTTP ${status} -> clear permanent error`, async () => {
			const fetchImpl = (async () =>
				errorResponse(status, statusText)) as typeof fetch;
			let message = "";
			try {
				await pullTelemetry({ appId: APP_ID, signals: ["RT0018"] }, fetchImpl);
				throw new Error("expected pullTelemetry to reject");
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).toContain(String(status));
			expect(message.toLowerCase()).toContain("permanent");
			expect(message).not.toContain(DECOY_KEY);
		});
	}

	for (const [status, statusText] of [
		[429, "Too Many Requests"],
		[500, "Internal Server Error"],
		[503, "Service Unavailable"],
	] as const) {
		it(`HTTP ${status} -> error names retryability (puller itself does not retry)`, async () => {
			const fetchImpl = (async () =>
				errorResponse(status, statusText)) as typeof fetch;
			let message = "";
			try {
				await pullTelemetry({ appId: APP_ID, signals: ["RT0018"] }, fetchImpl);
				throw new Error("expected pullTelemetry to reject");
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).toContain(String(status));
			expect(message.toLowerCase()).toContain("retry");
			expect(message).not.toContain(DECOY_KEY);
		});
	}
});

// ---------------------------------------------------------------------------
// pullTelemetrySplit (telemetry-multitenant plan, Task 2): split-mode KQL
// dimensions, per-(aadTenantId, environmentName) grouping, tenantMap/policy
// application. Non-split pullTelemetry's behavior is pinned above and MUST
// stay untouched by this work.
// ---------------------------------------------------------------------------

const SPLIT_COLUMNS = [
	...COLUMNS,
	{ name: "aadTenantId", type: "string" },
	{ name: "environmentName", type: "string" },
];

function splitPrimaryTableResponse(rows: unknown[][]) {
	return { tables: [{ name: "PrimaryTable", columns: SPLIT_COLUMNS, rows }] };
}

function makeSplitRow(opts: {
	appId?: string;
	methodName?: string;
	objectId?: number;
	count?: number;
	maxMs?: number;
	avgMs?: number;
	clientType?: string;
	aadTenantId: string;
	environmentName?: string;
}): unknown[] {
	return [
		opts.appId ?? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		"My ISV App",
		"Codeunit",
		opts.objectId ?? 50100,
		"Sales Post",
		opts.methodName ?? "ProcessLine",
		opts.count ?? 1,
		opts.maxMs ?? 1000,
		opts.avgMs ?? 900,
		"",
		opts.clientType ?? "",
		opts.aadTenantId,
		opts.environmentName ?? "",
	];
}

const TENANT_X = "11111111-1111-1111-1111-111111111111";
const TENANT_Y = "22222222-2222-2222-2222-222222222222";

describe("pullTelemetrySplit — KQL dimensions (behavior 2)", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("extends + groups by aadTenantId/environmentName for both signal queries", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(splitPrimaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018", "RT0005"],
				tenantMap: {},
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		expect(calls).toHaveLength(2);
		for (const url of calls) {
			const decoded = decodeURIComponent(url);
			expect(decoded).toContain(
				"aadTenantId = tostring(customDimensions.aadTenantId)",
			);
			expect(decoded).toContain(
				"environmentName = tostring(customDimensions.environmentName)",
			);
			expect(decoded).toMatch(/\bby\b[^\n]*aadTenantId[^\n]*environmentName/);
		}
	});

	it("--client-types filter still composes in split mode", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(splitPrimaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				clientTypes: ["Background"],
				tenantMap: {},
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		const decoded = decodeURIComponent(calls[0]);
		expect(decoded).toContain('| where clientType in ("Background")');
	});
});

describe("pullTelemetrySplit — grouping (behavior 3)", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("groups rows by (aadTenantId, environmentName); per-clientType rows survive inside a group", async () => {
		const rows = [
			makeSplitRow({
				aadTenantId: TENANT_X,
				environmentName: "PROD",
				clientType: "Background",
				methodName: "ProcessLineA",
			}),
			makeSplitRow({
				aadTenantId: TENANT_X,
				environmentName: "PROD",
				clientType: "WebClient",
				methodName: "ProcessLineB",
			}),
			makeSplitRow({
				aadTenantId: TENANT_Y,
				environmentName: "PROD",
				methodName: "ProcessLineC",
			}),
		];
		const fetchImpl = (async () =>
			okResponse(splitPrimaryTableResponse(rows))) as typeof fetch;

		const result = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				since: "4h",
				now: () => new Date("2026-01-01T12:00:00.000Z"),
				tenantMap: { [TENANT_X]: "acme", [TENANT_Y]: "beta" },
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		expect(result.skippedTenants).toEqual([]);
		expect(result.groups).toHaveLength(2);

		const acme = result.groups.find((g) => g.tenant === "acme");
		expect(acme).toBeDefined();
		expect(acme?.aadTenantId).toBe(TENANT_X);
		expect(acme?.environmentName).toBe("PROD");
		expect(acme?.stream).toBe("PROD");
		expect(acme?.batch.signals).toHaveLength(2);
		expect(acme?.batch.source).toBe("appinsights-api-split");
		expect(acme?.batch.windowStart).toBe("2026-01-01T08:00:00.000Z");
		expect(acme?.batch.windowEnd).toBe("2026-01-01T12:00:00.000Z");
		expect(acme?.batch.schemaVersion).toBe(1);
		expect(acme?.batch.payloadType).toBe("telemetry-batch");

		const beta = result.groups.find((g) => g.tenant === "beta");
		expect(beta).toBeDefined();
		expect(beta?.batch.signals).toHaveLength(1);
	});

	it("empty/absent environmentName becomes stream 'telemetry' (D2); a real environmentName is used verbatim as the stream", async () => {
		const rows = [
			makeSplitRow({ aadTenantId: TENANT_X, environmentName: "" }),
			makeSplitRow({ aadTenantId: TENANT_Y, environmentName: "Sandbox" }),
		];
		const fetchImpl = (async () =>
			okResponse(splitPrimaryTableResponse(rows))) as typeof fetch;

		const result = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				tenantMap: { [TENANT_X]: "acme", [TENANT_Y]: "beta" },
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		const acme = result.groups.find((g) => g.tenant === "acme");
		expect(acme?.stream).toBe("telemetry");
		expect(acme?.environmentName).toBeNull();

		const beta = result.groups.find((g) => g.tenant === "beta");
		expect(beta?.stream).toBe("Sandbox");
		expect(beta?.environmentName).toBe("Sandbox");
	});
});

describe("pullTelemetrySplit — mapping and policy (behavior 4)", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("unmapped + skip: no group, into skippedTenants with a summed signal count across environments", async () => {
		const rows = [
			makeSplitRow({ aadTenantId: TENANT_X, environmentName: "PROD" }),
			makeSplitRow({ aadTenantId: TENANT_X, environmentName: "SANDBOX" }),
		];
		const fetchImpl = (async () =>
			okResponse(splitPrimaryTableResponse(rows))) as typeof fetch;

		const result = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				tenantMap: {},
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		expect(result.groups).toHaveLength(0);
		expect(result.skippedTenants).toEqual([
			{ aadTenantId: TENANT_X, signalCount: 2 },
		]);
	});

	it("unmapped + fleet: group with tenant = fleetTenant, stream still from environmentName; distinct unmapped tenants stay distinct groups", async () => {
		const rows = [
			makeSplitRow({ aadTenantId: TENANT_X, environmentName: "PROD" }),
			makeSplitRow({ aadTenantId: TENANT_Y, environmentName: "PROD" }),
		];
		const fetchImpl = (async () =>
			okResponse(splitPrimaryTableResponse(rows))) as typeof fetch;

		const result = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				tenantMap: {},
				unmappedTenantPolicy: "fleet",
				fleetTenant: "acme-fleet",
			},
			fetchImpl,
		);

		expect(result.skippedTenants).toEqual([]);
		expect(result.groups).toHaveLength(2);
		for (const g of result.groups) {
			expect(g.tenant).toBe("acme-fleet");
			expect(g.stream).toBe("PROD");
		}
		const aadIds = result.groups.map((g) => g.aadTenantId).sort();
		expect(aadIds).toEqual([TENANT_X, TENANT_Y].sort());
	});

	it("case-insensitive aadTenantId <-> tenantMap-key matching, both directions (CONTROLLER-PINNED)", async () => {
		const guidLower = "33333333-3333-3333-3333-333333333333";
		const guidUpper = guidLower.toUpperCase();

		// (a) tenantMap key uppercase, Azure row aadTenantId lowercase
		const fetchImplA = (async () =>
			okResponse(
				splitPrimaryTableResponse([
					makeSplitRow({ aadTenantId: guidLower, environmentName: "PROD" }),
				]),
			)) as typeof fetch;
		const resultA = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				tenantMap: { [guidUpper]: "acme" },
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImplA,
		);
		expect(resultA.skippedTenants).toEqual([]);
		expect(resultA.groups).toHaveLength(1);
		expect(resultA.groups[0].tenant).toBe("acme");

		// (b) tenantMap key lowercase, Azure row aadTenantId uppercase
		const fetchImplB = (async () =>
			okResponse(
				splitPrimaryTableResponse([
					makeSplitRow({ aadTenantId: guidUpper, environmentName: "PROD" }),
				]),
			)) as typeof fetch;
		const resultB = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				tenantMap: { [guidLower]: "acme" },
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImplB,
		);
		expect(resultB.skippedTenants).toEqual([]);
		expect(resultB.groups).toHaveLength(1);
		expect(resultB.groups[0].tenant).toBe("acme");
	});
});

describe("pullTelemetrySplit — empty aadTenantId (behavior 5)", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("empty aadTenantId is treated as unmapped under skip policy: no crash, no group, lands in skippedTenants", async () => {
		const rows = [makeSplitRow({ aadTenantId: "", environmentName: "PROD" })];
		const fetchImpl = (async () =>
			okResponse(splitPrimaryTableResponse(rows))) as typeof fetch;

		const result = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				tenantMap: { [TENANT_X]: "acme" },
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		expect(result.groups).toHaveLength(0);
		expect(result.skippedTenants).toEqual([
			{ aadTenantId: "", signalCount: 1 },
		]);
	});

	it("empty aadTenantId is treated as unmapped under fleet policy: never silently attached to a mapped customer", async () => {
		const rows = [makeSplitRow({ aadTenantId: "", environmentName: "PROD" })];
		const fetchImpl = (async () =>
			okResponse(splitPrimaryTableResponse(rows))) as typeof fetch;

		const result = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				tenantMap: { [TENANT_X]: "acme" },
				unmappedTenantPolicy: "fleet",
				fleetTenant: "fleet-bucket",
			},
			fetchImpl,
		);

		expect(result.groups).toHaveLength(1);
		expect(result.groups[0].tenant).toBe("fleet-bucket");
		expect(result.groups[0].aadTenantId).toBe("");
		expect(result.groups[0].stream).toBe("PROD");
	});
});

describe("pullTelemetrySplit — round-trip through parseTelemetryBatch (behavior 6)", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("every group's batch validates through parseTelemetryBatch", async () => {
		const rows = [
			makeSplitRow({
				aadTenantId: TENANT_X,
				environmentName: "PROD",
				clientType: "Background",
			}),
			makeSplitRow({
				aadTenantId: TENANT_Y,
				environmentName: "",
				methodName: "OtherMethod",
			}),
		];
		const fetchImpl = (async () =>
			okResponse(splitPrimaryTableResponse(rows))) as typeof fetch;

		const result = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				tenantMap: { [TENANT_X]: "acme", [TENANT_Y]: "beta" },
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		expect(result.groups).toHaveLength(2);
		for (const group of result.groups) {
			const parsed = parseTelemetryBatch(group.batch, DEFAULT_LIFECYCLE_CONFIG);
			expect(parsed.signalCount).toBe(group.batch.signals.length);
			expect(parsed.result.patterns).toHaveLength(group.batch.signals.length);
			for (const p of parsed.result.patterns) {
				expect(p.fingerprint).toMatch(/^telemetry:[0-9a-f]{16}$/);
			}
		}
	});
});
