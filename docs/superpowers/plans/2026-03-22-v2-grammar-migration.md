# V2 Grammar Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `src/source/indexer.ts` from tree-sitter-al V1 grammar to V2, with pre/post verification tests to confirm the upgrade works.

**Architecture:** Three phases: (1) create a grammar-version-agnostic test that captures current indexer output as snapshots, (2) copy V2 wasm and apply all 14 code changes from `docs/v2-migration-guide.md`, (3) verify snapshots still match. The `isPropertyNamed` helper consolidates repeated property-type checks.

**Tech Stack:** TypeScript, bun:test, web-tree-sitter, tree-sitter-al V2 wasm

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `test/source/indexer-snapshots.test.ts` | Create | Grammar-agnostic snapshot tests capturing all indexer output |
| `src/source/tree-sitter-al.wasm` | Replace | Copy V2 wasm from `U:\Git\tree-sitter-al\tree-sitter-al.wasm` |
| `src/source/indexer.ts` | Modify | Apply all 14 V2 migration changes |
| `test/source/indexer.test.ts` | Modify (if needed) | Fix any assertions that break due to V2 behavioral differences |

---

### Task 1: Create Pre-Migration Snapshot Tests

These tests capture the exact output of the indexer on every fixture file. They are grammar-version-agnostic (they test the indexer's *output*, not tree-sitter node types). When we swap the wasm and update the code, these tests prove the migration preserves behavior.

**Files:**
- Create: `test/source/indexer-snapshots.test.ts`

- [ ] **Step 1: Write snapshot test file**

```typescript
import { describe, it, expect } from "bun:test";
import { indexALFile, buildSourceIndex } from "../../src/source/indexer.js";
import { resolve } from "path";

const fixturesDir = resolve(import.meta.dir, "../fixtures/source");

/**
 * Snapshot tests for the source indexer.
 * These capture the exact output of indexALFile/buildSourceIndex
 * for every fixture, independent of grammar version.
 * If these pass after a grammar upgrade, the migration is correct.
 */

describe("Indexer output snapshots", () => {
  // --- CodeUnit50100: basic codeunit with OnRun, loops, record ops ---
  describe("CodeUnit50100", () => {
    it("should produce correct object metadata", async () => {
      const r = await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir);
      expect(r).not.toBeNull();
      expect(r!.objectType).toBe("Codeunit");
      expect(r!.objectId).toBe(50100);
      expect(r!.objectName).toBe("Test Codeunit");
    });

    it("should find 2 procedures and 1 trigger", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir))!;
      expect(r.procedures.map(p => p.name).sort()).toEqual(["ProcessRecords", "SimpleMethod"]);
      expect(r.triggers.map(t => t.name)).toEqual(["OnRun"]);
    });

    it("ProcessRecords: loop with record ops", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "ProcessRecords")!;
      expect(proc.features.loops).toHaveLength(1);
      expect(proc.features.loops[0].type).toBe("repeat");
      expect(proc.features.recordOps.map(o => o.type).sort()).toEqual(
        ["CalcFields", "FindSet", "Modify", "Next", "SetRange"].sort()
      );
      expect(proc.features.recordOpsInLoops.length).toBeGreaterThan(0);
      // Variables
      const salesLine = proc.features.variables.find(v => v.name === "SalesLine");
      expect(salesLine).toBeDefined();
      expect(salesLine!.isRecord).toBe(true);
      expect(salesLine!.tableName).toBe("Sales Line");
      expect(salesLine!.isTemporary).toBe(false);
    });

    it("SimpleMethod: no loops, no record ops", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50100.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "SimpleMethod")!;
      expect(proc.features.loops).toHaveLength(0);
      expect(proc.features.recordOps).toHaveLength(0);
    });
  });

  // --- CodeUnit50400: temporary record variables ---
  describe("CodeUnit50400", () => {
    it("should detect temporary record variable", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50400.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "ProcessWithTempTable")!;
      const tempVar = proc.features.variables.find(v => v.name === "TempBuffer");
      expect(tempVar).toBeDefined();
      expect(tempVar!.isRecord).toBe(true);
      expect(tempVar!.isTemporary).toBe(true);
      expect(tempVar!.tableName).toBe("Sales Line");
    });

    it("should detect non-temporary record variable", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50400.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "ProcessWithRealTable")!;
      const realVar = proc.features.variables.find(v => v.name === "SalesLine");
      expect(realVar).toBeDefined();
      expect(realVar!.isRecord).toBe(true);
      expect(realVar!.isTemporary).toBe(false);
    });
  });

  // --- CodeUnit50500: OnRun trigger in codeunit ---
  describe("CodeUnit50500", () => {
    it("should find OnRun trigger", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50500.al"), fixturesDir))!;
      expect(r.triggers.map(t => t.name)).toEqual(["OnRun"]);
    });
  });

  // --- CodeUnit50200: nested loops, event subscribers ---
  describe("CodeUnit50200", () => {
    it("should have 5 procedures, 0 triggers", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50200.al"), fixturesDir))!;
      expect(r.procedures).toHaveLength(5);
      expect(r.triggers).toHaveLength(0);
    });

    it("OnBeforePostSalesDoc is event subscriber", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50200.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "OnBeforePostSalesDoc")!;
      expect(proc.isEventSubscriber).toBe(true);
    });

    it("ProcessNestedLoops is NOT event subscriber", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50200.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "ProcessNestedLoops")!;
      expect(proc.isEventSubscriber).toBe(false);
    });
  });

  // --- CodeUnit50700: field accesses and SetLoadFields ---
  describe("CodeUnit50700", () => {
    it("GoodSetLoadFields: correct field accesses", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50700.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "GoodSetLoadFields")!;
      const fieldNames = proc.features.fieldAccesses.map(a => a.fieldName);
      expect(fieldNames).toContain("Document No.");
      expect(fieldNames).toContain("Amount");
      // Method calls should NOT appear as field accesses
      const lower = fieldNames.map(f => f.toLowerCase());
      expect(lower).not.toContain("setloadfields");
      expect(lower).not.toContain("findset");
    });

    it("GoodSetLoadFields: allFieldArguments on SetLoadFields", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "CodeUnit50700.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "GoodSetLoadFields")!;
      const op = proc.features.recordOps.find(o => o.type === "SetLoadFields")!;
      expect(op.allFieldArguments).toHaveLength(2);
      expect(op.allFieldArguments).toContain("Document No.");
      expect(op.allFieldArguments).toContain("Amount");
    });
  });

  // --- Table50100: triggers in tables ---
  describe("Table50100", () => {
    it("should find 2 triggers and 1 procedure", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50100.al"), fixturesDir))!;
      expect(r.objectType).toBe("Table");
      expect(r.objectId).toBe(50100);
      expect(r.triggers.map(t => t.name).sort()).toEqual(["OnInsert", "OnModify"]);
      expect(r.procedures.map(p => p.name)).toEqual(["LookupRecords"]);
    });

    it("LookupRecords: for loop with record ops", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50100.al"), fixturesDir))!;
      const proc = r.procedures.find(p => p.name === "LookupRecords")!;
      expect(proc.features.loops).toHaveLength(1);
      expect(proc.features.loops[0].type).toBe("for");
      expect(proc.features.recordOpsInLoops.length).toBeGreaterThan(0);
    });
  });

  // --- Table50200: CalcFormula fields ---
  describe("Table50200", () => {
    it("should extract CalcFormula types", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50200.al"), fixturesDir))!;
      expect(r.fields).toHaveLength(5);

      const totalAmount = r.fields.find(f => f.name === "Total Amount")!;
      expect(totalAmount.calcFormulaType).toBe("Sum");
      expect(totalAmount.calcFormulaTable).toBe("Sales Line");

      const custName = r.fields.find(f => f.name === "Customer Name")!;
      expect(custName.calcFormulaType).toBe("Lookup");

      const lineCount = r.fields.find(f => f.name === "Line Count")!;
      expect(lineCount.calcFormulaType).toBe("Count");

      const noField = r.fields.find(f => f.name === "No.")!;
      expect(noField.calcFormulaType).toBeUndefined();
    });
  });

  // --- Table50400: keys and TableRelation ---
  describe("Table50400", () => {
    it("should extract keys with clustered flag", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50400.al"), fixturesDir))!;
      expect(r.keys).toHaveLength(3);

      const pk = r.keys.find(k => k.name === "PK")!;
      expect(pk.fields).toEqual(["No."]);
      expect(pk.clustered).toBe(true);

      const sk = r.keys.find(k => k.name === "CustomerDate")!;
      expect(sk.fields).toEqual(["Customer No.", "Posting Date"]);
      expect(sk.clustered).toBe(false);
    });

    it("should extract TableRelation target", async () => {
      const r = (await indexALFile(resolve(fixturesDir, "Table50400.al"), fixturesDir))!;
      const custField = r.fields.find(f => f.name === "Customer No.")!;
      expect(custField.tableRelationTarget).toBe("Customer");

      const noField = r.fields.find(f => f.name === "No.")!;
      expect(noField.tableRelationTarget).toBeUndefined();
    });
  });

  // --- buildSourceIndex aggregate ---
  describe("buildSourceIndex", () => {
    it("should index all 11 fixture files", async () => {
      const index = await buildSourceIndex(fixturesDir);
      expect(index.files).toHaveLength(11);
      expect(index.objects.size).toBe(11);
    });

    it("should build event catalog", async () => {
      const index = await buildSourceIndex(fixturesDir);
      expect(index.eventCatalog.subscribers.length).toBeGreaterThanOrEqual(2);
      expect(index.eventCatalog.publishers.length).toBeGreaterThanOrEqual(2);

      const salesPostSub = index.eventCatalog.subscribers.find(
        s => s.procedureName === "OnBeforePostSalesDoc"
      );
      expect(salesPostSub).toBeDefined();
      expect(salesPostSub!.targetObjectType).toBe("Codeunit");
      expect(salesPostSub!.targetObjectId).toBe("Sales-Post");
      expect(salesPostSub!.targetEventName).toBe("OnBeforePostSalesDoc");
    });
  });
});
```

- [ ] **Step 2: Run snapshot tests to verify they pass with V1 grammar**

Run: `bun test test/source/indexer-snapshots.test.ts`
Expected: All tests PASS (these capture current V1 behavior)

- [ ] **Step 3: Commit**

```bash
git add test/source/indexer-snapshots.test.ts
git commit -m "test: add grammar-agnostic indexer snapshot tests (pre-V2 baseline)"
```

---

### Task 2: Upgrade WASM to V2

**Files:**
- Replace: `src/source/tree-sitter-al.wasm`

- [ ] **Step 1: Copy V2 wasm**

```bash
cp "U:/Git/tree-sitter-al/tree-sitter-al.wasm" "U:/Git/al-perf/src/source/tree-sitter-al.wasm"
```

- [ ] **Step 2: Run snapshot tests to see what breaks**

Run: `bun test test/source/indexer-snapshots.test.ts`
Expected: FAILURES. This confirms the V1 code doesn't work with V2 grammar. Record the failures as the migration checklist.

- [ ] **Step 3: Run full test suite to see total breakage**

Run: `bun test`
Expected: Many failures in source-related tests. This is the "before" state.

**Do NOT commit yet** - we'll commit after the code changes are applied.

---

### Task 3: Add `isPropertyNamed` Helper

**Files:**
- Modify: `src/source/indexer.ts`

- [ ] **Step 1: Add the helper function after `stripQuotes` (around line 173)**

```typescript
/**
 * V2 grammar helper: check if a node is a generic `property` with a specific name.
 * Many V1-specific property nodes (calc_formula_property, table_relation_property,
 * clustered_property) became generic `property` nodes in V2.
 */
function isPropertyNamed(node: SyntaxNode, name: string): boolean {
  return node.type === "property"
    && node.childForFieldName("name")?.text?.toLowerCase() === name.toLowerCase();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/source/indexer.ts
git commit -m "refactor: add isPropertyNamed helper for V2 grammar migration"
```

---

### Task 4: Fix `member_expression` Field Rename (`property` -> `member`)

Migration guide items: #1 (field_access removed), #2 (property -> member)

**Files:**
- Modify: `src/source/indexer.ts` lines 371-402, 453-480

- [ ] **Step 1: Fix `collectRecordOps` - merge field_access into member_expression, rename property->member**

In `collectRecordOps`, replace the `member_expression` + `field_access` branches (lines 371-402) with:

```typescript
        if (funcNode.type === "member_expression") {
          const objNode = funcNode.childForFieldName("object") ?? funcNode.namedChildren[0];
          const propNode = funcNode.childForFieldName("member") ?? funcNode.namedChildren[1];
          if (propNode) {
            const methodName = stripQuotes(propNode.text);
            if (RECORD_OPS.has(methodName.toLowerCase())) {
              ops.push({
                node: n,
                methodName,
                recordVariable: objNode ? objNode.text : "",
                fieldArgument: extractFieldArgument(n, methodName),
                allFieldArguments: extractAllFieldArguments(n, methodName),
              });
            }
          }
        }
```

The entire `field_access` `else if` branch (lines 386-402) is removed since V2 has no `field_access` node.

- [ ] **Step 2: Fix `collectFieldAccesses` - merge field_access into member_expression, use field names**

In `collectFieldAccesses`, replace the `field_access` + `member_expression` branches (lines 457-480) with:

```typescript
    if (n.type === "member_expression" && n.parent?.type !== "call_expression") {
      // V2: all field access is member_expression with object + member fields
      const objNode = n.childForFieldName("object") ?? n.namedChildren[0];
      const memNode = n.childForFieldName("member") ?? n.namedChildren[1];
      if (objNode && memNode) {
        accesses.push({
          recordVariable: objNode.text,
          fieldName: stripQuotes(memNode.text),
          line: n.startPosition.row + 1,
          column: n.startPosition.column,
        });
      }
    }
```

- [ ] **Step 3: Update the JSDoc comment above `collectFieldAccesses`**

Change "field_access" references in the comment to reflect V2:

```typescript
/**
 * Collect field access nodes: Rec."Field Name" and Rec.Field (member_expression not in call).
 */
```

- [ ] **Step 4: Commit**

```bash
git add src/source/indexer.ts
git commit -m "fix: migrate field_access and member_expression to V2 grammar"
```

---

### Task 5: Fix Trigger Node Types

Migration guide items: #3 (onrun_trigger removed), #4 (named_trigger removed)

**Files:**
- Modify: `src/source/indexer.ts` lines 236-260, 822-855

- [ ] **Step 1: Simplify `extractTriggerName`**

Replace the entire function (lines 240-260) with:

```typescript
function extractTriggerName(trigger: SyntaxNode): string {
  // V2: all triggers are trigger_declaration with a name field
  const nameNode = trigger.childForFieldName("name");
  if (nameNode) {
    return stripQuotes(nameNode.text);
  }
  return "";
}
```

- [ ] **Step 2: Simplify `walkForMembers` trigger handling**

Replace lines 822-855 (the `named_trigger`, `trigger_declaration`, and `onrun_trigger` branches) with a single branch:

```typescript
      } else if (child.type === "trigger_declaration") {
        const name = extractTriggerName(child);
        const codeBlock = findCodeBlock(child);
        const features = extractFeatures(codeBlock);
        features.variables = extractVariables(child);

        triggers.push({
          name,
          objectType,
          objectName,
          objectId,
          file: relativePath,
          lineStart: child.startPosition.row + 1,
          lineEnd: child.endPosition.row + 1,
          features,
        });
```

- [ ] **Step 3: Update JSDoc for extractTriggerName**

```typescript
/**
 * Extract trigger name from a trigger_declaration node.
 */
```

- [ ] **Step 4: Commit**

```bash
git add src/source/indexer.ts
git commit -m "fix: migrate named_trigger and onrun_trigger to V2 trigger_declaration"
```

---

### Task 6: Fix CalcFormula Parsing

Migration guide items: #5 (calc_formula_property -> generic property), #6 (formula type nodes -> aggregate_formula), #11 (calc_field_ref -> calc_field_reference), #12 (table_reference removed)

**Files:**
- Modify: `src/source/indexer.ts` lines 613-670

- [ ] **Step 1: Delete `CALC_FORMULA_TYPE_MAP` (lines 613-621) and replace with aggregate function name map**

Delete the old constant entirely and add:

```typescript
/** Map from aggregate function name (lowercase) to CalcFormulaType */
const CALC_FORMULA_FUNC_MAP: Record<string, TableFieldInfo["calcFormulaType"]> = {
  sum: "Sum",
  count: "Count",
  average: "Average",
  min: "Min",
  max: "Max",
  exist: "Exist",
};
```

- [ ] **Step 2: Replace the `calc_formula_property` branch in `extractTableFields`**

Replace lines 645-670 with:

```typescript
        } else if (isPropertyNamed(child, "CalcFormula")) {
          const value = child.childForFieldName("value");
          if (value) {
            // Find the formula node within the property value
            for (const formulaChild of value.namedChildren) {
              if (formulaChild.type === "aggregate_formula") {
                // V2: aggregate_formula contains an aggregate_function child
                const funcNode = formulaChild.namedChildren.find(c => c.type === "aggregate_function");
                const funcName = funcNode?.text?.toLowerCase();
                if (funcName && funcName in CALC_FORMULA_FUNC_MAP) {
                  calcFormulaType = CALC_FORMULA_FUNC_MAP[funcName];
                }
                // Extract referenced table from calc_field_reference children
                for (const refChild of formulaChild.namedChildren) {
                  if (refChild.type === "calc_field_reference") {
                    // V2: children are inline identifiers; first identifier/quoted_identifier is the table
                    const tableNode = refChild.namedChildren.find(c =>
                      c.type === "identifier" || c.type === "quoted_identifier"
                    );
                    if (tableNode) {
                      calcFormulaTable = stripQuotes(tableNode.text);
                    }
                  }
                }
                break;
              } else if (formulaChild.type === "lookup_formula") {
                // Lookup is still a separate node in V2
                calcFormulaType = "Lookup";
                for (const refChild of formulaChild.namedChildren) {
                  if (refChild.type === "calc_field_reference") {
                    const tableNode = refChild.namedChildren.find(c =>
                      c.type === "identifier" || c.type === "quoted_identifier"
                    );
                    if (tableNode) {
                      calcFormulaTable = stripQuotes(tableNode.text);
                    }
                  } else if (refChild.type === "member_expression") {
                    const obj = refChild.childForFieldName("object") ?? refChild.namedChildren[0];
                    if (obj) {
                      calcFormulaTable = stripQuotes(obj.text);
                    }
                  }
                }
                break;
              }
            }
          }
```

- [ ] **Step 3: Commit**

```bash
git add src/source/indexer.ts
git commit -m "fix: migrate CalcFormula parsing to V2 aggregate_formula + generic property"
```

---

### Task 7: Fix TableRelation, Clustered, Key Parsing

Migration guide items: #7 (table_relation_property -> generic property), #8 (clustered_property -> generic property), #9 (key_field_list -> field_list), #10 (key name wrapper removed)

**Files:**
- Modify: `src/source/indexer.ts` lines 671-760

- [ ] **Step 1: Replace `table_relation_property` branch**

Replace lines 671-687 with:

```typescript
        } else if (isPropertyNamed(child, "TableRelation")) {
          const value = child.childForFieldName("value");
          if (value) {
            // Walk value subtree to find the table identifier
            // V2 inner structure may vary (table_relation_expression, simple_table_relation,
            // or direct identifiers). Use a recursive search for the first identifier.
            function findTableRef(node: SyntaxNode): string | undefined {
              if (node.type === "simple_table_relation") {
                const ref = node.namedChildren.find(c =>
                  c.type === "identifier" || c.type === "quoted_identifier"
                );
                return ref ? stripQuotes(ref.text) : undefined;
              }
              for (const child of node.namedChildren) {
                const found = findTableRef(child);
                if (found) return found;
              }
              return undefined;
            }
            tableRelationTarget = findTableRef(value);
          }
```

- [ ] **Step 2: Fix key parsing in `extractTableKeys`**

Replace the key_declaration body (lines 721-750) with:

```typescript
    if (node.type === "key_declaration") {
      // V2: key name is a direct identifier/quoted_identifier via field, not wrapped in name node
      const name = node.childForFieldName("name")?.text ?? "";
      const keyFieldList = node.namedChildren.find(c => c.type === "field_list");
      const fields: string[] = [];
      if (keyFieldList) {
        for (const child of keyFieldList.namedChildren) {
          if (child.type === "quoted_identifier") {
            fields.push(stripQuotes(child.text));
          } else if (child.type === "identifier") {
            fields.push(child.text);
          }
        }
      }

      // V2: Clustered is a generic property
      let clustered = false;
      for (const child of node.namedChildren) {
        if (isPropertyNamed(child, "Clustered")) {
          const value = child.childForFieldName("value")?.text;
          clustered = value?.toLowerCase() === "true";
          break;
        }
      }

      if (name) {
        keys.push({ name, fields, clustered, line: node.startPosition.row + 1 });
      }
      return;
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/source/indexer.ts
git commit -m "fix: migrate TableRelation, Clustered, key parsing to V2 grammar"
```

---

### Task 8: Fix `temporary` Detection and Dead Code Cleanup

Migration guide items: #13 (temporary -> temporary_keyword in record_type), #14 (procedure name inner loop dead code)

**Files:**
- Modify: `src/source/indexer.ts` lines 506, 221-231

- [ ] **Step 1: Fix temporary detection in `extractVariables`**

Replace both line 506 (`const tempNode = ...`) and line 512 (`const isTemporary = tempNode !== undefined;`) with:

```typescript
      // V2: temporary_keyword lives inside record_type, not as direct child of variable_declaration
      const isTemporary = recordTypeNode?.namedChildren.some(c => c.type === "temporary_keyword") ?? false;
```

This reuses the existing `recordTypeNode` variable (line 515) which already finds the `record_type` child. Place this line after `recordTypeNode` is resolved (after line 516). The full variable block becomes:

```typescript
      const nameNode = varDecl.namedChildren.find(c => c.type === "identifier");
      const typeSpecNode = varDecl.namedChildren.find(c => c.type === "type_specification");

      if (!nameNode || !typeSpecNode) continue;

      const name = nameNode.text;
      const typeStr = typeSpecNode.text;

      // Check if Record type
      const recordTypeNode = typeSpecNode.namedChildren.find(c => c.type === "record_type");
      const isRecord = recordTypeNode !== undefined;
      // V2: temporary_keyword lives inside record_type
      const isTemporary = recordTypeNode?.namedChildren.some(c => c.type === "temporary_keyword") ?? false;
```

- [ ] **Step 2: Clean up procedure name dead code**

Replace `extractProcedureName` (lines 221-233) with:

```typescript
function extractProcedureName(proc: SyntaxNode): string {
  const nameNode = proc.childForFieldName("name");
  if (nameNode) {
    return nameNode.text;
  }
  return "";
}
```

Remove the comment about "name node with identifier child" and the inner loop - V2 returns identifier directly.

- [ ] **Step 3: Commit**

```bash
git add src/source/indexer.ts
git commit -m "fix: migrate temporary detection to V2, clean up dead procedure name code"
```

---

### Task 9: Run All Tests and Fix Remaining Issues

**Files:**
- Modify: any files with remaining failures

- [ ] **Step 1: Run snapshot tests**

Run: `bun test test/source/indexer-snapshots.test.ts`
Expected: All PASS

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All 464 tests PASS

- [ ] **Step 3: If any tests fail, investigate and fix**

Common issues to watch for:
- V2 may produce slightly different text for some nodes (whitespace, quoting)
- The `table_relation_expression` nesting may differ - check with a debug print if TableRelation tests fail
- CalcFormula table extraction depends on exact `calc_field_reference` text format - may need adjustment

For each failure: read the actual vs expected, check what V2 produces by adding a temporary `console.log(JSON.stringify(node, null, 2))` in the relevant function, fix the code.

- [ ] **Step 4: Run type check**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit all fixes**

```bash
git add src/source/indexer.ts
git commit -m "fix: resolve remaining V2 grammar test failures"
```

---

### Task 10: Final Verification and Commit

- [ ] **Step 1: Run full test suite one final time**

Run: `bun test`
Expected: All tests PASS (464+)

- [ ] **Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit the wasm upgrade**

The wasm was replaced in Task 2 but not committed. Snapshot tests were already committed in Task 1.

```bash
git add src/source/tree-sitter-al.wasm
git commit -m "feat: upgrade tree-sitter-al to V2 grammar"
```

---

## Verification Strategy

1. **Pre-migration**: Task 1 snapshot tests pass with V1 grammar (proves tests capture real behavior)
2. **Post-wasm-swap**: Task 2 confirms tests FAIL with V2 wasm + V1 code (proves grammar actually changed)
3. **Post-migration**: Tasks 9-10 confirm all tests pass with V2 wasm + V2 code (proves migration is correct)
4. **Type safety**: `bunx tsc --noEmit` passes throughout
