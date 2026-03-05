// ---------------------------------------------------------------------------
// AL Profile Analyzer — Web UI
// ---------------------------------------------------------------------------

/**
 * Switch between views: dropzone, loading, results, error.
 * Hides all views and shows only the specified one.
 * Also toggles the "New Analysis" button visibility.
 */
function showView(viewId) {
  const views = ["dropzone", "loading", "results", "error"];
  for (const id of views) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle("hidden", id !== viewId);
    }
  }

  const newAnalysisBtn = document.getElementById("new-analysis");
  if (newAnalysisBtn) {
    newAnalysisBtn.classList.toggle("hidden", viewId !== "results");
  }
}

/**
 * Format microsecond timings into human-readable strings.
 */
function formatTime(us) {
  const abs = Math.abs(us);
  if (abs >= 1_000_000) return (us / 1_000_000).toFixed(1) + "s";
  if (abs >= 1_000) return (us / 1_000).toFixed(1) + "ms";
  return Math.round(us) + "\u00B5s";
}

/**
 * Escape HTML entities to prevent XSS when inserting user data via innerHTML.
 */
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render markdown to HTML using the marked library.
 * Strips raw HTML tags from input before parsing to prevent XSS
 * (e.g. from prompt injection in LLM output).
 */
function renderMarkdown(text) {
  if (typeof marked !== "undefined") {
    // Strip raw HTML before markdown parsing to prevent XSS
    const sanitized = text.replace(/<[^>]*>/g, "");
    return marked.parse(sanitized);
  }
  // Fallback if marked didn't load: escaped pre-formatted text
  const pre = document.createElement("pre");
  pre.textContent = text;
  return pre.outerHTML;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Section renderers — mirrors SECTION_ORDER from src/output/sections.ts:
//   summary, explanation, appBreakdown, tableBreakdown,
//   hotspots, criticalPath, patterns, objectBreakdown
// When adding a new section, update both this file AND src/output/sections.ts.
// ---------------------------------------------------------------------------

/**
 * Render the summary section.
 */
function renderSummary(data) {
  const section = document.getElementById("summary-section");
  if (!section) return;
  section.innerHTML = "";

  const card = document.createElement("div");
  card.className = "card";

  // One-liner headline
  const headline = document.createElement("div");
  headline.style.fontSize = "1.1rem";
  headline.style.fontWeight = "600";
  headline.style.marginBottom = "1rem";
  headline.textContent = data.summary.oneLiner;
  card.appendChild(headline);

  // Stats row
  const statsRow = document.createElement("div");
  statsRow.style.display = "flex";
  statsRow.style.flexWrap = "wrap";
  statsRow.style.gap = "1.5rem";
  statsRow.style.marginBottom = "1rem";
  statsRow.style.fontSize = "0.9rem";

  const stats = [
    { label: "Type", value: capitalize(data.meta.profileType) },
    { label: "Duration", value: formatTime(data.meta.totalDuration) },
    { label: "Nodes", value: String(data.meta.totalNodes) },
    { label: "Max Depth", value: String(data.meta.maxDepth) },
  ];
  if (data.meta.samplingInterval != null) {
    stats.push({
      label: "Sampling Interval",
      value: formatTime(data.meta.samplingInterval),
    });
  }
  if (data.meta.builtinSelfTime != null && data.meta.builtinSelfTime > 0) {
    stats.push({
      label: "Built-in Overhead",
      value: formatTime(data.meta.builtinSelfTime),
    });
  }
  stats.push({
    label: "Confidence",
    value: data.meta.confidenceScore + "/100",
  });
  stats.push({
    label: "Health",
    value: data.summary.healthScore + "/100",
  });

  for (const s of stats) {
    const stat = document.createElement("span");
    stat.className = "stat";
    const labelSpan = document.createElement("span");
    labelSpan.style.color = "var(--text-secondary)";
    labelSpan.textContent = s.label + ": ";
    const valueSpan = document.createElement("span");
    valueSpan.textContent = s.value;
    stat.appendChild(labelSpan);
    stat.appendChild(valueSpan);
    statsRow.appendChild(stat);
  }
  card.appendChild(statsRow);

  // Badges row
  const badgesRow = document.createElement("div");
  badgesRow.style.display = "flex";
  badgesRow.style.flexWrap = "wrap";
  badgesRow.style.gap = "0.5rem";
  badgesRow.style.alignItems = "center";

  // Source badge
  const srcBadge = document.createElement("span");
  if (data.meta.sourceAvailable) {
    srcBadge.className = "source-badge correlated";
    srcBadge.textContent = "Source Correlated";
  } else {
    srcBadge.className = "source-badge profile-only";
    srcBadge.textContent = "Profile Only";
  }
  badgesRow.appendChild(srcBadge);

  // Pattern count badges
  const pc = data.summary.patternCount;
  if (pc.critical > 0) {
    const b = document.createElement("span");
    b.className = "severity-badge severity-critical";
    b.textContent = pc.critical + " Critical";
    badgesRow.appendChild(b);
  }
  if (pc.warning > 0) {
    const b = document.createElement("span");
    b.className = "severity-badge severity-warning";
    b.textContent = pc.warning + " Warning";
    badgesRow.appendChild(b);
  }
  if (pc.info > 0) {
    const b = document.createElement("span");
    b.className = "severity-badge severity-info";
    b.textContent = pc.info + " Info";
    badgesRow.appendChild(b);
  }

  card.appendChild(badgesRow);
  section.appendChild(card);
}

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Render the hotspots table with sortable columns.
 */
function renderHotspots(data) {
  const section = document.getElementById("hotspots-section");
  if (!section) return;
  section.innerHTML = "";

  if (!data.hotspots || data.hotspots.length === 0) return;

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Top Hotspots";
  section.appendChild(title);

  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  // Sort state
  let sortKey = "selfTime";
  let sortAsc = false;

  const columns = [
    { label: "#", sortable: false },
    { label: "Function", sortable: false },
    { label: "Object", sortable: false },
    { label: "App", sortable: false },
    { label: "Self Time", sortable: true, key: "selfTime" },
    { label: "Total Time", sortable: true, key: "totalTime" },
    { label: "Hits", sortable: true, key: "hitCount" },
    { label: "Called By", sortable: false },
  ];

  const thElements = [];
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.label;
    if (col.sortable) {
      th.setAttribute("data-sort", col.key);
      th.style.cursor = "pointer";
      if (col.key === sortKey) {
        th.textContent = col.label + " " + (sortAsc ? "\u25B2" : "\u25BC");
      }
      th.addEventListener("click", () => {
        if (sortKey === col.key) {
          sortAsc = !sortAsc;
        } else {
          sortKey = col.key;
          sortAsc = false;
        }
        // Update header indicators
        for (const info of thElements) {
          if (info.sortable) {
            if (info.key === sortKey) {
              info.el.textContent =
                info.label + " " + (sortAsc ? "\u25B2" : "\u25BC");
            } else {
              info.el.textContent = info.label;
            }
          }
        }
        rebuildTbody();
      });
    }
    headerRow.appendChild(th);
    thElements.push({ el: th, ...col });
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  function rebuildTbody() {
    tbody.innerHTML = "";
    const sorted = [...data.hotspots].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      return sortAsc ? av - bv : bv - av;
    });
    for (let i = 0; i < sorted.length; i++) {
      const h = sorted[i];
      const tr = document.createElement("tr");

      // Rank
      const tdRank = document.createElement("td");
      tdRank.textContent = String(i + 1);
      tr.appendChild(tdRank);

      // Function name
      const tdFunc = document.createElement("td");
      tdFunc.className = "mono";
      tdFunc.textContent = h.functionName;
      tr.appendChild(tdFunc);

      // Object (with source location if available)
      const tdObj = document.createElement("td");
      if (h.sourceLocation) {
        tdObj.innerHTML =
          escapeHtml(h.objectType) + " " + h.objectId +
          '<br><span style="color:var(--text-secondary);font-size:0.85em">' +
          escapeHtml(h.sourceLocation.filePath) + ":" + h.sourceLocation.lineStart +
          "</span>";
      } else {
        tdObj.textContent =
          h.objectType + " " + h.objectId + " (" + h.objectName + ")";
      }
      tr.appendChild(tdObj);

      // App
      const tdApp = document.createElement("td");
      tdApp.textContent = h.appName;
      tr.appendChild(tdApp);

      // Self Time with bar + optional gap time
      const tdSelf = document.createElement("td");
      const gapHtml = h.gapTime && h.gapTime > 0
        ? ' <span style="color:var(--warning-color,#9F9700)">+' + escapeHtml(formatTime(h.gapTime)) + ' wait</span>'
        : "";
      tdSelf.innerHTML =
        escapeHtml(formatTime(h.selfTime)) +
        " (" +
        escapeHtml(h.selfTimePercent.toFixed(1)) +
        '%)<div class="bar-track"><div class="bar-fill" style="width:' +
        Math.min(h.selfTimePercent, 100) +
        '%"></div></div>' + gapHtml;
      tr.appendChild(tdSelf);

      // Total Time with bar
      const tdTotal = document.createElement("td");
      tdTotal.innerHTML =
        escapeHtml(formatTime(h.totalTime)) +
        " (" +
        escapeHtml(h.totalTimePercent.toFixed(1)) +
        '%)<div class="bar-track"><div class="bar-fill" style="width:' +
        Math.min(h.totalTimePercent, 100) +
        '%"></div></div>';
      tr.appendChild(tdTotal);

      // Hits
      const tdHits = document.createElement("td");
      tdHits.textContent = String(h.hitCount);
      tr.appendChild(tdHits);

      // Called By
      const tdCalledBy = document.createElement("td");
      tdCalledBy.className = "mono";
      if (h.calledBy && h.calledBy.length > 0) {
        tdCalledBy.textContent = h.calledBy.slice(0, 3).join(", ");
      } else {
        tdCalledBy.textContent = "\u2014";
      }
      tr.appendChild(tdCalledBy);

      tbody.appendChild(tr);
    }
  }

  rebuildTbody();
  wrapper.appendChild(table);
  section.appendChild(wrapper);
}

/**
 * Render the patterns section, grouped by severity.
 */
function renderCriticalPath(data) {
  const section = document.getElementById("critical-path-section");
  if (!section) return;
  section.innerHTML = "";

  const path = data.criticalPath;
  if (!path || path.length < 2) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";

  const heading = document.createElement("h2");
  heading.textContent = "Critical Path";
  section.appendChild(heading);

  const container = document.createElement("div");
  container.style.fontFamily = "monospace";
  container.style.fontSize = "0.95em";
  container.style.padding = "12px 0";

  for (const step of path) {
    const div = document.createElement("div");
    div.style.margin = "2px 0";
    const indent = "\u00A0\u00A0\u00A0\u00A0".repeat(step.depth);
    const arrow = step.depth > 0 ? "\u2514\u2500 " : "";
    div.innerHTML = `${indent}${arrow}<strong>${escapeHtml(step.functionName)}</strong> (${escapeHtml(step.objectType)} ${step.objectId}) \u2014 ${formatTime(step.totalTime)} (${step.totalTimePercent.toFixed(1)}%)`;
    container.appendChild(div);
  }

  section.appendChild(container);
}

function renderPatterns(data) {
  const section = document.getElementById("patterns-section");
  if (!section) return;
  section.innerHTML = "";

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Detected Patterns";
  section.appendChild(title);

  if (!data.patterns || data.patterns.length === 0) {
    const muted = document.createElement("div");
    muted.style.color = "var(--text-secondary)";
    muted.textContent = "No performance patterns detected";
    section.appendChild(muted);
    return;
  }

  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const severityIcon = { critical: "\u2716", warning: "\u26A0", info: "\u2139" };

  const sorted = [...data.patterns].sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
  );

  for (const p of sorted) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "0.75rem";

    // Badge + title row
    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.alignItems = "center";
    headerRow.style.gap = "0.75rem";
    headerRow.style.marginBottom = "0.5rem";

    const badge = document.createElement("span");
    badge.className = "severity-badge severity-" + p.severity;
    badge.textContent = severityIcon[p.severity] + " " + capitalize(p.severity);
    headerRow.appendChild(badge);

    const titleEl = document.createElement("strong");
    titleEl.textContent = p.title;
    headerRow.appendChild(titleEl);

    card.appendChild(headerRow);

    // Description
    const desc = document.createElement("div");
    desc.style.marginBottom = "0.5rem";
    desc.textContent = p.description;
    card.appendChild(desc);

    // Impact
    const impact = document.createElement("div");
    impact.style.fontSize = "0.9rem";
    impact.style.color = "var(--text-secondary)";
    impact.textContent = "Impact: " + formatTime(p.impact);
    card.appendChild(impact);

    // Suggestion
    if (p.suggestion) {
      const sugBox = document.createElement("div");
      sugBox.className = "suggestion-box";
      sugBox.textContent = p.suggestion;
      card.appendChild(sugBox);
    }

    section.appendChild(card);
  }
}

/**
 * Render the app breakdown section.
 */
function renderAppBreakdown(data) {
  const section = document.getElementById("app-breakdown-section");
  if (!section) return;
  section.innerHTML = "";

  if (!data.appBreakdown || data.appBreakdown.length === 0) return;

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "App Breakdown";
  section.appendChild(title);

  const sorted = [...data.appBreakdown].sort(
    (a, b) => b.selfTime - a.selfTime,
  );

  for (const app of sorted) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "1rem";
    row.style.marginBottom = "0.5rem";

    const nameEl = document.createElement("div");
    nameEl.style.minWidth = "200px";
    nameEl.style.flexShrink = "0";
    nameEl.textContent = app.appName;
    row.appendChild(nameEl);

    const barContainer = document.createElement("div");
    barContainer.style.flex = "1";
    barContainer.innerHTML =
      '<div class="bar-track"><div class="bar-fill" style="width:' +
      Math.min(app.selfTimePercent, 100) +
      '%"></div></div>';
    row.appendChild(barContainer);

    const pctEl = document.createElement("div");
    pctEl.style.minWidth = "50px";
    pctEl.style.textAlign = "right";
    pctEl.style.fontSize = "0.9rem";
    pctEl.textContent = app.selfTimePercent.toFixed(1) + "%";
    row.appendChild(pctEl);

    const timeEl = document.createElement("div");
    timeEl.style.minWidth = "80px";
    timeEl.style.textAlign = "right";
    timeEl.style.fontSize = "0.9rem";
    timeEl.style.color = "var(--text-secondary)";
    timeEl.textContent = formatTime(app.selfTime);
    row.appendChild(timeEl);

    section.appendChild(row);
  }
}

/**
 * Render the table breakdown section.
 */
function renderTableBreakdown(data) {
  const section = document.getElementById("table-breakdown-section");
  if (!section) return;
  section.innerHTML = "";

  if (!data.tableBreakdown || data.tableBreakdown.length === 0) return;

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Table Breakdown";
  section.appendChild(title);

  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  for (const col of ["Table", "Self Time", "Top Operation", "Call Sites", "SetLoadFields", "Filtered"]) {
    const th = document.createElement("th");
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const t of data.tableBreakdown) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = t.tableName;
    tr.appendChild(tdName);

    const tdTime = document.createElement("td");
    tdTime.textContent = formatTime(t.totalSelfTime) + " (" + t.totalSelfTimePercent.toFixed(1) + "%)";
    tr.appendChild(tdTime);

    const tdOp = document.createElement("td");
    if (t.operationBreakdown && t.operationBreakdown.length > 0) {
      tdOp.textContent = t.operationBreakdown[0].operation + " (" + formatTime(t.operationBreakdown[0].selfTime) + ")";
    } else {
      tdOp.textContent = "\u2014";
    }
    tr.appendChild(tdOp);

    const tdSites = document.createElement("td");
    tdSites.textContent = String(t.callSiteCount);
    tr.appendChild(tdSites);

    const tdSlf = document.createElement("td");
    tdSlf.textContent = t.hasSetLoadFields ? "Yes" : "No";
    tdSlf.style.color = t.hasSetLoadFields ? "var(--success-color, #4CAF50)" : "var(--text-secondary)";
    tr.appendChild(tdSlf);

    const tdFilt = document.createElement("td");
    tdFilt.textContent = t.hasFilters ? "Yes" : "No";
    tdFilt.style.color = t.hasFilters ? "var(--success-color, #4CAF50)" : "var(--text-secondary)";
    tr.appendChild(tdFilt);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  section.appendChild(wrapper);
}

/**
 * Render the object breakdown section with collapsible groups.
 */
function renderObjectBreakdown(data) {
  const section = document.getElementById("object-breakdown-section");
  if (!section) return;
  section.innerHTML = "";

  if (!data.objectBreakdown || data.objectBreakdown.length === 0) return;

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Object Breakdown";
  section.appendChild(title);

  const sorted = [...data.objectBreakdown].sort(
    (a, b) => b.selfTime - a.selfTime,
  );

  for (const obj of sorted) {
    const group = document.createElement("div");
    group.className = "object-group";

    // Header
    const header = document.createElement("div");
    header.className = "object-header";

    const leftSide = document.createElement("div");
    leftSide.style.display = "flex";
    leftSide.style.alignItems = "center";
    leftSide.style.gap = "0.75rem";

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "\u25B6";
    leftSide.appendChild(chevron);

    const objInfo = document.createElement("span");
    objInfo.innerHTML =
      "<strong>" +
      escapeHtml(obj.objectType) +
      " " +
      escapeHtml(obj.objectName) +
      "</strong>" +
      ' <span style="color:var(--text-secondary)">' +
      escapeHtml("ID " + obj.objectId) +
      " &middot; " +
      escapeHtml(obj.appName) +
      "</span>";
    leftSide.appendChild(objInfo);

    header.appendChild(leftSide);

    const rightSide = document.createElement("div");
    rightSide.style.display = "flex";
    rightSide.style.gap = "1.5rem";
    rightSide.style.fontSize = "0.9rem";
    rightSide.style.color = "var(--text-secondary)";

    const selfEl = document.createElement("span");
    selfEl.textContent = formatTime(obj.selfTime);
    rightSide.appendChild(selfEl);

    const methodCountEl = document.createElement("span");
    methodCountEl.textContent = obj.methodCount + " methods";
    rightSide.appendChild(methodCountEl);

    header.appendChild(rightSide);

    header.addEventListener("click", () => {
      group.classList.toggle("open");
    });

    group.appendChild(header);

    // Methods table (hidden by default)
    const methodsDiv = document.createElement("div");
    methodsDiv.className = "object-methods";

    if (obj.methods && obj.methods.length > 0) {
      const tbl = document.createElement("table");
      const mThead = document.createElement("thead");
      const mHeaderRow = document.createElement("tr");
      for (const col of ["Function", "Self Time", "Total Time", "Hits"]) {
        const th = document.createElement("th");
        th.textContent = col;
        th.style.cursor = "default";
        mHeaderRow.appendChild(th);
      }
      mThead.appendChild(mHeaderRow);
      tbl.appendChild(mThead);

      const mTbody = document.createElement("tbody");
      for (const m of obj.methods) {
        const tr = document.createElement("tr");

        const tdFunc = document.createElement("td");
        tdFunc.className = "mono";
        tdFunc.textContent = m.functionName;
        tr.appendChild(tdFunc);

        const tdSelf = document.createElement("td");
        tdSelf.textContent =
          formatTime(m.selfTime) +
          " (" +
          m.selfTimePercent.toFixed(1) +
          "%)";
        tr.appendChild(tdSelf);

        const tdTotal = document.createElement("td");
        tdTotal.textContent =
          formatTime(m.totalTime) +
          " (" +
          m.totalTimePercent.toFixed(1) +
          "%)";
        tr.appendChild(tdTotal);

        const tdHits = document.createElement("td");
        tdHits.textContent = String(m.hitCount);
        tr.appendChild(tdHits);

        mTbody.appendChild(tr);
      }
      tbl.appendChild(mTbody);
      methodsDiv.appendChild(tbl);
    }

    group.appendChild(methodsDiv);
    section.appendChild(group);
  }
}

/**
 * Render the AI explanation section (markdown-formatted).
 */
function renderExplanation(data) {
  const section = document.getElementById("explanation-section");
  if (!section) return;
  section.innerHTML = "";

  if (!data.explanation) return;

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "AI Analysis";
  section.appendChild(title);

  const card = document.createElement("div");
  card.className = "card";

  card.innerHTML = renderMarkdown(data.explanation);

  section.appendChild(card);
}

/**
 * Render analysis results into the results container.
 * Dispatches to individual section renderers.
 */
/**
 * Build the sidebar navigation from visible sections.
 */
function buildSidebar() {
  const nav = document.getElementById("sidebar-nav");
  if (!nav) return;
  nav.innerHTML = "";

  // Mirrors SECTION_ORDER from src/output/sections.ts
  const sections = [
    { id: "summary-section", label: "Summary" },
    { id: "explanation-section", label: "AI Analysis" },
    { id: "app-breakdown-section", label: "App Breakdown" },
    { id: "table-breakdown-section", label: "Table Breakdown" },
    { id: "hotspots-section", label: "Hotspots" },
    { id: "critical-path-section", label: "Critical Path" },
    { id: "patterns-section", label: "Patterns" },
    { id: "object-breakdown-section", label: "Object Breakdown" },
  ];

  const visibleSections = [];
  for (const s of sections) {
    const el = document.getElementById(s.id);
    if (el && el.innerHTML.trim() !== "") {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#" + s.id;
      a.textContent = s.label;
      a.setAttribute("data-section", s.id);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      li.appendChild(a);
      nav.appendChild(li);
      visibleSections.push(s.id);
    }
  }

  // Highlight active section on scroll
  if (window._sidebarScrollHandler) {
    window.removeEventListener("scroll", window._sidebarScrollHandler);
  }
  window._sidebarScrollHandler = () => {
    let activeId = visibleSections[0];
    for (let i = visibleSections.length - 1; i >= 0; i--) {
      const el = document.getElementById(visibleSections[i]);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= 120) {
          activeId = visibleSections[i];
          break;
        }
      }
    }
    for (const a of nav.querySelectorAll("a")) {
      a.classList.toggle("active", a.getAttribute("data-section") === activeId);
    }
  };
  window.addEventListener("scroll", window._sidebarScrollHandler);
  window._sidebarScrollHandler();
}

function renderResults(data) {
  // Clear batch-specific sections that single mode doesn't use
  for (const id of ["activity-breakdown-section", "batch-errors-section"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  }

  renderSummary(data);
  renderExplanation(data);
  renderAppBreakdown(data);
  renderTableBreakdown(data);
  renderHotspots(data);
  renderCriticalPath(data);
  renderPatterns(data);
  renderObjectBreakdown(data);
  buildSidebar();
}

/**
 * Handle dropped or selected files: detect batch vs single mode, dispatch.
 */
async function handleFiles(files) {
  const profileFiles = Array.from(files).filter(f => f.name.endsWith(".alcpuprofile"));
  const zipFile = Array.from(files).find(f => f.name.endsWith(".zip"));

  if (profileFiles.length > 1) {
    await handleBatchUpload(profileFiles, zipFile);
  } else if (profileFiles.length === 1) {
    await handleSingleUpload(profileFiles[0], zipFile);
  } else {
    document.getElementById("error-message").textContent =
      "No .alcpuprofile file found in dropped files";
    showView("error");
  }
}

/**
 * Upload a single profile for analysis (existing behavior).
 */
async function handleSingleUpload(profileFile, sourceFile) {
  const formData = new FormData();
  formData.append("profile", profileFile);
  if (sourceFile) {
    formData.append("source", sourceFile);
  }

  // Show loading state with elapsed timer
  showView("loading");
  const timerEl = document.getElementById("elapsed-timer");
  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = elapsed + "s elapsed";
  }, 1000);

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      let message = "Analysis failed";
      try {
        const errorData = await response.json();
        if (errorData.error) {
          message = errorData.error;
        }
      } catch {
        // Could not parse error JSON — use generic message
      }
      document.getElementById("error-message").textContent = message;
      showView("error");
      return;
    }

    const data = await response.json();
    renderResults(data);
    showView("results");
  } catch (err) {
    document.getElementById("error-message").textContent =
      err.message || "Network error — could not reach the server";
    showView("error");
  } finally {
    clearInterval(timerInterval);
  }
}

/**
 * Upload multiple profiles for batch analysis.
 */
async function handleBatchUpload(profileFiles, sourceFile) {
  showView("loading");
  const timerEl = document.getElementById("elapsed-timer");
  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = elapsed + "s elapsed";
  }, 1000);

  const formData = new FormData();
  for (const file of profileFiles) {
    formData.append("profiles[]", file);
  }
  if (sourceFile) {
    formData.append("source", sourceFile);
  }

  try {
    const response = await fetch("/api/analyze-batch", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      let message = "Batch analysis failed";
      try {
        const errorData = await response.json();
        if (errorData.error) {
          message = errorData.error;
        }
      } catch {
        // Could not parse error JSON — use generic message
      }
      document.getElementById("error-message").textContent = message;
      showView("error");
      return;
    }

    const data = await response.json();
    renderBatchResults(data);
    showView("results");
  } catch (err) {
    document.getElementById("error-message").textContent =
      err.message || "Network error — could not reach the server";
    showView("error");
  } finally {
    clearInterval(timerInterval);
  }
}

// ---------------------------------------------------------------------------
// Batch results rendering
// ---------------------------------------------------------------------------

/**
 * Get a health score color based on the score value.
 */
function healthColor(score) {
  if (score >= 80) return "var(--success-color, #22c55e)";
  if (score >= 50) return "var(--severity-warning)";
  return "var(--severity-critical)";
}

/**
 * Create a health score badge element.
 */
function createHealthBadge(score) {
  const badge = document.createElement("span");
  badge.style.display = "inline-block";
  badge.style.padding = "0.2rem 0.6rem";
  badge.style.borderRadius = "4px";
  badge.style.fontWeight = "600";
  badge.style.fontSize = "0.85rem";
  if (score >= 80) {
    badge.style.color = "#22c55e";
    badge.style.background = "rgba(34, 197, 94, 0.15)";
  } else if (score >= 50) {
    badge.style.color = "var(--severity-warning)";
    badge.style.background = "rgba(245, 158, 11, 0.15)";
  } else {
    badge.style.color = "var(--severity-critical)";
    badge.style.background = "rgba(239, 68, 68, 0.15)";
  }
  badge.textContent = score + "/100";
  return badge;
}

/**
 * Render the batch summary section.
 */
function renderBatchSummary(data) {
  const section = document.getElementById("summary-section");
  if (!section) return;
  section.innerHTML = "";

  const card = document.createElement("div");
  card.className = "card";

  // One-liner headline
  const headline = document.createElement("div");
  headline.style.fontSize = "1.1rem";
  headline.style.fontWeight = "600";
  headline.style.marginBottom = "1rem";
  headline.textContent = data.summary.oneLiner;
  card.appendChild(headline);

  // Stats row
  const statsRow = document.createElement("div");
  statsRow.style.display = "flex";
  statsRow.style.flexWrap = "wrap";
  statsRow.style.gap = "1.5rem";
  statsRow.style.marginBottom = "1rem";
  statsRow.style.fontSize = "0.9rem";

  const stats = [
    { label: "Profiles", value: String(data.meta.profileCount) },
    { label: "Total Duration", value: formatTime(data.meta.totalDuration) },
  ];
  if (data.meta.timeRange) {
    stats.push({
      label: "Time Range",
      value: new Date(data.meta.timeRange.start).toLocaleTimeString() + " - " + new Date(data.meta.timeRange.end).toLocaleTimeString(),
    });
  }
  stats.push({ label: "Health", value: data.summary.overallHealthScore + "/100" });

  for (const s of stats) {
    const stat = document.createElement("span");
    stat.className = "stat";
    const labelSpan = document.createElement("span");
    labelSpan.style.color = "var(--text-secondary)";
    labelSpan.textContent = s.label + ": ";
    const valueSpan = document.createElement("span");
    valueSpan.textContent = s.value;
    stat.appendChild(labelSpan);
    stat.appendChild(valueSpan);
    statsRow.appendChild(stat);
  }
  card.appendChild(statsRow);

  // Badges row
  const badgesRow = document.createElement("div");
  badgesRow.style.display = "flex";
  badgesRow.style.flexWrap = "wrap";
  badgesRow.style.gap = "0.5rem";
  badgesRow.style.alignItems = "center";

  // Batch badge
  const batchBadge = document.createElement("span");
  batchBadge.className = "source-badge correlated";
  batchBadge.style.background = "rgba(59, 130, 246, 0.15)";
  batchBadge.style.color = "var(--accent-blue)";
  batchBadge.textContent = "Batch Analysis";
  badgesRow.appendChild(batchBadge);

  // Source badge
  const srcBadge = document.createElement("span");
  if (data.meta.sourceAvailable) {
    srcBadge.className = "source-badge correlated";
    srcBadge.textContent = "Source Correlated";
  } else {
    srcBadge.className = "source-badge profile-only";
    srcBadge.textContent = "Profile Only";
  }
  badgesRow.appendChild(srcBadge);

  // Pattern count badges
  const pc = data.summary.totalPatternCount;
  if (pc.critical > 0) {
    const b = document.createElement("span");
    b.className = "severity-badge severity-critical";
    b.textContent = pc.critical + " Critical";
    badgesRow.appendChild(b);
  }
  if (pc.warning > 0) {
    const b = document.createElement("span");
    b.className = "severity-badge severity-warning";
    b.textContent = pc.warning + " Warning";
    badgesRow.appendChild(b);
  }
  if (pc.info > 0) {
    const b = document.createElement("span");
    b.className = "severity-badge severity-info";
    b.textContent = pc.info + " Info";
    badgesRow.appendChild(b);
  }

  card.appendChild(badgesRow);

  // Worst profile callout
  if (data.summary.worstProfile) {
    const wp = data.summary.worstProfile;
    const callout = document.createElement("div");
    callout.style.marginTop = "1rem";
    callout.style.padding = "0.75rem 1rem";
    callout.style.background = "var(--bg-primary)";
    callout.style.borderLeft = "3px solid var(--severity-warning)";
    callout.style.borderRadius = "0 4px 4px 0";
    callout.style.fontSize = "0.9rem";
    callout.innerHTML =
      '<span style="color:var(--text-secondary)">Worst profile:</span> ' +
      "<strong>" + escapeHtml(wp.description || wp.profilePath) + "</strong>" +
      ' <span style="color:var(--text-secondary)">(health ' + wp.healthScore + "/100)</span>";
    card.appendChild(callout);
  }

  section.appendChild(card);
}

/**
 * Render the activity breakdown table for batch results.
 */
function renderActivityBreakdown(data) {
  const section = document.getElementById("activity-breakdown-section");
  if (!section) return;
  section.innerHTML = "";

  if (!data.activityBreakdown || data.activityBreakdown.length === 0) return;

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Activity Breakdown";
  section.appendChild(title);

  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  for (const col of ["Activity", "Type", "Duration", "Health", "Patterns"]) {
    const th = document.createElement("th");
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const activity of data.activityBreakdown) {
    const tr = document.createElement("tr");

    // Activity name — use metadata description or profile path
    const tdActivity = document.createElement("td");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.style.cursor = "pointer";
    const activityName = (activity.metadata && activity.metadata.activityDescription)
      ? activity.metadata.activityDescription
      : activity.profilePath.replace(/^.*[/\\]/, "");
    summary.textContent = activityName;
    details.appendChild(summary);

    // Drill-down content
    const drillDown = document.createElement("div");
    drillDown.style.padding = "0.5rem 0";
    drillDown.style.fontSize = "0.85rem";
    drillDown.style.color = "var(--text-secondary)";

    if (activity.topHotspot) {
      const hotspotLine = document.createElement("div");
      hotspotLine.innerHTML =
        '<span style="color:var(--text-primary)">Top hotspot:</span> ' +
        '<span class="mono">' + escapeHtml(activity.topHotspot.functionName) + "</span>" +
        " (" + escapeHtml(activity.topHotspot.objectName) + ")" +
        " — " + activity.topHotspot.selfTimePercent.toFixed(1) + "% self time";
      drillDown.appendChild(hotspotLine);
    }

    if (activity.metadata) {
      const m = activity.metadata;
      const metaLines = [];
      if (m.userName) metaLines.push("User: " + m.userName);
      if (m.sqlCallCount) metaLines.push("SQL calls: " + m.sqlCallCount + " (" + formatTime(m.sqlCallDuration) + ")");
      if (m.httpCallCount) metaLines.push("HTTP calls: " + m.httpCallCount + " (" + formatTime(m.httpCallDuration) + ")");
      for (const line of metaLines) {
        const div = document.createElement("div");
        div.textContent = line;
        drillDown.appendChild(div);
      }
    }

    details.appendChild(drillDown);
    tdActivity.appendChild(details);
    tr.appendChild(tdActivity);

    // Type
    const tdType = document.createElement("td");
    tdType.textContent = (activity.metadata && activity.metadata.activityType) || "\u2014";
    tr.appendChild(tdType);

    // Duration
    const tdDuration = document.createElement("td");
    tdDuration.textContent = formatTime(activity.duration);
    tr.appendChild(tdDuration);

    // Health
    const tdHealth = document.createElement("td");
    tdHealth.appendChild(createHealthBadge(activity.healthScore));
    tr.appendChild(tdHealth);

    // Patterns
    const tdPatterns = document.createElement("td");
    const pc = activity.patternCount;
    const parts = [];
    if (pc.critical > 0) parts.push('<span class="severity-badge severity-critical">' + pc.critical + " C</span>");
    if (pc.warning > 0) parts.push('<span class="severity-badge severity-warning">' + pc.warning + " W</span>");
    if (pc.info > 0) parts.push('<span class="severity-badge severity-info">' + pc.info + " I</span>");
    tdPatterns.innerHTML = parts.length > 0 ? parts.join(" ") : "\u2014";
    tr.appendChild(tdPatterns);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  section.appendChild(wrapper);
}

/**
 * Render recurring patterns section for batch results.
 */
function renderRecurringPatterns(data) {
  const section = document.getElementById("patterns-section");
  if (!section) return;
  section.innerHTML = "";

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Recurring Patterns";
  section.appendChild(title);

  if (!data.recurringPatterns || data.recurringPatterns.length === 0) {
    const muted = document.createElement("div");
    muted.style.color = "var(--text-secondary)";
    muted.textContent = "No recurring patterns detected across profiles";
    section.appendChild(muted);
    return;
  }

  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const severityIcon = { critical: "\u2716", warning: "\u26A0", info: "\u2139" };

  const sorted = [...data.recurringPatterns].sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
  );

  for (const p of sorted) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "0.75rem";

    // Badge + title row
    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.alignItems = "center";
    headerRow.style.gap = "0.75rem";
    headerRow.style.marginBottom = "0.5rem";

    const badge = document.createElement("span");
    badge.className = "severity-badge severity-" + p.severity;
    badge.textContent = severityIcon[p.severity] + " " + capitalize(p.severity);
    headerRow.appendChild(badge);

    const titleEl = document.createElement("strong");
    titleEl.textContent = p.title;
    headerRow.appendChild(titleEl);

    card.appendChild(headerRow);

    // Recurrence stats
    const statsDiv = document.createElement("div");
    statsDiv.style.display = "flex";
    statsDiv.style.gap = "1.5rem";
    statsDiv.style.marginBottom = "0.5rem";
    statsDiv.style.fontSize = "0.9rem";

    const recurrenceEl = document.createElement("span");
    recurrenceEl.innerHTML =
      '<span style="color:var(--text-secondary)">Recurrence:</span> ' +
      p.recurrencePercent.toFixed(0) + "% (" + p.profileCount + "/" + p.totalProfiles + " profiles)";
    statsDiv.appendChild(recurrenceEl);
    card.appendChild(statsDiv);

    // Recurrence bar
    const barTrack = document.createElement("div");
    barTrack.className = "bar-track";
    barTrack.style.marginBottom = "0.5rem";
    const barFill = document.createElement("div");
    barFill.className = "bar-fill";
    barFill.style.width = Math.min(p.recurrencePercent, 100) + "%";
    // Color the bar by severity
    if (p.severity === "critical") {
      barFill.style.background = "var(--severity-critical)";
    } else if (p.severity === "warning") {
      barFill.style.background = "var(--severity-warning)";
    }
    barTrack.appendChild(barFill);
    card.appendChild(barTrack);

    // Affected activities
    if (p.affectedActivities && p.affectedActivities.length > 0) {
      const activitiesDiv = document.createElement("div");
      activitiesDiv.style.fontSize = "0.85rem";
      activitiesDiv.style.color = "var(--text-secondary)";
      activitiesDiv.textContent = "Affected: " + p.affectedActivities.slice(0, 5).join(", ");
      if (p.affectedActivities.length > 5) {
        activitiesDiv.textContent += " (+" + (p.affectedActivities.length - 5) + " more)";
      }
      card.appendChild(activitiesDiv);
    }

    section.appendChild(card);
  }
}

/**
 * Render cumulative hotspots table for batch results.
 */
function renderCumulativeHotspots(data) {
  const section = document.getElementById("hotspots-section");
  if (!section) return;
  section.innerHTML = "";

  if (!data.cumulativeHotspots || data.cumulativeHotspots.length === 0) return;

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Cumulative Hotspots";
  section.appendChild(title);

  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  // Sort state
  let sortKey = "cumulativeSelfTime";
  let sortAsc = false;

  const columns = [
    { label: "#", sortable: false },
    { label: "Method", sortable: false },
    { label: "Object", sortable: false },
    { label: "App", sortable: false },
    { label: "Cumul. Time", sortable: true, key: "cumulativeSelfTime" },
    { label: "Profiles", sortable: true, key: "profileCount" },
    { label: "Avg/Profile", sortable: true, key: "avgSelfTime" },
    { label: "Max", sortable: true, key: "maxSelfTime" },
  ];

  const thElements = [];
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.label;
    if (col.sortable) {
      th.setAttribute("data-sort", col.key);
      th.style.cursor = "pointer";
      if (col.key === sortKey) {
        th.textContent = col.label + " " + (sortAsc ? "\u25B2" : "\u25BC");
      }
      th.addEventListener("click", () => {
        if (sortKey === col.key) {
          sortAsc = !sortAsc;
        } else {
          sortKey = col.key;
          sortAsc = false;
        }
        for (const info of thElements) {
          if (info.sortable) {
            if (info.key === sortKey) {
              info.el.textContent = info.label + " " + (sortAsc ? "\u25B2" : "\u25BC");
            } else {
              info.el.textContent = info.label;
            }
          }
        }
        rebuildTbody();
      });
    }
    headerRow.appendChild(th);
    thElements.push({ el: th, ...col });
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  // Find max cumulative time for bar scaling
  const maxCumulTime = Math.max(...data.cumulativeHotspots.map(h => h.cumulativeSelfTime));

  function rebuildTbody() {
    tbody.innerHTML = "";
    const sorted = [...data.cumulativeHotspots].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      return sortAsc ? av - bv : bv - av;
    });
    for (let i = 0; i < sorted.length; i++) {
      const h = sorted[i];
      const tr = document.createElement("tr");

      // Rank
      const tdRank = document.createElement("td");
      tdRank.textContent = String(i + 1);
      tr.appendChild(tdRank);

      // Method
      const tdFunc = document.createElement("td");
      tdFunc.className = "mono";
      tdFunc.textContent = h.functionName;
      tr.appendChild(tdFunc);

      // Object
      const tdObj = document.createElement("td");
      tdObj.textContent = h.objectType + " " + h.objectId + " (" + h.objectName + ")";
      tr.appendChild(tdObj);

      // App
      const tdApp = document.createElement("td");
      tdApp.textContent = h.appName;
      tr.appendChild(tdApp);

      // Cumulative Time with bar
      const tdCumul = document.createElement("td");
      const barPct = maxCumulTime > 0 ? (h.cumulativeSelfTime / maxCumulTime) * 100 : 0;
      tdCumul.innerHTML =
        escapeHtml(formatTime(h.cumulativeSelfTime)) +
        '<div class="bar-track"><div class="bar-fill" style="width:' +
        Math.min(barPct, 100) +
        '%"></div></div>';
      tr.appendChild(tdCumul);

      // Profile count
      const tdProfiles = document.createElement("td");
      tdProfiles.textContent = String(h.profileCount) + "/" + data.meta.profileCount;
      tr.appendChild(tdProfiles);

      // Avg per profile
      const tdAvg = document.createElement("td");
      tdAvg.textContent = formatTime(h.avgSelfTime);
      tr.appendChild(tdAvg);

      // Max
      const tdMax = document.createElement("td");
      tdMax.textContent = formatTime(h.maxSelfTime);
      tr.appendChild(tdMax);

      tbody.appendChild(tr);
    }
  }

  rebuildTbody();
  wrapper.appendChild(table);
  section.appendChild(wrapper);
}

/**
 * Render batch app breakdown with bar chart.
 */
function renderBatchAppBreakdown(data) {
  const section = document.getElementById("app-breakdown-section");
  if (!section) return;
  section.innerHTML = "";

  if (!data.appBreakdown || data.appBreakdown.length === 0) return;

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "App Breakdown";
  section.appendChild(title);

  const sorted = [...data.appBreakdown].sort(
    (a, b) => b.selfTime - a.selfTime,
  );

  for (const app of sorted) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "1rem";
    row.style.marginBottom = "0.5rem";

    const nameEl = document.createElement("div");
    nameEl.style.minWidth = "200px";
    nameEl.style.flexShrink = "0";
    nameEl.textContent = app.appName;
    row.appendChild(nameEl);

    const barContainer = document.createElement("div");
    barContainer.style.flex = "1";
    barContainer.innerHTML =
      '<div class="bar-track"><div class="bar-fill" style="width:' +
      Math.min(app.selfTimePercent, 100) +
      '%"></div></div>';
    row.appendChild(barContainer);

    const pctEl = document.createElement("div");
    pctEl.style.minWidth = "50px";
    pctEl.style.textAlign = "right";
    pctEl.style.fontSize = "0.9rem";
    pctEl.textContent = app.selfTimePercent.toFixed(1) + "%";
    row.appendChild(pctEl);

    const timeEl = document.createElement("div");
    timeEl.style.minWidth = "80px";
    timeEl.style.textAlign = "right";
    timeEl.style.fontSize = "0.9rem";
    timeEl.style.color = "var(--text-secondary)";
    timeEl.textContent = formatTime(app.selfTime);
    row.appendChild(timeEl);

    section.appendChild(row);
  }
}

/**
 * Render batch errors section if any profiles failed to parse.
 */
function renderBatchErrors(data) {
  const section = document.getElementById("batch-errors-section");
  if (!section) return;
  section.innerHTML = "";

  if (!data.errors || data.errors.length === 0) return;

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Errors";
  section.appendChild(title);

  for (const err of data.errors) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "0.5rem";
    card.style.borderColor = "rgba(239, 68, 68, 0.3)";
    card.innerHTML =
      "<strong>" + escapeHtml(err.profilePath.replace(/^.*[/\\]/, "")) + "</strong>" +
      '<div style="color:var(--severity-critical);margin-top:0.25rem">' + escapeHtml(err.error) + "</div>";
    section.appendChild(card);
  }
}

/**
 * Render all batch analysis results.
 */
function renderBatchResults(data) {
  // Clear all single-analysis sections that batch doesn't use
  for (const id of ["table-breakdown-section", "critical-path-section", "object-breakdown-section"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  }

  renderBatchSummary(data);
  renderExplanation(data);
  renderActivityBreakdown(data);
  renderRecurringPatterns(data);
  renderCumulativeHotspots(data);
  renderBatchAppBreakdown(data);
  renderBatchErrors(data);
  buildBatchSidebar(data);
}

/**
 * Build sidebar navigation for batch results.
 */
function buildBatchSidebar(data) {
  const nav = document.getElementById("sidebar-nav");
  if (!nav) return;
  nav.innerHTML = "";

  const sections = [
    { id: "summary-section", label: "Summary" },
    { id: "explanation-section", label: "AI Analysis" },
    { id: "activity-breakdown-section", label: "Activities" },
    { id: "patterns-section", label: "Recurring Patterns" },
    { id: "hotspots-section", label: "Cumulative Hotspots" },
    { id: "app-breakdown-section", label: "App Breakdown" },
    { id: "batch-errors-section", label: "Errors" },
  ];

  const visibleSections = [];
  for (const s of sections) {
    const el = document.getElementById(s.id);
    if (el && el.innerHTML.trim() !== "") {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#" + s.id;
      a.textContent = s.label;
      a.setAttribute("data-section", s.id);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      li.appendChild(a);
      nav.appendChild(li);
      visibleSections.push(s.id);
    }
  }

  // Highlight active section on scroll
  if (window._sidebarScrollHandler) {
    window.removeEventListener("scroll", window._sidebarScrollHandler);
  }
  window._sidebarScrollHandler = () => {
    let activeId = visibleSections[0];
    for (let i = visibleSections.length - 1; i >= 0; i--) {
      const el = document.getElementById(visibleSections[i]);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= 120) {
          activeId = visibleSections[i];
          break;
        }
      }
    }
    for (const a of nav.querySelectorAll("a")) {
      a.classList.toggle("active", a.getAttribute("data-section") === activeId);
    }
  };
  window.addEventListener("scroll", window._sidebarScrollHandler);
  window._sidebarScrollHandler();
}

// ---------------------------------------------------------------------------
// Event handlers — set up on DOMContentLoaded
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const newAnalysisBtn = document.getElementById("new-analysis");
  const tryAgainBtn = document.getElementById("try-again");


  // --- Drag-and-drop ---
  dropzone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", (e) => {
    if (!dropzone.contains(e.relatedTarget)) {
      dropzone.classList.remove("dragover");
    }
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFiles(files);
    }
  });

  // --- Click to browse ---
  dropzone.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      handleFiles(fileInput.files);
    }
    // Reset so the same file can be re-selected
    fileInput.value = "";
  });

  // --- Reset buttons ---
  newAnalysisBtn.addEventListener("click", () => {
    showView("dropzone");
  });

  tryAgainBtn.addEventListener("click", () => {
    showView("dropzone");
  });
});
