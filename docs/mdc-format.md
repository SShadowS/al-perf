# .mdc File Format (Instrumentation Profile Companion Data)

Reverse-engineered from `cedf4512-490d-4252-b9f6-943dd571888f.zip`.

## Overview

Instrumentation `.alcpuprofile` files come with a companion `.zip` (same base filename) containing:

- **`<N>.mdc`** files — one per profile node (0-indexed, so `0.mdc` = profile node id 1)
- **`<ObjectType>%<ObjectId>.al`** files — decompiled AL source for profiled objects
- **`version`** file

The `.mdc` files are **FlatBuffers** binary format. Each file represents a single profile node with its full call stack and per-statement position data.

## FlatBuffers Schema (reconstructed)

```flatbuffers
// Reconstructed schema — field names are inferred from semantics

table MdcRoot {
  application_definition: ApplicationDefinition;  // [0] Object info (type, id)
  function_name: string;                          // [1] Method/trigger name
  // field [2] is always absent
  call_stack: [CallFrame];                        // [3] Full call stack (current → root)
  positions: [PositionEntry];                     // [4] Per-statement line/col entries
  start_time: int64;                              // [5] Node start timestamp (ticks)
  declaring_application: DeclaringApplication;    // [6] App that owns this code
  is_builtin_codeunit_call: bool;                 // [7] Optional — absent when false
}

table DeclaringApplication {
  app_name: string;       // [0] e.g. "System Application", "Continia Core"
  app_publisher: string;  // [1] e.g. "Microsoft", "Continia Software"
  app_version: string;    // [2] e.g. "20.0.37253.38230"
}

table ApplicationDefinition {
  object_id: uint32;      // [0] e.g. 151, 2000000003
  object_type: uint8;     // [1] Enum, see below
}

table CallFrame {
  function_name: string;          // [0] Method name
  app_definition: ApplicationDefinition;  // [1] Object info for this frame
  object_name: string;            // [2] e.g. "Company Triggers", "Sales-Post"
  position: SourceSpan;            // [3] Inline struct, source span of the call site
}

struct SourceSpan {
  from_line: uint16;    // Start line of the statement
  to_column: uint16;    // End column (= line length for full-line statements)
  to_line: uint16;      // End line (= from_line for single-line statements)
  from_column: uint16;  // Start column (typically indentation level)
}

table PositionEntry {
  // Fields vary — always has position at offset 4, optionally ref at offset 12
  position: SourceSpan;      // [field at offset 4] Source span of this statement
  ref_index: uint32;         // [field at offset 12] Optional — sequential 1-based index
}
```

## Node Numbering

- `.mdc` filenames are **0-indexed**: `0.mdc` corresponds to profile node `id: 1`
- Match by `startTime`: the root table's `start_time` field matches the profile node's `startTime`

## ObjectType Enum

| Raw Value | AL Object Type |
|-----------|---------------|
| 1         | Table         |
| 5         | CodeUnit      |
| 8         | Page          |
| 14        | PageExtension |

Other types (Report, XMLPort, Query, Enum, TableExtension, etc.) likely exist but weren't present in the test data.

## Vtable Variations

Two vtable layouts observed:

**8-field variant** (nodes with `isBuiltinCodeUnitCall = true`):
- Field offsets: `[appDef, funcName, (absent), callStack, positions, startTime, declApp, isBuiltin]`
- Root table size: 46-50 bytes

**7-field variant** (non-builtin nodes):
- Same fields minus `is_builtin_codeunit_call`
- Root table size: 46 bytes

The field order and semantics remain the same; only the bool field is absent.

## End Time

`endTime` is stored as an int64 immediately after `startTime` in the root table data area (at root + 20), though it's not referenced by a separate vtable field — it appears to be part of a packed startTime/endTime pair or accessed via a known fixed offset.

## Call Stack

The call stack vector contains the **full path from the current node back to the root**:
- `callStack[0]` = current node's frame
- `callStack[1]` = parent frame
- `callStack[N-1]` = root frame

Each frame includes: function name, object name, application definition (objectType + objectId), and position (line/column of the call site).

## Position Entries

Each `.mdc` contains a vector of position entries representing the executable statements within the method. This is more granular than the profile's `positionTicks`:

- The profile JSON's `positionTicks` only includes statements that were actually executed (with `ticks > 0`)
- The `.mdc` positions include ALL statements in the method body

Each position entry has:
- `position: SourceSpan` — a `{from_line, to_column, to_line, from_column}` struct representing the full source span of the statement
- `ref_index` — optional sequential reference (1-based, absent for the method entry point)

### SourceSpan Field Ordering

The SourceSpan struct uses an unusual byte order: `{from_line, to_column, to_line, from_column}`. This was confirmed by cross-referencing with the AL VSCode extension's `CreateSourceSpan()` method (in `Microsoft.Dynamics.Nav.AL.Common.dll`) which has `from_Line`, `to_Line`, `from_Column`, `to_Column` accessors.

For single-line statements, `from_line == to_line`. For full-line statements, `to_column` equals the line length. For control flow (`if`, `until`), `to_column` may cover only the condition expression.

### Line Number Offset

Position line numbers in `.mdc` files reference `.dal` (compiled) coordinates. The `.al` source files in the companion zip have a small per-object offset (typically 1-2 lines) from `.dal` line numbers. This offset varies by object.

## Source Files (.al)

The zip contains decompiled AL source files named `<ObjectType>%<ObjectId>.al`:
- `CodeUnit%12.al` — Codeunit 12
- `Table%18.al` — Table 18
- Only objects from apps involved in the profile are included
- Microsoft system-level objects (e.g., CodeUnit 151) may be excluded

## Example Decoded Data

### 0.mdc (Profile Node 1: OnCompanyOpen)

```
function_name: "OnCompanyOpen"
start_time: 63791355211203262
end_time: 63791355211277817
is_builtin_codeunit_call: true
declaring_app: { name: "System", publisher: "Microsoft", version: "0.0.0.0" }
application_definition: { object_id: 2000000003, object_type: 5 (CodeUnit) }
call_stack: [
  { func: "OnCompanyOpen", object: "Company Triggers", line: 16, col: 7 }
]
positions: [1 entry]
```

### 1.mdc (Profile Node 2: Init)

```
function_name: "Init"
start_time: 63791355211218886
end_time: 63791355211271496
is_builtin_codeunit_call: true
declaring_app: { name: "System Application", publisher: "Microsoft", version: "20.0.37253.38230" }
application_definition: { object_id: 151, object_type: 5 (CodeUnit) }
call_stack: [
  { func: "Init", object: "System Initialization Impl.", line: 25, col: 8 },
  { func: "OnCompanyOpen", object: "Company Triggers", line: 16, col: 7 }
]
positions: [7 entries at lines 25, 29, 31, 32, 35, 38, 40]
```

### 1000.mdc (Deep Call Stack)

```
function_name: "SetXmlAttributeCollection"
declaring_app: { name: "Continia Core", publisher: "Continia Software", version: "7.0.0.0" }
application_definition: { object_id: 6192824, object_type: 5 (CodeUnit) }
call_stack: [15 frames from SetXmlAttributeCollection → ... → OnCompanyOpen]
```
