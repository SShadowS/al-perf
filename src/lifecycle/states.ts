/**
 * states.ts — the pure lifecycle state machine (umbrella spec §4).
 *
 * The FULL transition table lives in the plan document
 * (docs/superpowers/plans/2026-07-10-lifecycle-engine.md, Task 2) and in the
 * exhaustive test (test/lifecycle/states.test.ts). This module encodes it —
 * no I/O, no storage; guards are passed in.
 *
 * Effects tell the CALLER (evaluate.ts / CLI) what bookkeeping the
 * transition implies:
 *  - "reset-absence" — zero the consecutive-absence counter.
 *  - "reopen"        — clear resolved_at, log a "reopened" event (re-appearance
 *                      after resolved reopens WITH history).
 *  - "file-fresh"    — the closed row stays closed; create a NEW finding row
 *                      with a supersedes link (re-appearance after human close).
 */

export type FindingState =
	| "new"
	| "open"
	| "regressed"
	| "improving"
	| "resolved"
	| "closed";

export type SeenQualifier = "normal" | "regressed" | "improved";

export type LifecycleEvent =
	| { type: "seen"; qualifier: SeenQualifier }
	| { type: "absent" }
	| { type: "close" };

export interface TransitionGuards {
	/** Consecutive-absence count AFTER incrementing for the current run. */
	absenceCount: number;
	/** Config N: resolved after N consecutive compatible absences. */
	resolveAfterRuns: number;
}

export type TransitionEffect = "reset-absence" | "reopen" | "file-fresh";

export type TransitionResult =
	| { ok: true; next: FindingState; effects: TransitionEffect[] }
	| { ok: false; reason: string };

export function transition(
	state: FindingState,
	event: LifecycleEvent,
	guards: TransitionGuards,
): TransitionResult {
	switch (event.type) {
		case "seen": {
			if (state === "closed") {
				return { ok: true, next: "closed", effects: ["file-fresh"] };
			}
			if (state === "resolved") {
				return {
					ok: true,
					next: "regressed",
					effects: ["reopen", "reset-absence"],
				};
			}
			if (event.qualifier === "regressed") {
				return { ok: true, next: "regressed", effects: ["reset-absence"] };
			}
			if (event.qualifier === "improved") {
				// A brand-new finding has no baseline to improve against.
				const next = state === "new" ? "open" : "improving";
				return { ok: true, next, effects: ["reset-absence"] };
			}
			// qualifier === "normal": steady state is "open".
			return { ok: true, next: "open", effects: ["reset-absence"] };
		}
		case "absent": {
			if (state === "resolved" || state === "closed") {
				return { ok: true, next: state, effects: [] };
			}
			if (guards.absenceCount >= guards.resolveAfterRuns) {
				return { ok: true, next: "resolved", effects: [] };
			}
			return { ok: true, next: state, effects: [] };
		}
		case "close": {
			if (state === "resolved") {
				return { ok: true, next: "closed", effects: [] };
			}
			return {
				ok: false,
				reason: `close is only legal from resolved (state=${state})`,
			};
		}
	}
}
