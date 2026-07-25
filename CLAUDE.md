## Project Overview

AL CPU Profile Analyzer — a CLI tool and MCP server for analyzing Business Central `.alcpuprofile` files. Combines profile data with source code analysis via `tree-sitter-al` to produce actionable performance insights for both humans and AI agents.

## Related Repositories

- **al-perf-bc**: `U:\Git\al-perf-bc\` — Business Central companion app (AL extension). Adds an "Analyze" action to the Performance Profiler page that sends the profile to the al-perf web service for AI-powered analysis.
- **al-flamegraph**: `U:\Git\AL-Flamegraph\` — related flamegraph visualization
- **tree-sitter-al**: `U:\Git\tree-sitter-al\` — AL language grammar for tree-sitter (used for source analysis)

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **CLI framework**: `commander`
- **tree-sitter**: `web-tree-sitter` + `tree-sitter-al.wasm`, pinned to the release named by `AL_GRAMMAR_VERSION` in `src/source/parser-init.ts` (currently v3.0.1). Downloaded on first use and re-downloaded whenever the cached copy's sibling `tree-sitter-al.version` does not match the pin — never `latest`, so every machine and CI run parses with the same grammar
- **MCP server**: `@modelcontextprotocol/sdk` (stdio transport)
- **Terminal output**: `chalk` + `cli-table3`
- **LLM integration**: `@anthropic-ai/sdk` (optional, for `--explain`)
- **Testing**: `bun:test`
- **Publishing**: npm as `al-perf` (unscoped), Docker as `sshadows/al-perf`

## Build and Test Commands

```bash
bun install          # install dependencies
bun test             # run all tests
bun test <file>      # run a single test file
bunx tsc --noEmit    # type check (no emit)
bun run build        # generate .d.ts declaration files (emitDeclarationOnly)
bun run web          # start the web server (port 3010)
./publish-docker.ps1 # build and push Docker image to sshadows/al-perf
bun run src/cli/index.ts analyze profile.alcpuprofile --explain --deep  # deep AI analysis
```

**Environment**: `ANTHROPIC_API_KEY` required for `--explain` and `--deep` features, and for web server AI analysis.

## Restarting the Web Server

When asked to restart the server, first check if it was started as a background task in this session and use `TaskStop` to stop it. Only fall back to `netstat`/`taskkill` if there is no background task to stop.

## Architecture

```
src/
  cli/        — CLI commands (analyze, compare, hotspots, explain, source-map, analyze-source, mcp, gate, history, batch, lifecycle)
  cli/formatters/ — Output formatters (terminal, json, markdown, html) with section registry enforcement
  config.ts   — Shared configuration constants
  core/       — Profile parsing and analysis (pure functions, no I/O)
  debug/      — Debug ID tracking and diagnostic output
  explain/    — LLM-powered analysis explanation (Anthropic API)
  history/    — Performance history storage
  lifecycle/  — finding lifecycle engine (SQLite store, state machine, baselines, digest, `sync` to drive sinks — config at `.al-perf/lifecycle.config.json`, sinks are `github` and `azureDevOps`, each independently enabled with its own trigger rules; each sink's token/PAT is read from the env var named by its `tokenEnv` (github default `GITHUB_TOKEN`, azureDevOps default `AZDO_PAT`) — see docs/lifecycle-gh-recipe.md and docs/lifecycle-ado-recipe.md; `lifecycle telemetry`/`lifecycle pull-telemetry` ingest App Insights BC telemetry as the trigger layer — see docs/telemetry-recipe.md; `lifecycle captures list/claim/cancel` operate the deep-capture request queue an external executor services — see docs/capture-request-contract.md; `lifecycle triage-agent` is the one optional, agentic step — a scheduled LLM pass over needs-triage findings with allow-listed tools and injection-hardened prompting — see docs/triage-agent-recipe.md; every `--tenant` value is normalized to lowercase+trim at the CLI boundary and in `evaluateRun`, so `--tenant Pilot2` and `--tenant pilot2` are the same tenant — existing mixed-case tenant data already on disk is NOT migrated by this; standardize on lowercase `--tenant` values)
  mcp/        — MCP server definition and tool wrappers
  output/     — Canonical output types shared across all interfaces
  source/     — tree-sitter-al integration for AL source code analysis
  types/      — Shared TypeScript types (profile, source-index, analysis)
web/        — Web server and UI (port 3010)
examples/   — Example scripts (performance-review.ts, ci-gate.sh)
test/       — Test suites + fixtures (bun:test)
```

### Engineering Principles

**SOLID, DRY, and TDD — pragmatically.** These principles serve maintainability, not architectural purity. Apply them where they reduce complexity; skip them where they'd add unnecessary abstraction or indirection. Three similar lines are fine if the alternative is a premature generalization. A simple function doesn't need an interface. Write tests first when the behavior is well-defined, but don't force TDD when spiking or exploring.

### Key Design Principles

- Every analysis function returns typed `AnalysisResult` objects — the canonical output structure. Batch analysis returns `BatchAnalysisResult` with aggregate sections.
- Output format (terminal/json/markdown) is a presentation concern, not an analysis concern
- **Formatter parity**: Enforced at compile time via `SectionRenderers<T>` in `src/output/sections.ts` (single-profile) and `BatchSectionRenderers<T>` in `src/output/batch-sections.ts` (batch). Every formatter must implement a renderer for every section type — TypeScript errors if one is missing. `SECTION_ORDER` / `BATCH_SECTION_ORDER` define the canonical render order.
- Indexing coverage, and what is deliberately NOT indexed: files under HIDDEN directories are skipped (`.dependencies/` holds other apps' downloaded symbols, not the app under analysis — on one real codebase that is 795 of 1378 `.al` files, all correctly excluded). Objects wrapped in a preprocessor conditional (`#if CLOUD`) ARE indexed — the declaration sits inside a `preproc_conditional_object`, not at the root. Object types with no analyzable AL code (`.Profile.al`, `.PageCustomization.al`, `dotnet.al`) index to `null` and are dropped. `index.objects` is keyed `Type_Id`, falling back to `Type_Name` for ID-less objects (interfaces, control add-ins) so they don't all collide on `Interface_0`.
- Source correlation is always optional — the tool must work without source files
- Profile-only pattern detectors work on any `.alcpuprofile`; source-correlated patterns require the pinned tree-sitter-al grammar + `.al` files
- The grammar (V2 onward, currently v3.x) uses generic `property` nodes with name fields instead of V1's specific nodes (`calc_formula_property`, `table_relation_property`, etc.). See `docs/v2-migration-guide.md` for the full mapping. The `isPropertyNamed()` helper in `indexer.ts` handles these checks.
- MCP tools are thin wrappers around the same core functions the CLI uses
- `--format auto` detects TTY vs pipe to choose human vs machine output

### AI-Powered Detection (--deep)

The `--deep` flag on `--explain` sends enriched payloads to Claude for analysis beyond rule-based patterns:
- **Cross-method patterns** (7.2): Call chain analysis, fan-out detection, redundant data access
- **Anomaly detection** (7.3): Profile compared against BC operational knowledge baselines
- **Business logic analysis** (7.1): Source-level evaluation (requires `--source`)
- **Code-level fixes** (7.4): Concrete AL code suggestions (requires `--source`)

AI findings are stored in `result.aiFindings[]` (typed `AIFinding[]`) and `result.aiNarrative`, separate from deterministic `result.patterns[]`. Without `--source`, 7.1 and 7.4 degrade gracefully (cross-method and anomaly detection still work).

### Data Flow

1. **Parse** `.alcpuprofile` → `RawProfile`, or `ir-json` (bc-mdc-converter's lossless per-invocation instrumentation IR) → synthesized per-invocation nodes. Format is sniffed from content, not extension — `analyzeProfile(path)` accepts both.
2. **Process**: build call tree, compute times, aggregate → `ProcessedProfile`
3. **Detect patterns** (algorithmic, no AI) → `DetectedPattern[]`
4. **Source correlation** (optional, if `--source` provided): index AL files with tree-sitter-al, map hotspots to source, run anti-pattern queries → `SourceCorrelation[]`
5. **Format output** (terminal/json/markdown) → stdout

### Capture kinds — verify profile changes against BOTH

`.alcpuprofile` comes in two structurally different kinds, and `detectProfileType`
(`src/core/parser.ts`) picks them apart: `kind: 1` is **sampling**, while
`sampleExecutionTimes` or per-node `positionTicks` mean **instrumentation**.
They differ in ways that silently halve the coverage of any profile-side change:

| | sampling | instrumentation |
|---|---|---|
| SQL statement nodes (`functionName` IS the SQL) | yes (181 in one capture) | none |
| `IdleTime` frame | yes | none |
| `selfTime` derived from | sample deltas | `positionTicks` |

So a fix verified only on one kind is verified on half the product. Real captures
to test against: `test/fixtures/batch-recorded/*.alcpuprofile` (sampling) and
`U:/Git/bc-mdc-converter/fixtures/*.reference.alcpuprofile` (instrumentation);
the minimal fixtures are `sampling-minimal` and `instrumentation-minimal`.
Note the fixtures do NOT cover every real shape — see `isIdleNode`, where every
fixture encoded `objectId: 0` and real sampling captures emit `-1`.

### Pattern Detection### Pattern Detection

Pattern detectors are composable functions with signature:
```typescript
type PatternDetector = (profile: ProcessedProfile, sourceIndex?: SourceIndex) => DetectedPattern[];
```

Three categories (21 detectors):
- **Profile-only** (7): single-method-dominance, high-hit-count, deep-call-stack, repeated-siblings, event-subscriber-hotspot, recursive-call, event-chain
- **Source-correlated** (7): calcfields-in-loop (with CalcFormula severity graduation), modify-in-loop, insert-in-loop, delete-in-loop, record-op-in-loop, missing-setloadfields, incomplete-setloadfields
  - "Loop" here includes **implicit** loops, not just `repeat`/`for`/`foreach`/`while`: a `Report`/`XMLport`/`Page` `OnAfterGetRecord` trigger runs once per row by platform contract, even with no syntactic loop in the source. `PER_ROW_TRIGGERS` in `src/source/indexer.ts` promotes these trigger bodies to loop bodies (`OnPreDataItem`/`OnPostDataItem` and table triggers like `OnValidate`/`OnInsert`/`OnModify` are excluded — they run once, or once per operation, not once per row). Findings raised from an implicit loop say so explicitly in their evidence/description (`RecordOpInfo.implicitLoop`), and a Page-sourced implicit-loop finding is one severity level below the same finding on a Report/XMLport.
  - `insert-in-loop` and `delete-in-loop` are separate detectors from `modify-in-loop` (not one widened detector): the fixes differ (temp table / bulk insert vs. `DeleteAll` with a filter), and separate pattern ids keep each detector's finding-lifecycle history independent. `delete-in-loop` also fires on `DeleteAll()` found inside a loop — deliberately, since `DeleteAll` is meant to replace the loop, not live inside one.
- **Source-only** (7): nested-loops, unfiltered-findset, event-subscriber-with-loop-ops, event-subscriber-with-loops, dangerous-call-in-loop, external-call-in-loop, unindexed-filter
  - `external-call-in-loop` rates a `Sleep` at **info** when its enclosing loop terminates on a CONDITION rather than on the data running out (`while <pred>`, or `repeat ... until <pred>` with no `X.Next()` in it). Such a loop is a wait — a retry backoff or a rate throttle — and the delay is its mechanism, so the critical rating and the "remove the Sleep" advice are both wrong. `for`/`foreach`/`repeat ... until X.Next() = 0` and per-row implicit loops stay critical: there the delay really does multiply by the row count.
  - `dangerous-call-in-loop` (`Commit`/`Error`/`TestField`) and `external-call-in-loop` (`HttpClient.{Send,Get,Post,Put,Patch,Delete}`, recognized by the receiver variable's **declared type** — not by method name alone, since `Get`/`Delete` collide with record-op method names — plus bare `Sleep(...)`) are separate detectors, not one widened set: `Commit` in a loop is a *transactional* problem (one write transaction becomes N); an external call in a loop is a *latency* problem (N network round-trips, or N blocking delays), fixed by batching the request or hoisting it out of the loop — a completely different suggestion. Both detectors inherit the same implicit-loop promotion/evidence (`DangerousCallInfo.implicitLoop` / `ExternalCallInfo.implicitLoop`, shared helpers in `src/source/implicit-loop.ts`) and the same Page severity downgrade as the source-correlated record-op detectors above. `Codeunit.Run` in a loop is a transaction-boundary problem and is deliberately out of scope for `external-call-in-loop`.
  - The "is this record temporary?" gate (`isTemporaryOp`) reads the owning object's `SourceTableTemporary` property as well as `var` declarations: a Page/Query with `SourceTableTemporary = true` has an in-memory `Rec`, and `Rec` has no `var` declaration for variable-level resolution to find. Without it every `Rec` op on such a page is charged SQL cost it never pays.
  - `unfiltered-findset` counts `SetView` and `CopyFilters` as filtering but **not** `SetCurrentKey`, which only picks the sort order. `CopyFilter` (singular) is resolved separately: `A.CopyFilter(fieldOfA, B.fieldOfB)` filters **B**, the record owning the second argument, not the receiver. Like the loop detectors and `missing-setloadfields`, it gates on `isKnownNonRecordOp`: `FindSet`/`FindFirst`/`FindLast` are matched by method NAME, and `RecordRef` has all three — its filters live on `FieldRef`, so "add SetRange" is the wrong API. That guard fails OPEN on an unresolved receiver, so an implicit `Rec` and object-level globals still report.
  - `incomplete-setloadfields` cross-checks each accessed name against the table's indexed field list. `Rec.SomeName` with no parentheses is a field read OR a paren-less call to a table procedure, and the parser cannot tell them apart — `Email.HasMoreDocuments` is `internal procedure HasMoreDocuments(): Boolean`, and was reported **critical** as a forgotten field. A name that is not a field of a KNOWN table is skipped; when the table is not in the index (base-app or `.dependencies/` tables) the finding stands but drops to **warning**, because the strong "will cause runtime errors" claim is not one the tool can support there.
  - `missing-setloadfields` drops to **info** when the record ESCAPES the member — passed whole as a call argument, or the receiver of a method that is not a field-neutral built-in (`escapedRecordVariables`, indexer.ts). SetLoadFields is only safe when every field read is visible where the narrowing happens; a callee or a table method reads fields this member never names, and narrowing the load starves exactly those reads. Half of Document Output's findings are in that shape, so this is the difference between a fix and a trap.
  - `unindexed-filter` judges a member's filters as a **set**, not one at a time: a filter is only flagged when *no* `SetRange`/`SetFilter` on that same record variable in that member hits a key's leading field. When a sibling does, SQL seeks that key and the rest are residual predicates over the seek result, so flagging them is a false positive (this is the common case — filtering every field of a compound key in order used to raise one finding per field after the first). Filters accumulate on the record independently of source order, so sibling position is not checked. Deliberately conservative in one direction: a sibling in a mutually exclusive `if`/`else` arm still suppresses, since branch scope is not tracked in `RecordOpInfo`.
  - Declared-type resolution (`extractVariables`) covers a member's **parameters**, its own `var_section`, and the **object-level** `var` section, with member-local names shadowing globals. All three matter in real AL: a `temporary` buffer is routinely a parameter or an object-level global rather than a local, and a reused `HttpClient` is almost always an object-level global. What is still unresolved is a name declared in none of those places (e.g. a page's implicit `Rec`), where `isKnownNonRecordOp` fails OPEN by design.

### ir-json Ingestion

`ir-json` is the lossless instrumentation interchange format produced by
`bc-mdc-converter --format ir-json` (spec: that repo's
`docs/superpowers/specs/2026-07-06-ir-json-format-design.md`). Key facts:

- Pinned to integer `schemaVersion` 1 via `IRJSON_SCHEMA_VERSION` in
  `src/types/irjson.ts` (contract test: `test/core/irjson-contract.test.ts`).
  Unknown keys are ignored (additive changes don't bump the version).
- `src/core/irjson-parser.ts` synthesizes one node per invocation
  (hitCount = 1 → aggregated hitCounts are EXACT invocation counts), builds
  the temporal call tree from `temporalParentIx`, converts 100 ns ticks to µs,
  and shifts 0-based wire lines to 1-based display lines — all exactly once.
- `ProcessedProfile.sourceFormat` is `"ir-json"` for these profiles;
  `meta.captureKind`, `meta.sourceFormat`, and `meta.incompleteInvocations`
  surface capture facts. Incomplete captures are analyzed and flagged.
- `repeated-siblings` and `high-hit-count` use exact counts (not statistical
  inference) on ir-json profiles.
- `/api/ingest` accepts gzipped profile parts (magic-byte detection);
  decompressed size budget `AL_PERF_MAX_PROFILE_BYTES` (default 128 MiB),
  invocation budget `config.irJson.maxInvocations` (500,000).

## Testing Conventions

- Test profiles in `test/fixtures/*.alcpuprofile`
- Batch test fixtures in `test/fixtures/batch/` (multiple profiles + `manifest.json`)
- Test AL source in `test/fixtures/source/`
- Every pattern detector needs unit tests with known-positive and known-negative profiles
- Formatter tests follow the pattern: parse a fixture, format it, assert output contains expected strings

## MCP Server

The MCP server exposes the analyzer as tools for AI agents (e.g., Claude Code).

**Configuration** (`.mcp.json`):
```json
{
  "mcpServers": {
    "al-profiler": {
      "command": "bun",
      "args": ["run", "src/mcp/index.ts"],
      "env": {}
    }
  }
}
```

**Tools** (11):
| Tool | Description |
|------|-------------|
| `analyze_profile` | Full analysis — hotspots, patterns, app/object/table breakdowns, summary |
| `analyze_batch` | Batch analysis of multiple profiles — aggregate hotspots, recurring patterns, activity breakdown |
| `get_hotspots` | Quick top-N hotspots (skips pattern detection) |
| `compare_profiles` | Before/after comparison — regressions, improvements, pattern diff |
| `explain_method` | Deep dive into one method — callers, callees, times |
| `drilldown_method` | Drill down into a specific method's call tree and timing |
| `analyze_source` | Static analysis of AL source files (no profile needed) |
| `gate_check` | CI/CD quality gate — pass/fail verdict against pattern thresholds |
| `visualize_flamegraph` | Generate flamegraph visualization of profile data |
| `history_list` | List stored performance history entries |
| `history_trend` | Show metric trends across stored history |

**Resources** (2): `pattern-docs` (pattern reference), `last-analysis` (cached result)

## CI/CD Gate

The `gate` CLI command and `gate_check` MCP tool enable pipeline integration:

```bash
# CLI: exit 1 if any critical patterns found
bun run src/cli/index.ts gate profile.alcpuprofile -f json

# With thresholds
bun run src/cli/index.ts gate profile.alcpuprofile --max-critical 0 --max-warning 5 -f json
```

Returns `{ verdict: "pass"|"fail", counts, thresholds, violations, patterns }`.

## Batch Analysis

The `batch` CLI command and `analyze_batch` MCP tool analyze multiple profiles as a collection, producing aggregate insights: recurring patterns, cumulative hotspots, activity breakdown, and merged app breakdown.

```bash
# Analyze a directory of profiles
bun run src/cli/index.ts batch ./scheduled-profiles/

# With metadata sidecar (exported from BC Scheduled Profiler)
bun run src/cli/index.ts batch ./scheduled-profiles/ --manifest manifest.json

# With source correlation and AI explanation
bun run src/cli/index.ts batch ./scheduled-profiles/ --source ./al-source/ --explain

# Output formats (same as analyze)
bun run src/cli/index.ts batch ./scheduled-profiles/ -f json|markdown|html|terminal
```

### Web API

`POST /api/analyze-batch` — multipart/form-data with `profiles[]` (required), `manifest` (optional JSON), `source` (optional .zip). Query: `?format=html|json`. The web UI auto-detects batch uploads.

## Library API

Exported from `al-perf`: `analyzeProfile`, `analyzeBatch`, `compareProfiles`, `createMcpServer`, `SourceIndexCache`. See `src/index.ts` for full exports.

Source index caching: `--source` with `--cache` stores to `.al-profile-cache/` inside the source directory, hash-invalidated on `.al` file changes.

## AI-Powered Explanation

The `analyze` command supports `--explain` to append an LLM-generated natural language interpretation of the analysis results.

```bash
# Uses ANTHROPIC_API_KEY env var, Sonnet model
bun run src/cli/index.ts analyze profile.alcpuprofile --explain

# Use Opus for deeper analysis
bun run src/cli/index.ts analyze profile.alcpuprofile --explain --model opus

# Explicit API key
bun run src/cli/index.ts analyze profile.alcpuprofile --explain --api-key sk-ant-...
```

The explanation is appended to all output formats (terminal, markdown, JSON). If the API call fails, the normal analysis output is still printed with a warning to stderr.

### Deep AI Analysis

```bash
# Deep analysis with source correlation (all 4 capabilities)
bun run src/cli/index.ts analyze profile.alcpuprofile --explain --deep --source ./src

# Deep analysis without source (cross-method + anomaly only)
bun run src/cli/index.ts analyze profile.alcpuprofile --explain --deep

# Use Opus for deeper analysis
bun run src/cli/index.ts analyze profile.alcpuprofile --explain --deep --model opus --source ./src
```

`--deep` returns structured `AIFinding[]` with severity, confidence, and optional code fixes, distinct from the narrative `--explain` output. The web server always runs deep analysis when `ANTHROPIC_API_KEY` is set.

## Publishing

### npm
- `bun run build` generates `.d.ts` files only (`emitDeclarationOnly: true`) — Bun runs TS directly
- `files` in package.json includes `src/**/*.ts`, `dist/**/*.d.ts`
- `engines.bun >= 1.0.0` — this package requires Bun

### Docker
- `./publish-docker.ps1` builds and pushes to `sshadows/al-perf`
- Tags with version from `package.json` + `latest`
- Use `-NoPush` to build only, `-Tag X.Y.Z` for custom tag
