---
name: continia-deploy
description: Compile and deploy AL code to a BC environment. Handles single-app and multi-app deploys with topological dependency ordering. Use when (1) AL code was changed and needs deploying, (2) the user asks to compile and publish, (3) a test fix needs deploying before re-running tests, or (4) a fresh environment needs all apps deployed. Invoke continia-env-setup first if no envId is available.
---

# Deploy AL Code

Compile and publish AL apps to a running BC environment.

The CLI is located at `.tools/continia.exe`.

## Prerequisites

A running environment ID. If unavailable, invoke `continia-env-setup` first.

## Strategy Selection

**Single app, deps already published:**
```bash
continia deploy <envId> <appPath> --json
```

**Single app with local dependencies (or fresh env):**
```bash
continia deploy <envId> <appPath> --with-deps --json
```

**All workspace apps:**
```bash
continia deploy <envId> --all --workspace-root <sessionRoot> --json
```

**Override schema sync mode** (default: Synchronize; options: Synchronize, ForceSync, Recreate):
```bash
continia deploy <envId> <appPath> --sync-mode ForceSync --json
```

## Result Interpretation

JSON output is an array per app:
```json
[{"app": "Continia Software_Continia Core", "compiled": true, "published": true}]
```

On failure, the `error` field contains details:
- **Missing symbols** -- invoke `continia-deps` to download dependencies, then retry
- **AL syntax errors** -- fix the code and re-deploy
- **"App is already installed"** -- add `--force` or increment the version
- **Schema sync errors** -- retry with `--sync-mode ForceSync` (or `Recreate` as last resort, which drops and recreates tables)
- **Connection refused** -- environment may have stopped; re-run `continia-env-setup`

## Standalone Operations

Compile only (no publish):
```bash
continia compile <appPath> --json
```

Compile uses the AL VS Code extension's bundled `alc.exe` (matched against analyzer DLLs by construction — no version mismatch). Override with `CONTINIA_ALC_PATH=<path>`. Without an AL extension installed, falls back to altool's `al compile` and warns on stderr — analyzers may fail to load in that mode.

Code analyzers (CodeCop, UICop, AppSourceCop, PerTenantExtensionCop, BCLinterCop) are auto-loaded from `<appPath>/.vscode/settings.json` (`al.codeAnalyzers` array). Standard placeholders (`${CodeCop}`, `${analyzerFolder}BusinessCentral.LinterCop.dll`, etc.) resolve against the same AL extension. Missing DLLs warn on stderr and skip — compile still runs.

Publish a pre-built .app file:
```bash
continia publish <envId> <appFile> --json
continia publish <envId> <appFile> --sync-mode ForceSync --json
```

## Gotchas

- **Deploy from the correct working directory** — The CLI discovers apps from the cwd. Run deploy from within the app's parent directory (e.g. `continia deploy <envId> Cloud` from the `DocumentOutput` dir). Passing full absolute paths like `U:\Git\...\DocumentOutput\Cloud` fails with "No app.json found."
- **`--all` deploys too much** — `--all --workspace-root` discovers all apps in the workspace including BC base apps (209+ apps in DO.Support). Deploy specific apps instead of using `--all`.

## Common Pattern: Fix-and-Deploy

1. Fix the AL code
2. `continia deploy <envId> <appPath> --json`
3. If compile fails, fix errors and retry
4. Once published, invoke `continia-test` to verify
