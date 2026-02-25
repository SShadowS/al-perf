import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeProfile } from "../core/analyzer.js";
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

  return server;
}
