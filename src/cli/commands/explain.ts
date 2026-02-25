import { Command } from "commander";
import { parseProfile } from "../../core/parser.js";
import { processProfile } from "../../core/processor.js";
import { aggregateByMethod } from "../../core/aggregator.js";
import { formatTime } from "../../core/analyzer.js";
import { resolveFormat } from "../formatters/auto.js";
import type { MethodBreakdown } from "../../types/aggregated.js";

export interface ExplainResult {
  method: MethodBreakdown;
  profileStats: {
    selfTime: string;
    selfTimePercent: string;
    totalTime: string;
    totalTimePercent: string;
    hitCount: number;
  };
  calledBy: string[];
  calls: string[];
}

export const explainCommand = new Command("explain")
  .description("Deep dive into a specific method from a profile")
  .argument("<profile>", "Path to .alcpuprofile file")
  .argument("<method>", "Method/function name to explain")
  .option("-f, --format <format>", "Output format: auto|terminal|json|markdown", "auto")
  .option("--object-id <id>", "Object ID to disambiguate")
  .action(async (profilePath: string, methodName: string, opts) => {
    const parsed = await parseProfile(profilePath);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    let candidates = methods.filter(
      (m) => m.functionName.toLowerCase() === methodName.toLowerCase(),
    );

    if (opts.objectId) {
      const objectId = parseInt(opts.objectId, 10);
      candidates = candidates.filter((m) => m.objectId === objectId);
    }

    if (candidates.length === 0) {
      process.stderr.write(`Error: Method "${methodName}" not found in profile.\n`);
      process.exit(1);
    }

    const method = candidates.sort((a, b) => b.selfTime - a.selfTime)[0];

    const result: ExplainResult = {
      method,
      profileStats: {
        selfTime: formatTime(method.selfTime),
        selfTimePercent: `${method.selfTimePercent.toFixed(1)}%`,
        totalTime: formatTime(method.totalTime),
        totalTimePercent: `${method.totalTimePercent.toFixed(1)}%`,
        hitCount: method.hitCount,
      },
      calledBy: method.calledBy,
      calls: method.calls,
    };

    const format = resolveFormat(opts.format);

    if (format === "json") {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      const chalk = (await import("chalk")).default;
      const lines: string[] = [];
      lines.push("");
      lines.push(chalk.bold.cyan(`\u2500\u2500 Method: ${method.functionName} \u2500\u2500`));
      lines.push(`  Object: ${method.objectType} ${method.objectId} (${method.objectName})`);
      lines.push(`  App: ${method.appName}`);
      lines.push("");
      lines.push(chalk.bold("Profile Stats"));
      lines.push(`  Self Time:  ${result.profileStats.selfTime} (${result.profileStats.selfTimePercent})`);
      lines.push(`  Total Time: ${result.profileStats.totalTime} (${result.profileStats.totalTimePercent})`);
      lines.push(`  Hit Count:  ${method.hitCount}`);
      lines.push("");

      if (method.calledBy.length > 0) {
        lines.push(chalk.bold("Called By"));
        for (const caller of method.calledBy) {
          lines.push(`  \u2190 ${caller}`);
        }
        lines.push("");
      }

      if (method.calls.length > 0) {
        lines.push(chalk.bold("Calls"));
        for (const callee of method.calls) {
          lines.push(`  \u2192 ${callee}`);
        }
        lines.push("");
      }

      process.stdout.write(lines.join("\n") + "\n");
    }
  });
