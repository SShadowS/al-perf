import type { Command } from "commander";
import { compareProfiles } from "../../core/analyzer.js";
import { formatComparison, type OutputFormat } from "../formatters/index.js";
import { withStatus } from "../status.js";

export function registerCompareCommand(program: Command) {
	program
		.command("compare")
		.description("Compare two AL CPU profiles (before/after)")
		.argument("<before>", "Path to the 'before' profile")
		.argument("<after>", "Path to the 'after' profile")
		.option(
			"-f, --format <format>",
			"Output format: auto|terminal|json|markdown",
			"auto",
		)
		.option("--threshold <ms>", "Minimum delta in ms to report", "0")
		.option(
			"--before-source <path>",
			"Path to the AL workspace for the 'before' version (enables regression fusion when paired with --after-source)",
		)
		.option(
			"--after-source <path>",
			"Path to the AL workspace for the 'after' version (enables regression fusion when paired with --before-source)",
		)
		.action(async (beforePath: string, afterPath: string, opts: any) => {
			const result = await withStatus("Comparing profiles...", () =>
				compareProfiles(beforePath, afterPath, {
					threshold: parseFloat(opts.threshold) * 1000,
					beforeSource: opts.beforeSource,
					afterSource: opts.afterSource,
				}),
			);
			process.stdout.write(
				formatComparison(result, opts.format as OutputFormat) + "\n",
			);
		});
}
