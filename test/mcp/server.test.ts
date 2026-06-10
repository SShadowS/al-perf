/**
 * server.test.ts — MCP server unit tests for Task P2.2:
 *   - analyze_profile with a workspace sourcePath includes a fusion block in the
 *     JSON output (annotations + prioritized findings + summary), and that block
 *     excludes cold/orphan/unkeyable findings (R2-12).
 *   - analyze_profile WITHOUT a workspace (profile-only) → no fusion block
 *     (response byte-unchanged).
 *   - prioritized_findings tool exists, returns weighted findings + summary on a
 *     workspace path, returns { disabled } on a non-workspace path, never throws
 *     on a degraded engine.
 *
 * Fusion-enabled paths are gated on a working stub binary. The "profile-only
 * unchanged" path requires NO binary and always runs.
 *
 * Pattern: InMemoryTransport + MCP Client (mirrors tools.test.ts).
 * Stub binary: makeStubBinary() from the fusion fixture set (mirrors fuse.e2e.test.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createMcpServer } from "../../src/mcp/server.js";
import { clearEngineCache } from "../../src/semantic/engine-runner.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");
const STUB_TS = resolve(FIXTURE_DIR, "alsem-stub.ts");
const SAMPLE_PROFILE = resolve(
	import.meta.dir,
	"../fixtures/sampling-minimal.alcpuprofile",
);
const BUN_EXE = process.execPath;

// ---------------------------------------------------------------------------
// Stub binary (mirrors fuse.e2e.test.ts makeStubBinary)
// ---------------------------------------------------------------------------

let cleanups: Array<() => void> = [];
afterEach(() => {
	// Clear the per-(workspaceContentHash) engine result cache between tests. The
	// stub binary's OUTPUT changes with ALSEM_STUB_MODE but the workspace dir
	// (WS_MIN) is identical, so without this a cached "ok" (empty-findings) result
	// would be served to a later "findings"-mode test for the same workspace.
	clearEngineCache();
	for (const fn of cleanups) {
		try {
			fn();
		} catch {
			// ignore
		}
	}
	cleanups = [];
});

/**
 * Build a platform-appropriate launcher that runs the committed `alsem-stub.ts`
 * via the current bun executable in the given mode.
 *
 *  - "ok"       (default) — valid envelopes, EMPTY findings (shape-only tests).
 *  - "findings"           — non-empty findings that correlate to the
 *                           sampling-minimal fixture's hot frames (ProcessLine
 *                           self 100% → weighted; OnRun self 0% → dropped by the
 *                           R2-12 filter but kept in hotspotAnnotations).
 */
function makeStubBinary(mode: "ok" | "findings" = "ok"): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-mcp-stub-"));
	cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
	if (process.platform === "win32") {
		const cmdPath = join(tmpDir, "alsem-stub.cmd");
		writeFileSync(
			cmdPath,
			`@echo off\r\nset "ALSEM_STUB_MODE=${mode}"\r\n"${BUN_EXE}" "${STUB_TS}" %*\r\n`,
		);
		return cmdPath;
	}
	const shPath = join(tmpDir, "alsem-stub.sh");
	writeFileSync(
		shPath,
		`#!/bin/sh\nexport ALSEM_STUB_MODE='${mode}'\nexec "${BUN_EXE}" "${STUB_TS}" "$@"\n`,
	);
	chmodSync(shPath, 0o755);
	return shPath;
}

// ---------------------------------------------------------------------------
// MCP client factory
// ---------------------------------------------------------------------------

async function createTestClient(
	env?: Partial<Record<string, string>>,
	serverOptions?: { defaultSourcePath?: string },
) {
	// Set env vars BEFORE building the server (engine-runner reads process.env at
	// call time, but we need AL_SEM_BIN available when the tool handler runs).
	const prevEnv: Record<string, string | undefined> = {};
	if (env) {
		for (const [k, v] of Object.entries(env)) {
			prevEnv[k] = process.env[k];
			if (v === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = v;
			}
		}
	}

	const server = createMcpServer(serverOptions);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test-mcp-client", version: "1.0.0" });
	await client.connect(clientTransport);

	return {
		client,
		cleanup: () => {
			// Restore env
			for (const [k, v] of Object.entries(prevEnv)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		},
	};
}

type TextContent = Array<{ type: string; text: string }>;

function parseResponse(result: { content: unknown }): unknown {
	const text = (result.content as TextContent)[0].text;
	return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// analyze_profile — profile-only (no sourcePath)
// Always runs; no binary needed.
// ---------------------------------------------------------------------------

describe("analyze_profile: profile-only (no fusion)", () => {
	test("no fusion block in output when no sourcePath is provided", async () => {
		// Ensure no default source path bleeds in from the environment.
		const { client, cleanup } = await createTestClient(
			{ AL_SEM_BIN: undefined },
			{ defaultSourcePath: undefined },
		);
		try {
			const result = await client.callTool(
				{
					name: "analyze_profile",
					arguments: {
						profilePath: SAMPLE_PROFILE,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			const parsed = parseResponse(result) as Record<string, unknown>;

			// Core response is present and valid
			expect(parsed.meta).toBeDefined();
			expect(parsed.hotspots).toBeDefined();

			// No fusion key when no workspace
			expect(parsed.fusion).toBeUndefined();
			// fusionViews on AnalysisResult stays undefined too (profile-only)
			expect(parsed.fusionViews).toBeUndefined();
		} finally {
			cleanup();
		}
	}, 120_000);

	test("no unweightedFindings key anywhere in the response (R2-12)", async () => {
		const { client, cleanup } = await createTestClient(
			{ AL_SEM_BIN: undefined },
			{ defaultSourcePath: undefined },
		);
		try {
			const result = await client.callTool(
				{
					name: "analyze_profile",
					arguments: { profilePath: SAMPLE_PROFILE },
				},
				undefined,
				{ timeout: 120_000 },
			);
			const text = (result.content as TextContent)[0].text;
			// The raw JSON string must not contain the key
			expect(text).not.toContain('"unweightedFindings"');
		} finally {
			cleanup();
		}
	}, 120_000);
});

// ---------------------------------------------------------------------------
// analyze_profile — with workspace + stub binary (fusion enabled)
// ---------------------------------------------------------------------------

describe("analyze_profile: with workspace sourcePath (fusion, stub binary)", () => {
	test("includes fusion block with hotspotAnnotations + prioritizedFindings + correlationSummary", async () => {
		const stubBin = makeStubBinary();
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: stubBin,
		});
		try {
			const result = await client.callTool(
				{
					name: "analyze_profile",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			const parsed = parseResponse(result) as Record<string, unknown>;
			const fusion = parsed.fusion as Record<string, unknown> | undefined;

			// Fusion block must be present
			expect(fusion).toBeDefined();
			if (!fusion) return;

			// Must have the three trimmed fields
			expect(Array.isArray(fusion.hotspotAnnotations)).toBe(true);
			expect(Array.isArray(fusion.prioritizedFindings)).toBe(true);
			expect(fusion.correlationSummary).toBeDefined();

			// R2-12: unweightedFindings MUST NOT appear in MCP output
			expect(fusion.unweightedFindings).toBeUndefined();
			// Verify at the raw JSON level too
			const text = (result.content as TextContent)[0].text;
			expect(text).not.toContain('"unweightedFindings"');
		} finally {
			cleanup();
		}
	}, 120_000);

	test("correlationSummary has the expected counter keys", async () => {
		const stubBin = makeStubBinary();
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: stubBin,
		});
		try {
			const result = await client.callTool(
				{
					name: "analyze_profile",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			const parsed = parseResponse(result) as Record<string, unknown>;
			const summary = (parsed.fusion as Record<string, unknown>)
				?.correlationSummary as Record<string, unknown> | undefined;

			expect(summary).toBeDefined();
			if (!summary) return;
			// All CorrelationSummary fields must be present
			expect(typeof summary.matched).toBe("number");
			expect(typeof summary.matchedClean).toBe("number");
			expect(typeof summary.ambiguous).toBe("number");
			expect(typeof summary.blindSpot).toBe("number");
			expect(typeof summary.coldCount).toBe("number");
			expect(typeof summary.unkeyableCount).toBe("number");
			expect(typeof summary.orphanCount).toBe("number");
		} finally {
			cleanup();
		}
	}, 120_000);

	test("core response (meta, hotspots, patterns) is present alongside the fusion block", async () => {
		const stubBin = makeStubBinary();
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: stubBin,
		});
		try {
			const result = await client.callTool(
				{
					name: "analyze_profile",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			const parsed = parseResponse(result) as Record<string, unknown>;

			// Core fields unchanged
			expect(parsed.meta).toBeDefined();
			expect(parsed.hotspots).toBeDefined();
			expect(parsed.patterns).toBeDefined();
			// AND fusion block is also present
			expect(parsed.fusion).toBeDefined();
		} finally {
			cleanup();
		}
	}, 120_000);

	test("fusion block absent when binary is unavailable (graceful degradation)", async () => {
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: "/nonexistent/alsem-binary-xyz",
		});
		try {
			const result = await client.callTool(
				{
					name: "analyze_profile",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			// Must NOT be an error
			expect(result.isError).toBeFalsy();
			const parsed = parseResponse(result) as Record<string, unknown>;
			// No fusion block (engine disabled) but core analysis still present
			expect(parsed.meta).toBeDefined();
			expect(parsed.fusion).toBeUndefined();
		} finally {
			cleanup();
		}
	}, 120_000);

	// --- Real (non-empty) findings via the "findings" stub mode ---
	test("fusion block has a POPULATED hotspotAnnotations entry with a correlated finding (findings stub)", async () => {
		const stubBin = makeStubBinary("findings");
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: stubBin,
		});
		try {
			const result = await client.callTool(
				{
					name: "analyze_profile",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			const parsed = parseResponse(result) as Record<string, unknown>;
			const fusion = parsed.fusion as Record<string, unknown>;
			expect(fusion).toBeDefined();

			// hotspotAnnotations must carry the ProcessLine annotation WITH its
			// correlated finding (proves annotateHotspots ran on real findings).
			const annotations = fusion.hotspotAnnotations as Array<
				Record<string, unknown>
			>;
			const procAnn = annotations.find(
				(a) => a.attrKey === "ProcessLine_CodeUnit_50000",
			);
			expect(procAnn).toBeDefined();
			expect(procAnn?.status).toBe("matched");
			const procFindings = procAnn?.findings as Array<Record<string, unknown>>;
			expect(procFindings.length).toBeGreaterThan(0);
			expect(procFindings.some((f) => f.id === "F-PROC")).toBe(true);

			// prioritizedFindings must contain the hot-leaf finding with selfTime>0.
			const prioritized = fusion.prioritizedFindings as Array<
				Record<string, unknown>
			>;
			expect(prioritized.length).toBeGreaterThan(0);
			const fProc = prioritized.find(
				(p) => (p.finding as Record<string, unknown>).id === "F-PROC",
			);
			expect(fProc).toBeDefined();
			expect(fProc?.selfTimePercent as number).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	}, 120_000);

	test("R2-12 through MCP: a matched zero-self finding is NOT inlined in prioritizedFindings but IS in hotspotAnnotations (findings stub)", async () => {
		const stubBin = makeStubBinary("findings");
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: stubBin,
		});
		try {
			const result = await client.callTool(
				{
					name: "analyze_profile",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			const parsed = parseResponse(result) as Record<string, unknown>;
			const fusion = parsed.fusion as Record<string, unknown>;

			// OnRun is matched but selfTimePercent 0 → its finding (F-ONRUN) must NOT
			// be in the weighted prioritizedFindings list (R2-12 self-time>0 filter).
			const prioritized = fusion.prioritizedFindings as Array<
				Record<string, unknown>
			>;
			const onrunWeighted = prioritized.find(
				(p) => (p.finding as Record<string, unknown>).id === "F-ONRUN",
			);
			expect(onrunWeighted).toBeUndefined();
			// Every weighted row is strictly selfTime>0.
			expect(prioritized.every((p) => (p.selfTimePercent as number) > 0)).toBe(
				true,
			);

			// But it IS honestly visible in hotspotAnnotations on the OnRun hotspot.
			const annotations = fusion.hotspotAnnotations as Array<
				Record<string, unknown>
			>;
			const onrunAnn = annotations.find(
				(a) => a.attrKey === "OnRun_CodeUnit_50000",
			);
			expect(onrunAnn).toBeDefined();
			const onrunFindings = onrunAnn?.findings as Array<
				Record<string, unknown>
			>;
			expect(onrunFindings.some((f) => f.id === "F-ONRUN")).toBe(true);
		} finally {
			cleanup();
		}
	}, 120_000);
});

// ---------------------------------------------------------------------------
// prioritized_findings tool
// ---------------------------------------------------------------------------

describe("prioritized_findings tool", () => {
	test("tool is registered (server exposes it)", async () => {
		const { client, cleanup } = await createTestClient();
		try {
			const tools = await client.listTools();
			const names = tools.tools.map((t) => t.name);
			expect(names).toContain("prioritized_findings");
		} finally {
			cleanup();
		}
	});

	test("returns weighted findings + correlationSummary on a workspace path (stub binary)", async () => {
		const stubBin = makeStubBinary();
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: stubBin,
		});
		try {
			const result = await client.callTool(
				{
					name: "prioritized_findings",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
						top: 10,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			expect(result.isError).toBeFalsy();
			const parsed = parseResponse(result) as Record<string, unknown>;

			// Must return prioritizedFindings and correlationSummary (R2-12 contract)
			expect(Array.isArray(parsed.prioritizedFindings)).toBe(true);
			expect(parsed.correlationSummary).toBeDefined();

			// R2-12: unweightedFindings MUST NOT appear
			expect(parsed.unweightedFindings).toBeUndefined();
			const text = (result.content as TextContent)[0].text;
			expect(text).not.toContain('"unweightedFindings"');

			// All prioritized findings must have selfTimePercent >= 0
			// (weighted means they have a real runtime sample)
			const findings = parsed.prioritizedFindings as Array<
				Record<string, unknown>
			>;
			expect(findings.every((f) => typeof f.selfTimePercent === "number")).toBe(
				true,
			);
		} finally {
			cleanup();
		}
	}, 120_000);

	test("returns { disabled: 'no AL workspace' } for a non-workspace sourcePath", async () => {
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: "/nonexistent/alsem",
		});
		try {
			const result = await client.callTool(
				{
					name: "prioritized_findings",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						// FIXTURE_DIR has no app.json → not a workspace
						sourcePath: FIXTURE_DIR,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			expect(result.isError).toBeFalsy();
			const parsed = parseResponse(result) as Record<string, unknown>;
			expect(parsed.disabled).toBe("no AL workspace");
		} finally {
			cleanup();
		}
	}, 120_000);

	test("returns { disabled: reason } when the engine is unavailable", async () => {
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: "/nonexistent/alsem-xyz",
		});
		try {
			const result = await client.callTool(
				{
					name: "prioritized_findings",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			expect(result.isError).toBeFalsy();
			const parsed = parseResponse(result) as Record<string, unknown>;
			expect(typeof parsed.disabled).toBe("string");
			expect((parsed.disabled as string).length).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	}, 120_000);

	test("never throws on a degraded engine (never isError=true for engine issues)", async () => {
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: "/nonexistent/alsem-xyz",
		});
		try {
			const result = await client.callTool(
				{
					name: "prioritized_findings",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			// isError must NOT be true (engine-unavailable is a graceful disable, not an error)
			expect(result.isError).toBeFalsy();
		} finally {
			cleanup();
		}
	}, 120_000);

	test("respects the top parameter (ok stub, empty findings)", async () => {
		// "ok" stub returns 0 findings; with real data this would limit results.
		// Verify no error and the field types are correct.
		const stubBin = makeStubBinary();
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: stubBin,
		});
		try {
			const result = await client.callTool(
				{
					name: "prioritized_findings",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
						top: 5,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			expect(result.isError).toBeFalsy();
			const parsed = parseResponse(result) as Record<string, unknown>;
			const findings = parsed.prioritizedFindings as unknown[];
			expect(Array.isArray(findings)).toBe(true);
			// Stub returns no findings → length = 0 (≤ top of 5)
			expect(findings.length).toBeLessThanOrEqual(5);
		} finally {
			cleanup();
		}
	}, 120_000);

	// --- Real (non-empty) findings via the "findings" stub mode ---
	test("returns a NON-EMPTY prioritizedFindings with selfTimePercent>0 (findings stub)", async () => {
		const stubBin = makeStubBinary("findings");
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: stubBin,
		});
		try {
			const result = await client.callTool(
				{
					name: "prioritized_findings",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
						top: 10,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			expect(result.isError).toBeFalsy();
			const parsed = parseResponse(result) as Record<string, unknown>;
			const findings = parsed.prioritizedFindings as Array<
				Record<string, unknown>
			>;
			// Non-empty: the ProcessLine finding is weighted.
			expect(findings.length).toBeGreaterThan(0);
			// R2-12: every returned row is strictly self-time>0.
			expect(findings.every((f) => (f.selfTimePercent as number) > 0)).toBe(
				true,
			);
			// The hot-leaf finding is present; the zero-self orchestrator one is not.
			const ids = findings.map(
				(f) => (f.finding as Record<string, unknown>).id,
			);
			expect(ids).toContain("F-PROC");
			expect(ids).not.toContain("F-ONRUN");
		} finally {
			cleanup();
		}
	}, 120_000);

	test("the top param truncates the returned findings (findings stub)", async () => {
		const stubBin = makeStubBinary("findings");
		const { client, cleanup } = await createTestClient({
			AL_SEM_BIN: stubBin,
		});
		try {
			const result = await client.callTool(
				{
					name: "prioritized_findings",
					arguments: {
						profilePath: SAMPLE_PROFILE,
						sourcePath: WS_MIN,
						top: 1,
					},
				},
				undefined,
				{ timeout: 120_000 },
			);
			expect(result.isError).toBeFalsy();
			const parsed = parseResponse(result) as Record<string, unknown>;
			const findings = parsed.prioritizedFindings as unknown[];
			// top:1 → at most 1 finding (the weighted set is exactly {F-PROC}).
			expect(findings.length).toBeLessThanOrEqual(1);
			expect(findings.length).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	}, 120_000);

	test("returns error for a non-existent profile path", async () => {
		const { client, cleanup } = await createTestClient();
		try {
			const result = await client.callTool({
				name: "prioritized_findings",
				arguments: {
					profilePath: "non-existent.alcpuprofile",
					sourcePath: WS_MIN,
				},
			});
			expect(result.isError).toBe(true);
			const text = (result.content as TextContent)[0].text;
			expect(text).toContain("Error");
		} finally {
			cleanup();
		}
	});
});
