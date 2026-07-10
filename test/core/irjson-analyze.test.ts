import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { aggregateByMethod } from "../../src/core/aggregator.js";
import { analyzeProfile } from "../../src/core/analyzer.js";
import { parseIrJson } from "../../src/core/irjson-parser.js";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import type { IrJsonDocument } from "../../src/types/irjson.js";

const FIXTURES = "test/fixtures";
const MINIMAL = `${FIXTURES}/irjson-minimal.ir.json`;

describe("parseProfile format detection", () => {
	test("an .ir.json payload is detected and parsed as ir-json", async () => {
		const parsed = await parseProfile(MINIMAL);
		expect(parsed.type).toBe("instrumentation");
		expect(parsed.sourceFormat).toBe("ir-json");
		// Fixture carries 7 invocations (indices 0..6); index 6 is an all-null
		// row added after the design doc's original 6-invocation sketch — see
		// the NOTE in irjson-parser.test.ts.
		expect(parsed.nodes).toHaveLength(7);
	});

	test(".alcpuprofile payloads still parse as before", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(parsed.type).toBe("sampling");
		expect(parsed.sourceFormat).toBe("alcpuprofile");
	});
});

describe("processProfile on ir-json", () => {
	test("uses exact self times, not statistical inference", async () => {
		const processed = processProfile(await parseProfile(MINIMAL));
		expect(processed.sourceFormat).toBe("ir-json");
		expect(processed.nodeMap.get(2)?.selfTime).toBe(1200);
		expect(processed.nodeMap.get(6)?.selfTime).toBe(0);
		// Σ selfTicks 40000 / 10 = 4000 µs; ir-json has no IdleTime nodes
		expect(processed.totalSelfTime).toBe(4000);
		expect(processed.activeSelfTime).toBe(4000);
		expect(processed.idleSelfTime).toBe(0);
		expect(processed.maxDepth).toBe(2);
		// OnRun total = 500 + (1200 + 600) + 1500 + 200 = 4000
		expect(processed.nodeMap.get(1)?.totalTime).toBe(4000);
		expect(processed.irCapture?.incompleteCount).toBe(1);
	});

	test("aggregation yields EXACT invocation counts", async () => {
		const processed = processProfile(await parseProfile(MINIMAL));
		const methods = aggregateByMethod(processed);
		const processLine = methods.find(
			(m) => m.functionName === "ProcessLine" && m.objectId === 50100,
		);
		expect(processLine?.hitCount).toBe(2);
		expect(processLine?.selfTime).toBe(2700);
	});

	test("real capture golden: exact totals and counts", () => {
		const gz = readFileSync(`${FIXTURES}/tiny.ir.json.gz`);
		const doc = JSON.parse(
			new TextDecoder().decode(Bun.gunzipSync(gz)),
		) as IrJsonDocument;
		const processed = processProfile(parseIrJson(doc));
		expect(processed.nodeCount).toBe(1639);
		expect(processed.roots).toHaveLength(214);
		expect(processed.maxDepth).toBe(28);
		// Σ selfTicks = 503943 ticks -> 50394.3 µs
		expect(processed.totalSelfTime).toBeCloseTo(50394.3, 3);
		const methods = aggregateByMethod(processed);
		const m = methods.find(
			(x) => x.functionName === "IsNonInventoriableType" && x.objectId === 27,
		);
		expect(m?.hitCount).toBe(102);
	});
});

describe("analyzeProfile on ir-json", () => {
	test("end to end with capture meta", async () => {
		const result = await analyzeProfile(MINIMAL);
		expect(result.meta.profileType).toBe("instrumentation");
		expect(result.meta.captureKind).toBe("instrumentation");
		expect(result.meta.sourceFormat).toBe("ir-json");
		expect(result.meta.incompleteInvocations).toBe(1);
		expect(result.meta.totalNodes).toBe(7);
		// isIncompleteMeasurement flows into the existing confidence factor
		expect(result.meta.confidenceFactors.incompleteMeasurements.value).toBe(1);
		const processLine = result.hotspots.find(
			(h) => h.functionName === "ProcessLine",
		);
		expect(processLine?.hitCount).toBe(2);
	});

	test(".alcpuprofile results carry captureKind but no incompleteInvocations", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.meta.captureKind).toBe("sampling");
		expect(result.meta.sourceFormat).toBe("alcpuprofile");
		expect(result.meta.incompleteInvocations).toBeUndefined();
	});
});
