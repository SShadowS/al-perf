import type { AnalysisResult, ComparisonResult } from "../../output/types.js";
import type { SectionRenderers } from "../../output/sections.js";
import { SECTION_ORDER } from "../../output/sections.js";
import type { MethodBreakdown } from "../../types/aggregated.js";
import { formatTime } from "../../core/analyzer.js";

/**
 * Build a simple bar chart string using filled/empty blocks.
 */
function bar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

/**
 * Format severity as a markdown badge.
 */
function severityBadge(severity: "critical" | "warning" | "info"): string {
  switch (severity) {
    case "critical":
      return "\uD83D\uDD34 **CRITICAL**";
    case "warning":
      return "\u26A0\uFE0F **WARNING**";
    case "info":
      return "\u2139\uFE0F **INFO**";
  }
}

function renderSummary(result: AnalysisResult): string {
  const lines: string[] = [];
  lines.push("## Summary");
  lines.push("");
  lines.push(result.summary.oneLiner);
  lines.push("");

  const source = result.meta.sourceAvailable ? "source available" : "no source";
  lines.push("| Property | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Type | ${result.meta.profileType} |`);
  lines.push(`| Nodes | ${result.meta.totalNodes} |`);
  lines.push(`| Max Depth | ${result.meta.maxDepth} |`);
  lines.push(`| Source | ${source} |`);
  if (result.meta.samplingInterval !== undefined) {
    lines.push(`| Sampling Interval | ${formatTime(result.meta.samplingInterval)} |`);
  }
  if (result.meta.builtinSelfTime !== undefined && result.meta.builtinSelfTime > 0) {
    lines.push(`| Built-in Overhead | ${formatTime(result.meta.builtinSelfTime)} |`);
  }
  lines.push(`| Confidence | ${result.meta.confidenceScore}/100 |`);
  lines.push(`| Health | ${result.summary.healthScore}/100 |`);
  lines.push("");

  const pc = result.summary.patternCount;
  lines.push(`**Patterns:** ${pc.critical} critical, ${pc.warning} warning, ${pc.info} info`);
  return lines.join("\n");
}

function renderHotspots(result: AnalysisResult): string {
  if (result.hotspots.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Top Hotspots");
  lines.push("");
  lines.push("| # | Function | Object | App | Self Time | Total Time | Hits | Called By |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");

  result.hotspots.forEach((h: MethodBreakdown, i: number) => {
    const selfTimeStr = `${formatTime(h.selfTime)} (${h.selfTimePercent.toFixed(1)}%)`;
    const gapStr = h.gapTime && h.gapTime > 0 ? ` +${formatTime(h.gapTime)} wait` : "";
    const objectStr = h.sourceLocation
      ? `${h.objectType} ${h.objectId} ([${h.sourceLocation.filePath}:${h.sourceLocation.lineStart}](${h.sourceLocation.filePath}))`
      : `${h.objectType} ${h.objectId} (${h.objectName})`;
    const calledByStr = h.calledBy.length > 0 ? h.calledBy.slice(0, 3).join(", ") : "-";
    lines.push(
      `| ${i + 1} | **${h.functionName}** | ${objectStr} | ${h.appName} | ${selfTimeStr}${gapStr} | ${formatTime(h.totalTime)} (${h.totalTimePercent.toFixed(1)}%) | ${h.hitCount} | ${calledByStr} |`,
    );
  });

  return lines.join("\n");
}

function renderCriticalPath(result: AnalysisResult): string {
  if (!result.criticalPath || result.criticalPath.length <= 1) return "";

  const lines: string[] = [];
  lines.push("## Critical Path");
  lines.push("");
  for (const step of result.criticalPath) {
    const indent = "\u00A0\u00A0".repeat(step.depth);
    const arrow = step.depth > 0 ? "\u2514 " : "";
    lines.push(`${indent}${arrow}**${step.functionName}** (${step.objectType} ${step.objectId}) \u2014 ${formatTime(step.totalTime)} (${step.totalTimePercent.toFixed(1)}%)`);
  }
  return lines.join("\n");
}

function renderPatterns(result: AnalysisResult): string {
  if (result.patterns.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Detected Patterns");
  lines.push("");

  for (const p of result.patterns) {
    lines.push(`### ${severityBadge(p.severity)} ${p.title}`);
    lines.push("");
    lines.push(p.description);
    lines.push("");
    lines.push(`**Impact:** ${formatTime(p.impact)}`);
    if (p.estimatedSavings && p.estimatedSavings > 0) {
      lines.push(`**Estimated savings:** ${formatTime(p.estimatedSavings)}`);
    }
    if (p.suggestion) {
      lines.push("");
      lines.push(`**Suggestion:** ${p.suggestion}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderAppBreakdown(result: AnalysisResult): string {
  if (result.appBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push("## App Breakdown");
  lines.push("");
  lines.push("| App | Self Time | % | Chart |");
  lines.push("| --- | --- | --- | --- |");

  for (const app of result.appBreakdown) {
    const pct = app.selfTimePercent.toFixed(1);
    lines.push(`| ${app.appName} | ${formatTime(app.selfTime)} | ${pct}% | \`${bar(app.selfTimePercent)}\` |`);
  }

  return lines.join("\n");
}

function renderTableBreakdown(result: AnalysisResult): string {
  if (!result.tableBreakdown || result.tableBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Table Breakdown");
  lines.push("");
  lines.push("| Table | Self Time | Top Operation | Call Sites | SetLoadFields | Filtered |");
  lines.push("| --- | --- | --- | --- | --- | --- |");

  for (const t of result.tableBreakdown) {
    const topOp = t.operationBreakdown.length > 0
      ? `${t.operationBreakdown[0].operation} (${formatTime(t.operationBreakdown[0].selfTime)})`
      : "-";
    lines.push(
      `| ${t.tableName} | ${formatTime(t.totalSelfTime)} (${t.totalSelfTimePercent.toFixed(1)}%) | ${topOp} | ${t.callSiteCount} | ${t.hasSetLoadFields ? "Yes" : "No"} | ${t.hasFilters ? "Yes" : "No"} |`,
    );
  }

  return lines.join("\n");
}

function renderObjectBreakdown(result: AnalysisResult): string {
  if (result.objectBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Object Breakdown");
  lines.push("");

  for (const obj of result.objectBreakdown) {
    lines.push(`### ${obj.objectType} ${obj.objectName} (ID ${obj.objectId})`);
    lines.push("");
    lines.push(`**App:** ${obj.appName} | **Self Time:** ${formatTime(obj.selfTime)} (${obj.selfTimePercent.toFixed(1)}%) | **Methods:** ${obj.methodCount}`);
    lines.push("");

    if (obj.methods.length > 0) {
      lines.push("| Function | Self Time | Total Time | Hits |");
      lines.push("| --- | --- | --- | --- |");
      for (const m of obj.methods) {
        lines.push(`| ${m.functionName} | ${formatTime(m.selfTime)} (${m.selfTimePercent.toFixed(1)}%) | ${formatTime(m.totalTime)} (${m.totalTimePercent.toFixed(1)}%) | ${m.hitCount} |`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderExplanation(result: AnalysisResult): string {
  if (!result.explanation) return "";

  const lines: string[] = [];
  lines.push("## AI Analysis");
  lines.push("");
  lines.push(result.explanation);
  return lines.join("\n");
}

function renderAiNarrative(result: AnalysisResult): string {
  if (!result.aiNarrative) return "";

  const lines: string[] = [];
  lines.push("## AI Narrative");
  lines.push("");
  lines.push(result.aiNarrative);
  return lines.join("\n");
}

function renderAiFindings(result: AnalysisResult): string {
  if (!result.aiFindings || result.aiFindings.length === 0) return "";

  const lines: string[] = [];
  lines.push("## AI Findings");
  lines.push("");

  for (const f of result.aiFindings) {
    lines.push(`### ${severityBadge(f.severity)} ${f.title}`);
    lines.push("");
    lines.push(`**Confidence:** ${f.confidence} | **Category:** ${f.category}`);
    lines.push("");
    lines.push(f.description);
    lines.push("");
    lines.push(`**Suggestion:** ${f.suggestion}`);
    lines.push("");
    lines.push(`**Evidence:** ${f.evidence}`);
    if (f.codeFix) {
      lines.push("");
      lines.push("```al");
      lines.push(f.codeFix);
      lines.push("```");
    }
    lines.push("");
  }

  return lines.join("\n");
}

const markdownSections: SectionRenderers<string> = {
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
 * Format a single analysis result as markdown.
 */
export function formatAnalysisMarkdown(result: AnalysisResult): string {
  const lines: string[] = [];

  // Header (formatter chrome, not a section)
  lines.push(`# AL Profile Analysis \u2014 ${result.meta.profilePath}`);
  lines.push("");

  for (const section of SECTION_ORDER) {
    const rendered = markdownSections[section](result);
    if (rendered) {
      lines.push(rendered);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Format a comparison result as markdown.
 */
export function formatComparisonMarkdown(result: ComparisonResult): string {
  const lines: string[] = [];

  // 1. Header
  lines.push("# AL Profile Comparison");
  lines.push("");
  lines.push(`- **Before:** ${result.meta.beforePath} (${result.meta.beforeType})`);
  lines.push(`- **After:** ${result.meta.afterPath} (${result.meta.afterType})`);
  lines.push("");

  // 2. Delta Summary
  const deltaSign = result.summary.deltaTime >= 0 ? "+" : "";
  const direction = result.summary.deltaTime > 0
    ? "\uD83D\uDD34 SLOWER"
    : result.summary.deltaTime < 0
      ? "\uD83D\uDFE2 FASTER"
      : "\u26AA UNCHANGED";

  lines.push("## Delta Summary");
  lines.push("");
  lines.push(`**${direction}** ${deltaSign}${formatTime(result.summary.deltaTime)} (${deltaSign}${result.summary.deltaPercent.toFixed(1)}%)`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Before total | ${formatTime(result.summary.beforeTotalTime)} |`);
  lines.push(`| After total | ${formatTime(result.summary.afterTotalTime)} |`);
  lines.push(`| Delta | ${deltaSign}${formatTime(result.summary.deltaTime)} (${deltaSign}${result.summary.deltaPercent.toFixed(1)}%) |`);
  lines.push("");

  // 3. Regressions
  if (result.regressions.length > 0) {
    lines.push("## Regressions");
    lines.push("");
    lines.push("| Function | Object | Before | After | Delta |");
    lines.push("| --- | --- | --- | --- | --- |");

    for (const r of result.regressions) {
      lines.push(
        `| ${r.functionName} | ${r.objectType} ${r.objectId} | ${formatTime(r.beforeSelfTime)} | ${formatTime(r.afterSelfTime)} | +${formatTime(r.deltaSelfTime)} (+${r.deltaPercent.toFixed(1)}%) |`,
      );
    }

    lines.push("");
  }

  // 4. Improvements
  if (result.improvements.length > 0) {
    lines.push("## Improvements");
    lines.push("");
    lines.push("| Function | Object | Before | After | Delta |");
    lines.push("| --- | --- | --- | --- | --- |");

    for (const imp of result.improvements) {
      lines.push(
        `| ${imp.functionName} | ${imp.objectType} ${imp.objectId} | ${formatTime(imp.beforeSelfTime)} | ${formatTime(imp.afterSelfTime)} | ${formatTime(imp.deltaSelfTime)} (${imp.deltaPercent.toFixed(1)}%) |`,
      );
    }

    lines.push("");
  }

  // 5. New methods
  if (result.newMethods.length > 0) {
    lines.push("## New Methods");
    lines.push("");

    for (const m of result.newMethods) {
      lines.push(`- **${m.functionName}** (${m.objectType} ${m.objectId}) \u2014 ${formatTime(m.selfTime)}`);
    }

    lines.push("");
  }

  // 6. Removed methods
  if (result.removedMethods.length > 0) {
    lines.push("## Removed Methods");
    lines.push("");

    for (const m of result.removedMethods) {
      lines.push(`- **${m.functionName}** (${m.objectType} ${m.objectId}) \u2014 ${formatTime(m.selfTime)}`);
    }

    lines.push("");
  }

  // 7. Pattern Deltas
  if (result.patternDeltas && result.patternDeltas.length > 0) {
    lines.push("## Pattern Changes");
    lines.push("");
    lines.push("| Status | Severity | Pattern | Impact |");
    lines.push("| --- | --- | --- | --- |");
    for (const d of result.patternDeltas) {
      const statusIcon = d.status === "new" ? "+ NEW"
        : d.status === "resolved" ? "- RESOLVED"
        : "~ CHANGED";
      const severityStr = d.status === "changed"
        ? `${d.beforeSeverity} \u2192 ${d.severity}`
        : d.severity;
      lines.push(`| ${statusIcon} | ${severityStr} | ${d.title} | ${formatTime(d.impact)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
