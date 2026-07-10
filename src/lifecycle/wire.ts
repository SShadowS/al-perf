/**
 * wire.ts — Fingerprint wiring for analysis outputs (lifecycle phase-2 bridge).
 *
 * Bridges the versioned finding-identity contract (fingerprint.ts) onto
 * al-perf's DetectedPattern[]: resolves each pattern's ANCHOR routine, derives
 * its FingerprintRoutineIdentity (stable when a confident alsem correlation
 * exists, fallback key otherwise), and stamps the canonical string-form
 * fingerprint onto the pattern.
 *
 * PURE — no I/O. Called by analyzeProfile (fallback identities, always) and
 * by fuseProfile (identity upgrade after correlation).
 *
 * ── ANCHOR POLICY (THE identity decision — decided once, here) ─────────────
 *
 * The anchor routine of a DetectedPattern is `involvedMethods[0]`, ALWAYS.
 * Two consumers anchoring differently would split identities, so no other
 * module may re-derive a pattern anchor FOR FINGERPRINT IDENTITY.
 *
 * NOT the same concept as src/semantic/corroboration-map.ts's `anchorIndex`:
 * that map picks the loop/recursion-OWNING involvedMethods[] entry for
 * CORROBORATION matching, a deliberately different question. For
 * high-hit-count they diverge on purpose — corroboration anchors the parent
 * (index 1, the loop owner) while fingerprint identity anchors the hot child
 * (index 0, per the policy above).
 *
 * Verified against every detector (src/core/patterns.ts,
 * src/source/source-patterns.ts, src/source/source-only-patterns.ts):
 *  - single-method-dominance, recursive-call, and all 11 source detectors
 *    emit exactly one involved method — the subject.
 *  - high-hit-count (both variants) puts the hot child (the exploding
 *    callee) first.
 *  - event-chain puts the chain ROOT subscriber first.
 *  - repeated-siblings puts the PARENT first — the loop-owning call site,
 *    i.e. the routine whose change resolves the finding.
 *  - deep-call-stack / event-subscriber-hotspot are aggregate patterns whose
 *    lists are tree-traversal-ordered; [0] is a deterministic representative.
 *
 * Rejected alternative — "hottest involved method by selfTime": relative
 * heat is the least stable input across runs of the same scenario; anchoring
 * on it splits identities whenever two involved methods trade places.
 * Position 0 never depends on timing.
 *
 * Granularity (pinned by the v1 hash contract): identity =
 * (patternId × anchor routine × appId) with no salient location, so N
 * instances of one pattern on one routine share ONE fingerprint. The
 * lifecycle engine (phase 3) treats them as one finding with N occurrences.
 */

import { methodAttrKey } from "../semantic/correlate.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { SemanticAttribution } from "../types/fused.js";
import type { DetectedPattern } from "../types/patterns.js";
import {
	computePatternFingerprint,
	type FingerprintRoutineIdentity,
	formatFingerprint,
	routineIdentityFromCorrelation,
} from "./fingerprint.js";

/** The resolved anchor of a pattern: routine identity + declaring appId. */
export interface PatternAnchor {
	identity: FingerprintRoutineIdentity;
	/** The anchor method's declaring appId ("" when unknown or unresolved). */
	appId: string;
}

/**
 * Index methods by their display label — the exact string the detectors write
 * into involvedMethods: `"<functionName> (<objectType> <objectId>)"`
 * (formatMethodRef in core/patterns.ts, methodLabel in source-patterns.ts,
 * memberLabel in source-only-patterns.ts — plus two inline producers that
 * build the same literal by hand instead of calling a shared helper:
 * detectDangerousCallsInLoop in source-only-patterns.ts, ~line 187, and the
 * record-ops-in-loop findings in cli/commands/analyze-source.ts, ~line 122).
 * All five sites must stay byte-identical to this format — a future producer
 * that drifts silently falls to the parseable-unresolved or unparseable rung
 * of resolvePatternAnchor's ladder below instead of resolving cleanly.
 * First write wins; method keys are unique after aggregation, so collisions
 * only occur for pathological synthetic input.
 */
export function buildMethodLabelMap(
	methods: MethodBreakdown[],
): Map<string, MethodBreakdown> {
	const map = new Map<string, MethodBreakdown>();
	for (const m of methods) {
		const label = `${m.functionName} (${m.objectType} ${m.objectId})`;
		if (!map.has(label)) map.set(label, m);
	}
	return map;
}

/**
 * Parse a display label back into identity fields. The first group is greedy
 * so only the LAST " (" starts the object suffix — function names may contain
 * spaces, dashes, and dots; object types are single tokens; ids are digits.
 */
const LABEL_RE = /^(.+) \((\S+) (\d+)\)$/;

/**
 * Resolve a pattern's anchor per the anchor policy (module header).
 *
 * Resolution ladder (every rung deterministic):
 *  1. involvedMethods[0] found in methodsByLabel → identity via
 *     routineIdentityFromCorrelation(attributions[methodAttrKey], method):
 *     stable when a confident correlation exists, fallback key otherwise.
 *     appId = method.appId ?? "".
 *  2. Label parseable but the method is not in the profile set → fallback key
 *     from the parsed (objectType, objectId, functionName), appId "".
 *  3. Label unparseable (or involvedMethods empty) → unkeyable-style fallback:
 *     objectType "", objectNumber 0, routine name = the raw label. Still
 *     deterministic — the same string always yields the same identity.
 */
export function resolvePatternAnchor(
	pattern: DetectedPattern,
	methodsByLabel: Map<string, MethodBreakdown>,
	attributions?: Map<string, SemanticAttribution>,
): PatternAnchor {
	const label = pattern.involvedMethods[0] ?? "";
	const method = methodsByLabel.get(label);
	if (method) {
		const attribution = attributions?.get(methodAttrKey(method));
		return {
			identity: routineIdentityFromCorrelation(attribution, method),
			appId: method.appId ?? "",
		};
	}
	const parsed = LABEL_RE.exec(label);
	if (parsed) {
		return {
			identity: routineIdentityFromCorrelation(undefined, {
				objectType: parsed[2],
				objectId: Number.parseInt(parsed[3], 10),
				functionName: parsed[1],
			}),
			appId: "",
		};
	}
	// Unkeyable-style fallback: a deterministic identity from the raw string.
	return {
		identity: routineIdentityFromCorrelation(undefined, {
			objectType: "",
			objectId: 0,
			functionName: label,
		}),
		appId: "",
	};
}

/**
 * Stamp `fingerprint` (canonical string form, `pattern:<16-hex>`) onto every
 * pattern IN PLACE. All 18 current detectors are routine-anchored, so no
 * salient location participates — identity survives line shifts by
 * construction (fingerprint.ts module header).
 *
 * Call sites:
 *  - analyzeProfile (core/analyzer.ts): no attributions → fallback keys.
 *    Runs ALWAYS (no source, no fusion required).
 *  - fuseProfile (semantic/fuse.ts): with attributions → re-mints, upgrading
 *    confidently-matched anchors to stable identities. Overwriting the
 *    analyzeProfile value is the ONE sanctioned overwrite (identity-upgrade
 *    semantics — see routineIdentityFromCorrelation).
 */
export function fingerprintPatterns(
	patterns: DetectedPattern[],
	methods: MethodBreakdown[],
	attributions?: Map<string, SemanticAttribution>,
): void {
	if (patterns.length === 0) return;
	const byLabel = buildMethodLabelMap(methods);
	for (const p of patterns) {
		const anchor = resolvePatternAnchor(p, byLabel, attributions);
		p.fingerprint = formatFingerprint(
			computePatternFingerprint(
				{ patternId: p.id },
				anchor.identity,
				anchor.appId,
			),
		);
	}
}
