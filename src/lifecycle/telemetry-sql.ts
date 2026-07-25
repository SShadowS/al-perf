/**
 * telemetry-sql.ts — pure logic for the telemetry SQL evidence layer: AL stack
 * parsing, the routine join key, statement redaction, and the statement→signal
 * join. No I/O and no KQL; `appinsights.ts` calls into this module so SQL-shape
 * knowledge stays out of the adapter and every rule here is unit-testable
 * without a fetch mock.
 */

/**
 * The AL frame grammar, verified against real RT0005 rows in Gate 0:
 *   "<Object Name>"(<ObjectType> <ObjectId>).<Method> line <N> - <app info>
 * Header lines (`AppObjectType:`, `AppObjectId:`) precede `AL CallStack:` and
 * are NOT frames — taking line 0 (the pre-fix behavior) yields a header string,
 * never a method. The marker `AL CallStack:` must be found first to avoid
 * matching fake frames that appear before it in the input.
 */
const AL_FRAME_RE = /"[^"]*"\([A-Za-z]+\s+\d+\)\.([A-Za-z_][\w]*)/;

export function parseAlStackFrame(stack: string): string | null {
	if (!stack) return null;

	// Find the AL CallStack marker first; skip any fake frames that precede it
	const idx = stack.indexOf("AL CallStack:");
	if (idx === -1) return null;

	// Search for the frame pattern starting from the marker
	const frameText = stack.slice(idx);
	const match = AL_FRAME_RE.exec(frameText);
	return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// telemetryRoutineKey
// ---------------------------------------------------------------------------

import {
	canonicalObjectType,
	normalizeAppGuid,
	normalizeTriggerName,
} from "../semantic/identity.js";

/**
 * The join key evidence attaches on. Uses the SAME normalizers as
 * `computeTelemetryFingerprint` (fingerprint.ts) so the key and the identity
 * can never disagree on casing or trigger spelling.
 *
 * `signalId` is DELIBERATELY omitted: finding identity includes it, so a key
 * that carried it could only ever reach RT0005 findings — and the whole point
 * is that RT0005 statements must also annotate the RT0018 finding for the same
 * routine.
 */
export function telemetryRoutineKey(
	appId: string,
	objectType: string,
	objectId: number,
	methodName: string,
): string {
	return [
		normalizeAppGuid(appId),
		canonicalObjectType(objectType),
		String(objectId),
		normalizeTriggerName(methodName).toLowerCase(),
	].join("|");
}
