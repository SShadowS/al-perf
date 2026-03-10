import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeProfile, compareProfiles, formatTime } from "../core/analyzer.js";
import { analyzeBatch } from "../core/batch-analyzer.js";
import { drilldownMethod } from "../core/drilldown.js";
import { parseProfile } from "../core/parser.js";
import { processProfile } from "../core/processor.js";
import { aggregateByMethod } from "../core/aggregator.js";
import { buildSourceIndex } from "../source/indexer.js";
import { runSourceOnlyDetectors } from "../source/source-only-patterns.js";
import { findCompanionZip, extractCompanionZip } from "../source/zip-extractor.js";
import { deepAnalysis } from "../explain/deep-analyzer.js";
import { HistoryStore } from "../history/store.js";
import type { AnalysisResult } from "../output/types.js";
import type { ProcessedProfile } from "../types/processed.js";
import type { SourceIndex } from "../types/source-index.js";
import type { ProfileMetadata } from "../types/batch.js";
import pkg from "../../package.json";

export interface McpServerOptions {
  defaultSourcePath?: string;
  historyDir?: string;
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const server = new McpServer({
    name: "al-profiler",
    version: pkg.version,
  });

  let lastAnalysis: AnalysisResult | null = null;

  server.registerTool(
    "analyze_profile",
    {
      title: "Analyze AL Profile",
      description: "Full analysis of a Business Central .alcpuprofile file. Returns hotspots, detected patterns (N+1 queries, heavy loops, etc.), app/object breakdowns, and a one-liner summary. If a companion .zip with AL source files exists alongside the profile, source correlation is enabled automatically.",
      inputSchema: {
        profilePath: z.string().describe("Path to the .alcpuprofile file"),
        sourcePath: z.string().optional().describe("Path to AL source directory (overrides auto-detection and server default)"),
        top: z.number().int().min(1).max(100).default(10).describe("Number of top hotspots to return"),
        appFilter: z.string().optional().describe("Comma-separated app names to focus on"),
      },
    },
    async ({ profilePath, sourcePath, top, appFilter }) => {
      try {
        let resolvedSourcePath = sourcePath ?? options?.defaultSourcePath;
        let cleanup: (() => Promise<void>) | undefined;

        if (!resolvedSourcePath) {
          const zipPath = findCompanionZip(profilePath);
          if (zipPath) {
            const extracted = await extractCompanionZip(zipPath);
            resolvedSourcePath = extracted.extractDir;
            cleanup = extracted.cleanup;
          }
        }

        let processedProfile: ProcessedProfile | undefined;
        let sourceIndex: SourceIndex | undefined;

        const result = await analyzeProfile(profilePath, {
          top,
          appFilter: appFilter?.split(",").map((s) => s.trim()),
          includePatterns: true,
          sourcePath: resolvedSourcePath,
          onProcessedProfile: (p) => { processedProfile = p; },
          onSourceIndex: (idx) => { sourceIndex = idx; },
        });

        // Deep AI analysis (when API key is available)
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (apiKey && processedProfile) {
          try {
            const deepResult = await deepAnalysis(result, processedProfile, {
              apiKey,
              sourceIndex,
            });
            result.aiFindings = deepResult.aiFindings;
            result.aiNarrative = deepResult.aiNarrative;
          } catch {
            // Non-fatal — analysis still returns without deep findings
          }
        }

        lastAnalysis = result;
        // Safe to cleanup before return: result is fully materialized in memory (no lazy refs to temp dir)
        if (cleanup) await cleanup();

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- analyze_batch ---
  server.registerTool(
    "analyze_batch",
    {
      title: "Analyze Profile Batch",
      description: "Analyze multiple AL CPU profiles and produce an aggregate report with recurring patterns, cumulative hotspots, and per-activity breakdown. Useful for analyzing scheduled profiler output.",
      inputSchema: {
        profilePaths: z.array(z.string()).describe("Paths to .alcpuprofile files, or a single directory path"),
        sourcePath: z.string().optional().describe("Path to AL source directory (overrides auto-detection and server default)"),
        manifestPath: z.string().optional().describe("Path to manifest.json with ProfileMetadata[]"),
        top: z.number().int().min(1).max(100).default(10).describe("Number of top hotspots per profile"),
        appFilter: z.string().optional().describe("Comma-separated app names to focus on"),
      },
    },
    async ({ profilePaths, sourcePath, manifestPath, top, appFilter }) => {
      try {
        const { readdirSync, statSync } = await import("fs");
        const { join } = await import("path");

        // Expand directory paths to .alcpuprofile files
        const resolvedPaths: string[] = [];
        for (const p of profilePaths) {
          try {
            const stat = statSync(p);
            if (stat.isDirectory()) {
              const files = readdirSync(p)
                .filter((f) => f.endsWith(".alcpuprofile"))
                .map((f) => join(p, f));
              resolvedPaths.push(...files);
            } else {
              resolvedPaths.push(p);
            }
          } catch {
            // Path doesn't exist — pass through for analysis-time error handling
            resolvedPaths.push(p);
          }
        }

        if (resolvedPaths.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Error: No .alcpuprofile files found in the provided paths." }],
            isError: true,
          };
        }

        // Read manifest if provided
        let metadata: ProfileMetadata[] | undefined;
        if (manifestPath) {
          const manifestContent = await Bun.file(manifestPath).text();
          metadata = JSON.parse(manifestContent) as ProfileMetadata[];
        }

        const resolvedSourcePath = sourcePath ?? options?.defaultSourcePath;

        const result = await analyzeBatch(resolvedPaths, {
          metadata,
          sourcePath: resolvedSourcePath,
          top,
          appFilter: appFilter?.split(",").map((s) => s.trim()),
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- get_hotspots ---
  server.registerTool(
    "get_hotspots",
    {
      title: "Get Hotspots",
      description: "Quick top-N hotspot summary from an AL CPU profile. Lighter than analyze_profile — skips pattern detection. Use this for a fast overview of where time is spent.",
      inputSchema: {
        profilePath: z.string().describe("Path to the .alcpuprofile file"),
        top: z.number().int().min(1).max(100).default(5).describe("Number of top hotspots to return"),
      },
    },
    async ({ profilePath, top }) => {
      try {
        const result = await analyzeProfile(profilePath, {
          top,
          includePatterns: false,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- compare_profiles ---
  server.registerTool(
    "compare_profiles",
    {
      title: "Compare Profiles",
      description: "Compare two AL CPU profiles (before/after) to find regressions and improvements. Returns methods that got slower, faster, appeared, or disappeared between the two runs.",
      inputSchema: {
        beforePath: z.string().describe("Path to the 'before' .alcpuprofile file"),
        afterPath: z.string().describe("Path to the 'after' .alcpuprofile file"),
        threshold: z.number().default(0).describe("Minimum delta in microseconds to report (default: 0)"),
      },
    },
    async ({ beforePath, afterPath, threshold }) => {
      try {
        const result = await compareProfiles(beforePath, afterPath, { threshold });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- explain_method ---
  server.registerTool(
    "explain_method",
    {
      title: "Explain Method",
      description: "Deep dive into a specific method from an AL CPU profile. Shows self time, total time, hit count, callers, and callees. Use objectId to disambiguate if multiple objects have the same method name.",
      inputSchema: {
        profilePath: z.string().describe("Path to the .alcpuprofile file"),
        method: z.string().describe("Method/function name to explain"),
        objectId: z.number().int().optional().describe("Object ID to disambiguate when multiple objects have the same method"),
      },
    },
    async ({ profilePath, method, objectId }) => {
      try {
        const parsed = await parseProfile(profilePath);
        const processed = processProfile(parsed);
        const methods = aggregateByMethod(processed);

        let candidates = methods.filter(
          (m) => m.functionName.toLowerCase() === method.toLowerCase(),
        );

        if (objectId !== undefined) {
          candidates = candidates.filter((m) => m.objectId === objectId);
        }

        if (candidates.length === 0) {
          return {
            content: [{ type: "text" as const, text: `Error: Method "${method}" not found in profile.` }],
            isError: true,
          };
        }

        const target = candidates.sort((a, b) => b.selfTime - a.selfTime)[0];

        const result = {
          method: target,
          profileStats: {
            selfTime: formatTime(target.selfTime),
            selfTimePercent: `${target.selfTimePercent.toFixed(1)}%`,
            totalTime: formatTime(target.totalTime),
            totalTimePercent: `${target.totalTimePercent.toFixed(1)}%`,
            hitCount: target.hitCount,
          },
          calledBy: target.calledBy,
          calls: target.calls,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- analyze_source ---
  server.registerTool(
    "analyze_source",
    {
      title: "Analyze AL Source",
      description: "Analyze AL source files for structural patterns without needing a profile. Parses .al files with tree-sitter, identifies objects, procedures, triggers, loops, and record operations. Reports structural findings like record operations inside loops (potential N+1 queries).",
      inputSchema: {
        sourcePath: z.string().describe("Path to directory containing .al source files"),
      },
    },
    async ({ sourcePath }) => {
      try {
        const index = await buildSourceIndex(sourcePath);

        const objects = Array.from(index.objects.values()).map((obj) => ({
          objectType: obj.objectType,
          objectName: obj.objectName,
          objectId: obj.objectId,
          file: obj.file.relativePath,
          procedures: obj.procedures.map((p) => ({
            name: p.name,
            lineStart: p.lineStart,
            lineEnd: p.lineEnd,
            loopCount: p.features.loops.length,
            recordOpCount: p.features.recordOps.length,
            recordOpsInLoopCount: p.features.recordOpsInLoops.length,
            nestingDepth: p.features.nestingDepth,
          })),
          triggers: obj.triggers.map((t) => ({
            name: t.name,
            lineStart: t.lineStart,
            lineEnd: t.lineEnd,
            loopCount: t.features.loops.length,
            recordOpCount: t.features.recordOps.length,
            recordOpsInLoopCount: t.features.recordOpsInLoops.length,
            nestingDepth: t.features.nestingDepth,
          })),
        }));

        const findings: Array<{
          severity: string;
          objectType: string;
          objectName: string;
          objectId: number;
          procedure: string;
          finding: string;
          file: string;
          line: number;
        }> = [];

        for (const obj of index.objects.values()) {
          const allMembers = [...obj.procedures, ...obj.triggers];
          for (const member of allMembers) {
            for (const op of member.features.recordOpsInLoops) {
              findings.push({
                severity: op.type === "CalcFields" || op.type === "Modify" ? "warning" : "info",
                objectType: obj.objectType,
                objectName: obj.objectName,
                objectId: obj.objectId,
                procedure: member.name,
                finding: `${op.type}() on ${op.recordVariable ?? "Record"} inside a loop`,
                file: member.file,
                line: op.line,
              });
            }
          }
        }

        const detectedPatterns = runSourceOnlyDetectors(index);

        const result = {
          files: index.files.length,
          objects,
          findings,
          detectedPatterns,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- gate_check ---
  server.registerTool(
    "gate_check",
    {
      title: "Quality Gate Check",
      description: "CI/CD quality gate — checks if a profile exceeds pattern thresholds. Returns pass/fail verdict with pattern counts. Use this to validate that a profile meets quality standards before deployment.",
      inputSchema: {
        profilePath: z.string().describe("Path to the .alcpuprofile file"),
        sourcePath: z.string().optional().describe("Path to AL source directory"),
        maxCritical: z.number().int().min(0).default(0).describe("Max critical patterns before failing (default: 0)"),
        maxWarning: z.number().int().min(0).optional().describe("Max warning patterns before failing (default: unlimited)"),
      },
    },
    async ({ profilePath, sourcePath, maxCritical, maxWarning }) => {
      try {
        let resolvedSourcePath = sourcePath ?? options?.defaultSourcePath;
        let cleanup: (() => Promise<void>) | undefined;

        if (!resolvedSourcePath) {
          const zipPath = findCompanionZip(profilePath);
          if (zipPath) {
            const extracted = await extractCompanionZip(zipPath);
            resolvedSourcePath = extracted.extractDir;
            cleanup = extracted.cleanup;
          }
        }

        const analysis = await analyzeProfile(profilePath, {
          includePatterns: true,
          sourcePath: resolvedSourcePath,
        });

        if (cleanup) await cleanup();

        const counts = { critical: 0, warning: 0, info: 0 };
        for (const p of analysis.patterns) {
          counts[p.severity]++;
        }

        const violations: string[] = [];
        if (counts.critical > maxCritical) {
          violations.push(`critical: ${counts.critical} > ${maxCritical}`);
        }
        if (maxWarning !== undefined && counts.warning > maxWarning) {
          violations.push(`warning: ${counts.warning} > ${maxWarning}`);
        }

        const verdict = violations.length === 0 ? "pass" : "fail";

        const result = {
          verdict,
          profilePath,
          counts,
          thresholds: { maxCritical, maxWarning: maxWarning ?? null },
          violations,
          patterns: analysis.patterns.map((p) => ({
            severity: p.severity,
            title: p.title,
            impact: p.impact,
            suggestion: p.suggestion,
          })),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- drilldown_method ---
  server.registerTool(
    "drilldown_method",
    {
      title: "Drill Down Method",
      description: "Deep dive into a specific method from an AL CPU profile. Shows how its totalTime is distributed across its own selfTime and child method contributions. Use objectId to disambiguate if multiple objects have the same method name.",
      inputSchema: {
        profilePath: z.string().describe("Path to the .alcpuprofile file"),
        method: z.string().describe("Method/function name to drill down into"),
        objectId: z.number().int().optional().describe("Object ID to disambiguate when multiple objects have the same method"),
      },
    },
    async ({ profilePath, method, objectId }) => {
      try {
        const result = await drilldownMethod(profilePath, method, objectId);
        if (!result) {
          return {
            content: [{ type: "text" as const, text: `Error: Method "${method}" not found in profile.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- visualize_flamegraph ---
  server.registerTool(
    "visualize_flamegraph",
    {
      title: "Visualize Flamegraph",
      description: "Generate an interactive flamegraph SVG by sending the profile to the AL-Flamegraph service. Returns the path to the saved SVG file.",
      inputSchema: {
        profilePath: z.string().describe("Path to the .alcpuprofile file"),
        serviceUrl: z.string().default("http://localhost:5000").describe("AL-Flamegraph service URL"),
      },
    },
    async ({ profilePath, serviceUrl }) => {
      try {
        const { basename } = await import("path");
        const fileContent = await Bun.file(profilePath).arrayBuffer();
        const formData = new FormData();
        formData.append("file", new Blob([fileContent]), basename(profilePath));

        const response = await fetch(`${serviceUrl}/upload`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          return {
            content: [{ type: "text" as const, text: `Flamegraph service error: ${response.status} ${response.statusText}` }],
            isError: true,
          };
        }

        const svg = await response.text();
        const svgPath = profilePath.replace(/\.alcpuprofile$/, ".flamegraph.svg");
        await Bun.write(svgPath, svg);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ svgPath, size: svg.length }) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to connect to flamegraph service: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // --- history_list ---
  server.registerTool(
    "history_list",
    {
      title: "List Analysis History",
      description: "List past analysis history entries. Filter by profile path or label. Returns entries sorted newest-first.",
      inputSchema: {
        profilePath: z.string().optional().describe("Filter by profile path (substring match)"),
        label: z.string().optional().describe("Filter by label (exact match)"),
        limit: z.number().int().min(1).max(100).default(10).describe("Maximum number of entries to return"),
      },
    },
    async ({ profilePath, label, limit }) => {
      try {
        const store = new HistoryStore(options?.historyDir ?? ".al-perf-history");
        const entries = store.query({ profilePath, label, limit });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- history_trend ---
  server.registerTool(
    "history_trend",
    {
      title: "Analysis Trend",
      description: "Compute trend deltas between the oldest and newest history entries. Shows how selfTime, healthScore, and patternCount changed over time.",
      inputSchema: {
        profilePath: z.string().optional().describe("Filter by profile path (substring match)"),
        limit: z.number().int().min(2).max(100).default(10).describe("Number of recent entries to consider"),
      },
    },
    async ({ profilePath, limit }) => {
      try {
        const store = new HistoryStore(options?.historyDir ?? ".al-perf-history");
        const entries = store.query({ profilePath, limit });

        if (entries.length < 2) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ message: "Need at least 2 history entries to compute a trend.", entries: entries.length }) }],
          };
        }

        // entries are newest-first from query; reverse to oldest-first for trend
        const sorted = [...entries].reverse();
        const first = sorted[0];
        const last = sorted[sorted.length - 1];

        const trend = {
          entries: sorted.length,
          oldest: { id: first.id, timestamp: first.timestamp },
          newest: { id: last.id, timestamp: last.timestamp },
          deltas: {
            totalSelfTime: last.metrics.totalSelfTime - first.metrics.totalSelfTime,
            healthScore: last.metrics.healthScore - first.metrics.healthScore,
            patternCount: {
              critical: last.metrics.patternCount.critical - first.metrics.patternCount.critical,
              warning: last.metrics.patternCount.warning - first.metrics.patternCount.warning,
              info: last.metrics.patternCount.info - first.metrics.patternCount.info,
            },
          },
          series: sorted.map(e => ({
            id: e.id,
            timestamp: e.timestamp,
            totalSelfTime: e.metrics.totalSelfTime,
            healthScore: e.metrics.healthScore,
            patternCount: e.metrics.patternCount,
          })),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(trend, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Resources ---

  server.registerResource(
    "pattern-docs",
    "resource://al-profiler/pattern-docs",
    {
      title: "Pattern Documentation",
      description: "Reference documentation for all detected patterns (profile-only and source-correlated).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: PATTERN_DOCS,
        },
      ],
    }),
  );

  server.registerResource(
    "last-analysis",
    "resource://al-profiler/last-analysis",
    {
      title: "Last Analysis Result",
      description: "The most recent AnalysisResult from analyze_profile. Returns null if no analysis has been run yet.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(lastAnalysis, null, 2),
        },
      ],
    }),
  );

  return server;
}

const PATTERN_DOCS = `# AL Profile Pattern Reference

## Profile-Only Patterns (no source needed)

### Single Method Dominance
**Severity:** critical
One method consuming a disproportionate share (>50%) of total self time.
Usually indicates a tight computation loop or a method called extremely frequently.

### High Hit Count
**Severity:** warning
A method with an unusually high number of hits (samples). May indicate a frequently
invoked event subscriber or a hot inner loop.

### Deep Call Stack
**Severity:** warning
Call stack depth exceeding expected norms (>30 levels). Can indicate excessive indirection,
recursive logic, or deeply nested event chains.

### Repeated Siblings
**Severity:** critical
Multiple sibling nodes with the same call frame, suggesting the same method is called
repeatedly at the same call site — a candidate for batching or caching.

### Event Subscriber Hotspot
**Severity:** warning
An event subscriber consuming significant self time. Event subscribers are implicit
call points that are easy to overlook during performance tuning.

## Source-Correlated Patterns (require AL source)

### CalcFields in Loop
**Severity:** critical
A CalcFields() call found inside a loop body (repeat/for/foreach/while). CalcFields
performs a database round-trip per call — inside a loop this becomes an N+1 query pattern.
**Fix:** Move CalcFields before the loop, or use SetLoadFields to pre-load needed fields.

### Modify in Loop
**Severity:** critical
A Modify() call inside a loop body. Each Modify causes a database write. Inside a loop,
this can cause severe performance degradation.
**Fix:** Collect changes and apply them after the loop, or use ModifyAll if possible.

### Record Operation in Loop
**Severity:** critical
A record operation (FindSet, FindFirst, Get, etc.) inside a loop body. Each call is a
database round-trip.
**Fix:** Consider restructuring to reduce database calls inside the loop.

### Missing SetLoadFields
**Severity:** warning
Record retrieval operations (FindSet, FindFirst, etc.) without a preceding SetLoadFields
call. Without SetLoadFields, Business Central loads all fields from the database,
which can be wasteful for tables with many or large fields.
**Fix:** Add SetLoadFields before record retrieval to load only the fields you need.

### Incomplete SetLoadFields
**Severity:** critical
SetLoadFields() is called before record retrieval, but the code later accesses fields
that were not included in the SetLoadFields call. In Business Central, accessing a field
not covered by SetLoadFields returns the field's default value, which is a silent data bug.
**Fix:** Add all accessed fields to the SetLoadFields call, or remove SetLoadFields if the
field list is difficult to maintain statically.

### Unindexed Filter
**Severity:** warning
SetRange/SetFilter is called on a field that is not the leading field of any key on the
target table. This forces SQL Server to perform a table scan instead of an index seek.
**Fix:** Add a key starting with the filtered field, or restructure the query to filter
on an existing key's leading field.

## Source-Only Patterns (no profile needed)

### Nested Loops
**Severity:** warning
A loop nested inside another loop. Nested loops multiply iteration counts
and can cause severe performance degradation, especially with record operations.
**Fix:** Pre-load inner data before the outer loop, or use bulk operations.

### Unfiltered FindSet
**Severity:** warning
A FindSet/FindFirst/FindLast call without any preceding SetRange() or SetFilter()
on the same record variable. This queries all records in the table.
**Fix:** Add SetRange() or SetFilter() before record retrieval to limit the result set.

### Event Subscriber with Loops
**Severity:** info/warning
An event subscriber procedure that contains loops or record operations inside loops.
Event subscribers are implicit call points that are easy to overlook during tuning.
**Fix:** Review the subscriber for performance impact and consider batching operations.
`;
