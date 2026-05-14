---
name: continia-deps
description: Install external dependencies on a BC environment and download symbol packages for AL compilation. Use when (1) compilation fails with missing symbol or reference errors, (2) a fresh environment needs base apps installed before deploying, (3) the user asks to install or update dependencies, or (4) .alpackages is empty or outdated.
---

# Manage Dependencies

The CLI is located at `.tools/continia.exe`.

Two distinct operations:

## Install on Environment

Install external app packages on the BC environment (runtime dependencies):
```bash
continia deps install <envId> <appPath> --json
```

Reads `app.json`, looks up each dependency in the DemoPortal app catalog, installs matches on the environment.

## Download Symbols

Download `.app` symbol files to `.alpackages` (compile-time dependencies):
```bash
continia deps download <envId> <appPath> --json
```

Reads `app.json`, downloads symbol packages into `<appPath>/.alpackages/`.

## Dependency Tree

Visualize the dependency graph without installing or downloading:
```bash
continia deps tree --workspace-root .
continia deps tree <appPath> --workspace-root .
```

## Fresh Environment Setup

1. Invoke `continia-env-setup` to get a running env
2. Install deps in dependency order:
   ```bash
   continia deps install <envId> Core/Cloud --json
   continia deps install <envId> DeliveryNetwork/Cloud --json
   continia deps install <envId> DocumentOutput/Cloud --json
   ```
3. Download symbols:
   ```bash
   continia deps download <envId> Core/Cloud --json
   continia deps download <envId> DeliveryNetwork/Cloud --json
   continia deps download <envId> DocumentOutput/Cloud --json
   ```
4. Invoke `continia-deploy` to build and publish

## Fixing Missing Symbol Errors

1. `continia deps download <envId> <appPath> --json`
2. `continia compile <appPath> --json`
