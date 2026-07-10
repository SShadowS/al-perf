# Fusion test fixtures (`test/fixtures/fusion/`)

Fixtures for the al-perf × al-sem fusion substrate (Phase P1).

## `ws-min/` — minimal AL workspace

A single-app AL workspace:

- `app.json` — app id `a1b2c3d4-e5f6-7890-abcd-ef1234567890`.
- `src/Foo.Codeunit.al` — codeunit 50100 "Foo" with:
  - `ProcessRecords` — `Rec.Modify()` inside a `repeat … until` loop (emits a
    `d1-db-op-in-loop` finding + 2× `d10-self-modifying-loop`).
  - `CleanProcedure` — no problematic patterns.
  - `OverloadedProc` — two overloads (same name, different signatures).

## Committed goldens

`ws-min.inventory.json` and `ws-min.analyze.json` are REAL output from the
`alsem` engine (version 0.0.12 at capture). The gated drift test
`test/semantic/engine-runner.test.ts` ("committed goldens are current") diffs a
live `runEngine(ws-min)` against these when `AL_SEM_BIN` is set.

### Regenerate

```bash
AL_SEM_BIN=U:/Git/al-call-hierarchy/target/release/alsem.exe

# inventory (routine universe)
"$AL_SEM_BIN" fingerprint test/fixtures/fusion/ws-min \
  --inventory-only --format json --deterministic \
  > test/fixtures/fusion/ws-min.inventory.json

# analyze (findings) — note: the warning line goes to STDERR; keep only stdout
"$AL_SEM_BIN" analyze test/fixtures/fusion/ws-min \
  --format json --deterministic 2>/dev/null \
  > test/fixtures/fusion/ws-min.analyze.json
```

Both are deterministic (`--deterministic` pins `generatedAt` to the epoch).

## `alsem-stub.ts` — fake CLI for binary-free degrade tests

A Bun script mimicking the `alsem` CLI surface (`fingerprint`/`analyze`
subcommands). The test builds a platform launcher (`.cmd`/`.sh`) around it and
drives degrade branches via the `ALSEM_STUB_MODE` env var
(`ok` / `bad-json` / `exit2` / `timeout` / `wrong-schema` / `opaque`). This lets
the degrade-branch tests run in CI WITHOUT the real binary.
