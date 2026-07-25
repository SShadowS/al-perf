# Changelog

## Unreleased

Most of this release is one finding: the AL indexer could not see large,
ordinary categories of AL code, so detectors reported clean on files they had
never really read. Fixing that surfaced real findings and removed false ones at
the same time. Measured end to end on a 573-file Business Central app:

| | before | after |
|---|---|---|
| findings | 615 | 714 |
| critical | 226 | **242** |
| warning | 389 | 335 |
| info | 0 | 137 |

A second theme runs through the rest: the tool could not be pointed at a large
workspace at all, and several of its own outputs were unusable at real scale —
a 595 KB "quick summary", a 1,028-character table cell, a crash dump in place
of an error message.

### Heads-up before upgrading

- **Source-correlated runs now report more critical findings, so a passing gate can start failing.** The 16 extra criticals above are real `modify-in-loop` / `insert-in-loop` / `record-op-in-loop` findings on code the indexer previously skipped — not a threshold change. If `gate --max-critical 0` runs in a pipeline, expect it to fail on code it used to pass, and budget a triage pass before upgrading. Profile-only gate verdicts (no `--source`) are unchanged.
- **The health score means something different.** It counted findings, so one repetitive detector bottomed out the scale. Two captured profiles exhibiting the *same single pattern* — one 4 times, one 16 times — scored 80 and 20, and a batch one-liner read "health 8/100, 0 critical patterns". It now counts DISTINCT problems per severity. Six captured profiles that scored 5, 5, 80, 20, 25 and 35 now score 80, 85, 95, 95, 80 and 90, and the two that differ only in repetition both land on 95. Anything calibrated to the old numbers needs re-baselining.
- **Some findings moved to a new `info` tier** rather than disappearing — see *Changed* below. If you triage by severity, your queue re-orders. On a 15,436-file corpus that is 3,018 of `missing-setloadfields`' 13,633 warnings and 1,239 of `unfiltered-findset`'s 5,414. Finding counts are unchanged in both cases; only the rating moved.
- **`appBreakdown[].methods` is gone from the JSON output.** Nothing read it: not a formatter, not the web UI, not MCP or the AI payload (both stripped it), and the batch path always emitted `[]`. If you consume `analyze -f json` or `/api/analyze` and read that array, rebuild it from `objectBreakdown[].methods`, which is unchanged.

### Added

- **Telemetry SQL evidence.** RT0005 slow-statement rows attach to telemetry findings as measured, threshold-gated evidence, and RT0018's `sqlExecutes`/`sqlRowsRead` ride along on the same findings. Statement text is redacted at ingest — company and database names never leave the adapter.
- **Per-signal availability.** A failed signal query no longer aborts the pull; it is recorded, reported in the digest, and marks the window incomplete so findings for that signal cannot resolve on data that was never fetched.
- **`lifecycle digest` actually renders signal availability.** The digest option existed and was tested, but nothing ever populated it: availability is a per-pull fact while the digest reads the store. Schema v8 adds a per-tenant snapshot, written after a successful evaluate and only when the batch carries the field. An older window never overwrites a newer one, since cron-driven pulls can land out of order.
- **The tree-sitter-al grammar is pinned to a release.** It was fetched once from `latest` with the version recorded nowhere, so whichever release happened to be current the first time a machine ran `--source` was that machine's grammar forever — two developers who started on different days parsed AL differently, and CI got whatever shipped that morning. `AL_GRAMMAR_VERSION` names the release, and a cached copy whose recorded version does not match is replaced.

### Changed

- **`missing-setloadfields` drops to `info` when the record escapes the member.** `SetLoadFields` is only safe advice when every field read is visible where the narrowing happens. If the record is passed whole to a callee, or has a table method called on it, fields this member never names may be read from it — and narrowing the load starves exactly those reads. 218 of 387 find-receivers in a real app are in one of those two shapes. The finding stands, because the I/O opportunity may be real; it stops reading as a fix you can apply without checking the callee.
- **`missing-setloadfields` also treats a `var` parameter and a whole-record copy as escapes.** A by-reference record parameter is the lookup-helper idiom — `local procedure FindWarehouseReceiptLine(var WarehouseReceiptLine: Record …)` that only filters and finds — where the member reads no field at all because every read happens in the caller. `TempLine := SalesLine` copies every field out of the right-hand record, so narrowing its load leaves the copy holding defaults. 3,018 of 13,633 warnings on a 15,436-file corpus move to info; a by-VALUE parameter is deliberately not an escape, since the caller gets a copy and never sees the find.
- **`unfiltered-findset` stops claiming a full table scan it cannot prove.** Filters travel with a record variable in AL, by value as well as by reference, so a record PARAMETER arrives carrying whatever the caller filtered — and an object's implicit `Rec` arrives filtered by SourceTableView, by the caller's SetTableView, and by the user's filter pane. Neither is visible to a member-local scan. Both drop to info with a description that says where the filters come from and a suggestion that points at the callers; 1,239 of 5,414 findings on the corpus (990 parameters, 247 implicit records). A local record keeps the warning: it is declared right there with no filters.
- **`external-call-in-loop` rates a `Sleep` in a wait loop as `info`.** A loop that terminates on a condition rather than on running out of rows is waiting for something, and the delay is the mechanism — a retry backoff or a rate throttle. Rating that critical and advising "remove Sleep() from the loop" deletes the backoff. `for`/`foreach`, `repeat … until X.Next() = 0` and per-row triggers are unchanged: there the delay really does multiply by the row count.
- **`incomplete-setloadfields` drops to `warning` when the record's table is not in the index.** `Rec.SomeName` with no parentheses is a field read or a paren-less call to a table procedure, and nothing distinguishes them without the table's field list. Against a base-app or `.dependencies/` table the detector cannot support its own "will cause runtime errors" claim, so it no longer makes it.
- **`nested-loops` requires the inner loop to touch the database.** A `for i := 1 to KeyRef.FieldCount` walking key fields through `FieldRef` is bounded by the key width and reaches no database. Nesting multiplies database cost only when the inner body does database work.

### Fixed — scale and output

- **A large workspace could not be indexed at all.** `parseALSource` returns a web-tree-sitter `Tree`, which holds WASM heap memory released only by an explicit `delete()`. Nothing ever called it, so every parsed file leaked its tree and the heap grew until it faulted — "Out of bounds memory access", then `Aborted()`, at roughly ten thousand files, which is inside the size of a real BC solution once dependencies are counted. A corpus that died at ~10,000 files now indexes 15,436 of them: 15,411 objects, 195,107 procedures. `buildSourceIndex` also had no per-file isolation, so one thrown parse cost every other result; failures are now collected per file with their reason and reported as `failedFiles` rather than being swallowed or fatal.
- **The MCP server spent an agent's whole context on one call.** `get_hotspots` — documented "quick" and "lighter than analyze_profile" — returned 595,710 characters for `top: 6`, because every `appBreakdown` and `objectBreakdown` row carries the full method list for that app or object, repeated once per app and again per object. It now returns what it advertises (8.6 KB); `analyze_profile` keeps the breakdown rows and drops their nested method arrays.
- **`--deep` billed about 20k tokens of method names per call.** The same nested method lists were 62% of the AI payload — 79,335 of 127,300 characters. The payload builder already stripped `tableBreakdown` as "noise without value"; this is the same thing, larger. Payloads roughly halve: 151k characters to 69k on a sampling capture.
- **The web API and `-f json` still shipped the per-app method list.** MCP stripped it, the deep AI payload stripped it, the batch merge always emitted `[]`, and no formatter or web view ever read it — so the one place it survived was the output every other consumer had already learned to discard. It is gone from `AppBreakdown` entirely rather than stripped in two more places: `/api/analyze` on a captured sampling profile goes 638,752 → 557,171 bytes (−12.8%), an instrumentation capture 692,835 → 677,361 (−2.2%). Building it was also quadratic — a linear `includes()` per node of the profile.
- **Bad input produced a crash dump instead of an error.** A truncated download or the wrong file answered with six lines of the parser's own source, a caret, and absolute paths into the install directory. Eight of eleven subcommands had no error handling at all, so this now lives at the entry point: `Error: <message>` on stderr, exit 1, and `AL_PERF_TRACE=1` for the stack when debugging the tool itself.
- **SQL statement names broke every rendered table.** `isSqlStatement` required a space after the keyword, but BC emits statements it has already elided itself as `SELECT...WHERE (...)`. None of those were recognized, so no formatter truncated them and a 1,028-character statement went into a markdown table cell verbatim. Fixing the predicate also exposed five render sites that never truncated at all.
- **Recursion double-counted a method's `totalTime`.** A node's `totalTime` already contains its descendants', but `aggregateByMethod` summed every node of a method, so a self-calling method was charged the same microseconds once per level: `PostItem` reported 254,702µs / 36% of a capture for a call that costs 127,351µs / 18%. This fed hotspots, the breakdowns, `explain_method` and `compareProfiles`. `drilldown_method` had the same bug plus a second one — it reported a summed total beside a single node's percentage, so its two headline numbers described different scopes and disagreed with `explain_method`.

### Fixed — the indexer could not see this code

- **Argument-less calls written without parentheses were invisible.** Classic C/AL — `Customer.FindSet`, `SalesLine.Modify`, `until Customer.Next = 0` — parses as a member expression, not a call, and only calls were collected. One real app contains 336 of them (101 `Next`, 91 `FindSet`, 43 `Insert`, 36 `Get`, 25 `FindFirst`, 23 `Modify`, 12 `FindLast`, 5 `Delete`); whole procedures indexed with zero record operations, showing two nested record loops as pure syntax with no database access. Worse, they were misread as FIELD accesses: `RecRef.Modify` became a field named "modify", which produced `critical` findings demanding that "modify" be added to a `SetLoadFields` list.
- **Record parameters were never indexed.** Only a member's own `var` section was read. A `temporary` buffer is routinely passed in — `procedure SetPrinters(var Printer: Record "CDO Printer" temporary)` — so in-memory work was charged SQL cost, and a `var FilterRecord: RecordRef` parameter's `Modify()` was reported as a SQL UPDATE. In the other direction, `unindexed-filter` and calcfields severity need the parameter's table to judge anything at all, so every filter on a parameter record was skipped silently. One app has 544 procedures taking a record parameter, 18 of them temporary.
- **Object-level globals were never indexed.** A codeunit or table can declare records and helpers above its members and reuse them everywhere; one app has 327 objects that do, with 111 global records (33 temporary) and 1,923 non-record globals. Unresolved, a global temp buffer was charged SQL cost and a global `List of [Text]`'s `.Insert()` read as a SQL INSERT. Member-local declarations shadow globals of the same name. This also closes `external-call-in-loop`'s documented blind spot, where an object-level `HttpClient` was invisible rather than merely unrefined.
- **Objects wrapped in a preprocessor conditional were skipped entirely.** `#if CLOUD` puts the declaration inside a `preproc_conditional_object`, and only the file's top level was scanned. Cloud/on-prem and localization variants are guarded this way as a matter of course — 19 files in one app, contributing not one finding, with no warning.
- **Interfaces and control add-ins overwrote each other.** They carry no object ID, so all 12 interfaces in one app keyed to `Interface_0` and all 8 control add-ins to `ControlAddIn_0`, each replacing the last: 18 objects lost. Indexed objects now equal indexed files (575/575, was 546/564).
- **Table fields with unquoted names were dropped.** `field(4; Amount; Decimal)` is as legal as `field(1; "No."; Code[20])`, but only the quoted spelling was captured, so a five-field table indexed three fields. That silently degraded calcfields severity and, once `incomplete-setloadfields` began checking accessed names against the field list, would have suppressed real findings.
- **Three kinds of receiver never resolved, so every gate failed open on them.** A CALL EXPRESSION receiver (`Tok.AsObject().Get('id', Value)`, `Dict.Keys().Get(i, …)`) was recorded under the literal text `Tok.AsObject()`, which matches no declaration — 129 JsonObject, Dictionary and enum-ordinal lookups inside loops were reported as "each iteration triggers a separate SQL query", and AL has no record-returning expression to chain a `Find`/`Get` onto in the first place. An INDEXED receiver (`ProdOrderRoutingLine[1].SetRange(…)`, `TempBuffer[1].Insert()`) now resolves to the array's declaration, which it shares with every element; 291 in-loop ops on the corpus have one. And `array[5] of Record "Sales Line" temporary` nests its record type one `type_specification` deeper, under `array_type`, so the table and the `temporary` were both invisible — an in-memory array buffer's `Insert` per row read as a SQL INSERT. Net on the corpus: 142 false findings removed, 21 real `unindexed-filter` findings recovered because an array receiver's table now resolves at all.
- **A variable declared with a quoted name was dropped outright.** `"G/L Entry": Record "G/L Entry" temporary;` is ordinary AL, but the name node is a `quoted_identifier` and only `identifier` was matched, so the declaration never entered the index and every gate that resolves that receiver failed open.
- **A page or query with `SourceTableTemporary = true` has an in-memory `Rec`.** `Rec` has no `var` declaration for variable-level resolution to find, so every operation on such a page was charged SQL cost it never pays.

### Fixed — detectors that read the evidence wrong

- **`unindexed-filter` judged each filter in isolation.** Filtering every field of a compound key in order raised one false finding per field after the first: one table alone accounted for 12, where all six fields of its key were filtered in key order. A filter is only a scan risk when no filter on that record hits a key's leading field.
- **`unfiltered-findset` missed three ways a record gets filtered** — `SetView`, `CopyFilters` (which filters the receiver) and `CopyFilter` (which filters the record owning its *second* argument, not the receiver). `SetCurrentKey` deliberately still counts as unfiltered: it picks the sort order and restricts nothing.
- **`RecordRef` receivers were treated as records** by `unfiltered-findset` and `missing-setloadfields`. `FindSet`/`FindFirst`/`FindLast` match by method name and `RecordRef` has all three; its filters live on `FieldRef`, so "add SetRange" and "add SetLoadFields" are advice for a different API.
- **`incomplete-setloadfields` reported table method calls as forgotten fields.** `Email.HasMoreDocuments` is `internal procedure HasMoreDocuments(): Boolean` — reported `critical`, claiming runtime errors, about a method call. Accessed names are now cross-checked against the table's fields when the table is known.

- **`incomplete-setloadfields` flagged primary key fields.** BC always loads the primary key — `SetLoadFields` cannot exclude the fields that identify the record — so reporting one as forgotten claimed a runtime error over something that cannot happen. Only visible on a corpus with its tables in-tree: 86 of 193 findings there flagged nothing else, and the detector drops to 94 findings with `critical` going 182 to 83.
- **`unindexed-filter` flagged FlowFilters and SystemId.** A FlowFilter is not a table column; it parameterises FlowField calculation and has no index by definition, so it cannot cause the scan being warned about. SystemId carries its own unique index. On that same corpus `"Date Filter"` was the single most-flagged field — 450 of 10,352 — with SystemId another 147; the detector drops to 9,077.
- **The escape analysis counted metadata calls as escapes.** `FieldNo`, `FieldCaption`, `Mark` and friends return a field number, a caption or set a flag; none reads a field value, so none can starve a `SetLoadFields`. Seventeen findings on a second codebase move back from info to warning.

### Fixed — profile analysis

- **Idle time was never excluded from real captures.** The idle guard required `objectId === 0`; every fixture in the repo encodes 0, but a captured BC profile emits the `IdleTime` frame with `-1`. Ten call sites ask to exclude idle and on real data none of them did — idle reached the hotspot list, the app and object breakdowns, and `compareProfiles`, where it surfaced as a "regression" of 2,599 → 3,910 microseconds of doing nothing. A second copy of the same check guarded the hotspot list and both sides of the comparison.
- **`recursive-call` counted call sites that were not recursing.** It claimed N occurrences "in the call tree as a recursive chain" and summed all N self-times into its impact, where N was every occurrence of the method anywhere. 5 of 38 findings across captured profiles overstated their count.
- **`event-chain` counted the root as one of the subscribers it triggers**, so "OnAfterLogin (11 subscribers)" meant 10. It also described a fan-out as a chain: members are grouped by nearest event ancestor, forming a tree — that OnAfterLogin's members sit at depth offsets [6,9,6,1,1,1,1,1,1,6] — while the text advised "reducing the chain depth". Fan-out and depth are now reported separately, because they have different fixes.

### Fixed — privacy

- **Profile findings published raw SQL, including customer database and company names, into GitHub and Azure DevOps issue titles.** A sampling profile embeds SQL statements as call-tree nodes whose function name IS the statement, and `high-hit-count` used it verbatim: `SELECT L.Text FROM [CRONUS].[dbo].[$ndo$textlookup] … has disproportionate hit count`. Finding titles become issue titles. 22 of 70 findings across captured profiles carried a raw statement; 4 carried a bracketed database name. Findings now name the operation and the logical table, which is schema rather than customer data — the same line the telemetry redactor draws.
- **A bare multi-part qualifier escaped SQL redaction on the telemetry path.** `mydb.dbo."Table"` carries no `$`, so the leftover scan passed it and the database name survived into an issue. First table position was already covered by a cross-check; a join's or a subquery's reference was not.
- **`pull-telemetry` could not work against real telemetry.** It read `customDimensions.executionTimeInMs`, an alias that came back non-null on 0 of 17,045 RT0018 rows and 6 of 15,957 RT0005 rows measured against a live environment — every real pull threw. It now reads the `executionTime` .NET timespan field BC actually populates.
- **RT0005 findings carried a stack header as their method name.** The fallback took the first line of `alStackTrace`, which is `AppObjectType: …`, not a method. RT0005 findings now parse the real AL frame. Existing RT0005 findings, if any, re-file once under corrected identities.
- **One unexpected `clientType` cost an entire telemetry window.** The adapter passed Azure's value through and the parser rejects anything outside `^[A-Za-z]+$` by throwing, failing the whole batch. The field is optional, so it is now dropped on its own and the row's timing and finding data survive.

## 3.0.0 — 2026-07-12

The release that turns al-perf from a profile analyzer into a performance observability platform. A profile analyzer answers "why was this run slow?" and forgets. This release adds a **finding lifecycle engine**: findings get a stable identity, are tracked across runs, and are driven out to the places you already look — GitHub, Azure DevOps, App Insights telemetry.

Two breaking changes; both have a mechanical fix. See below.

### Breaking

- **`lifecycle sync --config` moved to the parent command.** Use `lifecycle --config <path> sync ...` instead of `lifecycle sync --config <path> ...`. The default path and value semantics are unchanged, so documented invocations still work once the flag moves before the subcommand name.
- **Web ingest no longer accepts the shared secret by default.** Clients hitting `/api/ingest` and `/api/profiles` must re-register to obtain a per-tenant token, or the server must be started with `AL_PERF_ALLOW_SHARED_SECRET=1`. The old behavior let any holder of one secret write as any tenant.

The library API is purely additive — no exports were removed or changed.

### Added — finding lifecycle engine

- **Durable findings across runs.** Every finding gets a stable fingerprint and a state machine (`new → open → regressed / improving → resolved → closed`). SQLite-backed, at `.al-perf/lifecycle.db`. A problem that persists is one finding with a history, not a fresh row every run.
- **`lifecycle evaluate`** — analyze a profile and advance finding state.
- **`lifecycle status` / `digest`** — what's open, what regressed, what needs triage.
- **Baselines and absence tracking** — a finding that stops appearing auto-resolves after `resolveAfterRuns` (default 3), so a fixed problem closes itself.

### Added — sinks

- **GitHub sink** — files findings as issues, comments on regression and recurrence, closes on resolution. Configured per-tenant with its own trigger rules.
- **Azure DevOps sink** — the same, as work items.
- **Multi-sink fan-out** — both can run at once, each with independent rules. A sink enabled after a tenant already has history replays that history and picks up the live backlog on its first `sync` (dormant findings included; long-dead ones correctly skipped).
- **Epic collapse** — a storm of new findings collapses into one parent issue rather than flooding the tracker.
- **`lifecycle sync`** — drains every configured sink. Config at `.al-perf/lifecycle.config.json`; each sink's token comes from the env var named by its `tokenEnv`.

### Added — telemetry as a trigger layer

- **App Insights ingestion** (`lifecycle telemetry`, `lifecycle pull-telemetry`) — Business Central telemetry becomes findings, so a slow routine surfaces from production signal rather than waiting for someone to capture a profile.
- **Multi-tenant** — `--split-by-customer` fans a pull out across tenants. Every `--tenant` value is normalized to lowercase at the CLI boundary and in `evaluateRun`.

### Added — deep-capture request queue

- Recurring telemetry findings are coarse: they say a routine is slow, not why. The engine now **files a deep-capture request** — a queue an external executor services (poll → claim → capture → ship), auto-fulfilled when the resulting profile arrives.
- **`lifecycle captures list / claim / cancel / health`** — operate the queue. `health` reports depth, oldest pending, stuck claims and who holds them, and whether you're at the cap.
- **Self-correcting.** A request claimed by an executor that then dies is reclaimed after `claimTtlMinutes` (default 60) and handed to another worker. A `reclaim_count` distinguishes a dead executor from a poison request that kills whatever picks it up.
- **It says so when it jams.** When the executor dies the queue fills to `maxPending` and new requests stop being filed — `sync` warns, `captures health` shows it, and the digest carries a jammed-queue block (only when actually jammed, so the healthy case stays quiet).

### Added — agentic triage

- **`lifecycle triage-agent`** — an optional scheduled LLM pass over needs-triage findings, with allow-listed tools and injection-hardened prompting. The one agentic step in an otherwise deterministic pipeline.

### Added — ir-json ingestion

- Accepts `ir-json`, the lossless per-invocation instrumentation format from `bc-mdc-converter`. Hit counts become **exact invocation counts** rather than statistical inference, so `repeated-siblings` and `high-hit-count` stop guessing. Format is sniffed from content, not extension.

### Added — al-sem source fusion

- Optional correlation against the al-sem semantic engine upgrades a finding's identity from a fallback key to a stable routine anchor, and carries its history across the change rather than forking it.

### Fixed

- **Algorithm-version bumps no longer orphan every finding.** Changing `FINGERPRINT_ALGO_VERSION` changes every fingerprint by design — but it used to silently re-file every live problem as new and strand every existing row in `resolved` forever. `evaluateRun` now refuses to run, naming `lifecycle maintain --purge-stale-fingerprints` as the way forward.
- **`/api/debug/status` reports aggregate counts, not tenant names.** The endpoint is unauthenticated; it now exposes `staleAlgoTenantCount` / `staleAlgoFindingCount` and never a customer identifier.
- **Web ingest stopped claiming success while doing nothing.** A stale-algo tenant used to get one stderr line and a `202 {status:"stored"}`, every ingest, forever. The response now carries `lifecycle: {status:"blocked", reason, remediation}` when the guard fires.

## 2.3.3 — 2026-06-01

### Fixed

- **Upgrade banner auto-hides when AI is active** — Previously the banner rendered unconditionally until manually dismissed, so restoring the `ANTHROPIC_API_KEY` did not remove it. The banner now starts hidden and is shown by `app.js` only when `/api/debug/status` reports `aiEnabled: false`. Added `aiEnabled` to the status endpoint (`true` when `ANTHROPIC_API_KEY` is set and `AI_DISABLED !== "1"`).

## 2.3.2 — 2026-05-25

### Fixed

- **Stale assets behind Cloudflare** — `app.js`/`style.css` were cached ~186 days by Cloudflare with no cache-busting, so returning visitors (e.g. on mobile) kept old assets and never saw the upgrade banner. HTML now stamps local asset refs with `?v=<version>` and is served `Cache-Control: no-cache`, so each release yields fresh asset URLs and affected browsers self-heal on next visit.

## 2.3.1 — 2026-05-25

### Added

- **Deploy/restart detection** — `/api/debug/status` now returns `version` (from `package.json`), `startedAt` (boot timestamp), and `uptimeSec`, so a redeploy/restart is detectable over HTTP and the running version is visible. Existing `debugMode`/`pendingCaptures` fields unchanged.

## 2.3.0 — 2026-05-25

### Added

- **Web upgrade/sponsor banner** — Dismissible top banner announcing the v2 upgrade and offering a single sponsor logo slot. State persisted in `localStorage`.
- **`AI_DISABLED` flag** — Setting `AI_DISABLED=1` skips all AI calls (explain + deep) in the web service, avoiding wasted latency/retries when the API key is unavailable. Startup log reflects the state.

### Fixed

- **Persistent captures + stats** — Debug/consent captures (`DEBUG_DIR`) and `stats.json` now live under the data root (`AL_PERF_DATA_DIR`, `/data` in Docker), so they survive container redeploys instead of landing in the ephemeral container layer.
- **Privacy: no IP in consent captures** — Removed `consentedBy` (visitor IP) from saved consent capture metadata, matching the "anonymously" wording.

## 0.1.0 — 2026-03-05

Initial feature-complete release with 27 analysis capabilities across three tiers.

### Tier 1: Immediate Wins

- **Wall Clock vs CPU Gap Analysis** — Compare wall-clock duration to CPU time for instrumentation profiles, revealing I/O waits and SQL roundtrips
- **Built-in vs Custom Code Separation** — Classify nodes as built-in or custom using `isBuiltinCodeUnitCall`, enabling a "your code only" view
- **Line-Level Hotspot Map** — Break down `positionTicks[]` to produce line-by-line time attribution within methods (instrumentation profiles)
- **Cost Per Hit** — Compute `selfTime / hitCount` to normalize away call frequency and reveal intrinsic per-invocation cost
- **Recursive Call Detection** — Detect direct and indirect recursion in the call tree with depth and time reporting
- **Method Efficiency Score** — Compute `selfTime / totalTime` ratio to distinguish compute-bound methods from orchestrators
- **Hotspot-to-Source Deep Link** — Resolve each hotspot method to its source file location via tree-sitter-al, including file path and line range
- **Call Amplification Factor** — Compute `child.hitCount / parent.hitCount` on every edge to surface inner-loop fan-out

### Tier 2: High-Value Analysis

- **Critical Path Extraction** — Walk the call tree to find the single longest root-to-leaf path by totalTime
- **Variable Type Resolution** — Extract Record variable types from `var_section` declarations, mapping variable names to table references
- **Temporary Table Detection** — Detect `temporary` keyword on record variables and `SourceTableTemporary` on pages; exclude from N+1 warnings
- **"What If" Optimization Estimator** — Estimate time savings for each detected pattern (e.g., "fixing saves ~998ms")
- **Event Chain Tracer** — Trace full publisher → subscriber → transitive chains showing which events cause the most expensive cascades
- **Pattern-Level Comparison** — Extend profile comparison to include pattern differences: new, resolved, and severity-changed patterns
- **Profile Confidence Score** — 0–100 score based on sampling jitter, incomplete measurements, idle ratio, sample count, and duration
- **Commit/Error in Loop Detection** — Detect `Commit()`, `Error()`, and `TestField()` calls inside loops as severe anti-patterns
- **CalcField Complexity Scoring** — Parse `CalcFormula` from table declarations; graduate severity (SUM FlowField = critical, LOOKUP = warning)
- **Event Publisher/Subscriber Catalog** — Parse `[IntegrationEvent]`, `[BusinessEvent]`, and `[EventSubscriber]` attributes into a publisher→subscriber mapping
- **MCP Flamegraph Tool** — MCP tool that posts profile data to AL-Flamegraph API for interactive SVG visualization
- **Subtree Drill-Down** — Show a method's subtree time attribution breakdown (e.g., "60% SQL, 25% events, 15% own code")
- **Per-Instance Method Statistics** — Compute min/max/mean/median/p95/p99 of selfTime across multiple calls of the same method (instrumentation profiles)
- **Profile Health Score** — Single 0–100 score summarizing overall profile health from pattern counts, idle %, and timing distribution

### Tier 3: Strategic Investments

- **Field Reference Mapping** — Track which table fields are accessed per procedure via `field_access` and `field_ref` nodes; validate SetLoadFields coverage
- **Table Key Analysis** — Parse `key_declaration` from table declarations; cross-reference with SetRange/SetFilter to detect unindexed filter operations
- **Performance History Store** — JSON-based local store for tracking analysis results over time with CLI (`history list/trend/clear`) and MCP tools (`history_list`, `history_trend`)
- **Table-Centric View** — DBA-oriented analysis pivoting around database tables: per-table operation breakdown, call site counts, SetLoadFields/filter usage
- **Table Relationship Graph** — Parse `TableRelation`, `CalcFormula` references, and `lookup_where_conditions` to build a graph of table relationships

### Infrastructure

- **Section Registry** — Compile-time `SectionRenderers<T>` type ensures all formatters (terminal, markdown, HTML) render every section; TypeScript errors on missing sections
- **Formatter Parity** — Object breakdown, confidence/health scores, and pattern suggestions rendered consistently across all output formats and web UI
