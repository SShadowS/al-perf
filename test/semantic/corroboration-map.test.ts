import { describe, expect, it } from "bun:test";
import {
	CORROBORATION_MAP,
	corroboratesDetector,
} from "../../src/semantic/corroboration-map.js";

// The 7 runtime detector ids from src/core/patterns.ts (runDetectors).
const KNOWN_RUNTIME_DETECTOR_IDS = new Set([
	"single-method-dominance",
	"high-hit-count",
	"deep-call-stack",
	"repeated-siblings",
	"event-subscriber-hotspot",
	"recursive-call",
	"event-chain",
]);

describe("corroboration map", () => {
	it("maps only runtime-shape patterns", () => {
		for (const [, entry] of Object.entries(CORROBORATION_MAP)) {
			expect(entry.provenance).toBe("runtime"); // the map ONLY contains runtime-provenance entries
		}
	});
	it("repeated-siblings corroborates db-op/repeated-lookup/io in loop, anchored to the parent", () => {
		const e = CORROBORATION_MAP["repeated-siblings"];
		expect(e.anchorIndex).toBe(0); // involvedMethods[0] is the parent (loop owner)
		expect(corroboratesDetector("repeated-siblings", "d1-db-op-in-loop")).toBe(
			true,
		);
		expect(
			corroboratesDetector("repeated-siblings", "d4-repeated-lookup-in-loop"),
		).toBe(true);
		expect(corroboratesDetector("repeated-siblings", "d48-io-in-loop")).toBe(
			true,
		);
	});
	it("high-hit-count anchors to the parent (involvedMethods[1])", () => {
		expect(CORROBORATION_MAP["high-hit-count"].anchorIndex).toBe(1);
		expect(corroboratesDetector("high-hit-count", "d1-db-op-in-loop")).toBe(
			true,
		);
	});
	it("recursive-call corroborates recursive-event-expansion", () => {
		expect(
			corroboratesDetector("recursive-call", "d7-recursive-event-expansion"),
		).toBe(true);
	});
	it("never corroborates source-static / source-only patterns (category error)", () => {
		expect(CORROBORATION_MAP["modify-in-loop"]).toBeUndefined(); // source-static
		expect(CORROBORATION_MAP["dangerous-call-in-loop"]).toBeUndefined(); // source-only
		expect(corroboratesDetector("modify-in-loop", "d1-db-op-in-loop")).toBe(
			false,
		);
	});
	it("hard-excludes event-subscriber-hotspot (no single routine)", () => {
		expect(CORROBORATION_MAP["event-subscriber-hotspot"]).toBeUndefined();
	});
	it("does not corroborate an unmapped detector", () => {
		expect(corroboratesDetector("repeated-siblings", "d14-dead-routine")).toBe(
			false,
		);
	});
	it("drift guard: every map key is a known runtime detector id", () => {
		for (const key of Object.keys(CORROBORATION_MAP)) {
			expect(KNOWN_RUNTIME_DETECTOR_IDS.has(key)).toBe(true);
		}
	});
});
