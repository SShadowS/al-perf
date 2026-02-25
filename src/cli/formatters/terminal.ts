import chalk from "chalk";
import Table from "cli-table3";
import type { AnalysisResult, ComparisonResult, MethodDelta } from "../../output/types.js";
import type { MethodBreakdown, AppBreakdown } from "../../types/aggregated.js";
import type { DetectedPattern } from "../../types/patterns.js";

/**
 * Format microseconds into a human-readable time string.
 * >=1M -> seconds, >=1K -> ms, else microseconds
 */
export function formatTime(us: number): string {
  const abs = Math.abs(us);
  if (abs >= 1_000_000) {
    return `${(us / 1_000_000).toFixed(1)}s`;
  }
  if (abs >= 1_000) {
    return `${(us / 1_000).toFixed(1)}ms`;
  }
  return `${Math.round(us)}\u00b5s`;
}

/**
 * Build a simple bar chart string using filled/empty blocks.
 */
function bar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

/**
 * Format severity with appropriate color and icon.
 */
function formatSeverity(severity: "critical" | "warning" | "info"): string {
  switch (severity) {
    case "critical":
      return chalk.red("\u2716 CRITICAL");
    case "warning":
      return chalk.yellow("\u26A0 WARNING");
    case "info":
      return chalk.blue("\u2139 INFO");
  }
}

/**
 * Format a single analysis result for terminal display.
 */
export function formatAnalysisTerminal(result: AnalysisResult): string {
  const lines: string[] = [];

  // 1. Header
  lines.push("");
  lines.push(chalk.bold.cyan(`\u2500\u2500 AL Profile Analysis \u2014 ${result.meta.profilePath} \u2500\u2500`));
  lines.push("");

  // 2. Summary
  lines.push(chalk.bold("Summary"));
  lines.push(`  ${result.summary.oneLiner}`);
  lines.push(`  Type: ${result.meta.profileType} | Nodes: ${result.meta.totalNodes} nodes | Max Depth: ${result.meta.maxDepth}`);
  if (result.meta.samplingInterval !== undefined) {
    lines.push(`  Sampling Interval: ${formatTime(result.meta.samplingInterval)}`);
  }
  lines.push("");

  // 3. Top Hotspots
  if (result.hotspots.length > 0) {
    lines.push(chalk.bold("Top Hotspots"));

    const hotspotsTable = new Table({
      head: [
        chalk.gray("#"),
        chalk.gray("Function"),
        chalk.gray("Object"),
        chalk.gray("App"),
        chalk.gray("Self Time"),
        chalk.gray("Total Time"),
        chalk.gray("Hits"),
        chalk.gray("Called By"),
      ],
      style: { head: [], border: [] },
    });

    result.hotspots.forEach((h: MethodBreakdown, i: number) => {
      hotspotsTable.push([
        String(i + 1),
        chalk.white.bold(h.functionName),
        `${h.objectType} ${h.objectId} (${h.objectName})`,
        h.appName,
        `${formatTime(h.selfTime)} (${h.selfTimePercent.toFixed(1)}%)`,
        `${formatTime(h.totalTime)} (${h.totalTimePercent.toFixed(1)}%)`,
        String(h.hitCount),
        h.calledBy.length > 0 ? h.calledBy.slice(0, 3).join(", ") : "-",
      ]);
    });

    lines.push(hotspotsTable.toString());
    lines.push("");
  }

  // 4. Detected Patterns
  if (result.patterns.length > 0) {
    lines.push(chalk.bold("Detected Patterns"));
    lines.push("");

    for (const p of result.patterns) {
      lines.push(`  ${formatSeverity(p.severity)}  ${chalk.bold(p.title)}`);
      lines.push(`    ${p.description}`);
      lines.push(`    Impact: ${formatTime(p.impact)}`);
      lines.push("");
    }
  }

  // 5. App Breakdown
  if (result.appBreakdown.length > 0) {
    lines.push(chalk.bold("App Breakdown"));
    lines.push("");

    for (const app of result.appBreakdown) {
      const pct = app.selfTimePercent.toFixed(1);
      lines.push(`  ${bar(app.selfTimePercent)} ${pct.padStart(5)}%  ${formatTime(app.selfTime).padStart(8)}  ${app.appName}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format a comparison result for terminal display.
 */
export function formatComparisonTerminal(result: ComparisonResult): string {
  const lines: string[] = [];

  // 1. Header
  lines.push("");
  lines.push(chalk.bold.cyan("\u2500\u2500 AL Profile Comparison \u2500\u2500"));
  lines.push("");
  lines.push(`  Before: ${result.meta.beforePath} (${result.meta.beforeType})`);
  lines.push(`  After:  ${result.meta.afterPath} (${result.meta.afterType})`);
  lines.push("");

  // 2. Delta summary
  const deltaSign = result.summary.deltaTime >= 0 ? "+" : "";
  const direction = result.summary.deltaTime > 0
    ? chalk.red("SLOWER")
    : result.summary.deltaTime < 0
      ? chalk.green("FASTER")
      : chalk.gray("UNCHANGED");

  lines.push(chalk.bold("Delta Summary"));
  lines.push(`  ${direction}  ${deltaSign}${formatTime(result.summary.deltaTime)} (${deltaSign}${result.summary.deltaPercent.toFixed(1)}%)`);
  lines.push(`  Before total: ${formatTime(result.summary.beforeTotalTime)}`);
  lines.push(`  After total:  ${formatTime(result.summary.afterTotalTime)}`);
  lines.push("");

  // 3. Regressions
  if (result.regressions.length > 0) {
    lines.push(chalk.bold.red("Regressions"));

    const regTable = new Table({
      head: [
        chalk.gray(""),
        chalk.gray("Function"),
        chalk.gray("Object"),
        chalk.gray("Before"),
        chalk.gray("After"),
        chalk.gray("Delta"),
      ],
      style: { head: [], border: [] },
    });

    for (const r of result.regressions) {
      regTable.push([
        chalk.red("\u2191"),
        r.functionName,
        `${r.objectType} ${r.objectId}`,
        formatTime(r.beforeSelfTime),
        formatTime(r.afterSelfTime),
        chalk.red(`+${formatTime(r.deltaSelfTime)} (+${r.deltaPercent.toFixed(1)}%)`),
      ]);
    }

    lines.push(regTable.toString());
    lines.push("");
  }

  // 4. Improvements
  if (result.improvements.length > 0) {
    lines.push(chalk.bold.green("Improvements"));

    const impTable = new Table({
      head: [
        chalk.gray(""),
        chalk.gray("Function"),
        chalk.gray("Object"),
        chalk.gray("Before"),
        chalk.gray("After"),
        chalk.gray("Delta"),
      ],
      style: { head: [], border: [] },
    });

    for (const imp of result.improvements) {
      impTable.push([
        chalk.green("\u2193"),
        imp.functionName,
        `${imp.objectType} ${imp.objectId}`,
        formatTime(imp.beforeSelfTime),
        formatTime(imp.afterSelfTime),
        chalk.green(`${formatTime(imp.deltaSelfTime)} (${imp.deltaPercent.toFixed(1)}%)`),
      ]);
    }

    lines.push(impTable.toString());
    lines.push("");
  }

  // 5. New methods
  if (result.newMethods.length > 0) {
    lines.push(chalk.bold("New Methods"));
    for (const m of result.newMethods) {
      lines.push(`  ${chalk.green("+")} ${m.functionName} (${m.objectType} ${m.objectId}) \u2014 ${formatTime(m.selfTime)}`);
    }
    lines.push("");
  }

  // 6. Removed methods
  if (result.removedMethods.length > 0) {
    lines.push(chalk.bold("Removed Methods"));
    for (const m of result.removedMethods) {
      lines.push(`  ${chalk.red("-")} ${m.functionName} (${m.objectType} ${m.objectId}) \u2014 ${formatTime(m.selfTime)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
