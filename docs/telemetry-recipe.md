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
and `executionTime`/`executionTimeInMs` — the fields `pull-telemetry`
(below) already knows how to read.

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
fall back to the `default` severity thresholds below.

With no `--out`, the pulled batch is evaluated straight into the local
lifecycle DB (`--db`, default `.al-perf/lifecycle.sqlite`). With `--out
<path>`, the puller only writes the normalized batch JSON and touches
nothing else — pair it with `lifecycle telemetry <path>` on a different
box, or ship the file to `/api/ingest` (§6).

## 5. Severity thresholds (current defaults)

Per-signal severity is computed from `maxDurationMs` against these
thresholds. They ship as code defaults (`DEFAULT_LIFECYCLE_CONFIG.telemetry`
in `src/lifecycle/config.ts`) — v1 has no CLI flag or config file to
override them per tenant; if you need different thresholds today, that's a
build-time fork of this block, not a runtime setting:

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
than being dropped.

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

What telemetry does NOT do yet: trigger a deep capture automatically. A
recurring `RT0018` finding on a routine tells you where a profiler run would
pay off — acting on that (scheduling the capture, running
`al-profile analyze ... --explain --deep`) is presently a human decision
made off the digest, not an automated follow-up. Wiring that loop shut is
explicitly a later phase.
