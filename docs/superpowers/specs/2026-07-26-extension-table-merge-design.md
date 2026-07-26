# Merging table extensions into a resolved table picture

Date: 2026-07-26

## Problem

A BC table is not one object. A root `table` declaration plus any number of
`tableextension` objects — from the base app, from an ISV app, from a
per-tenant extension — together describe the fields and keys that exist at
runtime. The source index models only the parsed objects, so every detector
that asks a question about "the table" is answering it from a fragment.

Measured on four corpora:

| corpus | tableextensions | root table missing |
|---|---|---|
| tree-sitter-al (base app in-tree) | 303 | 1 (0%) |
| DO | 39 | 39 (100%) |
| DC | 13 | 13 (100%) |
| DocumentOutputRelease | 30 | 30 (100%) |

The two regimes are clean and opposite. With the base app in-tree, nearly
every extension's root is present and a merge does real work. On a partner
app — the normal way `--source` is used — the root is *never* present, so
merging into an existing base is a no-op and the only way an extension can
contribute is by building a partial picture from the extension alone.

What the extensions actually carry on the 15,436-file corpus:

| type | objects | with fields | with keys | with members |
|---|---|---|---|---|
| PageExtension | 553 | 0 | 0 | 334 (1,234 members) |
| TableExtension | 303 | 261 (1,057 fields) | 12 (14 keys) | 92 (550 members) |
| EnumExtension | 121 | 0 | 0 | 0 |
| ReportExtension | 12 | 0 | 0 | 11 (60 members) |

Two known defects fall inside this problem:

- `buildTableRelationGraph` already walks `TableExtension` objects but emits
  `fromTable: obj.objectName` — for `tableextension 50100 "CDC Sales Line Ext"
  extends "Sales Line"` that is `"CDC Sales Line Ext"`. Every
  extension-declared relation is attributed to a table that does not exist.
- `detectUnindexedFilters` and `detectIncompleteSetLoadFields` each resolve a
  table by linear-scanning `index.objects` per operation, and the latter
  allocates a fresh 15,411-element array on every call.

## Constraints

**Members are never re-homed.** `involvedMethods[0]` is
`Name (ObjectType ObjectId)` and is the finding fingerprint anchor via
`resolvePatternAnchor`. Relabelling a tableextension member as
`Table 125` would churn every finding's identity and break lifecycle
history. This design merges the *table picture* only — fields and keys —
and never changes who owns a piece of code.

**Completeness decides which questions are answerable.** Two different kinds
of question hide behind "does the table have this":

- *"Is this name a field, and what kind?"* — answerable from a fragment. A
  field that is present IS present.
- *"Is this name NOT a field?"* and *"does NO key lead with this field?"* —
  not answerable from a fragment. Unseen root fields and keys could say
  otherwise.

`incomplete-setloadfields` and `unindexed-filter` depend on exactly the second
kind, so they must be fenced.

**`complete` means the root declaration was indexed.** It never means every
extension was seen — that is not knowable, since an extension may live in an
app that was not indexed at all.

## Data

```ts
interface ResolvedTable {
  /**
   * As declared on the root. With no root, the `extendsTarget` text exactly
   * as written by the first contributor in `(objectId, file)` order — so the
   * display casing is deterministic even though the map key is lowercased.
   */
  name: string;
  /** The root's object id. Absent when no root declaration was indexed. */
  objectId?: number;
  /** Root's fields first, then each contributing extension's. */
  fields: TableFieldInfo[];
  keys: TableKeyInfo[];
  /**
   * The ROOT `table` declaration was indexed. False means this picture is
   * fragments only: a field found here IS a field, but a field absent from
   * here proves nothing.
   */
  complete: boolean;
  /**
   * The root's FIRST key, and only ever the root's. BC always loads the
   * primary key, and `incomplete-setloadfields` uses that fact — reading
   * `keys[0]` off a merged list would hand it an extension's key whenever
   * the root was not seen.
   */
  primaryKey?: TableKeyInfo;
  /** Every object that contributed, for evidence text and provenance. */
  sources: Array<{
    objectType: "Table" | "TableExtension";
    objectId: number;
    file: string;
  }>;
}
```

`SourceIndex` gains `tables: Map<string, ResolvedTable>`, keyed on the
lowercased table name. AL object names are unique per type across a solution,
so the name is a valid join key. `ObjectInfo` is otherwise untouched — it
stays the literal record of what was parsed.

`ObjectInfo` gains `extendsTarget?: string`: the named child following
`extends_keyword`, quotes stripped. Captured for **every** extension type, not
just TableExtension. It is one code path and it is the enabling fact; only
TableExtension feeds `index.tables` in this change, because PageExtension has
no fields or keys, no consumer reads enum values, and ReportExtension's
per-row triggers already work through `PER_ROW_TRIGGERS`.

### Alternatives rejected

**Mutate the base `ObjectInfo`** — append extension fields onto the base
Table and synthesize one when the root is absent. Fewest call-site changes,
but `index.objects` becomes a fiction: a Table whose `fields[].line` and
`.file` point into other files, and a synthesized Table attributed to a file
that does not declare it. `analyze-source`'s object counts and the snapshot
tests would move for a reason that has nothing to do with parsing.

**A memoized `resolveTable(index, name)` helper** — smallest blast radius,
but the merge state lives outside the index, and "the same concept resolved
two ways" is the shape that has produced a drifted-duplicate bug every time
in this repo.

## Build

`buildTableIndex(objects) → Map<string, ResolvedTable>`, two ordered passes:

1. Every `Table` object seeds an entry: `complete: true`,
   `primaryKey = keys[0]`, itself in `sources`. A duplicate root name — 16 of
   them in tree-sitter-al, from `BC.History` carrying historical copies —
   resolves **first wins**: later roots are appended to `sources` and
   contribute nothing else, so a stale copy can never redefine a live table.
2. Every `TableExtension` carrying an `extendsTarget` resolves by lowercased
   name. A miss creates a `complete: false` entry with no `primaryKey`.
   Fields are then appended **unioned by field name, first wins**, and keys
   **unioned by key name, first wins** — BC key names are unique within a
   table, so a repeated name is a redefinition, not a second key.

Pass 1 runs to completion before pass 2, so `complete` never depends on
file-walk order. Within pass 2 the contributing extensions are sorted by
`(objectId, file)` before merging, so the union is byte-identical on every
machine rather than inheriting filesystem order.

Call sites: `buildSourceIndex` calls it once after collecting objects, and
`deserializeIndex` calls the **same** builder. `tables` is derived data, so
the cache never stores it and `CACHE_VERSION` does not move. One builder, one
source of truth, nothing to drift.

## Detector uptake

| detector | question | reads partial? |
|---|---|---|
| `calcfields-in-loop` severity | what CalcFormula does this field have? | yes |
| `table-graph` | what does this field relate to? | yes |
| `incomplete-setloadfields` | is this name NOT a field? | fenced |
| `unindexed-filter` | does NO key lead with this field? | **skips** |

**`calcfields-in-loop`** — `resolveCalcFields` replaces its linear scan with
`index.tables.get(name)` and reads merged fields regardless of `complete`. A
FlowField found in an extension is a FlowField. An unresolved table still
returns `undefined` and still falls back to the conservative `critical`.

**`table-graph`** — iterate `index.tables` instead of `index.objects`.
`fromTable` becomes the resolved table name. `TableRelationInfo.fromTableId`
is a required `number`, so a partial table emits `0` — the value this index
already uses for objects with no id of their own (`Interface_0`,
`ControlAddIn_0`) — rather than the extension's own id, which would name the
wrong object. Extension relations stop being attributed to phantom tables.

**`incomplete-setloadfields`** — today two-way (table known / unknown),
becomes three-way:

| table | accessed name found in fields | not found |
|---|---|---|
| complete | `critical` | skip — it is a paren-less method call |
| partial | `critical` | `warning` + hedged description |
| absent | — | `warning` + hedged description (today's behaviour) |

The partial row is entirely new: a name confirmed to be an extension field
justifies certainty where today the whole table is unknown. `alwaysLoaded`
reads `table.primaryKey`, which is undefined on a partial table — so an
extension's key fields are never mistaken for always-loaded fields.

**`unindexed-filter`** — hard fence: `complete === false` skips the table,
exactly as today's empty-keys check does. On a complete table it gains in both
directions: extension keys merge in, removing false "no supporting key"
findings, and extension `FlowFilter` fields now resolve, removing false scan
warnings on fields that are not columns at all.

## Error handling

Nothing here throws. An extension whose `extends` target fails to parse
indexes normally and contributes nothing. A target naming a table nobody
declared produces a partial entry, which is the designed state rather than a
failure. `failedFiles` is unaffected.

## Testing

Fixtures: a base table with a tableextension extending it, plus an *orphan*
tableextension whose base is deliberately absent from the fixture directory.
This bumps the fixture-count assertions in five test files, as adding any
fixture does.

`buildTableIndex`:

1. root + extension → `complete: true`, fields unioned, `primaryKey` is the
   root's first key, both objects in `sources`
2. orphan extension → `complete: false`, no `primaryKey`, only the
   extension's fields
3. duplicate root → first wins, second recorded in `sources`, no field
   redefined
4. two extensions merge in `(objectId, file)` order, not walk order
5. cache round-trip: `deserializeIndex` rebuilds `tables` identical to a
   fresh build

Detectors:

6. calcfields severity graduates off an extension-declared FlowField, on a
   partial table
7. table-graph attributes an extension's relation to the base table name
8. `incomplete-setloadfields` on a partial table: an accessed name that is an
   extension field → `critical`; a name not found → `warning` + hedge
9. an extension's key fields are not treated as always-loaded when the root
   was never seen
10. `unindexed-filter` skips a partial table; on a complete table an
    extension key's leading field suppresses the finding

## Measurement

The tests pin behaviour; the corpora validate the change. Before/after
per-detector counts on all four, because they split into the two opposite
regimes — tree-sitter-al 302/303 complete, the three partner apps 100%
partial — and different detectors should move on each side. A sample in each
direction is hand-checked against the AL.

`calcfields-in-loop` is source-correlated and so also runs on the profile
path: verify on both a sampling capture
(`test/fixtures/batch-recorded/*.alcpuprofile`) and an instrumentation one
(`U:/Git/bc-mdc-converter/fixtures/*.reference.alcpuprofile`).

Index and detector wall time on tree-sitter-al is reported as a number, not
asserted. The map replaces two per-operation linear scans over 15,411
objects, one of which allocates a fresh array on every call.

**Stop condition.** If `incomplete-setloadfields` criticals jump sharply on
the partner apps, the "partial + found = critical" row is wrong and gets
re-examined before shipping rather than explained away. The Unreleased
CHANGELOG already warns that source-correlated criticals rose 226 → 242 and
that `gate --max-critical 0` can start failing; a second jump needs its own
heads-up, or it needs to not happen.
