import { describe, expect, it, test } from "bun:test";
import { resolve } from "path";
import { buildSourceIndex, indexALFile } from "../../src/source/indexer.js";
import type { RecordOpInfo } from "../../src/types/source-index.js";

const fixturesDir = resolve(import.meta.dir, "../fixtures/source");

/**
 * Index a fixture (given by its brief-style repo-relative path, e.g.
 * "test/fixtures/source/ImplicitRec.al") and flatten every procedure's and
 * trigger's recordOps into one array -- these tests only care whether an op
 * was collected at all, not which member it lives on.
 */
async function indexFixture(
	repoRelativePath: string,
): Promise<{ recordOps: RecordOpInfo[] }> {
	const fileName = repoRelativePath.split("/").pop()!;
	const result = await indexALFile(resolve(fixturesDir, fileName), fixturesDir);
	const recordOps = [
		...(result?.procedures.flatMap((p) => p.features.recordOps) ?? []),
		...(result?.triggers.flatMap((t) => t.features.recordOps) ?? []),
	];
	return { recordOps };
}

describe("indexALFile", () => {
	it("should index a codeunit file", async () => {
		const result = await indexALFile(
			resolve(fixturesDir, "CodeUnit50100.al"),
			fixturesDir,
		);
		expect(result).toBeDefined();
		expect(result!.objectType).toBe("Codeunit");
		expect(result!.objectId).toBe(50100);
		expect(result!.objectName).toBe("Test Codeunit");
		expect(result!.procedures.length).toBe(2);
		expect(result!.triggers.length).toBe(1); // OnRun

		const processRecords = result!.procedures.find(
			(p) => p.name === "ProcessRecords",
		);
		expect(processRecords).toBeDefined();
		expect(processRecords!.features.loops.length).toBe(1);
		expect(processRecords!.features.loops[0].type).toBe("repeat");
		expect(processRecords!.features.recordOpsInLoops.length).toBeGreaterThan(0);

		const simpleMethod = result!.procedures.find(
			(p) => p.name === "SimpleMethod",
		);
		expect(simpleMethod).toBeDefined();
		expect(simpleMethod!.features.loops.length).toBe(0);
		expect(simpleMethod!.features.recordOpsInLoops.length).toBe(0);
	});

	it("should index a table file", async () => {
		const result = await indexALFile(
			resolve(fixturesDir, "Table50100.al"),
			fixturesDir,
		);
		expect(result).toBeDefined();
		expect(result!.objectType).toBe("Table");
		expect(result!.objectId).toBe(50100);
		expect(result!.triggers.length).toBe(2); // OnInsert, OnModify

		const lookupRecords = result!.procedures.find(
			(p) => p.name === "LookupRecords",
		);
		expect(lookupRecords).toBeDefined();
		expect(lookupRecords!.features.loops.length).toBe(1);
		expect(lookupRecords!.features.loops[0].type).toBe("for");
		expect(lookupRecords!.features.recordOpsInLoops.length).toBeGreaterThan(0);
	});
});

test("extracts variable declarations with Record types", async () => {
	const result = await indexALFile(
		resolve(fixturesDir, "CodeUnit50100.al"),
		fixturesDir,
	);
	const processRecords = result!.procedures.find(
		(p) => p.name === "ProcessRecords",
	)!;
	expect(processRecords.features.variables).toBeDefined();
	expect(processRecords.features.variables.length).toBeGreaterThan(0);
	const salesLine = processRecords.features.variables.find(
		(v) => v.name === "SalesLine",
	);
	expect(salesLine).toBeDefined();
	expect(salesLine!.isRecord).toBe(true);
	expect(salesLine!.tableName).toBe("Sales Line");
	expect(salesLine!.isTemporary).toBe(false);
});

test("detects EventSubscriber attribute on procedures", async () => {
	const index = await buildSourceIndex(fixturesDir);
	const obj = index.objects.get("Codeunit_50200");
	expect(obj).toBeDefined();

	const eventSub = obj!.procedures.find(
		(p) => p.name === "OnBeforePostSalesDoc",
	);
	expect(eventSub).toBeDefined();
	expect(eventSub!.isEventSubscriber).toBe(true);

	const normal = obj!.procedures.find((p) => p.name === "ProcessNestedLoops");
	expect(normal).toBeDefined();
	expect(normal!.isEventSubscriber).toBe(false);
});

test("extracts tableRelationTarget from field declarations", async () => {
	const result = await indexALFile(
		resolve(fixturesDir, "Table50400.al"),
		fixturesDir,
	);
	expect(result).toBeDefined();
	const custField = result!.fields.find((f) => f.name === "Customer No.")!;
	expect(custField.tableRelationTarget).toBe("Customer");
});

test("fields without TableRelation have no tableRelationTarget", async () => {
	const result = await indexALFile(
		resolve(fixturesDir, "Table50400.al"),
		fixturesDir,
	);
	expect(result).toBeDefined();
	const noField = result!.fields.find((f) => f.name === "No.")!;
	expect(noField.tableRelationTarget).toBeUndefined();
});

test("extracts CalcFormula fields from table declarations", async () => {
	const result = await indexALFile(
		resolve(fixturesDir, "Table50200.al"),
		fixturesDir,
	);
	expect(result).toBeDefined();
	expect(result!.fields).toBeDefined();
	expect(result!.fields.length).toBe(6);

	const totalAmount = result!.fields.find((f) => f.name === "Total Amount");
	expect(totalAmount).toBeDefined();
	expect(totalAmount!.calcFormulaType).toBe("Sum");

	const customerName = result!.fields.find((f) => f.name === "Customer Name");
	expect(customerName).toBeDefined();
	expect(customerName!.calcFormulaType).toBe("Lookup");

	const lineCount = result!.fields.find((f) => f.name === "Line Count");
	expect(lineCount).toBeDefined();
	expect(lineCount!.calcFormulaType).toBe("Count");

	const hasOpenOrders = result!.fields.find(
		(f) => f.name === "Has Open Orders",
	);
	expect(hasOpenOrders).toBeDefined();
	expect(hasOpenOrders!.calcFormulaType).toBe("Exist");

	const noField = result!.fields.find((f) => f.name === "No.");
	expect(noField!.calcFormulaType).toBeUndefined();
});

test("extracts table keys from table declaration", async () => {
	const result = await indexALFile(
		resolve(fixturesDir, "Table50400.al"),
		fixturesDir,
	);
	expect(result).toBeDefined();
	expect(result!.keys).toBeDefined();
	expect(result!.keys).toHaveLength(3);

	const pk = result!.keys.find((k) => k.name === "PK")!;
	expect(pk).toBeDefined();
	expect(pk.fields).toEqual(["No."]);
	expect(pk.clustered).toBe(true);

	const sk = result!.keys.find((k) => k.name === "CustomerDate")!;
	expect(sk).toBeDefined();
	expect(sk.fields).toEqual(["Customer No.", "Posting Date"]);
	expect(sk.clustered).toBe(false);

	const amountIdx = result!.keys.find((k) => k.name === "AmountIdx")!;
	expect(amountIdx.fields).toEqual(["Amount"]);
});

test("builds event catalog from source attributes", async () => {
	const index = await buildSourceIndex(fixturesDir);
	expect(index.eventCatalog).toBeDefined();

	// CodeUnit50200 has two [EventSubscriber] procedures
	expect(index.eventCatalog.subscribers.length).toBeGreaterThanOrEqual(2);
	const salesPostSub = index.eventCatalog.subscribers.find(
		(s) => s.procedureName === "OnBeforePostSalesDoc",
	);
	expect(salesPostSub).toBeDefined();
	expect(salesPostSub!.targetObjectType).toBe("Codeunit");
	expect(salesPostSub!.targetObjectId).toBe("Sales-Post");
	expect(salesPostSub!.targetEventName).toBe("OnBeforePostSalesDoc");

	// CodeUnit50500 has two publishers: IntegrationEvent + BusinessEvent
	expect(index.eventCatalog.publishers.length).toBeGreaterThanOrEqual(2);
	const integrationPub = index.eventCatalog.publishers.find(
		(p) => p.procedureName === "OnBeforeProcessCalcFields",
	);
	expect(integrationPub).toBeDefined();
	expect(integrationPub!.eventType).toBe("IntegrationEvent");

	const businessPub = index.eventCatalog.publishers.find(
		(p) => p.procedureName === "OnAfterProcessCalcFields",
	);
	expect(businessPub).toBeDefined();
	expect(businessPub!.eventType).toBe("BusinessEvent");
});

test("extracts field accesses from procedures", async () => {
	const result = await indexALFile(
		resolve(fixturesDir, "CodeUnit50700.al"),
		fixturesDir,
	);
	expect(result).toBeDefined();

	const goodProc = result!.procedures.find(
		(p) => p.name === "GoodSetLoadFields",
	)!;
	expect(goodProc).toBeDefined();
	expect(goodProc.features.fieldAccesses.length).toBeGreaterThan(0);
	const fieldNames = goodProc.features.fieldAccesses.map((a) => a.fieldName);
	expect(fieldNames).toContain("Document No.");
	expect(fieldNames).toContain("Amount");

	const badProc = result!.procedures.find(
		(p) => p.name === "BadSetLoadFields",
	)!;
	expect(badProc).toBeDefined();
	const badFieldNames = badProc.features.fieldAccesses.map((a) => a.fieldName);
	expect(badFieldNames).toContain("Document No.");
	expect(badFieldNames).toContain("Amount");

	const noProc = result!.procedures.find((p) => p.name === "NoSetLoadFields")!;
	expect(noProc).toBeDefined();
	const noFieldNames = noProc.features.fieldAccesses.map((a) => a.fieldName);
	expect(noFieldNames).toContain("Amount");
});

test("extracts allFieldArguments for SetLoadFields calls", async () => {
	const result = await indexALFile(
		resolve(fixturesDir, "CodeUnit50700.al"),
		fixturesDir,
	);
	expect(result).toBeDefined();

	const goodProc = result!.procedures.find(
		(p) => p.name === "GoodSetLoadFields",
	)!;
	const setLoadFieldsOp = goodProc.features.recordOps.find(
		(op) => op.type === "SetLoadFields",
	);
	expect(setLoadFieldsOp).toBeDefined();
	expect(setLoadFieldsOp!.allFieldArguments).toBeDefined();
	expect(setLoadFieldsOp!.allFieldArguments!.length).toBe(2);
	expect(setLoadFieldsOp!.allFieldArguments).toContain("Document No.");
	expect(setLoadFieldsOp!.allFieldArguments).toContain("Amount");

	const badProc = result!.procedures.find(
		(p) => p.name === "BadSetLoadFields",
	)!;
	const badSetLoadFieldsOp = badProc.features.recordOps.find(
		(op) => op.type === "SetLoadFields",
	);
	expect(badSetLoadFieldsOp).toBeDefined();
	expect(badSetLoadFieldsOp!.allFieldArguments).toBeDefined();
	expect(badSetLoadFieldsOp!.allFieldArguments!.length).toBe(1);
	expect(badSetLoadFieldsOp!.allFieldArguments).toContain("Document No.");
});

test("extracts allFieldArguments for CalcFields calls (needed to rate severity on the called field, not the table)", async () => {
	const result = await indexALFile(
		resolve(fixturesDir, "CodeUnit50500.al"),
		fixturesDir,
	);
	expect(result).toBeDefined();

	const proc = result!.procedures.find(
		(p) => p.name === "ProcessWithLookupFieldOnAggregationTable",
	)!;
	expect(proc).toBeDefined();
	const calcFieldsOp = proc.features.recordOps.find(
		(op) => op.type === "CalcFields",
	);
	expect(calcFieldsOp).toBeDefined();
	expect(calcFieldsOp!.allFieldArguments).toBeDefined();
	expect(calcFieldsOp!.allFieldArguments).toEqual(["Customer Name"]);
});

test("does not count method calls as field accesses", async () => {
	const result = await indexALFile(
		resolve(fixturesDir, "CodeUnit50700.al"),
		fixturesDir,
	);
	expect(result).toBeDefined();

	const goodProc = result!.procedures.find(
		(p) => p.name === "GoodSetLoadFields",
	)!;
	// Method calls like SetLoadFields, SetRange, FindSet, Next, Message should NOT appear as field accesses
	const fieldNames = goodProc.features.fieldAccesses.map((a) =>
		a.fieldName.toLowerCase(),
	);
	expect(fieldNames).not.toContain("setloadfields");
	expect(fieldNames).not.toContain("setrange");
	expect(fieldNames).not.toContain("findset");
	expect(fieldNames).not.toContain("next");
});

describe("buildSourceIndex", () => {
	it("should build an index from a directory of AL files", async () => {
		const index = await buildSourceIndex(fixturesDir);
		expect(index.files.length).toBe(37);
		expect(index.objects.size).toBe(37);

		const procList = index.procedures.get("processrecords");
		expect(procList).toBeDefined();
		expect(procList!.length).toBe(1);
		expect(procList![0].objectId).toBe(50100);
	});
});

describe("implicit Rec", () => {
	it("collects a bare CalcFields() in table code", async () => {
		// `CalcFields(Amount);` with no receiver — the implicit Rec. Idiomatic in
		// table/page/report code and previously invisible to every detector.
		const feats = await indexFixture("test/fixtures/source/ImplicitRec.al");
		expect(feats.recordOps.some((op) => op.type === "CalcFields")).toBe(true);
	});

	it("does not collect a bare call in a codeunit, which has no implicit Rec", async () => {
		// A codeunit's `Get(...)` is a local procedure, not a record op.
		const feats = await indexFixture(
			"test/fixtures/source/CodeunitLocalGet.al",
		);
		expect(feats.recordOps).toHaveLength(0);
	});

	it('resolves a bare call in a report dataitem to the dataitem\'s own name, not "Rec"', async () => {
		// Correction from Task 7's review: reports/XMLports have no variable
		// literally named Rec. The implicit record inside a dataitem's trigger
		// is the dataitem's own instance name. Getting this wrong doesn't fail
		// loudly — it silently breaks downstream variable resolution
		// (isTemporaryOp, calcFieldSeverity's table lookup, SetLoadFields
		// coverage matching) for every bare call in report/XMLport code.
		const feats = await indexFixture(
			"test/fixtures/source/ImplicitRecReport.al",
		);
		const calcFields = feats.recordOps.find((op) => op.type === "CalcFields");
		expect(calcFields).toBeDefined();
		expect(calcFields!.recordVariable).toBe("CustLedgerEntry");
		expect(calcFields!.recordVariable).not.toBe("Rec");
	});

	it("collects a bare CalcFields() in a page's OnAfterGetRecord as Rec, inside the implicit loop", async () => {
		// Pins the "Page" arm of IMPLICIT_RECORD_OBJECT_TYPES specifically —
		// the reviewer proved deleting "Page" from the gate left the whole
		// suite green because no fixture exercised a bare call in a page.
		// A Page has no dataitem wrapper, so its implicit record is "Rec".
		const feats = await indexFixture("test/fixtures/source/ImplicitRecPage.al");
		const calcFields = feats.recordOps.find((op) => op.type === "CalcFields");
		expect(calcFields).toBeDefined();
		expect(calcFields!.recordVariable).toBe("Rec");
		expect(calcFields!.insideLoop).toBe(true);
	});

	it("collects a bare CalcFields() in an XMLport tableelement's OnAfterGetRecord as the tableelement's name, inside the implicit loop", async () => {
		// Pins the "XMLport" arm of IMPLICIT_RECORD_OBJECT_TYPES specifically —
		// the reviewer proved re-casing "XMLport" to "XmlPort" left the whole
		// suite green because no fixture exercised a bare call in an XMLport.
		const feats = await indexFixture(
			"test/fixtures/source/ImplicitRecXmlPort.al",
		);
		const calcFields = feats.recordOps.find((op) => op.type === "CalcFields");
		expect(calcFields).toBeDefined();
		expect(calcFields!.recordVariable).toBe("CustLedgerEntry");
		expect(calcFields!.insideLoop).toBe(true);
	});

	it("collects bare CalcFields()/Modify() in a TableExtension procedure as Rec", async () => {
		// TableExtension was entirely absent from IMPLICIT_RECORD_OBJECT_TYPES.
		// Real BC partner/ISV code overwhelmingly lives in extension objects
		// (base tables can't be modified in place), so this was a blind spot
		// in exactly the population that matters most.
		const feats = await indexFixture(
			"test/fixtures/source/ImplicitRecTableExtension.al",
		);
		const calcFields = feats.recordOps.find((op) => op.type === "CalcFields");
		const modify = feats.recordOps.find((op) => op.type === "Modify");
		expect(calcFields).toBeDefined();
		expect(calcFields!.recordVariable).toBe("Rec");
		expect(modify).toBeDefined();
		expect(modify!.recordVariable).toBe("Rec");
	});

	it("collects a bare CalcFields() in a PageExtension's own OnAfterGetRecord as Rec, inside the implicit loop", async () => {
		// Pins PageExtension's membership in BOTH IMPLICIT_RECORD_OBJECT_TYPES
		// (the op is collected at all) AND PER_ROW_TRIGGERS (insideLoop is
		// true) — a pageextension overriding OnAfterGetRecord directly is a
		// real BC idiom, and base pages can't be modified in place either.
		const feats = await indexFixture(
			"test/fixtures/source/ImplicitRecPageExtension.al",
		);
		const calcFields = feats.recordOps.find((op) => op.type === "CalcFields");
		expect(calcFields).toBeDefined();
		expect(calcFields!.recordVariable).toBe("Rec");
		expect(calcFields!.insideLoop).toBe(true);
	});

	it("resolves a bare call in a dataitem added by a ReportExtension to the dataitem's own name, inside the implicit loop", async () => {
		// Pins ReportExtension's membership in IMPLICIT_RECORD_OBJECT_TYPES,
		// DATAITEM_SCOPED_OBJECT_TYPES (dataitem name, not "Rec") and
		// PER_ROW_TRIGGERS (insideLoop) all at once — a reportextension
		// adding a dataitem via addfirst/addlast is a real BC idiom.
		const feats = await indexFixture(
			"test/fixtures/source/ImplicitRecReportExtension.al",
		);
		const calcFields = feats.recordOps.find((op) => op.type === "CalcFields");
		expect(calcFields).toBeDefined();
		expect(calcFields!.recordVariable).toBe("ExtraLedgerEntry");
		expect(calcFields!.recordVariable).not.toBe("Rec");
		expect(calcFields!.insideLoop).toBe(true);
	});

	it("does not collect a bare call in a report's global procedure outside any dataitem, which has no implicit record", async () => {
		// A report's implicit record is the dataitem's own name — there is no
		// dataitem in scope in a global helper procedure, so there is no
		// implicit record at all. Before this guard, the `?? "Rec"` fallback
		// silently invented a phantom "Rec" that doesn't exist in a report.
		const feats = await indexFixture(
			"test/fixtures/source/ImplicitRecReportGlobalProc.al",
		);
		expect(feats.recordOps).toHaveLength(0);
	});
});

describe("paren-less (classic C/AL) calls", () => {
	it("indexes argument-less record calls written without parentheses", async () => {
		// `Customer.FindSet` / `SalesLine.Modify` / `Customer.Next` parse as
		// member_expression, not call_expression. Without a branch for them the
		// record op is lost and every detector goes blind on old-style code.
		const result = (await indexALFile(
			resolve(fixturesDir, "CodeUnitOldStyle.al"),
			fixturesDir,
		))!;
		const proc = result.procedures.find((p) => p.name === "ConvertSetups")!;
		const ops = proc.features.recordOps.map(
			(o) => `${o.recordVariable}.${o.type}`,
		);
		expect(ops).toContain("Customer.FindSet");
		expect(ops).toContain("SalesLine.FindSet");
		expect(ops).toContain("SalesLine.Modify");
		expect(ops).toContain("SalesLine.Next");
		expect(ops).toContain("Customer.Next");
	});

	it("does not also record those calls as field accesses", async () => {
		// Before the fix `Customer.FindSet` produced a fieldAccess named
		// "FindSet", which incomplete-setloadfields would then demand appear in
		// a SetLoadFields list.
		const result = (await indexALFile(
			resolve(fixturesDir, "CodeUnitOldStyle.al"),
			fixturesDir,
		))!;
		const proc = result.procedures.find((p) => p.name === "ConvertSetups")!;
		const names = proc.features.fieldAccesses.map((a) =>
			a.fieldName.toLowerCase(),
		);
		expect(names).not.toContain("findset");
		expect(names).not.toContain("next");
		expect(names).not.toContain("modify");
	});

	it("marks a paren-less op inside a loop as inside a loop", async () => {
		const result = (await indexALFile(
			resolve(fixturesDir, "CodeUnitOldStyle.al"),
			fixturesDir,
		))!;
		const proc = result.procedures.find((p) => p.name === "ConvertSetups")!;
		const modify = proc.features.recordOps.find((o) => o.type === "Modify")!;
		expect(modify.insideLoop).toBe(true);
	});
});

describe("record parameters", () => {
	it("indexes parameters alongside var-section declarations", async () => {
		// extractVariables read only the var_section, so every record PARAMETER
		// was invisible: a `temporary` one could not be recognized as temporary,
		// and a plain one's table could not be resolved for the detectors that
		// need it (unindexed-filter, calcfields severity).
		const result = (await indexALFile(
			resolve(fixturesDir, "CodeUnitParams.al"),
			fixturesDir,
		))!;
		const proc = result.procedures.find((p) => p.name === "FillBuffer")!;
		const temp = proc.features.variables.find((v) => v.name === "TempBuffer")!;
		expect(temp).toBeDefined();
		expect(temp.isRecord).toBe(true);
		expect(temp.isTemporary).toBe(true);
		expect(temp.tableName).toBe("Sales Line");

		const source = proc.features.variables.find(
			(v) => v.name === "SourceLine",
		)!;
		expect(source.isRecord).toBe(true);
		expect(source.isTemporary).toBe(false);
	});

	it("keeps var-section declarations when a procedure has both", async () => {
		const result = (await indexALFile(
			resolve(fixturesDir, "CodeUnit50100.al"),
			fixturesDir,
		))!;
		const proc = result.procedures.find((p) => p.name === "ProcessRecords")!;
		expect(
			proc.features.variables.find((v) => v.name === "SalesLine"),
		).toBeDefined();
	});
});

describe("objects the index used to drop silently", () => {
	it("indexes an object wrapped in a preprocessor conditional", async () => {
		// findObjectDeclaration scanned only the root's direct children, but
		// `#if CLOUD` wraps the declaration in a preproc_conditional_object, so
		// the whole file was skipped. 19 files in one real 583-file codebase.
		const result = await indexALFile(
			resolve(fixturesDir, "TableGuarded.al"),
			fixturesDir,
		);
		expect(result).not.toBeNull();
		expect(result!.objectType).toBe("Table");
		expect(result!.objectId).toBe(50980);
		expect(result!.procedures.map((p) => p.name)).toContain("ScanEverything");
	});

	it("keeps every ID-less object, not just the last one", async () => {
		// Interfaces and control add-ins carry no object ID, so every one of
		// them keyed to "Interface_0" and overwrote the previous — 18 objects
		// lost in one codebase.
		const index = await buildSourceIndex(fixturesDir);
		const interfaces = [...index.objects.values()].filter(
			(o) => o.objectType === "Interface",
		);
		expect(interfaces.map((o) => o.objectName).sort()).toEqual([
			"Alpha Handler",
			"Beta Handler",
		]);
	});
});

describe("table field names", () => {
	it("captures unquoted field names, not only quoted ones", async () => {
		// `field(4; Amount; Decimal)` is as legal as `field(1; "No."; Code[20])`,
		// but only the quoted spelling was captured — Key Test Table indexed 3
		// of its 5 fields. Anything reading ObjectInfo.fields saw a partial
		// table: calcfields severity silently fell back to `critical`, and the
		// incomplete-setloadfields field cross-check would suppress real
		// findings for fields it could not see.
		const result = (await indexALFile(
			resolve(fixturesDir, "Table50400.al"),
			fixturesDir,
		))!;
		expect(result.fields.map((f) => f.name).sort()).toEqual([
			"Amount",
			"Customer No.",
			"Date Filter",
			"Description",
			"No.",
			"Posting Date",
		]);
	});
});

describe("parse trees are freed", () => {
	it("indexing many files does not exhaust the WASM heap", async () => {
		// A web-tree-sitter Tree holds WASM heap memory released only by an
		// explicit delete(). Without it the heap grew with every parsed file
		// until it faulted: "Out of bounds memory access", then Aborted(), at
		// roughly ten thousand files — inside the size of a real BC solution
		// with its dependencies. This soak is a fraction of that, enough to
		// fail fast if trees start leaking again.
		const file = resolve(fixturesDir, "CodeUnit50100.al");
		for (let i = 0; i < 1500; i++) {
			const r = await indexALFile(file, fixturesDir);
			expect(r).not.toBeNull();
		}
	}, 120_000);

	it("one unparseable file does not lose the rest of the index", async () => {
		// buildSourceIndex had no per-file isolation, so a single thrown
		// RuntimeError from the parser cost every other result in the run.
		const index = await buildSourceIndex(fixturesDir);
		expect(index.files.length).toBeGreaterThan(0);
		expect(index.failedFiles).toEqual([]);
	});
});
