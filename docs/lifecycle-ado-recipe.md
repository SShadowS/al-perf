# Azure DevOps Work Items from the al-perf digest — the `azureDevOps` sink

## What it is

The built-in `azureDevOps` sink routes lifecycle findings to Azure DevOps
Work Items, the same way the built-in `github` sink routes them to GitHub
Issues. Both are configured under `sinks` in
`.al-perf/lifecycle.config.json`, and **the trigger config is shared** —
`enabled`, `autoFile`, `autoFileMinSeverity`, `autoFileAfterRuns`,
`autoClose`, and `reopenOnRecurrence` mean exactly the same thing under
`sinks.azureDevOps` as they do under `sinks.github` (see
[docs/lifecycle-gh-recipe.md](lifecycle-gh-recipe.md) for the semantics of
each). Only the destination fields — org/project/work item type/state
names — are Azure DevOps-specific.

`lifecycle sync` evaluates each enabled sink's trigger rules independently
and drains each sink's outbox independently — a tenant can run GitHub only,
Azure DevOps only, or both at once. See "Both sinks at once", below.

## PAT creation — least privilege

Create a Personal Access Token scoped as narrowly as possible:

- **Scope: Work Items (Read & Write). Nothing else.** The sink only ever
  creates work items, comments on them, and transitions their state — it
  never touches repos, pipelines, or other Azure DevOps surfaces.
- Scope the PAT to the target **organization** (or, if your ADO org
  supports it, the target project) — not "All accessible organizations".
- Give it an expiry and rotate it; a long-lived, wide-scoped PAT is a
  standing risk.

Store the PAT in an environment variable. **The config file names the
env var, never the PAT itself** — `sinks.azureDevOps.tokenEnv` (default
`AZDO_PAT`). The sink reads `process.env[tokenEnv]` at delivery time only;
it is never written to the config file, logged, or included in any error
message. A missing env var fails the sync closed with a message that names
the env var and nothing else — see
[docs/lifecycle-gh-recipe.md](lifecycle-gh-recipe.md)'s token-scopes section
for the equivalent GitHub discipline.

## The config block

`.al-perf/lifecycle.config.json`:

```json
{
	"sinks": {
		"azureDevOps": {
			"enabled": true,
			"org": "my-org",
			"project": "MyProject",
			"tokenEnv": "AZDO_PAT",
			"workItemType": "Bug",
			"areaPath": "MyProject\\Performance",
			"tags": ["al-perf"],
			"tagsAllowList": ["al-perf", "performance", "regression"],
			"closedState": "Closed",
			"reopenState": "Active",
			"autoFile": false,
			"autoFileMinSeverity": "critical",
			"autoFileAfterRuns": 2,
			"autoClose": false,
			"reopenOnRecurrence": false
		}
	}
}
```

Field reference:

| Field | Required | Default | Notes |
|---|---|---|---|
| `enabled` | yes | — | Sink is inert unless `true`. |
| `org` | yes | — | `dev.azure.com/{org}`. |
| `project` | yes | — | Target project name. |
| `tokenEnv` | no | `AZDO_PAT` | Env var holding the PAT. |
| `workItemType` | no | `Bug` | e.g. `Bug`, `Issue`, `Task` — must exist in your process template. |
| `areaPath` | no | unset | Optional `/fields/System.AreaPath`; unset means the field is left unset, not defaulted. |
| `tags` | no | `["al-perf"]` | `System.Tags` applied to created work items, filtered by `tagsAllowList`. |
| `tagsAllowList` | no | `["al-perf", "performance", "regression"]` | Same allow-list discipline as `sinks.github.labelsAllowList`. |
| `closedState` | no | `"Closed"` | State a work item transitions to on auto-close. Process-template-dependent — see the table below. |
| `reopenState` | no | `"Active"` | State a work item transitions to on `reopenOnRecurrence`. Process-template-dependent. |
| `autoFile` / `autoFileMinSeverity` / `autoFileAfterRuns` / `autoClose` / `reopenOnRecurrence` | no | same as github | Shared trigger fields — see the gh-recipe. |

This example is not just illustrative — it is validated through
`loadSinksConfig` (the same fail-closed loader `lifecycle sync` uses) as
part of this repo's test suite, so a field name or type drifting from what
the loader actually accepts would be caught here, not just in prose.

## Process-template state names

`closedState`/`reopenState` default to `"Closed"`/`"Active"`, which are the
Agile process template's names. Azure DevOps process templates differ in
their state machines — set these two fields to match your project's actual
template, or the close/reopen PATCH will target a state name that doesn't
exist in your process and fail:

| Process template | `closedState` | `reopenState` |
|---|---|---|
| Agile (default) | `Closed` | `Active` |
| Scrum | `Done` | `New` |
| Basic | `Done` | `To Do` |

If your project uses a customized or inherited process template with
renamed states, use the state names from that template instead.

## Digest-first posture

Same defaults as the GitHub sink: `autoFile: false` and `autoClose: false`
out of the box. With auto-filing off, the sink only comments on and
transitions work items that already have an issue mapping — nothing gets
auto-created until you deliberately turn `autoFile` on for a tenant. Review
the digest (`lifecycle digest`) and decide what's worth filing; the sink
is delivery infrastructure, not a policy decision.

## Both sinks at once

`sinks.github` and `sinks.azureDevOps` can both be present in the same
`lifecycle.config.json`. Each is evaluated independently:

- Each has its own trigger rules — one tenant might auto-file criticals to
  GitHub while only ever commenting on an existing Azure DevOps backlog, or
  vice versa, or run identical rules on both.
- Each has its own issue mapping (keyed by `(tenant, sink, fingerprint)`),
  so a finding filed to GitHub and a finding filed to Azure DevOps are
  tracked as separate, independent deliveries — closing one has no effect
  on the other.
- A qualifying finding routes to **every enabled sink**: if both are
  enabled and both qualify to auto-file, one finding produces one GitHub
  issue AND one Azure DevOps work item.
- `lifecycle sync` drains each sink's outbox independently. A missing or
  unset token for one sink (e.g. `AZDO_PAT` not set) skips only that
  sink's drain — loudly, naming the missing env var, with a nonzero exit
  code — while the other sink still drains fully. One misconfigured sink
  never blocks the other.

**Adding Azure DevOps to an already-running GitHub tenant:** each sink tracks its
own position in the event history, so a sink you enable today replays everything
that came before it and picks up the backlog on its first `sync`. Dormant
findings — ones that would never have recurred and so would never have filed —
are included. Findings that have since resolved or closed are not: the create
gate checks the finding's state *now*, not its state when the event fired, so a
long-dead finding files nothing no matter how much history it has. GitHub, having
already scanned that history, enqueues nothing new. There is no longer any reason
to enable both sinks before a tenant accrues history.

```json
{
	"sinks": {
		"github": {
			"enabled": true,
			"repo": "owner/repo",
			"tokenEnv": "GITHUB_TOKEN"
		},
		"azureDevOps": {
			"enabled": true,
			"org": "my-org",
			"project": "MyProject",
			"tokenEnv": "AZDO_PAT"
		}
	}
}
```

Then: `al-profile lifecycle sync`. The JSON output's `drains` array has one
entry per sink that actually attempted a drain this run.

## Confidentiality note

As with the GitHub sink and telemetry pulling (see
[docs/telemetry-recipe.md](telemetry-recipe.md)'s confidentiality note),
enabling a sink for a per-customer or ISV-fleet tenant means
environment-identifying finding data — app names, routine names,
durations, and whatever else lands in the work item's Description — now
flows into an external Azure DevOps project. The digest-first default keeps
this internal until you deliberately turn `autoFile` on for a given tenant;
once you do, you're choosing to let that operational data live in an
external work-item tracker. Make that choice deliberately, per tenant, not
as a side effect of enabling the sink globally.
