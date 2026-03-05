import chalk from "chalk";
import Table from "cli-table3";
import { basename } from "path";
import type { BatchAnalysisResult } from "../../output/batch-types.js";
import type { BatchSectionRenderers } from "../../output/batch-sections.js";
import { BATCH_SECTION_ORDER } from "../../output/batch-sections.js";
import { formatTime } from "../../core/analyzer.js";
import { truncateFunctionName } from "../../core/display-utils.js";

/**
 * Build a simple bar chart string using filled/empty blocks.
 */
function bar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

/**
 * Format a health score with color based on value.
 */
function colorHealth(score: number): string {
  if (score >= 80) return chalk.green(String(score));
  if (score >= 50) return chalk.yellow(String(score));
  return chalk.red(String(score));
}

/**
 * Format severity with appropriate icon.
 */
function severityIcon(severity: "critical" | "warning" | "info"): string {
  switch (severity) {
    case "critical":
      return chalk.red("\u2716");
    case "warning":
      return chalk.yellow("\u26A0");
    case "info":
      return chalk.blue("\u2139");
  }
}

function renderBatchSummary(result: BatchAnalysisResult): string {
  const lines: string[] = [];
  lines.push(chalk.bold("Batch Summary"));
  lines.push(`  ${result.summary.oneLiner}`);
  lines.push(`  Profiles: ${result.meta.profileCount}`);

  if (result.meta.timeRange) {
    lines.push(`  Time range: ${result.meta.timeRange.start} \u2014 ${result.meta.timeRange.end}`);
  }

  lines.push(`  Health: ${colorHealth(result.summary.overallHealthScore)}/100`);

  if (result.summary.worstProfile) {
    const worst = result.summary.worstProfile;
    lines.push(
      `  Worst profile: ${chalk.red(worst.description)} (health ${worst.healthScore}/100)`,
    );
  }

  const pc = result.summary.totalPatternCount;
  const patternParts: string[] = [];
  if (pc.critical > 0) patternParts.push(chalk.red(`${pc.critical} critical`));
  if (pc.warning > 0) patternParts.push(chalk.yellow(`${pc.warning} warning`));
  if (pc.info > 0) patternParts.push(chalk.blue(`${pc.info} info`));
  if (patternParts.length > 0) {
    lines.push(`  Patterns: ${patternParts.join(", ")}`);
  } else {
    lines.push(`  Patterns: ${chalk.green("none")}`);
  }

  const sourceTag = result.meta.sourceAvailable
    ? chalk.green("source available")
    : chalk.gray("no source");
  lines.push(`  ${sourceTag}`);

  return lines.join("\n");
}

function renderBatchExplanation(result: BatchAnalysisResult): string {
  if (!result.explanation) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("AI Analysis"));
  lines.push(`  ${result.explanation.split("\n").join("\n  ")}`);
  return lines.join("\n");
}

function renderActivityBreakdown(result: BatchAnalysisResult): string {
  if (result.activityBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("Activity Breakdown"));

  const table = new Table({
    head: [
      chalk.gray("Activity"),
      chalk.gray("Type"),
      chalk.gray("Duration"),
      chalk.gray("Health"),
      chalk.gray("Patterns"),
    ],
    style: { head: [], border: [] },
  });

  for (const activity of result.activityBreakdown) {
    const label = activity.metadata?.activityDescription ?? basename(activity.profilePath);
    const activityType = activity.metadata?.activityType ?? "-";
    const patternParts: string[] = [];
    if (activity.patternCount.critical > 0)
      patternParts.push(chalk.red(`${activity.patternCount.critical}C`));
    if (activity.patternCount.warning > 0)
      patternParts.push(chalk.yellow(`${activity.patternCount.warning}W`));
    if (activity.patternCount.info > 0)
      patternParts.push(chalk.blue(`${activity.patternCount.info}I`));

    const selfRefNote = activity.selfReferential ? chalk.yellow(" \u26A0 self-ref") : "";

    table.push([
      label,
      activityType,
      formatTime(activity.duration),
      colorHealth(activity.healthScore) + "/100",
      (patternParts.length > 0 ? patternParts.join(" ") : chalk.green("-")) + selfRefNote,
    ]);
  }

  lines.push(table.toString());
  return lines.join("\n");
}

function renderRecurringPatterns(result: BatchAnalysisResult): string {
  if (result.recurringPatterns.length === 0) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("Recurring Patterns"));

  const table = new Table({
    head: [
      chalk.gray("Pattern"),
      chalk.gray("Severity"),
      chalk.gray("Profiles"),
      chalk.gray("Recurrence"),
    ],
    style: { head: [], border: [] },
  });

  for (const pattern of result.recurringPatterns) {
    const icon = severityIcon(pattern.severity);
    const severityLabel = pattern.severity.toUpperCase();
    table.push([
      pattern.title,
      `${icon} ${severityLabel}`,
      `${pattern.profileCount}/${pattern.totalProfiles}`,
      `${pattern.recurrencePercent}%`,
    ]);
  }

  lines.push(table.toString());
  return lines.join("\n");
}

function renderCumulativeHotspots(result: BatchAnalysisResult): string {
  if (result.cumulativeHotspots.length === 0) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("Cumulative Hotspots"));

  const table = new Table({
    head: [
      chalk.gray("Method"),
      chalk.gray("Object"),
      chalk.gray("Cumul. Time"),
      chalk.gray("Profiles"),
      chalk.gray("Avg/Profile"),
    ],
    style: { head: [], border: [] },
  });

  for (const hotspot of result.cumulativeHotspots) {
    table.push([
      chalk.white.bold(truncateFunctionName(hotspot.functionName, 80)),
      `${hotspot.objectType} ${hotspot.objectId} (${hotspot.objectName})`,
      formatTime(hotspot.cumulativeSelfTime),
      `${hotspot.profileCount}/${result.meta.profileCount}`,
      formatTime(hotspot.avgSelfTime),
    ]);
  }

  lines.push(table.toString());
  return lines.join("\n");
}

function renderAppBreakdown(result: BatchAnalysisResult): string {
  if (result.appBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("App Breakdown"));
  lines.push("");

  for (const app of result.appBreakdown) {
    const pct = app.selfTimePercent.toFixed(1);
    lines.push(
      `  ${bar(app.selfTimePercent)} ${pct.padStart(5)}%  ${formatTime(app.selfTime).padStart(8)}  ${app.appName}`,
    );
  }
  return lines.join("\n");
}

const batchTerminalSections: BatchSectionRenderers<string> = {
  batchSummary: renderBatchSummary,
  batchExplanation: renderBatchExplanation,
  activityBreakdown: renderActivityBreakdown,
  recurringPatterns: renderRecurringPatterns,
  cumulativeHotspots: renderCumulativeHotspots,
  appBreakdown: renderAppBreakdown,
};

/**
 * Format a batch analysis result for terminal display.
 */
export function formatBatchTerminal(result: BatchAnalysisResult): string {
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(
    chalk.bold.cyan(
      `\u2500\u2500 Batch Analysis \u2014 ${result.meta.profileCount} profiles \u2500\u2500`,
    ),
  );
  lines.push("");

  for (const section of BATCH_SECTION_ORDER) {
    const rendered = batchTerminalSections[section](result);
    if (rendered) {
      lines.push(rendered);
      lines.push("");
    }
  }

  if (result.errors.length > 0) {
    lines.push(chalk.bold.red("Errors"));
    for (const err of result.errors) {
      lines.push(`  ${chalk.red("\u2716")} ${err.profilePath}: ${err.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
