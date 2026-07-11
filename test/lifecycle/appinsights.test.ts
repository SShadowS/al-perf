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
		expect(decoded).toContain("clientType = tostring(customDimensions.clientType)");
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
			{ appId: APP_ID, signals: ["RT0018"], clientTypes: ["Background", "WebClient"] },
			fetchImpl,
		);

		const decoded = decodeURIComponent(calls[0]);
		expect(decoded).toContain('| where clientType in ("Background", "WebClient")');
	});

	it("rejects an invalid --client-types value before any fetch call (injection posture)", async () => {
		let fetchCalled = false;
		const fetchImpl = (async () => {
			fetchCalled = true;
			throw new Error("fetch should not be called");
		}) as typeof fetch;

		await expect(
			pullTelemetry(
				{ appId: APP_ID, signals: ["RT0018"], clientTypes: ["Background;drop"] },
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
				primaryTableResponse(call === 1 ? [rowWithoutColumn] : [rowWithEmptyColumn]),
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
		expect(parsed.result.patterns[0].fingerprint).toMatch(/^telemetry:[0-9a-f]{16}$/);
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
