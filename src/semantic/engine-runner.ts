/**
 * engine-runner.ts — CLI boundary between al-perf and the `alsem` engine.
 *
 * Makes TWO subprocess calls (per R2-A):
 *   1. `alsem fingerprint <ws> --inventory-only --format json --deterministic`
 *      → InventoryDoc  (routine universe: apps, routineInventory, coverage, …)
 *   2. `alsem analyze <ws> --format json --deterministic`
 *      → AnalyzeReport (findings[])
 *
 * Returns EngineAnalysis or { disabled, reason } — NEVER throws.
 * Results are cached per (workspaceContentHash, schemaVersions) so repeated
 * calls over an unchanged workspace do not re-spawn.
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import {
	EXPECTED_ANALYZE_SCHEMA_VERSION,
	EXPECTED_INVENTORY_SCHEMA_VERSION,
	type AnalyzeReport,
	type AppIdentity,
	type DiagnosticContract,
	type FindingSummary,
	type InventoryDoc,
	type RoutineIdentity,
} from "./contracts.js";

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** A successfully parsed result from the engine. */
export interface EngineAnalysis {
	/** Routines from the inventory projection. */
	routines: RoutineIdentity[];
	/** Findings from the analyze run. */
	findings: FindingSummary[];
	/** App identities from the inventory. */
	apps: AppIdentity[];
	/** Raw coverage entries (string[]) — subjects with coverage status. */
	coverage: string[];
	/** The primaryApp (first app in the inventory). */
	primaryApp: AppIdentity | undefined;
	/** Engine version string. */
	alsemVersion: string;
	/** Diagnostics from both envelope payloads. */
	diagnostics: DiagnosticContract[];
	/** True when coverage was degraded (opaqueApps non-empty or degraded). */
	coverageDegraded: boolean;
	/** Opaque app GUIDs (from analyze summary). */
	opaqueApps: string[];
}

/** Returned when the engine is unavailable or analysis failed non-fatally. */
export interface EngineDisabled {
	disabled: true;
	reason: string;
}

export type EngineResult = EngineAnalysis | EngineDisabled;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunEngineOptions {
	/**
	 * Explicit path to the `alsem` binary.
	 * Falls back to `AL_SEM_BIN` env, then `alsem` on PATH.
	 */
	engine?: string;
	/** Subprocess timeout in milliseconds. Default: 60_000. */
	timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, EngineAnalysis>();

/** Clear the in-process result cache (used by tests). */
export function clearEngineCache(): void {
	cache.clear();
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function resolveBinary(opts: RunEngineOptions): string | null {
	if (opts.engine) {
		// Accept the option as-is; existence check happens at spawn time
		return opts.engine;
	}
	const envBin = process.env.AL_SEM_BIN;
	if (envBin) return envBin;

	// Try alsem on PATH (Bun.which is not always available; use a simple check)
	try {
		const which = Bun.which("alsem");
		if (which) return which;
	} catch {
		// Bun.which not available
	}
	return null;
}

// ---------------------------------------------------------------------------
// Workspace content hash (for cache keying)
// ---------------------------------------------------------------------------

function collectWorkspaceFiles(dir: string): string[] {
	const files: string[] = [];
	function walk(d: string) {
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry === "node_modules" || entry === ".alpackages") continue;
			const full = join(d, entry);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(full);
			} else if (
				entry.endsWith(".al") ||
				entry === "app.json" ||
				entry === "app.manifest"
			) {
				files.push(full);
			}
		}
	}
	walk(dir);
	return files.sort();
}

function workspaceContentHash(dir: string): string {
	const files = collectWorkspaceFiles(dir);
	const h = createHash("sha256");
	for (const f of files) {
		let st;
		try {
			st = statSync(f);
		} catch {
			continue;
		}
		h.update(relative(dir, f));
		h.update(":");
		h.update(String(st.size));
		h.update(":");
		h.update(String(st.mtimeMs));
		h.update("\n");
	}
	// Also include .alpackages manifests
	const pkgDir = join(dir, ".alpackages");
	if (existsSync(pkgDir)) {
		let manifests: string[];
		try {
			manifests = readdirSync(pkgDir).filter((e) => e.endsWith(".json"));
		} catch {
			manifests = [];
		}
		for (const m of manifests.sort()) {
			try {
				const st = statSync(join(pkgDir, m));
				h.update(".alpackages/" + m + ":" + st.size + ":" + st.mtimeMs + "\n");
			} catch {
				// skip
			}
		}
	}
	return h.digest("hex");
}

function cacheKey(
	workspaceDir: string,
	inventorySchema: string,
	analyzeSchema: string,
): string {
	return `${workspaceContentHash(workspaceDir)}|${inventorySchema}|${analyzeSchema}`;
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

/** Spawn a process and collect stdout/stderr. Resolves with { stdout, stderr, exitCode }. */
async function spawnAndCollect(
	cmd: string[],
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill();
		} catch {
			// already exited
		}
	}, timeoutMs);

	const [stdoutBuf, stderrBuf] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).arrayBuffer(),
	]);
	await proc.exited;
	clearTimeout(timeoutHandle);

	if (timedOut) {
		throw new Error("TIMEOUT");
	}

	const stdout = new TextDecoder().decode(stdoutBuf);
	const stderr = new TextDecoder().decode(stderrBuf);
	const exitCode = proc.exitCode ?? 1;
	return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

function parseInventory(
	raw: string,
): { ok: true; doc: InventoryDoc } | { ok: false; reason: string } {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		return { ok: false, reason: `inventory JSON parse error: ${String(e)}` };
	}
	if (typeof doc !== "object" || doc === null) {
		return { ok: false, reason: "inventory: expected JSON object" };
	}
	const d = doc as Record<string, unknown>;
	if (d.kind !== "routine-inventory") {
		return {
			ok: false,
			reason: `inventory: unexpected kind "${d.kind}" (expected "routine-inventory")`,
		};
	}
	const sv = d.schemaVersion;
	if (typeof sv !== "string" || sv !== EXPECTED_INVENTORY_SCHEMA_VERSION) {
		return {
			ok: false,
			reason: `inventory: unsupported schemaVersion "${sv}" (expected "${EXPECTED_INVENTORY_SCHEMA_VERSION}")`,
		};
	}
	return { ok: true, doc: doc as InventoryDoc };
}

function parseAnalyze(
	raw: string,
): { ok: true; doc: AnalyzeReport } | { ok: false; reason: string } {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		return { ok: false, reason: `analyze JSON parse error: ${String(e)}` };
	}
	if (typeof doc !== "object" || doc === null) {
		return { ok: false, reason: "analyze: expected JSON object" };
	}
	const d = doc as Record<string, unknown>;
	if (d.kind !== "analyze-report") {
		return {
			ok: false,
			reason: `analyze: unexpected kind "${d.kind}" (expected "analyze-report")`,
		};
	}
	const sv = d.schemaVersion;
	if (typeof sv !== "string" || sv !== EXPECTED_ANALYZE_SCHEMA_VERSION) {
		return {
			ok: false,
			reason: `analyze: unsupported schemaVersion "${sv}" (expected "${EXPECTED_ANALYZE_SCHEMA_VERSION}")`,
		};
	}
	return { ok: true, doc: doc as AnalyzeReport };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run both `alsem fingerprint --inventory-only` and `alsem analyze` for a
 * workspace directory and return the combined `EngineAnalysis`.
 *
 * Returns `{ disabled, reason }` on ANY failure — never throws.
 */
export async function runEngine(
	workspaceDir: string,
	opts: RunEngineOptions = {},
): Promise<EngineResult> {
	try {
		return await runEngineUnsafe(workspaceDir, opts);
	} catch (e) {
		return { disabled: true, reason: `unexpected engine error: ${String(e)}` };
	}
}

async function runEngineUnsafe(
	workspaceDir: string,
	opts: RunEngineOptions,
): Promise<EngineResult> {
	const timeoutMs = opts.timeoutMs ?? 60_000;

	// 1. Resolve binary
	const bin = resolveBinary(opts);
	if (!bin) {
		return {
			disabled: true,
			reason: "alsem binary not found (set AL_SEM_BIN or add alsem to PATH)",
		};
	}

	// 2. Check if the binary path looks like it could exist (basic heuristic)
	//    We only check for plain paths (not paths with spaces that might be
	//    "bun script.ts" style). If the binary is a plain path, check existence.
	const binPath = bin.trim();
	const looksLikePath =
		binPath.startsWith("/") ||
		binPath.startsWith("\\") ||
		/^[A-Za-z]:[/\\]/.test(binPath) ||
		(!binPath.includes(" ") && !binPath.startsWith("bun "));
	if (looksLikePath && !existsSync(binPath)) {
		return {
			disabled: true,
			reason: `alsem binary not found at "${binPath}"`,
		};
	}

	// 3. Cache check — compute key using EXPECTED schema versions
	const key = cacheKey(
		workspaceDir,
		EXPECTED_INVENTORY_SCHEMA_VERSION,
		EXPECTED_ANALYZE_SCHEMA_VERSION,
	);
	const cached = cache.get(key);
	if (cached !== undefined) {
		return cached;
	}

	// 4. Spawn both processes in parallel
	const invCmd = [
		binPath,
		"fingerprint",
		workspaceDir,
		"--inventory-only",
		"--format",
		"json",
		"--deterministic",
	];
	const anaCmd = [
		binPath,
		"analyze",
		workspaceDir,
		"--format",
		"json",
		"--deterministic",
	];

	let invResult: { stdout: string; stderr: string; exitCode: number };
	let anaResult: { stdout: string; stderr: string; exitCode: number };

	try {
		[invResult, anaResult] = await Promise.all([
			spawnAndCollect(invCmd, timeoutMs),
			spawnAndCollect(anaCmd, timeoutMs),
		]);
	} catch (e) {
		const msg = String(e);
		if (msg === "Error: TIMEOUT" || msg.includes("TIMEOUT")) {
			return {
				disabled: true,
				reason:
					"al-sem timed out — engine took longer than the configured timeout",
			};
		}
		return { disabled: true, reason: `engine spawn error: ${msg}` };
	}

	// 5. Exit-code mapping (R2-F)
	//    0/1 → result available (1 only when --fail-on was passed; runner doesn't use it)
	//    2/3 → degrade + reason from stderr
	//    Other → degrade
	for (const [label, res] of [
		["fingerprint", invResult],
		["analyze", anaResult],
	] as [string, typeof invResult][]) {
		if (res.exitCode === 2 || res.exitCode === 3) {
			const firstLine = res.stderr.split("\n")[0]?.trim() ?? `${label} failed`;
			return {
				disabled: true,
				reason: `al-sem ${label} failed (exit ${res.exitCode}): ${firstLine}`,
			};
		}
		if (res.exitCode > 3) {
			const firstLine = res.stderr.split("\n")[0]?.trim() ?? `${label} failed`;
			return {
				disabled: true,
				reason: `al-sem ${label} exited with code ${res.exitCode}: ${firstLine}`,
			};
		}
	}

	// 6. Parse envelopes
	const invParsed = parseInventory(invResult.stdout);
	if (!invParsed.ok) {
		return { disabled: true, reason: invParsed.reason };
	}
	const anaParsed = parseAnalyze(anaResult.stdout);
	if (!anaParsed.ok) {
		return { disabled: true, reason: anaParsed.reason };
	}

	const inv = invParsed.doc;
	const ana = anaParsed.doc;

	// 7. Build EngineAnalysis
	const allDiagnostics: DiagnosticContract[] = [
		...inv.diagnostics,
		...ana.diagnostics,
	];

	const opaqueApps = ana.payload.summary.opaqueApps ?? [];
	const coverageDegraded = opaqueApps.length > 0;

	// Sort findings deterministically by (fingerprint, id) per R2-F
	const findings = [...ana.payload.findings].sort((a, b) => {
		const fpCmp = a.fingerprint.localeCompare(b.fingerprint);
		if (fpCmp !== 0) return fpCmp;
		return a.id.localeCompare(b.id);
	});

	const analysis: EngineAnalysis = {
		routines: inv.payload.routineInventory,
		findings,
		apps: inv.payload.apps,
		coverage: inv.payload.coverage.map((c) => c.subject),
		primaryApp: inv.payload.apps[0],
		alsemVersion: inv.alsemVersion,
		diagnostics: allDiagnostics,
		coverageDegraded,
		opaqueApps,
	};

	// 8. Cache and return
	cache.set(key, analysis);
	return analysis;
}
