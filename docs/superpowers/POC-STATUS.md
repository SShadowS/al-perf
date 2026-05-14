# Continuous Monitoring POC — Status

**Last updated:** 2026-05-05
**Plan:** [2026-04-13-poc-v0-v1.md](plans/2026-04-13-poc-v0-v1.md)
**Scope:** [2026-04-13-poc-scope.md](specs/2026-04-13-poc-scope.md)
**Design (rev 2):** [2026-04-13-continuous-monitoring-design.md](specs/2026-04-13-continuous-monitoring-design.md)

## Summary

POC **v0 (plaintext flow)** and **v1 (encrypted flow)** are code-complete and committed in both
repos. Node-side round-trip verified automatically. BC-side AL compiles and publishes to a BC28
sandbox. End-to-end interactive smoke test in the BC sandbox is the remaining manual step.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | Branch + gitignore setup | ✅ done |
| A | al-perf web v0 — plaintext ingest/serve | ✅ done |
| B | al-perf-bc v0 — Job Queue ship codeunit, tables, pages | ✅ done |
| C1 | v0 e2e BC sandbox smoke test | ⚠️ partial — compiles + publishes; interactive page test pending |
| D | al-perf web v1 — RSA/AES/HMAC encryption | ✅ done |
| E | al-perf-bc v1 — crypto codeunit + decrypt-on-open | ✅ done |
| F1 | v1 cross-language e2e | ⚠️ partial — Node round-trip ✅; BC decrypt interactive test pending |
| F2 | README updates | ✅ done |

## Commits

- **al-perf** `master` — branch `poc-continuous-monitoring` merged; latest POC work through
  the Biome adoption + tooling commits. Pushed to origin.
- **al-perf-bc** `main` — POC v0+v1 commits `d5ffe66`..`960302a`. Pushed to origin.

## Verified

- `bun test test/web/` — 23 POC web tests pass (storage, poc-secret, tenants, ingest v0+v1,
  profiles, crypto round-trip).
- `continia compile al-perf-bc` — AL extension compiles clean on BC28 (only the two
  acknowledged AL0796 `Unwrap` warnings).
- `continia publish` — extension published to BC28 sandbox env
  `f8aec760-ab47-4a32-8707-a4133ea8d400`.
- `bun run scripts/poc-roundtrip.ts` — register → encrypted ingest → fetch bundle → decrypt
  with private key, `blob match: true`. Validates RSA-OAEP-SHA1 + AES-256-CBC + HMAC-SHA256
  (Strategy B) + manifest-hash binding.

## Pending

1. **BC interactive smoke test** (C1 / F1 manual steps) — at the BC sandbox:
   - Configure `AL Perf Ship Setup Card`: Tenant Code, Server URL Base, Bearer Secret.
   - `Register Tenant`, enable, trigger profiler, `Ship Now`.
   - `AL Perf Ship Log List` → `Open Profile` → confirm decrypt + render.
   - Tamper test: flip a byte in `web/data/storage/<tenant>/profiles/<id>/blob.enc`,
     confirm `Open Profile` errors with HMAC mismatch and marks the row Failed.
2. **Milestone tags** — `poc-v0` and `poc-v1` not yet applied (plan says human applies them).
3. **POC v2** — not started. See [poc-scope.md](specs/2026-04-13-poc-scope.md) "POC v2" section
   (HMAC request signing, bootstrap tokens, atomic ingest, idempotency, compression, BYO
   Anthropic key).

## Known POC limits (do NOT ship to customers)

- Bearer secret in plaintext header — replay possible. v2 adds HMAC request signing.
- `register` endpoint accepts repeat registration after data-dir wipe — no bootstrap token.
- Inline (non-queued) analyze in `/api/ingest` — large profile blocks the request handler.
- Single key version, no rotation. No backup format — lose private key = lose history.
- No compression — large profiles may hit the AL Rijndael Base64 ceiling (~8 MB).
- HMAC computed over Base64-text concat (Strategy B) — correct, slightly non-standard;
  documented interop choice.

## Environment notes

- BC sandbox env id: `f8aec760-ab47-4a32-8707-a4133ea8d400` (continia DemoPortal, BC28 DK).
- al-perf web for the POC runs locally; expose to the BC sandbox via a tunnel (ngrok /
  cloudflared) since the sandbox container cannot reach `localhost`.
- Run web side: `AL_PERF_POC_SECRET="<secret>" PORT=3010 bun run web/server.ts`.
