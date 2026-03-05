import { basename } from "path";
import type { BatchAnalysisResult } from "../../output/batch-types.js";
import type { BatchSectionRenderers } from "../../output/batch-sections.js";
import { BATCH_SECTION_ORDER } from "../../output/batch-sections.js";
import { formatTime } from "../../core/analyzer.js";

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str: string | undefined | null): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Map severity to BC-themed color.
 */
function severityColor(severity: "critical" | "warning" | "info"): string {
  switch (severity) {
    case "critical":
      return "#EB6965";
    case "warning":
      return "#9F9700";
    case "info":
      return "#505C6D";
  }
}

/**
 * Color for health score based on value.
 */
function healthColor(score: number): string {
  if (score >= 80) return "#4CAF50";
  if (score >= 50) return "#9F9700";
  return "#EB6965";
}

function renderBatchSummary(result: BatchAnalysisResult): string {
  const pc = result.summary.totalPatternCount;
  const healthCol = healthColor(result.summary.overallHealthScore);

  const timeRangeRow = result.meta.timeRange
    ? `<tr><td>Time Range</td><td>${escapeHtml(result.meta.timeRange.start)} &mdash; ${escapeHtml(result.meta.timeRange.end)}</td></tr>`
    : "";

  const worstRow = result.summary.worstProfile
    ? `<tr><td>Worst Profile</td><td><span style="color:#EB6965">${escapeHtml(result.summary.worstProfile.description)}</span> (health ${result.summary.worstProfile.healthScore}/100)</td></tr>`
    : "";

  const sourceRow = result.meta.sourceAvailable
    ? `<tr><td>Source</td><td>source available</td></tr>`
    : `<tr><td>Source</td><td>no source</td></tr>`;

  return `<p class="summary-text">${escapeHtml(result.summary.oneLiner)}</p>
  <div class="badges">
    <span class="badge" style="background:${healthCol}">${result.summary.overallHealthScore}/100 Health</span>
    <span class="badge" style="background:#EB6965">${pc.critical} Critical</span>
    <span class="badge" style="background:#9F9700">${pc.warning} Warning</span>
    <span class="badge" style="background:#505C6D">${pc.info} Info</span>
  </div>

  <div class="section">
    <h2>Batch Details</h2>
    <table class="meta-table">
      <tr><td>Profiles</td><td>${result.meta.profileCount}</td></tr>
      ${timeRangeRow}
      <tr><td>Total Duration</td><td>${formatTime(result.meta.totalDuration)}</td></tr>
      ${worstRow}
      ${sourceRow}
    </table>
  </div>`;
}

function renderBatchExplanation(result: BatchAnalysisResult): string {
  if (!result.explanation) return "";

  return `<div class="section explanation">
    <h2>AI Analysis</h2>
    <div class="explanation-content">${escapeHtml(result.explanation).replace(/\n/g, "<br>")}</div>
  </div>`;
}

function renderActivityBreakdown(result: BatchAnalysisResult): string {
  if (result.activityBreakdown.length === 0) return "";

  const rows = result.activityBreakdown
    .map((activity) => {
      const label = activity.metadata?.activityDescription ?? basename(activity.profilePath);
      const activityType = activity.metadata?.activityType ?? "\u2014";
      const healthCol = healthColor(activity.healthScore);

      const patternParts: string[] = [];
      if (activity.patternCount.critical > 0)
        patternParts.push(`<span class="severity-badge" style="background:#EB6965">${activity.patternCount.critical}C</span>`);
      if (activity.patternCount.warning > 0)
        patternParts.push(`<span class="severity-badge" style="background:#9F9700">${activity.patternCount.warning}W</span>`);
      if (activity.patternCount.info > 0)
        patternParts.push(`<span class="severity-badge" style="background:#505C6D">${activity.patternCount.info}I</span>`);
      const patternsStr = patternParts.length > 0 ? patternParts.join(" ") : `<span style="color:#4CAF50">\u2014</span>`;

      const topHotspotStr = activity.topHotspot
        ? `<strong>Top hotspot:</strong> ${escapeHtml(activity.topHotspot.functionName)} (${escapeHtml(activity.topHotspot.objectName)}) &mdash; ${activity.topHotspot.selfTimePercent.toFixed(1)}% self time`
        : "No hotspots";

      const metaDetails = activity.metadata
        ? `<p><strong>User:</strong> ${escapeHtml(activity.metadata.userName)} &bull;
              <strong>SQL calls:</strong> ${activity.metadata.sqlCallCount} (${formatTime(activity.metadata.sqlCallDuration)}) &bull;
              <strong>HTTP calls:</strong> ${activity.metadata.httpCallCount} (${formatTime(activity.metadata.httpCallDuration)})</p>`
        : "";

      return `<tr>
        <td colspan="5" style="padding:0;border:none">
          <details>
            <summary class="activity-summary">
              <span class="activity-cell">${escapeHtml(label)}</span>
              <span class="activity-cell">${escapeHtml(activityType)}</span>
              <span class="activity-cell">${formatTime(activity.duration)}</span>
              <span class="activity-cell"><span style="color:${healthCol};font-weight:600">${activity.healthScore}/100</span></span>
              <span class="activity-cell">${patternsStr}</span>
            </summary>
            <div class="activity-detail">
              <p>${topHotspotStr}</p>
              <p><strong>Profile:</strong> ${escapeHtml(activity.profilePath)}</p>
              ${metaDetails}
            </div>
          </details>
        </td>
      </tr>`;
    })
    .join("\n");

  return `<div class="section">
    <h2>Activity Breakdown</h2>
    <table class="activity-table">
      <thead>
        <tr><th>Activity</th><th>Type</th><th>Duration</th><th>Health</th><th>Patterns</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderRecurringPatterns(result: BatchAnalysisResult): string {
  if (result.recurringPatterns.length === 0) return "";

  const grouped: Record<string, typeof result.recurringPatterns> = {
    critical: [],
    warning: [],
    info: [],
  };

  for (const p of result.recurringPatterns) {
    grouped[p.severity].push(p);
  }

  const sections: string[] = [];

  for (const severity of ["critical", "warning", "info"] as const) {
    const patterns = grouped[severity];
    if (patterns.length === 0) continue;

    const color = severityColor(severity);
    const cards = patterns
      .map((p) => {
        const barWidth = Math.round(p.recurrencePercent);
        return `<div class="pattern">
          <div class="pattern-header">
            <span class="severity-badge" style="background:${color}">${severity.toUpperCase()}</span>
            <span class="pattern-title">${escapeHtml(p.title)}</span>
            <span style="margin-left:auto;color:#505C6D;font-size:0.9em">${p.profileCount}/${p.totalProfiles} profiles</span>
          </div>
          <div class="recurrence-bar-container">
            <div class="recurrence-bar" style="width:${barWidth}%;background:${color}"></div>
            <span class="recurrence-label">${p.recurrencePercent}%</span>
          </div>
        </div>`;
      })
      .join("\n");

    sections.push(cards);
  }

  return `<div class="section">
    <h2>Recurring Patterns</h2>
    ${sections.join("\n")}
  </div>`;
}

function renderCumulativeHotspots(result: BatchAnalysisResult): string {
  if (result.cumulativeHotspots.length === 0) return "";

  const maxTime = result.cumulativeHotspots.length > 0
    ? result.cumulativeHotspots[0].cumulativeSelfTime
    : 1;

  const rows = result.cumulativeHotspots
    .map((h) => {
      const barWidth = maxTime > 0 ? Math.round((h.cumulativeSelfTime / maxTime) * 100) : 0;
      return `<tr>
        <td><strong>${escapeHtml(h.functionName)}</strong></td>
        <td>${escapeHtml(h.objectType)} ${h.objectId} (${escapeHtml(h.objectName)})</td>
        <td>
          <div class="time-bar-container">
            <div class="bar" style="width:${barWidth}%"></div>
            <span>${formatTime(h.cumulativeSelfTime)}</span>
          </div>
        </td>
        <td>${h.profileCount}/${result.meta.profileCount}</td>
        <td>${formatTime(h.avgSelfTime)}</td>
      </tr>`;
    })
    .join("\n");

  return `<div class="section">
    <h2>Cumulative Hotspots</h2>
    <table>
      <thead>
        <tr><th>Method</th><th>Object</th><th>Cumul. Time</th><th>Profiles</th><th>Avg/Profile</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderAppBreakdown(result: BatchAnalysisResult): string {
  if (result.appBreakdown.length === 0) return "";

  const rows = result.appBreakdown
    .map((app) => {
      const pct = app.selfTimePercent.toFixed(1);
      const barWidth = Math.round(app.selfTimePercent);
      return `<tr>
        <td>${escapeHtml(app.appName)}</td>
        <td>${formatTime(app.selfTime)}</td>
        <td>${pct}%</td>
        <td><div class="bar" style="width:${barWidth}%"></div></td>
      </tr>`;
    })
    .join("\n");

  return `<div class="section">
    <h2>App Breakdown</h2>
    <table>
      <thead>
        <tr><th>App</th><th>Self Time</th><th>%</th><th>Chart</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

const batchHtmlSections: BatchSectionRenderers<string> = {
  batchSummary: renderBatchSummary,
  batchExplanation: renderBatchExplanation,
  activityBreakdown: renderActivityBreakdown,
  recurringPatterns: renderRecurringPatterns,
  cumulativeHotspots: renderCumulativeHotspots,
  appBreakdown: renderAppBreakdown,
};

/**
 * Format a batch analysis result as a self-contained BC-themed HTML page.
 */
export function formatBatchHtml(result: BatchAnalysisResult): string {
  const sectionHtml = BATCH_SECTION_ORDER
    .map((section) => batchHtmlSections[section](result))
    .filter((html) => html !== "")
    .join("\n\n  ");

  const errorsHtml = result.errors.length > 0
    ? `<div class="section">
    <h2 style="color:#EB6965">Errors</h2>
    ${result.errors.map((e) => `<p style="color:#EB6965"><strong>&times;</strong> ${escapeHtml(e.profilePath)}: ${escapeHtml(e.error)}</p>`).join("\n")}
  </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Batch Analysis &mdash; ${result.meta.profileCount} profiles</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Segoe UI", sans-serif;
      font-size: 13.5pt;
      color: #212121;
      background: #FFFFFF;
      padding: 24px;
      line-height: 1.5;
    }
    h1 { color: #00B7C3; margin-bottom: 16px; font-size: 1.5em; }
    h2 { color: #00B7C3; margin: 24px 0 12px; font-size: 1.2em; border-bottom: 2px solid #00B7C3; padding-bottom: 4px; }
    .section { margin-bottom: 24px; }
    .summary-text { margin-bottom: 12px; }
    .badges { display: flex; gap: 12px; margin: 12px 0; flex-wrap: wrap; }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 4px;
      color: #fff;
      font-weight: 600;
      font-size: 0.9em;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 0.95em;
    }
    th, td {
      text-align: left;
      padding: 6px 10px;
      border-bottom: 1px solid #E0E0E0;
    }
    th { background: #F5F5F5; font-weight: 600; }
    tr:hover { background: #FAFAFA; }
    .meta-table td:first-child { font-weight: 600; width: 180px; }
    .pattern {
      border: 1px solid #E0E0E0;
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 12px;
    }
    .pattern-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .severity-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      color: #fff;
      font-weight: 700;
      font-size: 0.8em;
      text-transform: uppercase;
    }
    .pattern-title { font-weight: 600; }
    .bar { height: 14px; background: #00B7C3; border-radius: 2px; min-width: 2px; }
    .recurrence-bar-container {
      position: relative;
      background: #F5F5F5;
      border-radius: 4px;
      height: 22px;
      overflow: hidden;
    }
    .recurrence-bar {
      height: 100%;
      border-radius: 4px;
      min-width: 2px;
    }
    .recurrence-label {
      position: absolute;
      right: 8px;
      top: 2px;
      font-size: 0.85em;
      font-weight: 600;
      color: #212121;
    }
    .time-bar-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .time-bar-container .bar {
      flex-shrink: 0;
      height: 10px;
    }
    .time-bar-container span {
      white-space: nowrap;
    }
    .activity-table { border-collapse: collapse; }
    .activity-table thead th { position: sticky; top: 0; }
    .activity-summary {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
      gap: 0;
      padding: 6px 10px;
      cursor: pointer;
      list-style: none;
      border-bottom: 1px solid #E0E0E0;
    }
    .activity-summary::-webkit-details-marker { display: none; }
    .activity-summary:hover { background: #FAFAFA; }
    .activity-cell { display: flex; align-items: center; }
    .activity-detail {
      padding: 10px 16px 14px 28px;
      background: #FAFAFA;
      border-bottom: 1px solid #E0E0E0;
      font-size: 0.9em;
      color: #505C6D;
    }
    .activity-detail p { margin: 4px 0; }
    details summary { outline: none; }
    .explanation { }
    .explanation-content {
      padding: 12px 0;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <h1>Batch Analysis &mdash; ${result.meta.profileCount} profiles</h1>

  ${sectionHtml}

  ${errorsHtml}
</body>
</html>`;
}
