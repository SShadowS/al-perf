import { describe, expect, test } from "bun:test";
import { parseIrJson } from "../../src/core/irjson-parser.js";
import {
	detectHighHitCount,
	detectRepeatedSiblings,
} from "../../src/core/patterns.js";
import { processProfile } from "../../src/core/processor.js";
import type {
	IrJsonDocument,
	IrJsonInvocation,
} from "../../src/types/irjson.js";

function makeInvocation(
	index: number,
	method: string,
	objectId: number,
	parentIx: number | null,
	selfTicks = 1000,
): IrJsonInvocation {
	return {
		index,
		objectType: "CodeUnit",
		objectId,
		objectName: `Obj${objectId}`,
		method,
		appIx: 0,
		startTicks: index * 100,
		endTicks: index * 100 + 50,
		clampedEndTicks: null,
		inSweep: true,
		selfTicks,
		temporalParentIx: parentIx,
		v8AggregationParentIx: null,
		isBuiltin: false,
		isIncomplete: false,
		calledLine: null,
		callerLine: null,
		lines: [],
		exception: null,
	};
}

function makeDoc(invocations: IrJsonInvocation[]): IrJsonDocument {
	return {
		schemaVersion: 1,
		generator: { name: "bc-mdc-converter", version: "0.0.0-test" },
		capture: {
			platformVersion: "26.0.0.0",
			t0Ticks: "0",
			startTicks: 0,
			endTicks: invocations.length * 100 + 50,
			approxWallClockStart: null,
			ticksPerMs: 10000,
			invocationCount: invocations.length,
			incompleteCount: 0,
			exceptionCount: 0,
		},
		apps: [
			{ id: "app-1", name: "Test App", publisher: "Test", version: "1.0.0.0" },
		],
		invocations,
	};
}

describe("detectHighHitCount on ir-json (exact fan-out)", () => {
	test("fires when a method averages >10 child invocations per parent invocation", () => {
		// 2 RunBatch roots, 12 GetLine children each: 24 calls / 2 parents = 12x
		const invs: IrJsonInvocation[] = [
			makeInvocation(0, "RunBatch", 50200, null),
			makeInvocation(1, "RunBatch", 50200, null),
		];
		for (let i = 0; i < 12; i++) {
			invs.push(makeInvocation(2 + i, "GetLine", 50201, 0));
		}
		for (let i = 0; i < 12; i++) {
			invs.push(makeInvocation(14 + i, "GetLine", 50201, 1));
		}
		const profile = processProfile(parseIrJson(makeDoc(invs)));
		const patterns = detectHighHitCount(profile);
		expect(patterns).toHaveLength(1);
		expect(patterns[0].id).toBe("high-hit-count");
		expect(patterns[0].severity).toBe("warning");
		expect(patterns[0].description).toContain("exactly 24 times");
		expect(patterns[0].evidence).toContain("exact invocation counts");
		expect(patterns[0].evidence).toContain("12.0x");
		// impact = 24 child invocations x 100 µs exact self time
		expect(patterns[0].impact).toBe(2400);
	});

	test("does not fire at 10x or below", () => {
		const invs: IrJsonInvocation[] = [
			makeInvocation(0, "RunBatch", 50200, null),
			makeInvocation(1, "RunBatch", 50200, null),
		];
		for (let i = 0; i < 10; i++) {
			invs.push(makeInvocation(2 + i, "GetLine", 50201, 0));
		}
		for (let i = 0; i < 10; i++) {
			invs.push(makeInvocation(12 + i, "GetLine", 50201, 1));
		}
		const profile = processProfile(parseIrJson(makeDoc(invs)));
		expect(detectHighHitCount(profile)).toHaveLength(0);
	});
});

describe("detectRepeatedSiblings on ir-json (exact counts)", () => {
	test("fires with exact-count wording at 50+ same-method children", () => {
		const invs: IrJsonInvocation[] = [
			makeInvocation(0, "Process", 50300, null),
		];
		for (let i = 0; i < 55; i++) {
			invs.push(makeInvocation(1 + i, "GetItem", 50301, 0));
		}
		const profile = processProfile(parseIrJson(makeDoc(invs)));
		const patterns = detectRepeatedSiblings(profile);
		expect(patterns).toHaveLength(1);
		expect(patterns[0].id).toBe("repeated-siblings");
		expect(patterns[0].title).toContain("55 times");
		expect(patterns[0].evidence).toContain("exact invocation count");
	});

	test("does not fire below 50", () => {
		const invs: IrJsonInvocation[] = [
			makeInvocation(0, "Process", 50300, null),
		];
		for (let i = 0; i < 49; i++) {
			invs.push(makeInvocation(1 + i, "GetItem", 50301, 0));
		}
		const profile = processProfile(parseIrJson(makeDoc(invs)));
		expect(detectRepeatedSiblings(profile)).toHaveLength(0);
	});
});
