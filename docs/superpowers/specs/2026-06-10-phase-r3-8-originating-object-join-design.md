# R3-8: originatingObject join — app-scoped attribution precision — Design

> **Context:** The P3 spec's RE-8 / the P3.2 final review deferred wiring `originatingObject` (the
> declaring object's StableObjectId, emitted by the frozen engine on inventory routines + `--with-evidence`
> findings) into the al-perf fusion join. Today al-perf joins on `(canonicalObjectType, objectNumber,
> normalizeTriggerName(functionName))` + (P3.2) `enclosingMember` — but NO app identity. `originatingObject`
> is parsed onto `RoutineIdentity`/`FindingLocation` and then ignored. This is the focused follow-up to use
> it. Built on `feat/alsem-fusion`. Additive — graceful when the engine doesn't emit it (old schema).

## Goal
Use the declaring-app identity to make attribution APP-SCOPED and resolve residual collisions:
1. **App-scoping (the real value):** BC object numbers are APP-SCOPED — `Table 36` in the Base
   Application and `Table 36` in app B are DIFFERENT objects. A CPU-profile is multi-app (Base App +
   extensions + the primary app); the al-sem inventory is the ONE workspace app. Today the join
   `(Table, 36, OnValidate)` could spuriously match a Base-App profile frame to the primary app's
   inventory routine if their object numbers coincide. `originatingObject` (which carries the app GUID)
   + the profile frame's `declaringApplication.appId` let us GATE the match to the same app.
2. **Residual member-collision disambiguation:** when the precise `(objectType, objectNumber, member,
   trigger)` key still resolves to >1 inventory routine with DIFFERENT `originatingObject`s, the profile
   frame's app identity disambiguates (vs a genuine overload — same originatingObject — which stays
   ambiguous).
3. **Provenance display:** surface "in <extension>" when `originatingObject` differs from the base object.

## What the profile carries (verified, RE-10)
Each frame: `callFrame.scriptId` (e.g. `"PageExtension_50022"` / `"Table_36"`) + `declaringApplication.appId`
(e.g. `"0c88976eb8e346de92016247df5e6f67"` — dash-less hex) + appName/appVersion. So a frame identifies
its declaring object as `(appId, objectType, objectNumber)`. The engine's `originatingObject` is the
`:`-form StableObjectId `appGuid:ObjectType:Number` (dashed GUID, e.g. `11111111-d1it-...:Table:72100`).
GUID normalization (strip dashes + lowercase, as P4.2's `normalizeAppGuid`) bridges the two forms.

## Components

### R3-8a — carry `appId` on MethodBreakdown
`MethodBreakdown` (`types/aggregated.ts`) gains `appId?: string` (the declaring app GUID, dash-less hex
from the frame). `aggregateByMethod` (`core/aggregator.ts`) reads `node.declaringApplication?.appId`
(P4.2 already threads `appId` onto the node). A method aggregates frames of one routine → one app → one
appId (consistent; if frames disagree, take the first/dominant — flag as a soundness check). Additive
optional field.

### R3-8b — reconstruct + match originatingObject in correlate
A method's originating-object form = `normalizeGuid(appId):canonicalObjectType:objectId`. A routine's
`originatingObject` normalized the same way. In `correlate.ts`:
- **App-scoping (gate):** when the bare/precise key resolves a candidate, additionally require the
  method's normalized originating-object app GUID to match the candidate routine's `originatingObject`
  app GUID — BUT only when BOTH sides have the identity (the method has an `appId` AND the routine has
  `originatingObject`); otherwise fall back to today's app-agnostic match (graceful — old engine /
  System frames with no appId). This prevents a cross-app object-number false match.
- **Residual collision:** in the precise-member >1 branch, when candidates have DIFFERENT
  `originatingObject`s, pick the one whose normalized originatingObject matches the method's
  reconstructed form → `matched`. Same-originatingObject candidates (genuine overload) stay `ambiguous`.

### R3-8c — surface originatingObject provenance (display)
In the fusion views/renderers, when a matched routine's `originatingObject` names a DIFFERENT object than
the hotspot's own (an extension-declared member), show "(declared in <displayName/originatingObject>)".
Minor, additive, gated on presence.

## Honesty / non-invasiveness
- Graceful: a method without `appId` (System frames, old profiles) or a routine without `originatingObject`
  (old engine) → fall back to today's app-agnostic join (no regression). The app-scope gate ONLY tightens
  when both identities are present.
- App-scoping can only REMOVE a wrong cross-app match (tighten), never invent one — additive precision.
- Determinism preserved; fusion-off byte-unchanged.

## Risks for the (adversarial) review to stress
1. **The real collision class (the #1 question):** is the "two extensions, same base field" collision the
   P3 review imagined REAL, given each AL extension owns its own object NUMBER (so two extension routines
   don't share `objectNumber`)? Or is the genuine, COMMON collision the cross-app object-number case
   (Base App Table 36 vs primary Table 36)? Determine which collisions actually occur and confirm R3-8
   resolves the real one (app-scoping), not a phantom one.
2. **Inventory app scope:** does the al-sem `routine-inventory` contain ONLY the primary workspace app's
   routines, or dependency/opaque apps too? If only the primary app, then the app-scope gate's effect is:
   reject profile frames from OTHER apps that coincidentally share an object number with a primary-app
   routine. Confirm the inventory scope (read engine-runner's inventory parse + the coverage/opaqueApps
   model) so the gate is sound (we must not reject a legitimate primary-app frame).
3. **appId consistency on a method:** a `MethodBreakdown` aggregates frames; could frames of "the same"
   (functionName, objectType, objectId) come from DIFFERENT apps (the app-scoped-number collision means
   two apps' Table 36 OnValidate aggregate into ONE MethodBreakdown today!)? If so, the method's appId is
   ambiguous and the aggregation itself is unsound — does R3-8 need to also key aggregation by appId
   (a deeper change)? This is the crux: if the profile aggregation already collapses two apps' same-number
   objects, carrying one appId is lossy.
4. **GUID normalization:** dash-less profile appId vs dashed engine appGuid — confirm normalize bridges
   them (reuse P4.2's normalizeAppGuid); any app whose profile appId isn't a GUID (System)?
5. **Additivity/graceful:** the both-identities-present gate; no regression for old engine / System frames;
   determinism.

## Non-goals
Changing the engine (originatingObject is already emitted). The display polish beyond a provenance note.
Re-keying the profile aggregation by appId IF the review finds it unnecessary (but see risk #3 — if
aggregation collapses cross-app same-number objects, that's the real bug to surface).

## VERIFIED crux (risk #3 confirmed)
`aggregateByMethod` (`core/aggregator.ts:62`) keys by `${functionName}_${objectType}_${objectId}` — NO
appId. BC object numbers are APP-SCOPED, so two different apps' `Table 36 OnValidate` collapse into ONE
`MethodBreakdown` (times summed, first-seen appName kept). This is a latent cross-app CONFLATION bug
independent of fusion. Consequence for R3-8: carrying "one appId" on a conflated method is lossy. The
DESIGN FORK the review must resolve:
- **Option A (de-conflate):** re-key `aggregateByMethod` (+ `compareProfiles`' delta key) by appId
  (`functionName_objectType_objectId_appId`). Correct base behavior; each method gets a well-defined
  appId; R3-8's app-scope join becomes sound. BLAST RADIUS: changes the method breakdown for any profile
  with a cross-app object-number collision (splits a previously-merged row) → hotspots/comparison output
  shifts; snapshot updates; every aggregateByMethod consumer. How common is the collision in practice
  (AppSource apps get unique ranges; PTEs share 50000-99999 — a real but uncommon collision)?
- **Option B (best-effort):** keep aggregation; carry first-seen/dominant appId; the app-scope gate is
  best-effort (correct in the common no-collision case, lossy in the rare collision). Smaller, no base
  output change.
The review must recommend A or B (and if A, scope the blast radius). The user values correctness ("best
solution") — A is likely right IF the blast radius is contained, but the empirical collision frequency
governs whether it's worth the base-output churn.

## Self-review notes
- The HEADLINE value is app-scoping (risk #1/#3), not the rare two-extensions edge — the design must
  confirm the real collision class before implementing.
- Reuses P4.2's `normalizeAppGuid` + the appId-on-node threading; the canonical join helpers.
- Additive + graceful; tightens only when both app identities are present.
