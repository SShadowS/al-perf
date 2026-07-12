# `--list-tenants` Discovery Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ISV onboarding for the multi-tenant split is blocked on hand-authoring tenantMap entries (live fleet showed ~114 customer tenants). `pull-telemetry --list-tenants` discovers the AAD tenants emitting signals and prints paste-ready map entries.

**Architecture:** One new lightweight KQL (distinct tenants + environments + row counts over the window), one new read-only mode on the existing `pull-telemetry` command. No DB access, no evaluation, no batch. Mapped-status comes from the already-loaded config's tenantMap.

**Tech Stack:** Bun, TypeScript, bun:test — al-perf conventions (tabs, biome, TDD).

## Global Constraints

- Tabs; biome clean; `bunx tsc --noEmit` clean.
- TDD failing-test-first. `AI_DISABLED=1 bun test <file>`; full suite once before the final commit.
- Commit trailer:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- Zero new deps; injectable fetchImpl; API key discipline unchanged (env-name indirection, x-api-key header only).
- Non-list modes byte-identical (no changes to existing KQL constants or pull paths).
- AAD tenant ids and environment names in output are printed VERBATIM (terminal/JSON context, single-escape discipline) — but the paste-ready map stub must emit syntactically valid JSON (JSON.stringify each key).

## Design Decisions (locked)

- **D1 — One mode flag:** `pull-telemetry --list-tenants` is mutually exclusive with `--split-by-customer`, `--out`, `--stream`, `--profile-id` (usage error, exit 2, zero fetches, message naming the conflict).
- **D2 — KQL:** one query across the configured `--signals` (default RT0018,RT0005) and `--since` window:
  `traces | where timestamp > datetime({since}) | where customDimensions.eventId in ({signals}) [extension filter if --app-extension-id given — NO: keep current behavior, the puller already scopes by App Insights app, not extension] | summarize rows=count(), environments=make_set(tostring(customDimensions.environmentName)) by aadTenantId=tostring(customDimensions.aadTenantId) | order by rows desc`
  (signals injected via the existing validated-signal splice; since via the existing ISO canonicalization).
- **D3 — Output:** text = table (aadTenantId, rows, environments CSV, mapped→tenant-code or "(unmapped)", with empty aadTenantId rendered "(none)"); json = `{tenants: [{aadTenantId, rows, environments, mappedTo}], unmappedCount}`. After the text table, print a paste-ready stub for UNMAPPED GUID-shaped tenants only:
  ```json
  "tenantMap": {
  	"<guid>": "TODO-tenant-code",
  	...
  }
  ```
  Non-GUID ids (e.g. `"common"`, `""`) appear in the table but never in the stub (the loader would reject them).
- **D4 — mappedTo** resolves against the merged config's `telemetry.tenantMap` (lowercased lookup, same as the splitter).

---

### Task 1: The whole feature

**Files:**
- Modify: `src/lifecycle/appinsights.ts` (add `listTenants(opts, fetchImpl?): Promise<TenantDiscovery[]>` + the KQL builder)
- Modify: `src/cli/commands/lifecycle.ts` (flag, exclusivity guard, output rendering)
- Modify: `docs/telemetry-recipe.md` (onboarding section: run --list-tenants, paste stub, fill codes, re-run split — replaces the hand-authoring framing in the ISV section)
- Test: `test/lifecycle/appinsights.test.ts`, `test/lifecycle/cli.test.ts`

**Interfaces:**

```typescript
export interface TenantDiscovery {
	aadTenantId: string; // verbatim, may be "" or non-GUID
	rows: number;
	environments: string[]; // make_set result, order not guaranteed
}
export function listTenants(
	opts: Pick<PullOptions, "appId" | "apiKeyEnv" | "since" | "signals">,
	fetchImpl?: typeof fetch,
): Promise<TenantDiscovery[]>;
```

Behavior tests (mocked fetch):
- [ ] KQL contains summarize-by aadTenantId + make_set(environmentName); signals validated/spliced via the existing path; since canonicalized; x-api-key header only; missing env var → error naming it, zero fetches.
- [ ] Rows map by column NAME; make_set arrives as a JSON array cell — parse defensively (string cell → JSON.parse with fallback to [String(cell)]).
- [ ] CLI: exclusivity guard for each conflicting flag (exit 2, zero fetches); text table renders "(none)" for empty id and "(unmapped)" vs mapped code (config with one mapped GUID proves D4 lowercase lookup); stub lists ONLY unmapped GUID-shaped ids, is valid JSON (parse it in the test), and appears AFTER the table; json format shape exact.
- [ ] Docs: onboarding subsection in the ISV multi-tenant section; flag table row; example output trimmed and realistic.
- [ ] Full suite + tsc + biome. Commit — `feat(telemetry): pull-telemetry --list-tenants discovery for tenantMap onboarding`

---

## Self-Review Notes
- Single task: one feature, one file-pair, one review gate — splitting further would gate nothing meaningful.
- The stub emitting only GUID-shaped ids means the paste can never be rejected by the loader's GUID validation; non-GUID noise ("common") stays visible in the table so operators know it exists (and gets skipped by design at split time).
- No schema/wire/state changes anywhere.
