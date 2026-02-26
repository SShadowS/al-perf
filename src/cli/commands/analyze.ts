import type { Command } from "commander";
import { resolve } from "path";
import { analyzeProfile } from "../../core/analyzer.js";
import { formatAnalysis, type OutputFormat } from "../formatters/index.js";
import { explainAnalysis, type ExplainModel } from "../../explain/explainer.js";
import { findCompanionZip, extractCompanionZip } from "../../source/zip-extractor.js";
import { SourceIndexCache } from "../../source/cache.js";
import type { SourceIndex } from "../../types/source-index.js";
import { withStatus } from "../status.js";

export function registerAnalyzeCommand(program: Command) {
  program
    .command("analyze")
    .description("Full analysis of an AL CPU profile")
    .argument("<profile>", "Path to .alcpuprofile file")
    .option("-f, --format <format>", "Output format: auto|terminal|json|markdown", "auto")
    .option("-n, --top <number>", "Number of top hotspots", "10")
    .option("--threshold <ms>", "Minimum selfTime in ms to report", "0")
    .option("--app-filter <names>", "Focus on specific app(s), comma-separated")
    .option("--no-patterns", "Skip pattern detection")
    .option("-s, --source <path>", "Path to AL source directory (enables source correlation)")
    .option("--cache", "Cache source index for faster re-analysis")
    .option("--explain", "Append AI-generated analysis summary (requires ANTHROPIC_API_KEY)")
    .option("--model <model>", "Model for --explain: sonnet (default) or opus", "sonnet")
    .option("--api-key <key>", "Anthropic API key (default: ANTHROPIC_API_KEY env var)")
    .action(async (profilePath: string, opts: any) => {
      // Resolve source path: explicit --source, or auto-detect companion zip
      let sourcePath: string | undefined = opts.source;
      let cleanup: (() => Promise<void>) | undefined;

      if (!sourcePath) {
        const zipPath = findCompanionZip(profilePath);
        if (zipPath) {
          const extracted = await withStatus("Extracting companion source archive...", () =>
            extractCompanionZip(zipPath),
          );
          sourcePath = extracted.extractDir;
          cleanup = extracted.cleanup;
        }
      }

      // Build source index via cache when --cache is provided
      let sourceIndex: SourceIndex | undefined;
      if (sourcePath && opts.cache) {
        const cache = new SourceIndexCache(resolve(sourcePath, ".al-profile-cache"));
        sourceIndex = await withStatus("Building source index...", () =>
          cache.getOrBuild(sourcePath!),
        );
      }

      const result = await withStatus("Analyzing profile...", () =>
        analyzeProfile(profilePath, {
          top: parseInt(opts.top, 10),
          threshold: parseFloat(opts.threshold) * 1000,
          appFilter: opts.appFilter?.split(",").map((s: string) => s.trim()),
          includePatterns: opts.patterns !== false,
          sourcePath: opts.cache ? undefined : sourcePath,
          sourceIndex,
        }),
      );
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
            result.explanation = await withStatus(`Generating AI explanation (Claude ${modelLabel})...`, () =>
              explainAnalysis(result, {
                apiKey,
                model: model as ExplainModel,
              }),
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Warning: --explain failed: ${message}`);
          }
        }
      }

      console.log(formatAnalysis(result, opts.format as OutputFormat));

      // Clean up temp dir if we extracted from companion zip
      if (cleanup) await cleanup();
    });
}
