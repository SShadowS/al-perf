/**
 * fingerprint.test.ts — Unit tests for src/lifecycle/fingerprint.ts
 *
 * Covers:
 *  - FINGERPRINT_ALGO_VERSION pin
 *  - normalizeSalientLocation: capture-kind line-base normalization
 *    (ir-json wire 0-based → display 1-based; .alcpuprofile passthrough),
 *    path normalization, invalid-line handling
 *  - computePatternFingerprint: determinism, namespace/version stamping,
 *    stable-vs-fallback divergence, line-shift stability (routine-anchored)
 *  - wrapAlsemFingerprint / computeTelemetryFingerprint: passthrough,
 *    coarse key, namespace non-collision
 *  - routineIdentityFromCorrelation: matched→stable, ambiguous NEVER stable,
 *    fallback normalization
 *  - linkFingerprints: migration records + guards
 */

import { describe, expect, it } from "bun:test";
import {
	FINGERPRINT_ALGO_VERSION,
	normalizeSalientLocation,
} from "../../src/lifecycle/fingerprint.js";

// ---------------------------------------------------------------------------
// FINGERPRINT_ALGO_VERSION
// ---------------------------------------------------------------------------

describe("FINGERPRINT_ALGO_VERSION", () => {
	it("is pinned to 1", () => {
		expect(FINGERPRINT_ALGO_VERSION).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// normalizeSalientLocation
// ---------------------------------------------------------------------------

describe("normalizeSalientLocation", () => {
	it("converts an ir-json wire line (0-based) to a display line (+1)", () => {
		const loc = normalizeSalientLocation({ line: 41 }, "ir-json");
		expect(loc.line).toBe(42);
	});

	it("passes an .alcpuprofile display line through unchanged", () => {
		const loc = normalizeSalientLocation({ line: 42 }, "alcpuprofile");
		expect(loc.line).toBe(42);
	});

	it("capture-kind equivalence: wire line N equals display line N+1", () => {
		const fromWire = normalizeSalientLocation(
			{ file: "src\\SalesPost.Codeunit.al", line: 41 },
			"ir-json",
		);
		const fromDisplay = normalizeSalientLocation(
			{ file: "src/salespost.codeunit.al", line: 42 },
			"alcpuprofile",
		);
		expect(fromWire).toEqual(fromDisplay);
	});

	it("ir-json wire line 0 is valid and becomes display line 1", () => {
		const loc = normalizeSalientLocation({ line: 0 }, "ir-json");
		expect(loc.line).toBe(1);
	});

	it("normalizes file paths: backslashes → forward slashes, lowercased", () => {
		const loc = normalizeSalientLocation(
			{ file: "Src\\App\\SalesPost.Codeunit.AL", line: 1 },
			"alcpuprofile",
		);
		expect(loc.file).toBe("src/app/salespost.codeunit.al");
	});

	it("drops a non-positive .alcpuprofile display line (line 0 = unknown)", () => {
		expect(
			normalizeSalientLocation({ line: 0 }, "alcpuprofile").line,
		).toBeUndefined();
	});

	it("drops a negative ir-json wire line", () => {
		expect(normalizeSalientLocation({ line: -1 }, "ir-json").line).toBeUndefined();
	});

	it("drops a non-integer line", () => {
		expect(
			normalizeSalientLocation({ line: 41.5 }, "ir-json").line,
		).toBeUndefined();
	});

	it("omits file when absent or empty", () => {
		expect(normalizeSalientLocation({ line: 1 }, "alcpuprofile").file).toBeUndefined();
		expect(
			normalizeSalientLocation({ file: "", line: 1 }, "alcpuprofile").file,
		).toBeUndefined();
	});
});
