# AL Perf VSCode Extension — Design Spec

## Overview

A VSCode extension that integrates al-perf performance analysis directly into the AL development workflow. After a Business Central Performance Profiler debug session, the extension sends the profile to the hosted al-perf service and renders findings across five VSCode integration points: Webview panel, TreeView, editor decorations, CodeLens, and Diagnostics.

## Goals

- Zero-friction analysis: detect new profiles automatically, one click to analyze
- Findings appear where developers already look: in the editor, in the Problems panel, in the sidebar
- AI-powered fix suggestions presented as diff previews, not black-box auto-edits
- First-class VSCode citizen: native APIs where they fit, Webview only for rich content

## Architecture: Hybrid (Webview + Native APIs)

Five integration points, each using the right VSCode API:

| Component | VSCode API | Purpose |
|-----------|-----------|---------|
| Summary panel | Webview | Health score, one-liner, pattern counts, top hotspots, profile metadata |
| Pattern/hotspot tree | TreeView (Activity Bar) | Navigable tree of patterns by severity + hotspots. Click to jump to source |
| Inline annotations | Editor Decorations | Gutter icons, line background highlighting, hover tooltips on affected lines |
| Fix actions | CodeLens | "⚠ N performance issues · Show fixes" above affected procedures |
| Problem integration | Diagnostics API | Squiggly underlines, Problems panel entries, F8 navigation |

## Service Communication

- **Endpoint**: `https://alperf.sshadows.dk/api/analyze` (configurable via `alPerf.serviceUrl`)
- **Protocol**: POST multipart/form-data with `?stream=1` (SSE streaming; `format` param is ignored when streaming — the `done` event always returns JSON)
- **Payload**: `.alcpuprofile` file (field: `profile`) + optional `.zip` source bundle (field: `source`)
- **Response**: SSE event stream:
  - `event: progress` — `{ step: string, message: string }` (e.g. `{ step: "patterns", message: "Detecting patterns..." }`)
  - `event: done` — Full `AnalysisResult` JSON
  - `event: error` — `{ error: string }`

## Extension Activation & Profile Discovery

The extension activates when a workspace contains `app.json` (AL project).

### Profile detection

1. File watcher on `.snapshots/*.alcpuprofile` detects new profiles
2. Notification: "New performance profile detected. Analyze?" with an **Analyze** button
3. Extension looks for a matching `.zip` in `.snapshots/` (same GUID filename). If found, sends it for source correlation.

### Entry points

- **Auto-detect**: File watcher triggers notification
- **Manual**: Command Palette → `AL Perf: Analyze Performance Profile` (file picker)
- **Generate & Analyze**: Command Palette → `AL Perf: Generate & Analyze Profile` — calls `al.generateCpuProfileFile` first, then watches for the result. If the AL Language extension is not installed or the command is unavailable, shows an error: "AL Language extension required for profile generation."

## Analysis Flow

1. **Upload**: POST multipart to service with `.alcpuprofile` + `.zip` (if available), `?stream=1`
2. **Progress**: VSCode progress notification with SSE status updates from `progress` events
3. **Result**: On SSE `done`, deserialize `AnalysisResult` and build the location index (see below), then distribute to all five view layers
4. **Error**: On SSE `error` or HTTP failure, show error notification with message. Never crash silently.
5. **Caching**: Keep last result in memory keyed by profile file path. Re-renders decorations on file switch. Persist to extension storage to survive restarts. Replaced on re-analysis of the same profile.

### Building the Location Index

`DetectedPattern` and `AIFinding` contain `involvedMethods: string[]` (format: `"FunctionName (ObjectType ObjectId)"`) but no direct source locations. The extension builds a lookup index after receiving the result:

1. Index all `MethodBreakdown` hotspots by method identifier → `SourceLocation` (file + line range). Key format: `"${functionName} (${objectType} ${objectId})"` to match `involvedMethods` strings.
2. For each `DetectedPattern`, resolve `involvedMethods` to `SourceLocation` via the hotspot index
3. For each `AIFinding`, resolve `involvedMethods` the same way
4. Patterns/findings that resolve to no source location (e.g. base app methods without source, or methods outside the top-N hotspots) get TreeView/panel entries only — no editor decorations

This is a client-side join, no server changes needed.

### Source Path Resolution

`SourceLocation.filePath` is relative to the source root (the zip contents). The extension resolves these to workspace-absolute paths by joining with the workspace root folder. This assumes the `.zip` was created from the workspace root (which is how `al.generateCpuProfileFile` works). If a resolved path does not exist on disk, that finding gets panel/tree entries only — no editor decorations.

## Webview Summary Panel

Located in the secondary sidebar or panel area. Shows:

- **Health score**: Circular badge + one-liner summary from `result.summary`
- **Pattern counts**: Critical / Warning / Info count bar
- **Top hotspots**: Method name, object, percentage bar, hit count. Clickable to jump to source.
- **Profile metadata**: Type (sampling/instrumentation), duration, source availability, confidence score

## TreeView (Activity Bar)

The extension gets its own icon in the Activity Bar. Two sections:

### Patterns section
- Grouped by severity (critical first)
- Each pattern is expandable: shows affected methods with line numbers
- Click a method → opens file and jumps to line
- Severity badges (colored dots + labels)

### Hotspots section
- Top N methods by self-time percentage
- Click → jump to source location

## Editor Decorations

Applied when a file is opened that has findings:

- **Gutter icons**: Red dot (●) for critical, yellow triangle (▲) for warning
- **Line background**: Subtle red/yellow tint on affected lines
- **Hover tooltips**: On hover, shows severity, pattern name, description with hit counts and timing, impact estimate, and suggestion

Color coding:
- Critical: `#f44747` (red)
- Warning: `#cca700` (yellow)
- Info: `#3794ff` (blue)

## CodeLens

Appears above procedures that have findings:

- Format: `"⚠ N performance issues · Show fixes"`
- "Show fixes" triggers the fix flow (see below)
- Only shown on procedures with at least one finding

## Diagnostics API

Each pattern maps to a VSCode Diagnostic:

- **Source**: `"AL Perf"`
- **Severity mapping**: `critical` → Error, `warning` → Warning, `info` → Information
- **Range**: From resolved `SourceLocation` (via location index), narrowed to specific line from pattern evidence when available
- **Message**: Pattern title + concise description with metrics
- **Code**: Link to pattern documentation
- **Related information**: For third-party/base app findings, diagnostic goes on the call site in user's code with `DiagnosticRelatedInformation` pointing to the external method

Supports F8 ("Go to Next Problem") cycling through performance findings.

Cleared on new analysis or via `AL Perf: Clear Results` command.

## Fix Flow (CodeLens → Diff Preview)

1. User clicks "Show fixes" in CodeLens (or "Fix" in TreeView)
2. Extension checks `aiFindings` with `category: "code-fix"` for that method
3. If fix available:
   a. Resolve the finding's method to a `SourceLocation` via the location index
   b. Read the current file content
   c. Replace the procedure body (lines `lineStart` to `lineEnd`) with the `codeFix` content
   d. Create a virtual document (`vscode.Uri.parse('alperf-fix:...')`) with the modified content
   e. Open VSCode diff editor: current file (left) vs virtual document (right), titled "Pattern Name — Suggested Fix"
   f. User reviews and can copy changes manually or accept via editor actions
4. If no fix available: info message "No automated fix available. See suggestion in the tooltip."

**Note on `codeFix` format**: `AIFinding.codeFix` is free-form AL code (a replacement procedure body), not a structured diff. The extension replaces the full procedure body at the resolved line range. If the `codeFix` cannot be cleanly mapped (e.g. line range mismatch after edits), the extension shows the fix as a read-only preview with a message to apply manually.

## Third-Party / Base App Findings

Code from other apps can't be edited, but findings about them still matter. Handling:

- **In TreeView**: Shown with a distinct icon indicating external code
- **In Webview panel**: Hotspots from any app shown (with app name)
- **In editor**: Subtle annotation on the *call site* in user's code, with tooltip explaining the external method's impact
- **No CodeLens/fix**: No fix actions for code you don't own
- **Diagnostics**: `DiagnosticRelatedInformation` links user's call site to the external finding

## Configuration

### Settings (`contributes.configuration`)

| Setting | Default | Description |
|---------|---------|-------------|
| `alPerf.serviceUrl` | `https://alperf.sshadows.dk` | Service endpoint |
| `alPerf.autoDetect` | `true` | Watch `.snapshots/` for new profiles |
| `alPerf.maxHotspots` | `10` | Number of hotspots in panel |

### Commands (`contributes.commands`)

| Command | Description |
|---------|-------------|
| `AL Perf: Analyze Performance Profile` | Pick a `.alcpuprofile` file and analyze |
| `AL Perf: Generate & Analyze Profile` | Calls `al.generateCpuProfileFile`, then analyzes |
| `AL Perf: Clear Results` | Removes all decorations, diagnostics, CodeLens, clears panel |
| `AL Perf: Show Results Panel` | Opens/focuses the webview summary panel |

### Activation Events

- `workspaceContains:app.json`
- `onCommand:alPerf.*`

## Tech Stack

- **Language**: TypeScript
- **Bundler**: esbuild (standard for VSCode extensions)
- **VSCode API**: Webview, TreeDataProvider, DecorationProvider, CodeLensProvider, DiagnosticCollection
- **HTTP**: Native `fetch` + `FormData` (Node 18+, available in VSCode's runtime) for multipart uploads. Manual SSE parsing from `ReadableStream` (or `eventsource-parser` package if manual parsing proves fragile).
- **Testing**: VSCode extension test framework (`@vscode/test-electron`)

## Out of Scope (for now)

- Local al-perf server support (always uses hosted service)
- Batch analysis (single profile only)
- Profile comparison (before/after)
- Flamegraph visualization
- History/trend tracking
- Extension marketplace publishing (local dev only)
