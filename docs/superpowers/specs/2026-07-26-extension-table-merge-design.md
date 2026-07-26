# Merging table extensions into a resolved table picture

Date: 2026-07-26
Revised: 2026-07-26 after a three-model review panel (see *Review history*).

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
  table by linear-scanning `index.objects` per record variable, and the latter
  spreads the whole 15,411-entry map into a fresh array before `.find()`.

## Constraints

**Members are never re-homed.** `involvedMethods[0]` is
`Name (ObjectType ObjectId)` and is the finding fingerprint anchor via
`resolvePatternAnchor`. Relabelling a tableextension member as
`Table 125` would churn every finding's identity and break lifecycle
history. This design merges the *table picture* only — fields and keys —
and never changes who owns a piece of code.

**Positive facts survive a fragment; negative facts do not.** Two different
kinds of question hide behind "does the table have this":

- *"Is this name a field, and what kind?"* — answerable from a fragment. A
  field that is present IS present.
- *"Is this name NOT a field?"* and *"does NO key lead with this field?"* —
  not answerable from a fragment.

`incomplete-setloadfields` and `unindexed-filter` depend on exactly the second
kind, so they must be fenced.

**The world is never closed, and this design does not claim to close it.**
`rootSeen` means the root `table` declaration was indexed. It does not mean
every extension was indexed — an extension may live in a dependency app that
`--source` never saw, and no flag can ever prove otherwise. So the negative
questions above stay open-world even on a `rootSeen` table. What merging does
is make them *less wrong*: an extension key that is currently invisible starts
suppressing a false "no supporting key" finding. The fence exists so the tool
does not claim more certainty than before, not because it achieves closure.

**Non-goal: implicit `Rec` in extension members.** Every detector resolves a
record's table through `member.features.variables`, and a `TableExtension`
member's implicit `Rec` has no declaration to find. The 550 members living in
tableextensions are therefore unhelped by this change. That is a real and
separately-tracked gap, not something this design quietly fixes.

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
  /**
   * Every contributor's keys, concatenated with provenance. NOT deduplicated
   * by key name — see `keys` in the Build section.
   */
  keys: Array<{ key: TableKeyInfo; fromObjectId: number; fromFile: string }>;
  /**
   * The root `table` declaration was indexed. False means this picture is
   * fragments only: a field found here IS a field, but a field absent from
   * here proves nothing. True does NOT mean every extension was seen.
   */
  rootSeen: boolean;
  /**
   * More than one distinct root `table` declaration carries this name.
   * Namespaces make that legal and it happens in the base app — `Dimension
   * Set Entry` is table 480 in the Base Application and table 36950 in
   * PowerBI Reports. These are different tables, so neither the merge nor
   * any answer derived from it is meaningful. An ambiguous entry answers
   * NOTHING: every consumer treats it exactly as it treats an absent table.
   */
  ambiguous: boolean;
  /**
   * The root's FIRST key, and only ever the root's. Microsoft's table-keys
   * documentation is explicit: "table extension objects inherit the primary
   * key of the table object they extend … any key that you define in a table
   * extension object is considered a secondary key." So an extension key can
   * never be the primary key, and with no root there is no primary key to
   * know. `incomplete-setloadfields` needs this because BC always loads the
   * primary key.
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
lowercased table name. `ObjectInfo` is otherwise untouched — it stays the
literal record of what was parsed.

**On the join key.** AL object names are *not* unique per type across a
solution: namespaces exist and 12,302 of the corpus's 15,941 files declare
one, which is exactly why 16 table names collide there. Name is used as the
join key anyway, for two measured reasons — every `tableextension … extends`
target in the corpus is an unqualified simple name (0 of 303 are
namespace-qualified), and colliding names are 16 of 2,080 tables. The
`ambiguous` flag exists to make the residue honest rather than to pretend it
away. Full namespace-aware resolution is deliberately out of scope: nothing
in the index carries a namespace today, and adding one is a larger change
than this.

`ObjectInfo` gains `extendsTarget?: string`: the named child following
`extends_keyword`, quotes stripped. Captured for **every** extension type, not
just TableExtension. It is one code path and it is the enabling fact; only
TableExtension feeds `index.tables` in this change, because PageExtension has
no fields or keys, no consumer reads enum values, and ReportExtension's
per-row triggers already work through `PER_ROW_TRIGGERS`.

### Alternatives rejected

**Mutate the base `ObjectInfo`** — append extension fields onto the base
Table and synthesize one when the root is absent. Fewest call-site changes,
but `index.objects` becomes a fiction: a Table whose fields carry `line`
numbers into files the object does not name (`TableFieldInfo` has a `line`
and no `file`; the file lives once, on the object), and a synthesized Table
attributed to a file that does not declare it. `analyze-source`'s object
counts and the snapshot tests would move for a reason that has nothing to do
with parsing.

**A memoized `resolveTable(index, name)` helper** — genuinely viable, and the
weaker of the two rejections. A resolver module can be a single source of
truth just as much as a map on the index, and it would avoid changing a
public type. It is rejected on ergonomics rather than principle: the merge is
needed by four call sites in three files, all of which already receive the
`SourceIndex`, so a field on the index is the shorter path to the same
invariant. Both designs share every hard problem below — cache
compatibility, ambiguity, key identity — so the choice is not load-bearing.

## Build

`buildTableIndex(objects) → Map<string, ResolvedTable>`, two ordered passes.

**Pass 1 — roots.** Every `Table` object seeds an entry: `rootSeen: true`,
`primaryKey = keys[0]`, itself in `sources`. Roots are processed in
**relative-path order**; `buildSourceIndex` inserts objects in unsorted
`Glob.scan` order, which is filesystem-dependent, and relative paths keep the
result identical across machines where absolute paths would not.

A second root declaring the same name with a *different* object id sets
`ambiguous: true`. Both are recorded in `sources` and the entry stops
answering questions. This is not a tie-break — measured on tree-sitter-al,
all 16 duplicate names have distinct object ids and are genuinely different
tables in different apps. (An earlier draft of this spec called them
"historical copies"; that was wrong.) Two roots sharing both name and id
cannot reach the builder, since `index.objects` is keyed `Type_Id` and the
later one has already replaced the earlier — measured: 0 of the 16.

**Pass 2 — extensions.** Every `TableExtension` carrying an `extendsTarget`
resolves by lowercased name, contributors sorted by `(objectId, relative
path)`. A miss creates a `rootSeen: false` entry with no `primaryKey`.

- **Fields** are appended, unioned by field name, first wins. The compiler
  already forbids an extension from redeclaring a base field name, so this
  union never fires on compiling source; it is a defensive tie-break, not a
  semantic rule.
- **Keys are NOT deduplicated by name.** Microsoft's table-keys documentation
  states: *"You can use the same key name in the table extension, unless the
  key contains fields from the base table object."* Collapsing on name would
  silently drop a valid extension index, and a dropped key that leads with a
  filtered field manufactures exactly the false `unindexed-filter` finding
  this change exists to remove. Key identity is `(contributor object, key
  name)`, which is why `keys` carries provenance.

Pass 1 runs to completion before pass 2, so `rootSeen` and `ambiguous` never
depend on the order extensions happen to arrive in.

**Call sites and the cache.** `buildSourceIndex` calls the builder once after
collecting objects, and `deserializeIndex` calls the **same** builder — one
builder, one source of truth. `tables` itself is derived and is never
serialized, but `extendsTarget` is a **new `ObjectInfo` field and IS
serialized**, so `CACHE_VERSION` must move from 3 to 4. Without the bump, a
cache written before this change still passes both its version check and its
directory hash, deserializes objects with no `extendsTarget`, and rebuilds
`tables` with zero contributing extensions — a cached run silently producing
different findings from a fresh one on identical source.

## Detector uptake

| detector | question | on a fragment |
|---|---|---|
| `calcfields-in-loop` severity | what CalcFormula does this field have? | yes, with a fence on partial resolution |
| `table-graph` | what does this field relate to? | yes |
| `incomplete-setloadfields` | is this name NOT a field? | fenced |
| `unindexed-filter` | does NO key lead with this field? | **skips** |

An `ambiguous` entry is treated as an absent table by all four. That is a
behaviour change for 16 tables, where today the linear scan silently returns
whichever same-named table it reached first.

**`calcfields-in-loop`** — `resolveCalcFields` replaces its linear scan with
`index.tables.get(name)` and may read merged fields on a fragment, because a
FlowField found in an extension is a FlowField. But two of its existing paths
must be fenced on `rootSeen`, or the merge introduces a new under-severity
false negative:

- **Bare `CalcFields()`** falls back to "every FlowField on the table". On a
  fragment that set is not the runtime set, so an extension's lone `Lookup`
  would downgrade the finding to `warning` while an unseen root `Sum` is what
  actually runs.
- **A partially-resolved argument list** returns the resolved subset when
  `resolved.length > 0`. `CalcFields(ExtLookup, BaseSum)` on a fragment
  resolves only `ExtLookup` and downgrades on that basis alone.

Both keep the conservative `critical` when `rootSeen` is false. The same
fence applies to `calcFieldFactSentence`, which asserts *"This table has
Lookup FlowFields"* — a statement about the whole table that must not be made
from a fragment.

**`table-graph`** — iterate `index.tables` instead of `index.objects`.
`fromTable` becomes the resolved table name. `TableRelationInfo.fromTableId`
is a required `number`, so an entry with no root emits `0` — the value this
index already uses for objects with no id of their own (`Interface_0`,
`ControlAddIn_0`) — rather than the extension's own id, which would name the
wrong object. `fromTableId` has no consumers outside `table-graph.ts` and the
type declaration, so this is free. Extension relations stop being attributed
to phantom tables.

**`incomplete-setloadfields`** — today two-way (table known / unknown),
becomes three-way:

| table | accessed name found in fields | not found |
|---|---|---|
| root seen | `critical` | skip — it is a paren-less method call |
| fragment only | `critical` | `warning` + hedged description |
| absent / ambiguous | — | `warning` + hedged description (today's behaviour) |

Only the middle-left cell is new: a name confirmed to be an extension field
justifies certainty where today the whole table is unknown. The middle-right
cell is today's behaviour restated, not an improvement — on a fragment,
"not found" still conflates an un-narrowed base field (a true finding) with a
paren-less base method call (a false one).

Two guards ride along:

- `alwaysLoaded` reads `table.primaryKey`, which is undefined on a fragment,
  so an extension's secondary key fields are never mistaken for always-loaded
  fields. The consequence is that reading a *base* primary-key field on a
  fragment still reports — unchanged from today, and unfixable without the
  root.
- **A FlowField or FlowFilter is never reported as a missing SetLoadFields
  entry.** `SetLoadFields` does not accept them, so "add this to
  SetLoadFields" would not compile. The field's `calcFormulaType` /
  `fieldClass` are already indexed; merging extension fields widens the blast
  radius of this pre-existing bug enough that it is fixed here rather than
  left.

Out of scope, and pre-existing: `alwaysLoaded` covers `SystemId` and the
primary key, but Microsoft documents the data-audit fields
(`SystemCreatedAt`, `SystemCreatedBy`, `SystemModifiedAt`,
`SystemModifiedBy`) and filtered-upon fields as always loaded too. That is a
separate false-positive source, unaffected either way by this change.

**`unindexed-filter`** — hard fence: `rootSeen === false` skips the table,
exactly as today's empty-keys check does, so partner apps continue to get no
`unindexed-filter` findings for base tables. This design does not improve
that and does not claim to. On a `rootSeen` table it gains in both
directions: extension keys merge in, removing false "no supporting key"
findings, and extension `FlowFilter` fields now resolve, removing false scan
warnings on fields that are not columns at all.

## Error handling

Nothing here throws. An extension whose `extends` target fails to parse
indexes normally and contributes nothing. A target naming a table nobody
declared produces a fragment entry, which is the designed state rather than a
failure. `failedFiles` is unaffected.

## Compatibility

`SourceIndex` is exported from `src/index.ts`, so adding a required `tables`
field is a breaking change for any external caller that constructs one. It is
declared required rather than optional so no consumer can silently skip the
merge; the CHANGELOG carries the note.

## Testing

Fixtures: a base table with a tableextension extending it, an *orphan*
tableextension whose base is deliberately absent, a second root declaring an
existing table name under a different id, and an extension key whose name
collides with a base key name. This bumps the fixture-count assertions in
five test files, as adding any fixture does.

`buildTableIndex`:

1. root + extension → `rootSeen: true`, fields unioned, `primaryKey` is the
   root's first key, both objects in `sources`
2. orphan extension → `rootSeen: false`, no `primaryKey`, only the
   extension's fields
3. two roots, same name, different ids → `ambiguous: true`, both in
   `sources`, and every consumer treats the entry as absent
4. an extension key whose name matches a base key name is KEPT, with its
   contributor recorded — not collapsed
5. contributors merge in `(objectId, relative path)` order, and roots in
   relative-path order, neither in walk order
6. cache round-trip: `deserializeIndex` rebuilds `tables` identical to a
   fresh build, and a `CACHE_VERSION` 3 entry is rejected rather than reused

Detectors:

7. calcfields severity graduates off an extension-declared FlowField when the
   root is seen
8. bare `CalcFields()` on a fragment stays `critical`, and no "this table
   has …" fact sentence is emitted
9. `CalcFields(ExtLookup, UnresolvedField)` on a fragment stays `critical`
10. table-graph attributes an extension's relation to the base table name
11. `incomplete-setloadfields` on a fragment: an accessed name that is an
    extension field → `critical`; a name not found → `warning` + hedge
12. an extension FlowField accessed after `SetLoadFields` is not reported as
    a missing entry
13. an extension's key fields are not treated as always-loaded when the root
    was never seen
14. `unindexed-filter` skips a fragment; on a root-seen table an extension
    key's leading field suppresses the finding

## Measurement

The tests pin behaviour; the corpora validate the change. Before/after
per-detector counts on all four, because they split into the two opposite
regimes — tree-sitter-al 302/303 with a root, the three partner apps 100%
fragment — and different detectors should move on each side. A sample in each
direction is hand-checked against the AL.

Three sources of movement must be attributed separately, or the numbers
cannot be read:

- the merge itself
- the `ambiguous` fence, which changes 16 tables from "silently pick the
  first match" to "answer nothing"
- **case sensitivity.** Every current lookup compares
  `o.objectName === variable.tableName` exactly; the new map is keyed
  lowercased. AL identifiers are case-insensitive, so this silently fixes a
  latent bug — and moves counts for a reason unrelated to extensions.

`calcfields-in-loop` is source-correlated and so also runs on the profile
path: verify on both a sampling capture
(`test/fixtures/batch-recorded/*.alcpuprofile`) and an instrumentation one
(`U:/Git/bc-mdc-converter/fixtures/*.reference.alcpuprofile`).

Index and detector wall time on tree-sitter-al is reported as a number, not
asserted. The map replaces two per-record-variable linear scans over 15,411
objects, one of which spreads the whole map into a fresh array first.

**Stop condition.** If `incomplete-setloadfields` criticals jump sharply on
the partner apps, the "fragment + found = critical" row is wrong and gets
re-examined before shipping rather than explained away. The Unreleased
CHANGELOG already warns that source-correlated criticals rose 226 → 242 and
that `gate --max-critical 0` can start failing; a second jump needs its own
heads-up, or it needs to not happen.

## Review history

Reviewed by a three-model panel (Fable 5, Gemini 3.1 Pro, GPT-5.5), each
reading the codebase in isolation. Six defects in the first draft were
confirmed against the source or against Microsoft Learn and are fixed above:

1. `CACHE_VERSION` was said not to need a bump. It does — `extendsTarget` is
   serialized. Flagged by all three.
2. "Union keys by key name, first wins" would drop valid keys; duplicate key
   names across a base table and its extension are documented as legal.
3. `calcfields`' bare-call and partial-argument paths downgrade severity
   unsoundly on a fragment.
4. The 16 duplicate table names were mis-described as historical copies; they
   are distinct tables with distinct ids, legal under namespaces. "First
   wins" was the wrong answer.
5. Root ordering was left to filesystem walk order while extensions were
   sorted.
6. Overclaims: `complete` renamed to `rootSeen` and its limits stated, the
   implicit-`Rec` gap named as a non-goal, a nonexistent `TableFieldInfo.file`
   removed, and the case-sensitivity side effect attributed.

Two panel claims were checked and rejected: that a fragment's handling of
base method calls and base primary-key reads introduces new false positives
(both are today's behaviour, restated above), and that `index.objects` has
already lost duplicate roots (measured: 0 of 16 share an object id).
