/**
 * fingerprint.ts — Versioned finding-identity contract (lifecycle pre-phase).
 *
 * The single source of truth for how a finding is identified across the
 * platform (umbrella spec §4 "Finding identity"). Consumed by the fusion
 * output types (phase 2) and the lifecycle engine (phase 3).
 *
 * PURE — no I/O, no storage, no subprocess calls. Types + functions only.
 *
 * Namespaces (identities NEVER collide across origins):
 *   alsem:<native>    — alsem-originated findings keep their native
 *                       fingerprint verbatim (passthrough, never re-hashed).
 *   pattern:<hash>    — al-perf pattern detections (sha256, 16 hex chars).
 *   telemetry:<hash>  — coarse routine-level telemetry signals (RT0018 …).
 *
 * Pattern fingerprint = sha256 over (algoVersion, "pattern", patternId,
 * appId, routine identity, salient location). Routine identity is the alsem
 * `stableRoutineId` when a CONFIDENT correlation exists (status="matched"
 * with a single id), else the fallback key
 * (appId, canonicalObjectType, objectNumber, normalizedRoutineName) — so
 * profile-only findings (the common case before source registration) are
 * ALWAYS fingerprintable. Ambiguous correlations NEVER mint
 * stableRoutineId-based fingerprints.
 *
 * Salient-location convention: 1-based DISPLAY lines. ir-json wire lines are
 * 0-based and get +1; `.alcpuprofile` lines are already display lines.
 * Routine-anchored patterns (all 18 current detectors) carry NO salient
 * location — their identity survives line shifts by construction. Only a
 * future site-anchored detector opts in by passing a normalized location.
 *
 * Every fingerprint carries `algoVersion` (= FINGERPRINT_ALGO_VERSION at mint
 * time). Algorithm upgrades produce `FingerprintMigration` records via
 * `linkFingerprints` — the lifecycle store (phase 3) applies them; this
 * module only defines the record.
 *
 * KNOWN LIMITATION: renaming a routine or changing its signature severs
 * `stableRoutineId` — the old finding silently resolves and a duplicate is
 * filed under the new identity. Mitigations (phase 3): alsem's differential
 * machinery as rename-detection prior art, plus a manual fingerprint-merge
 * operation (`linkFingerprints` with reason "manual-merge") exposed via
 * `findings_update`.
 */

import { createHash } from "node:crypto";
import {
	canonicalObjectType,
	normalizeAppGuid,
	normalizeTriggerName,
} from "../semantic/identity.js";

// ---------------------------------------------------------------------------
// Version constant (the contract pin)
// ---------------------------------------------------------------------------

/**
 * The fingerprint algorithm version stamped on every minted fingerprint.
 * Bump when the hash inputs, token order, normalization rules, or truncation
 * length change — and ship a re-fingerprint migration (linkFingerprints).
 */
export const FINGERPRINT_ALGO_VERSION = 1;

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** The three identity origins. Prefixed onto the string form — never collide. */
export type FingerprintNamespace = "alsem" | "pattern" | "telemetry";

/**
 * A namespaced finding identity.
 *
 * `value` is the BARE hash (pattern/telemetry) or the native alsem
 * fingerprint — it never contains the namespace prefix. The canonical string
 * form `"<namespace>:<value>"` is produced by `formatFingerprint`.
 */
export interface FindingFingerprint {
	value: string;
	namespace: FingerprintNamespace;
	algoVersion: number;
}

/**
 * The wire format a location came from. The line-base convention is a
 * property of the serialization format:
 *  - "alcpuprofile" — 1-based display lines (Microsoft's profile format).
 *  - "ir-json"      — 0-based wire lines (bc-mdc-converter interchange IR).
 */
export type CaptureKind = "alcpuprofile" | "ir-json";

/**
 * A normalized, capture-kind-independent source location.
 * Produced ONLY by `normalizeSalientLocation` — never construct by hand.
 */
export interface SalientLocation {
	/** Normalized path: forward slashes, lowercased. Absent when unknown. */
	file?: string;
	/** 1-based display line. Absent when unknown/invalid. */
	line?: number;
}

/**
 * The routine identity that anchors a pattern fingerprint.
 *
 *  - "stable"   — a confident alsem correlation exists; the alsem
 *                 `stableRoutineId` (colon form
 *                 `<appGuid>:<objectType>:<objectNumber>#<hash>`) is the
 *                 identity. Survives line shifts and file moves; severed by
 *                 rename/signature change (see module header).
 *  - "fallback" — no confident correlation (profile-only, ambiguous,
 *                 blind-spot, cold, unkeyable). All fields pre-normalized:
 *                 appId dash-less lowercase ("" when unknown), objectType in
 *                 canonical AL-keyword case, routine name trigger-normalized
 *                 and lowercased (AL identifiers are case-insensitive).
 *
 * NOTE: named FingerprintRoutineIdentity (not RoutineIdentity) to avoid
 * colliding with the alsem inventory type in src/semantic/contracts.ts.
 */
export type FingerprintRoutineIdentity =
	| { kind: "stable"; stableRoutineId: string }
	| {
			kind: "fallback";
			appId: string;
			canonicalObjectType: string;
			objectNumber: number;
			normalizedRoutineName: string;
	  };

// ---------------------------------------------------------------------------
// normalizeSalientLocation
// ---------------------------------------------------------------------------

/**
 * Normalize a raw location to the capture-kind-independent convention.
 *
 * Line rule (THE contract): output is a 1-based display line.
 *  - "ir-json"      → wire line + 1 (wire lines are 0-based; wire 0 = display 1).
 *  - "alcpuprofile" → unchanged (already display lines).
 * A line that is missing, non-integer, or would normalize to < 1 (e.g. the
 * `.alcpuprofile` "line 0 = unknown" convention) is dropped (undefined).
 *
 * File rule: backslashes → forward slashes, lowercased (AL projects live on
 * case-insensitive filesystems; casing must not split identities). Empty or
 * missing → undefined.
 */
export function normalizeSalientLocation(
	location: { file?: string; line?: number },
	captureKind: CaptureKind,
): SalientLocation {
	const file = location.file
		? location.file.replace(/\\/g, "/").toLowerCase()
		: undefined;

	let line: number | undefined;
	if (location.line !== undefined && Number.isInteger(location.line)) {
		const display =
			captureKind === "ir-json" ? location.line + 1 : location.line;
		line = display >= 1 ? display : undefined;
	}

	return { file, line };
}

// ---------------------------------------------------------------------------
// String form
// ---------------------------------------------------------------------------

/**
 * The canonical string form: `"<namespace>:<hash-or-native>"`.
 * This is the key the lifecycle store (phase 3) and sinks use.
 */
export function formatFingerprint(fp: FindingFingerprint): string {
	return `${fp.namespace}:${fp.value}`;
}

// ---------------------------------------------------------------------------
// Hashing (internal)
//
// Token contract (v1): tokens are joined with "\u001f" (ASCII unit separator
// — cannot occur in AL identifiers, GUIDs, or paths) and sha256-hashed,
// truncated to the first 16 hex chars. The first token is the algo version
// ("v1"), the second the domain ("pattern"/"telemetry"), so raw hashes can
// never collide across versions or domains even before namespacing.
// ---------------------------------------------------------------------------

const TOKEN_SEP = "\u001f";

function sha256Hex16(tokens: readonly string[]): string {
	return createHash("sha256")
		.update(tokens.join(TOKEN_SEP))
		.digest("hex")
		.slice(0, 16);
}

/** Deterministic token expansion of a routine identity (kind-prefixed). */
function identityTokens(identity: FingerprintRoutineIdentity): string[] {
	if (identity.kind === "stable") {
		return ["sid", identity.stableRoutineId];
	}
	return [
		"fk",
		identity.appId,
		identity.canonicalObjectType,
		String(identity.objectNumber),
		identity.normalizedRoutineName,
	];
}

/** Deterministic token expansion of a salient location (absent → empty). */
function locationTokens(location: SalientLocation | undefined): string[] {
	if (!location) return ["loc", "", ""];
	return [
		"loc",
		location.file ?? "",
		location.line !== undefined ? String(location.line) : "",
	];
}

// ---------------------------------------------------------------------------
// computePatternFingerprint
// ---------------------------------------------------------------------------

/** The pattern-side inputs to a fingerprint. */
export interface PatternFingerprintInput {
	/** The detector id (DetectedPattern.id), e.g. "calcfields-in-loop". */
	patternId: string;
	/**
	 * Already-normalized location (via `normalizeSalientLocation`).
	 * OMIT for routine-anchored patterns (all 18 current detectors) — their
	 * identity is the routine, and it must survive line shifts. Only a future
	 * site-anchored detector passes a location, accepting that line drift then
	 * changes identity.
	 */
	salientLocation?: SalientLocation;
}

/**
 * Mint a `pattern:` fingerprint:
 * sha256(v1, "pattern", patternId, appId, routine identity, salient location),
 * hex-truncated to 16 chars.
 *
 * `appId` is normalized (dash-less lowercase) and hashed even when the
 * fallback identity carries it too — the spec formula includes it
 * unconditionally, and double inclusion is deterministic. Pass the SAME
 * method's declaring appId here and in the identity (use
 * `routineIdentityFromCorrelation` to build the identity).
 */
export function computePatternFingerprint(
	pattern: PatternFingerprintInput,
	identity: FingerprintRoutineIdentity,
	appId: string,
): FindingFingerprint {
	const tokens = [
		`v${FINGERPRINT_ALGO_VERSION}`,
		"pattern",
		pattern.patternId,
		normalizeAppGuid(appId),
		...identityTokens(identity),
		...locationTokens(pattern.salientLocation),
	];
	return {
		value: sha256Hex16(tokens),
		namespace: "pattern",
		algoVersion: FINGERPRINT_ALGO_VERSION,
	};
}

// ---------------------------------------------------------------------------
// wrapAlsemFingerprint
// ---------------------------------------------------------------------------

/**
 * Wrap an alsem-native fingerprint (FindingSummary.fingerprint from
 * `src/semantic/contracts.ts`) under the `alsem:` namespace. PASSTHROUGH —
 * the native value is the identity; it is never re-hashed, so alsem's own
 * identity stability guarantees carry over unchanged.
 */
export function wrapAlsemFingerprint(native: string): FindingFingerprint {
	return {
		value: native,
		namespace: "alsem",
		algoVersion: FINGERPRINT_ALGO_VERSION,
	};
}

// ---------------------------------------------------------------------------
// computeTelemetryFingerprint
// ---------------------------------------------------------------------------

/**
 * The coarse routine-level key for telemetry findings (no call trees in
 * telemetry — object/method granularity is all there is).
 */
export interface TelemetryFingerprintInput {
	/** The signal discriminator, e.g. "RT0018" (long-running AL) or "RT0005" (long-running SQL). */
	signalId: string;
	appId: string;
	/** Any casing/spelling — canonicalized internally. */
	objectType: string;
	objectNumber: number;
	/** Raw routine name — trigger-normalized and lowercased internally. */
	routineName: string;
}

/**
 * Mint a `telemetry:` fingerprint over the coarse key
 * (signalId, appId, objectType, objectNumber, routineName), with the same
 * normalization as the pattern fallback key so a later deep-capture pattern
 * finding on the same routine correlates cleanly at the routine level.
 */
export function computeTelemetryFingerprint(
	input: TelemetryFingerprintInput,
): FindingFingerprint {
	const tokens = [
		`v${FINGERPRINT_ALGO_VERSION}`,
		"telemetry",
		input.signalId,
		normalizeAppGuid(input.appId),
		canonicalObjectType(input.objectType),
		String(input.objectNumber),
		normalizeTriggerName(input.routineName).toLowerCase(),
	];
	return {
		value: sha256Hex16(tokens),
		namespace: "telemetry",
		algoVersion: FINGERPRINT_ALGO_VERSION,
	};
}
