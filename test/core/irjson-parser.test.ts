import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { isIrJsonDocument, parseIrJson } from "../../src/core/irjson-parser.js";
import type { IrJsonDocument } from "../../src/types/irjson.js";

const FIXTURES = "test/fixtures";

function loadMinimal(): IrJsonDocument {
	return JSON.parse(
		readFileSync(`${FIXTURES}/irjson-minimal.ir.json`, "utf8"),
	) as IrJsonDocument;
}

function loadReal(): IrJsonDocument {
	const gz = readFileSync(`${FIXTURES}/tiny.ir.json.gz`);
	return JSON.parse(
		new TextDecoder().decode(Bun.gunzipSync(gz)),
	) as IrJsonDocument;
}

describe("isIrJsonDocument", () => {
	test("recognizes an ir-json document", () => {
		expect(isIrJsonDocument(loadMinimal())).toBe(true);
	});

	test("rejects an .alcpuprofile raw object (has nodes, no invocations)", () => {
		const raw = JSON.parse(
			readFileSync(`${FIXTURES}/sampling-minimal.alcpuprofile`, "utf8"),
		);
		expect(isIrJsonDocument(raw)).toBe(false);
	});

	test("rejects null, arrays, and junk", () => {
		expect(isIrJsonDocument(null)).toBe(false);
		expect(isIrJsonDocument([])).toBe(false);
		expect(isIrJsonDocument({ schemaVersion: 1 })).toBe(false);
	});
});

// NOTE: the committed fixture carries 7 invocations (indices 0..6), not the
// 6 the design doc originally sketched. Index 6 is an all-null row (no
// object/method/appIx, inSweep:false, selfTicks:0, temporalParentIx:null)
// added to exercise the fully-null path without crashing the parser. Golden
// values below (node count, root ids, irCapture) are reconciled against the
// fixture as committed, not the original draft.
describe("parseIrJson — minimal fixture golden", () => {
	const parsed = parseIrJson(loadMinimal());

	test("profile-level fields", () => {
		expect(parsed.type).toBe("instrumentation");
		expect(parsed.sourceFormat).toBe("ir-json");
		expect(parsed.nodes).toHaveLength(7);
		// ticks/10 -> µs: capture 0..50000 ticks = 0..5000 µs
		expect(parsed.startTime).toBe(0);
		expect(parsed.endTime).toBe(5000);
		expect(parsed.totalDuration).toBe(5000);
		expect(parsed.samplingInterval).toBeUndefined();
		expect(parsed.irCapture).toEqual({
			invocationCount: 7,
			incompleteCount: 1,
			exceptionCount: 1,
		});
	});

	test("node ids are index+1 and the temporal tree is wired", () => {
		// index 0 (OnRun) -> id 1; children are indices 1,3,4 -> ids 2,4,5
		expect(parsed.nodeMap.get(1)?.children).toEqual([2, 4, 5]);
		expect(parsed.nodeMap.get(2)?.children).toEqual([3]);
		// roots: index 0 (OnRun), index 5 (OrphanMethod, temporalParentIx null),
		// index 6 (all-null row, temporalParentIx null) -> ids 1, 6, 7
		const rootIds = parsed.rootNodes.map((n) => n.id).sort((a, b) => a - b);
		expect(rootIds).toEqual([1, 6, 7]);
	});

	test("exact self times in µs (selfTicks / 10)", () => {
		expect(parsed.exactSelfTimes?.get(1)).toBe(500);
		expect(parsed.exactSelfTimes?.get(2)).toBe(1200);
		expect(parsed.exactSelfTimes?.get(3)).toBe(600);
		expect(parsed.exactSelfTimes?.get(4)).toBe(1500);
		expect(parsed.exactSelfTimes?.get(5)).toBe(200);
		expect(parsed.exactSelfTimes?.get(6)).toBe(0);
		expect(parsed.exactSelfTimes?.get(7)).toBe(0);
	});

	test("hitCount is 1 per node (one node per invocation = exact counts)", () => {
		for (const node of parsed.nodes) {
			expect(node.hitCount).toBe(1);
		}
	});

	test("wire lines get the +1 display shift", () => {
		// calledLine.line 5 (wire, 0-based) -> lineNumber 6 (display)
		expect(parsed.nodeMap.get(1)?.callFrame.lineNumber).toBe(6);
		expect(parsed.nodeMap.get(1)?.callFrame.columnNumber).toBe(5);
		// null calledLine -> 0
		expect(parsed.nodeMap.get(6)?.callFrame.lineNumber).toBe(0);
	});

	test("declaringApplication mapped from apps[appIx]", () => {
		const onRun = parsed.nodeMap.get(1);
		expect(onRun?.declaringApplication?.appName).toBe("My ISV App");
		expect(onRun?.declaringApplication?.appPublisher).toBe("Contoso");
		expect(onRun?.declaringApplication?.appVersion).toBe("1.2.0.0");
		expect(onRun?.declaringApplication?.appId).toBe(
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		);
		expect(parsed.nodeMap.get(3)?.declaringApplication?.appName).toBe(
			"Base Application",
		);
	});

	test("applicationDefinition mapped from invocation object fields", () => {
		const findPrice = parsed.nodeMap.get(3);
		expect(findPrice?.applicationDefinition.objectType).toBe("Table");
		expect(findPrice?.applicationDefinition.objectId).toBe(27);
		expect(findPrice?.applicationDefinition.objectName).toBe("Item");
		expect(findPrice?.callFrame.functionName).toBe("FindPrice");
	});

	test("incomplete row: isIncompleteMeasurement set, clamped end used", () => {
		const post = parsed.nodeMap.get(5);
		expect(post?.isIncompleteMeasurement).toBe(true);
		expect(post?.startTime).toBe(4100); // 41000 ticks
		// clampedEndTicks 50000 wins over pathological raw endTicks 99999999999
		expect(post?.endTime).toBe(5000);
	});

	test("not-in-sweep row: no span times, selfTime 0, is a root", () => {
		const orphan = parsed.nodeMap.get(6);
		expect(orphan?.startTime).toBeUndefined();
		expect(orphan?.endTime).toBeUndefined();
		expect(parsed.exactSelfTimes?.get(6)).toBe(0);
	});

	test("all-null row (index 6): flows through without crashing", () => {
		const nullRow = parsed.nodeMap.get(7);
		expect(nullRow).toBeDefined();
		expect(nullRow?.callFrame.functionName).toBe("(unknown)");
		expect(nullRow?.callFrame.lineNumber).toBe(0);
		expect(nullRow?.callFrame.columnNumber).toBe(0);
		expect(nullRow?.applicationDefinition).toEqual({
			objectType: "",
			objectName: "",
			objectId: 0,
		});
		expect(nullRow?.declaringApplication).toBeUndefined();
		expect(nullRow?.hitCount).toBe(1);
		expect(nullRow?.startTime).toBeUndefined();
		expect(nullRow?.endTime).toBeUndefined();
		expect(parsed.exactSelfTimes?.get(7)).toBe(0);
	});
});

describe("parseIrJson — real converter output golden", () => {
	test("parses the committed real capture", () => {
		const parsed = parseIrJson(loadReal());
		expect(parsed.type).toBe("instrumentation");
		expect(parsed.nodes).toHaveLength(1639);
		expect(parsed.rootNodes).toHaveLength(214);
		expect(parsed.irCapture?.incompleteCount).toBe(0);
	});
});

describe("parseIrJson — validation errors", () => {
	test("rejects a foreign schemaVersion", () => {
		const doc = loadMinimal();
		doc.schemaVersion = 2;
		expect(() => parseIrJson(doc)).toThrow(/schemaVersion 2/);
	});

	test("rejects index/position mismatch", () => {
		const doc = loadMinimal();
		doc.invocations[0].index = 5;
		expect(() => parseIrJson(doc)).toThrow(/index/);
	});

	test("rejects temporalParentIx >= index (contract: always < index)", () => {
		const doc = loadMinimal();
		doc.invocations[1].temporalParentIx = 3;
		expect(() => parseIrJson(doc)).toThrow(/temporalParentIx/);
	});

	test("rejects out-of-range appIx", () => {
		const doc = loadMinimal();
		doc.invocations[0].appIx = 99;
		expect(() => parseIrJson(doc)).toThrow(/appIx/);
	});

	test("enforces the invocation budget", () => {
		const doc = loadMinimal();
		expect(() => parseIrJson(doc, { maxInvocations: 3 })).toThrow(
			/invocation budget/,
		);
	});
});
