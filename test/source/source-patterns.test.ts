import { describe, it, expect, beforeAll } from "bun:test";
import {
  detectCalcFieldsInLoop,
  detectModifyInLoop,
  detectRecordOpInLoop,
  detectMissingSetLoadFields,
  detectIncompleteSetLoadFields,
  runSourceDetectors,
} from "../../src/source/source-patterns.js";
import { buildSourceIndex } from "../../src/source/indexer.js";
import type { SourceIndex } from "../../src/types/source-index.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import { resolve } from "path";

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
    const method = makeMethod({ functionName: "ProcessRecords", objectType: "Codeunit", objectId: 50100 });
    const patterns = detectCalcFieldsInLoop([method], sourceIndex);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].id).toBe("calcfields-in-loop");
    expect(patterns[0].severity).toBe("critical");
  });

  it("should not flag CalcFields outside loop", () => {
    const method = makeMethod({ functionName: "SimpleMethod", objectType: "Codeunit", objectId: 50100 });
    const patterns = detectCalcFieldsInLoop([method], sourceIndex);
    expect(patterns.length).toBe(0);
  });
});

describe("detectModifyInLoop", () => {
  it("should detect Modify inside loop in ProcessRecords", () => {
    const method = makeMethod({ functionName: "ProcessRecords", objectType: "Codeunit", objectId: 50100 });
    const patterns = detectModifyInLoop([method], sourceIndex);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].id).toBe("modify-in-loop");
  });
});

describe("detectRecordOpInLoop", () => {
  it("should detect Get and CalcFields in for loop in LookupRecords", () => {
    const method = makeMethod({ functionName: "LookupRecords", objectType: "Table", objectId: 50100 });
    const patterns = detectRecordOpInLoop([method], sourceIndex);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].id).toBe("record-op-in-loop");
  });
});

describe("detectMissingSetLoadFields", () => {
  it("should detect FindSet without SetLoadFields in ProcessRecords", () => {
    const method = makeMethod({ functionName: "ProcessRecords", objectType: "Codeunit", objectId: 50100 });
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
    const tempPattern = patterns.find(p => p.title.includes("ProcessWithTempTable"));
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
    const tempPattern = patterns.find(p => p.title.includes("ProcessWithTempTable"));
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
});

describe("detectIncompleteSetLoadFields", () => {
  it("should flag SetLoadFields missing accessed fields", () => {
    const method = makeMethod({ functionName: "BadSetLoadFields", objectType: "Codeunit", objectId: 50700 });
    const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].id).toBe("incomplete-setloadfields");
    expect(patterns[0].severity).toBe("critical");
    // The description should mention the missing field
    expect(patterns[0].description.toLowerCase()).toContain("amount");
  });

  it("should not flag complete SetLoadFields", () => {
    const method = makeMethod({ functionName: "GoodSetLoadFields", objectType: "Codeunit", objectId: 50700 });
    const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
    expect(patterns).toHaveLength(0);
  });

  it("should not flag procedures without SetLoadFields", () => {
    const method = makeMethod({ functionName: "NoSetLoadFields", objectType: "Codeunit", objectId: 50700 });
    const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
    expect(patterns).toHaveLength(0);
  });

  it("should include suggestion with missing field names", () => {
    const method = makeMethod({ functionName: "BadSetLoadFields", objectType: "Codeunit", objectId: 50700 });
    const patterns = detectIncompleteSetLoadFields([method], sourceIndex);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].suggestion.toLowerCase()).toContain("amount");
  });
});

describe("runSourceDetectors", () => {
  it("should run all source detectors and return sorted results", () => {
    const methods = [
      makeMethod({ functionName: "ProcessRecords", objectType: "Codeunit", objectId: 50100, selfTime: 5000 }),
      makeMethod({ functionName: "LookupRecords", objectType: "Table", objectId: 50100, selfTime: 3000 }),
    ];
    const patterns = runSourceDetectors(methods, sourceIndex);
    expect(patterns.length).toBeGreaterThan(0);
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i].impact).toBeLessThanOrEqual(patterns[i - 1].impact);
    }
  });
});
