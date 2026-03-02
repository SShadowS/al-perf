# al-profile-analyzer

[![npm version](https://img.shields.io/npm/v/al-profile-analyzer)](https://www.npmjs.com/package/al-profile-analyzer)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io)

> Analyze Business Central `.alcpuprofile` files — find hotspots, detect anti-patterns, and track regressions.

Works as a **CLI**, **web app**, **MCP server**, or **library**.

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [Web Server](#web-server)
- [MCP Server](#mcp-server)
- [Library API](#library-api)
- [Docker](#docker)
- [Pattern Reference](#pattern-reference)
- [Development](#development)
- [License](#license)

## Install

```bash
# npm / bun
bun add al-profile-analyzer

# From source
git clone https://github.com/anthropics/al-perf.git
cd al-perf
bun install
```

Requires [Bun](https://bun.sh) >= 1.0.0.

## Quick Start

```bash
# Analyze a profile
al-profile analyze profile.alcpuprofile

# With AL source correlation
al-profile analyze profile.alcpuprofile --source ./al-src

# Quick top-5 hotspots
al-profile hotspots profile.alcpuprofile

# Compare before/after
al-profile compare before.alcpuprofile after.alcpuprofile

# CI/CD quality gate (exits 1 on critical patterns)
al-profile gate profile.alcpuprofile --max-critical 0
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `analyze <profile>` | Full analysis — hotspots, patterns, app/object breakdowns |
| `hotspots <profile>` | Quick top-N hotspot summary |
| `compare <before> <after>` | Before/after diff — regressions and improvements |
| `explain <profile> <method>` | Deep dive into a single method — callers, callees, times |
| `analyze-source <path>` | Static analysis of AL source files (no profile needed) |
| `source-map <profile>` | Map profile methods to source file locations |
| `gate <profile>` | CI/CD quality gate — pass/fail against thresholds |
| `mcp` | Start the MCP server (stdio transport) |

**Common flags:**

```
-f, --format <type>   Output format: terminal, json, markdown, auto (default: auto)
-t, --top <n>         Number of hotspots to show (default: 10)
-s, --source <path>   Path to AL source files for correlation
--cache               Cache the source index for faster re-analysis
--explain             Append AI-powered explanation (requires ANTHROPIC_API_KEY)
--model <name>        AI model: sonnet (default), opus
```

## Web Server

Upload `.alcpuprofile` files through a browser for instant analysis.

```bash
bun run web
# → http://localhost:3010
```

Accepts optional source `.zip` files for correlation. If `ANTHROPIC_API_KEY` is set, results include an AI-generated explanation.

## MCP Server

Expose all analysis tools to AI agents (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "al-profiler": {
      "command": "bun",
      "args": ["run", "src/mcp/index.ts"]
    }
  }
}
```

**Tools:** `analyze_profile` · `get_hotspots` · `compare_profiles` · `explain_method` · `analyze_source` · `gate_check`

**Resources:** `pattern-docs` · `last-analysis`

## Library API

```typescript
import { analyzeProfile, compareProfiles } from "al-profile-analyzer";

const result = await analyzeProfile("profile.alcpuprofile", {
  top: 10,
  includePatterns: true,
  sourcePath: "./al-src",
});

for (const p of result.patterns) {
  console.log(`[${p.severity}] ${p.title}: ${p.suggestion}`);
}
```

## Docker

```bash
docker build -t al-profile-analyzer .
docker run -p 3010:3010 al-profile-analyzer

# With AI explanation
docker run -p 3010:3010 -e ANTHROPIC_API_KEY=sk-ant-... al-profile-analyzer
```

## Pattern Reference

### Profile-based

| Pattern | Severity | Description |
|---------|----------|-------------|
| High Hit Count | warning | Methods called excessively |
| Repeated Siblings | warning | Same method called repeatedly at same call site |
| Single Method Dominance | critical | One method consumes >50% of total time |
| Deep Call Stack | warning | Call chains deeper than 30 levels |
| Event Subscriber Hotspot | warning | Event subscribers consuming significant time |

### Source-correlated (requires `--source`)

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
bun test <file>      # Run a single test file
bunx tsc --noEmit    # Type check
bun run build        # Generate .d.ts declarations
bun run web          # Start the web server
```

## License

[MIT](LICENSE)
