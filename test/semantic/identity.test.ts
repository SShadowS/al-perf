/**
 * identity.test.ts — Unit tests for src/semantic/identity.ts
 *
 * Covers:
 *  - parseObjectId: valid `/`-form, malformed inputs (colon-form, too many
 *    segments, non-integer number, empty segments)
 *  - canonicalObjectType: runtime→canonical (CodeUnit, XMLPort), al-sem→same
 *    (Codeunit, XMLport), TableData→Table, extension kinds, unknown pass-through
 *  - normalizeTriggerName: field trigger strip, multi-separator edge case, no-op
 *  - isAlRoutineFrame: AL routine → true; builtin → false; SQL prefixes → false
 */

import { describe, expect, it } from "bun:test";
import {
	canonicalObjectType,
	isAlRoutineFrame,
	normalizeTriggerName,
	parseObjectId,
} from "../../src/semantic/identity.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";

// ---------------------------------------------------------------------------
// parseObjectId
// ---------------------------------------------------------------------------

describe("parseObjectId", () => {
	it("parses a well-formed /Codeunit/ objectId", () => {
		const result = parseObjectId(
			"a1b2c3d4-e5f6-7890-abcd-ef1234567890/Codeunit/50100",
		);
		expect(result).not.toBeNull();
		expect(result!.appGuid).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
		expect(result!.objectType).toBe("Codeunit");
		expect(result!.objectNumber).toBe(50100);
	});

	it("parses objectNumber 0 as valid", () => {
		const result = parseObjectId(
			"some-guid-1234-5678-9abc-def012345678/Table/0",
		);
		expect(result).not.toBeNull();
		expect(result!.objectNumber).toBe(0);
	});

	it("returns null for colon-form (: delimiter)", () => {
		// al-sem snapshot uses `:` but the internal/analyze form uses `/`
		expect(
			parseObjectId("a1b2c3d4-e5f6-7890-abcd-ef1234567890:Codeunit:50100"),
		).toBeNull();
	});

	it("returns null when split yields 2 segments", () => {
		expect(parseObjectId("guid/Codeunit")).toBeNull();
	});

	it("returns null when split yields 4 segments", () => {
		expect(parseObjectId("a/b/c/d")).toBeNull();
	});

	it("returns null for non-integer objectNumber", () => {
		expect(parseObjectId("guid/Codeunit/notanumber")).toBeNull();
	});

	it("returns null for float objectNumber", () => {
		expect(parseObjectId("guid/Codeunit/50100.5")).toBeNull();
	});

	it("returns null when any segment is empty", () => {
		expect(parseObjectId("/Codeunit/50100")).toBeNull(); // empty appGuid
		expect(parseObjectId("guid//50100")).toBeNull(); // empty objectType
		expect(parseObjectId("guid/Codeunit/")).toBeNull(); // empty objectNumber
	});

	it("preserves the objectType as-is (does not canonicalise)", () => {
		// parseObjectId is a pure splitter; canonicalisation is caller's job
		const result = parseObjectId("guid/XMLPort/9999");
		expect(result).not.toBeNull();
		expect(result!.objectType).toBe("XMLPort");
	});
});

// ---------------------------------------------------------------------------
// canonicalObjectType
// ---------------------------------------------------------------------------

describe("canonicalObjectType", () => {
	// Runtime spellings from al-perf's object-types.ts numeric map
	it("CodeUnit → Codeunit", () => {
		expect(canonicalObjectType("CodeUnit")).toBe("Codeunit");
	});

	it("XMLPort → XMLport", () => {
		expect(canonicalObjectType("XMLPort")).toBe("XMLport");
	});

	it("codeunit (lowercase) → Codeunit", () => {
		expect(canonicalObjectType("codeunit")).toBe("Codeunit");
	});

	it("xmlport (lowercase) → XMLport", () => {
		expect(canonicalObjectType("xmlport")).toBe("XMLport");
	});

	// al-sem spellings are already canonical — should return unchanged
	it("Codeunit is already canonical", () => {
		expect(canonicalObjectType("Codeunit")).toBe("Codeunit");
	});

	it("XMLport is already canonical", () => {
		expect(canonicalObjectType("XMLport")).toBe("XMLport");
	});

	// Special alias
	it("TableData → Table", () => {
		expect(canonicalObjectType("TableData")).toBe("Table");
	});

	it("tabledata (lowercase) → Table", () => {
		expect(canonicalObjectType("tabledata")).toBe("Table");
	});

	it("Table → Table", () => {
		expect(canonicalObjectType("Table")).toBe("Table");
	});

	// Extension kinds
	it("PageExtension → PageExtension", () => {
		expect(canonicalObjectType("PageExtension")).toBe("PageExtension");
	});

	it("TableExtension → TableExtension", () => {
		expect(canonicalObjectType("TableExtension")).toBe("TableExtension");
	});

	it("pageextension (lowercase) → PageExtension", () => {
		expect(canonicalObjectType("pageextension")).toBe("PageExtension");
	});

	it("EnumExtension → EnumExtension", () => {
		expect(canonicalObjectType("EnumExtension")).toBe("EnumExtension");
	});

	// Other standard types
	it("REPORT (all caps) → Report", () => {
		expect(canonicalObjectType("REPORT")).toBe("Report");
	});

	it("Page → Page", () => {
		expect(canonicalObjectType("Page")).toBe("Page");
	});

	it("Query → Query", () => {
		expect(canonicalObjectType("Query")).toBe("Query");
	});

	it("Interface → Interface", () => {
		expect(canonicalObjectType("Interface")).toBe("Interface");
	});

	it("Enum → Enum", () => {
		expect(canonicalObjectType("Enum")).toBe("Enum");
	});

	// Unknown types pass through unchanged
	it("unknown type passes through unchanged", () => {
		expect(canonicalObjectType("SomeUnknownType")).toBe("SomeUnknownType");
	});

	it("System passes through unchanged (not an AL object kind)", () => {
		// "System" appears in some profiles but is not a source-code object type
		expect(canonicalObjectType("System")).toBe("System");
	});
});

// ---------------------------------------------------------------------------
// normalizeTriggerName
// ---------------------------------------------------------------------------

describe("normalizeTriggerName", () => {
	it("strips a simple field trigger prefix", () => {
		expect(normalizeTriggerName("Sell-to Customer No. - OnValidate")).toBe(
			"OnValidate",
		);
	});

	it("strips a short field trigger prefix", () => {
		expect(normalizeTriggerName("No. - OnInsert")).toBe("OnInsert");
	});

	it("strips prefix from a page control trigger", () => {
		expect(normalizeTriggerName("Amount - OnAfterValidate")).toBe(
			"OnAfterValidate",
		);
	});

	it("leaves a plain procedure name unchanged (no ` - ` separator)", () => {
		expect(normalizeTriggerName("ProcessRecords")).toBe("ProcessRecords");
	});

	it("leaves OnRun unchanged (trigger without field prefix)", () => {
		expect(normalizeTriggerName("OnRun")).toBe("OnRun");
	});

	it("leaves OnInsert unchanged (trigger without field prefix)", () => {
		expect(normalizeTriggerName("OnInsert")).toBe("OnInsert");
	});

	it("edge case: field name contains ` - ` — strips at the last occurrence when suffix is a trigger", () => {
		// A field named "Start - End Date" with trigger OnValidate
		expect(normalizeTriggerName("Start - End Date - OnValidate")).toBe(
			"OnValidate",
		);
	});

	it("does NOT over-strip a quoted procedure whose suffix is not a trigger keyword", () => {
		// A real AL procedure named "Get - Value" must NOT become "Value" (which
		// would cause a spurious blind-spot). "Value" is not a trigger keyword.
		expect(normalizeTriggerName("Get - Value")).toBe("Get - Value");
	});

	it("does NOT strip when the suffix is an ordinary word", () => {
		expect(normalizeTriggerName("Compute - Total")).toBe("Compute - Total");
	});

	it("strips OnAction (page action trigger)", () => {
		expect(normalizeTriggerName("Post - OnAction")).toBe("OnAction");
	});

	it("strips OnLookup (field trigger)", () => {
		expect(normalizeTriggerName("Customer No. - OnLookup")).toBe("OnLookup");
	});

	it("strips OnAfterGetRecord (page/report trigger)", () => {
		expect(normalizeTriggerName("Rec - OnAfterGetRecord")).toBe(
			"OnAfterGetRecord",
		);
	});

	it("trigger-suffix match is case-insensitive", () => {
		// Profiles may vary casing; the suffix check lowercases before matching
		expect(normalizeTriggerName("Field A - onvalidate")).toBe("onvalidate");
	});

	it("returns ` - ` unchanged (suffix is empty, not a trigger)", () => {
		// functionName is exactly " - " — suffix is "" which is not a trigger
		// keyword, so the string is left untouched (no over-strip, no throw)
		expect(normalizeTriggerName(" - ")).toBe(" - ");
	});
});

// ---------------------------------------------------------------------------
// isAlRoutineFrame
// ---------------------------------------------------------------------------

function makeMethod(
	functionName: string,
	isBuiltin?: boolean,
): MethodBreakdown {
	return {
		functionName,
		objectType: "Codeunit",
		objectName: "TestObject",
		objectId: 50100,
		appName: "TestApp",
		selfTime: 100,
		selfTimePercent: 10,
		totalTime: 100,
		totalTimePercent: 10,
		hitCount: 1,
		calledBy: [],
		calls: [],
		costPerHit: 100,
		efficiencyScore: 1.0,
		isBuiltin,
	};
}

describe("isAlRoutineFrame", () => {
	it("returns true for a plain AL procedure name", () => {
		expect(isAlRoutineFrame(makeMethod("ProcessRecords"))).toBe(true);
	});

	it("returns true for a trigger with no builtin flag", () => {
		expect(isAlRoutineFrame(makeMethod("OnRun"))).toBe(true);
	});

	it("returns true when isBuiltin is explicitly false", () => {
		expect(isAlRoutineFrame(makeMethod("DoWork", false))).toBe(true);
	});

	it("returns true when isBuiltin is undefined (not set)", () => {
		expect(isAlRoutineFrame(makeMethod("DoWork", undefined))).toBe(true);
	});

	it("returns false when isBuiltin is true", () => {
		expect(isAlRoutineFrame(makeMethod("OnRun", true))).toBe(false);
	});

	it("returns false for a SELECT SQL frame", () => {
		expect(
			isAlRoutineFrame(makeMethod("SELECT TOP 1 * FROM [Sales Header]")),
		).toBe(false);
	});

	it("returns false for a SELECT frame (lowercase)", () => {
		expect(isAlRoutineFrame(makeMethod("select * from customer"))).toBe(false);
	});

	it("returns false for an INSERT SQL frame", () => {
		expect(isAlRoutineFrame(makeMethod("INSERT INTO [Customer] …"))).toBe(
			false,
		);
	});

	it("returns false for an UPDATE SQL frame", () => {
		expect(isAlRoutineFrame(makeMethod("UPDATE [Sales Line] SET …"))).toBe(
			false,
		);
	});

	it("returns false for a DELETE SQL frame", () => {
		expect(isAlRoutineFrame(makeMethod("DELETE FROM [Item] WHERE …"))).toBe(
			false,
		);
	});

	it("returns false for IF EXISTS SQL frame", () => {
		expect(isAlRoutineFrame(makeMethod("IF EXISTS (SELECT …)"))).toBe(false);
	});

	it("returns false for IF NOT EXISTS SQL frame", () => {
		expect(isAlRoutineFrame(makeMethod("IF NOT EXISTS (SELECT …)"))).toBe(
			false,
		);
	});

	it("returns false for EXEC SQL frame", () => {
		expect(isAlRoutineFrame(makeMethod("EXEC sp_something"))).toBe(false);
	});

	it("a field trigger frame (not builtin) is an AL frame", () => {
		// The profile reports the compound name; isAlRoutineFrame only checks
		// builtin/SQL — the trigger normalization is done separately
		expect(
			isAlRoutineFrame(makeMethod("Sell-to Customer No. - OnValidate")),
		).toBe(true);
	});
});
