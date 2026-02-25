import type { Command } from "commander";
import { compareProfiles } from "../../core/analyzer.js";
import { formatComparison, type OutputFormat } from "../formatters/index.js";

export function registerCompareCommand(program: Command) {
  program
    .command("compare")
    .description("Compare two AL CPU profiles (before/after)")
    .argument("<before>", "Path to the 'before' profile")
    .argument("<after>", "Path to the 'after' profile")
    .option("-f, --format <format>", "Output format: auto|terminal|json|markdown", "auto")
    .option("--threshold <ms>", "Minimum delta in ms to report", "0")
    .action(async (beforePath: string, afterPath: string, opts: any) => {
      const result = await compareProfiles(beforePath, afterPath, {
        threshold: parseFloat(opts.threshold) * 1000,
      });
      console.log(formatComparison(result, opts.format as OutputFormat));
    });
}
