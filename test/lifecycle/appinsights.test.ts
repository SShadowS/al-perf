/**
 * appinsights.test.ts — the App Insights REST puller (telemetry-ingest plan,
 * Task 5): request pinning (URL/headers, key never leaked), missing-env-var
 * fail-closed with zero fetch calls, row normalization across both duration
 * wire shapes (plain ms number vs .NET timespan string) with an AL-frame
 * methodName fallback (`parseAlStackFrame`, Task 8), HTTP error
 * classification (permanent vs retryable — v1 does not retry), and a
 * pull -> parseTelemetryBatch round-trip proving fingerprints mint cleanly
 * off pulled data.
 *
 * Task 8 (telemetry-sql-evidence plan) additionally covers: the duration
 * extraction fix (`executionTime` timespan, not the absent
 * `executionTimeInMs` alias — Gate 0 measured it non-null on 0/17,045 RT0018
 * rows and 6/15,957 RT0005 rows), RT0005 grouping by `stackTrace` instead of
 * collapsing every statement under one object with `any()`, and RT0018's new
 * `sqlExecutes`/`sqlRowsRead` aggregates.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseTelemetryBatch } from "../../src/core/telemetry-parser.js";
import {
	buildKqlQuery,
	buildStatementKqlQuery,
	DEFAULT_API_KEY_ENV,
	listTenants,
	normalizeTable,
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

describe("buildKqlQuery — duration fix (Task 8, Gate 0)", () => {
	it("derives ms from the executionTime timespan, not the absent executionTimeInMs alias", () => {
		for (const signalId of ["RT0005", "RT0018"]) {
			const kql = buildKqlQuery(
				signalId,
				"2026-07-25T00:00:00.000Z",
				undefined,
				false,
			);
			expect(kql).toContain("totimespan(customDimensions.executionTime)");
			expect(kql).not.toContain("executionTimeInMs");
		}
	});
});

describe("buildKqlQuery — RT0005 stack grouping / RT0018 SQL counters (Task 8)", () => {
	it("RT0005 groups by alStackTrace instead of collapsing with any()", () => {
		const kql = buildKqlQuery(
			"RT0005",
			"2026-07-25T00:00:00.000Z",
			undefined,
			false,
		);
		expect(kql).not.toContain("stackTrace = any(stackTrace)");
		expect(kql).toContain(
			"by appId, appName, objectType, objectId, objectName, methodName, stackTrace, clientType",
		);
	});

	it("RT0018 keeps its existing grouping and gains guarded SQL counters", () => {
		const kql = buildKqlQuery(
			"RT0018",
			"2026-07-25T00:00:00.000Z",
			undefined,
			false,
		);
		expect(kql).toContain("stackTrace = any(stackTrace)");
		expect(kql).toContain(
			"sqlExecutes = iff(countif(isnotnull(customDimensions.sqlExecutes)) == 0, real(null), todouble(sum(toint(customDimensions.sqlExecutes))))",
		);
		expect(kql).toContain(
			"sqlRowsRead = iff(countif(isnotnull(customDimensions.sqlRowsRead)) == 0, real(null), todouble(sum(toint(customDimensions.sqlRowsRead))))",
		);
	});
});

// ---------------------------------------------------------------------------
// Fix Round 1: Kusto's sum() over an all-null column folds to 0, not null (the
// opposite of SQL) — verified against live telemetry (RT0005 groups, which
// never carry sqlExecutes/sqlRowsRead, summed to a real 0). An unguarded
// sum(toint(...)) would hand asOptionalCount a real 0 for BC < v22.0 rows,
// minting a false "confirmed zero SQL statements". The iff/countif guard
// fixes that; these tests pin the guard is present, not just the bare sum().
// ---------------------------------------------------------------------------

describe("buildKqlQuery — RT0018 SQL counter null-safety guard (Fix Round 1)", () => {
	it("both counters are guarded with countif(isnotnull(...)) == 0, not a bare sum()", () => {
		const kql = buildKqlQuery(
			"RT0018",
			"2026-07-25T00:00:00.000Z",
			undefined,
			false,
		);
		const guardOccurrences = kql.match(/countif\(isnotnull\(/g) ?? [];
		expect(guardOccurrences).toHaveLength(2);
		expect(kql).toContain("countif(isnotnull(customDimensions.sqlExecutes))");
		expect(kql).toContain("countif(isnotnull(customDimensions.sqlRowsRead))");
		expect(kql).not.toContain("sqlExecutes = sum(toint(");
		expect(kql).not.toContain("sqlRowsRead = sum(toint(");
	});

	it("the guard only fires when the counter is absent on EVERY row (== 0), so a group with partial presence still sums the present rows", () => {
		const kql = buildKqlQuery(
			"RT0018",
			"2026-07-25T00:00:00.000Z",
			undefined,
			false,
		);
		// `== 0` means "the column was null on every row in the group" -- NOT
		// e.g. "< count()", which would incorrectly null out a group where the
		// counter is present on only SOME rows. Kusto's sum() already skips
		// individual nulls within a non-empty set (same as SQL); only the
		// ALL-null fold-to-0 case needs this guard, so a mixed-presence group
		// falls through to the real sum() branch unaffected.
		expect(kql).toContain(
			"iff(countif(isnotnull(customDimensions.sqlExecutes)) == 0, real(null), todouble(sum(toint(customDimensions.sqlExecutes))))",
		);
		expect(kql).toContain(
			"iff(countif(isnotnull(customDimensions.sqlRowsRead)) == 0, real(null), todouble(sum(toint(customDimensions.sqlRowsRead))))",
		);
	});
});

describe("normalizeTable — RT0005 header-only stack no longer becomes the method name (Task 8)", () => {
	it("a header-only stack (no AL CallStack: marker) yields no frame, so the row is skipped rather than emitted with a header string as its method", () => {
		const table = {
			columns: [
				{ name: "appId" },
				{ name: "objectType" },
				{ name: "objectId" },
				{ name: "methodName" },
				{ name: "stackTrace" },
				{ name: "count" },
				{ name: "maxDurationMs" },
			],
			rows: [
				[
					"app",
					"CodeUnit",
					80,
					"",
					"AppObjectType: CodeUnit\r\nAppObjectId: 80",
					1,
					900,
				],
			],
		};
		const { signals, skipped } = normalizeTable(table, "RT0005");
		expect(signals).toHaveLength(0);
		expect(skipped).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// buildStatementKqlQuery — value columns via pass-through levels (Task 9,
// Fix Round 1 CRITICAL): top-nested returns ONLY its own clause columns, so
// occurrences/measuredTotalMs/thresholdMs must EACH ride an uncapped
// Ignore<N> = max(1) pass-through level to survive at all — reading them
// straight off the summarize (the pre-fix version) produced NaN in
// production. Asserted here directly against the real column names
// (verified-statement-kql.md), not a hand-written fixture — a fabricated
// fixture is exactly what let the NaN bug pass a green suite the first time.
// ---------------------------------------------------------------------------

describe("buildStatementKqlQuery — value columns and clientType (Fix Round 1)", () => {
	it("non-split: projects exactly the columns the normalizer reads, with every non-capped dimension passed through via Ignore<N> = max(1)", () => {
		const kql = buildStatementKqlQuery("2026-07-25T00:00:00.000Z", false);
		expect(kql).toContain(
			"| project extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement, clientType, occurrences, measuredTotalMs, thresholdMs",
		);
		// extensionId, alObjectType, alObjectId, alStackTrace, clientType,
		// occurrences, measuredTotalMs, thresholdMs = 8 pass-through levels.
		expect(
			kql.match(/top-nested of \w+ by Ignore\d+ = max\(1\)/g),
		).toHaveLength(8);
		expect(kql).toContain(
			"top-nested 5 of sqlStatement by max(measuredTotalMs)",
		);
		// sqlStatement is the ONLY level capped with a number.
		expect(kql.match(/top-nested \d+ of/g)).toEqual(["top-nested 5 of"]);
	});

	it("split: also carries aadTenantId/environmentName through the project and as two more pass-through levels", () => {
		const kql = buildStatementKqlQuery("2026-07-25T00:00:00.000Z", true);
		expect(kql).toContain(
			"| project extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement, clientType, aadTenantId, environmentName, occurrences, measuredTotalMs, thresholdMs",
		);
		expect(
			kql.match(/top-nested of \w+ by Ignore\d+ = max\(1\)/g),
		).toHaveLength(10);
		expect(kql).toContain(
			"summarize occurrences = count(), measuredTotalMs = sum(ms), thresholdMs = min(thresholdMs) by extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement, clientType, aadTenantId, environmentName",
		);
	});

	it("carries clientType through extend/summarize (so it can match the aggregate query's own clientType grouping)", () => {
		const kql = buildStatementKqlQuery("2026-07-25T00:00:00.000Z", false);
		expect(kql).toContain("clientType = tostring(customDimensions.clientType)");
		expect(kql).toMatch(/summarize[^\n]*\bby\b[^\n]*clientType/);
	});

	it("--client-types filters the statement query, same shape as the aggregate query's own filter", () => {
		const withFilter = buildStatementKqlQuery(
			"2026-07-25T00:00:00.000Z",
			false,
			["Background", "WebClient"],
		);
		expect(withFilter).toContain(
			'| where clientType in ("Background", "WebClient")',
		);

		const withoutFilter = buildStatementKqlQuery(
			"2026-07-25T00:00:00.000Z",
			false,
		);
		expect(withoutFilter).not.toContain("| where clientType in");
	});
});

describe("pullTelemetry — non-split snapshot pin (telemetry-multitenant plan Task 2, behavior 1: captured BEFORE the split-mode refactor, must stay byte-identical after; RT0005/RT0018 shapes diverged and re-baselined under Task 8 — see expectedKql)", () => {
	const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z");

	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	// RT0005 and RT0018 diverge here (Task 8): RT0005 groups by stackTrace and
	// has no SQL-counter aggregates; RT0018 keeps the any()-carried stackTrace
	// and gains sqlExecutes/sqlRowsRead, guarded against Kusto's sum()-over-
	// all-null == 0 behavior (Fix Round 1). Both share the Gate-0 duration fix
	// (executionTime timespan, not the absent executionTimeInMs alias).
	function expectedKql(signalId: string): string {
		const isSqlSignal = signalId === "RT0005";
		const lines = [
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
			"         ms = toreal(totimespan(customDimensions.executionTime)) / 10000",
		];
		if (isSqlSignal) {
			lines.push(
				"| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms)",
				"    by appId, appName, objectType, objectId, objectName, methodName, stackTrace, clientType",
			);
		} else {
			lines.push(
				"| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms), stackTrace = any(stackTrace),",
				"    sqlExecutes = iff(countif(isnotnull(customDimensions.sqlExecutes)) == 0, real(null), todouble(sum(toint(customDimensions.sqlExecutes)))),",
				"    sqlRowsRead = iff(countif(isnotnull(customDimensions.sqlRowsRead)) == 0, real(null), todouble(sum(toint(customDimensions.sqlRowsRead))))",
				"    by appId, appName, objectType, objectId, objectName, methodName, clientType",
			);
		}
		return lines.join("\n");
	}

	// Task 9 (Fix Round 1): a third call — the statement-level RT0005 query,
	// separate from the two per-signal aggregate queries above — is issued
	// whenever RT0005 is among the requested signals. Mirrors
	// buildStatementKqlQuery exactly (verified-statement-kql.md, corrected
	// 2026-07-25): the value columns (occurrences/measuredTotalMs/thresholdMs)
	// ride their own uncapped Ignore<N> = max(1) pass-through levels — a
	// top-nested clause returns ONLY its own clause columns, never the
	// summarize's columns un-nested — and the trailing `project` whitelists
	// exactly what the normalizer reads.
	function expectedStatementKql(): string {
		return [
			"traces",
			"| where timestamp > datetime(2026-01-01T08:00:00.000Z)",
			'| where customDimensions.eventId == "RT0005"',
			"| extend extensionId = tostring(customDimensions.extensionId),",
			"         alObjectType = tostring(customDimensions.alObjectType),",
			"         alObjectId = toint(customDimensions.alObjectId),",
			"         alStackTrace = tostring(customDimensions.alStackTrace),",
			"         sqlStatement = tostring(customDimensions.sqlStatement),",
			"         clientType = tostring(customDimensions.clientType),",
			"         thresholdMs = toreal(totimespan(customDimensions.longRunningThreshold)) / 10000,",
			"         ms = toreal(totimespan(customDimensions.executionTime)) / 10000",
			"| summarize occurrences = count(), measuredTotalMs = sum(ms), thresholdMs = min(thresholdMs) by extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement, clientType",
			"| top-nested of extensionId by Ignore0 = max(1),\n  top-nested of alObjectType by Ignore1 = max(1),\n  top-nested of alObjectId by Ignore2 = max(1),\n  top-nested of alStackTrace by Ignore3 = max(1),\n  top-nested of clientType by Ignore4 = max(1),\n  top-nested 5 of sqlStatement by max(measuredTotalMs),\n  top-nested of occurrences by Ignore5 = max(1),\n  top-nested of measuredTotalMs by Ignore6 = max(1),\n  top-nested of thresholdMs by Ignore7 = max(1)",
			"| project extensionId, alObjectType, alObjectId, alStackTrace, sqlStatement, clientType, occurrences, measuredTotalMs, thresholdMs",
		].join("\n");
	}

	it("generated KQL for both default signals is byte-identical to the pre-refactor shape, plus a third statement-query call (Task 9)", async () => {
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

		expect(calls).toHaveLength(3);
		const decoded = calls.map((u) =>
			decodeURIComponent(new URL(u).searchParams.get("query") ?? ""),
		);
		expect(decoded[0]).toBe(expectedKql("RT0018"));
		expect(decoded[1]).toBe(expectedKql("RT0005"));
		expect(decoded[2]).toBe(expectedStatementKql());
	});

	it("output batch for the row-normalization fixture is byte-identical to the pre-refactor shape, plus signalAvailability (Task 9)", async () => {
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

		// Only RT0018 requested -> no statement query fires (gated on RT0005
		// being among the requested signals), so this stays a single fetch call.
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
			signalAvailability: [{ signalId: "RT0018", queried: true, rows: 1 }],
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

	it("queries once per requested signal, plus one statement query when RT0005 is requested (Task 9)", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018", "RT0005"] },
			fetchImpl,
		);

		expect(calls).toHaveLength(3);
		expect(decodeURIComponent(calls[0])).toContain('eventId == "RT0018"');
		expect(decodeURIComponent(calls[1])).toContain('eventId == "RT0005"');
		// The 3rd call is the statement query: also filters RT0005, but groups
		// on sqlStatement rather than methodName/stackTrace.
		expect(decodeURIComponent(calls[2])).toContain('eventId == "RT0005"');
		expect(decodeURIComponent(calls[2])).toContain("sqlStatement");
	});

	it("issues no statement query when RT0005 is not among the requested signals", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetry({ appId: APP_ID, signals: ["RT0018"] }, fetchImpl);

		expect(calls).toHaveLength(1);
	});

	// Fix Round 1, minor: SIGNAL_ID_RE permits lowercase ("rt0005" is a valid
	// --signals value), so the statement-query gate must not be case-sensitive
	// or `--signals rt0005` would silently pull RT0005 rows with no SQL
	// evidence enrichment at all.
	it("still issues the statement query when --signals uses lowercase 'rt0005'", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		await pullTelemetry({ appId: APP_ID, signals: ["rt0005"] }, fetchImpl);

		expect(calls).toHaveLength(2); // the aggregate query + the statement query
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

	it("normalizes numeric-ms rows and timespan-string rows to the same shape, with AL-frame methodName fallback; round-trips through parseTelemetryBatch", async () => {
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
			"", // alMethod empty -> fall back to parseAlStackFrame on the AL CallStack
			1,
			"00:00:12.345",
			"00:00:09.500",
			'AL CallStack:\n"Sales Post"(Codeunit 50200).ProcessLine2 line 10 - My ISV App by Contoso',
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
		expect(s2.methodName).toBe("ProcessLine2");

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
// Per-signal failure capture (telemetry-sql-evidence plan, Task 9): a failing
// signal — HTTP error OR a normalization throw — degrades that ONE signal,
// recorded in signalAvailability, rather than aborting the whole pull. Only
// "every signal failed" still throws.
// ---------------------------------------------------------------------------

describe("pullTelemetry — per-signal failure capture (Task 9)", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	const okRt0018Row = [
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

	it("a failing signal records availability instead of aborting the pull; the other signal's rows survive", async () => {
		const fetchImpl = (async (url: string) => {
			const decoded = decodeURIComponent(url);
			if (decoded.includes('eventId == "RT0005"')) {
				return errorResponse(500, "Internal Server Error");
			}
			return okResponse(primaryTableResponse([okRt0018Row]));
		}) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018", "RT0005"] },
			fetchImpl,
		);

		expect(batch.signals.length).toBeGreaterThan(0); // RT0018 rows survived
		expect(batch.signals.every((s) => s.signalId === "RT0018")).toBe(true);

		const rt0005Avail = batch.signalAvailability?.find(
			(a) => a.signalId === "RT0005",
		);
		expect(rt0005Avail?.queried).toBe(true);
		expect(rt0005Avail?.rows).toBe(0);
		expect(rt0005Avail?.error).toContain("500");

		const rt0018Avail = batch.signalAvailability?.find(
			(a) => a.signalId === "RT0018",
		);
		expect(rt0018Avail?.error).toBeUndefined();
		expect(rt0018Avail?.rows).toBe(1);
	});

	it("all signals failing still throws, naming every failed signal", async () => {
		const fetchImpl = (async () =>
			errorResponse(500, "Internal Server Error")) as typeof fetch;

		let message = "";
		try {
			await pullTelemetry(
				{ appId: APP_ID, signals: ["RT0018", "RT0005"] },
				fetchImpl,
			);
			throw new Error("expected pullTelemetry to reject");
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("every signal query failed");
		expect(message).toContain("RT0018");
		expect(message).toContain("RT0005");
		expect(message).toContain("500");
		expect(message).not.toContain(DECOY_KEY);
	});

	it("a normalization throw (not just an HTTP error) degrades one signal, not the pull", async () => {
		// maxDurationMs is a garbage timespan string -> asDurationMs throws
		// mid-normalization for every RT0005 row; RT0018 must still survive.
		const badDurationRow = [
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			"My ISV App",
			"Codeunit",
			50200,
			"Sales Post",
			"ProcessLine2",
			1,
			"not-a-timespan",
			undefined,
			"",
		];
		const fetchImpl = (async (url: string) => {
			const decoded = decodeURIComponent(url);
			if (decoded.includes("top-nested")) {
				return okResponse(primaryTableResponse([])); // statement query, irrelevant here
			}
			if (decoded.includes('eventId == "RT0005"')) {
				return okResponse(primaryTableResponse([badDurationRow]));
			}
			return okResponse(primaryTableResponse([okRt0018Row]));
		}) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0018", "RT0005"] },
			fetchImpl,
		);

		expect(batch.signals).toHaveLength(1);
		expect(batch.signals[0].signalId).toBe("RT0018");
		const rt0005Avail = batch.signalAvailability?.find(
			(a) => a.signalId === "RT0005",
		);
		expect(rt0005Avail?.error).toContain("timespan");
	});
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

	it("extends + groups by aadTenantId/environmentName for both signal queries, and the Task-9 statement query", async () => {
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

		// 2 signal queries + 1 statement query, all three carrying the tenant
		// dimensions — the statement query's join happens per split group, so
		// it must carry them too (verified-statement-kql.md).
		expect(calls).toHaveLength(3);
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

// ---------------------------------------------------------------------------
// Statement-level SQL evidence, split mode (telemetry-sql-evidence plan,
// Task 9): the join must happen PER SPLIT GROUP, after tenant grouping —
// never globally. Two tenants whose findings share app/object/method must
// each see only their own statement rows.
// ---------------------------------------------------------------------------

// Fix Round 1: these column names/order MUST match buildStatementKqlQuery's
// own `| project` line exactly — a fixture inventing a different column set
// (e.g. one the query cannot actually emit) is what let the NaN bug pass a
// green suite the first time. Pinned by the "projects exactly the columns"
// tests above.
const STATEMENT_COLUMNS = [
	{ name: "extensionId", type: "string" },
	{ name: "alObjectType", type: "string" },
	{ name: "alObjectId", type: "long" },
	{ name: "alStackTrace", type: "string" },
	{ name: "sqlStatement", type: "string" },
	{ name: "clientType", type: "string" },
	{ name: "aadTenantId", type: "string" },
	{ name: "environmentName", type: "string" },
	{ name: "occurrences", type: "long" },
	{ name: "measuredTotalMs", type: "real" },
	{ name: "thresholdMs", type: "real" },
];

function statementTableResponse(rows: unknown[][]) {
	return {
		tables: [{ name: "PrimaryTable", columns: STATEMENT_COLUMNS, rows }],
	};
}

function makeStatementRow(opts: {
	appId?: string;
	objectId?: number;
	stackTrace?: string;
	sqlStatement: string;
	clientType?: string;
	occurrences?: number;
	measuredTotalMs?: number;
	thresholdMs?: number;
	aadTenantId: string;
	environmentName?: string;
}): unknown[] {
	return [
		opts.appId ?? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		"Codeunit",
		opts.objectId ?? 50100,
		opts.stackTrace ??
			'AL CallStack: "Sales Post"(Codeunit 50100).ProcessLine line 1',
		opts.sqlStatement,
		opts.clientType ?? "",
		opts.aadTenantId,
		opts.environmentName ?? "PROD",
		opts.occurrences ?? 1,
		opts.measuredTotalMs ?? 1000,
		opts.thresholdMs ?? 750,
	];
}

describe("pullTelemetrySplit — statement evidence join (behavior 7, Task 9)", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("does not attach across tenants — join runs per group", async () => {
		// Both tenants share the SAME app/object/method (Codeunit 50100 /
		// ProcessLine) -- exactly the shape that would collide under a global
		// join keyed on the routine alone.
		const fetchImpl = (async (url: string) => {
			const decoded = decodeURIComponent(url);
			if (decoded.includes("top-nested")) {
				return okResponse(
					statementTableResponse([
						makeStatementRow({
							aadTenantId: TENANT_X,
							sqlStatement: 'SELECT "No_" FROM dbo."CRONUS$Sales Header"',
						}),
						makeStatementRow({
							aadTenantId: TENANT_Y,
							sqlStatement:
								'SELECT "Entry No_" FROM dbo."CRONUS$Item Ledger Entry"',
						}),
					]),
				);
			}
			return okResponse(
				splitPrimaryTableResponse([
					makeSplitRow({ aadTenantId: TENANT_X, environmentName: "PROD" }),
					makeSplitRow({ aadTenantId: TENANT_Y, environmentName: "PROD" }),
				]),
			);
		}) as typeof fetch;

		const result = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0005"],
				tenantMap: { [TENANT_X]: "tenant-a", [TENANT_Y]: "tenant-b" },
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		const a = result.groups.find((g) => g.tenant === "tenant-a");
		const b = result.groups.find((g) => g.tenant === "tenant-b");
		expect(a?.batch.signals[0]?.sqlEvidence?.statements[0]?.table).toBe(
			"Sales Header",
		);
		expect(b?.batch.signals[0]?.sqlEvidence?.statements[0]?.table).toBe(
			"Item Ledger Entry",
		);
		// Neither group's evidence carries the OTHER tenant's statement.
		expect(a?.batch.signals[0]?.sqlEvidence?.statements).toHaveLength(1);
		expect(b?.batch.signals[0]?.sqlEvidence?.statements).toHaveLength(1);
	});

	it("issues no statement query when RT0005 is not among the requested signals", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return okResponse(
				splitPrimaryTableResponse([
					makeSplitRow({ aadTenantId: TENANT_X, environmentName: "PROD" }),
				]),
			);
		}) as typeof fetch;

		await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0018"],
				tenantMap: { [TENANT_X]: "tenant-a" },
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		expect(calls).toHaveLength(1);
	});

	it("every group's batch carries the SAME signalAvailability array (availability is per pull, not per tenant)", async () => {
		const fetchImpl = (async (url: string) => {
			const decoded = decodeURIComponent(url);
			if (decoded.includes("top-nested")) {
				return okResponse(statementTableResponse([]));
			}
			return okResponse(
				splitPrimaryTableResponse([
					makeSplitRow({ aadTenantId: TENANT_X, environmentName: "PROD" }),
					makeSplitRow({ aadTenantId: TENANT_Y, environmentName: "PROD" }),
				]),
			);
		}) as typeof fetch;

		const result = await pullTelemetrySplit(
			{
				appId: APP_ID,
				signals: ["RT0005"],
				tenantMap: { [TENANT_X]: "tenant-a", [TENANT_Y]: "tenant-b" },
				unmappedTenantPolicy: "skip",
				fleetTenant: "fleet",
			},
			fetchImpl,
		);

		expect(result.groups).toHaveLength(2);
		const [g1, g2] = result.groups;
		expect(g1.batch.signalAvailability).toEqual(g2.batch.signalAvailability);
		// The statement query gets its OWN entry (Fix Round 1) — distinct
		// signalId from the aggregate RT0005 query's, so a total statement-
		// query outage is never indistinguishable from "queried, no slow SQL".
		expect(g1.batch.signalAvailability).toEqual([
			{ signalId: "RT0005", queried: true, rows: 2 },
			{
				signalId: "RT0005 statements",
				queried: true,
				rows: 0,
				truncated: false,
				unmatchedRows: 0,
			},
		]);
	});

	// -----------------------------------------------------------------------
	// Fix Round 2: N1 (unmatchedRows reaches the availability entry) and the
	// partial-query-failure truncation signal. Both exercised via non-split
	// pullTelemetry — simpler to construct, same code paths as split mode.
	// -----------------------------------------------------------------------

	it("unmatchedRows on the statement-query availability entry reflects a clientType mismatch, not silence", async () => {
		const fetchImpl = (async (url: string) => {
			const decoded = decodeURIComponent(url);
			if (decoded.includes("top-nested")) {
				return okResponse(
					statementTableResponse([
						makeStatementRow({
							clientType: "Background",
							aadTenantId: "",
							sqlStatement: 'SELECT "a" FROM dbo."CRONUS$Sales Header"',
						}),
					]),
				);
			}
			// The aggregate RT0005 query: one signal, but under a DIFFERENT
			// clientType than the statement row above.
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
				"WebClient",
			];
			return okResponse(primaryTableResponse([row]));
		}) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0005"] },
			fetchImpl,
		);

		// Strict clientType matching is unchanged: no evidence attaches.
		expect(batch.signals[0]?.sqlEvidence).toBeUndefined();
		// But the mismatch is now OBSERVABLE, rather than looking identical to
		// a genuinely clean "no slow SQL" result.
		const avail = batch.signalAvailability?.find(
			(a) => a.signalId === "RT0005 statements",
		);
		expect(avail?.unmatchedRows).toBe(1);
	});

	it("sets truncated from a partial-query-failure marker in the JSON body, even with a small row count", async () => {
		const fetchImpl = (async (url: string) => {
			const decoded = decodeURIComponent(url);
			if (decoded.includes("top-nested")) {
				return okResponse({
					tables: [
						{
							name: "PrimaryTable",
							columns: STATEMENT_COLUMNS,
							rows: [
								makeStatementRow({
									aadTenantId: "",
									sqlStatement: 'SELECT "a" FROM dbo."CRONUS$Sales Header"',
								}),
							],
						},
					],
					// The App Insights REST API's actual truncation signal: HTTP 200
					// with an `error` property alongside `tables` — not a row count
					// anywhere near APPINSIGHTS_QUERY_ROW_CAP.
					error: {
						code: "PartialError",
						message: "The results might be incomplete.",
					},
				});
			}
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0005"] },
			fetchImpl,
		);

		const avail = batch.signalAvailability?.find(
			(a) => a.signalId === "RT0005 statements",
		);
		expect(avail?.rows).toBe(1); // far below the row-cap constant
		expect(avail?.truncated).toBe(true);
	});

	it("truncated stays false for a small, complete response carrying no partial-failure marker", async () => {
		const fetchImpl = (async (url: string) => {
			const decoded = decodeURIComponent(url);
			if (decoded.includes("top-nested")) {
				return okResponse(statementTableResponse([]));
			}
			return okResponse(primaryTableResponse([]));
		}) as typeof fetch;

		const batch = await pullTelemetry(
			{ appId: APP_ID, signals: ["RT0005"] },
			fetchImpl,
		);

		const avail = batch.signalAvailability?.find(
			(a) => a.signalId === "RT0005 statements",
		);
		expect(avail?.truncated).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// listTenants (list-tenants plan, Task 1): tenant-discovery query for
// --split-by-customer onboarding — one KQL query grouped by aadTenantId
// (not by routine), reusing the same env-var/signal-id validation and
// --since canonicalization as pullTelemetry.
// ---------------------------------------------------------------------------

const LIST_TENANTS_COLUMNS = [
	{ name: "aadTenantId", type: "string" },
	{ name: "rows", type: "long" },
	{ name: "environments", type: "dynamic" },
];

function listTenantsResponse(rows: unknown[][]) {
	return {
		tables: [{ name: "PrimaryTable", columns: LIST_TENANTS_COLUMNS, rows }],
	};
}

describe("listTenants — KQL shape and request pinning", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("summarizes by aadTenantId with make_set(environmentName), splices validated signal ids, canonicalizes --since, x-api-key header only", async () => {
		const calls: Array<[string, RequestInit | undefined]> = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			calls.push([url, init]);
			return okResponse(listTenantsResponse([]));
		}) as typeof fetch;

		await listTenants(
			{
				appId: APP_ID,
				since: "2026-01-01T08:00:00.000Z",
				signals: ["RT0018", "RT0005"],
			},
			fetchImpl,
		);

		expect(calls).toHaveLength(1);
		const [url, init] = calls[0];
		expect(url).not.toContain(DECOY_KEY);
		const decoded = decodeURIComponent(url);
		expect(decoded).toContain(
			"| where timestamp > datetime(2026-01-01T08:00:00.000Z)",
		);
		expect(decoded).toContain(
			'customDimensions.eventId in ("RT0018", "RT0005")',
		);
		expect(decoded).toContain("make_set(environmentName)");
		expect(decoded).toMatch(/\bby\b[^\n]*aadTenantId/);

		const headers = init?.headers as Record<string, string>;
		expect(Object.keys(headers)).toEqual(["x-api-key"]);
		expect(headers["x-api-key"]).toBe(DECOY_KEY);
	});

	it("rejects an invalid signal id before any fetch call (same SIGNAL_ID_RE as pullTelemetry)", async () => {
		let fetchCalled = false;
		const fetchImpl = (async () => {
			fetchCalled = true;
			throw new Error("fetch should not be called");
		}) as typeof fetch;

		await expect(
			listTenants({ appId: APP_ID, signals: ["bad;signal"] }, fetchImpl),
		).rejects.toThrow(/invalid signal id/i);
		expect(fetchCalled).toBe(false);
	});
});

describe("listTenants — missing API key env var", () => {
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("names the env var and makes zero fetch calls", async () => {
		delete process.env[DEFAULT_API_KEY_ENV];
		let fetchCalled = false;
		const fetchImpl = (async () => {
			fetchCalled = true;
			throw new Error("fetch should not be called");
		}) as typeof fetch;

		await expect(listTenants({ appId: APP_ID }, fetchImpl)).rejects.toThrow(
			/APPINSIGHTS_API_KEY/,
		);
		expect(fetchCalled).toBe(false);
	});
});

describe("listTenants — row normalization", () => {
	beforeEach(() => {
		process.env[DEFAULT_API_KEY_ENV] = DECOY_KEY;
	});
	afterEach(() => {
		delete process.env[DEFAULT_API_KEY_ENV];
	});

	it("maps columns by NAME; aadTenantId carried verbatim including empty and non-GUID values", async () => {
		const rows = [
			[
				"11111111-1111-1111-1111-111111111111",
				5,
				JSON.stringify(["PROD", "SANDBOX"]),
			],
			["", 2, JSON.stringify([""])],
			["common", 1, JSON.stringify(["Sandbox"])],
		];
		const fetchImpl = (async () =>
			okResponse(listTenantsResponse(rows))) as typeof fetch;

		const result = await listTenants(
			{ appId: APP_ID, signals: ["RT0018"] },
			fetchImpl,
		);

		expect(result).toHaveLength(3);
		expect(result[0]).toEqual({
			aadTenantId: "11111111-1111-1111-1111-111111111111",
			rows: 5,
			environments: ["PROD", "SANDBOX"],
		});
		expect(result[1].aadTenantId).toBe("");
		expect(result[1].rows).toBe(2);
		expect(result[2].aadTenantId).toBe("common");
	});

	it("parses a make_set cell arriving as a JSON-array string", async () => {
		const rows = [["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", 3, '["A","B"]']];
		const fetchImpl = (async () =>
			okResponse(listTenantsResponse(rows))) as typeof fetch;

		const result = await listTenants(
			{ appId: APP_ID, signals: ["RT0018"] },
			fetchImpl,
		);

		expect(result[0].environments).toEqual(["A", "B"]);
	});

	it("falls back to [String(cell)] when a string cell isn't valid JSON", async () => {
		const rows = [["bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", 1, "not-json"]];
		const fetchImpl = (async () =>
			okResponse(listTenantsResponse(rows))) as typeof fetch;

		const result = await listTenants(
			{ appId: APP_ID, signals: ["RT0018"] },
			fetchImpl,
		);

		expect(result[0].environments).toEqual(["not-json"]);
	});

	it("accepts an already-parsed array cell for environments (defensive)", async () => {
		const rows = [["cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee", 4, ["X", "Y"]]];
		const fetchImpl = (async () =>
			okResponse(listTenantsResponse(rows))) as typeof fetch;

		const result = await listTenants(
			{ appId: APP_ID, signals: ["RT0018"] },
			fetchImpl,
		);

		expect(result[0].environments).toEqual(["X", "Y"]);
	});
});
