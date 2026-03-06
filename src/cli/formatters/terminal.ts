import chalk from "chalk";
import Table from "cli-table3";
import type { AnalysisResult, ComparisonResult } from "../../output/types.js";
import type { SectionRenderers } from "../../output/sections.js";
import { SECTION_ORDER } from "../../output/sections.js";
import type { MethodBreakdown } from "../../types/aggregated.js";
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

function renderSummary(result: AnalysisResult): string {
  const lines: string[] = [];
  lines.push(chalk.bold("Summary"));
  lines.push(`  ${result.summary.oneLiner}`);
  const sourceTag = result.meta.sourceAvailable ? chalk.green("source available") : chalk.gray("no source");
  lines.push(`  Type: ${result.meta.profileType} | Nodes: ${result.meta.totalNodes} nodes | Max Depth: ${result.meta.maxDepth} | ${sourceTag}`);
  if (result.meta.samplingInterval !== undefined) {
    lines.push(`  Sampling Interval: ${formatTime(result.meta.samplingInterval)}`);
  }
  if (result.meta.builtinSelfTime !== undefined && result.meta.builtinSelfTime > 0) {
    lines.push(`  Built-in overhead: ${formatTime(result.meta.builtinSelfTime)}`);
  }
  lines.push(`  Confidence: ${result.meta.confidenceScore}/100`);
  lines.push(`  Health: ${result.summary.healthScore}/100`);
  return lines.join("\n");
}

function renderHotspots(result: AnalysisResult): string {
  if (result.hotspots.length === 0) return "";

  const lines: string[] = [];
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
    const selfTimeStr = `${formatTime(h.selfTime)} (${h.selfTimePercent.toFixed(1)}%)`;
    const gapStr = h.gapTime && h.gapTime > 0 ? chalk.yellow(` +${formatTime(h.gapTime)} wait`) : "";
    const objectStr = h.sourceLocation
      ? `${h.objectType} ${h.objectId}\n${chalk.gray(h.sourceLocation.filePath + ":" + h.sourceLocation.lineStart)}`
      : `${h.objectType} ${h.objectId} (${h.objectName})`;
    hotspotsTable.push([
      String(i + 1),
      chalk.white.bold(truncateFunctionName(h.functionName, 80)),
      objectStr,
      h.appName,
      selfTimeStr + gapStr,
      `${formatTime(h.totalTime)} (${h.totalTimePercent.toFixed(1)}%)`,
      String(h.hitCount),
      h.calledBy.length > 0 ? h.calledBy.slice(0, 3).join(", ") : "-",
    ]);
  });

  lines.push(hotspotsTable.toString());
  return lines.join("\n");
}

function renderCriticalPath(result: AnalysisResult): string {
  if (!result.criticalPath || result.criticalPath.length <= 1) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("Critical Path"));
  lines.push("");
  for (const step of result.criticalPath) {
    const indent = "  ".repeat(step.depth + 1);
    const arrow = step.depth > 0 ? "\u2514\u2500 " : "";
    lines.push(`${indent}${arrow}${chalk.white.bold(step.functionName)} (${step.objectType} ${step.objectId}) \u2014 ${formatTime(step.totalTime)} (${step.totalTimePercent.toFixed(1)}%)`);
  }
  return lines.join("\n");
}

function renderPatterns(result: AnalysisResult): string {
  if (result.patterns.length === 0) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("Detected Patterns"));
  lines.push("");

  for (const p of result.patterns) {
    lines.push(`  ${formatSeverity(p.severity)}  ${chalk.bold(p.title)}`);
    lines.push(`    ${p.description}`);
    lines.push(`    Impact: ${formatTime(p.impact)}`);
    if (p.estimatedSavings && p.estimatedSavings > 0) {
      lines.push(`    Estimated savings: ${chalk.green(formatTime(p.estimatedSavings))}`);
    }
    if (p.suggestion) {
      lines.push(`    ${chalk.cyan("Suggestion:")} ${p.suggestion}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderAppBreakdown(result: AnalysisResult): string {
  if (result.appBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("App Breakdown"));
  lines.push("");

  for (const app of result.appBreakdown) {
    const pct = app.selfTimePercent.toFixed(1);
    lines.push(`  ${bar(app.selfTimePercent)} ${pct.padStart(5)}%  ${formatTime(app.selfTime).padStart(8)}  ${app.appName}`);
  }
  return lines.join("\n");
}

function renderTableBreakdown(result: AnalysisResult): string {
  if (!result.tableBreakdown || result.tableBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("Table Breakdown"));

  const tableBreakdownTable = new Table({
    head: [
      chalk.gray("Table"),
      chalk.gray("Self Time"),
      chalk.gray("Top Operation"),
      chalk.gray("Call Sites"),
      chalk.gray("SetLoadFields"),
      chalk.gray("Filtered"),
    ],
    style: { head: [], border: [] },
  });

  for (const t of result.tableBreakdown) {
    const topOp = t.operationBreakdown.length > 0
      ? `${t.operationBreakdown[0].operation} (${formatTime(t.operationBreakdown[0].selfTime)})`
      : "-";
    tableBreakdownTable.push([
      t.tableName,
      `${formatTime(t.totalSelfTime)} (${t.totalSelfTimePercent.toFixed(1)}%)`,
      topOp,
      String(t.callSiteCount),
      t.hasSetLoadFields ? chalk.green("Yes") : chalk.gray("No"),
      t.hasFilters ? chalk.green("Yes") : chalk.gray("No"),
    ]);
  }

  lines.push(tableBreakdownTable.toString());
  return lines.join("\n");
}

function renderObjectBreakdown(result: AnalysisResult): string {
  if (result.objectBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("Object Breakdown"));

  const objTable = new Table({
    head: [
      chalk.gray("Object"),
      chalk.gray("ID"),
      chalk.gray("App"),
      chalk.gray("Self Time"),
      chalk.gray("Methods"),
    ],
    style: { head: [], border: [] },
  });

  for (const obj of result.objectBreakdown) {
    objTable.push([
      `${obj.objectType} ${obj.objectName}`,
      String(obj.objectId),
      obj.appName,
      `${formatTime(obj.selfTime)} (${obj.selfTimePercent.toFixed(1)}%)`,
      String(obj.methodCount),
    ]);
    for (const m of obj.methods) {
      objTable.push([
        chalk.gray(`  ${m.functionName}`),
        "",
        "",
        chalk.gray(`${formatTime(m.selfTime)} (${m.selfTimePercent.toFixed(1)}%)`),
        chalk.gray(String(m.hitCount) + " hits"),
      ]);
    }
  }

  lines.push(objTable.toString());
  return lines.join("\n");
}

function renderExplanation(result: AnalysisResult): string {
  if (!result.explanation) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("AI Analysis"));
  lines.push(`  ${result.explanation.split("\n").join("\n  ")}`);
  return lines.join("\n");
}

function renderAiNarrative(result: AnalysisResult): string {
  if (!result.aiNarrative) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("AI Narrative"));
  lines.push(`  ${result.aiNarrative.split("\n").join("\n  ")}`);
  return lines.join("\n");
}

function renderAiFindings(result: AnalysisResult): string {
  if (!result.aiFindings || result.aiFindings.length === 0) return "";

  const lines: string[] = [];
  lines.push(chalk.bold("AI Findings"));
  lines.push("");

  for (const f of result.aiFindings) {
    lines.push(`  ${formatSeverity(f.severity)}  ${chalk.bold(f.title)}  [${f.confidence} confidence]`);
    lines.push(`    Category: ${f.category}`);
    lines.push(`    ${f.description}`);
    lines.push(`    ${chalk.cyan("Suggestion:")} ${f.suggestion}`);
    lines.push(`    Evidence: ${f.evidence}`);
    if (f.codeFix) {
      lines.push(`    Code fix:`);
      for (const line of f.codeFix.split("\n")) {
        lines.push(`      ${line}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

const terminalSections: SectionRenderers<string> = {
  summary: renderSummary,
  hotspots: renderHotspots,
  criticalPath: renderCriticalPath,
  patterns: renderPatterns,
  appBreakdown: renderAppBreakdown,
  tableBreakdown: renderTableBreakdown,
  objectBreakdown: renderObjectBreakdown,
  explanation: renderExplanation,
  aiNarrative: renderAiNarrative,
  aiFindings: renderAiFindings,
};

/**
 * Format a single analysis result for terminal display.
 */
export function formatAnalysisTerminal(result: AnalysisResult): string {
  const lines: string[] = [];

  // Header (formatter chrome, not a section)
  lines.push("");
  lines.push(chalk.bold.cyan(`\u2500\u2500 AL Profile Analysis \u2014 ${result.meta.profilePath} \u2500\u2500`));
  lines.push("");

  for (const section of SECTION_ORDER) {
    const rendered = terminalSections[section](result);
    if (rendered) {
      lines.push(rendered);
      lines.push("");
    }
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

  // 7. Pattern Deltas
  if (result.patternDeltas && result.patternDeltas.length > 0) {
    lines.push(chalk.bold("Pattern Changes"));
    lines.push("");
    for (const d of result.patternDeltas) {
      const icon = d.status === "new" ? chalk.red("+ NEW")
        : d.status === "resolved" ? chalk.green("- RESOLVED")
        : chalk.yellow("~ CHANGED");
      const severityStr = d.status === "changed"
        ? `${d.beforeSeverity} \u2192 ${d.severity}`
        : d.severity;
      lines.push(`  ${icon}  [${severityStr}] ${d.title} (${formatTime(d.impact)})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
