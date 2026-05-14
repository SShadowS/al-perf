# V2 Grammar Migration Guide — al-perf

The tree-sitter-al grammar was rewritten (V1→V2). This document lists all code changes needed in this repo.

All changes are in `src/source/indexer.ts` unless noted otherwise.

## Breaking Changes

### 1. `field_access` node removed (lines 386-402, 457-468)

V2 has no `field_access` node. Quoted-identifier field access (`Rec."Field Name"`) is now `member_expression` with a `quoted_identifier` as the `member` field.

**Fix:**
```typescript
// V1:
if (funcNode.type === "field_access") {
  const record = funcNode.childForFieldName("record");
  const field = funcNode.childForFieldName("field");
}

// V2:
if (funcNode.type === "member_expression") {
  const record = funcNode.childForFieldName("object");
  const field = funcNode.childForFieldName("member");
  // field may be identifier or quoted_identifier
}
```

Merge the `field_access` branches (lines 386-402, 457-468) into the existing `member_expression` branches.

### 2. `member_expression` field `property` → `member` (line 373)

**Fix:**
```typescript
// V1:
funcNode.childForFieldName("property")

// V2:
funcNode.childForFieldName("member")
```

Also update lines 469-476 where `member_expression` properties are accessed positionally — use `childForFieldName("member")` instead.

### 3. `onrun_trigger` removed (lines 255, 841)

V2 has no `onrun_trigger` node. OnRun is a regular `trigger_declaration` with `name: "OnRun"`.

**Fix:**
```typescript
// V1:
if (trigger.type === "onrun_trigger") { ... }

// V2:
if (trigger.type === "trigger_declaration") {
  const name = trigger.childForFieldName("name");
  if (name?.text?.toLowerCase() === "onrun") { ... }
}
```

### 4. `named_trigger` removed (line 823)

V2 has no `named_trigger` node. All triggers are `trigger_declaration`.

**Fix:**
```typescript
// V1:
if (child.type === "named_trigger") { ... }
if (child.type === "onrun_trigger") { ... }

// V2 (combine both):
if (child.type === "trigger_declaration") { ... }
```

### 5. `calc_formula_property` → generic `property` (lines 645-669)

V2 has no `calc_formula_property` node. CalcFormula is a `property` node with `name` text `"CalcFormula"`.

**Fix:**
```typescript
// V1:
if (child.type === "calc_formula_property") { ... }

// V2:
if (child.type === "property") {
  const propName = child.childForFieldName("name")?.text;
  if (propName?.toLowerCase() === "calcformula") { ... }
}
```

### 6. `CALC_FORMULA_TYPE_MAP` — all node names changed (lines 613-621)

V2 replaces `sum_formula`, `count_formula`, `average_formula`, `min_formula`, `max_formula`, `exist_formula` with a single `aggregate_formula` node containing an `aggregate_function` child whose text is the function name.

**Fix:**
```typescript
// V1:
const CALC_FORMULA_TYPE_MAP = {
  sum_formula: "Sum",
  lookup_formula: "Lookup",
  count_formula: "Count",
  // ...
};

// V2:
// Find the formula node within the property value
const formulaNode = valueNode; // child of property
if (formulaNode.type === "aggregate_formula") {
  const funcNode = formulaNode.namedChildren.find(c => c.type === "aggregate_function");
  const funcName = funcNode?.text?.toLowerCase(); // "sum", "count", etc.
  // Map funcName to CalcFormulaType
} else if (formulaNode.type === "lookup_formula") {
  // lookup is still a separate node
}
```

### 7. `table_relation_property` → generic `property` (lines 671-685)

**Fix:**
```typescript
// V1:
if (child.type === "table_relation_property") { ... }

// V2:
if (child.type === "property") {
  const propName = child.childForFieldName("name")?.text;
  if (propName?.toLowerCase() === "tablerelation") {
    const value = child.childForFieldName("value");
    // Inner nodes (table_relation_value, simple_table_relation) still exist
  }
}
```

### 8. `clustered_property` → generic `property` (lines 723, 739)

**Fix:**
```typescript
// V1:
if (c.type === "clustered_property") { ... }

// V2:
if (c.type === "property") {
  const propName = c.childForFieldName("name")?.text;
  if (propName?.toLowerCase() === "clustered") {
    const value = c.childForFieldName("value")?.text;
    // value is "true" or "false"
  }
}
```

### 9. `key_field_list` → `field_list` (line 722)

**Fix:**
```typescript
// V1:
c.type === "key_field_list"

// V2:
c.type === "field_list"
// Or better: node.childForFieldName("fields")
```

### 10. Key name wrapper `"name"` removed (line 721)

V2 key names are direct `identifier`/`quoted_identifier`, not wrapped in a `name` node.

**Fix:**
```typescript
// V1:
if (c.type === "name") { keyName = c.text; }

// V2:
const keyName = node.childForFieldName("name")?.text;
```

### 11. `calc_field_ref` → `calc_field_reference` (line 652)

**Fix:**
```typescript
// V1:
refChild.type === "calc_field_ref"

// V2:
refChild.type === "calc_field_reference"
```

### 12. `table_reference` removed (line 658)

V2's `calc_field_reference` contains all parts inline (dot-separated identifiers). No separate `table_reference` wrapper.

**Fix:** Navigate `calc_field_reference` children directly for table and field names.

### 13. `temporary` → `temporary_keyword` (line 506)

The `temporary` node is now `temporary_keyword` and lives inside `record_type`, not as a direct child of `variable_declaration`.

**Fix:**
```typescript
// V1:
varDecl.namedChildren.find(c => c.type === "temporary")

// V2:
const typeNode = varDecl.childForFieldName("type");
const recordType = typeNode?.namedChildren.find(c => c.type === "record_type");
const isTemporary = recordType?.namedChildren.some(c => c.type === "temporary_keyword");
```

## Dead Code (functional but unnecessary)

### 14. Procedure `name` inner loop (lines 224-228)

V2 returns `identifier` directly from `childForFieldName("name")`. The loop searching for `"identifier"` child finds nothing and falls through to `nameNode.text` — which works. Remove the loop, use `nameNode.text` directly.

## Unchanged (no action needed)

- `call_expression`, `argument_list` — node names and fields unchanged
- `variable_declaration` type `"variable_declaration"` — unchanged
- `record_type` — still exists, `reference` field for table name
- `repeat_statement`, `for_statement`, `foreach_statement`, `while_statement`, `if_statement`, `case_statement` — unchanged
- `source_file` root node — unchanged
- `OBJECT_TYPE_MAP` object declaration names — all unchanged
- All loop/control flow node names — unchanged
- `member_expression` with `object` field — unchanged (only `property`→`member` renamed)

## Helper: Generic Property Pattern

Many V1 property checks become this V2 pattern:

```typescript
function isPropertyNamed(node: SyntaxNode, name: string): boolean {
  return node.type === "property"
    && node.childForFieldName("name")?.text?.toLowerCase() === name.toLowerCase();
}

// Usage:
if (isPropertyNamed(child, "CalcFormula")) { ... }
if (isPropertyNamed(child, "TableRelation")) { ... }
if (isPropertyNamed(child, "Clustered")) { ... }
```
