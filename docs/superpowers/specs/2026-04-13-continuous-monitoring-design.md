# Continuous Monitoring — Auto-Ship Design

**Date:** 2026-04-13 (rev 2 — post-review hardening)
**Status:** Draft, awaiting user review
**Scope:** Phase 1 — auto-ship of Scheduled Profiler results from Business Central to al-perf platform, with end-to-end encryption, replay-resistant auth, and durable acceptance.

## Changelog (rev 1 → rev 2)

- **CRITICAL fix:** manifest integrity binding now reconstructible — server stores original manifest bytes as plaintext sidecar; BC hashes those exact bytes.
- **CRITICAL fix:** `tenantCode`/`activityId` strictly validated and path-resolved to prevent traversal.
- **CRITICAL fix:** durable acceptance — server persists idempotency record + raw payload to disk before returning 202; BC status `Accepted` (transport ack), distinct from terminal `Stored` (server confirmed).
- **HIGH fix:** auth uses HMAC-SHA256 request signing (timestamp + nonce + body hash). Tenant secret never retransmitted after registration. First-time registration requires server-issued bootstrap token.
- **HIGH fix:** Anthropic key handling — explicit log-scrubbing requirements, in-memory side channel from request to worker, never persisted in idempotency record.
- **HIGH fix:** public key rotation concrete — per-tenant versioned key ring at server, version stamp on every ciphertext, BC retains private key ring.
- **HIGH fix:** tenant secret rotation endpoint added; KEK-envelope encryption of stored secrets.
- **HIGH fix:** backup format = encrypted XML blob (PBKDF2 + AES-256-CBC + HMAC), pure AL, Cloud-safe. PFX dropped.
- **HIGH fix:** profile compression (gzip via `Data Compression` codeunit) before encrypt, plus chunking strategy + max-payload caps. Solves Rijndael Base64 ceiling.
- **HIGH fix:** explicit multipart size limits + temp-storage caps.
- **HIGH fix:** `var SecretText` out parameter pattern (replaces TryFunction returning SecretText).
- **MEDIUM fix:** byte layout of `blob.enc` / `result.enc` explicit (16 IV + 32 tag + ciphertext).
- **MEDIUM fix:** HMAC computed over raw bytes via `GenerateHash(InStream, ...)` overload; no Base64-text-concat ambiguity.
- **MEDIUM fix:** idempotency record state machine (queued / processing / done / failed) with cached response replay.
- **MEDIUM fix:** worker DLQ + status endpoint.
- **MEDIUM fix:** retry policy nuanced (4xx terminal except 408/429; 5xx + connection retried until retention deadline).
- **MEDIUM fix:** threat model reworded — plaintext `metrics.json` / `manifest.json` confidentiality NOT claimed; encryption protects raw blob, AI text, method/object names.

## Problem

al-perf today is a diagnostic tool — someone hands it a `.alcpuprofile`, it analyzes it. To become a monitoring platform, profiles must flow from BC environments to the platform automatically, get analyzed, persisted, trended, and surfaced as alerts on regression.

Microsoft's Scheduled Performance Profiler is the natural collection mechanism: individual `.alcpuprofile` per activity, rich metadata, supported in BC SaaS. Weakness: 1-week retention, no analysis layer. al-perf fills the gap.

This spec covers BC-side shipping + al-perf-side ingestion + encryption. Dashboard / regression alerting / trending UI consume what this spec produces.

## Goals

1. **Hands-off shipping.** Job Queue ships new profiles to al-perf without user action.
2. **End-to-end encryption.** Sensitive payload (raw blob, AI narrative, method/object names) encrypted at rest with tenant-controlled keypair.
3. **BYO Anthropic key.** Customer pays own AI cost for scheduled monitoring; web one-off uploads stay free.
4. **OnPrem demo, Cloud-ready.** Same AL code path for OnPrem demo today and Cloud production after MS unblocks platform table access.
5. **Replay-resistant auth.** No retransmitted secrets after registration; bounded replay window.
6. **Durable acceptance.** Server confirms persistence before 202; BC distinguishes transport ack from terminal storage state.
7. **Resilient.** Survives transient errors, BC's profile-emission delay, BC's 1-week retention, server worker failures.

## Non-goals

- Dashboard / web UI for tenants (separate spec).
- Cross-tenant aggregation.
- Synchronous AI analysis on shipping path.
- Schedule provisioning from al-perf (orchestrator-side, separate spec).
- Confidentiality of plaintext metrics — see threat model.

## Threat model

| Threat | Mitigation | Notes |
|---|---|---|
| Network MITM | TLS 1.2+ | Required |
| Disk compromise of encrypted bundle (raw blob, AI text, method/object names) | Hybrid encryption — RSA-OAEP + AES-256-CBC + HMAC-SHA256 | Encrypted at rest |
| Disk compromise of plaintext `metrics.json` / `manifest.json` | Not mitigated; accepted | Numeric trends + manifest fields not classified as business secret. Document in customer onboarding. |
| Disk compromise of tenant secret store | KEK envelope (AES-256-GCM with server master KEK) | KEK from env / KMS, never on disk |
| Tenant ID enumeration on read APIs | Strict `tenantCode` regex + HMAC-signed reads | Path-validated, normalized |
| Path traversal via `tenantCode`/`activityId` in filesystem paths | Regex allowlist + path-normalize-and-verify-under-base | Server-side validation gate |
| Log leakage of secrets / Anthropic key | Mandatory header + body scrubbing in proxy/app/error/job paths | Compliance test in build order |
| Replay of valid auth requests | HMAC over `(method,path,ts,nonce,body-hash)` + 5-min ts skew + 10-min nonce cache | |
| Replay of registration | Bootstrap token (one-time, server-issued, time-bounded) | |
| Anthropic key theft from worker state | In-memory side channel; never persisted in idempotency or DLQ | |
| Loss of tenant private key | Encrypted XML backup blob (PBKDF2 + AES + HMAC), passphrase-protected | Pure AL, Cloud-safe |
| Plaintext temp staging during queue handoff | Acknowledged Phase 1 limitation; brief on-disk window | Production: RAM-backed `tmpfs` for `_inflight/` |
| Worker silently losing accepted profiles | Idempotency record persisted before 202; worker advances state machine | DLQ for unrecoverable analyses |

## Architecture

```
┌──────────────────────────┐         ┌────────────────────────────┐
│  Business Central        │         │  al-perf platform          │
│                          │         │                            │
│  Scheduled Profiler ─────┼─writes─►│                            │
│  └─ Performance Profiles │         │                            │
│                          │         │                            │
│  al-perf-bc (extension)  │         │                            │
│  ├─ Setup card           │         │                            │
│  ├─ AL Perf Ship Setup   │         │                            │
│  ├─ AL Perf Ship Log     │         │                            │
│  ├─ AL Perf Auto Ship    │  POST   │  /api/tenants/register     │
│  │  (Job Queue codeunit) │ ────────►  /api/tenants/{id}/...     │
│  ├─ AL Perf Crypto       │         │  /api/ingest               │
│  │  (key ring + HMAC)    │         │     ├─ size-checked        │
│  └─ private keys (Iso.   │         │     ├─ HMAC verify         │
│     Storage, versioned)  │         │     ├─ durable _inflight/  │
│                          │  GET    │     └─ 202 accepted        │
│  Decrypt+display action ◄┼─────────  worker:                    │
│                          │         │     ├─ analyze             │
│                          │         │     ├─ encrypt to pubkey   │
│                          │         │     └─ persist ciphertext  │
│                          │         │  DLQ on failure            │
└──────────────────────────┘         └────────────────────────────┘
```

## Identifiers and validation

| Identifier | Format | Validation |
|---|---|---|
| `tenantCode` | `^[a-z0-9][a-z0-9-]{0,39}$` | Server rejects 400 if invalid; never used in path before validation |
| `activityId` | RFC 4122 v4 GUID | Server rejects 400; case-normalized lowercase |
| `keyVersion` | Positive integer, monotonic per tenant | Server rejects non-incrementing |
| `nonce` | 8 random bytes, Base64 (12 chars) | Server tracks `(tenantCode, nonce)` for 10 min |
| `ts` | Epoch milliseconds | Server rejects if `|now - ts| > 5 min` |

All filesystem paths derived from these MUST be normalized via `path.resolve` and verified to start with the intended base directory before any I/O.

## Auth & identity lifecycle

### Bootstrap token (first-time registration)

1. Operator obtains a bootstrap token from al-perf admin CLI:
   ```
   al-perf admin issue-token --tenant acme-prod --hours 1
   → token: "bt_8f3a...dc91"   (32 random bytes Base64url)
   ```
   Server stores `web/bootstrap-tokens/{SHA-256(token)}.json` = `{tenantCode, expiresAt, used:false, issuedAt}`.
2. Operator pastes token into BC setup card.
3. BC POSTs `/api/tenants/register`:
   ```
   POST {endpoint}/api/tenants/register
   Headers:
     Content-Type: application/json
   Body:
     {
       "tenantCode":      "acme-prod",
       "publicKeyXml":    "<RSAKeyValue>...</RSAKeyValue>",
       "keyVersion":      1,
       "bootstrapToken":  "bt_8f3a...dc91",
       "tenantTag":       "ACME Production",
       "bcEnvironment":   "production",
       "bcVersion":       "28.0.46665.48549"
     }
   ```
   No secret in body.
4. Server: validate token (matches, unused, not expired). Generate fresh `tenantSecret` (32 random bytes Base64). Wrap with KEK (AES-256-GCM). Store in tenant record. Mark token used. Return:
   ```
   201 Created
   {
     "tenantCode": "acme-prod",
     "tenantSecret": "<plaintext-Base64>",   ; returned ONCE
     "currentKeyVersion": 1,
     "registeredAt": "..."
   }
   ```
5. BC stores `tenantSecret` immediately in `IsolatedStorage` `'al-perf-tenant-secret'`. If user navigates away before save, registration is unrecoverable — must re-issue token.
6. Subsequent POSTs to `/api/tenants/register` for known `tenantCode` → 409.

### Request signing (every authenticated call)

```
Authorization: HMAC-SHA256 keyId=acme-prod, ts=1747920000000, nonce=Yk9zQjZxV2c=, sig=<base64>
```

```
sig = HMAC-SHA256(
  key = tenantSecret,
  data = METHOD || '\n' ||
         PATH   || '\n' ||
         ts     || '\n' ||
         nonce  || '\n' ||
         SHA-256(body-bytes)
)
```

Server verification:
1. Parse header components. Else 401.
2. Validate `keyId` regex; load tenant record; KEK-unwrap stored `tenantSecret`. Else 401.
3. Reject if `|now - ts| > 5 min`. Else 401.
4. Reject if `(tenantCode, nonce)` already in 10-min replay cache. Else 401.
5. Compute expected sig over received bytes. Constant-time compare.
6. On mismatch: 401. On match: insert nonce into replay cache, proceed.

### Tenant secret rotation

```
PATCH /api/tenants/{tenantCode}/secret
Authorization: HMAC-SHA256 ... (signed with current secret)
Body: {} (empty)
```

Server: verify auth, generate new secret, KEK-wrap, atomic store-swap, return `{tenantSecret: <new plaintext>}`. Old secret rejected immediately. BC must update IsolatedStorage on success. If BC update fails, tenant locked out — recovery requires new bootstrap token.

### Public key rotation

```
PATCH /api/tenants/{tenantCode}/public-key
Authorization: HMAC-SHA256 ... (signed with current secret)
Body:
  {
    "publicKeyXml": "<RSAKeyValue>...</RSAKeyValue>",
    "keyVersion": 2
  }
```

Server: verify auth, validate `keyVersion = currentKeyVersion + 1`. Append to `publicKeys[]` ring, set `currentKeyVersion`. Existing ciphertext stays decryptable with retained BC privkey ring.

BC retains every private key in IsolatedStorage as `'al-perf-private-key-{N}'` indefinitely (until manual purge action when no historical profile under that version exists in al-perf).

### Log scrubbing requirements (mandatory, server-side)

- Reverse proxy: never log `Authorization`, `X-Anthropic-Api-Key`, any cookie. Strip from access log format.
- App framework: only allowlisted structured fields. No raw body. No header dump on errors.
- Error/exception telemetry (Sentry/etc.): scrub headers + body before send.
- Worker job state: Anthropic key passed via in-memory side channel. NEVER serialized to idempotency record, DLQ, or job queue persistence layer. Worker reads, copies to local var, unlinks side-channel file before analyze. Wipe local var (overwrite) after analyze.
- Compliance test (in build order step 1 & 2): replay full ingest with grep over `journalctl`/log files for known token bytes; assert zero matches.

## Data flow

### Per-profile ship (BC side, runs on Job Queue)

Codeunit 70503 `AL Perf Auto Ship` `OnRun()`:

1. Load `AL Perf Ship Setup`. Exit if not `Enabled`.
2. Compute window:
   ```
   windowStart = if FirstRun then (now - LookBackWindow hours)
                 else (LastRun - 1h overlap)
   ```
3. Filter `Performance Profiles`:
   - `"Starting Date-Time" >= windowStart`
   - Setup's `Schedule ID Filter` if set
   - Setup's `Activity Type Filter` if set
4. Skip count = 0. Shipped count today = COUNT of `AL Perf Ship Log` with `Shipped At >= today`.
5. For each candidate profile:
   1. Skip if exists in `AL Perf Ship Log` with status ∈ {Accepted, Stored}.
   2. Skip if `Activity Duration < MinActivityDuration` → log row Skipped (reason: filter).
   3. Skip if shipped count today >= `Daily Ship Limit` → log row Skipped (reason: limit). Increment skipped-today.
   4. Read `Profile` BLOB. Skip if size > 30 MB → log row Skipped (reason: oversize).
   5. Insert/update `AL Perf Ship Log` Pending.
   6. Compress via `Codeunit "Data Compression"` (gzip). Build multipart with `X-Profile-Encoding: gzip`.
   7. Compute `Authorization` via `AL Perf Crypto.SignRequest('POST', '/api/ingest', bodyInStream)`.
   8. POST to `{endpoint}/api/ingest` with timeout 120s.
   9. On 202 → mark `Accepted`, store `Server Profile ID`, `Key Version`. Increment shipped-today.
   10. On 400/401/403/413: mark `Failed` (terminal), store reason. Don't retry.
   11. On 408 (Request Timeout) / 429 (Too Many Requests) / 5xx / connection error: leave Pending. Retry next run. Cutoff: `min(profile age + 6 days, 5 attempts)` — whichever comes first stops retrying with terminal Failed.
6. Update `Last Run DateTime`, set `Skipped Today (Limit Hit)` count, clear or set `Last Error`.

After main loop, async refresh: for `Accepted` rows older than 5 min, GET `/api/tenants/{id}/profiles/{activityId}/status`. Advance to `Stored` or `AnalysisFailed` based on terminal idempotency state.

### Ingest request format

```
POST {endpoint}/api/ingest
Headers:
  Authorization:        HMAC-SHA256 keyId=acme-prod, ts=..., nonce=..., sig=...
  X-Anthropic-Api-Key:  sk-ant-...                  (optional — header omitted if no key configured)
  X-Idempotency-Key:    <activityId GUID>           (server dedupes)
  X-Profile-Encoding:   gzip | identity
  Content-Type:         multipart/form-data; boundary=...

Parts:
  manifest (application/json):
    Server stores BYTE-FOR-BYTE as `manifest.json` sidecar. BC reproduces hash from these exact bytes.
    Schema:
    {
      "activityId": "...",
      "activityType": "Background",
      "activityDescription": "...",
      "startTime": "ISO8601 with offset",
      "activityDuration": 1234,
      "alExecutionDuration": 567,
      "sqlCallDuration": 200,
      "sqlCallCount": 15,
      "httpCallDuration": 0,
      "httpCallCount": 0,
      "userName": "...",
      "clientSessionId": "...",
      "scheduleId": "...",
      "scheduleDescription": "..."
    }

  profile (application/octet-stream):
    raw .alcpuprofile bytes, possibly gzip-compressed (per X-Profile-Encoding)
```

### Size limits

| Component | Hard limit |
|---|---|
| Total request body | 50 MB |
| `manifest` part | 64 KB |
| `profile` part (compressed or identity) | 50 MB |
| BC-side pre-compress profile blob | 30 MB |
| Per-profile `_inflight/` temp space | 100 MB |
| Server `_inflight/` total disk reserve | refuse new request if disk free < 500 MB |

Server reads `Content-Length` header before parsing; rejects 413 if exceeded. Streaming parser enforces per-part caps.

### Server-side processing (al-perf web)

1. Parse `Authorization`. HMAC verify per "Request signing" above. 401 on failure.
2. Validate `tenantCode` from `keyId` and `activityId` from `X-Idempotency-Key`. 400 on failure.
3. Validate Content-Length, Content-Type, encoding header. 413/400 on failure.
4. Load idempotency record `storage/{tenantCode}/idempotency/{activityId}.json`:
   ```
   { state: "queued"|"processing"|"done"|"failed",
     responseStatus, responseBody,
     createdAt, finishedAt, errorReason }
   ```
   - If `done` or `failed`: return cached `(responseStatus, responseBody)` unchanged.
   - If `queued` or `processing`: return cached 202.
   - If absent: proceed.
5. Multipart parse with size enforcement.
6. **Durable acceptance** — write to `storage/{tenantCode}/_inflight/{activityId}/`:
   ```
   manifest.json    ; exact bytes of multipart manifest part
   profile.bin      ; raw bytes of multipart profile part
   encoding.txt     ; "gzip" or "identity"
   anthropic.tmp    ; Anthropic key bytes if header present, file mode 0600 (owner read-only)
   ```
   Then write idempotency record `state:"queued"`.
7. Return:
   ```
   202 Accepted
   { "id": "<activityId>", "status": "accepted" }
   ```

Worker (separate process — Phase 1: filesystem-watch on `_inflight/`; Phase 2: queue table):

1. Detect new `_inflight/{activityId}/` directory.
2. Move idempotency state → `processing`.
3. Read `profile.bin`. If `encoding.txt == gzip`, decompress in-memory.
4. Read `anthropic.tmp` → in-memory string. `unlink` file immediately (best-effort secure delete; production: zero-overwrite first).
5. `analyzeProfile(profileBlob, {explainOpts: anthropicKey ? {deep:true, apiKey:anthropicKey} : undefined})` → `AnalysisResult`.
6. Wipe `anthropicKey` local var (overwrite buffer).
7. Encrypt with current tenant pubkey (key version recorded):
   - `K_enc` = 32 random bytes from CSRNG.
   - `K_mac` = 32 random bytes from CSRNG.
   - `IV1` = 16 random bytes from CSRNG.
   - `IV2` = 16 random bytes from CSRNG.
   - `manifestBytes` = exact bytes of `_inflight/{activityId}/manifest.json` (already committed to disk; no canonicalization step).
   - `manifestHash`   = `SHA-256(manifestBytes)` (32 bytes raw).
   - `ciphertextBlob`   = `AES-256-CBC(K_enc, IV1, profileBlob)` with PKCS#7 padding.
   - `ciphertextResult` = `AES-256-CBC(K_enc, IV2, utf8Bytes(JSON.stringify(result)))`.
   - `tagBlob`   = `HMAC-SHA256(K_mac, IV1 || manifestHash || ciphertextBlob)` — raw byte concatenation.
   - `tagResult` = `HMAC-SHA256(K_mac, IV2 || manifestHash || ciphertextResult)`.
   - `wrapped`   = `RSA-OAEP-SHA1(tenant_pubkey_at_currentKeyVersion, K_enc || K_mac)`. (OAEP-SHA1 is the AL `RSA.Encrypt(...,OaepPadding=true,...)` guaranteed default. 64-byte payload + RSA-3072 leaves ample security margin.)
8. Build `metrics.json` (plaintext, server-derived):
   ```
   {
     activityId, scheduleId, activityType, startTime,
     activityDuration, alExecutionDuration,
     sqlCallDuration, sqlCallCount,
     httpCallDuration, httpCallCount,
     totalDuration, activeSelfTime, idleSelfTime,
     nodeCount, maxDepth, healthScore, confidenceScore,
     patternCounts: { critical, warning, info },
     blobHash: SHA-256(profileBlob),
     keyVersion: <int>,
     analyzedAt: "..."
   }
   ```
   Method names, object names, AI text — never written to `metrics.json`.
9. Persist atomically to `storage/{tenantCode}/profiles/{activityId}/`:
   ```
   manifest.json   ; copy from _inflight (exact bytes)
   metrics.json    ; from step 8 (plaintext, queryable)
   wrapped.bin     ; 384 bytes (RSA-3072 OAEP ciphertext)
   blob.enc        ; bytes [0..16) IV1, [16..48) tagBlob, [48..) ciphertextBlob
   result.enc      ; bytes [0..16) IV2, [16..48) tagResult, [48..) ciphertextResult
   keyversion.txt  ; "<currentKeyVersion>"
   ```
   Atomic moves via `rename` after fsync.
10. Update idempotency `state:"done"`, `responseBody:{id, status:"stored", keyVersion, sizes:{...}}`.
11. Remove `_inflight/{activityId}/` directory (recursive).
12. Wipe `profileBlob` and `result` from memory.

On worker exception:
- Update idempotency `state:"failed"`, `errorReason:"..."`, `responseStatus:500` (returned on subsequent reads).
- Move `_inflight/{activityId}/` → `_dlq/{activityId}/` for human inspection.
- BC's status endpoint poll surfaces `AnalysisFailed`.

### Decryption (BC side)

User clicks **Open Profile** on `AL Perf Ship Log` row →

1. GET `/api/tenants/{tenantCode}/profiles/{activityId}` HMAC-signed. Server returns:
   ```
   {
     keyVersion: 2,
     manifest:   "<base64 raw bytes>",
     metrics:    { ... },
     wrapped:    "<base64 384 bytes>",
     blob:       { iv: "<base64 16>", tag: "<base64 32>", ciphertext: "<base64 N>" },
     result:     { iv: "<base64 16>", tag: "<base64 32>", ciphertext: "<base64 M>" }
   }
   ```
2. `AL Perf Crypto.GetPrivateKeyForVersion(KeyVersion, var PrivateKeyXml: SecretText): Boolean`. If false → error 'no matching private key for version N — restore from backup'.
3. `RSA.Decrypt(PrivateKeyXml, WrappedInStream, true /*OaepPadding=true*/, KeysOutStream)`. Read 64 bytes; split `K_enc[0..32]`, `K_mac[32..64]`. Both held as Base64 SecretText.
4. Decode `manifest` base64 → manifest bytes InStream. Compute `manifestHash = CryptographyManagement.GenerateHash(manifestInStream, HashAlgorithm::SHA256)` — InStream overload, raw bytes.
5. For each `{iv, tag, ciphertext}` of `{blob, result}`:
   1. Build raw-byte InStream of `iv || manifestHash || ciphertext` (16 + 32 + N bytes) into a TempBlob.
   2. `expectedTag = CryptographyManagement.GenerateHash(InStream, K_mac as Base64, HMACSHA256)` — InStream overload, raw bytes.
   3. Compare `expectedTag` to received `tag` (both Base64 strings, fixed length). Mismatch → error 'tampered or wrong key' → mark Ship Log row `TamperedOnRead`. (AL has no constant-time compare; both sides fixed length, no early-exit-on-prefix. Acceptable for Phase 1.)
   4. `Rijndael.SetEncryptionData(K_enc as Base64, IV as Base64); plaintextBase64 := Rijndael.DecryptBinaryData(ciphertext as Base64);` Streaming chunk recommended for >5 MB ciphertext (see Compression below).
6. Plaintext blob → `Sampling Performance Profiler.SetData(InStream)` → `Performance Profiler` page renders as if profile recorded locally.
7. Plaintext result JSON → render via existing `usercontrol(AnalysisResults; WebPageViewer)` HTML, or de-serialize to structured page.

## Compression and chunking

- BC side: every `profile` part run through `Codeunit "Data Compression"` gzip before encryption + multipart write. Set `X-Profile-Encoding: gzip`. Typical 5-10× reduction. `.alcpuprofile` (JSON-y) compresses well.
- Server: decompress before analyze. Encrypt over uncompressed bytes (stable hash). Decompression failure → 400.
- Chunking trigger: if BC-side post-compression profile bytes > 8 MB, split into ordered chunks `chunkSize = 2 MB` for AES encryption. Each chunk encrypted independently with the same `K_enc` and a derived IV `IV_n = AES-256-ECB(K_enc, n)` (CTR-counter pattern via single ECB block — distinct per chunk, no IV reuse) — but for Phase 1 simplicity: encrypt full blob if ≤ 8 MB; if > 8 MB and chunking required, error and ask admin to lower sampling frequency. Chunking implementation deferred to Phase 2 unless real profiles exceed 8 MB after gzip in field testing.
- All AL `Rijndael.{Encrypt,Decrypt}BinaryData` paths handle Base64 strings up to ~12 MB safely; larger needs chunking. Spec assumes 8 MB compressed cap for Phase 1.

## Components

### BC side — al-perf-bc additions

#### Table 70503 `AL Perf Ship Setup` (single record)

| Field | Type | Notes |
|---|---|---|
| Primary Key | Code[10] | empty |
| Enabled | Boolean | master switch |
| Tenant Code | Code[40] | regex-validated |
| Server URL Base | Text[250] | `https://alperf.example.com` |
| Tenant Tag | Text[100] | friendly env label |
| Schedule ID Filter | Guid | optional |
| Activity Type Filter | Enum + "All" | All / Web Client / Background / Web API Client |
| Min Activity Duration (ms) | Integer | default 500 |
| Daily Ship Limit | Integer | default 200 |
| Look-back Window (h) | Integer | default 24 |
| Last Run DateTime | DateTime | visibility |
| Last Error | Text[500] | visibility |
| Current Key Version | Integer | drives encryption pubkey selection |
| Skipped Today (Limit Hit) | Integer (FlowField) | counts ShipLog rows where `Status = Skipped`, `Reason = LimitHit`, today |
| Bootstrap Token (write-only field) | Text[100] | wiped on register |

Secrets in IsolatedStorage `DataScope::Module`:
- `'al-perf-tenant-secret'` → tenant secret (Base64)
- `'al-perf-anthropic-key'` → Anthropic API key (optional)
- `'al-perf-private-key-N'` → RSA private XML for keyVersion N (ring)
- `'al-perf-current-key-version'` → mirror of table field for fast lookup

#### Table 70504 `AL Perf Ship Log`

| Field | Type | Notes |
|---|---|---|
| Activity ID | Guid | PK |
| Schedule ID | Guid | for filtering |
| Activity Description | Text[250] | denormalized |
| Starting Date-Time | DateTime | denormalized |
| Status | Enum | Pending, Accepted, Stored, Failed, AnalysisFailed, Skipped, TamperedOnRead |
| Skip Reason | Enum | None, Filter, LimitHit, Oversize, Duplicate |
| Shipped At | DateTime | when 202 received |
| Stored At | DateTime | when terminal `Stored` confirmed |
| HTTP Status | Integer | last response status |
| Error Message | Text[500] | last error |
| Attempt Count | Integer | retry counter |
| Profile Size (bytes) | BigInteger | original blob size |
| Compressed Size (bytes) | BigInteger | post-gzip |
| Server Profile ID | Text[100] | echo from server |
| Key Version | Integer | which pubkey used |

Retention: indefinite (small rows). Manual cleanup action.

State machine:
```
Pending ──ship+202──► Accepted ──poll status──► Stored
   │                    │                          │
   │                    └──poll status──► AnalysisFailed
   ├─4xx──► Failed
   ├─5xx (over budget)──► Failed
   └─filter/limit/size──► Skipped
                                       Open Profile──► [decrypt OK / TamperedOnRead]
```

#### Codeunit 70504 `AL Perf Crypto`

```al
codeunit 70504 "AL Perf Crypto"
{
    Access = Public;

    /// Generates a new RSA-3072 keypair, stores private XML in IsolatedStorage under next version.
    /// Returns out KeyVersion and Fingerprint.
    procedure GenerateKeypair(KeySize: Integer; var KeyVersion: Integer; var Fingerprint: Text);

    procedure GetCurrentPublicKeyXml(): Text;

    /// Boolean return + var-out — replaces TryFunction returning SecretText.
    procedure GetPrivateKeyForVersion(KeyVersion: Integer; var KeyXml: SecretText): Boolean;

    /// Verify HMAC, decrypt wrapped, decrypt blob+result. Returns false on tamper.
    procedure DecryptBundle(
        KeyVersion: Integer;
        WrappedInStream: InStream;
        ManifestInStream: InStream;
        IvBlob: Text; TagBlob: Text; CipherBlobInStream: InStream;
        IvResult: Text; TagResult: Text; CipherResultInStream: InStream;
        var BlobOutStream: OutStream;
        var ResultOutStream: OutStream
    ): Boolean;

    /// Backup format: 'ALPRBK1' header + PBKDF2-SHA256 params + salt + IV + AES-256-CBC ciphertext + HMAC-SHA256 tag.
    /// Encrypts entire private key ring as JSON.
    procedure ExportEncryptedBackup(Passphrase: SecretText; var Stream: OutStream);
    procedure ImportEncryptedBackup(Passphrase: SecretText; Stream: InStream);

    procedure ComputeFingerprint(PublicKeyXml: Text): Text;

    /// Builds Authorization header value for an outbound request.
    /// SHA-256s body InStream into hash, builds canonical string, HMAC-signs with tenant secret.
    procedure SignRequest(Method: Text; Path: Text; BodyInStream: InStream): Text;
}
```

Internal: AES-CBC + HMAC orchestration via `Rijndael Cryptography` + `Cryptography Management.GenerateHash(InStream,...HMACSHA256)`. PBKDF2 via existing `Codeunit "Cryptography Management"` GenerateBase64KeyedHash with iteration loop (Phase 1 ad-hoc; Phase 2 use `Rfc2898DeriveBytes` codeunit if Cloud-callable).

Backup blob format:
```
Offset  Bytes  Field
0       7      magic "ALPRBK1"
7       4      uint32 BE iterations (default 100000)
11      32     salt
43      16     IV
59      32     HMAC-SHA256(K_mac, header || ciphertext)
91      var    AES-256-CBC ciphertext of UTF-8 JSON of {keyVersion → privateKeyXml}
```
where K_enc, K_mac = HKDF-SHA256(PBKDF2(passphrase, salt, iter, 64), 'al-perf-backup-v1').

#### Codeunit 70503 `AL Perf Auto Ship`

Job Queue runner. `OnRun()`. Internal helpers for window calc, manifest build, multipart build (with `AL Perf Crypto.SignRequest` for Authorization), HTTP send, log update, status refresh.

#### Pages

- `AL Perf Ship Setup Card` (70503): General, Authentication, Encryption (key ring factbox), Filters, Status (with skip-counter), Connection. Actions: Generate Keypair, Rotate Keypair, Rotate Tenant Secret, Export Backup, Import Backup, Test Connection, View Ship Log, Set Anthropic Key, Clear Anthropic Key, Register (with Bootstrap Token field).
- `AL Perf Key Ring Factbox` (70505): list of (KeyVersion, Fingerprint, Generated At, In Use). Action: Purge old version (with confirmation; warns if any Ship Log row references it).
- `AL Perf Ship Log List` (70504): filter by Status. Actions: Open Profile (decrypt + view), Refresh Status (poll server for Accepted rows), Retry (reset Pending for Failed-transient), Delete Old.
- Page extension on `Performance Profile List` (1931): "Ship Now" action.
- Page extension on `Perf. Profiler Schedules List` (1933): "Ship All Profiles for Schedule" action.

### al-perf web side

#### Tenant store

```
web/tenants/{tenantCode}.json
  {
    "secretCiphertext": "<KEK-wrapped Base64>",     // AES-256-GCM with server master KEK
    "publicKeys": [
      { "keyVersion": 1, "jwk": {...}, "fingerprint": "...", "addedAt": "..." },
      { "keyVersion": 2, "jwk": {...}, "fingerprint": "...", "addedAt": "..." }
    ],
    "currentKeyVersion": 2,
    "tenantTag": "...",
    "bcEnvironment": "...",
    "bcVersion": "...",
    "registeredAt": "...",
    "lastSeenAt": "...",
    "secretRotatedAt": "..."
  }
```

KEK loaded at server boot from `AL_PERF_KEK` env var (32 hex bytes). Phase 1 single-instance demo. Phase 2 production: KMS / Azure Key Vault.

`tenantCode` regex-validated and `path.resolve` checked under `web/tenants/` base before any I/O.

#### Bootstrap token store

```
web/bootstrap-tokens/{SHA-256(token)}.json
  { "tenantCode": "...", "expiresAt": "...", "used": false, "issuedAt": "..." }
```

Admin CLI: `al-perf admin issue-token --tenant <code> --hours <n>`. CLI validates `--tenant` regex.

#### Profile store

```
web/storage/{tenantCode}/profiles/{activityId}/
  manifest.json   ; plaintext, exact bytes received
  metrics.json    ; plaintext, server-derived
  wrapped.bin     ; 384 bytes
  blob.enc        ; 16+32+N bytes
  result.enc      ; 16+32+M bytes
  keyversion.txt  ; "<int>"

web/storage/{tenantCode}/idempotency/{activityId}.json
  { state, responseStatus, responseBody, createdAt, finishedAt, errorReason }

web/storage/{tenantCode}/_inflight/{activityId}/    ; transient, removed by worker
  manifest.json, profile.bin, encoding.txt, anthropic.tmp

web/storage/{tenantCode}/_dlq/{activityId}/         ; transient, retained for inspection
  ...same as _inflight + error.log
```

All `{tenantCode}` and `{activityId}` regex-validated and path-normalized.

#### Endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| POST /api/tenants/register | bootstrap token | First-time only; 409 if known tenantCode |
| PATCH /api/tenants/{id}/secret | HMAC | Returns new secret once |
| PATCH /api/tenants/{id}/public-key | HMAC | Validates monotonic keyVersion |
| GET /api/tenants/{id}/healthz | HMAC | Auth ping |
| POST /api/ingest | HMAC | Multipart ingest, 202 + durable persistence |
| GET /api/tenants/{id}/profiles/{activityId} | HMAC | Returns full encrypted bundle + manifest + metrics |
| GET /api/tenants/{id}/profiles/{activityId}/status | HMAC | Cheap idempotency-state poll |
| GET /api/tenants/{id}/history | HMAC | Paginated metrics list |
| GET /api/tenants/{id}/trend | HMAC | Aggregated time series over plaintext metrics |

Phase 1: per-tenant rate limit not enforced (in-process trust). Phase 2: token bucket per tenant.

#### Worker

Phase 1: filesystem-watch on `_inflight/` (chokidar-style, Bun supports). In-process queue.
Phase 2: queue table + worker pool.

DLQ: failed jobs persist `_dlq/{activityId}/` with `error.log`. Server status endpoint surfaces via idempotency record.

#### Crypto module (`web/crypto.ts`)

```ts
validateTenantCode(code: string): asserts code is TenantCode
validateActivityId(id: string): asserts id is ActivityId
resolveTenantPath(base: string, tenantCode: string, ...rest: string[]): string  // throws if escapes base
xmlRsaToJwk(xml: string): JsonWebKey                                              // .NET RSA XML → JWK
verifyAuthHeader(header, method, path, body, storedSecret, replayCache): boolean
encryptBundle(plaintextBlob: Buffer, plaintextResult: Buffer, manifestBytes: Buffer, jwk: JsonWebKey):
  { wrapped: Buffer, blob: BundlePart, result: BundlePart }
wrapTenantSecret(plain: Buffer, kek: Buffer): Buffer       // AES-256-GCM
unwrapTenantSecret(wrapped: Buffer, kek: Buffer): Buffer
checkAndInsertNonce(replayCache, tenantCode, nonce, ts): boolean
```

### Library API (open source, `src/`)

No new exports. Web server consumes existing `analyzeProfile`. Encryption + tenant lifecycle live in `web/` (closed-source).

## Open questions (decided)

1. **Anthropic key validation** — only on `Test Connection` action. Don't burn tokens per ship.
2. **Deterministic-only mode** — yes if no Anthropic key. Trending without AI valuable.
3. **Anthropic key rotation** — no server-side action; per-request.
4. **Ship granularity** — 1/request. Simpler, idempotent.
5. **Backfill** — yes, via `Look-back Window (h)`.
6. **Cost cap** — `Daily Ship Limit` 200/day default.
7. **OAEP-SHA1 acceptable?** Yes — 64-byte payload + RSA-3072. Documented.
8. **Bootstrap token UX** — admin CLI issues, operator pastes into BC setup card.
9. **Backup format** — encrypted XML blob (PBKDF2 + AES + HMAC). PFX dropped due to AL Cloud-feasibility concerns.
10. **Anthropic key transport** — header in flight, file-on-disk briefly during queue, in-memory during analyze. Documented limitation. Production: tmpfs for `_inflight/`.

## Risks

- **Key loss = history loss.** Mandatory backup-then-confirm at keypair generation. Backup blob format is documented + interoperable.
- **KEK loss at server side** = all tenant secrets unrecoverable. Tenants re-register via new bootstrap tokens. Mitigation: KEK in env, replicas share KEK. Phase 2: KMS.
- **MS scope changes pending.** Cloud target requires platform table access + page extensibility. Demo unblocked because OnPrem.
- **BC retention deadline.** Job Queue must run frequently enough. Default 5 min. Status warns if Look-back exceeds retention.
- **Plaintext `_inflight` window.** Brief, may include Anthropic key. Production: RAM-backed `tmpfs`.
- **Constant-time compare absent in AL.** Phase 1 acceptable (fixed-length tags, single comparison). Phase 2 hardening optional.
- **Worker single-instance.** Phase 1 acceptable. Phase 2: HA worker pool with queue table.

## Phase boundaries

**Phase 1 (this spec):**
- Bootstrap-token registration, HMAC auth, durable ingest, hybrid encryption.
- OnPrem demo target.
- File-based storage, in-process worker, single-instance web server.
- Encrypted backup blob format.

**Phase 2 (separate spec):**
- Multi-tenant dashboard UI, regression alerting, statistical baselines.
- Email/Teams webhooks.
- Cloud target for al-perf-bc (after MS unlock).
- Postgres/queue-table, HA workers.
- KMS-backed KEK.
- Per-tenant rate limiting.
- AL constant-time HMAC compare.
- Streaming chunked encryption for >8 MB compressed payloads.

**Phase 3:**
- Schedule provisioning from al-perf platform.
- Privacy-preserving cross-tenant aggregation if customer demand.

## Test plan

### Unit
- AES-CBC + HMAC + RSA-OAEP round trip Node ↔ AL crypto across blob and result.
- Manifest hash binding: encrypt with manifest A, decrypt with manifest B → tamper error.
- TamperedOnRead: flip 1 byte in `blob.enc` → HMAC mismatch error.
- Backup blob: export, fresh BC env, import, decrypt v1 profile.

### Auth
- HMAC sig verify: header reorder still verifies; body hash mismatch fails.
- Replay: same nonce within 10 min → 401; > 10 min → success.
- ts skew: ±5 min OK; ±6 min → 401.
- Bootstrap token: unused succeeds; reused → 401; expired → 401.

### Path safety
- `tenantCode = ../etc/passwd` → 400.
- `activityId = not-a-guid` → 400.
- Filesystem path resolution under base verified.

### Size limits
- 51 MB profile rejected 413.
- 65 KB manifest rejected 413.
- 49 MB profile + matching headers accepted.

### Idempotency
- Replay same activityId 5×: 1 worker invocation, 5× cached 202 response.
- After worker `done`: GET status returns "stored".

### Worker DLQ
- Corrupted profile triggers analyze exception → state=failed, `_dlq/` populated, BC status=AnalysisFailed.

### Compression
- gzip and identity round-trip.
- Decompress failure (truncated): 400.

### Key rotation
- Generate v1, ship 1 profile under v1.
- Generate v2 in BC, PATCH public-key, ship 1 profile under v2.
- Decrypt both back from BC ring.

### Tenant secret rotation
- HMAC-signed PATCH /secret with current secret returns new secret.
- Old secret rejects 401 immediately.
- Atomic swap: no race window where both valid or neither.

### Negative
- Wrong KEK at server boot → all secret unwraps fail → 401 on every request.
- Anthropic key missing → deterministic-only analysis.
- 4xx (auth) on ship → BC marks Failed.
- 5xx on ship → BC retries; succeeds on 3rd attempt.

### Compliance
- Replay full ingest with grep over journalctl/log files for known token bytes; assert zero matches.

## Build order

1. **al-perf web side: auth + path safety + KEK envelope.**
   - Bootstrap token CLI + store.
   - tenantCode/activityId validators + `resolveTenantPath` helper.
   - HMAC verifier + replay cache.
   - KEK envelope wrap/unwrap (AES-256-GCM).
   - Tenant register / secret-rotate / public-key-rotate endpoints.
   - Compliance log-scrubbing test infrastructure.
2. **al-perf web side: ingest + durable acceptance + worker.**
   - `/api/ingest` with size enforcement, idempotency record, durable `_inflight/` write before 202.
   - Filesystem-watch worker: pop, analyze, encrypt, persist, update idempotency.
   - DLQ.
   - `/api/tenants/{id}/profiles/{activityId}/status` endpoint.
3. **al-perf-bc: AL Perf Crypto codeunit.**
   - Versioned keypair generation + IsolatedStorage ring.
   - Encryption helpers (Rijndael + RSA + HMAC) — InStream throughout.
   - Encrypted backup blob (PBKDF2 + AES + HMAC).
   - `SignRequest` HMAC builder.
   - Cross-language round-trip tests against Node side.
4. **al-perf-bc: setup + registration.**
   - `AL Perf Ship Setup` table + card + key ring factbox.
   - Bootstrap-token-driven registration flow.
   - Test Connection.
5. **al-perf-bc: ship pipeline.**
   - `AL Perf Ship Log` with new state machine.
   - Compression before encrypt.
   - HMAC-signed Authorization header on every ship.
   - `AL Perf Auto Ship` codeunit.
   - Job Queue Entry wiring.
   - Status refresh poll for Accepted → Stored.
6. **al-perf-bc: decrypt + view.**
   - `Open Profile` action: fetch bundle → verify HMAC → decrypt → `SetData` → existing visualization.
7. **al-perf web side: read APIs.**
   - history, trend, profile-bundle.
8. **End-to-end demo run.**
   - OnPrem BC sandbox + local al-perf.
   - Bootstrap-token registration, auto-ship, decrypted view, key rotation drill, secret rotation drill.
