import type { Command } from "commander";
import { analyzeProfile } from "../../core/analyzer.js";
import { formatAnalysis, type OutputFormat } from "../formatters/index.js";

export function registerHotspotsCommand(program: Command) {
  program
    .command("hotspots")
    .description("Quick hotspot summary from an AL CPU profile")
    .argument("<profile>", "Path to .alcpuprofile file")
    .option("-f, --format <format>", "Output format: auto|terminal|json|markdown", "auto")
    .option("-n, --top <number>", "Number of hotspots", "5")
    .action(async (profilePath: string, opts: any) => {
      const result = await analyzeProfile(profilePath, {
        top: parseInt(opts.top, 10),
        includePatterns: false,
      });
      console.log(formatAnalysis(result, opts.format as OutputFormat));
    });
}
