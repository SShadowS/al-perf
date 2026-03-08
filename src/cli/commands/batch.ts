import type { Command } from "commander";
import { resolve, extname, basename } from "path";
import { readdirSync, statSync, readFileSync } from "fs";
import { analyzeBatch, type BatchOptions } from "../../core/batch-analyzer.js";
import { formatBatch, type OutputFormat } from "../formatters/index.js";
import type { ExplainModel } from "../../explain/explainer.js";
import { formatCallCost } from "../../explain/api-cost.js";
import type { ApiCallCost } from "../../explain/api-cost.js";
import type { BatchExplainResult } from "../../explain/batch-explainer.js";
import type { ProfileMetadata } from "../../types/batch.js";
import { SourceIndexCache } from "../../source/cache.js";
import type { SourceIndex } from "../../types/source-index.js";
import { withStatus } from "../status.js";
import { initIdCounter, nextId } from "../../debug/ids.js";
import { writeCaptureToDisk } from "../../debug/writer.js";
import type { DebugCapture } from "../../debug/types.js";

/**
 * Resolve a list of paths (files and directories) into a flat list of
 * .alcpuprofile file paths. Directories are scanned for matching files.
 */
function resolveProfilePaths(paths: string[]): string[] {
  const result: string[] = [];
  for (const p of paths) {
    const resolved = resolve(p);
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      // If stat fails, treat it as a file path (will fail at analysis time with a clear error)
      result.push(resolved);
      continue;
    }

    if (stat.isDirectory()) {
      const entries = readdirSync(resolved);
      for (const entry of entries) {
        if (extname(entry).toLowerCase() === ".alcpuprofile") {
          result.push(resolve(resolved, entry));
        }
      }
    } else {
      result.push(resolved);
    }
  }
  return result;
}

export function registerBatchCommand(program: Command) {
  program
    .command("batch")
    .description("Analyze multiple AL CPU profiles as a batch")
    .argument("<paths...>", "Profile files or directories containing .alcpuprofile files")
    .option("-f, --format <format>", "Output format: auto|terminal|json|markdown|html", "auto")
    .option("-n, --top <number>", "Number of top hotspots per profile", "10")
    .option("--manifest <path>", "Path to JSON manifest with profile metadata")
    .option("--app-filter <names>", "Focus on specific app(s), comma-separated")
    .option("-s, --source <path>", "Path to AL source directory (enables source correlation)")
    .option("--cache", "Cache source index for faster re-analysis")
    .option("--explain", "Append AI-generated batch analysis summary (requires ANTHROPIC_API_KEY)")
    .option("--deep", "Enable deep AI analysis (not yet supported for batch; falls back to --explain)")
    .option("--model <model>", "Model for --explain: sonnet (default) or opus", "sonnet")
    .option("--api-key <key>", "Anthropic API key (visible in process listings; prefer ANTHROPIC_API_KEY env var)")
    .option("--debug", "Save debug capture (prompts, payloads, responses) to debug/ folder")
    .action(async (paths: string[], opts: any) => {
      if (opts.deep) {
        console.error("Note: --deep is not yet supported for batch analysis. Using --explain instead.");
        opts.explain = true;
      }

      // Resolve files and directories into profile paths
      const profilePaths = resolveProfilePaths(paths);

      if (profilePaths.length === 0) {
        console.error("Error: No .alcpuprofile files found in the provided paths.");
        process.exit(1);
      }

      // Read manifest if provided
      let metadata: ProfileMetadata[] | undefined;
      if (opts.manifest) {
        try {
          const manifestContent = readFileSync(resolve(opts.manifest), "utf-8");
          metadata = JSON.parse(manifestContent);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error reading manifest: ${message}`);
          process.exit(1);
        }
      }

      // Build source index once if --source provided
      let sourceIndex: SourceIndex | undefined;
      const sourcePath = opts.source;
      if (sourcePath && opts.cache) {
        const cache = new SourceIndexCache(resolve(sourcePath, ".al-profile-cache"));
        sourceIndex = await withStatus("Building source index...", () =>
          cache.getOrBuild(sourcePath!),
        );
      }

      const batchOptions: BatchOptions = {
        metadata,
        top: parseInt(opts.top, 10),
        appFilter: opts.appFilter?.split(",").map((s: string) => s.trim()),
        sourcePath: opts.cache ? undefined : sourcePath,
        sourceIndex,
      };

      const batchStart = Date.now();

      const result = await withStatus(
        `Analyzing ${profilePaths.length} profiles...`,
        () => analyzeBatch(profilePaths, batchOptions),
      );

      let batchExplainResult: BatchExplainResult | undefined;
      const apiCosts: ApiCallCost[] = [];

      // Run LLM explanation if --explain is provided
      if (opts.explain) {
        const model = opts.model ?? "sonnet";
        if (model !== "sonnet" && model !== "opus") {
          console.error(`Error: --model must be "sonnet" or "opus", got "${model}"`);
          process.exit(1);
        }
        const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          console.error("Warning: --explain requires an API key. Set ANTHROPIC_API_KEY or use --api-key.");
        } else {
          try {
            const modelLabel = model === "opus" ? "Opus" : "Sonnet";
            const mod = await import("../../explain/batch-explainer.js");
            batchExplainResult = await withStatus(
              `Generating AI batch explanation (Claude ${modelLabel})...`,
              () => mod.explainBatchAnalysis(result, { apiKey, model: model as ExplainModel }),
            );
            result.explanation = batchExplainResult.text;
            apiCosts.push(batchExplainResult.cost);
            console.error(`[api-cost] ${formatCallCost(batchExplainResult.cost)}`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Warning: --explain failed: ${message}`);
          }
        }
      }

      // Report errors to stderr
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`Warning: Failed to analyze ${err.profilePath}: ${err.error}`);
        }
      }

      process.stdout.write(formatBatch(result, opts.format as OutputFormat) + "\n");

      // Save debug capture if --debug is provided
      if (opts.debug) {
        const debugDir = resolve(process.cwd(), "debug");
        await initIdCounter(debugDir);

        const batchProfiles = await Promise.all(
          profilePaths.map(async (p) => ({
            name: basename(p),
            data: new Uint8Array(await Bun.file(resolve(p)).arrayBuffer()),
          })),
        );

        const capture: DebugCapture = {
          id: nextId(),
          token: crypto.randomUUID(),
          timestamp: new Date(),
          profileData: batchProfiles[0].data,
          profileName: batchProfiles[0].name,
          batchProfiles,
          manifestJson: opts.manifest ? readFileSync(resolve(opts.manifest), "utf-8") : undefined,
          analysisResult: result,
          costs: apiCosts,
          analysisDurationMs: Date.now() - batchStart,
        };

        if (batchExplainResult) {
          capture.batchExplainCapture = {
            debugInfo: batchExplainResult.debugInfo,
            parsedOutput: batchExplainResult.text,
          };
        }

        const folder = await writeCaptureToDisk(capture, debugDir, "developer-debug");
        console.error(`[debug] Capture saved to ${folder}`);
      }
    });
}
