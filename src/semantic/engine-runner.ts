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
 * calls over an unchanged workspace do not re-spawn (an in-flight promise is
 * cached so concurrent callers share one run).
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import {
	type AnalyzeReport,
	type AppIdentity,
	type CoverageEntry,
	type DiagnosticContract,
	EXPECTED_ANALYZE_SCHEMA_VERSION,
	EXPECTED_INVENTORY_SCHEMA_VERSION,
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
	/**
	 * Full coverage entries from the inventory (directStatus / inheritedStatus /
	 * reasons / unknownTargets per subject) — P1b's blind-spot / matched-clean
	 * logic may need the per-routine status.
	 */
	coverage: CoverageEntry[];
	/** Convenience: just the coverage subjects (StableRoutineIds). */
	coverageSubjects: string[];
	/** The primaryApp (first app in the inventory). */
	primaryApp: AppIdentity | undefined;
	/** Engine version string. */
	alsemVersion: string;
	/** Diagnostics from both envelope payloads. */
	diagnostics: DiagnosticContract[];
	/** True when coverage was degraded (opaqueApps non-empty). */
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
// Typed errors (minor item #8)
// ---------------------------------------------------------------------------

/** Thrown by `spawnAndCollect` when a child exceeds its timeout. */
class EngineTimeoutError extends Error {
	constructor(public readonly label: string) {
		super(`al-sem ${label} timed out`);
		this.name = "EngineTimeoutError";
	}
}

// ---------------------------------------------------------------------------
// Cache (in-flight promise cache so concurrent callers share one run — #4)
// ---------------------------------------------------------------------------

const cache = new Map<string, Promise<EngineResult>>();

/** Clear the in-process result cache (used by tests). */
export function clearEngineCache(): void {
	cache.clear();
}

// ---------------------------------------------------------------------------
// Workspace detection
// ---------------------------------------------------------------------------

/**
 * Return `true` when the given path is a directory that contains an `app.json`
 * — i.e. it is a valid AL workspace suitable for al-sem fusion. Shared by the
 * CLI `analyze` command and the MCP server so the fusion gate is defined once.
 */
export function isAlWorkspaceDir(dirPath: string): boolean {
	try {
		const st = statSync(dirPath);
		if (!st.isDirectory()) return false;
		return existsSync(join(dirPath, "app.json"));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function resolveBinary(opts: RunEngineOptions): string | null {
	if (opts.engine) {
		// Accept the option as-is; existence check happens below
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
// Workspace content hash (for cache keying) — content-hash, not mtime (#5)
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

/**
 * Hash the CONTENTS of every `*.al` + `app.json` + `.alpackages` manifest under
 * the workspace. Content-hashing (vs (size,mtime)) avoids a stale cache when a
 * same-size, sub-granularity-mtime edit happens — correctness matters because
 * this cache feeds a perf analyzer.
 */
function workspaceContentHash(dir: string): string {
	const h = createHash("sha256");

	const hashFile = (path: string, label: string) => {
		let data: Buffer;
		try {
			data = readFileSync(path);
		} catch {
			return;
		}
		h.update(label);
		h.update("\0");
		h.update(String(data.byteLength));
		h.update("\0");
		h.update(data);
		h.update("\n");
	};

	for (const f of collectWorkspaceFiles(dir)) {
		hashFile(f, relative(dir, f).replace(/\\/g, "/"));
	}

	// Also include .alpackages manifests (the binary .app blobs are large; the
	// JSON manifests are the cheap identity surface).
	const pkgDir = join(dir, ".alpackages");
	if (existsSync(pkgDir)) {
		let manifests: string[];
		try {
			manifests = readdirSync(pkgDir).filter((e) => e.endsWith(".json"));
		} catch {
			manifests = [];
		}
		for (const m of manifests.sort()) {
			hashFile(join(pkgDir, m), ".alpackages/" + m);
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

interface SpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Non-null when the child was killed by a signal (exitCode is then null). */
	signalCode: string | null;
}

/**
 * Spawn a process and collect stdout/stderr. ALWAYS reaps the child (kills it on
 * timeout) so it is never orphaned. Throws `EngineTimeoutError` on timeout;
 * otherwise resolves with the collected output.
 *
 * Completion is gated on `proc.exited` (raced against the timeout) — NOT on
 * stdout EOF — so a grandchild that inherits the stdout pipe (e.g. a shim that
 * forks the real binary) cannot wedge the read. The streams are drained
 * concurrently; on a clean exit both buffers are fully read before we return.
 */
async function spawnAndCollect(
	cmd: string[],
	timeoutMs: number,
	label: string,
): Promise<SpawnResult> {
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
	});

	// Start draining both streams immediately. These resolve when the pipes hit
	// EOF (all writers — incl. inherited grandchildren — have closed them).
	const stdoutP = new Response(proc.stdout)
		.arrayBuffer()
		.catch(() => new ArrayBuffer(0));
	const stderrP = new Response(proc.stderr)
		.arrayBuffer()
		.catch(() => new ArrayBuffer(0));

	let timedOut = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutP = new Promise<void>((resolve) => {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			resolve();
		}, timeoutMs);
	});

	try {
		// Race the child's own exit against the timeout.
		await Promise.race([proc.exited, timeoutP]);

		if (timedOut) {
			// Kill the child (and best-effort its tree) so nothing is orphaned.
			try {
				proc.kill();
			} catch {
				// already exited
			}
			// Give the kill a moment to land, then stop waiting on the child so a
			// stubborn grandchild holding the pipe cannot wedge us.
			await Promise.race([
				proc.exited,
				new Promise<void>((r) => setTimeout(r, 250)),
			]);
			throw new EngineTimeoutError(label);
		}

		// Clean exit: both stream drains are now guaranteed to complete (the
		// process is gone, so all pipe writers are closed).
		const [stdoutBuf, stderrBuf] = await Promise.all([stdoutP, stderrP]);
		const stdout = new TextDecoder().decode(stdoutBuf);
		const stderr = new TextDecoder().decode(stderrBuf);
		// exitCode is null when killed by a signal; surface signalCode (#9).
		const exitCode = proc.exitCode ?? -1;
		const signalCode = (proc.signalCode as string | null) ?? null;
		return { stdout, stderr, exitCode, signalCode };
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	}
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

/** Accept a backward-compatible minor bump — degrade only on a MAJOR mismatch. */
function majorMatches(actual: string, expected: string): boolean {
	return actual.split(".")[0] === expected.split(".")[0];
}

type ParseResult<T> = { ok: true; doc: T } | { ok: false; reason: string };

function parseInventory(raw: string): ParseResult<InventoryDoc> {
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
			reason: `inventory: unexpected kind "${String(d.kind)}" (expected "routine-inventory")`,
		};
	}
	const sv = d.schemaVersion;
	if (
		typeof sv !== "string" ||
		!majorMatches(sv, EXPECTED_INVENTORY_SCHEMA_VERSION)
	) {
		return {
			ok: false,
			reason: `inventory: unsupported schemaVersion "${String(sv)}" (expected major "${EXPECTED_INVENTORY_SCHEMA_VERSION.split(".")[0]}")`,
		};
	}
	// Structural guard: payload + its arrays must exist (#3).
	const payload = d.payload as Record<string, unknown> | undefined;
	if (typeof payload !== "object" || payload === null) {
		return { ok: false, reason: "inventory: missing payload object" };
	}
	if (!Array.isArray(payload.routineInventory)) {
		return {
			ok: false,
			reason: "inventory: payload.routineInventory is not an array",
		};
	}
	if (!Array.isArray(payload.apps)) {
		return { ok: false, reason: "inventory: payload.apps is not an array" };
	}
	if (!Array.isArray(payload.coverage)) {
		return { ok: false, reason: "inventory: payload.coverage is not an array" };
	}
	if (!Array.isArray(d.diagnostics)) {
		return { ok: false, reason: "inventory: diagnostics is not an array" };
	}
	return { ok: true, doc: doc as InventoryDoc };
}

function parseAnalyze(raw: string): ParseResult<AnalyzeReport> {
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
			reason: `analyze: unexpected kind "${String(d.kind)}" (expected "analyze-report")`,
		};
	}
	const sv = d.schemaVersion;
	if (
		typeof sv !== "string" ||
		!majorMatches(sv, EXPECTED_ANALYZE_SCHEMA_VERSION)
	) {
		return {
			ok: false,
			reason: `analyze: unsupported schemaVersion "${String(sv)}" (expected major "${EXPECTED_ANALYZE_SCHEMA_VERSION.split(".")[0]}")`,
		};
	}
	// Structural guard: payload.findings + payload.summary.opaqueApps (#3).
	const payload = d.payload as Record<string, unknown> | undefined;
	if (typeof payload !== "object" || payload === null) {
		return { ok: false, reason: "analyze: missing payload object" };
	}
	if (!Array.isArray(payload.findings)) {
		return { ok: false, reason: "analyze: payload.findings is not an array" };
	}
	const summary = payload.summary as Record<string, unknown> | undefined;
	if (typeof summary !== "object" || summary === null) {
		return { ok: false, reason: "analyze: missing payload.summary object" };
	}
	if (!Array.isArray(summary.opaqueApps)) {
		return {
			ok: false,
			reason: "analyze: payload.summary.opaqueApps is not an array",
		};
	}
	if (!Array.isArray(d.diagnostics)) {
		return { ok: false, reason: "analyze: diagnostics is not an array" };
	}
	return { ok: true, doc: doc as AnalyzeReport };
}

// ---------------------------------------------------------------------------
// Exit-code / signal mapping (R2-F, #9)
// ---------------------------------------------------------------------------

function degradeFromExit(
	label: string,
	res: SpawnResult,
): EngineDisabled | null {
	const firstLine = res.stderr.split("\n")[0]?.trim() || `${label} failed`;
	// Killed by a signal (exitCode null → coerced to -1) → degrade explicitly.
	if (res.signalCode !== null) {
		return {
			disabled: true,
			reason: `al-sem ${label} killed by signal ${res.signalCode}: ${firstLine}`,
		};
	}
	// 0/1 → result available (1 only with --fail-on, which the runner never passes).
	if (res.exitCode === 0 || res.exitCode === 1) {
		return null;
	}
	// 2/3 → analysis-failure / config-error.
	if (res.exitCode === 2 || res.exitCode === 3) {
		return {
			disabled: true,
			reason: `al-sem ${label} failed (exit ${res.exitCode}): ${firstLine}`,
		};
	}
	// Anything else (incl. -1 from a missing exit code) → degrade.
	return {
		disabled: true,
		reason: `al-sem ${label} exited with code ${res.exitCode}: ${firstLine}`,
	};
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run both `alsem fingerprint --inventory-only` and `alsem analyze` for a
 * workspace directory and return the combined `EngineAnalysis`.
 *
 * Returns `{ disabled, reason }` on ANY failure — never throws.
 * Concurrent calls for the same (content-hash, schemaVersions) share one run.
 */
export function runEngine(
	workspaceDir: string,
	opts: RunEngineOptions = {},
): Promise<EngineResult> {
	// 1. Resolve + validate the binary BEFORE any cache work, so a bad spec
	//    fails fast without needing the cache key (which hashes the workspace).
	const bin = resolveBinary(opts);
	if (!bin) {
		return Promise.resolve({
			disabled: true,
			reason: "alsem binary not found (set AL_SEM_BIN or add alsem to PATH)",
		});
	}
	const binPath = bin.trim();
	// Real existence check — no space heuristic (#10). A plain command name on
	// PATH (no separators) is accepted as-is; anything path-like must exist.
	const looksLikePath =
		binPath.includes("/") ||
		binPath.includes("\\") ||
		/^[A-Za-z]:/.test(binPath);
	if (looksLikePath && !existsSync(binPath)) {
		return Promise.resolve({
			disabled: true,
			reason: `alsem binary not found at "${binPath}"`,
		});
	}

	// 2. Cache the in-flight PROMISE so concurrent callers share one run (#4).
	let key: string;
	try {
		key = cacheKey(
			workspaceDir,
			EXPECTED_INVENTORY_SCHEMA_VERSION,
			EXPECTED_ANALYZE_SCHEMA_VERSION,
		);
	} catch (e) {
		return Promise.resolve({
			disabled: true,
			reason: `failed to hash workspace: ${String(e)}`,
		});
	}

	const cached = cache.get(key);
	if (cached !== undefined) {
		return cached;
	}

	const pending = runEngineUnsafe(binPath, workspaceDir, opts).catch(
		(e): EngineResult => ({
			disabled: true,
			reason: `unexpected engine error: ${String(e)}`,
		}),
	);
	cache.set(key, pending);

	// On a disabled result, evict so a later (possibly fixed) call retries.
	void pending.then((result) => {
		if ("disabled" in result) {
			if (cache.get(key) === pending) cache.delete(key);
		}
	});

	return pending;
}

async function runEngineUnsafe(
	binPath: string,
	workspaceDir: string,
	opts: RunEngineOptions,
): Promise<EngineResult> {
	const timeoutMs = opts.timeoutMs ?? 60_000;

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

	// Promise.allSettled so BOTH children always run to completion and self-kill
	// on timeout — never orphan a sibling on a one-side failure (#1).
	const [invSettled, anaSettled] = await Promise.allSettled([
		spawnAndCollect(invCmd, timeoutMs, "fingerprint"),
		spawnAndCollect(anaCmd, timeoutMs, "analyze"),
	]);

	// Map a rejected spawn (timeout / ENOENT) → degrade.
	const rejectionReason = (
		settled: PromiseSettledResult<SpawnResult>,
		label: string,
	): string | null => {
		if (settled.status === "rejected") {
			const err = settled.reason;
			if (err instanceof EngineTimeoutError) {
				return `al-sem ${label} timed out — engine took longer than the configured timeout`;
			}
			return `al-sem ${label} spawn error: ${String(err)}`;
		}
		return null;
	};

	const invReject = rejectionReason(invSettled, "fingerprint");
	if (invReject) return { disabled: true, reason: invReject };
	const anaReject = rejectionReason(anaSettled, "analyze");
	if (anaReject) return { disabled: true, reason: anaReject };

	// Both fulfilled here.
	const invResult = (invSettled as PromiseFulfilledResult<SpawnResult>).value;
	const anaResult = (anaSettled as PromiseFulfilledResult<SpawnResult>).value;

	// Exit-code / signal mapping.
	const invExitDisabled = degradeFromExit("fingerprint", invResult);
	if (invExitDisabled) return invExitDisabled;
	const anaExitDisabled = degradeFromExit("analyze", anaResult);
	if (anaExitDisabled) return anaExitDisabled;

	// Parse envelopes.
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

	// Build EngineAnalysis.
	const allDiagnostics: DiagnosticContract[] = [
		...inv.diagnostics,
		...ana.diagnostics,
	];

	const opaqueApps = ana.payload.summary.opaqueApps ?? [];
	const coverageDegraded = opaqueApps.length > 0;

	// Sort findings deterministically by (fingerprint, id) per R2-F.
	const findings = [...ana.payload.findings].sort((a, b) => {
		const fpCmp = a.fingerprint.localeCompare(b.fingerprint);
		if (fpCmp !== 0) return fpCmp;
		return a.id.localeCompare(b.id);
	});

	const analysis: EngineAnalysis = {
		routines: inv.payload.routineInventory,
		findings,
		apps: inv.payload.apps,
		coverage: inv.payload.coverage,
		coverageSubjects: inv.payload.coverage.map((c) => c.subject),
		primaryApp: inv.payload.apps[0],
		alsemVersion: inv.alsemVersion,
		diagnostics: allDiagnostics,
		coverageDegraded,
		opaqueApps,
	};

	return analysis;
}
