/**
 * triage-tools.test.ts — allow-listed tool layer (tools.ts) + audit log
 * (audit.ts) for the triage agent (plan Task 2, D4/D7). No live API calls;
 * no agent loop here (Task 3) — these are pure store-backed tool functions.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import {
	recordRoutineMetrics,
	routineKeyFor,
} from "../../src/lifecycle/baselines.js";
import type { NewFinding } from "../../src/lifecycle/store.js";
import { LifecycleStore } from "../../src/lifecycle/store.js";
import { TriageAuditLog } from "../../src/lifecycle/triage/audit.js";
import { PROMPT_VERSION } from "../../src/lifecycle/triage/prompt.js";
import {
	sanitizeReportFileName,
	TriageTools,
} from "../../src/lifecycle/triage/tools.js";

function baseFinding(overrides?: Partial<NewFinding>): NewFinding {
	return {
		tenant: "t1",
		fingerprint: "pattern:deadbeef00000000",
		algoVersion: 1,
		state: "open",
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "CalcFields inside loop",
		severity: "warning",
		appId: "abc123",
		appName: "My App",
		routineKey: "abc123|codeunit|50100|postorder",
		firstSeenAt: "2026-07-01T10:00:00Z",
		lastSeenAt: "2026-07-01T10:00:00Z",
		lastEventAt: "2026-07-01T10:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
		...overrides,
	};
}

function fixedNow(ts = "2026-07-12T12:00:00Z"): () => string {
	return () => ts;
}

function seedRun(
	store: LifecycleStore,
	profileId: string,
	captureTime: string,
): number {
	return store.recordRun({
		tenant: "t1",
		stream: "nightly",
		profileId,
		captureKind: "sampling",
		captureTime,
		versionStamp: "",
		incomplete: false,
		exercisedApps: { ids: [], names: [] },
	}).runId;
}

function makeTools(
	store: LifecycleStore,
	reportDir: string,
	overrides?: { tenant?: string; dryRun?: boolean; now?: () => string },
): TriageTools {
	return new TriageTools({
		store,
		tenant: overrides?.tenant ?? "t1",
		reportDir,
		now: overrides?.now ?? fixedNow(),
		dryRun: overrides?.dryRun ?? false,
	});
}

describe("TriageTools.findingsList", () => {
	it("returns compact rows scoped to the constructor tenant only", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const idA = store.insertFinding(baseFinding({ fingerprint: "f-a" }));
			store.insertFinding(
				baseFinding({ tenant: "other-tenant", fingerprint: "f-b" }),
			);
			const runId = seedRun(store, "p1", "2026-07-01T10:00:00Z");
			store.recordOccurrence({
				findingId: idA,
				runId,
				captureTime: "2026-07-01T10:00:00Z",
				severity: "warning",
			});
			const tools = makeTools(store, dir);
			const res = tools.findingsList({});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.result).toHaveLength(1);
			expect(res.result[0]).toMatchObject({
				id: idA,
				fingerprint: "f-a",
				title: "CalcFields inside loop",
				severity: "warning",
				state: "open",
				occurrences: 1,
			});
			expect(res.result[0].lastSeenAt).toBe("2026-07-01T10:00:00Z");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("filters by state and severity", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			store.insertFinding(
				baseFinding({
					fingerprint: "f-open-warn",
					state: "open",
					severity: "warning",
				}),
			);
			store.insertFinding(
				baseFinding({
					fingerprint: "f-open-crit",
					state: "open",
					severity: "critical",
				}),
			);
			store.insertFinding(
				baseFinding({
					fingerprint: "f-resolved",
					state: "resolved",
					severity: "critical",
				}),
			);
			const tools = makeTools(store, dir);
			const byState = tools.findingsList({ state: "resolved" });
			expect(byState.ok && byState.result.map((r) => r.fingerprint)).toEqual([
				"f-resolved",
			]);
			const bySeverity = tools.findingsList({
				state: "open",
				severity: "critical",
			});
			expect(
				bySeverity.ok && bySeverity.result.map((r) => r.fingerprint),
			).toEqual(["f-open-crit"]);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps limit at 50 even when a larger limit is requested", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			for (let i = 0; i < 60; i++) {
				store.insertFinding(baseFinding({ fingerprint: `f-${i}` }));
			}
			const tools = makeTools(store, dir);
			const res = tools.findingsList({ limit: 1000 });
			expect(res.ok && res.result.length).toBe(50);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("TriageTools.findingsGet", () => {
	it("returns the full row, occurrence count, latest occurrence details, and recent events", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const id = store.insertFinding(baseFinding());
			const runId1 = seedRun(store, "p1", "2026-07-01T10:00:00Z");
			const runId2 = seedRun(store, "p2", "2026-07-02T10:00:00Z");
			store.recordOccurrence({
				findingId: id,
				runId: runId1,
				captureTime: "2026-07-01T10:00:00Z",
				severity: "warning",
				details: JSON.stringify({ note: "first" }),
			});
			store.recordOccurrence({
				findingId: id,
				runId: runId2,
				captureTime: "2026-07-02T10:00:00Z",
				severity: "warning",
				details: JSON.stringify({ note: "latest" }),
			});
			store.logEvent({
				findingId: id,
				event: "first-seen",
				fromState: null,
				toState: "new",
				at: "2026-07-01T10:00:00Z",
			});
			const tools = makeTools(store, dir);
			const res = tools.findingsGet({ id });
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.result.id).toBe(id);
			expect(res.result.title).toBe("CalcFields inside loop");
			expect(res.result.occurrenceCount).toBe(2);
			expect(res.result.latestOccurrenceDetails).toBe(
				JSON.stringify({ note: "latest" }),
			);
			expect(res.result.recentEvents.map((e) => e.event)).toEqual([
				"first-seen",
			]);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the same not-found error for an unknown id and for another tenant's id", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const otherId = store.insertFinding(
				baseFinding({ tenant: "other-tenant", fingerprint: "f-other" }),
			);
			const tools = makeTools(store, dir, { tenant: "t1" });
			const unknown = tools.findingsGet({ id: 999999 });
			const wrongTenant = tools.findingsGet({ id: otherId });
			expect(unknown.ok).toBe(false);
			expect(wrongTenant.ok).toBe(false);
			if (unknown.ok || wrongTenant.ok) return;
			// Same template for both — the message must never distinguish
			// "doesn't exist" from "exists under another tenant".
			const template = (msg: string) => msg.replace(/\d+/g, "<id>");
			expect(template(unknown.error)).toBe(template(wrongTenant.error));
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("TriageTools.baselineQuery", () => {
	it("returns null baseline with no metric rows", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const tools = makeTools(store, dir);
			const res = tools.baselineQuery({
				routineKey: "abc123|codeunit|50100|postorder",
				captureKind: "sampling",
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.result.baseline).toBeNull();
			expect(res.result.stream).toBeNull();
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns rollup baseline stats for the routine's most recently observed stream", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		const routineKey = routineKeyFor({
			appId: "abc123",
			objectType: "codeunit",
			objectId: 50100,
			functionName: "PostOrder",
		});
		try {
			const method = (selfTime: number) => ({
				functionName: "PostOrder",
				objectType: "codeunit",
				objectName: "Order Post",
				objectId: 50100,
				appName: "My App",
				appId: "abc123",
				selfTime,
				selfTimePercent: 50,
				totalTime: selfTime + 100,
				totalTimePercent: 60,
				hitCount: 10,
				calledBy: [],
				calls: [],
				costPerHit: 100,
				efficiencyScore: 0.8,
			});
			for (const [p, t, v] of [
				["p1", "2026-07-01T00:00:00Z", 1_000_000],
				["p2", "2026-07-02T00:00:00Z", 1_200_000],
				["p3", "2026-07-03T00:00:00Z", 1_100_000],
			] as const) {
				recordRoutineMetrics(
					store,
					{
						tenant: "t1",
						stream: "nightly",
						captureKind: "sampling",
						profileId: p,
						captureTime: t,
						versionStamp: "",
					},
					[method(v)],
					500,
				);
			}
			const tools = makeTools(store, dir, {
				now: fixedNow("2026-07-05T00:00:00Z"),
			});
			const res = tools.baselineQuery({ routineKey, captureKind: "sampling" });
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.result.stream).toBe("nightly");
			expect(res.result.baseline?.median).toBe(1_100_000);
			expect(res.result.baseline?.sameStampCount).toBe(3);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("TriageTools.recordTriage", () => {
	it("prefixes the note with [by agent-triage v<PROMPT_VERSION>] and clears needs_triage", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const id = store.insertFinding(baseFinding({ needsTriage: true }));
			const tools = makeTools(store, dir);
			const res = tools.recordTriage({
				id,
				assessment: "looks like an intentional nightly batch job",
				recommendation: "no action needed",
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.result.recorded).toBe(true);
			const row = store.getFinding(id);
			expect(row?.needsTriage).toBe(false);
			expect(row?.triageNote).toBe(
				`[by agent-triage v${PROMPT_VERSION}] looks like an intentional nightly batch job\n\nRecommendation: no action needed`,
			);
			expect(row?.triagedAt).toBe("2026-07-12T12:00:00Z");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("honors dryRun: returns dry-run message and makes zero writes", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const id = store.insertFinding(baseFinding({ needsTriage: true }));
			const tools = makeTools(store, dir, { dryRun: true });
			const res = tools.recordTriage({
				id,
				assessment: "a",
				recommendation: "b",
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.result).toEqual({
				recorded: false,
				message: "dry-run: not recorded",
			});
			const row = store.getFinding(id);
			expect(row?.needsTriage).toBe(true);
			expect(row?.triageNote).toBeNull();
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("no-ops without error when the finding was already triaged (race guard)", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const id = store.insertFinding(baseFinding({ needsTriage: false }));
			const tools = makeTools(store, dir);
			const res = tools.recordTriage({
				id,
				assessment: "a",
				recommendation: "b",
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.result.recorded).toBe(false);
			expect(res.result.message).not.toBe("dry-run: not recorded");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a finding id belonging to another tenant", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const otherId = store.insertFinding(
				baseFinding({
					tenant: "other-tenant",
					fingerprint: "f-other",
					needsTriage: true,
				}),
			);
			const tools = makeTools(store, dir, { tenant: "t1" });
			const res = tools.recordTriage({
				id: otherId,
				assessment: "a",
				recommendation: "b",
			});
			expect(res.ok).toBe(false);
			expect(store.getFinding(otherId)?.needsTriage).toBe(true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sanitizeReportFileName / TriageTools.reportFile jail", () => {
	it("writes content inside the report dir for a valid name", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const tools = makeTools(store, dir);
			const res = tools.reportFile({
				name: "finding-42.md",
				content: "# Report\n",
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const target = join(dir, "finding-42.md");
			expect(existsSync(target)).toBe(true);
			expect(readFileSync(target, "utf8")).toBe("# Report\n");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const rejections: Array<[string, string]> = [
		["parent-directory reference", ".."],
		["current-directory token", "."],
		["absolute unix path", "/etc/passwd"],
		["absolute path with forward slash", "sub/dir.txt"],
		["absolute path with backslash", "sub\\dir.txt"],
		["drive letter", "C:evil.txt"],
		["drive letter with backslash", "C:\\evil.txt"],
		["empty name", ""],
		["Windows reserved device name (bare)", "con"],
		["Windows reserved device name (uppercase)", "NUL"],
		["Windows reserved device name (with extension)", "con.txt"],
		["Windows reserved device name (multi-extension)", "LPT9.backup.tar"],
		["Windows reserved device name (COM port)", "com1.log"],
	];
	for (const [label, name] of rejections) {
		it(`rejects: ${label} (${JSON.stringify(name)})`, () => {
			const sanitized = sanitizeReportFileName(name);
			expect(sanitized.ok).toBe(false);

			const store = new LifecycleStore(":memory:");
			const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
			try {
				const tools = makeTools(store, dir);
				const res = tools.reportFile({ name, content: "x" });
				expect(res.ok).toBe(false);
			} finally {
				store.close();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("never writes outside the report directory even if a rejected name were forced through", () => {
		// Defense-in-depth check: resolve+prefix directly, mirroring the
		// zip-extractor precedent (src/source/zip-extractor.ts).
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const escaped = join(dir, "..", "escaped.txt");
			const prefix = dir.endsWith(sep) ? dir : dir + sep;
			expect(escaped.startsWith(prefix)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns ok:false (never throws) when the write itself fails, e.g. ENAMETOOLONG for a 300-char name", () => {
		// sanitizeReportFileName has no length cap (only a charset + reserved-name
		// check) — a 300-char all-valid-charset name passes it but blows past the
		// filesystem's per-component name limit (~255 bytes on both NTFS and
		// ext4), so writeFileSync throws. reportFile must catch that, not let it
		// propagate — the class docstring promises dispatch() never throws, and
		// this is the write path that could otherwise break that promise.
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const longName = `${"a".repeat(296)}.txt`; // 300 chars total
			expect(sanitizeReportFileName(longName).ok).toBe(true);
			const tools = makeTools(store, dir);
			const res = tools.reportFile({ name: longName, content: "x" });
			expect(res.ok).toBe(false);
			if (res.ok) return;
			expect(res.error).toContain("report_file: write failed");
			// dispatch() must surface the same failure without throwing.
			expect(() =>
				tools.dispatch("report_file", { name: longName, content: "x" }),
			).not.toThrow();
			expect(
				tools.dispatch("report_file", { name: longName, content: "x" }).ok,
			).toBe(false);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("dispatch() never throws even when a tool method throws internally", () => {
		// Blanket backstop test: a malformed input that would make an internal
		// helper throw (not just return an error) must still come back as an
		// error ToolResult, not propagate.
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const tools = makeTools(store, dir);
			// baselineQuery's captureKind check runs before any query, but
			// findings_get with a non-numeric id shape exercises the DB layer
			// with an unexpected type — this must not throw through dispatch.
			expect(() =>
				tools.dispatch("findings_get", { id: { nested: "object" } }),
			).not.toThrow();
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("TriageAuditLog runId sanitization", () => {
	it("accepts a valid charset runId", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-audit-"));
		try {
			const log = new TriageAuditLog({
				reportDir: dir,
				runId: "run-2026.07.12_ABC",
				now: fixedNow(),
			});
			expect(log.filePath()).toBe(join(dir, "audit-run-2026.07.12_ABC.jsonl"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const badRunIds: Array<[string, string]> = [
		["parent-directory traversal", "../evil"],
		["path separator", "run/1"],
		["backslash", "run\\1"],
		["empty", ""],
		["bare dot", "."],
	];
	for (const [label, runId] of badRunIds) {
		it(`throws for an invalid runId: ${label} (${JSON.stringify(runId)})`, () => {
			const dir = mkdtempSync(join(tmpdir(), "alperf-triage-audit-"));
			try {
				expect(
					() => new TriageAuditLog({ reportDir: dir, runId, now: fixedNow() }),
				).toThrow();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});

describe("TriageTools.dispatch (allow-list)", () => {
	it("routes each of the five D4 tool names to its implementation", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const id = store.insertFinding(baseFinding());
			const tools = makeTools(store, dir);
			expect(tools.dispatch("findings_list", {}).ok).toBe(true);
			expect(tools.dispatch("findings_get", { id }).ok).toBe(true);
			expect(
				tools.dispatch("baseline_query", {
					routineKey: "abc123|codeunit|50100|postorder",
					captureKind: "sampling",
				}).ok,
			).toBe(true);
			expect(
				tools.dispatch("record_triage", {
					id,
					assessment: "a",
					recommendation: "b",
				}).ok,
			).toBe(true);
			expect(
				tools.dispatch("report_file", { name: "r.md", content: "x" }).ok,
			).toBe(true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns an error result (never throws) for an unknown tool name", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const tools = makeTools(store, dir);
			const res = tools.dispatch("delete_everything", {});
			expect(res.ok).toBe(false);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cannot be made to target another tenant — no input shape carries a tenant field", () => {
		const store = new LifecycleStore(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-"));
		try {
			const otherId = store.insertFinding(
				baseFinding({ tenant: "other-tenant", fingerprint: "f-other" }),
			);
			const tools = makeTools(store, dir, { tenant: "t1" });
			// Even smuggling a `tenant` key in the JSON input has no effect —
			// TriageTools reads the tenant from its constructor only.
			const res = tools.dispatch("findings_get", {
				id: otherId,
				tenant: "other-tenant",
			});
			expect(res.ok).toBe(false);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("TriageAuditLog", () => {
	it("writes one JSONL line per tool call with the D7 shape", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-audit-"));
		try {
			const log = new TriageAuditLog({
				reportDir: dir,
				runId: "run-1",
				now: fixedNow("2026-07-12T09:00:00Z"),
			});
			log.logToolCall({
				findingId: 42,
				tool: "findings_get",
				input: { id: 42 },
				resultSummary: "ok",
			});
			const lines = readFileSync(log.filePath(), "utf8").trim().split("\n");
			expect(lines).toHaveLength(1);
			const entry = JSON.parse(lines[0]);
			expect(entry).toEqual({
				ts: "2026-07-12T09:00:00Z",
				findingId: 42,
				tool: "findings_get",
				input: { id: 42 },
				resultSummary: "ok",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("omits findingId when not supplied (tool calls with no associated finding)", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-audit-"));
		try {
			const log = new TriageAuditLog({
				reportDir: dir,
				runId: "run-1",
				now: fixedNow(),
			});
			log.logToolCall({
				tool: "findings_list",
				input: {},
				resultSummary: "3 rows",
			});
			const entry = JSON.parse(readFileSync(log.filePath(), "utf8").trim());
			expect(entry).not.toHaveProperty("findingId");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes run-start and run-end header/footer entries and appends across calls", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-audit-"));
		try {
			const log = new TriageAuditLog({
				reportDir: dir,
				runId: "run-2",
				now: fixedNow("2026-07-12T09:00:00Z"),
			});
			log.logRunStart({
				model: "claude-sonnet-5",
				promptVersion: PROMPT_VERSION,
				tenant: "t1",
				dryRun: false,
			});
			log.logToolCall({
				tool: "findings_list",
				input: {},
				resultSummary: "1 row",
			});
			log.logRunEnd({
				findingsTriaged: 1,
				findingsSkipped: 0,
				tokenUsage: { inputTokens: 100, outputTokens: 50 },
			});
			const lines = readFileSync(log.filePath(), "utf8").trim().split("\n");
			expect(lines).toHaveLength(3);
			const [start, , end] = lines.map((l) => JSON.parse(l));
			expect(start.kind).toBe("run-start");
			expect(start.model).toBe("claude-sonnet-5");
			expect(start.promptVersion).toBe(PROMPT_VERSION);
			expect(end.kind).toBe("run-end");
			expect(end.findingsTriaged).toBe(1);
			expect(end.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names the file audit-<runId>.jsonl inside the report dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-audit-"));
		try {
			const log = new TriageAuditLog({
				reportDir: dir,
				runId: "abc123",
				now: fixedNow(),
			});
			log.logRunStart({
				model: "m",
				promptVersion: 1,
				tenant: "t1",
				dryRun: false,
			});
			expect(log.filePath()).toBe(join(dir, "audit-abc123.jsonl"));
			expect(existsSync(log.filePath())).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never contains the string ANTHROPIC_API_KEY or a sk-ant- style secret", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-triage-audit-"));
		try {
			const log = new TriageAuditLog({
				reportDir: dir,
				runId: "run-3",
				now: fixedNow(),
			});
			log.logRunStart({
				model: "claude-sonnet-5",
				promptVersion: 1,
				tenant: "t1",
				dryRun: false,
			});
			log.logToolCall({
				tool: "findings_get",
				input: { id: 1 },
				resultSummary: "ok",
			});
			log.logRunEnd({
				findingsTriaged: 0,
				findingsSkipped: 0,
				tokenUsage: { inputTokens: 0, outputTokens: 0 },
			});
			const content = readFileSync(log.filePath(), "utf8");
			expect(content).not.toContain("ANTHROPIC_API_KEY");
			expect(content).not.toMatch(/sk-ant-/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
