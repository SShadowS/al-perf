# AL Perf VSCode Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VSCode extension that sends AL performance profiles to alperf.sshadows.dk and renders findings across five native integration points (Webview, TreeView, Decorations, CodeLens, Diagnostics).

**Architecture:** Hybrid approach — REST client to hosted service with SSE streaming, results distributed across Webview summary panel + native TreeView + editor decorations + CodeLens + Diagnostics. Client-side location index joins patterns/findings to source locations via hotspot method identifiers.

**Tech Stack:** TypeScript, VSCode Extension API, esbuild, native fetch + FormData, manual SSE parsing

**Spec:** `docs/superpowers/specs/2026-03-23-vscode-extension-design.md`

**Repo:** `U:\Git\al-perf-vscode` (new repo, sibling to al-perf)

---

## File Structure

```
al-perf-vscode/
  .vscode/
    launch.json           — Extension debug/run configuration
  src/
    extension.ts          — Extension entry point (activate/deactivate)
    config.ts             — Configuration constants and settings reader
    types.ts              — AnalysisResult, AIFinding, MethodBreakdown types (client-side mirror)
    api/
      client.ts           — REST client: upload profile, parse SSE stream
    model/
      location-index.ts   — Build method→SourceLocation lookup, resolve patterns/findings
      result-store.ts     — Cache analysis results, persist to extension storage
    views/
      summary-panel.ts    — Webview panel: health score, pattern counts, hotspots
      summary-panel.html  — Webview HTML template (copied to dist/ by esbuild)
      tree-provider.ts    — TreeView data provider: patterns + hotspots tree
    editor/
      decorations.ts      — Gutter icons, line backgrounds, hover tooltips
      codelens.ts         — CodeLens provider: "N performance issues · Show fixes"
      diagnostics.ts      — Diagnostics collection: squiggly underlines, Problems panel
      fix-preview.ts      — Diff editor flow: build virtual doc, open diff view
    profile/
      watcher.ts          — File watcher on .snapshots/*.alcpuprofile
      discovery.ts        — Find matching .zip, resolve workspace paths
  resources/
    icon.svg              — Activity Bar icon
    icons/
      critical.svg        — Red circle gutter icon
      warning.svg         — Yellow triangle gutter icon
      info.svg            — Blue info gutter icon
  test/
    suite/
      index.ts            — Test runner entry
      location-index.test.ts
      client.test.ts
      discovery.test.ts
    fixtures/
      sample-result.json  — Mock AnalysisResult for tests
  package.json
  tsconfig.json
  esbuild.js             — Build script
  .gitignore
  .vscodeignore
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.js`, `.gitignore`, `.vscodeignore`, `.vscode/launch.json`, `src/extension.ts`, `src/config.ts`

- [ ] **Step 1: Initialize repo and npm project**

```bash
cd U:\Git
mkdir al-perf-vscode
cd al-perf-vscode
git init
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install --save-dev @types/vscode typescript esbuild @vscode/test-electron
```

- [ ] **Step 3: Create package.json with extension manifest**

Replace the generated `package.json` with the full extension manifest:

```json
{
  "name": "al-perf-vscode",
  "displayName": "AL Perf",
  "description": "Performance analysis for AL (Business Central) — powered by al-perf",
  "version": "0.1.0",
  "publisher": "sshadows",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Debuggers", "Other"],
  "activationEvents": ["workspaceContains:app.json", "onCommand:alPerf.analyze", "onCommand:alPerf.generateAndAnalyze"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      { "command": "alPerf.analyze", "title": "AL Perf: Analyze Performance Profile" },
      { "command": "alPerf.generateAndAnalyze", "title": "AL Perf: Generate & Analyze Profile" },
      { "command": "alPerf.clearResults", "title": "AL Perf: Clear Results" },
      { "command": "alPerf.showPanel", "title": "AL Perf: Show Results Panel" }
    ],
    "configuration": {
      "title": "AL Perf",
      "properties": {
        "alPerf.serviceUrl": {
          "type": "string",
          "default": "https://alperf.sshadows.dk",
          "description": "AL Perf service endpoint"
        },
        "alPerf.autoDetect": {
          "type": "boolean",
          "default": true,
          "description": "Watch .snapshots/ for new profiles"
        },
        "alPerf.maxHotspots": {
          "type": "number",
          "default": 10,
          "description": "Number of hotspots to show in panel"
        }
      }
    },
    "viewsContainers": {
      "activitybar": [
        { "id": "alPerf", "title": "AL Perf", "icon": "resources/icon.svg" }
      ]
    },
    "views": {
      "alPerf": [
        { "id": "alPerf.patterns", "name": "Patterns" },
        { "id": "alPerf.hotspots", "name": "Hotspots" }
      ]
    }
  },
  "scripts": {
    "build": "node esbuild.js",
    "watch": "node esbuild.js --watch",
    "test": "node --experimental-vm-modules node_modules/@vscode/test-electron/out/runTest.js"
  },
  "devDependencies": {}
}
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 5: Create esbuild.js**

```javascript
const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");

const fs = require("fs");
const path = require("path");

const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  plugins: [
    {
      name: "copy-html",
      setup(build) {
        build.onEnd(() => {
          // Copy HTML templates to dist/
          const src = "src/views/summary-panel.html";
          const dest = "dist/views/summary-panel.html";
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        });
      },
    },
  ],
};

if (watch) {
  esbuild.context(buildOptions).then((ctx) => {
    ctx.watch();
    console.log("Watching for changes...");
  });
} else {
  esbuild.build(buildOptions).then(() => console.log("Build complete"));
}
```

- [ ] **Step 6: Create .vscode/launch.json**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "${defaultBuildTask}"
    }
  ]
}
```

- [ ] **Step 7: Create .gitignore and .vscodeignore**

`.gitignore`:
```
node_modules/
dist/
*.vsix
```

`.vscodeignore`:
```
src/**
test/**
node_modules/**
.vscode/**
tsconfig.json
esbuild.js
```

- [ ] **Step 8: Create src/config.ts**

```typescript
import * as vscode from "vscode";

export function getServiceUrl(): string {
  return vscode.workspace
    .getConfiguration("alPerf")
    .get<string>("serviceUrl", "https://alperf.sshadows.dk");
}

export function getAutoDetect(): boolean {
  return vscode.workspace
    .getConfiguration("alPerf")
    .get<boolean>("autoDetect", true);
}

export function getMaxHotspots(): number {
  return vscode.workspace
    .getConfiguration("alPerf")
    .get<number>("maxHotspots", 10);
}
```

- [ ] **Step 9: Create src/extension.ts (minimal activation)**

```typescript
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  console.log("AL Perf extension activated");

  context.subscriptions.push(
    vscode.commands.registerCommand("alPerf.analyze", () => {
      vscode.window.showInformationMessage("AL Perf: Analyze not yet implemented");
    }),
    vscode.commands.registerCommand("alPerf.generateAndAnalyze", () => {
      vscode.window.showInformationMessage("AL Perf: Generate & Analyze not yet implemented");
    }),
    vscode.commands.registerCommand("alPerf.clearResults", () => {
      vscode.window.showInformationMessage("AL Perf: Clear not yet implemented");
    }),
    vscode.commands.registerCommand("alPerf.showPanel", () => {
      vscode.window.showInformationMessage("AL Perf: Panel not yet implemented");
    })
  );
}

export function deactivate() {}
```

- [ ] **Step 10: Create placeholder icon**

Create `resources/icon.svg` — a simple performance chart icon (can be replaced later).

- [ ] **Step 11: Build, verify, commit**

```bash
npm run build
git add -A
git commit -m "feat: scaffold al-perf-vscode extension project"
```

Run: Extension Host via F5 in VSCode to verify activation.

---

## Task 2: Types

**Files:**
- Create: `src/types.ts`, `test/fixtures/sample-result.json`

- [ ] **Step 1: Create src/types.ts**

Mirror the al-perf response types needed by the extension. These are client-side copies (not imported from al-perf) so the extension has no runtime dependency on the server codebase.

```typescript
export interface AnalysisResult {
  meta: ProfileMeta;
  summary: AnalysisSummary;
  criticalPath: CriticalPathStep[];
  hotspots: MethodBreakdown[];
  patterns: DetectedPattern[];
  appBreakdown: AppBreakdown[];
  objectBreakdown: ObjectBreakdown[];
  tableBreakdown?: TableBreakdown[];
  explanation?: string;
  aiFindings?: AIFinding[];
  aiNarrative?: string;
}

export interface ProfileMeta {
  profilePath: string;
  profileType: "sampling" | "instrumentation";
  totalDuration: number;
  totalSelfTime: number;
  idleSelfTime: number;
  totalNodes: number;
  maxDepth: number;
  samplingInterval?: number;
  sourceAvailable: boolean;
  builtinSelfTime?: number;
  confidenceScore: number;
  analyzedAt: string;
}

export interface AnalysisSummary {
  oneLiner: string;
  topApp: { name: string; percent: number } | null;
  topMethod: { name: string; object: string; percent: number } | null;
  patternCount: { critical: number; warning: number; info: number };
  healthScore: number;
}

export interface MethodBreakdown {
  functionName: string;
  objectType: string;
  objectName: string;
  objectId: number;
  appName: string;
  selfTime: number;
  selfTimePercent: number;
  totalTime: number;
  totalTimePercent: number;
  hitCount: number;
  calledBy: string[];
  calls: string[];
  isBuiltin?: boolean;
  lineHotspots?: LineHotspot[];
  costPerHit: number;
  efficiencyScore: number;
  callAmplification?: number;
  sourceLocation?: SourceLocation;
  sourceSnippet?: string;
}

export interface SourceLocation {
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

export interface LineHotspot {
  line: number;
  executionTime: number;
  executionTimePercent: number;
}

export interface DetectedPattern {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  impact: number;
  involvedMethods: string[];
  evidence: string;
  suggestion?: string;
  estimatedSavings?: number;
  savingsExplanation?: string;
}

export interface AIFinding {
  title: string;
  category: "business-logic" | "cross-method" | "anomaly" | "code-fix";
  severity: "critical" | "warning" | "info";
  confidence: "high" | "medium" | "low";
  description: string;
  involvedMethods: string[];
  suggestion: string;
  codeFix?: string;
  evidence: string;
}

export interface CriticalPathStep {
  functionName: string;
  objectType: string;
  objectId: number;
  objectName: string;
  appName: string;
  selfTime: number;
  totalTime: number;
  totalTimePercent: number;
  depth: number;
}

export interface AppBreakdown {
  appName: string;
  appPublisher: string;
  selfTime: number;
  selfTimePercent: number;
  totalTime: number;
  nodeCount: number;
  methods: string[];
}

export interface ObjectBreakdown {
  objectType: string;
  objectName: string;
  objectId: number;
  appName: string;
  selfTime: number;
  selfTimePercent: number;
  methodCount: number;
}

export interface TableBreakdown {
  tableName: string;
  totalSelfTime: number;
  totalSelfTimePercent: number;
  callSiteCount: number;
  hasSetLoadFields: boolean;
  hasFilters: boolean;
}

/** Resolved finding with source location attached */
export interface ResolvedFinding {
  pattern?: DetectedPattern;
  aiFinding?: AIFinding;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  suggestion?: string;
  sourceLocation: SourceLocation;
  methodKey: string;
}
```

- [ ] **Step 2: Create test fixture**

Create `test/fixtures/sample-result.json` with a realistic `AnalysisResult` containing 2-3 hotspots with `sourceLocation`, 2 patterns, and 1 AI finding with `codeFix`. Use realistic AL method names (e.g. `PostSalesLine`, `CalcFields`).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts test/fixtures/sample-result.json
git commit -m "feat: add client-side AnalysisResult types and test fixture"
```

---

## Task 3: SSE API Client

**Files:**
- Create: `src/api/client.ts`, `test/suite/client.test.ts`

- [ ] **Step 1: Write failing test for SSE parsing**

`test/suite/client.test.ts`:

```typescript
import * as assert from "assert";
import { parseSSEChunk } from "../../src/api/client";

suite("SSE Parser", () => {
  test("parses progress event", () => {
    const chunk = 'event: progress\ndata: {"step":"analyzing","message":"Analyzing profile..."}\n\n';
    const events = parseSSEChunk(chunk);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "progress");
    assert.strictEqual(events[0].data.step, "analyzing");
  });

  test("parses done event", () => {
    const chunk = 'event: done\ndata: {"meta":{},"summary":{}}\n\n';
    const events = parseSSEChunk(chunk);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "done");
  });

  test("skips keepalive comments", () => {
    const chunk = ': keepalive\n\nevent: progress\ndata: {"step":"x","message":"y"}\n\n';
    const events = parseSSEChunk(chunk);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "progress");
  });

  test("handles multiple events in one chunk", () => {
    const chunk =
      'event: progress\ndata: {"step":"a","message":"b"}\n\n' +
      'event: progress\ndata: {"step":"c","message":"d"}\n\n';
    const events = parseSSEChunk(chunk);
    assert.strictEqual(events.length, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `parseSSEChunk` not found

- [ ] **Step 3: Implement SSE parser and API client**

`src/api/client.ts`:

```typescript
import { AnalysisResult } from "../types";

export interface SSEEvent {
  type: "progress" | "done" | "error";
  data: any;
}

export function parseSSEChunk(chunk: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const parts = chunk.split("\n\n");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;

    let eventType = "message";
    let data = "";

    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event: ")) eventType = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }

    if (data) {
      try {
        events.push({ type: eventType as SSEEvent["type"], data: JSON.parse(data) });
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return events;
}

export interface AnalyzeOptions {
  serviceUrl: string;
  profilePath: string;
  profileData: Buffer;
  sourceData?: Buffer;
  onProgress?: (step: string, message: string) => void;
}

export async function analyzeProfile(options: AnalyzeOptions): Promise<AnalysisResult> {
  const formData = new FormData();
  formData.append("profile", new Blob([options.profileData]), "profile.alcpuprofile");

  if (options.sourceData) {
    formData.append("source", new Blob([options.sourceData]), "source.zip");
  }

  const response = await fetch(`${options.serviceUrl}/api/analyze?stream=1`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Service returned ${response.status}: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("No response body (streaming not supported)");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AnalysisResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const events = parseSSEChunk(part + "\n\n");
      for (const event of events) {
        if (event.type === "progress" && options.onProgress) {
          options.onProgress(event.data.step, event.data.message);
        } else if (event.type === "done") {
          result = event.data as AnalysisResult;
        } else if (event.type === "error") {
          throw new Error(event.data.error || "Analysis failed");
        }
      }
    }
  }

  if (!result) throw new Error("Stream ended without result");
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts test/suite/client.test.ts
git commit -m "feat: add SSE API client for al-perf service"
```

---

## Task 4: Location Index

**Files:**
- Create: `src/model/location-index.ts`, `test/suite/location-index.test.ts`

- [ ] **Step 1: Write failing test**

`test/suite/location-index.test.ts`:

```typescript
import * as assert from "assert";
import { LocationIndex } from "../../src/model/location-index";
import type { AnalysisResult, MethodBreakdown, DetectedPattern } from "../../src/types";

function makeHotspot(name: string, objType: string, objId: number, filePath?: string): MethodBreakdown {
  return {
    functionName: name,
    objectType: objType,
    objectName: "TestObject",
    objectId: objId,
    appName: "TestApp",
    selfTime: 1000,
    selfTimePercent: 10,
    totalTime: 2000,
    totalTimePercent: 20,
    hitCount: 100,
    calledBy: [],
    calls: [],
    costPerHit: 10,
    efficiencyScore: 0.5,
    sourceLocation: filePath ? { filePath, lineStart: 10, lineEnd: 20 } : undefined,
  };
}

suite("LocationIndex", () => {
  test("resolves pattern involvedMethod to source location", () => {
    const hotspots = [makeHotspot("PostSalesLine", "CodeUnit", 80, "src/Cod80.al")];
    const patterns: DetectedPattern[] = [{
      id: "test",
      severity: "critical",
      title: "Test",
      description: "Test",
      impact: 1000,
      involvedMethods: ["PostSalesLine (CodeUnit 80)"],
      evidence: "test",
    }];

    const index = new LocationIndex(hotspots);
    const resolved = index.resolvePattern(patterns[0]);
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].sourceLocation.filePath, "src/Cod80.al");
  });

  test("returns empty for methods without source", () => {
    const hotspots = [makeHotspot("CalcFields", "Table", 37, undefined)];
    const patterns: DetectedPattern[] = [{
      id: "test",
      severity: "warning",
      title: "Test",
      description: "Test",
      impact: 500,
      involvedMethods: ["CalcFields (Table 37)"],
      evidence: "test",
    }];

    const index = new LocationIndex(hotspots);
    const resolved = index.resolvePattern(patterns[0]);
    assert.strictEqual(resolved.length, 0);
  });

  test("resolves AI finding to source location", () => {
    const hotspots = [makeHotspot("ProcessLines", "CodeUnit", 50100, "src/Cod50100.al")];
    const index = new LocationIndex(hotspots);
    const location = index.resolveMethod("ProcessLines (CodeUnit 50100)");
    assert.ok(location);
    assert.strictEqual(location!.filePath, "src/Cod50100.al");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `LocationIndex` not found

- [ ] **Step 3: Implement LocationIndex**

`src/model/location-index.ts`:

```typescript
import type { MethodBreakdown, SourceLocation, DetectedPattern, AIFinding, ResolvedFinding } from "../types";

export class LocationIndex {
  private index = new Map<string, { location: SourceLocation; hotspot: MethodBreakdown }>();

  constructor(hotspots: MethodBreakdown[]) {
    for (const h of hotspots) {
      if (h.sourceLocation) {
        const key = `${h.functionName} (${h.objectType} ${h.objectId})`;
        this.index.set(key, { location: h.sourceLocation, hotspot: h });
      }
    }
  }

  resolveMethod(methodKey: string): SourceLocation | undefined {
    return this.index.get(methodKey)?.location;
  }

  getHotspot(methodKey: string): MethodBreakdown | undefined {
    return this.index.get(methodKey)?.hotspot;
  }

  resolvePattern(pattern: DetectedPattern): ResolvedFinding[] {
    const results: ResolvedFinding[] = [];
    for (const method of pattern.involvedMethods) {
      const location = this.resolveMethod(method);
      if (location) {
        results.push({
          pattern,
          severity: pattern.severity,
          title: pattern.title,
          description: pattern.description,
          suggestion: pattern.suggestion,
          sourceLocation: location,
          methodKey: method,
        });
      }
    }
    return results;
  }

  resolveAIFinding(finding: AIFinding): ResolvedFinding[] {
    const results: ResolvedFinding[] = [];
    for (const method of finding.involvedMethods) {
      const location = this.resolveMethod(method);
      if (location) {
        results.push({
          aiFinding: finding,
          severity: finding.severity,
          title: finding.title,
          description: finding.description,
          suggestion: finding.suggestion,
          sourceLocation: location,
          methodKey: method,
        });
      }
    }
    return results;
  }

  /** Resolve all patterns and findings into a flat list grouped by file */
  resolveAll(patterns: DetectedPattern[], findings?: AIFinding[]): Map<string, ResolvedFinding[]> {
    const byFile = new Map<string, ResolvedFinding[]>();

    const add = (f: ResolvedFinding) => {
      const file = f.sourceLocation.filePath;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(f);
    };

    for (const p of patterns) {
      for (const r of this.resolvePattern(p)) add(r);
    }
    if (findings) {
      for (const f of findings) {
        for (const r of this.resolveAIFinding(f)) add(r);
      }
    }

    return byFile;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/model/location-index.ts test/suite/location-index.test.ts
git commit -m "feat: add LocationIndex for resolving patterns to source locations"
```

---

## Task 5: Profile Watcher & Discovery

**Files:**
- Create: `src/profile/watcher.ts`, `src/profile/discovery.ts`, `test/suite/discovery.test.ts`

- [ ] **Step 1: Write failing test for discovery**

`test/suite/discovery.test.ts`:

```typescript
import * as assert from "assert";
import { findMatchingZip, resolveWorkspacePath } from "../../src/profile/discovery";
import * as path from "path";

suite("Discovery", () => {
  test("findMatchingZip returns zip with same GUID", () => {
    const profilePath = "/workspace/.snapshots/abc-123.alcpuprofile";
    const zip = findMatchingZip(profilePath);
    // Returns expected path (existence check is separate)
    assert.strictEqual(zip, "/workspace/.snapshots/abc-123.zip");
  });

  test("resolveWorkspacePath joins relative to workspace root", () => {
    const resolved = resolveWorkspacePath("src/Cod50100.al", "/workspace");
    assert.strictEqual(resolved, path.join("/workspace", "src/Cod50100.al"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: Implement discovery.ts**

`src/profile/discovery.ts`:

```typescript
import * as path from "path";
import * as fs from "fs";

/** Given a .alcpuprofile path, return the expected .zip path (same GUID) */
export function findMatchingZip(profilePath: string): string {
  const dir = path.dirname(profilePath);
  const base = path.basename(profilePath, ".alcpuprofile");
  return path.join(dir, base + ".zip");
}

/** Check if matching zip exists on disk */
export function hasMatchingZip(profilePath: string): boolean {
  return fs.existsSync(findMatchingZip(profilePath));
}

/** Resolve a source-relative path to workspace-absolute */
export function resolveWorkspacePath(relativePath: string, workspaceRoot: string): string {
  return path.join(workspaceRoot, relativePath);
}

/** Check if a resolved source file exists */
export function sourceFileExists(relativePath: string, workspaceRoot: string): boolean {
  return fs.existsSync(resolveWorkspacePath(relativePath, workspaceRoot));
}
```

- [ ] **Step 4: Implement watcher.ts**

`src/profile/watcher.ts`:

```typescript
import * as vscode from "vscode";
import * as path from "path";

export class ProfileWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private onNewProfile: (profileUri: vscode.Uri) => void) {}

  start(): void {
    if (this.watcher) return;

    this.watcher = vscode.workspace.createFileSystemWatcher(
      "**/.snapshots/*.alcpuprofile"
    );

    this.watcher.onDidCreate((uri) => {
      this.onNewProfile(uri);
    }, null, this.disposables);
  }

  dispose(): void {
    this.watcher?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/profile/ test/suite/discovery.test.ts
git commit -m "feat: add profile watcher and source discovery"
```

---

## Task 6: Result Store

**Files:**
- Create: `src/model/result-store.ts`

- [ ] **Step 1: Implement result store**

`src/model/result-store.ts`:

```typescript
import * as vscode from "vscode";
import type { AnalysisResult } from "../types";
import { LocationIndex } from "./location-index";

export class ResultStore {
  private result: AnalysisResult | undefined;
  private locationIndex: LocationIndex | undefined;
  private profileKey: string | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<AnalysisResult | undefined>();
  readonly onDidChange = this._onDidChange.event;

  setResult(profilePath: string, result: AnalysisResult): void {
    this.profileKey = profilePath;
    this.result = result;
    this.locationIndex = new LocationIndex(result.hotspots);
    this._onDidChange.fire(result);
  }

  getResult(): AnalysisResult | undefined {
    return this.result;
  }

  getLocationIndex(): LocationIndex | undefined {
    return this.locationIndex;
  }

  getProfileKey(): string | undefined {
    return this.profileKey;
  }

  clear(): void {
    this.result = undefined;
    this.locationIndex = undefined;
    this.profileKey = undefined;
    this._onDidChange.fire(undefined);
  }

  /** Persist to extension storage */
  async save(storage: vscode.Memento): Promise<void> {
    if (this.result && this.profileKey) {
      await storage.update("alPerf.lastResult", {
        profileKey: this.profileKey,
        result: this.result,
      });
    } else {
      await storage.update("alPerf.lastResult", undefined);
    }
  }

  /** Restore from extension storage */
  restore(storage: vscode.Memento): void {
    const saved = storage.get<{ profileKey: string; result: AnalysisResult }>("alPerf.lastResult");
    if (saved) {
      this.setResult(saved.profileKey, saved.result);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/model/result-store.ts
git commit -m "feat: add ResultStore with persistence and change events"
```

---

## Task 7: Diagnostics Provider

**Files:**
- Create: `src/editor/diagnostics.ts`

- [ ] **Step 1: Implement diagnostics provider**

`src/editor/diagnostics.ts`:

```typescript
import * as vscode from "vscode";
import type { ResolvedFinding } from "../types";
import type { ResultStore } from "../model/result-store";
import { resolveWorkspacePath } from "../profile/discovery";

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export class DiagnosticsManager implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];

  constructor(private store: ResultStore, private workspaceRoot: string) {
    this.collection = vscode.languages.createDiagnosticCollection("alPerf");

    this.disposables.push(
      store.onDidChange(() => this.refresh()),
      this.collection
    );
  }

  refresh(): void {
    this.collection.clear();

    const result = this.store.getResult();
    const index = this.store.getLocationIndex();
    if (!result || !index) return;

    const byFile = index.resolveAll(result.patterns, result.aiFindings);

    for (const [relPath, findings] of byFile) {
      const absPath = resolveWorkspacePath(relPath, this.workspaceRoot);
      const uri = vscode.Uri.file(absPath);
      const diagnostics = findings.map((f) => this.toDiagnostic(f));
      this.collection.set(uri, diagnostics);
    }
  }

  private toDiagnostic(finding: ResolvedFinding): vscode.Diagnostic {
    const range = new vscode.Range(
      finding.sourceLocation.lineStart - 1, 0,
      finding.sourceLocation.lineEnd - 1, Number.MAX_SAFE_INTEGER
    );

    const severity = SEVERITY_MAP[finding.severity] ?? vscode.DiagnosticSeverity.Information;
    const diagnostic = new vscode.Diagnostic(range, `${finding.title}: ${finding.description}`, severity);
    diagnostic.source = "AL Perf";

    if (finding.pattern?.id) {
      diagnostic.code = {
        value: finding.pattern.id,
        target: vscode.Uri.parse(`https://alperf.sshadows.dk/patterns#${finding.pattern.id}`),
      };
    }

    if (finding.suggestion) {
      diagnostic.message += `\n\nSuggestion: ${finding.suggestion}`;
    }

    return diagnostic;
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/editor/diagnostics.ts
git commit -m "feat: add DiagnosticsManager for Problems panel integration"
```

---

## Task 8: Editor Decorations

**Files:**
- Create: `src/editor/decorations.ts`

- [ ] **Step 1: Implement decoration provider**

`src/editor/decorations.ts`:

```typescript
import * as vscode from "vscode";
import type { ResolvedFinding } from "../types";
import type { ResultStore } from "../model/result-store";
import { resolveWorkspacePath } from "../profile/discovery";

export class DecorationManager implements vscode.Disposable {
  private criticalDecoration: vscode.TextEditorDecorationType;
  private warningDecoration: vscode.TextEditorDecorationType;
  private infoDecoration: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];

  constructor(private store: ResultStore, private workspaceRoot: string, extensionUri: vscode.Uri) {
    const iconPath = (name: string) => vscode.Uri.joinPath(extensionUri, "resources", "icons", `${name}.svg`);

    this.criticalDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(244, 71, 71, 0.1)",
      gutterIconPath: iconPath("critical").fsPath,
      gutterIconSize: "80%",
      overviewRulerColor: "#f44747",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      isWholeLine: true,
    });

    this.warningDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(204, 167, 0, 0.08)",
      gutterIconPath: iconPath("warning").fsPath,
      gutterIconSize: "80%",
      overviewRulerColor: "#cca700",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      isWholeLine: true,
    });

    this.infoDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(55, 148, 255, 0.06)",
      gutterIconPath: iconPath("info").fsPath,
      gutterIconSize: "80%",
      overviewRulerColor: "#3794ff",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      isWholeLine: true,
    });

    this.disposables.push(
      this.criticalDecoration,
      this.warningDecoration,
      this.infoDecoration,
      vscode.window.onDidChangeActiveTextEditor(() => this.applyToActiveEditor()),
      store.onDidChange(() => this.applyToActiveEditor())
    );
  }

  applyToActiveEditor(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const result = this.store.getResult();
    const index = this.store.getLocationIndex();
    if (!result || !index) {
      this.clearEditor(editor);
      return;
    }

    const byFile = index.resolveAll(result.patterns, result.aiFindings);
    const editorRelPath = vscode.workspace.asRelativePath(editor.document.uri);

    // Find findings for this file
    let findings: ResolvedFinding[] = [];
    for (const [relPath, f] of byFile) {
      const resolvedAbs = resolveWorkspacePath(relPath, this.workspaceRoot);
      if (editor.document.uri.fsPath === resolvedAbs) {
        findings = f;
        break;
      }
    }

    const critical: vscode.DecorationOptions[] = [];
    const warning: vscode.DecorationOptions[] = [];
    const info: vscode.DecorationOptions[] = [];

    for (const f of findings) {
      const range = new vscode.Range(
        f.sourceLocation.lineStart - 1, 0,
        f.sourceLocation.lineEnd - 1, Number.MAX_SAFE_INTEGER
      );

      const hoverMessage = new vscode.MarkdownString();
      hoverMessage.appendMarkdown(`**${f.severity.toUpperCase()}** — ${f.title}\n\n`);
      hoverMessage.appendMarkdown(f.description + "\n\n");
      if (f.suggestion) {
        hoverMessage.appendMarkdown(`*Suggestion:* ${f.suggestion}`);
      }

      const decoration: vscode.DecorationOptions = { range, hoverMessage };

      if (f.severity === "critical") critical.push(decoration);
      else if (f.severity === "warning") warning.push(decoration);
      else info.push(decoration);
    }

    editor.setDecorations(this.criticalDecoration, critical);
    editor.setDecorations(this.warningDecoration, warning);
    editor.setDecorations(this.infoDecoration, info);
  }

  private clearEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this.criticalDecoration, []);
    editor.setDecorations(this.warningDecoration, []);
    editor.setDecorations(this.infoDecoration, []);
  }

  clear(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) this.clearEditor(editor);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/editor/decorations.ts
git commit -m "feat: add editor decorations with gutter icons and hover tooltips"
```

---

## Task 9: CodeLens Provider

**Files:**
- Create: `src/editor/codelens.ts`

- [ ] **Step 1: Implement CodeLens provider**

`src/editor/codelens.ts`:

```typescript
import * as vscode from "vscode";
import type { ResultStore } from "../model/result-store";
import type { ResolvedFinding } from "../types";
import { resolveWorkspacePath } from "../profile/discovery";

export class PerfCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor(private store: ResultStore, private workspaceRoot: string) {
    this.disposables.push(
      store.onDidChange(() => this._onDidChange.fire()),
      this._onDidChange
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const result = this.store.getResult();
    const index = this.store.getLocationIndex();
    if (!result || !index) return [];

    const byFile = index.resolveAll(result.patterns, result.aiFindings);

    // Find findings for this document
    let findings: ResolvedFinding[] = [];
    for (const [relPath, f] of byFile) {
      const resolvedAbs = resolveWorkspacePath(relPath, this.workspaceRoot);
      if (document.uri.fsPath === resolvedAbs) {
        findings = f;
        break;
      }
    }

    if (findings.length === 0) return [];

    // Group by procedure (lineStart)
    const byProcedure = new Map<number, ResolvedFinding[]>();
    for (const f of findings) {
      const line = f.sourceLocation.lineStart;
      if (!byProcedure.has(line)) byProcedure.set(line, []);
      byProcedure.get(line)!.push(f);
    }

    const lenses: vscode.CodeLens[] = [];
    for (const [lineStart, procedureFindings] of byProcedure) {
      const range = new vscode.Range(lineStart - 1, 0, lineStart - 1, 0);
      const count = procedureFindings.length;
      const hasCodeFix = procedureFindings.some((f) => f.aiFinding?.codeFix);

      const title = `\u26A0 ${count} performance issue${count > 1 ? "s" : ""}`;
      const command: vscode.Command = hasCodeFix
        ? { title: `${title} \u00B7 Show fixes`, command: "alPerf.showFixes", arguments: [procedureFindings] }
        : { title, command: "alPerf.showPanel" };

      lenses.push(new vscode.CodeLens(range, command));
    }

    return lenses;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/editor/codelens.ts
git commit -m "feat: add CodeLens provider for performance issues"
```

---

## Task 10: Fix Preview (Diff Editor)

**Files:**
- Create: `src/editor/fix-preview.ts`

- [ ] **Step 1: Implement fix preview**

`src/editor/fix-preview.ts`:

```typescript
import * as vscode from "vscode";
import * as fs from "fs";
import type { ResolvedFinding } from "../types";
import { resolveWorkspacePath } from "../profile/discovery";

/** Manages virtual document content for fix previews. Register once at activation. */
export class FixPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private contents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider("alperf-fix", this);
  }

  setContent(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) || "";
  }

  dispose(): void {
    this.registration.dispose();
    this._onDidChange.dispose();
  }
}

export async function showFixPreview(
  findings: ResolvedFinding[],
  workspaceRoot: string,
  provider: FixPreviewProvider
): Promise<void> {
  const fixable = findings.find((f) => f.aiFinding?.codeFix);
  if (!fixable || !fixable.aiFinding?.codeFix) {
    vscode.window.showInformationMessage("No automated fix available. See suggestion in the tooltip.");
    return;
  }

  const relPath = fixable.sourceLocation.filePath;
  const absPath = resolveWorkspacePath(relPath, workspaceRoot);

  if (!fs.existsSync(absPath)) {
    vscode.window.showErrorMessage(`Source file not found: ${relPath}`);
    return;
  }

  const originalContent = fs.readFileSync(absPath, "utf-8");
  const lines = originalContent.split("\n");

  const before = lines.slice(0, fixable.sourceLocation.lineStart - 1);
  const after = lines.slice(fixable.sourceLocation.lineEnd);
  const fixedContent = [...before, fixable.aiFinding.codeFix, ...after].join("\n");

  const fixedUri = vscode.Uri.parse(
    `alperf-fix:${relPath}?fix=${encodeURIComponent(fixable.title)}&t=${Date.now()}`
  );
  provider.setContent(fixedUri, fixedContent);

  const originalUri = vscode.Uri.file(absPath);
  const title = `${fixable.title} — Suggested Fix`;
  await vscode.commands.executeCommand("vscode.diff", originalUri, fixedUri, title);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/editor/fix-preview.ts
git commit -m "feat: add fix preview with diff editor"
```

---

## Task 11: TreeView Provider

**Files:**
- Create: `src/views/tree-provider.ts`

- [ ] **Step 1: Implement tree data provider**

`src/views/tree-provider.ts`:

```typescript
import * as vscode from "vscode";
import type { ResultStore } from "../model/result-store";
import type { AnalysisResult, DetectedPattern, MethodBreakdown } from "../types";
import { resolveWorkspacePath } from "../profile/discovery";

type TreeItem = PatternItem | MethodItem | HotspotItem;

class PatternItem extends vscode.TreeItem {
  constructor(public readonly pattern: DetectedPattern) {
    super(pattern.title, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = pattern.severity;
    this.tooltip = pattern.description;
    this.iconPath = new vscode.ThemeIcon(
      pattern.severity === "critical" ? "circle-filled" : pattern.severity === "warning" ? "warning" : "info",
      new vscode.ThemeColor(
        pattern.severity === "critical" ? "testing.iconFailed" : pattern.severity === "warning" ? "list.warningForeground" : "list.deactivatedModeForeground"
      )
    );
  }
}

class MethodItem extends vscode.TreeItem {
  constructor(methodKey: string, filePath: string | undefined, lineStart: number | undefined, workspaceRoot: string) {
    super(methodKey, vscode.TreeItemCollapsibleState.None);

    if (filePath && lineStart !== undefined) {
      const absPath = resolveWorkspacePath(filePath, workspaceRoot);
      this.description = `:${lineStart}`;
      this.command = {
        command: "vscode.open",
        title: "Go to source",
        arguments: [
          vscode.Uri.file(absPath),
          { selection: new vscode.Range(lineStart - 1, 0, lineStart - 1, 0) },
        ],
      };
      this.iconPath = new vscode.ThemeIcon("symbol-method");
    } else {
      this.description = "(no source)";
      this.iconPath = new vscode.ThemeIcon("symbol-method");
    }
  }
}

class HotspotItem extends vscode.TreeItem {
  constructor(hotspot: MethodBreakdown, workspaceRoot: string) {
    super(hotspot.functionName, vscode.TreeItemCollapsibleState.None);
    this.description = `${hotspot.selfTimePercent.toFixed(1)}%`;
    this.tooltip = `${hotspot.objectType} "${hotspot.objectName}" · ${hotspot.hitCount} hits`;

    if (hotspot.sourceLocation) {
      const absPath = resolveWorkspacePath(hotspot.sourceLocation.filePath, workspaceRoot);
      this.command = {
        command: "vscode.open",
        title: "Go to source",
        arguments: [
          vscode.Uri.file(absPath),
          { selection: new vscode.Range(hotspot.sourceLocation.lineStart - 1, 0, hotspot.sourceLocation.lineStart - 1, 0) },
        ],
      };
    }

    this.iconPath = new vscode.ThemeIcon("flame");
  }
}

export class PatternTreeProvider implements vscode.TreeDataProvider<TreeItem>, vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor(private store: ResultStore, private workspaceRoot: string) {
    this.disposables.push(
      store.onDidChange(() => this._onDidChange.fire()),
      this._onDidChange
    );
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    const result = this.store.getResult();
    if (!result) return [];

    if (!element) {
      // Root: patterns sorted by severity
      const order = { critical: 0, warning: 1, info: 2 };
      return [...result.patterns]
        .sort((a, b) => order[a.severity] - order[b.severity])
        .map((p) => new PatternItem(p));
    }

    if (element instanceof PatternItem) {
      const index = this.store.getLocationIndex();
      return element.pattern.involvedMethods.map((m) => {
        const loc = index?.resolveMethod(m);
        return new MethodItem(m, loc?.filePath, loc?.lineStart, this.workspaceRoot);
      });
    }

    return [];
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

export class HotspotTreeProvider implements vscode.TreeDataProvider<HotspotItem>, vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor(private store: ResultStore, private workspaceRoot: string, private maxItems: number) {
    this.disposables.push(
      store.onDidChange(() => this._onDidChange.fire()),
      this._onDidChange
    );
  }

  getTreeItem(element: HotspotItem): vscode.TreeItem {
    return element;
  }

  getChildren(): HotspotItem[] {
    const result = this.store.getResult();
    if (!result) return [];

    return result.hotspots
      .slice(0, this.maxItems)
      .map((h) => new HotspotItem(h, this.workspaceRoot));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/views/tree-provider.ts
git commit -m "feat: add TreeView providers for patterns and hotspots"
```

---

## Task 12: Webview Summary Panel

**Files:**
- Create: `src/views/summary-panel.ts`, `src/views/summary-panel.html`

- [ ] **Step 1: Create HTML template**

`src/views/summary-panel.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
      margin: 0;
    }
    .banner {
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .score-ring {
      width: 48px; height: 48px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: bold; font-size: 14px;
    }
    .score-good { background: conic-gradient(var(--vscode-testing-iconPassed) 0% var(--score-pct), var(--vscode-panel-border) var(--score-pct) 100%); }
    .score-warn { background: conic-gradient(var(--vscode-list-warningForeground) 0% var(--score-pct), var(--vscode-panel-border) var(--score-pct) 100%); }
    .score-bad { background: conic-gradient(var(--vscode-testing-iconFailed) 0% var(--score-pct), var(--vscode-panel-border) var(--score-pct) 100%); }
    .score-inner {
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--vscode-editor-background);
      display: flex; align-items: center; justify-content: center;
    }
    .one-liner { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .counts {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .count {
      flex: 1; text-align: center; padding: 10px;
      border-right: 1px solid var(--vscode-panel-border);
    }
    .count:last-child { border-right: none; }
    .count-num { font-size: 20px; font-weight: bold; }
    .count-label { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .critical { color: var(--vscode-testing-iconFailed); }
    .warning { color: var(--vscode-list-warningForeground); }
    .info { color: var(--vscode-textLink-foreground); }
    .hotspots { padding: 12px 16px; }
    .hotspots-title { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin-bottom: 8px; letter-spacing: 0.5px; }
    .hotspot { margin-bottom: 8px; }
    .hotspot-row { display: flex; justify-content: space-between; align-items: center; }
    .hotspot-name { font-size: 13px; cursor: pointer; color: var(--vscode-textLink-foreground); }
    .hotspot-name:hover { text-decoration: underline; }
    .hotspot-detail { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .bar { height: 3px; background: var(--vscode-panel-border); border-radius: 2px; margin-top: 4px; }
    .bar-fill { height: 3px; border-radius: 2px; }
    .meta { padding: 12px 16px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
    .meta-row { display: flex; justify-content: space-between; margin-bottom: 4px; }
    .meta-value { color: var(--vscode-foreground); }
    .empty { display: flex; align-items: center; justify-content: center; min-height: 200px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div id="content">
    <div class="empty">No analysis results yet. Run "AL Perf: Analyze Performance Profile" to start.</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "update") renderResult(msg.result, msg.maxHotspots || 10);
      else if (msg.type === "clear") renderEmpty();
    });

    function renderResult(r, maxHotspots) {
      const score = r.summary.healthScore;
      const scoreClass = score >= 70 ? "score-good" : score >= 40 ? "score-warn" : "score-bad";

      let html = `
        <div class="banner">
          <div class="score-ring ${scoreClass}" style="--score-pct: ${score}%">
            <div class="score-inner">${score}</div>
          </div>
          <div>
            <div style="font-weight: 600;">Health Score: ${score}/100</div>
            <div class="one-liner">${r.summary.oneLiner}</div>
          </div>
        </div>
        <div class="counts">
          <div class="count"><div class="count-num critical">${r.summary.patternCount.critical}</div><div class="count-label">Critical</div></div>
          <div class="count"><div class="count-num warning">${r.summary.patternCount.warning}</div><div class="count-label">Warning</div></div>
          <div class="count"><div class="count-num info">${r.summary.patternCount.info}</div><div class="count-label">Info</div></div>
        </div>
        <div class="hotspots">
          <div class="hotspots-title">Top Hotspots</div>
      `;

      for (const h of r.hotspots.slice(0, maxHotspots)) {
        const pct = h.selfTimePercent;
        const color = pct > 25 ? "var(--vscode-testing-iconFailed)" : pct > 10 ? "var(--vscode-list-warningForeground)" : "var(--vscode-textLink-foreground)";
        html += `
          <div class="hotspot">
            <div class="hotspot-row">
              <span class="hotspot-name" onclick="navigateTo('${h.sourceLocation?.filePath || ""}', ${h.sourceLocation?.lineStart || 0})">${h.functionName}</span>
              <span style="font-size: 12px; font-weight: 600; color: ${color};">${pct.toFixed(1)}%</span>
            </div>
            <div class="hotspot-detail">${h.objectType} "${h.objectName}" · ${h.hitCount} hits</div>
            <div class="bar"><div class="bar-fill" style="width: ${pct}%; background: ${color};"></div></div>
          </div>
        `;
      }

      html += `</div>`;
      html += `
        <div class="meta">
          <div class="meta-row"><span>Profile type</span><span class="meta-value">${r.meta.profileType}</span></div>
          <div class="meta-row"><span>Duration</span><span class="meta-value">${(r.meta.totalDuration / 1000000).toFixed(1)}s</span></div>
          <div class="meta-row"><span>Source</span><span class="meta-value">${r.meta.sourceAvailable ? "Available" : "Not available"}</span></div>
          <div class="meta-row"><span>Confidence</span><span class="meta-value">${r.meta.confidenceScore}%</span></div>
        </div>
      `;

      document.getElementById("content").innerHTML = html;
    }

    function renderEmpty() {
      document.getElementById("content").innerHTML = '<div class="empty">No analysis results yet.</div>';
    }

    function navigateTo(filePath, line) {
      if (filePath && line) {
        vscode.postMessage({ type: "navigate", filePath, line });
      }
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Implement summary panel manager**

`src/views/summary-panel.ts`:

```typescript
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { ResultStore } from "../model/result-store";
import type { AnalysisResult } from "../types";
import { resolveWorkspacePath } from "../profile/discovery";
import { getMaxHotspots } from "../config";

export class SummaryPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private store: ResultStore,
    private workspaceRoot: string,
    private extensionUri: vscode.Uri
  ) {
    this.disposables.push(
      store.onDidChange((result) => {
        if (result) this.update(result);
        else this.clear();
      })
    );
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "alPerf.summary",
      "AL Perf",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const htmlPath = path.join(this.extensionUri.fsPath, "dist", "views", "summary-panel.html");
    this.panel.webview.html = fs.readFileSync(htmlPath, "utf-8");

    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.type === "navigate" && msg.filePath && msg.line) {
          const absPath = resolveWorkspacePath(msg.filePath, this.workspaceRoot);
          const uri = vscode.Uri.file(absPath);
          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(msg.line - 1, 0, msg.line - 1, 0),
          });
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, null, this.disposables);

    // If we already have a result, show it
    const result = this.store.getResult();
    if (result) this.update(result);
  }

  private update(result: AnalysisResult): void {
    this.panel?.webview.postMessage({
      type: "update",
      result,
      maxHotspots: getMaxHotspots(),
    });
  }

  private clear(): void {
    this.panel?.webview.postMessage({ type: "clear" });
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/views/summary-panel.ts src/views/summary-panel.html
git commit -m "feat: add Webview summary panel with health score and hotspots"
```

---

## Task 13: Wire Everything Together

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Wire all components in extension.ts**

Replace `src/extension.ts` with the full wiring:

```typescript
import * as vscode from "vscode";
import * as fs from "fs";
import { getServiceUrl, getAutoDetect, getMaxHotspots } from "./config";
import { analyzeProfile } from "./api/client";
import { ResultStore } from "./model/result-store";
import { ProfileWatcher } from "./profile/watcher";
import { findMatchingZip, hasMatchingZip } from "./profile/discovery";
import { DiagnosticsManager } from "./editor/diagnostics";
import { DecorationManager } from "./editor/decorations";
import { PerfCodeLensProvider } from "./editor/codelens";
import { FixPreviewProvider, showFixPreview } from "./editor/fix-preview";
import { PatternTreeProvider, HotspotTreeProvider } from "./views/tree-provider";
import { SummaryPanel } from "./views/summary-panel";

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const store = new ResultStore();
  store.restore(context.workspaceState);

  // Views
  const summaryPanel = new SummaryPanel(store, workspaceRoot, context.extensionUri);
  const patternTree = new PatternTreeProvider(store, workspaceRoot);
  const hotspotTree = new HotspotTreeProvider(store, workspaceRoot, getMaxHotspots());

  vscode.window.registerTreeDataProvider("alPerf.patterns", patternTree);
  vscode.window.registerTreeDataProvider("alPerf.hotspots", hotspotTree);

  // Editor integrations
  const diagnostics = new DiagnosticsManager(store, workspaceRoot);
  const decorations = new DecorationManager(store, workspaceRoot, context.extensionUri);
  const codeLensProvider = new PerfCodeLensProvider(store, workspaceRoot);
  const fixProvider = new FixPreviewProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "al" }, codeLensProvider)
  );

  // Profile watcher
  const watcher = new ProfileWatcher((uri) => {
    vscode.window
      .showInformationMessage("New performance profile detected. Analyze?", "Analyze")
      .then((choice) => {
        if (choice === "Analyze") runAnalysis(uri.fsPath);
      });
  });

  if (getAutoDetect()) watcher.start();

  // Core analysis function
  async function runAnalysis(profilePath: string): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "AL Perf", cancellable: false },
      async (progress) => {
        try {
          progress.report({ message: "Uploading profile..." });

          const profileData = Buffer.from(fs.readFileSync(profilePath));
          const zipPath = findMatchingZip(profilePath);
          const sourceData = hasMatchingZip(profilePath)
            ? Buffer.from(fs.readFileSync(zipPath))
            : undefined;

          const result = await analyzeProfile({
            serviceUrl: getServiceUrl(),
            profilePath,
            profileData,
            sourceData,
            onProgress: (step, message) => {
              progress.report({ message });
            },
          });

          store.setResult(profilePath, result);
          await store.save(context.workspaceState);
          summaryPanel.show();
        } catch (err: any) {
          vscode.window.showErrorMessage(`AL Perf analysis failed: ${err.message}`);
        }
      }
    );
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("alPerf.analyze", async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "AL CPU Profile": ["alcpuprofile"] },
      });
      if (files?.[0]) runAnalysis(files[0].fsPath);
    }),

    vscode.commands.registerCommand("alPerf.generateAndAnalyze", async () => {
      try {
        await vscode.commands.executeCommand("al.generateCpuProfileFile");
        // The watcher will pick up the new file
        vscode.window.showInformationMessage("Profile generation started. The analysis will begin when the profile is ready.");
      } catch {
        vscode.window.showErrorMessage("AL Language extension required for profile generation.");
      }
    }),

    vscode.commands.registerCommand("alPerf.clearResults", () => {
      store.clear();
      diagnostics.clear();
      decorations.clear();
      store.save(context.workspaceState);
    }),

    vscode.commands.registerCommand("alPerf.showPanel", () => {
      summaryPanel.show();
    }),

    vscode.commands.registerCommand("alPerf.showFixes", (findings) => {
      showFixPreview(findings, workspaceRoot, fixProvider);
    })
  );

  // Disposables
  context.subscriptions.push(store, summaryPanel, patternTree, hotspotTree, diagnostics, decorations, codeLensProvider, fixProvider, watcher);
}

export function deactivate() {}
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire all components together in extension entry point"
```

---

## Task 14: Manual Integration Test

**Files:** None (testing only)

- [ ] **Step 1: Launch Extension Host**

Press F5 in VSCode with the al-perf-vscode workspace open. A new Extension Development Host window opens.

- [ ] **Step 2: Open an AL project**

Open a workspace that contains `app.json` and `.snapshots/*.alcpuprofile` (e.g. `H:\Dropbox\Blog\AL-FlamegraphApp`).

- [ ] **Step 3: Verify activation**

Check the Output panel for "AL Perf extension activated".

- [ ] **Step 4: Run analysis**

Command Palette → `AL Perf: Analyze Performance Profile` → select the `.alcpuprofile` file.

- [ ] **Step 5: Verify all integration points**

1. Progress notification appears with streaming messages
2. Summary panel opens with health score, pattern counts, hotspots
3. Activity Bar shows AL Perf icon with patterns and hotspots trees
4. Open a source file referenced in the results — check for gutter decorations, line highlights, hover tooltips
5. Check Problems panel for "AL Perf" diagnostics
6. Check CodeLens above affected procedures
7. If a code fix is available, click "Show fixes" and verify diff editor opens

- [ ] **Step 6: Test clear command**

Command Palette → `AL Perf: Clear Results` — verify all decorations, diagnostics, and panel content are cleared.

- [ ] **Step 7: Commit any fixes**

Fix any issues found during manual testing and commit.

```bash
git add -A
git commit -m "fix: integration test fixes"
```

---

## Task 15: Polish and Cleanup

- [ ] **Step 1: Add CLAUDE.md for the extension repo**

Create `CLAUDE.md` with project overview, build/test commands, and architecture notes.

- [ ] **Step 2: Add .superpowers to .gitignore in al-perf**

If not already there, add `.superpowers/` to `U:\Git\al-perf\.gitignore`.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: add project documentation"
```
