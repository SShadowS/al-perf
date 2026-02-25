# AL CPU Profile Analyzer

Analyze Business Central `.alcpuprofile` files to find performance bottlenecks, detect anti-patterns, and track regressions — via CLI, MCP server, or library API.

## Features

- **Profile analysis** — Parse sampling & instrumentation profiles, identify hotspots, detect patterns
- **Source correlation** — Map profile hotspots to AL source code using tree-sitter-al
- **Pattern detection** — 10+ detectors for common AL performance anti-patterns
- **Profile comparison** — Before/after comparison to validate optimizations
- **Multiple output formats** — Terminal (colored), JSON, Markdown
- **MCP server** — Expose all analysis as tools for AI agents (Claude Code, etc.)
- **CI/CD gate** — Fail pipelines when critical patterns exceed thresholds
- **Static analysis** — Analyze AL source files without a profile

## Requirements

- [Bun](https://bun.sh/) >= 1.0.0

## Installation

```bash
# From npm
bun add al-profile-analyzer

# From source
git clone <repo-url>
cd al-perf
bun install
```

## Quick Start

### Analyze a profile

```bash
# Terminal output (default in TTY)
bun run src/cli/index.ts analyze path/to/profile.alcpuprofile

# With source correlation
bun run src/cli/index.ts analyze profile.alcpuprofile --source path/to/al-source

# With source caching (faster re-analysis)
bun run src/cli/index.ts analyze profile.alcpuprofile --source path/to/al-source --cache

# JSON output (for piping)
bun run src/cli/index.ts analyze profile.alcpuprofile -f json

# Markdown output (for reports)
bun run src/cli/index.ts analyze profile.alcpuprofile -f markdown
```

### Quick hotspots

```bash
bun run src/cli/index.ts hotspots profile.alcpuprofile --top 5
```

### Compare profiles

```bash
bun run src/cli/index.ts compare before.alcpuprofile after.alcpuprofile
```

### Static source analysis (no profile needed)

```bash
bun run src/cli/index.ts analyze-source path/to/al-source
```

### CI/CD quality gate

```bash
# Fail if any critical patterns detected
bun run src/cli/index.ts gate profile.alcpuprofile -f json

# With thresholds
bun run src/cli/index.ts gate profile.alcpuprofile --max-critical 0 --max-warning 5
```

## MCP Server

The analyzer runs as an MCP server for AI agent integration:

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

**Tools:** `analyze_profile`, `get_hotspots`, `compare_profiles`, `explain_method`, `analyze_source`, `gate_check`

**Resources:** `pattern-docs` (pattern reference), `last-analysis` (cached result)

## Library API

```typescript
import { analyzeProfile, compareProfiles } from "al-profile-analyzer";

const result = await analyzeProfile("profile.alcpuprofile", {
  top: 10,
  includePatterns: true,
  sourcePath: "path/to/al-source",
});

for (const p of result.patterns) {
  console.log(`[${p.severity}] ${p.title}: ${p.suggestion}`);
}
```

## Detected Patterns

### Profile-based

| Pattern | Severity | Description |
|---------|----------|-------------|
| High Hit Count | warning | Methods called excessively |
| Repeated Siblings | warning | Same method called repeatedly at same call site |
| Single Method Dominance | critical | One method consumes >50% of profile time |
| Deep Call Stack | warning | Call chains deeper than 30 levels |
| Event Subscriber Hotspot | warning | Event subscribers consuming significant time |

### Source-correlated (require `--source`)

| Pattern | Severity | Description |
|---------|----------|-------------|
| CalcFields in Loop | critical | CalcFields/CalcSums called inside loops |
| Modify in Loop | critical | Modify/ModifyAll called inside loops |
| Record Op in Loop | critical | FindSet/FindFirst/Get inside loops |
| Missing SetLoadFields | warning | Find operations without SetLoadFields |

### Source-only (no profile needed)

| Pattern | Severity | Description |
|---------|----------|-------------|
| Nested Loops | warning | Loops nested inside other loops |
| Unfiltered FindSet | warning | FindSet without SetRange/SetFilter |
| Event Subscriber Issues | info | Event subscribers containing loops or record ops |

## Development

```bash
bun install          # Install dependencies
bun test             # Run all tests
bun test <file>      # Run single test file
bunx tsc --noEmit    # Type check
bun run build        # Generate .d.ts declaration files
```

## License

MIT
