# BC Telemetry as the lifecycle trigger layer

Application Insights telemetry (RT0018 long-running AL, RT0005 long-running
SQL) flows into the SAME finding lifecycle engine as profile captures — same
state machine, same digest, same GitHub sink. It answers a narrower question
than a profile: not "why is this slow" (no call tree, no source
correlation), but "this routine is running slow in production, right now,
across the fleet." Telemetry findings are the trigger layer for deciding
where to point a deep capture — scheduling that deep capture automatically is
a later phase; today it's a decision the digest hands to a human (or your own
automation).

## 1. ISV setup — ship telemetry from your extension

Add `applicationInsightsConnectionString` to your extension's `app.json`:

```json
{
	"id": "...",
	"name": "My App",
	"applicationInsightsConnectionString": "InstrumentationKey=...;IngestionEndpoint=...;..."
}
```

This ships telemetry for every install of the extension — fleet-wide,
zero per-customer setup — to the Application Insights resource that
connection string points at. BC emits `RT0018` (long-running AL) and
`RT0005` (long-running SQL) traces with `customDimensions.extensionId`,
`alObjectType`, `alObjectId`, `alMethod` (or `alStackTrace` as a fallback),
`executionTime`/`executionTimeInMs`, and `clientType` (`Background`,
`WebClient`, `WebServiceAPI`, ...) — the fields `pull-telemetry` (below)
already knows how to read. `clientType` gets its own section (§9): it lets
you filter the pull and tune severity separately for background job-queue
methods vs. interactive sessions instead of one blanket threshold.

### Environment-level wiring (everything, not just one extension)

The app.json route only covers YOUR extension's objects. To capture
platform-wide signals for a whole environment, set the connection string at
the environment level instead (both routes can coexist — events then land in
both resources):

- **SaaS**: Admin Center → the environment → **Application Insights
  Connection String**; takes effect on the environment's next restart.
- **OnPrem**: on the BC server,
  `Set-NAVServerConfiguration -ServerInstance BC -KeyName ApplicationInsightsConnectionString -KeyValue "InstrumentationKey=...;IngestionEndpoint=...;..."`
  then `Restart-NAVServerInstance BC`.
- **Docker container** (Windows daemon): same cmdlets through
  `docker exec <container> powershell -Command "Import-Module 'C:\Program Files\Microsoft Dynamics NAV\*\Service\NavAdminTool.ps1'; Set-NAVServerConfiguration -ServerInstance BC -KeyName ApplicationInsightsConnectionString -KeyValue '<cs>'; Restart-NAVServerInstance BC"`
  (NavAdminTool loads the Management module; read the current value back with
  `Get-NAVServerConfiguration -ServerInstance BC -KeyName ApplicationInsightsConnectionString`).

Ingestion is NOT immediate: expect 2–5 minutes of lag between a BC event
and its row being queryable. Quick verify once wired — run in the
resource's Logs blade:

```
traces | where customDimensions.eventId startswith "RT" | take 10
```

An empty result after generating traffic usually means nothing crossed the
emit thresholds (RT0018 ≈ 10 s of AL, RT0005 ≈ 1 s of SQL by default) —
quiet is normal on a healthy dev box, and `pull-telemetry` returning zero
signals is the same non-event (§7).

## 2. Finding the App Insights app id

`pull-telemetry --app-id` wants the Application Insights **Application ID**
(a GUID), not the instrumentation key and not the resource name:

Azure Portal → your Application Insights resource → **Settings → API Access**
→ copy **Application ID**.

## 3. API key — least privilege

Same screen (**API Access**) → **Create API Key**. Grant **Read telemetry**
only — nothing else is needed, and Write/SDK-control permissions would be a
needlessly broad grant for a read-only puller.

Store the key value in an environment variable; `pull-telemetry` reads it by
**name**, never a literal:

```bash
al-profile lifecycle pull-telemetry --app-id <guid> --api-key-env APPINSIGHTS_API_KEY
```

`--api-key-env` defaults to `APPINSIGHTS_API_KEY` — pass a different env var
name if you keep multiple keys around. The key is read once at call time,
sent only as the `x-api-key` header, and never appears in logs or thrown
errors (only the env var *name* does, e.g. on a missing-key exit).

## 4. Cron example — Windows Task Scheduler `.cmd` wrapper

The scheduled task's own command line is visible to anyone who can view the
task (`schtasks /query`, Task Scheduler UI, exported XML) — so the secret
never goes there. Keep it in a separate file locked down with `icacls`, and
have the `.cmd` wrapper read it into the environment for the one process
that needs it.

```
C:\ProgramData\al-perf\appinsights-api-key.txt      <- key value only, no wrapping quotes
C:\srv\al-perf\pull-telemetry.cmd                   <- scheduled task target
```

Lock the key file down to the account the task runs as (adjust the account
name; SYSTEM below is the common case for a machine-wide scheduled task):

```powershell
icacls "C:\ProgramData\al-perf\appinsights-api-key.txt" /inheritance:r `
	/grant:r "SYSTEM:R" "Administrators:F"
```

`pull-telemetry.cmd`:

```bat
@echo off
setlocal
set /p APPINSIGHTS_API_KEY=<"C:\ProgramData\al-perf\appinsights-api-key.txt"
cd /d "C:\srv\al-perf"
bun run src\cli\index.ts lifecycle pull-telemetry ^
	--app-id 11111111-2222-3333-4444-555555555555 ^
	--since 15m ^
	--db .al-perf\lifecycle.sqlite
endlocal
```

Register it to run every 15 minutes (match `--since` to the schedule
interval so windows don't gap or overlap):

```powershell
schtasks /create /tn "al-perf pull-telemetry" `
	/tr "C:\srv\al-perf\pull-telemetry.cmd" `
	/sc minute /mo 15 /ru SYSTEM
```

`pull-telemetry` does not retry — v1 is cron-driven; a failed run is picked
up whole by the next tick. `--since` accepts either an ISO 8601 timestamp or
a relative duration (`15m`, `4h`, `1d`); it defaults to `1h` if omitted.
`--signals` defaults to `RT0018,RT0005`; pass a comma-separated list to pull
a different (or narrower) set — unknown signal ids are still accepted and
fall back to the `default` severity thresholds below. `--client-types`
(default: unset, no filter) narrows the pull to a comma-separated list of BC
session client types, e.g. `--client-types Background,WebClient` — see §9
for the full clientType story (filtering, severity, and merge behavior).

With no `--out`, the pulled batch is evaluated straight into the local
lifecycle DB (`--db`, default `.al-perf/lifecycle.sqlite`). With `--out
<path>`, the puller only writes the normalized batch JSON and touches
nothing else — pair it with `lifecycle telemetry <path>` on a different
box, or ship the file to `/api/ingest` (§6).

## 5. Severity thresholds (defaults — file-overridable)

Per-signal severity is computed from `maxDurationMs` against these
thresholds. They ship as code defaults (`DEFAULT_LIFECYCLE_CONFIG.telemetry`
in `src/lifecycle/config.ts`), and every value below is overridable at
runtime, per tenant, with no fork required: `lifecycle`'s parent `--config
<path>` flag (default `.al-perf/lifecycle.config.json`) and the web ingest
path's `AL_PERF_LIFECYCLE_CONFIG` env var both load a `telemetry` block that
deep-merges onto these defaults BY KEY — override just `RT0018` and
`RT0005`/`default` are untouched. See §11 for a full config file example and
§9 for the `@clientType` composite-key convention (e.g.
`"RT0018@Background"`) that lets background job-queue methods carry
different thresholds than interactive sessions:

```json
{
	"telemetry": {
		"maxSignalsPerBatch": 10000,
		"severity": {
			"RT0018": { "warningMs": 10000, "criticalMs": 30000 },
			"RT0005": { "warningMs": 10000, "criticalMs": 60000 },
			"default": { "warningMs": 10000, "criticalMs": 60000 }
		}
	}
}
```

`maxSignalsPerBatch` is a hard budget — a batch with more signals than this
is rejected outright (protects the ingest path from an unbounded payload).
Unknown `signalId`s (future BC event ids) fall back to `"default"` rather
than being dropped. A config file's `telemetry.severity` entries deep-merge
onto this table by key (§11); a file containing only `{"telemetry":
{"severity": {...}}}` leaves `maxSignalsPerBatch` and every untouched
severity key at its default.

## 6. The batch JSON contract — for hand-rolled exporters

`pull-telemetry` is one adapter. Anything that can produce this shape can
feed the lifecycle engine — `lifecycle telemetry <file>` locally, or POST it
(gzipped or plain) to `/api/ingest` as the `profile` part with manifest
`captureKind: "telemetry"`. Schema is pinned to integer `schemaVersion: 1`
(`TELEMETRY_BATCH_SCHEMA_VERSION`, `src/types/telemetry.ts`); unknown keys
are ignored, so additive fields never require a version bump, but
`schemaVersion !== 1` is rejected.

```json
{
	"schemaVersion": 1,
	"payloadType": "telemetry-batch",
	"windowStart": "2026-07-11T09:00:00.000Z",
	"windowEnd": "2026-07-11T09:15:00.000Z",
	"source": "appinsights-api",
	"signals": [
		{
			"signalId": "RT0018",
			"appId": "11111111-2222-3333-4444-555555555555",
			"appName": "My App",
			"objectType": "Codeunit",
			"objectId": 50100,
			"objectName": "Sales-Post",
			"methodName": "PostSalesLine",
			"count": 3,
			"maxDurationMs": 15234,
			"avgDurationMs": 9871.5
		}
	]
}
```

Field rules the parser enforces (fail-closed — the whole batch is rejected,
not just the bad row):

- `windowStart` / `windowEnd`: ISO 8601 strings; `windowEnd` becomes the
  run's `captureTime`.
- `source` is optional free text (adapter provenance, e.g. `"appinsights-api"`).
- Per signal, **required and non-empty**: `signalId`, `appId`, `objectType`,
  `methodName`. `objectId` must be an integer. `count` and `maxDurationMs`
  must be non-negative finite numbers.
- `appName`, `objectName`, `avgDurationMs` are optional.
- Each signal is one aggregated row — pre-aggregate per (app, object,
  method) on your side; there is no call tree here, only routine-level
  counts and durations.
- `signals.length` over `maxSignalsPerBatch` (§5) rejects the whole batch.

Every signal mints a `telemetry:<16-hex>` fingerprint from
`(signalId, appId, objectType, objectId, methodName)` (normalized —
casing and trigger-name prefixes don't split identity). The same coarse key
from a profile-derived pattern finding on the same routine is designed to
correlate with it at the routine level once a source registers.

## 7. Digest-first posture

Telemetry findings are not a separate reporting surface — they show up in
`lifecycle digest` exactly like pattern and alsem findings (same
`fingerprint`/`title`/`severity`/`state` shape, `source` is `telemetry`
internally but the digest contract doesn't even expose that column). The
`telemetry:` prefix on the fingerprint and the `RT00xx:` prefix on the title
are how you tell them apart at a glance:

```bash
al-profile lifecycle digest --db .al-perf/lifecycle.sqlite -f json
```

They obey the same `autoFile` hysteresis as everything else flowing through
`lifecycle sync` — a telemetry finding files (or stays digest-only) under
the exact same `autoFileMinSeverity` / `autoFileAfterRuns` rules documented
in [`docs/lifecycle-gh-recipe.md`](lifecycle-gh-recipe.md). Nothing about
telemetry gets special-cased in the sink.

An app only counts as "exercised" when at least one of its RT0018/RT0005
signals appears in a batch's window, so a fully healthy app that stops
producing signals altogether leaves its earlier findings open rather than
auto-resolving — silence is not resolution; close them explicitly with
`lifecycle close`, or wait for the app to reappear in a later batch with
signals but without that particular finding.

What telemetry now automates: **scheduling** a deep capture, not running
one. A recurring `RT0018`/`RT0005` finding that clears the
`captureRequests` thresholds (`src/lifecycle/config.ts`) gets a
`capture_requests` row filed by `lifecycle sync`'s trigger scan. Actually
running the capture and shipping the resulting profile is still an external
executor's job — see §8 below.

## 8. Closing the loop: telemetry → scheduled capture → fulfillment

The full cycle, end to end:

```
pull-telemetry cron (§4, every 15m)
  → RT0018/RT0005 findings land in the lifecycle DB
  → lifecycle sync's capture-request scan (processCaptureTriggers)
      files a capture_requests row once a finding clears
      minOccurrences / minSeverity
  → lifecycle captures list -f json --status pending
      is how an executor discovers it
  → executor claims it, runs the capture, ships a profile to the SAME tenant
  → evaluating that profile (lifecycle evaluate / web ingest) matches its
      method index against the request's routine key and marks it
      fulfilled automatically — no extra step
```

`lifecycle sync` itself needs to run on a schedule for the scan to happen —
treat it as a separate cron tick alongside `pull-telemetry` (§4). The full
executor-side contract — poll cadence, claim semantics, the exact JSON row
shape, TTL expiry — is [`docs/capture-request-contract.md`](capture-request-contract.md).

## 9. ClientType segmentation

BC session client type — `customDimensions.clientType` (`Background`,
`WebClient`, `WebServiceAPI`, `Api`, ...) — rides along on every RT0018/RT0005
trace. `pull-telemetry` always includes it in the query's `extend` and
`summarize ... by` key, independent of whether you filter on it, so every
emitted signal carries `clientType` whenever BC populated it. Rows from an
older platform version (or a trace that never got a client type) simply omit
the field rather than guessing.

**Filtering.** `--client-types Background,WebClient` narrows the pull itself
with a `| where clientType in (...)` clause. Each value is validated against
`^[A-Za-z]+$` *before* it's spliced into the KQL — the same posture as
`--signals` — so an invalid value (injection attempt or typo) is a usage
error with zero HTTP calls, not a malformed query sent upstream. Omit the
flag to pull every client type (the default).

**Severity ladder.** Threshold lookup tries, in order: `${signalId}@
${clientType}` (e.g. `"RT0018@Background"`), then plain `${signalId}`, then
`"default"` — each rung checked with `Object.hasOwn` so a crafted or
coincidental key can't hijack the lookup via the prototype chain. Configure
the composite key exactly like a plain signal id, just with `@ClientType`
appended (§10 has a worked example, §11 the full file shape).

**Fingerprint identity is unaffected.** `clientType` never enters the
fingerprint — a routine running slow in `Background` and slow in
`WebClient` is still ONE finding, not two. When a batch carries the same
routine under more than one client type, the parser merges them *after*
severity assignment into a single finding: the merged severity is the max
across constituents, counts sum, `maxDurationMs` is the max observed, and
the finding's evidence lists a `ClientType: N × max Xms` line per
constituent so the breakdown stays visible even though there's one finding.

## 10. Tuning for job-queue apps

Interactive-AL defaults (`RT0018`: warning 10 s / critical 30 s) are tuned
for a user waiting on a page. They are the wrong yardstick for a background
job-queue codeunit, where minutes of runtime can be entirely normal — first
contact with real ISV telemetry (Continia DocumentOutput) showed 15/15
findings landing critical under the interactive defaults, because every one
of them was a `Background` job-queue export, not a stalled user session.

The fix is not "raise the threshold everywhere" (that would hide a genuinely
slow interactive session) — it's segmenting by `clientType` (§9) so
background methods get their own, much looser, ladder rung while interactive
`RT0018` stays exactly where it protects a real user:

```json
{
	"telemetry": {
		"severity": {
			"RT0018@Background": { "warningMs": 300000, "criticalMs": 1800000 },
			"RT0018": { "warningMs": 10000, "criticalMs": 30000 }
		}
	}
}
```

That's 5 minutes / 30 minutes for `Background` RT0018 traces, versus the
unchanged 10 s / 30 s for everything else. The ladder order (§9) means a
`Background` RT0018 signal always tries `"RT0018@Background"` first and only
falls through to plain `"RT0018"` if the composite key is absent — so this
file segment is additive, not a replacement of the interactive rung, and you
can drop it in without touching anything else in `telemetry.severity`.

## 11. Config file — full example

`lifecycle`'s parent `--config <path>` flag (default
`.al-perf/lifecycle.config.json`; missing file → defaults apply) is read by
`evaluate`, `telemetry`, `pull-telemetry`, and `sync`, and by the web ingest
path via the `AL_PERF_LIFECYCLE_CONFIG` env var. One file, three coexisting
blocks — `sinks` (GitHub delivery, see
[`docs/lifecycle-gh-recipe.md`](lifecycle-gh-recipe.md)), `telemetry`
(severity thresholds, §5/§9/§10), and `captureRequests` (deep-capture
trigger tuning, see
[`docs/capture-request-contract.md`](capture-request-contract.md)):

```json
{
	"sinks": {
		"github": {
			"enabled": true,
			"repo": "owner/repo",
			"tokenEnv": "GITHUB_TOKEN",
			"autoFile": false,
			"autoFileMinSeverity": "critical",
			"autoFileAfterRuns": 2,
			"autoClose": false,
			"labels": ["al-perf"],
			"labelsAllowList": ["al-perf", "performance", "regression"]
		}
	},
	"telemetry": {
		"maxSignalsPerBatch": 10000,
		"severity": {
			"RT0018@Background": { "warningMs": 300000, "criticalMs": 1800000 },
			"RT0018": { "warningMs": 10000, "criticalMs": 30000 },
			"RT0005": { "warningMs": 10000, "criticalMs": 60000 },
			"default": { "warningMs": 10000, "criticalMs": 60000 }
		}
	},
	"captureRequests": {
		"enabled": true,
		"minOccurrences": 3,
		"minSeverity": "warning",
		"ttlDays": 14,
		"maxPending": 20
	}
}
```

Every block is optional and independently omittable — a file with only
`sinks` (the pre-existing shape) still works exactly as before; a file with
only `telemetry` or only `captureRequests` patches just that block onto the
code defaults. The merge is BY KEY within `telemetry.severity`: the example
above overrides `RT0018@Background` and leaves `RT0005`/`default` at their
code defaults untouched (`maxSignalsPerBatch` shown explicitly here, but it
would stay at its default of `10000` even if omitted).

**The `--config` flag moved.** Earlier versions accepted a `sync`-level
`--config <path>` flag (`lifecycle sync --config <path>`). It has been
replaced by the parent flag shown above — put `--config` before the
subcommand: `lifecycle --config <path> sync`. The default path and the
file's meaning are unchanged; only its position on the command line moved,
and it now applies to every subcommand that reads the file, not just `sync`.
