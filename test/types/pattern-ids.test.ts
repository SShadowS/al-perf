import { describe, expect, it } from "bun:test";
import { PATTERN_DOCS, patternDocHas } from "../../src/mcp/server.js";
import { PATTERN_IDS } from "../../src/types/patterns.js";

describe("PATTERN_IDS is the complete detector vocabulary", () => {
	it("has exactly the 21 ids the detectors emit", () => {
		expect(new Set(PATTERN_IDS).size).toBe(21);
	});

	it("every PATTERN_IDS entry has a PATTERN_DOCS section", () => {
		const missing = PATTERN_IDS.filter((id) => !patternDocHas(id));
		expect(missing).toEqual([]);
	});

	it("PATTERN_DOCS is non-empty and referenced by patternDocHas", () => {
		// Guards against a vacuously-true patternDocHas (e.g. always returning
		// true) by asserting a made-up id is correctly reported as undocumented.
		expect(patternDocHas("not-a-real-pattern-id")).toBe(false);
		expect(PATTERN_DOCS.length).toBeGreaterThan(0);
	});
});
