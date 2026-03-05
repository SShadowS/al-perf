import { basename } from "path";
import type { BatchAnalysisResult } from "../../output/batch-types.js";
import type { BatchSectionRenderers } from "../../output/batch-sections.js";
import { BATCH_SECTION_ORDER } from "../../output/batch-sections.js";
import { formatTime } from "../../core/analyzer.js";

function renderBatchSummary(result: BatchAnalysisResult): string {
  const lines: string[] = [];
  lines.push("# Batch Analysis");
  lines.push("");
  lines.push(result.summary.oneLiner);
  lines.push("");

  lines.push("| Property | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Profiles | ${result.meta.profileCount} |`);

  if (result.meta.timeRange) {
    lines.push(`| Time Range | ${result.meta.timeRange.start} — ${result.meta.timeRange.end} |`);
  }

  lines.push(`| Health | ${result.summary.overallHealthScore}/100 |`);

  if (result.summary.worstProfile) {
    const worst = result.summary.worstProfile;
    lines.push(`| Worst Profile | ${worst.description} (health ${worst.healthScore}/100) |`);
  }

  const pc = result.summary.totalPatternCount;
  lines.push(`| Patterns | ${pc.critical} critical, ${pc.warning} warning, ${pc.info} info |`);

  return lines.join("\n");
}

function renderBatchExplanation(result: BatchAnalysisResult): string {
  if (!result.explanation) return "";

  const lines: string[] = [];
  lines.push("## AI Analysis");
  lines.push("");
  lines.push(result.explanation);
  return lines.join("\n");
}

function renderActivityBreakdown(result: BatchAnalysisResult): string {
  if (result.activityBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Activity Breakdown");
  lines.push("");
  lines.push("| Activity | Type | Duration | Health | Patterns |");
  lines.push("| --- | --- | --- | --- | --- |");

  for (const activity of result.activityBreakdown) {
    const label = activity.metadata?.activityDescription ?? basename(activity.profilePath);
    const activityType = activity.metadata?.activityType ?? "-";
    const patternParts: string[] = [];
    if (activity.patternCount.critical > 0) patternParts.push(`${activity.patternCount.critical}C`);
    if (activity.patternCount.warning > 0) patternParts.push(`${activity.patternCount.warning}W`);
    if (activity.patternCount.info > 0) patternParts.push(`${activity.patternCount.info}I`);

    lines.push(
      `| ${label} | ${activityType} | ${formatTime(activity.duration)} | ${activity.healthScore}/100 | ${patternParts.length > 0 ? patternParts.join(" ") : "-"} |`,
    );
  }

  return lines.join("\n");
}

function renderRecurringPatterns(result: BatchAnalysisResult): string {
  if (result.recurringPatterns.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Recurring Patterns");
  lines.push("");
  lines.push("| Pattern | Severity | Profiles | Recurrence |");
  lines.push("| --- | --- | --- | --- |");

  for (const pattern of result.recurringPatterns) {
    lines.push(
      `| ${pattern.title} | ${pattern.severity.toUpperCase()} | ${pattern.profileCount}/${pattern.totalProfiles} | ${pattern.recurrencePercent}% |`,
    );
  }

  return lines.join("\n");
}

function renderCumulativeHotspots(result: BatchAnalysisResult): string {
  if (result.cumulativeHotspots.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Cumulative Hotspots");
  lines.push("");
  lines.push("| Method | Object | Cumul. Time | Profiles | Avg/Profile |");
  lines.push("| --- | --- | --- | --- | --- |");

  for (const hotspot of result.cumulativeHotspots) {
    lines.push(
      `| **${hotspot.functionName}** | ${hotspot.objectType} ${hotspot.objectId} (${hotspot.objectName}) | ${formatTime(hotspot.cumulativeSelfTime)} | ${hotspot.profileCount}/${result.meta.profileCount} | ${formatTime(hotspot.avgSelfTime)} |`,
    );
  }

  return lines.join("\n");
}

function renderAppBreakdown(result: BatchAnalysisResult): string {
  if (result.appBreakdown.length === 0) return "";

  const lines: string[] = [];
  lines.push("## App Breakdown");
  lines.push("");
  lines.push("| App | Self Time | % of Total |");
  lines.push("| --- | --- | --- |");

  for (const app of result.appBreakdown) {
    lines.push(`| ${app.appName} | ${formatTime(app.selfTime)} | ${app.selfTimePercent.toFixed(1)}% |`);
  }

  return lines.join("\n");
}

const batchMarkdownSections: BatchSectionRenderers<string> = {
  batchSummary: renderBatchSummary,
  batchExplanation: renderBatchExplanation,
  activityBreakdown: renderActivityBreakdown,
  recurringPatterns: renderRecurringPatterns,
  cumulativeHotspots: renderCumulativeHotspots,
  appBreakdown: renderAppBreakdown,
};

/**
 * Format a batch analysis result as markdown.
 */
export function formatBatchMarkdown(result: BatchAnalysisResult): string {
  const lines: string[] = [];

  for (const section of BATCH_SECTION_ORDER) {
    const rendered = batchMarkdownSections[section](result);
    if (rendered) {
      lines.push(rendered);
      lines.push("");
    }
  }

  if (result.errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const err of result.errors) {
      lines.push(`- **${err.profilePath}**: ${err.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
