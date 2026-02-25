import type { Command } from "commander";
import { analyzeProfile } from "../../core/analyzer.js";
import { formatAnalysis, type OutputFormat } from "../formatters/index.js";

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
    .action(async (profilePath: string, opts: any) => {
      const result = await analyzeProfile(profilePath, {
        top: parseInt(opts.top, 10),
        threshold: parseFloat(opts.threshold) * 1000,
        appFilter: opts.appFilter?.split(",").map((s: string) => s.trim()),
        includePatterns: opts.patterns !== false,
      });
      console.log(formatAnalysis(result, opts.format as OutputFormat));
    });
}
