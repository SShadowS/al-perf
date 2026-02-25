import type { Command } from "commander";
import { analyzeProfile } from "../../core/analyzer.js";
import { formatAnalysis, type OutputFormat } from "../formatters/index.js";
import { findCompanionZip, extractCompanionZip } from "../../source/zip-extractor.js";

export function registerAnalyzeCommand(program: Command) {
  program
    .command("analyze")
    .description("Full analysis of an AL CPU profile")
    .argument("<profile>", "Path to .alcpuprofile file")
    .option("-f, --format <format>", "Output format: auto|terminal|json", "auto")
    .option("-n, --top <number>", "Number of top hotspots", "10")
    .option("--threshold <ms>", "Minimum selfTime in ms to report", "0")
    .option("--app-filter <names>", "Focus on specific app(s), comma-separated")
    .option("--no-patterns", "Skip pattern detection")
    .option("-s, --source <path>", "Path to AL source directory (enables source correlation)")
    .action(async (profilePath: string, opts: any) => {
      // Resolve source path: explicit --source, or auto-detect companion zip
      let sourcePath: string | undefined = opts.source;
      let cleanup: (() => Promise<void>) | undefined;

      if (!sourcePath) {
        const zipPath = findCompanionZip(profilePath);
        if (zipPath) {
          const extracted = await extractCompanionZip(zipPath);
          sourcePath = extracted.extractDir;
          cleanup = extracted.cleanup;
        }
      }

      const result = await analyzeProfile(profilePath, {
        top: parseInt(opts.top, 10),
        threshold: parseFloat(opts.threshold) * 1000,
        appFilter: opts.appFilter?.split(",").map((s: string) => s.trim()),
        includePatterns: opts.patterns !== false,
        sourcePath,
      });
      console.log(formatAnalysis(result, opts.format as OutputFormat));

      // Clean up temp dir if we extracted from companion zip
      if (cleanup) await cleanup();
    });
}
