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
	computePatternFingerprint,
	computeTelemetryFingerprint,
	FINGERPRINT_ALGO_VERSION,
	type FindingFingerprint,
	type FingerprintRoutineIdentity,
	formatFingerprint,
	linkFingerprints,
	normalizeSalientLocation,
	routineIdentityFromCorrelation,
	wrapAlsemFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import type { SemanticAttribution } from "../../src/types/fused.js";

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
		expect(
			normalizeSalientLocation({ line: -1 }, "ir-json").line,
		).toBeUndefined();
	});

	it("drops a non-integer line", () => {
		expect(
			normalizeSalientLocation({ line: 41.5 }, "ir-json").line,
		).toBeUndefined();
	});

	it("omits file when absent or empty", () => {
		expect(
			normalizeSalientLocation({ line: 1 }, "alcpuprofile").file,
		).toBeUndefined();
		expect(
			normalizeSalientLocation({ file: "", line: 1 }, "alcpuprofile").file,
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// computePatternFingerprint / formatFingerprint
// ---------------------------------------------------------------------------

/** A pre-normalized fallback identity used across the fingerprint tests. */
const FALLBACK_ID: FingerprintRoutineIdentity = {
	kind: "fallback",
	appId: "437dbf0e84ff417a965ded2bb9650972",
	canonicalObjectType: "Codeunit",
	objectNumber: 50100,
	normalizedRoutineName: "processrecords",
};

/** A stable identity for the SAME routine (confident alsem match). */
const STABLE_ID: FingerprintRoutineIdentity = {
	kind: "stable",
	stableRoutineId:
		"437dbf0e-84ff-417a-965d-ed2bb9650972:Codeunit:50100#a1b2c3d4",
};

const APP_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";

describe("computePatternFingerprint", () => {
	it("is deterministic: identical inputs → identical fingerprints", () => {
		const a = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const b = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(a).toEqual(b);
	});

	it("emits a 16-char lowercase hex value", () => {
		const fp = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(fp.value).toMatch(/^[0-9a-f]{16}$/);
	});

	it("stamps namespace 'pattern' and the current algo version", () => {
		const fp = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(fp.namespace).toBe("pattern");
		expect(fp.algoVersion).toBe(FINGERPRINT_ALGO_VERSION);
	});

	it("stable identity vs fallback identity for the SAME routine diverge", () => {
		// Until a migration links them, these are distinct identities by design.
		const viaFallback = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const viaStable = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			STABLE_ID,
			APP_ID,
		);
		expect(viaFallback.value).not.toBe(viaStable.value);
	});

	it("different patternId on the same routine → different fingerprints", () => {
		const a = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const b = computePatternFingerprint(
			{ patternId: "modify-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(a.value).not.toBe(b.value);
	});

	it("different appId → different fingerprints", () => {
		const a = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const b = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			"11111111-2222-3333-4444-555555555555",
		);
		expect(a.value).not.toBe(b.value);
	});

	it("dashed and dash-less appId forms normalize to the same fingerprint", () => {
		const dashed = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			"437dbf0e-84ff-417a-965d-ed2bb9650972",
		);
		const dashless = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			"437DBF0E84FF417A965DED2BB9650972",
		);
		expect(dashed.value).toBe(dashless.value);
	});

	it("line-shift stability: routine-anchored patterns carry no location, so shifted source lines cannot change identity", () => {
		// The contract for loop-type / routine-anchored patterns (all 18 current
		// detectors): salientLocation is OMITTED. The same finding before and
		// after an unrelated edit shifts every line — identity must not change.
		const before = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const after = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(before.value).toBe(after.value);
	});

	it("a provided salient location DOES participate in the hash", () => {
		const without = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const withLoc = computePatternFingerprint(
			{
				patternId: "calcfields-in-loop",
				salientLocation: normalizeSalientLocation(
					{ file: "src/SalesPost.Codeunit.al", line: 42 },
					"alcpuprofile",
				),
			},
			FALLBACK_ID,
			APP_ID,
		);
		expect(without.value).not.toBe(withLoc.value);
	});

	it("capture-kind equivalence at the hash level: wire line N ≡ display line N+1", () => {
		const fromWire = computePatternFingerprint(
			{
				patternId: "calcfields-in-loop",
				salientLocation: normalizeSalientLocation(
					{ file: "src/SalesPost.Codeunit.al", line: 41 },
					"ir-json",
				),
			},
			FALLBACK_ID,
			APP_ID,
		);
		const fromDisplay = computePatternFingerprint(
			{
				patternId: "calcfields-in-loop",
				salientLocation: normalizeSalientLocation(
					{ file: "src/SalesPost.Codeunit.al", line: 42 },
					"alcpuprofile",
				),
			},
			FALLBACK_ID,
			APP_ID,
		);
		expect(fromWire.value).toBe(fromDisplay.value);
	});
});

describe("formatFingerprint", () => {
	it("renders the canonical '<namespace>:<value>' string form", () => {
		const fp = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(formatFingerprint(fp)).toBe(`pattern:${fp.value}`);
	});
});

// ---------------------------------------------------------------------------
// wrapAlsemFingerprint
// ---------------------------------------------------------------------------

describe("wrapAlsemFingerprint", () => {
	it("passes the native alsem fingerprint through verbatim (never re-hashed)", () => {
		const fp = wrapAlsemFingerprint("alsem-native-fp-xyz");
		expect(fp.value).toBe("alsem-native-fp-xyz");
	});

	it("stamps namespace 'alsem' and the current algo version", () => {
		const fp = wrapAlsemFingerprint("alsem-native-fp-xyz");
		expect(fp.namespace).toBe("alsem");
		expect(fp.algoVersion).toBe(FINGERPRINT_ALGO_VERSION);
	});

	it("string form prefixes the namespace exactly once", () => {
		const fp = wrapAlsemFingerprint("native:with:colons");
		expect(formatFingerprint(fp)).toBe("alsem:native:with:colons");
	});
});

// ---------------------------------------------------------------------------
// computeTelemetryFingerprint
// ---------------------------------------------------------------------------

describe("computeTelemetryFingerprint", () => {
	const INPUT = {
		signalId: "RT0018",
		appId: "437dbf0e-84ff-417a-965d-ed2bb9650972",
		objectType: "Codeunit",
		objectNumber: 50100,
		routineName: "ProcessRecords",
	};

	it("is deterministic and emits a 16-char lowercase hex value", () => {
		const a = computeTelemetryFingerprint(INPUT);
		const b = computeTelemetryFingerprint(INPUT);
		expect(a).toEqual(b);
		expect(a.value).toMatch(/^[0-9a-f]{16}$/);
	});

	it("stamps namespace 'telemetry' and the current algo version", () => {
		const fp = computeTelemetryFingerprint(INPUT);
		expect(fp.namespace).toBe("telemetry");
		expect(fp.algoVersion).toBe(FINGERPRINT_ALGO_VERSION);
	});

	it("different signalId on the same routine → different identity (RT0018 ≠ RT0005)", () => {
		const rt18 = computeTelemetryFingerprint(INPUT);
		const rt05 = computeTelemetryFingerprint({ ...INPUT, signalId: "RT0005" });
		expect(rt18.value).not.toBe(rt05.value);
	});

	it("normalizes like the pattern fallback key: casing, appId dashes, trigger prefix", () => {
		const canonical = computeTelemetryFingerprint(INPUT);
		const messy = computeTelemetryFingerprint({
			signalId: "RT0018",
			appId: "437DBF0E84FF417A965DED2BB9650972",
			objectType: "CodeUnit",
			objectNumber: 50100,
			routineName: "PROCESSRECORDS",
		});
		expect(messy.value).toBe(canonical.value);

		// Field-trigger names get the "<member> - " prefix stripped, like the join key.
		const bare = computeTelemetryFingerprint({
			...INPUT,
			routineName: "OnValidate",
		});
		const compound = computeTelemetryFingerprint({
			...INPUT,
			routineName: "Sell-to Customer No. - OnValidate",
		});
		expect(compound.value).toBe(bare.value);
	});
});

// ---------------------------------------------------------------------------
// Namespace non-collision
// ---------------------------------------------------------------------------

describe("namespace non-collision", () => {
	const FALLBACK: FingerprintRoutineIdentity = {
		kind: "fallback",
		appId: "437dbf0e84ff417a965ded2bb9650972",
		canonicalObjectType: "Codeunit",
		objectNumber: 50100,
		normalizedRoutineName: "processrecords",
	};

	it("pattern and telemetry over the same routine never share an identity", () => {
		const pattern = computePatternFingerprint(
			{ patternId: "high-hit-count" },
			FALLBACK,
			"437dbf0e-84ff-417a-965d-ed2bb9650972",
		);
		const telemetry = computeTelemetryFingerprint({
			signalId: "high-hit-count", // adversarial: same discriminator string
			appId: "437dbf0e-84ff-417a-965d-ed2bb9650972",
			objectType: "Codeunit",
			objectNumber: 50100,
			routineName: "ProcessRecords",
		});
		// The domain token makes even the raw hashes differ …
		expect(pattern.value).not.toBe(telemetry.value);
		// … and the namespace prefix guarantees distinct string forms regardless.
		expect(formatFingerprint(pattern)).not.toBe(formatFingerprint(telemetry));
	});

	it("an alsem native value equal to a pattern hash still cannot collide", () => {
		const pattern = computePatternFingerprint(
			{ patternId: "high-hit-count" },
			FALLBACK,
			"437dbf0e-84ff-417a-965d-ed2bb9650972",
		);
		const alsem = wrapAlsemFingerprint(pattern.value);
		expect(formatFingerprint(alsem)).not.toBe(formatFingerprint(pattern));
	});
});

// ---------------------------------------------------------------------------
// routineIdentityFromCorrelation
// ---------------------------------------------------------------------------

describe("routineIdentityFromCorrelation", () => {
	const METHOD = {
		appId: "437DBF0E-84FF-417A-965D-ED2BB9650972",
		objectType: "CodeUnit",
		objectId: 50100,
		functionName: "ProcessRecords",
	};

	const SID = "437dbf0e-84ff-417a-965d-ed2bb9650972:Codeunit:50100#a1b2c3d4";

	it("matched with a single stableRoutineId → stable identity", () => {
		const attr: SemanticAttribution = {
			status: "matched",
			findings: [],
			attributionConfidence: "exact",
			stableRoutineId: SID,
		};
		expect(routineIdentityFromCorrelation(attr, METHOD)).toEqual({
			kind: "stable",
			stableRoutineId: SID,
		});
	});

	it("ambiguous NEVER mints a stable identity, even though candidate ids are present", () => {
		const attr: SemanticAttribution = {
			status: "ambiguous",
			findings: [],
			attributionConfidence: "ambiguous",
			stableRoutineId: [SID, `${SID}ff`],
		};
		const id = routineIdentityFromCorrelation(attr, METHOD);
		expect(id.kind).toBe("fallback");
	});

	it("blind-spot → fallback identity", () => {
		const attr: SemanticAttribution = {
			status: "blind-spot",
			findings: [],
			attributionConfidence: "exact",
			reason: "object Codeunit 50100 was not analyzed",
		};
		expect(routineIdentityFromCorrelation(attr, METHOD).kind).toBe("fallback");
	});

	it("no attribution at all (profile-only, no fusion) → fallback identity", () => {
		expect(routineIdentityFromCorrelation(undefined, METHOD).kind).toBe(
			"fallback",
		);
	});

	it("matched but stableRoutineId is an array → fallback (defensive)", () => {
		const attr: SemanticAttribution = {
			status: "matched",
			findings: [],
			attributionConfidence: "exact",
			stableRoutineId: [SID],
		};
		expect(routineIdentityFromCorrelation(attr, METHOD).kind).toBe("fallback");
	});

	it("fallback fields are fully normalized", () => {
		const id = routineIdentityFromCorrelation(undefined, {
			appId: "437DBF0E-84FF-417A-965D-ED2BB9650972",
			objectType: "CodeUnit",
			objectId: 50100,
			functionName: "Sell-to Customer No. - OnValidate",
		});
		expect(id).toEqual({
			kind: "fallback",
			appId: "437dbf0e84ff417a965ded2bb9650972",
			canonicalObjectType: "Codeunit",
			objectNumber: 50100,
			normalizedRoutineName: "onvalidate",
		});
	});

	it("absent appId → fallback with empty appId (profile-only findings stay fingerprintable)", () => {
		const id = routineIdentityFromCorrelation(undefined, {
			objectType: "Codeunit",
			objectId: 50100,
			functionName: "ProcessRecords",
		});
		expect(id).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "Codeunit",
			objectNumber: 50100,
			normalizedRoutineName: "processrecords",
		});
	});
});

// ---------------------------------------------------------------------------
// linkFingerprints
// ---------------------------------------------------------------------------

describe("linkFingerprints", () => {
	const FALLBACK: FingerprintRoutineIdentity = {
		kind: "fallback",
		appId: "437dbf0e84ff417a965ded2bb9650972",
		canonicalObjectType: "Codeunit",
		objectNumber: 50100,
		normalizedRoutineName: "processrecords",
	};
	const STABLE: FingerprintRoutineIdentity = {
		kind: "stable",
		stableRoutineId:
			"437dbf0e-84ff-417a-965d-ed2bb9650972:Codeunit:50100#a1b2c3d4",
	};
	const APP = "437dbf0e-84ff-417a-965d-ed2bb9650972";

	const v1Fp = computePatternFingerprint(
		{ patternId: "calcfields-in-loop" },
		FALLBACK,
		APP,
	);
	// A future-algo fingerprint, constructed literally (FindingFingerprint is
	// a plain data type; only THIS module can mint v-current hashes).
	const v2Fp: FindingFingerprint = {
		value: "0123456789abcdef",
		namespace: "pattern",
		algoVersion: 2,
	};

	it("produces a migration record with default reason 'algo-upgrade'", () => {
		const migration = linkFingerprints(v1Fp, v2Fp);
		expect(migration).toEqual({ from: v1Fp, to: v2Fp, reason: "algo-upgrade" });
	});

	it("algo-upgrade requires a strictly increasing algoVersion", () => {
		expect(() => linkFingerprints(v2Fp, v1Fp, "algo-upgrade")).toThrow();
		const sameVersion: FindingFingerprint = {
			...v1Fp,
			value: "fedcba9876543210",
		};
		expect(() => linkFingerprints(v1Fp, sameVersion, "algo-upgrade")).toThrow();
	});

	it("algo-upgrade requires the same namespace", () => {
		const telemetryV2: FindingFingerprint = {
			value: "0123456789abcdef",
			namespace: "telemetry",
			algoVersion: 2,
		};
		expect(() => linkFingerprints(v1Fp, telemetryV2, "algo-upgrade")).toThrow();
	});

	it("identity-upgrade links a fallback-key finding to its stable identity at the same version", () => {
		const stableFp = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			STABLE,
			APP,
		);
		const migration = linkFingerprints(v1Fp, stableFp, "identity-upgrade");
		expect(migration.reason).toBe("identity-upgrade");
		expect(migration.from).toEqual(v1Fp);
		expect(migration.to).toEqual(stableFp);
	});

	it("identity-upgrade requires the same namespace", () => {
		const alsemFp = wrapAlsemFingerprint("native-x");
		expect(() => linkFingerprints(v1Fp, alsemFp, "identity-upgrade")).toThrow();
	});

	it("manual-merge allows cross-namespace links (rename mitigation)", () => {
		const alsemFp = wrapAlsemFingerprint("native-x");
		const migration = linkFingerprints(v1Fp, alsemFp, "manual-merge");
		expect(migration.reason).toBe("manual-merge");
	});

	it("refuses to link an identity to itself", () => {
		expect(() => linkFingerprints(v1Fp, { ...v1Fp })).toThrow();
	});
});
