/**
 * states.test.ts — exhaustive coverage of the lifecycle transition table
 * (every state × event × guard combination from the plan's normative table).
 */

import { describe, expect, it } from "bun:test";
import {
	type FindingState,
	type LifecycleEvent,
	transition,
} from "../../src/lifecycle/states.js";

const seen = (
	qualifier: "normal" | "regressed" | "improved",
): LifecycleEvent => ({
	type: "seen",
	qualifier,
});
const absent: LifecycleEvent = { type: "absent" };
const close: LifecycleEvent = { type: "close" };
const below = { absenceCount: 1, resolveAfterRuns: 3 };
const atThreshold = { absenceCount: 3, resolveAfterRuns: 3 };

// [state, event, guards, expectedNext, expectedEffects] — INVALID rows use null next.
const TABLE: Array<
	[FindingState, LifecycleEvent, typeof below, FindingState | null, string[]]
> = [
	["new", seen("normal"), below, "open", ["reset-absence"]],
	["new", seen("regressed"), below, "regressed", ["reset-absence"]],
	["new", seen("improved"), below, "open", ["reset-absence"]],
	["new", absent, below, "new", []],
	["new", absent, atThreshold, "resolved", []],
	["new", close, below, null, []],
	["open", seen("normal"), below, "open", ["reset-absence"]],
	["open", seen("regressed"), below, "regressed", ["reset-absence"]],
	["open", seen("improved"), below, "improving", ["reset-absence"]],
	["open", absent, below, "open", []],
	["open", absent, atThreshold, "resolved", []],
	["open", close, below, null, []],
	["regressed", seen("normal"), below, "open", ["reset-absence"]],
	["regressed", seen("regressed"), below, "regressed", ["reset-absence"]],
	["regressed", seen("improved"), below, "improving", ["reset-absence"]],
	["regressed", absent, below, "regressed", []],
	["regressed", absent, atThreshold, "resolved", []],
	["regressed", close, below, null, []],
	["improving", seen("normal"), below, "open", ["reset-absence"]],
	["improving", seen("regressed"), below, "regressed", ["reset-absence"]],
	["improving", seen("improved"), below, "improving", ["reset-absence"]],
	["improving", absent, below, "improving", []],
	["improving", absent, atThreshold, "resolved", []],
	["improving", close, below, null, []],
	["resolved", seen("normal"), below, "regressed", ["reopen", "reset-absence"]],
	[
		"resolved",
		seen("regressed"),
		below,
		"regressed",
		["reopen", "reset-absence"],
	],
	[
		"resolved",
		seen("improved"),
		below,
		"regressed",
		["reopen", "reset-absence"],
	],
	["resolved", absent, below, "resolved", []],
	["resolved", absent, atThreshold, "resolved", []],
	["resolved", close, below, "closed", []],
	["closed", seen("normal"), below, "closed", ["file-fresh"]],
	["closed", seen("regressed"), below, "closed", ["file-fresh"]],
	["closed", seen("improved"), below, "closed", ["file-fresh"]],
	["closed", absent, below, "closed", []],
	["closed", absent, atThreshold, "closed", []],
	["closed", close, below, null, []],
];

describe("transition table", () => {
	for (const [state, event, guards, next, effects] of TABLE) {
		const eventLabel =
			event.type === "seen" ? `seen(${event.qualifier})` : event.type;
		const guardLabel =
			guards.absenceCount >= guards.resolveAfterRuns ? ">=N" : "<N";
		it(`${state} x ${eventLabel} [${guardLabel}] -> ${next ?? "INVALID"}`, () => {
			const result = transition(state, event, guards);
			if (next === null) {
				expect(result.ok).toBe(false);
			} else {
				if (!result.ok) throw new Error(`unexpected invalid: ${result.reason}`);
				expect(result.next).toBe(next);
				expect(result.effects).toEqual(effects as never);
			}
		});
	}
});
