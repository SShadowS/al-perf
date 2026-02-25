import { describe, it, expect } from "bun:test";
import { extractSnippet, annotateSnippet, readSourceLines } from "../../src/source/snippets.js";
import { resolve } from "path";

const fixtureFile = resolve(import.meta.dir, "../fixtures/source/CodeUnit50100.al");

describe("extractSnippet", () => {
  it("should extract lines from a file", async () => {
    const snippet = await extractSnippet(fixtureFile, 3, 14);
    expect(snippet).toContain("procedure ProcessRecords");
    expect(snippet).toContain("SalesLine.FindSet");
  });

  it("should include line numbers", async () => {
    const snippet = await extractSnippet(fixtureFile, 3, 5, { lineNumbers: true });
    expect(snippet).toMatch(/^\s*3\|/m);
    expect(snippet).toMatch(/^\s*4\|/m);
    expect(snippet).toMatch(/^\s*5\|/m);
  });

  it("should handle context lines around a range", async () => {
    const snippet = await extractSnippet(fixtureFile, 10, 10, { contextLines: 2 });
    // Line 10 ± 2 context = lines 8-12
    expect(snippet.split("\n").length).toBeGreaterThanOrEqual(3);
  });
});

describe("annotateSnippet", () => {
  it("should add markers to specified lines", () => {
    const source = `    if SalesLine.FindSet() then
        repeat
            SalesLine.CalcFields(Amount);
            SalesLine.Modify();
        until SalesLine.Next() = 0;`;

    const annotations = new Map<number, string>();
    annotations.set(3, "FlowField in loop");
    annotations.set(4, "Consider ModifyAll");

    const result = annotateSnippet(source, 8, annotations);
    expect(result).toContain("\u2190 FlowField in loop");
    expect(result).toContain("\u2190 Consider ModifyAll");
  });
});

describe("readSourceLines", () => {
  it("should read all lines of a file", async () => {
    const lines = await readSourceLines(fixtureFile);
    expect(lines.length).toBeGreaterThan(10);
    expect(lines[0]).toContain("codeunit 50100");
  });
});
