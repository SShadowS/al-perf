// === ir-json wire format (bc-mdc-converter --format ir-json) ===
//
// Contract source: U:\Git\bc-mdc-converter\docs\superpowers\specs\
// 2026-07-06-ir-json-format-design.md (schemaVersion 1).
//
// Versioning policy (§3.7): integer schemaVersion; breaking changes bump it;
// additive optional fields do NOT. We therefore accept exactly
// IRJSON_SCHEMA_VERSION and ignore unknown keys.
//
// Units: all tick values are 100 ns ticks rebased to capture.t0Ticks
// (ticksPerMs = 10000). Line/column numbers are RAW WIRE VALUES (0-based) —
// the parser applies the +1 display shift, not these types.

/** The ir-json schemaVersion this consumer is pinned to. */
export const IRJSON_SCHEMA_VERSION = 1;

export interface IrJsonGenerator {
	name: string;
	version: string;
}

export interface IrJsonCapture {
	platformVersion: string;
	/** Absolute rebase anchor as a string (exceeds Number.MAX_SAFE_INTEGER). */
	t0Ticks: string;
	startTicks: number;
	endTicks: number;
	approxWallClockStart: string | null;
	ticksPerMs: number;
	invocationCount: number;
	incompleteCount: number;
	exceptionCount: number;
}

export interface IrJsonApp {
	/** May be "" when the declaring app carries no id (dedup fell back to name). */
	id: string;
	name: string;
	publisher: string;
	version: string;
}

export interface IrJsonLineRef {
	objectType: string;
	objectId: number;
	line: number;
	column: number;
	toLine: number;
	toColumn: number;
}

export interface IrJsonLineHit {
	line: number;
	column: number;
	toLine: number;
	toColumn: number;
	hits: number;
}

export interface IrJsonException {
	message: string;
	line: number;
}

export interface IrJsonInvocation {
	index: number;
	objectType: string | null;
	objectId: number | null;
	objectName: string | null;
	method: string | null;
	appIx: number | null;
	startTicks: number | null;
	/** RAW unclamped span end — may be pathological on isIncomplete rows (§3.5). */
	endTicks: number | null;
	/** Post-clamp end, non-null ONLY when the clamp changed the raw end. */
	clampedEndTicks: number | null;
	inSweep: boolean;
	/** Exact self time; 0 when inSweep === false; always >= 0. */
	selfTicks: number;
	/** TRUE temporal parent (this is the call tree); always < index when non-null. */
	temporalParentIx: number | null;
	/** Phase-2 aggregation edge — NOT the call tree; carried for losslessness only. */
	v8AggregationParentIx: number | null;
	isBuiltin: boolean;
	isIncomplete: boolean;
	calledLine: IrJsonLineRef | null;
	callerLine: IrJsonLineRef | null;
	lines: IrJsonLineHit[];
	exception: IrJsonException | null;
}

export interface IrJsonDocument {
	schemaVersion: number;
	generator: IrJsonGenerator;
	capture: IrJsonCapture;
	apps: IrJsonApp[];
	invocations: IrJsonInvocation[];
}
