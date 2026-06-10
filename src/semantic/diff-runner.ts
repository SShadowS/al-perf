/**
 * diff-runner.ts — Invoke `alsem diff` + `alsem fingerprint --inventory-only`
 * for a before/after workspace pair and return a typed `DiffAnalysis`.
 *
 * Pattern mirrors engine-runner.ts: never throws → returns
 * `DiffAnalysis | EngineDisabled`. Schema-pinned to EXPECTED_DIFF_SCHEMA_VERSION.
 *
 * P4.0b — Revision 2 spec (PR2-1..PR2-8).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
	EXPECTED_INVENTORY_SCHEMA_VERSION,
	type RoutineIdentity,
} from "./contracts.js";
import type { EngineDisabled, RunEngineOptions } from "./engine-runner.js";
// Re-use the internal spawn helper from engine-runner by re-implementing a
// minimal version here.  We cannot import the private `spawnAndCollect` from
// engine-runner, so we duplicate the pattern for the diff invocation.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The schemaVersion emitted by `alsem diff`. */
export const EXPECTED_DIFF_SCHEMA_VERSION = "1.0.0";

/** A single finding from `alsem diff payload.findings[]`. */
export interface DiffDelta {
	id: string;
	/** "abi" | "schema" | "events" | "capabilities" | "permissions" */
	category: string;
	/**
	 * The finding kind (e.g. "capability-gained-write", "procedure-added").
	 * This is the `kind` field on the top-level finding object in the diff
	 * envelope (mirrors `details.kind` for most capabilities).
	 */
	kind: string;
	severity: string;
	/** :-form stableId. Prefer `newStableId` for the after-WS join. */
	normalizedStableId: string;
	/** Present for renamed routines — the new after-WS stableId. */
	newStableId?: string;
	/** Display-friendly routine name. */
	displayName: string;
	/** From `details.resourceKind` (e.g. "table", "http"). */
	resourceKind?: string;
	/** From `details.resourceId`. */
	resourceId?: string;
	/** From `details.op` (e.g. "insert", "send"). */
	op?: string;
}

/** The parsed diff-report + after-WS inventory + workspace versions. */
export interface DiffAnalysis {
	/** Findings in ENGINE ORDER (never sorted here — determinism via PR2-8). */
	findings: DiffDelta[];
	/** Routines from the after-WS inventory (for the stableId→method join). */
	afterInventory: RoutineIdentity[];
	/** Version string from the before-workspace app.json (`version` field). */
	beforeAppVersion: string | undefined;
	/** Version string from the after-workspace app.json (`version` field). */
	afterAppVersion: string | undefined;
	/** Engine version string from the diff envelope. */
	alsemVersion: string;
}

export type DiffResult = DiffAnalysis | EngineDisabled;

// ---------------------------------------------------------------------------
// Helpers (minimal re-implementation of engine-runner's spawn pattern)
// ---------------------------------------------------------------------------

/** Accept a backward-compatible minor bump — degrade only on a MAJOR mismatch. */
function majorMatches(actual: string, expected: string): boolean {
	return actual.split(".")[0] === expected.split(".")[0];
}

interface SpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	signalCode: string | null;
}

async function spawnCollect(
	cmd: string[],
	timeoutMs: number,
	label: string,
): Promise<SpawnResult> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });

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
		await Promise.race([proc.exited, timeoutP]);
		if (timedOut) {
			try {
				proc.kill();
			} catch {
				// already exited
			}
			await Promise.race([
				proc.exited,
				new Promise<void>((r) => setTimeout(r, 250)),
			]);
			throw new Error(`al-sem ${label} timed out`);
		}
		const [stdoutBuf, stderrBuf] = await Promise.all([stdoutP, stderrP]);
		const td = new TextDecoder();
		return {
			stdout: td.decode(stdoutBuf),
			stderr: td.decode(stderrBuf),
			exitCode: proc.exitCode ?? -1,
			signalCode: (proc.signalCode as string | null) ?? null,
		};
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	}
}

function degradeExit(label: string, res: SpawnResult): EngineDisabled | null {
	const firstLine = res.stderr.split("\n")[0]?.trim() || `${label} failed`;
	if (res.signalCode !== null) {
		return {
			disabled: true,
			reason: `al-sem ${label} killed by signal ${res.signalCode}: ${firstLine}`,
		};
	}
	if (res.exitCode === 0 || res.exitCode === 1) return null;
	return {
		disabled: true,
		reason: `al-sem ${label} failed (exit ${res.exitCode}): ${firstLine}`,
	};
}

// ---------------------------------------------------------------------------
// Workspace app.json version reader
// ---------------------------------------------------------------------------

/**
 * Read the `version` field from `<wsDir>/app.json`.
 * Returns `undefined` if the file is missing or malformed.
 */
function readAppJsonVersion(wsDir: string): string | undefined {
	try {
		const raw = readFileSync(join(wsDir, "app.json"), "utf-8");
		const obj = JSON.parse(raw);
		if (
			typeof obj === "object" &&
			obj !== null &&
			typeof obj.version === "string"
		) {
			return obj.version;
		}
	} catch {
		// missing / malformed — return undefined
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Envelope parsers
// ---------------------------------------------------------------------------

type ParseResult<T> = { ok: true; doc: T } | { ok: false; reason: string };

interface DiffEnvelope {
	kind: string;
	schemaVersion: string;
	alsemVersion: string;
	payload: {
		findings: Array<{
			id: string;
			category: string;
			kind: string;
			severity: string;
			subject: {
				normalizedStableId: string;
				newStableId?: string;
				displayName: string;
			};
			details?: {
				kind?: string;
				resourceKind?: string;
				resourceId?: string;
				op?: string;
			};
			coverageState?: unknown;
		}>;
	};
}

function parseDiffEnvelope(raw: string): ParseResult<DiffEnvelope> {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		return { ok: false, reason: `diff JSON parse error: ${String(e)}` };
	}
	if (typeof doc !== "object" || doc === null) {
		return { ok: false, reason: "diff: expected JSON object" };
	}
	const d = doc as Record<string, unknown>;
	if (d.kind !== "diff-report") {
		return {
			ok: false,
			reason: `diff: unexpected kind "${String(d.kind)}" (expected "diff-report")`,
		};
	}
	const sv = d.schemaVersion;
	if (
		typeof sv !== "string" ||
		!majorMatches(sv, EXPECTED_DIFF_SCHEMA_VERSION)
	) {
		return {
			ok: false,
			reason: `diff: unsupported schemaVersion "${String(sv)}" (expected major "${EXPECTED_DIFF_SCHEMA_VERSION.split(".")[0]}")`,
		};
	}
	const payload = d.payload as Record<string, unknown> | undefined;
	if (typeof payload !== "object" || payload === null) {
		return { ok: false, reason: "diff: missing payload object" };
	}
	if (!Array.isArray(payload.findings)) {
		return { ok: false, reason: "diff: payload.findings is not an array" };
	}
	return { ok: true, doc: doc as DiffEnvelope };
}

interface InventoryEnvelope {
	payload: {
		routineInventory: RoutineIdentity[];
	};
	schemaVersion: string;
}

function parseInventoryEnvelope(raw: string): ParseResult<InventoryEnvelope> {
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
	return { ok: true, doc: doc as InventoryEnvelope };
}

// ---------------------------------------------------------------------------
// Diff delta projection
// ---------------------------------------------------------------------------

/**
 * Project the raw diff-report finding array into typed `DiffDelta[]`.
 * Preserves ENGINE ORDER (determinism via PR2-8 — no sorting here).
 */
function projectFindings(
	rawFindings: DiffEnvelope["payload"]["findings"],
): DiffDelta[] {
	const result: DiffDelta[] = [];
	for (const f of rawFindings) {
		if (!f || typeof f !== "object") continue;
		const subj = f.subject;
		if (!subj || typeof subj.normalizedStableId !== "string") continue;
		const delta: DiffDelta = {
			id: typeof f.id === "string" ? f.id : "",
			category: typeof f.category === "string" ? f.category : "",
			kind: typeof f.kind === "string" ? f.kind : "",
			severity: typeof f.severity === "string" ? f.severity : "",
			normalizedStableId: subj.normalizedStableId,
			displayName: typeof subj.displayName === "string" ? subj.displayName : "",
		};
		if (typeof subj.newStableId === "string") {
			delta.newStableId = subj.newStableId;
		}
		if (f.details) {
			if (typeof f.details.resourceKind === "string") {
				delta.resourceKind = f.details.resourceKind;
			}
			if (typeof f.details.resourceId === "string") {
				delta.resourceId = f.details.resourceId;
			}
			if (typeof f.details.op === "string") {
				delta.op = f.details.op;
			}
		}
		result.push(delta);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Binary resolution (mirrors engine-runner pattern)
// ---------------------------------------------------------------------------

function resolveBinary(opts: RunEngineOptions): string | null {
	if (opts.engine) return opts.engine;
	const envBin = process.env.AL_SEM_BIN;
	if (envBin) return envBin;
	try {
		const which = Bun.which("alsem");
		if (which) return which;
	} catch {
		// Bun.which not available
	}
	return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run `alsem diff <beforeWs> <afterWs> --format json --deterministic` and
 * `alsem fingerprint --inventory-only <afterWs> --deterministic`.
 *
 * Returns `DiffAnalysis` on success or `{ disabled, reason }` — NEVER throws.
 * Also reads both workspace `app.json` files for the version guard (PR2-4).
 */
export async function runEngineDiff(
	beforeWs: string,
	afterWs: string,
	opts: RunEngineOptions = {},
): Promise<DiffResult> {
	const bin = resolveBinary(opts);
	if (!bin) {
		return {
			disabled: true,
			reason: "alsem binary not found (set AL_SEM_BIN or add alsem to PATH)",
		};
	}
	const binPath = bin.trim();
	const looksLikePath =
		binPath.includes("/") ||
		binPath.includes("\\") ||
		/^[A-Za-z]:/.test(binPath);
	if (looksLikePath && !existsSync(binPath)) {
		return {
			disabled: true,
			reason: `alsem binary not found at "${binPath}"`,
		};
	}

	const timeoutMs = opts.timeoutMs ?? 120_000;

	const diffCmd = [
		binPath,
		"diff",
		beforeWs,
		afterWs,
		"--format",
		"json",
		"--deterministic",
	];
	const invCmd = [
		binPath,
		"fingerprint",
		afterWs,
		"--inventory-only",
		"--format",
		"json",
		"--deterministic",
	];

	// Run both concurrently — allSettled so both always reap.
	const [diffSettled, invSettled] = await Promise.allSettled([
		spawnCollect(diffCmd, timeoutMs, "diff"),
		spawnCollect(invCmd, timeoutMs, "fingerprint"),
	]);

	if (diffSettled.status === "rejected") {
		return {
			disabled: true,
			reason: `al-sem diff spawn error: ${String(diffSettled.reason)}`,
		};
	}
	if (invSettled.status === "rejected") {
		return {
			disabled: true,
			reason: `al-sem fingerprint spawn error: ${String(invSettled.reason)}`,
		};
	}

	const diffRes = diffSettled.value;
	const invRes = invSettled.value;

	const diffExit = degradeExit("diff", diffRes);
	if (diffExit) return diffExit;
	const invExit = degradeExit("fingerprint", invRes);
	if (invExit) return invExit;

	const diffParsed = parseDiffEnvelope(diffRes.stdout);
	if (!diffParsed.ok) return { disabled: true, reason: diffParsed.reason };

	const invParsed = parseInventoryEnvelope(invRes.stdout);
	if (!invParsed.ok) return { disabled: true, reason: invParsed.reason };

	return {
		findings: projectFindings(diffParsed.doc.payload.findings),
		afterInventory: invParsed.doc.payload.routineInventory,
		beforeAppVersion: readAppJsonVersion(beforeWs),
		afterAppVersion: readAppJsonVersion(afterWs),
		alsemVersion: diffParsed.doc.alsemVersion,
	};
}
