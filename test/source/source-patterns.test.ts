import { beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "path";
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
	});
});

describe("calcfields-in-loop — suggestion must be actionable", () => {
	it("never tells the user to use SetLoadFields on a FlowField", () => {
		// SetLoadFields does not accept FlowFields, and CalcFields operates on
		// FlowFields. Suggesting it is advice the user cannot follow.
		// https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/record/record-setloadfields-method
		//
		// The suggestion is still allowed (deliberately) to NAME SetLoadFields in
		// order to warn the user off it -- developers reach for it by reflex --
		// so this checks for the specific bad advice ("use SetLoadFields") rather
		// than a blanket absence of the word.
		const method = makeMethod({
			functionName: "ProcessRecords",
			objectType: "Codeunit",
			objectId: 50100,
		});
		const patterns = detectCalcFieldsInLoop([method], sourceIndex);
		const finding = patterns.find((p) => p.id === "calcfields-in-loop");
		expect(finding).toBeDefined();
		expect(finding?.suggestion).not.toMatch(/use SetLoadFields/i);
		expect(finding?.suggestion).toContain("SetAutoCalcFields");
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
		expect(finding?.suggestion).not.toMatch(/use SetLoadFields/i);
		expect(finding?.suggestion).toContain("SetAutoCalcFields");
	});
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
		expect(patterns[0].severity).toBe("critical");
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
