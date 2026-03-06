## Project Overview

AL CPU Profile Analyzer — a CLI tool and MCP server for analyzing Business Central `.alcpuprofile` files. Combines profile data with source code analysis via `tree-sitter-al` to produce actionable performance insights for both humans and AI agents.

The design plan is in `Initial Plan.md` at the repo root.

## Related Repositories

- **al-perf-bc**: `U:\Git\al-perf-bc\` — Business Central companion app (AL extension). Adds an "Analyze" action to the Performance Profiler page that sends the profile to the al-perf web service for AI-powered analysis.
- **al-flamegraph**: `U:\Git\AL-Flamegraph\` — related flamegraph visualization
- **tree-sitter-al**: `U:\Git\tree-sitter-al\` — AL language grammar for tree-sitter (used for source analysis)

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **CLI framework**: `commander`
- **tree-sitter**: `web-tree-sitter` + `tree-sitter-al.wasm` (WASM for portability)
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

## Restarting the Web Server

When asked to restart the server, first check if it was started as a background task in this session and use `TaskStop` to stop it. Only fall back to `netstat`/`taskkill` if there is no background task to stop.

## Architecture

```
src/
  core/       — Profile parsing and analysis (pure functions, no I/O)
  source/     — tree-sitter-al integration for AL source code analysis
  cli/        — CLI commands (analyze, compare, hotspots, explain, source-map, analyze-source, mcp, gate, history, batch)
  cli/formatters/ — Output formatters (terminal, json, markdown, html) with section registry enforcement
  explain/    — LLM-powered analysis explanation (Anthropic API)
  mcp/        — MCP server definition and tool wrappers
  output/     — Canonical output types shared across all interfaces
  types/      — Shared TypeScript types (profile, source-index, analysis)
examples/   — Example scripts (performance-review.ts, ci-gate.sh)
test/       — Test suites + fixtures (bun:test)
```

### Engineering Principles

**SOLID, DRY, and TDD — pragmatically.** These principles serve maintainability, not architectural purity. Apply them where they reduce complexity; skip them where they'd add unnecessary abstraction or indirection. Three similar lines are fine if the alternative is a premature generalization. A simple function doesn't need an interface. Write tests first when the behavior is well-defined, but don't force TDD when spiking or exploring.

### Key Design Principles

- Every analysis function returns typed `AnalysisResult` objects — the canonical output structure. Batch analysis returns `BatchAnalysisResult` with aggregate sections.
- Output format (terminal/json/markdown) is a presentation concern, not an analysis concern
- **Formatter parity**: Enforced at compile time via `SectionRenderers<T>` in `src/output/sections.ts` (single-profile) and `BatchSectionRenderers<T>` in `src/output/batch-sections.ts` (batch). Every formatter must implement a renderer for every section type — TypeScript errors if one is missing. `SECTION_ORDER` / `BATCH_SECTION_ORDER` define the canonical render order.
- Source correlation is always optional — the tool must work without source files
- Profile-only pattern detectors work on any `.alcpuprofile`; source-correlated patterns require tree-sitter-al + `.al` files
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

1. **Parse** `.alcpuprofile` → `RawProfile`
2. **Process**: build call tree, compute times, aggregate → `ProcessedProfile`
3. **Detect patterns** (algorithmic, no AI) → `DetectedPattern[]`
4. **Source correlation** (optional, if `--source` provided): index AL files with tree-sitter-al, map hotspots to source, run anti-pattern queries → `SourceCorrelation[]`
5. **Format output** (terminal/json/markdown) → stdout

### Pattern Detection

Pattern detectors are composable functions with signature:
```typescript
type PatternDetector = (profile: ProcessedProfile, sourceIndex?: SourceIndex) => DetectedPattern[];
```

Three categories (18 detectors):
- **Profile-only** (7): single-method-dominance, high-hit-count, deep-call-stack, repeated-siblings, event-subscriber-hotspot, recursive-call, event-chain
- **Source-correlated** (5): calcfields-in-loop (with CalcFormula severity graduation), modify-in-loop, record-op-in-loop, missing-setloadfields, incomplete-setloadfields
- **Source-only** (6): nested-loops, unfiltered-findset, event-subscriber-with-loop-ops, event-subscriber-with-loops, commit-error-in-loop, unindexed-filter

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

**Tools** (9):
| Tool | Description |
|------|-------------|
| `analyze_profile` | Full analysis — hotspots, patterns, app/object/table breakdowns, summary |
| `analyze_batch` | Batch analysis of multiple profiles — aggregate hotspots, recurring patterns, activity breakdown |
| `get_hotspots` | Quick top-N hotspots (skips pattern detection) |
| `compare_profiles` | Before/after comparison — regressions, improvements, pattern diff |
| `explain_method` | Deep dive into one method — callers, callees, times |
| `analyze_source` | Static analysis of AL source files (no profile needed) |
| `gate_check` | CI/CD quality gate — pass/fail verdict against pattern thresholds |
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

```
POST /api/analyze-batch
Content-Type: multipart/form-data

Fields:
  manifest    (optional)  JSON string with ProfileMetadata[]
  profiles[]  (required)  One or more .alcpuprofile files
  source      (optional)  .zip of AL source files

Query params:
  ?format=html|json       (default: json)
```

The web UI auto-detects batch uploads when multiple profiles are dropped and renders the batch result view with drill-down.

## Library API

```typescript
import { analyzeProfile, analyzeBatch, compareProfiles, createMcpServer } from "al-perf";

// Analyze a single profile
const result = await analyzeProfile("path/to/profile.alcpuprofile", {
  top: 10,
  includePatterns: true,
  sourcePath: "path/to/al-source",
});

// Each pattern has an actionable suggestion
for (const p of result.patterns) {
  console.log(`[${p.severity}] ${p.title}: ${p.suggestion}`);
}

// Batch analysis of multiple profiles
const batchResult = await analyzeBatch(
  ["profile1.alcpuprofile", "profile2.alcpuprofile"],
  { sourcePath: "path/to/al-source", top: 10 }
);
console.log(`Analyzed ${batchResult.meta.profileCount} profiles`);
```

## Source Index Caching

When using `--source` with `--cache`, the source index is cached to `.al-profile-cache/` inside the source directory. The cache is hash-invalidated when any `.al` file changes (based on file paths + mtimes).

```typescript
import { SourceIndexCache } from "al-perf";
const cache = new SourceIndexCache(".cache");
const index = await cache.getOrBuild("path/to/al-source");
```

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
