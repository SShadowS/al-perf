import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeProfile, compareProfiles, formatTime } from "../core/analyzer.js";
import { parseProfile } from "../core/parser.js";
import { processProfile } from "../core/processor.js";
import { aggregateByMethod } from "../core/aggregator.js";
import { buildSourceIndex } from "../source/indexer.js";
import { findCompanionZip, extractCompanionZip } from "../source/zip-extractor.js";

export interface McpServerOptions {
  defaultSourcePath?: string;
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const server = new McpServer({
    name: "al-profiler",
    version: "0.1.0",
  });

  let lastAnalysis: unknown = null;

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

        const result = await analyzeProfile(profilePath, {
          top,
          appFilter: appFilter?.split(",").map((s) => s.trim()),
          includePatterns: true,
          sourcePath: resolvedSourcePath,
        });

        lastAnalysis = result;
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

        const result = {
          files: index.files.length,
          objects,
          findings,
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

  return server;
}
