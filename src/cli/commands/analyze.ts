import type { Command } from "commander";
import { resolve } from "path";
import { analyzeProfile } from "../../core/analyzer.js";
import { formatAnalysis, type OutputFormat } from "../formatters/index.js";
import { explainAnalysis, type ExplainModel } from "../../explain/explainer.js";
import type { ExplainResult } from "../../explain/explainer.js";
import { deepAnalysis } from "../../explain/deep-analyzer.js";
import type { DeepExplainResult } from "../../explain/deep-analyzer.js";
import { formatCallCost } from "../../explain/api-cost.js";
import type { ApiCallCost } from "../../explain/api-cost.js";
import { findCompanionZip, extractCompanionZip } from "../../source/zip-extractor.js";
import { SourceIndexCache } from "../../source/cache.js";
import type { SourceIndex } from "../../types/source-index.js";
import type { ProcessedProfile } from "../../types/processed.js";
import { withStatus } from "../status.js";
import { initIdCounter, nextId } from "../../debug/ids.js";
import { writeCaptureToDisk } from "../../debug/writer.js";
import type { DebugCapture } from "../../debug/types.js";

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
    .option("--deep", "Enable deep AI analysis with structured findings (implies --explain, requires ANTHROPIC_API_KEY)")
    .option("--model <model>", "Model for --explain: sonnet (default) or opus", "sonnet")
    .option("--api-key <key>", "Anthropic API key (visible in process listings; prefer ANTHROPIC_API_KEY env var)")
    .option("--save-history", "Save analysis result to history store")
    .option("--history-dir <dir>", "History store directory", ".al-perf-history")
    .option("--git-commit <hash>", "Git commit hash to associate with this analysis")
    .option("--label <label>", "Label for this analysis run (e.g., 'baseline', 'after-fix')")
    .option("--debug", "Save debug capture (prompts, payloads, responses) to debug/ folder")
    .action(async (profilePath: string, opts: any) => {
      // --deep implies --explain
      if (opts.deep && !opts.explain) opts.explain = true;

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

      let processedProfile: ProcessedProfile | undefined;
      let resolvedSourceIndex: SourceIndex | undefined = sourceIndex;
      const analyzeStart = Date.now();

      const result = await withStatus("Analyzing profile...", () =>
        analyzeProfile(profilePath, {
          top: parseInt(opts.top, 10),
          threshold: parseFloat(opts.threshold) * 1000,
          appFilter: opts.appFilter?.split(",").map((s: string) => s.trim()),
          includePatterns: opts.patterns !== false,
          sourcePath: sourcePath,
          sourceIndex,
          onProcessedProfile: opts.deep ? (p: ProcessedProfile) => { processedProfile = p; } : undefined,
          onSourceIndex: opts.deep ? (idx: SourceIndex) => { resolvedSourceIndex = idx; } : undefined,
        }),
      );
      let explainResult: ExplainResult | undefined;
      let deepResult: DeepExplainResult | undefined;
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
            explainResult = await withStatus(`Generating AI explanation (Claude ${modelLabel})...`, () =>
              explainAnalysis(result, {
                apiKey,
                model: model as ExplainModel,
              }),
            );
            result.explanation = explainResult.text;
            apiCosts.push(explainResult.cost);
            console.error(`[api-cost] ${formatCallCost(explainResult.cost)}`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Warning: --explain failed: ${message}`);
          }
        }
      }

      // Run deep AI analysis if --deep is provided
      if (opts.deep) {
        const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          console.error("Warning: --deep requires an API key. Set ANTHROPIC_API_KEY or use --api-key.");
        } else if (processedProfile) {
          try {
            const model = opts.model as ExplainModel;
            const modelLabel = model === "opus" ? "Opus" : "Sonnet";
            deepResult = await withStatus(`Running deep AI analysis (Claude ${modelLabel})...`, () =>
              deepAnalysis(result, processedProfile!, {
                apiKey,
                model,
                sourceIndex: resolvedSourceIndex,
              }),
            );
            result.aiFindings = deepResult.aiFindings;
            result.aiNarrative = deepResult.aiNarrative;
            apiCosts.push(deepResult.cost);
            console.error(`[api-cost] ${formatCallCost(deepResult.cost)}`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Warning: --deep analysis failed: ${message}`);
          }
        }
      }

      if (opts.saveHistory) {
        const { HistoryStore } = await import("../../history/store.js");
        const store = new HistoryStore(opts.historyDir);
        store.save(result, { gitCommit: opts.gitCommit, label: opts.label });
      }

      process.stdout.write(formatAnalysis(result, opts.format as OutputFormat) + "\n");

      // Save debug capture if --debug is provided
      if (opts.debug) {
        const debugDir = resolve(process.cwd(), "debug");
        await initIdCounter(debugDir);

        const filePath = resolve(profilePath);
        const profileBytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());

        const capture: DebugCapture = {
          id: nextId(),
          token: crypto.randomUUID(),
          timestamp: new Date(),
          profileData: profileBytes,
          profileName: filePath.split(/[\\/]/).pop() || "profile.alcpuprofile",
          analysisResult: result,
          costs: apiCosts,
          analysisDurationMs: Date.now() - analyzeStart,
        };

        if (explainResult) {
          capture.explainCapture = {
            debugInfo: explainResult.debugInfo,
            parsedOutput: explainResult.text,
          };
        }
        if (deepResult) {
          capture.deepCapture = {
            debugInfo: deepResult.debugInfo,
            parsedOutput: { findings: deepResult.aiFindings, narrative: deepResult.aiNarrative },
          };
        }

        const folder = await writeCaptureToDisk(capture, debugDir, "developer-debug");
        console.error(`[debug] Capture saved to ${folder}`);
      }

      // Clean up temp dir if we extracted from companion zip
      if (cleanup) await cleanup();
    });
}
