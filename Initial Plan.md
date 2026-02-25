# AL CPU Profile Analyzer — CLI Tool & MCP Server

**Design Plan & Developer Guide v2**
**Pivot:** Website → Local CLI + MCP server that AI agents can call
**Date:** February 2026

al-flamegrah repo: u:\Git\AL-Flamegraph\
tree-sitter-al repo: u:\Git\tree-sitter-al\

---

## 1. The Core Insight

A website can only see the profile. A local tool can see the profile **and** the source code. That changes everything.

When you combine:

- `.alcpuprofile` → **where** time is spent (methods, hit counts, call trees)
- `tree-sitter-al` → **what** the code actually does (loops, record operations, CalcFields)
- Source file access → **the actual lines** around the hotspot

...you get analysis that an LLM agent can act on directly. Not "this method is slow" but "line 47 of PostSalesLine.Codeunit.al has a CalcFields inside a repeat..until that iterates ~2,400 times — here's the code, here's a fix."

### 1.1 Three consumers, one tool

| Consumer | Interface | Output format |
|----------|-----------|---------------|
| **Human in terminal** | `al-profile analyze posting.alcpuprofile` | Colored terminal output, ASCII charts, markdown |
| **Claude Code / AI agent** | MCP tool call or CLI with `--format json` | Structured JSON with source snippets |
| **Multi-agent pipeline** | Agent SDK `createSdkMcpServer` | Same JSON, consumed by specialized agents |

The key principle: **every analysis command produces both a human-readable summary and a machine-readable structure**. The `--format` flag controls which you get. Default is `auto` (detects TTY vs pipe).

---

## 2. What tree-sitter-al Enables

Your tree-sitter-al parser can extract structural information from AL source files that the profile alone cannot provide. Here's what becomes possible:

### 2.1 Source-correlated hotspot analysis

Profile says: `PostSalesLine` has hitCount=2400, selfTime=8200ms

tree-sitter-al parses the actual procedure and finds:

```
repeat..until loop at line 47-89
  └── CalcFields("Amount") at line 62
  └── Modify() at line 78
  └── FindFirst() at line 51 (inside the loop body)
```

The tool can now output:

```
CRITICAL: PostSalesLine (Codeunit 80) — 8200ms (66% of total)
  Loop at lines 47-89 with ~2400 iterations
  Issues inside loop body:
    Line 62: CalcFields("Amount") — expensive FlowField recalc per iteration
    Line 78: Modify() — single-record write per iteration, consider ModifyAll
    Line 51: FindFirst() — record lookup per iteration, consider pre-loading

  Source context:
    47│ SalesLine.SetRange("Document No.", SalesHeader."No.");
    48│ if SalesLine.FindSet() then
    49│   repeat
    50│     ...
    51│     if Customer.FindFirst() then  ← HOTSPOT: Move outside loop
    52│       ...
    62│     SalesLine.CalcFields(Amount);  ← HOTSPOT: FlowField in loop
    ...
    78│     SalesLine.Modify();            ← HOTSPOT: Consider ModifyAll
    79│   until SalesLine.Next() = 0;
```

### 2.2 What to extract from AL source via tree-sitter

| AST query | Purpose |
|-----------|---------|
| `repeat..until` / `for..to` / `while..do` loops | Correlate with high hitCount nodes |
| `Record.FindSet()` / `FindFirst()` / `Find()` | Record operations — flag when inside loops |
| `Record.CalcFields(...)` | FlowField calculations — flag when inside loops |
| `Record.Modify()` / `ModifyAll()` | Write operations — suggest ModifyAll for bulk |
| `Record.SetLoadFields(...)` presence | Check if missing before FindSet |
| `procedure` / `trigger` declarations | Map profile method names to exact file:line |
| Event subscribers `[EventSubscriber(...)]` | Identify subscriber chains |
| `if ... then begin ... end` nesting depth | Complexity metric |
| Table/field references | Which tables and fields are touched |

### 2.3 tree-sitter query examples for AL

```scheme
;; Find all repeat..until loops
(repeat_statement) @loop

;; Find method calls inside loops
(repeat_statement
  (statement_list
    (expression_statement
      (method_call
        method: (member_access
          field: (identifier) @method_name)))))

;; Find CalcFields calls
(method_call
  method: (member_access
    field: (identifier) @name
    (#eq? @name "CalcFields")))

;; Find procedure declarations with their names
(procedure_declaration
  name: (identifier) @proc_name)

;; Find trigger declarations
(trigger_declaration
  name: (identifier) @trigger_name)
```

These queries let you build a **source index** that maps every procedure/trigger to its file, line range, and structural features (loops, record ops, etc.).

---

## 3. Architecture

### 3.1 Package structure

```
al-profile-analyzer/
├── src/
│   ├── cli/                      # CLI entry point
│   │   ├── index.ts              # Main CLI with commander/yargs
│   │   ├── commands/
│   │   │   ├── analyze.ts        # Single profile analysis
│   │   │   ├── compare.ts        # Two-profile comparison
│   │   │   ├── hotspots.ts       # Quick hotspot summary
│   │   │   ├── source-map.ts     # Build source index
│   │   │   └── explain.ts        # Explain a specific method
│   │   └── formatters/
│   │       ├── terminal.ts       # Colored TTY output
│   │       ├── json.ts           # Machine-readable JSON
│   │       ├── markdown.ts       # Markdown report
│   │       └── auto.ts           # Detect TTY, pick format
│   │
│   ├── mcp/                      # MCP server
│   │   ├── server.ts             # MCP server definition
│   │   └── tools.ts              # Tool definitions
│   │
│   ├── core/                     # Shared analysis engine
│   │   ├── parser.ts             # .alcpuprofile parser
│   │   ├── processor.ts          # Tree builder, time calculator
│   │   ├── aggregator.ts         # Group by app/object/method/table
│   │   ├── patterns.ts           # Algorithmic pattern detection
│   │   └── comparator.ts         # Two-profile diff engine
│   │
│   ├── source/                   # Source code analysis
│   │   ├── indexer.ts            # Walk AL files, build source index
│   │   ├── locator.ts            # Map profile methods → source files
│   │   ├── analyzer.ts           # tree-sitter queries for anti-patterns
│   │   ├── snippets.ts           # Extract relevant source context
│   │   └── queries/              # tree-sitter query files
│   │       ├── loops.scm
│   │       ├── record-ops.scm
│   │       ├── declarations.scm
│   │       └── patterns.scm
│   │
│   ├── output/                   # Output data structures
│   │   ├── types.ts              # The canonical output types
│   │   ├── human.ts              # Human-readable rendering
│   │   └── llm.ts                # LLM-optimized rendering
│   │
│   └── types/                    # Shared TypeScript types
│       ├── profile.ts            # .alcpuprofile types
│       ├── source-index.ts       # Source index types
│       └── analysis.ts           # Analysis result types
│
├── tree-sitter-al/               # Git submodule or npm dep
├── package.json
├── tsconfig.json
└── CLAUDE.md                     # Instructions for AI agents
```

### 3.2 Flow: CLI analysis

```
al-profile analyze posting.alcpuprofile --source ./src --format auto

  ┌─────────────────────────────────┐
  │  1. Parse .alcpuprofile         │ → RawProfile
  └──────────────┬──────────────────┘
                 │
  ┌──────────────▼──────────────────┐
  │  2. Process: build tree,        │ → ProcessedProfile
  │     compute times, aggregate    │   (tree, aggregations, stats)
  └──────────────┬──────────────────┘
                 │
  ┌──────────────▼──────────────────┐
  │  3. Detect patterns             │ → DetectedPattern[]
  │     (loops, N+1, recursion,     │   (algorithmic, no AI)
  │      silent killers, etc.)      │
  └──────────────┬──────────────────┘
                 │
  ┌──────────────▼──────────────────┐
  │  4. Source correlation          │ → SourceCorrelation[]
  │     (if --source provided)      │
  │     - Index AL files with       │
  │       tree-sitter-al            │
  │     - Map hotspot methods to    │
  │       source locations          │
  │     - Extract source context    │
  │     - Run anti-pattern queries  │
  └──────────────┬──────────────────┘
                 │
  ┌──────────────▼──────────────────┐
  │  5. Format output               │ → stdout
  │     (terminal / json / markdown)│
  └─────────────────────────────────┘
```

### 3.3 Flow: MCP server (called by Claude Code or Agent SDK)

```json
// .mcp.json in project root
{
  "mcpServers": {
    "al-profiler": {
      "command": "npx",
      "args": ["al-profile-analyzer", "mcp"],
      "env": {
        "AL_SOURCE_PATH": "./app/src"
      }
    }
  }
}
```

Agent calls:
```
mcp__al-profiler__analyze_profile({ profilePath: "./perf/posting.alcpuprofile" })
mcp__al-profiler__explain_method({ profilePath: "...", method: "PostSalesLine", objectId: 80 })
mcp__al-profiler__compare_profiles({ before: "...", after: "..." })
mcp__al-profiler__hotspots({ profilePath: "...", top: 10 })
```

### 3.4 Flow: Agent SDK (inside multi-agent pipeline)

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { analyzeProfile, compareProfiles } from "al-profile-analyzer";

const profilerServer = createSdkMcpServer({
  name: "al-profiler",
  version: "1.0.0",
  tools: [
    tool(
      "analyze_profile",
      "Analyze an AL CPU profile file, returning hotspots, patterns, and source-correlated findings",
      {
        profilePath: z.string().describe("Path to .alcpuprofile file"),
        sourcePath: z.string().optional().describe("Path to AL source directory"),
        top: z.number().optional().describe("Number of top hotspots to return"),
      },
      async (args) => {
        const result = await analyzeProfile(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    ),
    tool(
      "compare_profiles",
      "Compare two AL CPU profiles (before/after) and identify regressions and improvements",
      {
        beforePath: z.string(),
        afterPath: z.string(),
        sourcePath: z.string().optional(),
      },
      async (args) => {
        const result = await compareProfiles(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    ),
  ]
});

// Use in a performance review agent
for await (const message of query({
  prompt: "Analyze the profile at ./perf/posting.alcpuprofile against our source code and suggest optimizations",
  options: {
    mcpServers: { "al-profiler": profilerServer },
    allowedTools: [
      "mcp__al-profiler__analyze_profile",
      "mcp__al-profiler__compare_profiles",
      "Read",   // Agent can also read source files directly
      "Grep",
      "Edit",   // Agent can propose fixes
    ],
  }
})) {
  // Agent reads profile → identifies hotspots → reads source → proposes edits
}
```

This is the real power: an agent that can **find the bottleneck, read the code, and write the fix** in one loop.

---

## 4. Output Design

The most critical design decision: the output format must serve both humans and LLMs well.

### 4.1 Canonical output structure

Every analysis command produces an `AnalysisResult`:

```typescript
interface AnalysisResult {
  meta: {
    profilePath: string;
    profileType: "sampling" | "instrumentation";
    samplingInterval?: number;
    totalTime: number;
    totalNodes: number;
    sourceAvailable: boolean;
    analyzedAt: string;   // ISO timestamp
  };

  summary: {
    oneLiner: string;     // "12.4s posting process, 66% in Sales Line table ops"
    totalTime: number;
    topApp: { name: string; percent: number };
    topMethod: { name: string; object: string; percent: number };
    patternCount: { critical: number; warning: number; info: number };
  };

  hotspots: Hotspot[];

  patterns: DetectedPattern[];

  appBreakdown: AppBreakdown[];

  objectBreakdown: ObjectBreakdown[];

  // Only when source is available
  sourceFindings?: SourceFinding[];

  // Raw data for LLMs that want to dig deeper
  callTree?: CallTreeNode;
}

interface Hotspot {
  rank: number;
  method: string;
  objectType: string;
  objectName: string;
  objectId: number;
  app: string;
  selfTime: number;
  selfTimePercent: number;
  totalTime: number;
  totalTimePercent: number;
  hitCount: number;
  calledBy: string[];             // Parent methods
  calls: string[];                // Child methods

  // Source correlation (when available)
  source?: {
    file: string;                 // Relative path
    lineStart: number;
    lineEnd: number;
    snippet: string;              // The relevant source lines
  };
}

interface DetectedPattern {
  id: string;                     // "loop-calcfields", "n-plus-one", etc.
  severity: "critical" | "warning" | "info";
  title: string;                  // "CalcFields inside loop"
  description: string;            // Human-readable explanation
  impact: number;                 // Estimated ms that could be saved
  involvedMethods: string[];
  evidence: string;               // What data supports this finding

  // Source correlation
  source?: {
    file: string;
    lineStart: number;
    lineEnd: number;
    snippet: string;
    annotatedSnippet: string;     // Snippet with ← ISSUE markers
  };

  suggestion?: {
    what: string;                 // "Use SetLoadFields before FindSet"
    why: string;                  // "Limits fields loaded from DB"
    example?: string;             // AL code example
  };
}

interface SourceFinding {
  type: "loop_with_record_op" | "missing_setloadfields"
      | "modify_in_loop" | "calcfields_in_loop"
      | "unfiltered_findset" | "deep_nesting"
      | "event_subscriber_chain";
  file: string;
  line: number;
  method: string;
  detail: string;
  profileCorrelation?: {          // Link back to profile data
    hitCount: number;
    selfTime: number;
  };
}
```

### 4.2 Human output (terminal)

```
╔══════════════════════════════════════════════════════════════╗
║  AL Profile Analysis — posting.alcpuprofile                 ║
╚══════════════════════════════════════════════════════════════╝

Summary: 12.4s posting process, 66% in Sales Line table operations
Profile: sampling @ 100ms intervals, 847 nodes, 5 apps

── Top 5 Hotspots ──────────────────────────────────────────────

 #1  PostSalesLine (Codeunit 80, Base Application)
     Self: 8200ms (66.1%)  Total: 9400ms  Hits: 2400
     📁 src/Codeunit/Cod80.PostSalesLine.al:47-89

     47│ SalesLine.SetRange("Document No.", SalesHeader."No.");
     48│ if SalesLine.FindSet() then
     49│   repeat
     ..│     ...
     62│     SalesLine.CalcFields(Amount);  ← ⚠ FlowField in loop
     ..│     ...
     78│     SalesLine.Modify();            ← ⚠ Single Modify in loop
     79│   until SalesLine.Next() = 0;

 #2  ValidateCustomerNo (Table 36, Base Application)
     Self: 940ms (7.6%)  Total: 1100ms  Hits: 12
     ...

── Detected Patterns ───────────────────────────────────────────

 🔴 CRITICAL  CalcFields in loop (PostSalesLine, line 62)
    CalcFields("Amount") called ~2400× inside repeat..until
    Impact: ~6000ms  |  Fix: Pre-calculate or use SIFT

 🔴 CRITICAL  Single Modify in loop (PostSalesLine, line 78)
    Modify() called ~2400× inside repeat..until
    Impact: ~1500ms  |  Fix: Collect changes, use ModifyAll

 🟡 WARNING   Missing SetLoadFields (PostSalesLine, line 48)
    FindSet() without SetLoadFields loads all fields
    Impact: ~400ms   |  Fix: Add SetLoadFields before FindSet

── App Breakdown ───────────────────────────────────────────────

 Base Application      ████████████████████████████████████░  89%  11.0s
 Sales Customizations  ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   8%   1.0s
 Inventory Insights    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   2%   0.2s
 System Application    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   1%   0.1s
```

### 4.3 JSON output (for LLMs / piping)

Same structure as `AnalysisResult`, pretty-printed. An LLM agent sees:

```json
{
  "meta": {
    "profilePath": "posting.alcpuprofile",
    "profileType": "sampling",
    "totalTime": 12400,
    "sourceAvailable": true
  },
  "summary": {
    "oneLiner": "12.4s posting process, 66% in Sales Line table operations",
    "topMethod": {
      "name": "PostSalesLine",
      "object": "Codeunit 80",
      "percent": 66.1
    }
  },
  "hotspots": [
    {
      "rank": 1,
      "method": "PostSalesLine",
      "objectType": "Codeunit",
      "objectName": "Sales-Post",
      "objectId": 80,
      "selfTime": 8200,
      "hitCount": 2400,
      "source": {
        "file": "src/Codeunit/Cod80.PostSalesLine.al",
        "lineStart": 47,
        "lineEnd": 89,
        "snippet": "SalesLine.SetRange(\"Document No.\", ...);\nif SalesLine.FindSet() then\n  repeat\n    ...\n    SalesLine.CalcFields(Amount);\n    ...\n    SalesLine.Modify();\n  until SalesLine.Next() = 0;"
      }
    }
  ],
  "patterns": [
    {
      "id": "calcfields-in-loop",
      "severity": "critical",
      "title": "CalcFields inside loop",
      "impact": 6000,
      "source": {
        "file": "src/Codeunit/Cod80.PostSalesLine.al",
        "lineStart": 62,
        "annotatedSnippet": "    SalesLine.CalcFields(Amount);  // ← Called ~2400× inside repeat..until"
      },
      "suggestion": {
        "what": "Pre-calculate Amount using a query or SIFT-enabled key",
        "why": "CalcFields triggers a separate SQL query per call for FlowFields"
      }
    }
  ]
}
```

An LLM reading this can immediately:
1. Understand the problem (structured data, not prose to parse)
2. Open the file at the exact line (`Read` tool on `src/Codeunit/Cod80.PostSalesLine.al`)
3. Propose an edit (`Edit` tool targeting line 62)

### 4.4 Markdown output (for reports / docs)

```
al-profile analyze posting.alcpuprofile --format markdown > report.md
```

Produces a clean markdown document suitable for including in PRs, tickets, or documentation.

---

## 5. CLI Commands

### 5.1 `al-profile analyze`

The main command. Full analysis of a single profile.

```
al-profile analyze <profile> [options]

Options:
  --source, -s <path>     Path to AL source directory (enables source correlation)
  --format, -f <format>   Output format: auto|terminal|json|markdown (default: auto)
  --top, -n <number>      Number of top hotspots (default: 10)
  --threshold <ms>        Minimum selfTime to report (default: 0)
  --app-filter <name>     Focus on specific app(s), comma-separated
  --no-patterns           Skip pattern detection
  --no-source             Skip source analysis even if --source provided
  --include-tree          Include full call tree in JSON output
  --verbose, -v           Show more detail

Examples:
  al-profile analyze posting.alcpuprofile
  al-profile analyze posting.alcpuprofile -s ./src -n 20
  al-profile analyze posting.alcpuprofile -f json | jq '.hotspots[:3]'
  al-profile analyze posting.alcpuprofile -f json | claude "suggest fixes for the top issue"
```

### 5.2 `al-profile compare`

Compare two profiles (before/after).

```
al-profile compare <before> <after> [options]

Options:
  --source, -s <path>     Path to AL source directory
  --format, -f <format>   Output format
  --threshold <ms>        Minimum delta to report (default: 50ms)

Output includes:
  - Overall delta (total time change)
  - Per-method deltas (regressions in red, improvements in green)
  - New methods (appeared in "after")
  - Removed methods (disappeared from "after")
  - Matched method statistics

Examples:
  al-profile compare before.alcpuprofile after.alcpuprofile
  al-profile compare before.alcpuprofile after.alcpuprofile -f json
```

### 5.3 `al-profile hotspots`

Quick summary — just the top N hotspots, minimal output. Designed for fast triage.

```
al-profile hotspots <profile> [options]

Options:
  --top, -n <number>      Number of hotspots (default: 5)
  --format, -f <format>   Output format
  --by <grouping>         Group by: method|app|object|table (default: method)

Examples:
  al-profile hotspots posting.alcpuprofile
  al-profile hotspots posting.alcpuprofile --by app
  al-profile hotspots posting.alcpuprofile --by table -f json
```

### 5.4 `al-profile explain`

Deep dive into a specific method — shows everything known about it from both the profile and source.

```
al-profile explain <profile> <method> [options]

Options:
  --source, -s <path>     Path to AL source
  --object-id <id>        Disambiguate when multiple objects have same method name
  --format, -f <format>   Output format

Examples:
  al-profile explain posting.alcpuprofile PostSalesLine -s ./src
  al-profile explain posting.alcpuprofile OnValidate --object-id 36
```

Output for a single method includes:
- Profile stats (self-time, total-time, hit count, % of total)
- Call context (who calls it, what it calls)
- Full source code of the method (if available)
- All detected patterns involving this method
- Annotated source with issue markers

### 5.5 `al-profile source-map`

Build and inspect the source index. Useful for debugging source correlation.

```
al-profile source-map <source-path> [options]

Options:
  --format, -f <format>   Output format
  --stats                 Show statistics about the source index

Examples:
  al-profile source-map ./src --stats
  al-profile source-map ./src -f json | jq '.procedures | length'
```

### 5.6 `al-profile mcp`

Start as an MCP server (stdio transport).

```
al-profile mcp [options]

Options:
  --source, -s <path>     Default AL source path (can be overridden per tool call)

Used in .mcp.json:
  { "command": "npx", "args": ["al-profile-analyzer", "mcp", "-s", "./src"] }
```

---

## 6. MCP Server Tools

### 6.1 Tool definitions

```typescript
// analyze_profile
{
  name: "analyze_profile",
  description: `Analyze an AL CPU profile (.alcpuprofile) file from Business Central.
    Returns hotspots, detected anti-patterns, app breakdown, and source-correlated
    findings. Use this when you need to understand why a BC process is slow.`,
  input: {
    profilePath: z.string().describe("Path to .alcpuprofile file"),
    sourcePath: z.string().optional()
      .describe("Path to AL source directory for code correlation"),
    top: z.number().optional().default(10)
      .describe("Number of top hotspots to include"),
    appFilter: z.string().optional()
      .describe("Comma-separated app names to focus on"),
  }
}

// compare_profiles
{
  name: "compare_profiles",
  description: `Compare two AL CPU profiles (before and after) to identify
    performance regressions and improvements. Returns per-method deltas,
    new/removed methods, and overall change summary.`,
  input: {
    beforePath: z.string().describe("Path to the 'before' profile"),
    afterPath: z.string().describe("Path to the 'after' profile"),
    sourcePath: z.string().optional(),
    threshold: z.number().optional().default(50)
      .describe("Minimum delta in ms to report"),
  }
}

// explain_method
{
  name: "explain_method",
  description: `Deep dive into a specific method from an AL CPU profile.
    Returns full profile stats, call context, source code, and all patterns
    involving this method. Use after analyze_profile to investigate a specific hotspot.`,
  input: {
    profilePath: z.string(),
    method: z.string().describe("Method/function name to explain"),
    objectId: z.number().optional()
      .describe("Object ID to disambiguate duplicate method names"),
    sourcePath: z.string().optional(),
  }
}

// get_hotspots
{
  name: "get_hotspots",
  description: `Quick hotspot summary from an AL CPU profile.
    Returns the top N most expensive methods. Faster and lighter than full analysis.`,
  input: {
    profilePath: z.string(),
    top: z.number().optional().default(5),
    groupBy: z.enum(["method", "app", "object", "table"]).optional(),
  }
}

// analyze_source
{
  name: "analyze_source",
  description: `Analyze AL source code for potential performance issues using
    tree-sitter-al, independent of any profile. Finds loops with record operations,
    missing SetLoadFields, etc. Use for preventive analysis.`,
  input: {
    sourcePath: z.string().describe("Path to AL source directory or file"),
    patterns: z.array(z.string()).optional()
      .describe("Specific patterns to check: loop-calcfields, missing-setloadfields, modify-in-loop, etc."),
  }
}
```

### 6.2 MCP Resources

The MCP server can also expose resources:

```typescript
// Last analysis result
"resource://al-profiler/last-analysis"

// Source index (list of all procedures/triggers with locations)
"resource://al-profiler/source-index"

// Detected patterns documentation
"resource://al-profiler/pattern-docs"
```

---

## 7. Source Indexer Design

### 7.1 The source index

When `--source` is provided, the tool builds an index of all AL source files:

```typescript
interface SourceIndex {
  files: Map<string, ALFile>;
  procedures: Map<string, ProcedureInfo[]>;  // key = procedure name
  triggers: Map<string, TriggerInfo[]>;
  objects: Map<number, ObjectInfo>;           // key = object ID
  tables: Map<number, TableInfo>;

  // Lookup helpers
  findProcedure(name: string, objectId?: number): ProcedureInfo | null;
  findTrigger(name: string, objectId?: number): TriggerInfo | null;
  getSourceSnippet(file: string, startLine: number, endLine: number): string;
}

interface ProcedureInfo {
  name: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  objectType: string;
  objectName: string;
  objectId: number;

  // Structural features (from tree-sitter analysis)
  features: {
    hasLoops: boolean;
    loopLocations: LineRange[];
    recordOperations: RecordOp[];      // FindSet, Modify, CalcFields, etc.
    recordOpsInLoops: RecordOp[];      // Subset that are inside loops
    nestingDepth: number;
    callsCount: number;
    localVariables: VariableInfo[];
    parameters: ParameterInfo[];
  };
}

interface RecordOp {
  type: "FindSet" | "FindFirst" | "Find" | "CalcFields" | "Modify"
      | "ModifyAll" | "Insert" | "Delete" | "DeleteAll"
      | "SetLoadFields" | "SetRange" | "SetFilter" | "Get";
  line: number;
  column: number;
  insideLoop: boolean;
  recordVariable?: string;
  arguments?: string[];    // e.g., field names for CalcFields
}
```

### 7.2 Matching profile methods to source

The profile gives us:
- `functionName`: "PostSalesLine"
- `applicationDefinition.objectType`: "Codeunit"
- `applicationDefinition.objectId`: 80
- `applicationDefinition.objectName`: "Sales-Post"
- `declaringApplication.appName`: "Base Application"

The source index gives us:
- Procedure "PostSalesLine" in object Codeunit 80 at `src/Codeunit/Cod80.SalesPost.al:47`

**Matching strategy:**

```typescript
function matchToSource(node: ProcessedNode, index: SourceIndex): ProcedureInfo | null {
  const { functionName } = node.callFrame;
  const objectId = node.applicationDefinition?.objectId;

  // 1. Exact match: name + objectId
  if (objectId) {
    const match = index.findProcedure(functionName, objectId);
    if (match) return match;
  }

  // 2. Name-only match (when objectId is missing or for triggers)
  const candidates = index.procedures.get(functionName) ?? [];
  if (candidates.length === 1) return candidates[0];

  // 3. Disambiguate by object type + name
  if (node.applicationDefinition) {
    const match = candidates.find(c =>
      c.objectType === node.applicationDefinition.objectType &&
      c.objectName === node.applicationDefinition.objectName
    );
    if (match) return match;
  }

  // 4. No match — method is from an app we don't have source for
  return null;
}
```

**Important:** We'll only have source for the user's own extensions, not for Base Application or third-party apps. The tool should handle this gracefully — profile data for all apps, source correlation only where available.

---

## 8. Pattern Detection Engine

### 8.1 Profile-only patterns (no source needed)

| Pattern | Detection logic | Severity |
|---------|----------------|----------|
| **High hitCount in subtree** | Node with hitCount > 100 where parent has hitCount < 10 | warning |
| **Repeated sibling calls** | Same method appears 50+ times as child of same parent | critical |
| **Deep call stack** | Max depth > 30 | warning |
| **Event subscriber hotspot** | OnBefore*/OnAfter* methods with combined selfTime > 10% | warning |
| **Cross-app overhead** | Time spent crossing app boundaries > 20% | info |
| **Single method dominance** | One method > 50% of total selfTime | critical |
| **Silent killer** | selfTime < 1% but hitCount in top 5 | warning |

### 8.2 Source-correlated patterns (tree-sitter + profile)

| Pattern | Detection logic | Severity |
|---------|----------------|----------|
| **CalcFields in loop** | tree-sitter finds CalcFields inside repeat/for/while + hitCount confirms | critical |
| **Modify in loop** | tree-sitter finds Modify() inside loop + hitCount > 10 | critical |
| **FindSet/FindFirst in loop** | Record lookup inside loop body | critical |
| **Missing SetLoadFields** | FindSet/FindFirst without preceding SetLoadFields on same record var | warning |
| **Unfiltered FindSet** | FindSet without preceding SetRange/SetFilter | warning |
| **Nested loops** | tree-sitter finds loop inside loop, either has high hitCount | critical |
| **Table operation clustering** | Multiple hotspot methods all operate on the same table | info |

### 8.3 Composability

Patterns are composable filters. Each pattern detector is a function:

```typescript
type PatternDetector = (
  profile: ProcessedProfile,
  sourceIndex?: SourceIndex
) => DetectedPattern[];

// Register detectors
const detectors: PatternDetector[] = [
  detectHighHitCount,
  detectRepeatedSiblings,
  detectDeepCallStack,
  detectEventSubscriberHotspots,
  detectSingleMethodDominance,
  // Source-correlated (only run if sourceIndex available)
  detectCalcFieldsInLoop,
  detectModifyInLoop,
  detectRecordOpInLoop,
  detectMissingSetLoadFields,
  detectNestedLoops,
];

function runDetectors(profile: ProcessedProfile, sourceIndex?: SourceIndex): DetectedPattern[] {
  return detectors
    .flatMap(detect => detect(profile, sourceIndex))
    .sort((a, b) => b.impact - a.impact);  // Most impactful first
}
```

Users and agents can also add custom detectors — the engine is pluggable.

---

## 9. Multi-Agent Pipeline Integration

This tool slots into your existing DevOps pipeline architecture as a specialized stage:

```
Azure DevOps Work Item
        │
        ▼
┌─────────────────┐
│  Analysis Agent  │  ← Reads work item, understands requirements
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Planning Agent  │  ← Plans implementation approach
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Code Agent     │  ← Writes the AL code
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Performance Review Agent  ★    │  ← NEW: Uses al-profile-analyzer
│                                 │
│  1. Run BC container with test  │
│  2. Execute profiled scenario   │
│  3. Call analyze_profile MCP    │
│  4. If patterns.critical > 0:  │
│     → Call explain_method       │
│     → Read source, propose fix  │
│     → Loop back to Code Agent   │
│  5. If comparing to baseline:   │
│     → Call compare_profiles     │
│     → Gate on regression thresh │
│                                 │
│  Output: Performance report     │
│  as PR comment or work item     │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────┐
│  Review Agent    │  ← Code review, including perf findings
└─────────────────┘
```

### 9.1 Performance gate in CI/CD

The CLI can be used as a CI gate:

```yaml
# Azure DevOps pipeline
- script: |
    al-profile analyze $(Build.ArtifactStagingDirectory)/perf-profile.alcpuprofile \
      --source ./src \
      --format json \
      --app-filter "My Extension" \
      > analysis.json

    # Fail if any critical patterns detected
    CRITICAL_COUNT=$(jq '.summary.patternCount.critical' analysis.json)
    if [ "$CRITICAL_COUNT" -gt 0 ]; then
      echo "##vso[task.logissue type=error]$CRITICAL_COUNT critical performance patterns detected"
      jq '.patterns[] | select(.severity == "critical") | .title' analysis.json
      exit 1
    fi
  displayName: 'Performance gate'
```

### 9.2 Standalone source analysis (no profile needed)

For preventive analysis in PRs, even without running a profile:

```bash
# Analyze changed files for known anti-patterns
al-profile analyze-source ./src --format json | jq '.findings[]'
```

This uses tree-sitter-al only — scans source for structural anti-patterns without any profiler data. Useful as a fast lint-like check.

---

## 10. Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Bun | Your existing stack, fast startup for CLI |
| **Language** | TypeScript | Type safety, Agent SDK compatibility |
| **CLI framework** | `commander` or `citty` | Lightweight, good subcommand support |
| **tree-sitter binding** | `tree-sitter` npm + `tree-sitter-al` | Your parser, native bindings via node-gyp or WASM |
| **MCP server** | `@modelcontextprotocol/sdk` | Standard MCP, works with Claude Code |
| **Agent SDK integration** | `@anthropic-ai/claude-agent-sdk` | For embedding in pipeline agents |
| **Terminal output** | `chalk` + `cli-table3` or `columnify` | Colored, formatted terminal output |
| **JSON output** | Native `JSON.stringify` | No dep needed |
| **Testing** | `bun:test` | Built-in, fast |
| **Publishing** | npm | `npx al-profile-analyzer analyze ...` |

### 10.1 tree-sitter-al integration options

Two approaches for consuming tree-sitter-al:

**Option A: Native binding (faster, harder to distribute)**
```typescript
import Parser from "tree-sitter";
import AL from "tree-sitter-al";

const parser = new Parser();
parser.setLanguage(AL);
const tree = parser.parse(sourceCode);
```
Requires native compilation. Works great locally, harder for npm distribution.

**Option B: WASM binding (slightly slower, universal)**
```typescript
import Parser from "web-tree-sitter";

await Parser.init();
const parser = new Parser();
const AL = await Parser.Language.load("tree-sitter-al.wasm");
parser.setLanguage(AL);
const tree = parser.parse(sourceCode);
```
No native compilation. Works everywhere. Slightly slower parse time but for a CLI tool analyzing a finite set of files, this is fine.

**Recommendation:** Start with WASM for easy npm distribution. Add native binding as optional optimization later.

---

## 11. Implementation Phases

### Phase 1: Core CLI + Parser (MVP)
**Ship: A working `analyze` command with terminal and JSON output**

- [ ] Profile parser (handle both sampling and instrumentation)
- [ ] Tree builder and time calculator
- [ ] Aggregator (by app, object, method)
- [ ] Basic pattern detection (profile-only patterns)
- [ ] `analyze` command with terminal and JSON formatters
- [ ] `hotspots` command
- [ ] `compare` command (basic delta computation)
- [ ] npm publishable

**Estimated:** 1-2 weeks

### Phase 2: Source Correlation
**Ship: tree-sitter-al integration, source-correlated findings**

- [ ] Source indexer (walk AL files, build procedure/trigger map)
- [ ] Profile-to-source matching
- [ ] Source snippet extraction
- [ ] tree-sitter queries for loops, record ops, etc.
- [ ] Source-correlated pattern detection
- [ ] `explain` command
- [ ] `source-map` command
- [ ] Annotated source output (with ← markers)

**Estimated:** 2-3 weeks

### Phase 3: MCP Server
**Ship: Claude Code can call the tool**

- [ ] MCP server with stdio transport
- [ ] All analysis tools exposed as MCP tools
- [ ] MCP resources (last analysis, source index)
- [ ] .mcp.json example configuration
- [ ] CLAUDE.md with usage instructions
- [ ] Documentation for Claude Code users

**Estimated:** 1 week

### Phase 4: Agent SDK Integration
**Ship: Embeddable in multi-agent pipelines**

- [ ] Export `analyzeProfile()`, `compareProfiles()` as library functions
- [ ] `createSdkMcpServer` factory function
- [ ] Example performance review agent
- [ ] CI/CD gate script examples
- [ ] Agent-optimized output (structured for tool-use loops)

**Estimated:** 1 week

### Phase 5: Advanced Patterns + Source Analysis
**Ship: Deeper detection, standalone source linting**

- [ ] `analyze-source` command (no profile needed)
- [ ] Additional tree-sitter queries (nested loops, temp table patterns, etc.)
- [ ] Custom pattern definition (YAML/JSON pattern specs)
- [ ] Event subscriber chain analysis
- [ ] Table operation clustering

**Estimated:** 2 weeks

### Phase 6: Polish
**Ship: Production-ready tool**

- [ ] Markdown formatter
- [ ] Performance optimization (large profiles)
- [ ] Caching (source index, parsed profiles)
- [ ] Comprehensive test suite with sample profiles
- [ ] Comprehensive CLAUDE.md for optimal agent behavior
- [ ] Blog post + documentation site

**Estimated:** 1-2 weeks

---

## 12. The CLAUDE.md

When this tool runs in a project, the CLAUDE.md should teach agents how to use it effectively:

```markdown
# AL Profile Analyzer

This project has the `al-profile-analyzer` MCP server configured.
Use it to analyze Business Central performance profiles.

## Available tools

- `analyze_profile` — Full analysis of .alcpuprofile files
- `compare_profiles` — Before/after comparison
- `explain_method` — Deep dive into a specific method
- `get_hotspots` — Quick top-N summary
- `analyze_source` — Lint AL source for anti-patterns (no profile needed)

## Workflow for performance investigation

1. Start with `get_hotspots` to identify the top bottlenecks
2. Use `explain_method` to understand each hotspot in detail
3. Read the source files at the indicated locations
4. Propose fixes based on the detected patterns and suggestions
5. After implementing fixes, use `compare_profiles` to validate improvement

## Workflow for PR review

1. Use `analyze_source` on changed files to catch anti-patterns early
2. If a profile is available, use `analyze_profile` to check for regressions
3. Comment findings on the relevant lines

## Key BC/AL performance rules

- Always use SetLoadFields before FindSet/FindFirst
- Never call CalcFields on FlowFields inside loops
- Prefer ModifyAll over Modify inside loops when possible
- Watch for record operations (Find*, Get) inside repeat..until
- Event subscribers add hidden overhead — check subscriber chains
```

---

## 13. CLAUDE.md for the Analyzer's Own Development

For when Claude Code is working on the analyzer itself:

```markdown
# al-profile-analyzer Development

## Architecture
- `src/core/` — Profile parsing and analysis (no I/O, pure functions)
- `src/source/` — tree-sitter-al integration for source analysis
- `src/cli/` — CLI commands and formatters
- `src/mcp/` — MCP server definition
- `src/output/` — Canonical output types shared across all interfaces

## Key design principles
- Every analysis function returns typed `AnalysisResult` objects
- Output format (terminal/json/markdown) is a presentation concern, not analysis concern
- Source correlation is always optional — tool must work without source
- Profile-only patterns work on any .alcpuprofile
- Source patterns require tree-sitter-al + access to .al files
- MCP tools are thin wrappers around the same core functions the CLI uses

## Testing
- Test profiles in `test/fixtures/*.alcpuprofile`
- Test AL source in `test/fixtures/src/`
- Every pattern detector has unit tests with known-positive and known-negative profiles
- Run: `bun test`

## tree-sitter-al usage
- Parser initialized in `src/source/indexer.ts`
- Queries defined in `src/source/queries/*.scm`
- Use WASM binding for portability: `web-tree-sitter` + `tree-sitter-al.wasm`
```

---

## 14. Open Questions

| # | Question | Options | Leaning |
|---|----------|---------|---------|
| 1 | **Package name** | `al-profile-analyzer`, `al-perf`, `bcprof` | `al-profile-analyzer` (clear) |
| 2 | **tree-sitter binding** | Native (tree-sitter) vs WASM (web-tree-sitter) | WASM for distribution |
| 3 | **Monorepo?** | Single package vs separate core/cli/mcp | Single package, separate entry points |
| 4 | **Base App source** | Bundle known MS object signatures, or skip? | Skip — focus on user's extensions |
| 5 | **Config file** | `.alprofilerrc`, inline CLI flags only | CLI flags + env vars, config file later |
| 6 | **Optional web viewer** | Add `al-profile serve` for local browser viz? | Phase 7+ — nice to have, not core |
| 7 | **Publish scope** | `al-profile-analyzer` or `@sshadows/al-profile-analyzer` | Unscoped for easier npx |
| 8 | **tree-sitter-al completeness** | Is the grammar complete enough for all needed queries? | Test early in Phase 2 |
