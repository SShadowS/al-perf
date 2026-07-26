import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fingerprintPatterns } from "../../src/lifecycle/wire.js";
import { buildSourceIndex } from "../../src/source/indexer.js";
import {
	detectCalcFieldsInLoop,
	detectDeleteInLoop,
	detectIncompleteSetLoadFields,
	detectInsertInLoop,
	detectMissingSetLoadFields,
	detectModifyInLoop,
	detectRecordOpInLoop,
	runSourceDetectors,
	syntheticMethodsFromIndex,
} from "../../src/source/source-patterns.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { SourceIndex } from "../../src/types/source-index.js";

const fixturesDir = resolve(import.meta.dir, "../fixtures/source");

let sourceIndex: SourceIndex;

beforeAll(async () => {
	sourceIndex = await buildSourceIndex(fixturesDir);
});

function makeMethod(overrides: Partial<MethodBreakdown>): MethodBreakdown {
	return {
		functionName: "TestProc",
		objectType: "Codeunit",
		objectName: "Test",
		objectId: 50100,
		appName: "Test App",
		selfTime: 1000,
		selfTimePercent: 10,
		totalTime: 2000,
		totalTimePercent: 20,
		hitCount: 100,
		calledBy: [],
		calls: [],
		...overrides,
	};
}

describe("detectCalcFieldsInLoop", () => {
	it("should detect CalcFields inside loop in ProcessRecords", () => {
		const method = makeMethod({
			functionName: "ProcessRecords",
			objectType: "Codeunit",
			objectId: 50100,
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].id).toBe("calcfields-in-loop");
		expect(patterns[0].severity).toBe("critical");
	});

	it("should not flag CalcFields outside loop", () => {
		const method = makeMethod({
			functionName: "SimpleMethod",
			objectType: "Codeunit",
			objectId: 50100,
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		expect(patterns.length).toBe(0);
	});
});

describe("detectModifyInLoop", () => {
	it("should detect Modify inside loop in ProcessRecords", () => {
		const method = makeMethod({
			functionName: "ProcessRecords",
			objectType: "Codeunit",
			objectId: 50100,
		});
		const patterns = detectModifyInLoop([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].id).toBe("modify-in-loop");
	});

	it("still flags only Modify/ModifyAll — Insert and Delete are separate findings", () => {
		const method = makeMethod({
			functionName: "ModifyAndInsertInLoop",
			objectType: "Codeunit",
			objectId: 50920,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		const modify = patterns.filter((p) => p.id === "modify-in-loop");
		const insert = patterns.filter((p) => p.id === "insert-in-loop");
		const del = patterns.filter((p) => p.id === "delete-in-loop");
		expect(modify.length).toBe(1);
		expect(insert.length).toBe(1);
		expect(del.length).toBe(1);
	});
});

describe("insert-in-loop", () => {
	it("flags Insert inside a loop", () => {
		const method = makeMethod({
			functionName: "InsertInLoop",
			objectType: "Codeunit",
			objectId: 50920,
		});
		const patterns = detectInsertInLoop([method], sourceIndex);
		const f = patterns.find((p) => p.id === "insert-in-loop");
		expect(f).toBeDefined();
		expect(f?.suggestion).toMatch(/temporary|bulk|batch/i);
	});

	it("does not flag Insert on a temporary record", () => {
		const method = makeMethod({
			functionName: "InsertInLoopTemp",
			objectType: "Codeunit",
			objectId: 50920,
		});
		const patterns = detectInsertInLoop([method], sourceIndex);
		expect(patterns.find((p) => p.id === "insert-in-loop")).toBeUndefined();
	});

	it("does not flag Insert() on a resolved non-Record variable (List of [Text])", () => {
		// Whole-branch review Blocker 1: RECORD_OPS (indexer.ts) matches the
		// method NAME only, and Insert() is a real method on List of [Text]
		// too. `Names` resolves in InsertOnNonRecordInLoop's own var_section
		// with isRecord === false, so isKnownNonRecordOp must exclude it. That
		// code touches no database.
		const method = makeMethod({
			functionName: "InsertOnNonRecordInLoop",
			objectType: "Codeunit",
			objectId: 50920,
		});
		const patterns = detectInsertInLoop([method], sourceIndex);
		expect(patterns.find((p) => p.id === "insert-in-loop")).toBeUndefined();
	});

	it("is wired into runSourceDetectors", () => {
		const method = makeMethod({
			functionName: "InsertInLoop",
			objectType: "Codeunit",
			objectId: 50920,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		expect(patterns.find((p) => p.id === "insert-in-loop")).toBeDefined();
	});
});

describe("delete-in-loop", () => {
	it("flags Delete inside a loop and suggests DeleteAll", () => {
		const method = makeMethod({
			functionName: "DeleteInLoop",
			objectType: "Codeunit",
			objectId: 50920,
		});
		const patterns = detectDeleteInLoop([method], sourceIndex);
		const f = patterns.find((p) => p.id === "delete-in-loop");
		expect(f).toBeDefined();
		expect(f?.suggestion).toContain("DeleteAll");
	});

	it("flags DeleteAll inside a loop deliberately — DeleteAll replaces the loop, not lives in one", () => {
		const method = makeMethod({
			functionName: "DeleteAllInLoop",
			objectType: "Codeunit",
			objectId: 50920,
		});
		const patterns = detectDeleteInLoop([method], sourceIndex);
		const f = patterns.find((p) => p.id === "delete-in-loop");
		expect(f).toBeDefined();
	});

	it("does not flag Delete on a temporary record", () => {
		const method = makeMethod({
			functionName: "DeleteInLoopTemp",
			objectType: "Codeunit",
			objectId: 50920,
		});
		const patterns = detectDeleteInLoop([method], sourceIndex);
		expect(patterns.find((p) => p.id === "delete-in-loop")).toBeUndefined();
	});

	it("does not double-report an HttpClient.Delete() as a record delete-in-loop", () => {
		// Whole-branch review Blocker 1: CodeUnit50300.al's HttpMethodsInLoop
		// calls Client.Delete(...) where Client: HttpClient. Get/Delete collide
		// with RECORD_OPS' method names by name alone (documented at
		// indexer.ts:566-568), so this used to ALSO produce a critical
		// delete-in-loop finding claiming a SQL DELETE, right next to the
		// correct external-call-in-loop finding on the same line — a single
		// HTTP call double-reported, once correctly and once as a fabricated
		// database write. Client resolves with isRecord === false, so
		// isKnownNonRecordOp must exclude it here.
		const method = makeMethod({
			functionName: "HttpMethodsInLoop",
			objectType: "Codeunit",
			objectId: 50300,
		});
		const patterns = detectDeleteInLoop([method], sourceIndex);
		expect(patterns.find((p) => p.id === "delete-in-loop")).toBeUndefined();
	});

	it("is wired into runSourceDetectors", () => {
		const method = makeMethod({
			functionName: "DeleteInLoop",
			objectType: "Codeunit",
			objectId: 50920,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		expect(patterns.find((p) => p.id === "delete-in-loop")).toBeDefined();
	});
});

describe("detectRecordOpInLoop", () => {
	it("should detect Get and CalcFields in for loop in LookupRecords", () => {
		const method = makeMethod({
			functionName: "LookupRecords",
			objectType: "Table",
			objectId: 50100,
		});
		const patterns = detectRecordOpInLoop([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].id).toBe("record-op-in-loop");
	});
});

describe("SourceTableTemporary", () => {
	it("does not charge SQL cost to Rec on a temporary-source page", () => {
		// SourceTableTemporary = true makes the page's whole Rec in-memory, so
		// "each iteration triggers a separate SQL query" is false for it. The
		// temp-ness is an object property -- there is no `var` declaration for
		// Rec, so variable-level resolution cannot see it. Vend in the same
		// loop is a real Record and must still be reported.
		const method = makeMethod({
			functionName: "FillFromJournal",
			objectType: "Page",
			objectId: 50804,
		});
		const patterns = detectRecordOpInLoop([method], sourceIndex);
		const receivers = patterns.map((p) => p.description);
		expect(receivers.some((d) => d.includes("Get() on Vend"))).toBe(true);
		expect(receivers.some((d) => d.includes("Get() on Rec"))).toBe(false);
	});

	it("does not report Insert on a temporary-source page's Rec", () => {
		const method = makeMethod({
			functionName: "FillFromJournal",
			objectType: "Page",
			objectId: 50804,
		});
		expect(detectInsertInLoop([method], sourceIndex)).toHaveLength(0);
	});
});

describe("detectMissingSetLoadFields", () => {
	it("should detect FindSet without SetLoadFields in ProcessRecords", () => {
		const method = makeMethod({
			functionName: "ProcessRecords",
			objectType: "Codeunit",
			objectId: 50100,
		});
		const patterns = detectMissingSetLoadFields([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].id).toBe("missing-setloadfields");
		expect(patterns[0].severity).toBe("warning");
	});

	it("is wired into runSourceDetectors", () => {
		// The detector call itself was deleted from runSourceDetectors's list
		// once already and the full 1776-test suite stayed green -- nothing
		// asserted the detector actually reaches production output.
		const method = makeMethod({
			functionName: "LateSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "missing-setloadfields"),
		).toBeDefined();
	});

	it("does not flag a RecordRef find — SetLoadFields there is a different API", () => {
		// FIND_OPS matches method NAMES, and RecordRef has FindFirst too. Its
		// fields are reached through FieldRef by number, so the suggestion this
		// detector emits does not apply. The same guard the loop detectors use
		// (isKnownNonRecordOp) resolves the receiver's declared type.
		const method = makeMethod({
			functionName: "RecordRefFindIsNotMissingSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectMissingSetLoadFields([method], sourceIndex);
		expect(patterns).toHaveLength(0);
	});
});

describe("missing-setloadfields — ordering", () => {
	it("still flags the FindSet when SetLoadFields comes AFTER it", () => {
		// LateSetLoadFields (CodeUnit50700): FindSet() on line 44, SetLoadFields()
		// on line 51. The bug is AT the FindSet -- at that moment no fields were
		// restricted yet. A SetLoadFields() further down the method does not
		// retroactively fix the find that already ran.
		const method = makeMethod({
			functionName: "LateSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectMissingSetLoadFields([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "missing-setloadfields"),
		).toBeDefined();
	});

	it("does not flag when SetLoadFields precedes the FindSet", () => {
		// FilteredQuery (CodeUnit50200): SetLoadFields() on line 34, FindSet() on
		// line 35 -- genuinely covered by the time the find runs.
		const method = makeMethod({
			functionName: "FilteredQuery",
			objectType: "Codeunit",
			objectId: 50200,
		});
		const patterns = detectMissingSetLoadFields([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "missing-setloadfields"),
		).toBeUndefined();
	});

	it("does not flag a temporary record", () => {
		// ProcessWithTempTable (CodeUnit50400): TempBuffer.FindSet() with no
		// SetLoadFields anywhere in the method. SetLoadFields is a no-op on a
		// temp record -- no SQL load happens -- so there is nothing to warn
		// about, regardless of ordering.
		const method = makeMethod({
			functionName: "ProcessWithTempTable",
			objectId: 50400,
		});
		const patterns = detectMissingSetLoadFields([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "missing-setloadfields"),
		).toBeUndefined();
	});
});

describe("missing-setloadfields — bare SetLoadFields() reset", () => {
	it("does not treat a bare SetLoadFields() as coverage — it resets to loading all fields", () => {
		// BareSetLoadFieldsReset (CodeUnit50700): SetLoadFields() with zero
		// arguments resets to loading ALL fields (Microsoft docs) -- it is not a
		// restriction, so it must not suppress the warning.
		const method = makeMethod({
			functionName: "BareSetLoadFieldsReset",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectMissingSetLoadFields([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "missing-setloadfields"),
		).toBeDefined();
	});
});

describe("missing-setloadfields — earliest SetLoadFields wins", () => {
	it("does not flag either find when SetLoadFields(A) precedes the first find and SetLoadFields(B) precedes the second", () => {
		// RepeatedSetLoadFieldsBetweenFinds (CodeUnit50700): SetLoadFields(A);
		// FindSet; SetLoadFields(B); FindSet. Both finds are genuinely preceded
		// by SOME restriction, so neither should be flagged. Anchoring on the
		// LATEST SetLoadFields per variable (instead of the earliest) would
		// evaluate the FIRST find against SetLoadFields(B), which has not run
		// yet at that point in the method -- a false positive.
		const method = makeMethod({
			functionName: "RepeatedSetLoadFieldsBetweenFinds",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectMissingSetLoadFields([method], sourceIndex);
		expect(
			patterns.filter((p) => p.id === "missing-setloadfields"),
		).toHaveLength(0);
	});
});

describe("missing-setloadfields — same-line position", () => {
	it("does not flag when SetLoadFields precedes FindSet earlier on the same physical line", () => {
		// SetLoadFieldsSameLineAsFindSet (CodeUnit50700): both calls on one
		// physical line, SetLoadFields written first (lower column). Comparing
		// line numbers alone treats an equal line as "not yet covered" and
		// wrongly flags this; comparing (line, column) resolves the tie.
		const method = makeMethod({
			functionName: "SetLoadFieldsSameLineAsFindSet",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectMissingSetLoadFields([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "missing-setloadfields"),
		).toBeUndefined();
	});
});

describe("temporary table exclusion", () => {
	it("skips CalcFields-in-loop for temporary record variables", () => {
		const method = makeMethod({
			functionName: "ProcessWithTempTable",
			objectId: 50400,
			objectName: "Temp Table Patterns",
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		// Should NOT flag the temporary table operation
		const tempPattern = patterns.find((p) =>
			p.title.includes("ProcessWithTempTable"),
		);
		expect(tempPattern).toBeUndefined();
	});

	it("still flags CalcFields-in-loop for real record variables", () => {
		const method = makeMethod({
			functionName: "ProcessWithRealTable",
			objectId: 50400,
			objectName: "Temp Table Patterns",
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
	});

	it("skips Modify-in-loop for temporary record variables", () => {
		const method = makeMethod({
			functionName: "ProcessWithTempTable",
			objectId: 50400,
			objectName: "Temp Table Patterns",
		});
		const patterns = detectModifyInLoop([method], sourceIndex);
		const tempPattern = patterns.find((p) =>
			p.title.includes("ProcessWithTempTable"),
		);
		expect(tempPattern).toBeUndefined();
	});
});

describe("CalcField severity graduation", () => {
	it("keeps critical severity when table has Sum CalcFormula fields", () => {
		const method = makeMethod({
			functionName: "ProcessWithSumCalcField",
			objectId: 50500,
			objectName: "CalcField Loop Test",
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].severity).toBe("critical");
		// The resolved field ("Total Amount") really is a Sum FlowField -- this
		// is a known fact, not a guess, so the suggestion may assert it.
		expect(patterns[0].suggestion).toContain(
			"This table has aggregation FlowFields (Sum/Count), which force a SQL aggregation per call.",
		);
	});

	it("downgrades to warning when table only has Lookup CalcFormula fields", () => {
		const method = makeMethod({
			functionName: "ProcessWithLookupCalcFieldOnly",
			objectId: 50500,
			objectName: "CalcField Loop Test",
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].severity).toBe("warning");
		expect(patterns[0].suggestion).toContain(
			"This table has Lookup FlowFields — cheaper than Sum/Count, but still one SQL query per iteration.",
		);
	});

	it("rates severity from the field actually passed to CalcFields, not the whole table", () => {
		// "CalcField Test Table" also has a Sum FlowField ("Total Amount") and a
		// Count FlowField ("Line Count") elsewhere, but this call only calculates
		// the Lookup field "Customer Name". Before the fix, severity was decided
		// from whether the TABLE had any aggregation FlowField, so this was rated
		// critical merely because of an unrelated Sum field on the same table.
		const method = makeMethod({
			functionName: "ProcessWithLookupFieldOnAggregationTable",
			objectId: 50500,
			objectName: "CalcField Loop Test",
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].severity).toBe("warning");
		// And the fact sentence must name the field actually called (Lookup),
		// not the unrelated Sum/Count fields also on this table.
		expect(patterns[0].suggestion).toContain(
			"This table has Lookup FlowFields",
		);
		expect(patterns[0].suggestion).not.toContain("aggregation FlowFields");
	});

	it("rates Exist FlowFields as warning, not critical, and names them correctly (not 'Lookup')", () => {
		// Exist FlowFields can short-circuit on the first matching row (SELECT
		// CASE WHEN EXISTS(...)), unlike Sum/Count/Average/Min/Max which must
		// scan every matching row -- same cost class as Lookup, so `warning` is
		// right. But lumping it into the "Lookup FlowFields" sentence would be
		// a different flavor of the exact falsehood this task exists to
		// eliminate: asserting a specific FlowField type that isn't what was
		// actually called. "CalcField Test Table" also has Sum/Count/Lookup
		// fields elsewhere -- this call only calculates the Exist field.
		const method = makeMethod({
			functionName: "ProcessWithExistCalcFieldOnly",
			objectId: 50500,
			objectName: "CalcField Loop Test",
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		const finding = patterns.find((p) => p.id === "calcfields-in-loop");
		expect(finding).toBeDefined();
		expect(finding!.severity).toBe("warning");
		expect(finding!.suggestion).toContain("Exist FlowField");
		expect(finding!.suggestion).not.toContain("Lookup FlowFields");
		expect(finding!.suggestion).not.toContain("aggregation FlowFields");
	});
});

describe("calcfields-in-loop — suggestion must be actionable", () => {
	it("never tells the user to use SetLoadFields on a FlowField, and never asserts a FlowField type it doesn't know", () => {
		// SetLoadFields does not accept FlowFields, and CalcFields operates on
		// FlowFields. Suggesting it is advice the user cannot follow.
		// https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/record/record-setloadfields-method
		//
		// The suggestion is still allowed (deliberately) to NAME SetLoadFields in
		// order to warn the user off it -- developers reach for it by reflex --
		// exactly once, and only in that disclaimer. Anything else naming it
		// (e.g. "use SetLoadFields", "consider SetLoadFields") is the bad advice
		// creeping back in.
		//
		// "Sales Line" is deliberately NOT in the fixture index -- this call
		// hits the table-not-found path, so the tool genuinely does not know
		// this field's CalcFormula type. It must not claim "This table has
		// aggregation FlowFields" (or any other FlowField-type claim) here --
		// that would be asserting a fact it has no evidence for.
		const method = makeMethod({
			functionName: "ProcessRecords",
			objectType: "Codeunit",
			objectId: 50100,
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		const finding = patterns.find((p) => p.id === "calcfields-in-loop");
		expect(finding).toBeDefined();
		const s = finding!.suggestion;
		expect(s).toContain("SetAutoCalcFields");
		// SetLoadFields may be named exactly once, and only to warn the user OFF it.
		expect([...s.matchAll(/SetLoadFields/gi)]).toHaveLength(1);
		expect(s).toMatch(
			/SetLoadFields\(\) does NOT help here — it does not accept FlowFields/,
		);
		// The field never resolved (table not in the index) -- no "This table
		// has ... FlowFields" claim may appear.
		expect(s).not.toContain("This table has");
	});

	it("warns the user off SetLoadFields by name on the warning-severity branch too", () => {
		const method = makeMethod({
			functionName: "ProcessWithLookupCalcFieldOnly",
			objectId: 50500,
			objectName: "CalcField Loop Test",
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		const finding = patterns.find((p) => p.id === "calcfields-in-loop");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warning");
		const s = finding!.suggestion;
		expect(s).toContain("SetAutoCalcFields");
		expect([...s.matchAll(/SetLoadFields/gi)]).toHaveLength(1);
		expect(s).toMatch(
			/SetLoadFields\(\) does NOT help here — it does not accept FlowFields/,
		);
	});
});

describe("calcfields-in-loop — CalcSums gets actionable advice", () => {
	it("does not tell a CalcSums to call SetAutoCalcFields (a no-op for CalcSums)", () => {
		// SetAutoCalcFields only affects FlowFields calculated via CalcFields as
		// each record is retrieved -- CalcSums re-sums a FlowField/SIFT field over
		// the record's current filter and is unaffected by it. Telling the user
		// to call it here is confident advice that does nothing, the same class
		// of bug the CalcFields suggestion fix (above) removed, in the sibling op.
		const method = makeMethod({
			functionName: "ProcessWithCalcSums",
			objectId: 50500,
			objectName: "CalcField Loop Test",
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		const finding = patterns.find(
			(p) => p.id === "calcfields-in-loop" && p.title.includes("CalcSums"),
		);
		expect(finding).toBeDefined();
		expect(finding?.suggestion).not.toContain("SetAutoCalcFields");
		expect(finding?.suggestion).toMatch(
			/outside the loop|filtered set|SIFT|CalcSums on the filtered/i,
		);
	});

	it("still tells a CalcFields to call SetAutoCalcFields", () => {
		const method = makeMethod({
			functionName: "ProcessWithSumCalcField",
			objectId: 50500,
			objectName: "CalcField Loop Test",
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		const finding = patterns.find(
			(p) => p.id === "calcfields-in-loop" && p.title.includes("CalcFields"),
		);
		expect(finding).toBeDefined();
		expect(finding?.suggestion).toContain("SetAutoCalcFields");
	});
});

describe("calcfields-in-loop — resolving fields through the merged table", () => {
	function findings(functionName: string) {
		return detectCalcFieldsInLoop(
			[makeMethod({ functionName, objectType: "Codeunit", objectId: 50975 })],
			sourceIndex,
		);
	}

	it("graduates severity off an extension-declared FlowField when the root is seen", () => {
		// "Ext Lookup" lives in tableextension 50971. Before the merge it did
		// not resolve at all and every such finding took the conservative
		// critical default.
		const p = findings("CalcExtFlowFieldOnRootSeenTable");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("warning");
		expect(p[0].suggestion).toMatch(/Lookup/i);
	});

	it("keeps critical for a bare CalcFields() on a fragment", () => {
		// The fallback is "every FlowField on the table"; on a fragment that is
		// a claim about fields nobody has seen.
		const p = findings("BareCalcFieldsOnFragment");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
		expect(p[0].suggestion).not.toMatch(/This table has/i);
	});

	it("keeps critical when only some called fields resolve on a fragment", () => {
		// "Orphan Lookup" (not "Orphan Sum") resolves; "Unseen Base Total" does
		// not. Deliberately a Lookup: if the resolved subset contained a Sum,
		// calcFieldSeverity would land on critical anyway (Sum forces it),
		// which would pass even with the allResolved fence deleted -- see the
		// mutation-testing note below.
		const p = findings("PartlyResolvedCalcFieldsOnFragment");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
		expect(p[0].suggestion).not.toMatch(/This table has/i);
	});

	it("keeps critical for a bare CalcFields() on a Lookup-only fragment", () => {
		// "Merge Absent Lookup"'s only known FlowField is a Lookup -- no
		// Sum/Count anywhere in the picture, so this is the case fence 1's own
		// comment describes: an unseen root Sum is what actually runs, and the
		// bare-call fallback must not downgrade on the Lookup alone.
		const p = findings("BareCalcFieldsOnLookupOnlyFragment");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
		expect(p[0].suggestion).not.toMatch(/This table has/i);
	});

	it("treats an ambiguous table exactly as an absent one, even though the winning root's fields survive", () => {
		// Two distinct roots both declare "Merge Ambig" (50973, 50974). The
		// merged entry is marked ambiguous, but the winning root's fields
		// (including this Lookup, added to 50973 only) are NOT empty -- so
		// this is the one case the `resolved.length === 0` branch cannot also
		// catch. Without the `|| table.ambiguous` fence, this would resolve
		// the Lookup and downgrade to warning.
		const p = findings("CalcFieldsOnAmbiguousFragment");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
		expect(p[0].suggestion).not.toMatch(/This table has/i);
	});
});

describe("duplicate wrong-advice sites stay fixed", () => {
	// Task 1 fixed four shipped copies of "use SetLoadFields() to pre-load the
	// fields you need" -- SetLoadFields does not accept FlowFields, and
	// CalcFields operates on FlowFields, so that advice cannot be followed.
	// This file's own suggestion strings are pinned above; the other three
	// copies had no test at all and were trivially reintroducible with the
	// full suite green. One guard per file, checked directly against the
	// shipped source text, so none of the four can drift back silently.
	const badAdvice = /(use|using|consider)\s+SetLoadFields/i;
	const files = [
		"../../src/source/source-patterns.ts",
		"../../src/core/what-if.ts",
		"../../src/mcp/server.ts",
		"../../src/cli/commands/analyze-source.ts",
	];

	for (const relPath of files) {
		it(`${relPath} does not tell the user to use/consider SetLoadFields for CalcFields-in-loop`, () => {
			const text = readFileSync(resolve(import.meta.dir, relPath), "utf-8");
			expect(text).not.toMatch(badAdvice);
		});
	}
});

describe("detectIncompleteSetLoadFields", () => {
	it("should flag SetLoadFields missing accessed fields", () => {
		const method = makeMethod({
			functionName: "BadSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].id).toBe("incomplete-setloadfields");
		expect(patterns[0].severity).toBe("warning");
		// The description should mention the missing field
		expect(patterns[0].description.toLowerCase()).toContain("amount");
	});

	it("should not flag complete SetLoadFields", () => {
		const method = makeMethod({
			functionName: "GoodSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
		expect(patterns).toHaveLength(0);
	});

	it("should not flag procedures without SetLoadFields", () => {
		const method = makeMethod({
			functionName: "NoSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
		expect(patterns).toHaveLength(0);
	});

	it("should include suggestion with missing field names", () => {
		const method = makeMethod({
			functionName: "BadSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].suggestion.toLowerCase()).toContain("amount");
	});

	it("is wired into runSourceDetectors", () => {
		// Same hole as detectMissingSetLoadFields: nothing asserted this
		// detector's output actually reaches runSourceDetectors either.
		const method = makeMethod({
			functionName: "BadSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "incomplete-setloadfields"),
		).toBeDefined();
	});
});

describe("incomplete-setloadfields — bare SetLoadFields() reset", () => {
	it("does not treat a bare SetLoadFields() as incomplete — it already loads every field", () => {
		// BareSetLoadFieldsReset (CodeUnit50700): SetLoadFields() with zero
		// arguments loads ALL fields (Microsoft docs). The pre-fix code treated
		// the empty argument list as "loads zero fields" and compared it
		// against every field later accessed, so it flagged Amount as
		// "missing" -- a live critical false positive shipped by this exact
		// fixture. Nothing can be missing from a call that loads everything.
		const method = makeMethod({
			functionName: "BareSetLoadFieldsReset",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "incomplete-setloadfields"),
		).toBeUndefined();
	});
});

describe("incomplete-setloadfields — temporary records", () => {
	it("does not flag a temporary record", () => {
		// ProcessTempWithIncompleteSetLoadFields (CodeUnit50400): SetLoadFields
		// is a no-op on a temporary record -- no SQL load happens -- so an
		// "incomplete" SetLoadFields call on a temp variable can never be a
		// real problem, regardless of what fields are later accessed.
		const method = makeMethod({
			functionName: "ProcessTempWithIncompleteSetLoadFields",
			objectId: 50400,
		});
		const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "incomplete-setloadfields"),
		).toBeUndefined();
	});
});

describe("incomplete-setloadfields — ordering", () => {
	it("does not blame a field access that happened before the SetLoadFields call ran", () => {
		// FieldAccessBeforeSetLoadFields (CodeUnit50700): Amount is accessed
		// BEFORE any SetLoadFields call runs, then SetLoadFields("Document No.")
		// runs, then only "Document No." is accessed afterward (and IS
		// covered). Aggregating every field access in the method regardless of
		// position (the pre-fix behavior) would count the early Amount access
		// against this SetLoadFields call and wrongly flag it as incomplete.
		const method = makeMethod({
			functionName: "FieldAccessBeforeSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
		expect(
			patterns.find((p) => p.id === "incomplete-setloadfields"),
		).toBeUndefined();
	});
});

describe("incomplete-setloadfields — per-access resolution (regression guard)", () => {
	it("does not flag either access when a later SetLoadFields narrows to different fields before each one", () => {
		// RepeatedSetLoadFieldsBetweenFinds (CodeUnit50700): SetLoadFields(A =
		// "Document No."); FindSet; read A; SetLoadFields(B = Amount); FindSet;
		// read B. Both reads are genuinely covered by the call in effect AT THE
		// TIME each one ran.
		//
		// THE REGRESSION this pins: a prior fix shared this detector's coverage
		// logic with missing-setloadfields by anchoring BOTH detectors on the
		// EARLIEST restrictive SetLoadFields call per variable. That is correct
		// for missing-setloadfields (existence of any preceding call is enough)
		// but wrong here -- it evaluated the SECOND read (Amount) against the
		// FIRST call's field set ("Document No." only) and reported Amount as
		// "missing", a critical-severity false positive on 100% correct AL. The
		// fix resolves coverage PER ACCESS (the LAST call before that specific
		// access), not by anchoring the whole method on the earliest call.
		const method = makeMethod({
			functionName: "RepeatedSetLoadFieldsBetweenFinds",
			objectType: "Codeunit",
			objectId: 50700,
		});
		expect(detectIncompleteSetLoadFields([method], sourceIndex)).toHaveLength(
			0,
		);
	});

	it("does not blame an access on an earlier call once a later bare reset re-loads everything", () => {
		// BareResetReplacesEarlierSetLoadFields (CodeUnit50700): SetLoadFields
		// ("Document No.") narrows, then a LATER bare SetLoadFields() resets to
		// loading ALL fields before Amount is read. The bare reset governs that
		// access -- it must not be evaluated against the earlier, no-longer-in-
		// effect narrower call. This is a pre-existing false positive (present
		// even before the earliest-vs-latest regression) that per-access
		// resolution closes as a side effect: a bare reset re-loads every field,
		// but anchoring on an earlier call for the whole method would still
		// blame this access on that earlier, narrower field set.
		const method = makeMethod({
			functionName: "BareResetReplacesEarlierSetLoadFields",
			objectType: "Codeunit",
			objectId: 50700,
		});
		expect(detectIncompleteSetLoadFields([method], sourceIndex)).toHaveLength(
			0,
		);
	});
});

describe("runSourceDetectors", () => {
	it("should run all source detectors and return sorted results", () => {
		const methods = [
			makeMethod({
				functionName: "ProcessRecords",
				objectType: "Codeunit",
				objectId: 50100,
				selfTime: 5000,
			}),
			makeMethod({
				functionName: "LookupRecords",
				objectType: "Table",
				objectId: 50100,
				selfTime: 3000,
			}),
		];
		const patterns = runSourceDetectors(methods, sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		for (let i = 1; i < patterns.length; i++) {
			expect(patterns[i].impact).toBeLessThanOrEqual(patterns[i - 1].impact);
		}
	});

	it("falls back to severity when two findings tie on (nonzero) impact", () => {
		// Report.OnAfterGetRecord findings are "critical" (runs once per row of
		// potentially millions); the identical shape on a Page is downgraded to
		// "warning" (tens of rows, not millions). Forcing both methods to the
		// same selfTime produces a genuine impact tie across every finding on
		// both methods — impact-only sorting would leave them in whatever order
		// the detectors happened to emit them.
		const critical = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "Report",
			objectId: 50800,
			selfTime: 4000,
		});
		const warning = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "Page",
			objectId: 50803,
			selfTime: 4000,
		});
		// detectInsertInLoop and detectDeleteInLoop both match Report AND Page,
		// and iterate the methods array in the order given below — so with the
		// warning-severity (Page) method listed first, their two findings
		// naturally emerge as [warning, critical] before any sort. A stable
		// impact-only sort is a no-op on a tie and would leave that inversion in
		// the final output; only a genuine severity fallback corrects it.
		const patterns = runSourceDetectors([warning, critical], sourceIndex);
		expect(patterns.length).toBeGreaterThan(1);
		expect(patterns.every((p) => p.impact === 4000)).toBe(true);

		const rank: Record<string, number> = { critical: 3, warning: 2, info: 1 };
		for (let i = 1; i < patterns.length; i++) {
			expect(rank[patterns[i].severity]).toBeLessThanOrEqual(
				rank[patterns[i - 1].severity],
			);
		}

		// Guard against a vacuous pass: both severities must actually be present.
		const severities = new Set(patterns.map((p) => p.severity));
		expect(severities.has("critical")).toBe(true);
		expect(severities.has("warning")).toBe(true);
	});
});

describe("per-row triggers are loop bodies", () => {
	it("flags CalcFields in a report OnAfterGetRecord", () => {
		// OnAfterGetRecord runs once per dataitem row — it IS the loop. There is no
		// `repeat` in the source, which is exactly why this was invisible.
		const method = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "Report",
			objectId: 50800,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		const found = patterns.find((p) => p.id === "calcfields-in-loop");
		expect(found).toBeDefined();
		expect(found!.severity).toBe("critical");
		// Step 5: a finding raised from an implicit loop must explain itself —
		// otherwise "inside a loop" against a trigger with no visible loop
		// reads as a tool bug, not a real finding.
		expect(found!.evidence).toContain("Report.OnAfterGetRecord");
		expect(found!.evidence).toContain("runs once per row");
		expect(found!.description).toContain("Report.OnAfterGetRecord");
	});

	it("does not treat OnPreDataItem as a loop body — it runs once", () => {
		// The guard against over-firing. Not every trigger is per-row.
		const method = makeMethod({
			functionName: "OnPreDataItem",
			objectType: "Report",
			objectId: 50801,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		expect(patterns.find((p) => p.id === "calcfields-in-loop")).toBeUndefined();
	});

	it("flags CalcFields in an XMLport OnAfterGetRecord (locks in the OBJECT_TYPE_MAP casing)", () => {
		// OBJECT_TYPE_MAP maps xmlport_declaration to "XMLport" (not "XmlPort"
		// or "Xmlport"). A casing mismatch in PER_ROW_TRIGGERS's keys would
		// silently no-op this whole object type while still type-checking.
		const method = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "XMLport",
			objectId: 50802,
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].evidence).toContain("XMLport.OnAfterGetRecord");
	});

	it("flags CalcFields in a Page OnAfterGetRecord without asserting a FlowField type it doesn't know", () => {
		// ImplicitRecPage.al's implicit `Rec` (a Page has no dataitem wrapper,
		// so there's no `var`-declared name to resolve) means `resolveCalcFields`
		// can never find a table match here — and "Cust. Ledger Entry" isn't
		// even in this fixture index, so the tool has zero evidence about
		// Balance's CalcFormula type either way. Before the Issue 4 fix, the
		// suggestion was keyed off the post-downgrade `warning` severity and
		// unconditionally claimed "This table has Lookup FlowFields — cheaper
		// than Sum/Count" here — false on both counts: nothing was resolved,
		// and Balance is conventionally a Sum FlowField, not Lookup.
		const method = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "Page",
			objectId: 50903,
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		const finding = patterns.find((p) => p.id === "calcfields-in-loop");
		expect(finding).toBeDefined();
		// Critical (conservative default, table unresolved), downgraded one
		// level for Page implicit loops.
		expect(finding!.severity).toBe("warning");
		expect(finding!.evidence).toContain("Page.OnAfterGetRecord");
		expect(finding!.suggestion).toContain("SetAutoCalcFields");
		expect(finding!.suggestion).not.toContain("This table has");
	});

	it("flags CalcFields in a PageExtension OnAfterGetRecord at reduced (warning) severity too", () => {
		// Whole-branch review Blocker 2: downgradePageImplicitLoop matched
		// implicitLoop?.startsWith("Page.") only. A pageextension's marker is
		// "PageExtension.OnAfterGetRecord", which does NOT start with "Page." —
		// so identical code (a bare CalcFields in OnAfterGetRecord) kept the
		// report/XMLport-level `critical` severity on a PageExtension while a
		// base Page got `warning`. Base pages can't be modified in place in
		// BC, so pageextensions are where almost all real page code lives —
		// this bug hit most real users, not the rare base-page override.
		const method = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "PageExtension",
			objectId: 50906,
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		const finding = patterns.find((p) => p.id === "calcfields-in-loop");
		expect(finding).toBeDefined();
		expect(finding!.severity).toBe("warning");
		expect(finding!.evidence).toContain("PageExtension.OnAfterGetRecord");
	});

	it("flags Modify in a Page OnAfterGetRecord at reduced (warning) severity", () => {
		// A page renders tens of rows, not a report's millions — same bug
		// shape, dropped one severity level (critical -> warning).
		const method = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "Page",
			objectId: 50803,
		});
		const patterns = detectModifyInLoop([method], sourceIndex);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].severity).toBe("warning");
		expect(patterns[0].evidence).toContain("Page.OnAfterGetRecord");
	});

	it("flags Insert in a report OnAfterGetRecord — insert-in-loop inherits the implicit-loop explanation", () => {
		// Same shape as the calcfields-in-loop test above: Insert() here has no
		// visible loop in the source either. The two new detectors (Task 2)
		// must not be exempt from the implicit-loop explanation (Task 7).
		const method = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "Report",
			objectId: 50800,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		const found = patterns.find((p) => p.id === "insert-in-loop");
		expect(found).toBeDefined();
		expect(found!.severity).toBe("critical");
		expect(found!.evidence).toContain("Report.OnAfterGetRecord");
		expect(found!.evidence).toContain("runs once per row");
		expect(found!.description).toContain("Report.OnAfterGetRecord");
	});

	it("flags Delete in a report OnAfterGetRecord — delete-in-loop inherits the implicit-loop explanation", () => {
		const method = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "Report",
			objectId: 50800,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		const found = patterns.find((p) => p.id === "delete-in-loop");
		expect(found).toBeDefined();
		expect(found!.severity).toBe("critical");
		expect(found!.evidence).toContain("Report.OnAfterGetRecord");
		expect(found!.evidence).toContain("runs once per row");
		expect(found!.description).toContain("Report.OnAfterGetRecord");
	});

	it("flags Insert in a Page OnAfterGetRecord at reduced (warning) severity", () => {
		// Same downgrade shape as the Modify-in-a-Page test above: a page
		// renders tens of rows, not a report's millions.
		const method = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "Page",
			objectId: 50803,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		const found = patterns.find((p) => p.id === "insert-in-loop");
		expect(found).toBeDefined();
		expect(found!.severity).toBe("warning");
		expect(found!.evidence).toContain("Page.OnAfterGetRecord");
	});

	it("flags Delete in a Page OnAfterGetRecord at reduced (warning) severity", () => {
		const method = makeMethod({
			functionName: "OnAfterGetRecord",
			objectType: "Page",
			objectId: 50803,
		});
		const patterns = runSourceDetectors([method], sourceIndex);
		const found = patterns.find((p) => p.id === "delete-in-loop");
		expect(found).toBeDefined();
		expect(found!.severity).toBe("warning");
		expect(found!.evidence).toContain("Page.OnAfterGetRecord");
	});

	it("does not promote table triggers (OnModify) to implicit loops", () => {
		// Table triggers are per-OPERATION, not per-row — they're only a loop
		// when the caller loops (cross-procedure propagation, out of scope
		// here). Flagging every CalcFields/Get/Modify in OnValidate/OnInsert/
		// OnModify would be noise.
		const method = makeMethod({
			functionName: "OnModify",
			objectType: "Table",
			objectId: 50100,
		});
		const patterns = detectRecordOpInLoop([method], sourceIndex);
		expect(patterns.find((p) => p.id === "record-op-in-loop")).toBeUndefined();
	});
});

describe("multi-member matching — final whole-branch-review blocker", () => {
	// matchToSource used to return matchAllToSource(...)[0] — a SINGLE
	// candidate for (name, objectType, objectId). But triggers are NOT
	// name-unique within an object: a report with two dataitems has TWO
	// OnAfterGetRecord members; a table with two field OnValidate triggers has
	// TWO OnValidate members. The old resolver collapsed both onto member #1,
	// double-reporting it while member #2..N were never analyzed at all.
	//
	// ReportTwoDataItems.al (Report 50909) and TableTwoValidateTriggers.al
	// (Table 50931) exist specifically to pin this: no fixture in the corpus
	// had two same-named members before them, so every corpus sweep in the
	// prior fix was structurally blind to this shape.
	let allSyntheticPatterns: ReturnType<typeof runSourceDetectors>;

	beforeAll(() => {
		allSyntheticPatterns = runSourceDetectors(
			syntheticMethodsFromIndex(sourceIndex),
			sourceIndex,
		);
	});

	it("syntheticMethodsFromIndex emits exactly ONE method per (name, objectType, objectId) even when multiple raw members share that name — the N² dedupe guard", () => {
		// Without this dedupe, two raw "OnAfterGetRecord" members would each
		// independently call matchAllToSource and each get back BOTH real
		// candidates — 2 methods x 2 candidates = 4 duplicate findings where
		// there should be 2. Removing the dedupe must turn this red.
		const methods = syntheticMethodsFromIndex(sourceIndex);
		expect(
			methods.filter((m) => m.objectType === "Report" && m.objectId === 50909),
		).toHaveLength(1);
		expect(
			methods.filter((m) => m.objectType === "Table" && m.objectId === 50931),
		).toHaveLength(1);
	});

	it("analyzes BOTH dataitems of a report with two same-named OnAfterGetRecord triggers — not just dataitem #1, and not duplicated", () => {
		const calcfields = allSyntheticPatterns.filter(
			(p) =>
				p.id === "calcfields-in-loop" &&
				p.involvedMethods[0] === "OnAfterGetRecord (Report 50909)",
		);
		const modify = allSyntheticPatterns.filter(
			(p) =>
				p.id === "modify-in-loop" &&
				p.involvedMethods[0] === "OnAfterGetRecord (Report 50909)",
		);
		// Exactly one CalcFields per dataitem (Customer AND Vendor) — not 1
		// (member #2 invisible, the pre-fix bug: revert to matchToSource[0] and
		// this drops to 1) and not 4 (N x N duplication if the dedupe above is
		// removed).
		expect(calcfields).toHaveLength(2);
		// Vendor's Modify() was never analyzed before this fix — matchToSource
		// always resolved "OnAfterGetRecord (Report 50909)" to the Customer
		// dataitem (member #1) only.
		expect(modify).toHaveLength(1);
	});

	it("does not move the fingerprint anchor across dataitems — both calcfields-in-loop findings on the report share the identical involvedMethods label", () => {
		const calcfields = allSyntheticPatterns.filter(
			(p) =>
				p.id === "calcfields-in-loop" &&
				p.involvedMethods[0] === "OnAfterGetRecord (Report 50909)",
		);
		expect(calcfields).toHaveLength(2);
		expect(calcfields[0].involvedMethods).toEqual(
			calcfields[1].involvedMethods,
		);
	});

	it("fingerprint stability verified via the real wiring (not assumed): both findings collapse to ONE fingerprint", () => {
		// Per src/lifecycle/wire.ts, identity is (patternId x anchor routine x
		// appId) with no salient location — N instances of one pattern on one
		// routine share ONE fingerprint. Proven here against the ACTUAL
		// fingerprintPatterns wiring, not just by comparing involvedMethods
		// strings by hand.
		const methods = syntheticMethodsFromIndex(sourceIndex);
		const patterns = runSourceDetectors(methods, sourceIndex).filter(
			(p) =>
				p.id === "calcfields-in-loop" &&
				p.involvedMethods[0] === "OnAfterGetRecord (Report 50909)",
		);
		expect(patterns).toHaveLength(2);
		fingerprintPatterns(patterns, methods);
		expect(patterns[0].fingerprint).toBeDefined();
		expect(patterns[0].fingerprint).toBe(patterns[1].fingerprint);
	});

	it("analyzes BOTH field OnValidate triggers of a table sharing the same trigger name — field #2's real repeat...until Modify() is a genuine critical finding, not an implicit-loop edge case", () => {
		// Table triggers are not per-row (see "does not promote table triggers"
		// above) — TableTwoValidateTriggers.al's second field deliberately uses
		// a real syntactic repeat...until loop so this is a genuine bug, not an
		// artifact of implicit-loop promotion.
		const calc = allSyntheticPatterns.filter(
			(p) =>
				p.id === "calcfields-in-loop" &&
				p.involvedMethods[0] === "OnValidate (Table 50931)",
		);
		const modify = allSyntheticPatterns.filter(
			(p) =>
				p.id === "modify-in-loop" &&
				p.involvedMethods[0] === "OnValidate (Table 50931)",
		);
		expect(calc).toHaveLength(1); // field "Customer No." — not doubled
		expect(modify).toHaveLength(1); // field "Related No." — invisible before this fix
		expect(modify[0]?.severity).toBe("critical");
	});
});

describe("source-match collision — codeunit and table sharing id 50999", () => {
	it("attributes calcfields-in-loop to the Codeunit, not the Table", () => {
		// Both objects declare Refresh() and share id 50999; only the codeunit's
		// Refresh has the loop. Before the locator fix, the Table's Refresh was a
		// phantom anchor for this finding.
		const patterns = runSourceDetectors(
			syntheticMethodsFromIndex(sourceIndex),
			sourceIndex,
		);
		const calc = patterns.filter(
			(p) =>
				p.id === "calcfields-in-loop" &&
				p.involvedMethods[0].startsWith("Refresh ("),
		);
		expect(calc).toHaveLength(1);
		expect(calc[0].involvedMethods[0]).toContain("Codeunit");
		expect(calc[0].involvedMethods[0]).not.toContain("Table");
	});
});

describe("record parameters reach the detectors", () => {
	it("does not report inserts into a temporary record PARAMETER", () => {
		// The buffer's temp-ness is declared on the parameter. Before parameters
		// were indexed, isTemporaryOp could not see it and every Insert into a
		// caller-owned buffer read as a SQL INSERT per row.
		const method = makeMethod({
			functionName: "FillBuffer",
			objectType: "Codeunit",
			objectId: 50960,
		});
		expect(detectInsertInLoop([method], sourceIndex)).toHaveLength(0);
	});

	it("still reports inserts into a non-temporary record parameter", () => {
		const method = makeMethod({
			functionName: "InsertIntoRealParameterRecord",
			objectType: "Codeunit",
			objectId: 50960,
		});
		expect(detectInsertInLoop([method], sourceIndex)).toHaveLength(1);
	});
});

describe("object-level globals reach the detectors", () => {
	function m(functionName: string) {
		return makeMethod({
			functionName,
			objectType: "Codeunit",
			objectId: 50970,
		});
	}

	it("does not report inserts into an object-level TEMPORARY record", () => {
		expect(
			detectInsertInLoop([m("FillGlobalTempBuffer")], sourceIndex),
		).toHaveLength(0);
	});

	it("still reports inserts into an object-level non-temporary record", () => {
		expect(
			detectInsertInLoop([m("InsertIntoGlobalRealRecord")], sourceIndex),
		).toHaveLength(1);
	});

	it("does not report Insert() on an object-level List of [Text]", () => {
		// isKnownNonRecordOp failed OPEN on any unresolved receiver, and every
		// object-level global was unresolved — so a List's Insert() in a loop
		// read as a SQL INSERT. Document Output has 1923 non-Record globals.
		expect(
			detectInsertInLoop([m("InsertIntoGlobalList")], sourceIndex),
		).toHaveLength(0);
	});

	it("lets a member-local declaration shadow an object-level global of the same name", () => {
		// The global `SalesLine` is a Codeunit; the local one is a real Record.
		// Resolution must prefer the local, or the finding disappears.
		expect(
			detectInsertInLoop([m("LocalShadowsGlobal")], sourceIndex),
		).toHaveLength(1);
	});
});

describe("missing-setloadfields — records that escape the member", () => {
	function f(functionName: string) {
		const method = makeMethod({
			functionName,
			objectType: "Codeunit",
			objectId: 50700,
		});
		return detectMissingSetLoadFields([method], sourceIndex)[0];
	}

	it("downgrades when the record is passed on to another procedure", () => {
		// 144 of Document Output's find-receivers are handed whole to a callee
		// that can read any field. SetLoadFields there would starve the callee,
		// so the finding must not read as a straightforward fix.
		const p = f("FindThenPassRecordOn");
		expect(p).toBeDefined();
		expect(p.severity).toBe("info");
		expect(p.suggestion).toMatch(/passed|callee|escapes/i);
	});

	it("downgrades when a table method is called on the record", () => {
		const p = f("FindThenCallTableMethod");
		expect(p).toBeDefined();
		expect(p.severity).toBe("info");
	});

	it("keeps warning when every field read is in the same member", () => {
		const p = f("FindThenReadOwnFieldsOnly");
		expect(p).toBeDefined();
		expect(p.severity).toBe("warning");
	});

	it("downgrades when the find target is a `var` (by-reference) parameter", () => {
		// `procedure Sel(var Tmpl: Record "Item Journal Template")` that only
		// filters and finds is a LOOKUP HELPER: every field read happens in the
		// caller. SetLoadFields here starves a caller this member cannot see.
		const p = f("FindIntoVarParameter");
		expect(p).toBeDefined();
		expect(p.severity).toBe("info");
	});

	it("keeps warning for a by-VALUE record parameter", () => {
		// Passed by value the caller gets a copy and never sees this find, so
		// the field reads really are all visible here.
		const p = f("FindIntoValueParameter");
		expect(p).toBeDefined();
		expect(p.severity).toBe("warning");
	});

	it("downgrades when the whole record is assigned to another record", () => {
		// `TempLineValue := LineValue` copies EVERY field out of LineValue.
		// Narrowing its load leaves the copy holding defaults.
		const p = f("FindThenCopyWholeRecord");
		expect(p).toBeDefined();
		expect(p.severity).toBe("info");
	});
});

describe("incomplete-setloadfields — what counts as a field access", () => {
	function f(functionName: string, objectId: number) {
		return detectIncompleteSetLoadFields(
			[makeMethod({ functionName, objectType: "Codeunit", objectId })],
			sourceIndex,
		);
	}

	it("does not flag a paren-less table METHOD call as a missing field", () => {
		// `Email.HasMoreDocuments` in a real codebase is `internal procedure
		// HasMoreDocuments(): Boolean` — recorded as a field access, it produced
		// a critical finding claiming runtime errors about a method call.
		expect(f("SetLoadFieldsThenCallTableMethod", 50600)).toHaveLength(0);
	});

	it("still flags a genuinely missing field on a known table, at critical", () => {
		const p = f("SetLoadFieldsMissingRealField", 50600);
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
		expect(p[0].description.toLowerCase()).toContain("description");
	});

	it("drops to warning when the table cannot be resolved", () => {
		// With no table in the index there is no way to tell a field from a
		// paren-less method call, so the critical "will cause runtime errors"
		// claim is not one the tool can stand behind. All 16 findings on one
		// real codebase were in this state, and at least one was a method.
		const p = f("BadSetLoadFields", 50700);
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("warning");
		expect(p[0].description).toMatch(
			/could not be confirmed|not in the index/i,
		);
	});
});

describe("escape analysis — metadata calls are not escapes", () => {
	it("FieldNo/FieldCaption/Mark read no field values, so they do not downgrade", () => {
		// These return a field number, a caption, or set a mark. None of them
		// reads a field VALUE off the record, so they cannot starve a
		// SetLoadFields and must not push the finding to info.
		const method = makeMethod({
			functionName: "FindThenOnlyMetadataCalls",
			objectType: "Codeunit",
			objectId: 50700,
		});
		const p = detectMissingSetLoadFields([method], sourceIndex)[0];
		expect(p).toBeDefined();
		expect(p.severity).toBe("warning");
	});
});

describe("incomplete-setloadfields — primary key fields are always loaded", () => {
	it("does not flag a primary-key field as forgotten", () => {
		// BC always loads the primary key: SetLoadFields cannot exclude the
		// fields that identify the record. 86 of 193 findings on a 15,436-file
		// corpus were exactly this — rated critical, claiming runtime errors,
		// about `"No."` and `"Document Type"`.
		const method = makeMethod({
			functionName: "SetLoadFieldsThenReadPrimaryKey",
			objectType: "Codeunit",
			objectId: 50600,
		});
		expect(detectIncompleteSetLoadFields([method], sourceIndex)).toHaveLength(
			0,
		);
	});

	it("still flags a genuinely missing non-key field", () => {
		const method = makeMethod({
			functionName: "SetLoadFieldsMissingRealField",
			objectType: "Codeunit",
			objectId: 50600,
		});
		const p = detectIncompleteSetLoadFields([method], sourceIndex);
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
	});
});

describe("incomplete-setloadfields — the merged table picture", () => {
	function findings(functionName: string) {
		return detectIncompleteSetLoadFields(
			[makeMethod({ functionName, objectType: "Codeunit", objectId: 50976 })],
			sourceIndex,
		);
	}

	it("flags an extension-declared field at critical when the root is seen", () => {
		const p = findings("ReadsExtensionFieldAfterNarrowing");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
		expect(p[0].description.toLowerCase()).toContain("ext code");
	});

	it("never reports a FlowField as a missing SetLoadFields entry", () => {
		// SetLoadFields does not accept FlowFields — the suggestion would not
		// compile.
		expect(findings("ReadsExtensionFlowFieldAfterNarrowing")).toHaveLength(0);
	});

	it("never reports a FlowFilter as a missing SetLoadFields entry", () => {
		// SetLoadFields does not accept FlowFilters either — the suggestion
		// would not compile. Separate clause from the FlowField guard above,
		// so it needs its own test: nothing else in the fixture corpus reads a
		// FlowFilter after a SetLoadFields call.
		expect(findings("ReadsExtensionFlowFilterAfterNarrowing")).toHaveLength(0);
	});

	it("does not flag the root's primary key", () => {
		expect(findings("ReadsPrimaryKeyAfterNarrowing")).toHaveLength(0);
	});

	it("flags a confirmed extension field at critical even with no root", () => {
		const p = findings("ReadsFragmentFieldAfterNarrowing");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
	});

	it("hedges an unconfirmable name on a fragment", () => {
		const p = findings("ReadsUnknownNameOnFragmentAfterNarrowing");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("warning");
		expect(p[0].description).toMatch(
			/could not be confirmed|not in the index|only .*fragment/i,
		);
		// The fragment-specific half of the wording, not just the shared
		// "not in the index" suffix both branches emit.
		expect(p[0].description).toContain("only known from its extensions");
	});

	it("treats an ambiguous table exactly as an absent one, even though the winning root's own field survives", () => {
		// Two distinct roots both declare "Merge Ambig". The merged entry's
		// `fields` still carries the winning root's "AlphaOnly" -- if the
		// ambiguous check were dropped, that field would resolve and this
		// would wrongly report critical instead of the hedged warning an
		// unusable table gets.
		const p = findings("ReadsAlphaOnlyOnAmbiguousTable");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("warning");
		expect(p[0].description).toMatch(
			/could not be confirmed|not in the index/i,
		);
		// Ambiguous is treated as ABSENT, not as a fragment — it must get the
		// plain "not in the index" wording, not the fragment-specific phrase.
		expect(p[0].description).not.toContain("only known from its extensions");
	});
});

describe("receiver resolution — indexed, quoted and expression receivers", () => {
	function findingsFor(functionName: string) {
		return runSourceDetectors(
			syntheticMethodsFromIndex(sourceIndex).filter(
				(m) => m.functionName === functionName && m.objectId === 50961,
			),
			sourceIndex,
		);
	}

	it("does not bill an array of TEMPORARY records as SQL", () => {
		// `TempBuffer[1].Insert()` parses with a subscript_expression receiver
		// whose text is "TempBuffer[1]" — matching no declaration, so the
		// temporary gate failed open and every element op read as a SQL write.
		// 291 in-loop ops on a 15,436-file corpus have an indexed receiver.
		const ids = findingsFor("InsertIntoTempArrayInLoop").map((p) => p.id);
		expect(ids).not.toContain("insert-in-loop");
		expect(ids).not.toContain("record-op-in-loop");
	});

	it("still bills an array of REAL records as SQL", () => {
		const ids = findingsFor("InsertIntoRealArrayInLoop").map((p) => p.id);
		expect(ids).toContain("insert-in-loop");
	});

	it("does not bill a quoted-name temporary variable as SQL", () => {
		const ids = findingsFor("QuotedVariableNameInLoop").map((p) => p.id);
		expect(ids).not.toContain("insert-in-loop");
		expect(ids).not.toContain("record-op-in-loop");
	});

	it("does not treat a call-expression receiver as a record op", () => {
		// `Tok.AsObject().Get('id', Value)` is a JsonObject lookup. AL has no
		// record-returning expression to chain a Find/Get onto, so a receiver
		// that is itself a call can never be a record. 130 such ops in loops on
		// the corpus were reported as "a separate SQL query" per iteration.
		expect(findingsFor("JsonGetInLoop")).toHaveLength(0);
		// and nothing anywhere else in the file mistakes it for one either
		expect(
			runSourceDetectors(
				syntheticMethodsFromIndex(sourceIndex),
				sourceIndex,
			).filter((p) =>
				p.involvedMethods.some((m) => m.includes("JsonGetInLoop")),
			),
		).toHaveLength(0);
	});
});
