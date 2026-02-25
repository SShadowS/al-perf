import { describe, it, expect } from "bun:test";
import { createALParser, parseALSource } from "../../src/source/parser-init.js";

describe("createALParser", () => {
  it("should initialize a tree-sitter parser with AL language", async () => {
    const parser = await createALParser();
    expect(parser).toBeDefined();
  });
});

describe("parseALSource", () => {
  it("should parse a simple codeunit", async () => {
    const source = `codeunit 50100 "My Codeunit"
{
    procedure DoSomething()
    begin
        Message('Hello');
    end;
}`;
    const tree = await parseALSource(source);
    expect(tree).toBeDefined();
    expect(tree.rootNode.type).toBe("source_file");
    expect(tree.rootNode.namedChildCount).toBeGreaterThan(0);
  });

  it("should parse a table with trigger", async () => {
    const source = `table 50100 "My Table"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    trigger OnInsert()
    begin
    end;
}`;
    const tree = await parseALSource(source);
    expect(tree.rootNode.type).toBe("source_file");
  });
});
