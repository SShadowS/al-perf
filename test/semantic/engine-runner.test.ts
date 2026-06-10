/**
 * engine-runner.test.ts — Tests for the al-sem CLI boundary.
 *
 * Coverage:
 * (a) binary-absent → { disabled, reason }
 * (b) committed-golden parse (parses ws-min goldens from disk, NO binary)
 * (c) real-binary run over ws-min (gated: AL_SEM_BIN env var must be set)
 * (d) stub-backed degrade branches (binary-free): bad-json, exit2, timeout,
 *     wrong-schema, opaque→coverageDegraded
 * (e) cache hit — second call does NOT re-spawn (stub-backed spawn-count spy)
 * (f) goldens-drift gated test (AL_SEM_BIN) — live run matches committed goldens
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	clearEngineCache,
	type EngineAnalysis,
	runEngine,
} from "../../src/semantic/engine-runner.js";

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");
const STUB_TS = resolve(FIXTURE_DIR, "alsem-stub.ts");
const BUN_EXE = process.execPath; // the bun binary running this test

// ── helpers ──────────────────────────────────────────────────────────────────

function isDisabled(
	result: unknown,
): result is { disabled: true; reason: string } {
	return (
		typeof result === "object" &&
		result !== null &&
		"disabled" in result &&
		(result as { disabled: unknown }).disabled === true
	);
}

function isEngineAnalysis(result: unknown): result is EngineAnalysis {
	return (
		typeof result === "object" &&
		result !== null &&
		"routines" in result &&
		"findings" in result
	);
}

/**
 * Build a platform-appropriate single-binary launcher that runs the committed
 * `alsem-stub.ts` via the current bun executable, forwarding all args. The stub
 * MODE is baked into the launcher (set in the script) because Bun.spawn does not
 * propagate a runtime mutation of `process.env` to the child, and the runner
 * does not let callers inject env. Returns the launcher path (a single
 * resolvable path the runner WILL spawn).
 */
function makeStubBinary(tmpDir: string, mode: string): string {
	if (process.platform === "win32") {
		const cmdPath = join(tmpDir, "alsem-stub.cmd");
		// %* forwards all args; @echo off keeps stdout clean.
		writeFileSync(
			cmdPath,
			`@echo off\r\nset "ALSEM_STUB_MODE=${mode}"\r\n"${BUN_EXE}" "${STUB_TS}" %*\r\n`,
		);
		return cmdPath;
	}
	const shPath = join(tmpDir, "alsem-stub.sh");
	writeFileSync(
		shPath,
		`#!/bin/sh\nexport ALSEM_STUB_MODE='${mode}'\nexec "${BUN_EXE}" "${STUB_TS}" "$@"\n`,
	);
	chmodSync(shPath, 0o755);
	return shPath;
}

// Tracks temp dirs for cleanup between tests.
let cleanups: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanups) {
		try {
			fn();
		} catch {
			// ignore
		}
	}
	cleanups = [];
	clearEngineCache();
});

/** Build a stub binary in a fresh temp dir, baking in the given mode. */
function makeTmpStub(mode: string): { tmpDir: string; binary: string } {
	const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-stub-"));
	cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
	return { tmpDir, binary: makeStubBinary(tmpDir, mode) };
}

// ── (a) binary absent ────────────────────────────────────────────────────────

describe("engine-runner: binary absent", () => {
	test("returns disabled when engine path does not exist", async () => {
		clearEngineCache();
		const result = await runEngine(WS_MIN, {
			engine: "/nonexistent/alsem",
		});
		expect(isDisabled(result)).toBe(true);
		if (isDisabled(result)) {
			expect(result.reason).toMatch(/not found/i);
		}
	});

	test("returns disabled for a spaced path that does not exist (real existence check)", async () => {
		// A legit-looking but missing path WITH spaces must still degrade with a
		// "not found at" reason — the runner uses a real existence check, not a
		// space heuristic.
		clearEngineCache();
		const result = await runEngine(WS_MIN, {
			engine: "/nonexistent dir/with spaces/alsem",
		});
		expect(isDisabled(result)).toBe(true);
		if (isDisabled(result)) {
			expect(result.reason).toMatch(/not found at/i);
		}
	});
});

// ── (b) committed-golden path (no binary required) ───────────────────────────

describe("engine-runner: committed-golden parse", () => {
	test("parses ws-min.inventory.json into routineInventory", async () => {
		const inventoryPath = resolve(FIXTURE_DIR, "ws-min.inventory.json");
		const raw = await Bun.file(inventoryPath).text();
		const doc = JSON.parse(raw);

		expect(doc.kind).toBe("routine-inventory");
		expect(doc.schemaVersion).toBe("1.0.0");
		expect(doc.payload.routineInventory).toBeArray();
		expect(doc.payload.routineInventory.length).toBeGreaterThanOrEqual(1);

		const procRecords = doc.payload.routineInventory.find(
			(r: { routineName: string }) => r.routineName === "ProcessRecords",
		);
		expect(procRecords).toBeDefined();
		expect(procRecords.objectType).toBe("Codeunit");
		expect(procRecords.objectNumber).toBe(50100);
		expect(procRecords.stableRoutineId).toBeString();

		const overloads = doc.payload.routineInventory.filter(
			(r: { routineName: string }) => r.routineName === "OverloadedProc",
		);
		expect(overloads.length).toBe(2);

		expect(doc.payload.apps).toBeArray();
		expect(doc.payload.apps[0].appGuid).toBe(
			"a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		);
	});

	test("parses ws-min.analyze.json into findings", async () => {
		const analyzePath = resolve(FIXTURE_DIR, "ws-min.analyze.json");
		const raw = await Bun.file(analyzePath).text();
		const doc = JSON.parse(raw);

		expect(doc.kind).toBe("analyze-report");
		expect(doc.schemaVersion).toBe("1.0.0");
		expect(doc.payload.findings).toBeArray();

		const d1 = doc.payload.findings.find(
			(f: { detector: string }) => f.detector === "d1-db-op-in-loop",
		);
		expect(d1).toBeDefined();
		expect(d1.severity).toBe("high");
		expect(d1.primaryLocation.routineName).toBe("ProcessRecords");

		// objectId uses "/" delimiter (internal form)
		expect(d1.primaryLocation.objectId).toMatch(/\//);
		expect(d1.primaryLocation.objectId).not.toMatch(/^[^/]+:[^/]+:[^/]+$/);
	});
});

// ── (c) real-binary run (gated: AL_SEM_BIN must be set) ──────────────────────

const AL_SEM_BIN = process.env.AL_SEM_BIN;

describe("engine-runner: real-binary run", () => {
	test.skipIf(!AL_SEM_BIN)(
		"runEngine over ws-min returns EngineAnalysis with routines + findings",
		async () => {
			clearEngineCache();
			const result = await runEngine(WS_MIN, {
				engine: AL_SEM_BIN,
				timeoutMs: 60_000,
			});

			expect(isEngineAnalysis(result)).toBe(true);
			if (!isEngineAnalysis(result)) return;

			expect(result.routines.length).toBeGreaterThanOrEqual(1);
			const procRecords = result.routines.find(
				(r) => r.routineName === "ProcessRecords",
			);
			expect(procRecords).toBeDefined();

			expect(result.findings.length).toBeGreaterThanOrEqual(1);
			const d1 = result.findings.find((f) => f.detector === "d1-db-op-in-loop");
			expect(d1).toBeDefined();
			expect(d1!.severity).toBe("high");

			expect(result.alsemVersion).toBeString();
			expect(result.alsemVersion.length).toBeGreaterThan(0);
			expect(result.apps.length).toBeGreaterThanOrEqual(1);

			// Coverage is exposed as full entries + subjects convenience.
			expect(result.coverage).toBeArray();
			expect(result.coverageSubjects).toBeArray();
		},
	);
});

// ── (d) stub-backed degrade branches (binary-free) ───────────────────────────

describe("engine-runner: stub-backed degrade branches", () => {
	test("ok mode → EngineAnalysis (sanity: the stub is spawnable)", async () => {
		const { binary } = makeTmpStub("ok");
		const result = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 10_000,
		});
		expect(isEngineAnalysis(result)).toBe(true);
		if (isEngineAnalysis(result)) {
			expect(result.routines.length).toBe(1);
			expect(result.coverageDegraded).toBe(false);
		}
	});

	test("bad-json mode → degrade with a JSON parse reason", async () => {
		const { binary } = makeTmpStub("bad-json");
		const result = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 10_000,
		});
		expect(isDisabled(result)).toBe(true);
		if (isDisabled(result)) {
			expect(result.reason).toMatch(/JSON parse/i);
		}
	});

	test("exit2 mode → degrade with the exit-2 stderr reason", async () => {
		const { binary } = makeTmpStub("exit2");
		const result = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 10_000,
		});
		expect(isDisabled(result)).toBe(true);
		if (isDisabled(result)) {
			expect(result.reason).toMatch(/exit 2/);
			expect(result.reason).toMatch(/analysis failed/);
		}
	});

	test("timeout mode → degrade with a timed-out reason (and no orphan)", async () => {
		const { binary } = makeTmpStub("timeout");
		const start = Date.now();
		const result = await runEngine(WS_MIN, { engine: binary, timeoutMs: 500 });
		const elapsed = Date.now() - start;
		expect(isDisabled(result)).toBe(true);
		if (isDisabled(result)) {
			expect(result.reason).toMatch(/timed out/i);
		}
		// The runner returned promptly (well under the stub's 60s sleep) — proving
		// it killed the child rather than waiting on it.
		expect(elapsed).toBeLessThan(10_000);
	});

	test("wrong-schema mode → degrade with an unsupported-schema reason", async () => {
		const { binary } = makeTmpStub("wrong-schema");
		const result = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 10_000,
		});
		expect(isDisabled(result)).toBe(true);
		if (isDisabled(result)) {
			expect(result.reason).toMatch(/unsupported schemaVersion/i);
		}
	});

	test("opaque mode → EngineAnalysis with coverageDegraded=true", async () => {
		const { binary } = makeTmpStub("opaque");
		const result = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 10_000,
		});
		expect(isEngineAnalysis(result)).toBe(true);
		if (isEngineAnalysis(result)) {
			expect(result.coverageDegraded).toBe(true);
			expect(result.opaqueApps.length).toBeGreaterThanOrEqual(1);
		}
	});
});

// ── (d') sibling-leak: one-side failure must not orphan the other ────────────

describe("engine-runner: sibling subprocess not orphaned", () => {
	test("timeout on one side returns promptly and never throws", async () => {
		// Both calls run the same stub in "timeout" mode; the runner must kill
		// BOTH and return promptly. (allSettled ensures neither is orphaned.)
		const { binary } = makeTmpStub("timeout");
		let threw = false;
		const start = Date.now();
		let result: Awaited<ReturnType<typeof runEngine>> | undefined;
		try {
			result = await runEngine(WS_MIN, { engine: binary, timeoutMs: 400 });
		} catch {
			threw = true;
		}
		const elapsed = Date.now() - start;
		expect(threw).toBe(false);
		expect(isDisabled(result)).toBe(true);
		expect(elapsed).toBeLessThan(10_000);
	});
});

// ── (e) cache hit — stub-backed spawn-count spy (binary-free, un-gated) ───────

describe("engine-runner: cache hit", () => {
	test("second call for the same workspace does not re-spawn (spawn-count spy)", async () => {
		const { binary } = makeTmpStub("ok");
		clearEngineCache();

		const spawnSpy = spyOn(Bun, "spawn");
		try {
			const result1 = await runEngine(WS_MIN, {
				engine: binary,
				timeoutMs: 10_000,
			});
			const spawnCount1 = spawnSpy.mock.calls.length;
			// First call spawns 2 children (fingerprint + analyze).
			expect(spawnCount1).toBe(2);

			const result2 = await runEngine(WS_MIN, {
				engine: binary,
				timeoutMs: 10_000,
			});
			const spawnCount2 = spawnSpy.mock.calls.length;
			// Second call is a cache hit — NO additional spawns.
			expect(spawnCount2).toBe(spawnCount1);

			// Same object reference (cached) + byte-identical.
			expect(result1).toBe(result2);
			expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
		} finally {
			spawnSpy.mockRestore();
		}
	});

	test("concurrent calls share one in-flight run (no double-spawn)", async () => {
		const { binary } = makeTmpStub("ok");
		clearEngineCache();

		const spawnSpy = spyOn(Bun, "spawn");
		try {
			// Fire two concurrent runs for the same workspace BEFORE either resolves.
			const [r1, r2] = await Promise.all([
				runEngine(WS_MIN, { engine: binary, timeoutMs: 10_000 }),
				runEngine(WS_MIN, { engine: binary, timeoutMs: 10_000 }),
			]);
			// Only ONE run actually spawned (2 children), shared by both callers.
			expect(spawnSpy.mock.calls.length).toBe(2);
			expect(r1).toBe(r2);
		} finally {
			spawnSpy.mockRestore();
		}
	});

	test("clearEngineCache forces a fresh run on next call", async () => {
		const { binary } = makeTmpStub("ok");
		clearEngineCache();

		const result1 = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 10_000,
		});
		clearEngineCache();
		const result2 = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 10_000,
		});

		// After clear, a NEW object (different reference) but byte-identical content.
		expect(result1).not.toBe(result2);
		expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
	});

	test("a disabled result is NOT cached (next call retries)", async () => {
		clearEngineCache();

		// First: bad-json → disabled (should be evicted, not cached).
		const badStub = makeTmpStub("bad-json");
		const bad = await runEngine(WS_MIN, {
			engine: badStub.binary,
			timeoutMs: 10_000,
		});
		expect(isDisabled(bad)).toBe(true);

		// Second: ok → must produce a fresh EngineAnalysis (proves the disabled
		// result was not cached for this workspace key).
		const okStub = makeTmpStub("ok");
		const good = await runEngine(WS_MIN, {
			engine: okStub.binary,
			timeoutMs: 10_000,
		});
		expect(isEngineAnalysis(good)).toBe(true);
	});
});

// ── (d'') schema 1.1.0 new fields: enclosingMember, evidencePath ─────────────

describe("engine-runner: schema 1.1.0 new fields", () => {
	test("findings mode: inventory row carries enclosingMember + originatingObject", async () => {
		const { binary } = makeTmpStub("findings");
		const result = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 15_000,
		});
		expect(isEngineAnalysis(result)).toBe(true);
		if (!isEngineAnalysis(result)) return;

		// The stub emits a field-trigger row with enclosingMember "Quantity".
		const onValidateRow = result.routines.find(
			(r) => r.routineName === "OnValidate" && r.objectType === "Table",
		);
		expect(onValidateRow).toBeDefined();
		expect(onValidateRow?.enclosingMember).toBe("Quantity");
		expect(onValidateRow?.originatingObject).toMatch(/Table:72100/);
	});

	test("findings mode: ProcessLine finding carries parsed evidencePath (flat file+line)", async () => {
		const { binary } = makeTmpStub("findings");
		const result = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 15_000,
		});
		expect(isEngineAnalysis(result)).toBe(true);
		if (!isEngineAnalysis(result)) return;

		const procFinding = result.findings.find((f) => f.id === "F-PROC");
		expect(procFinding).toBeDefined();
		expect(procFinding?.evidencePath).toBeDefined();
		expect(Array.isArray(procFinding?.evidencePath)).toBe(true);
		expect(procFinding?.evidencePath?.length).toBe(2);

		const step0 = procFinding?.evidencePath?.[0];
		expect(step0?.routineId).toMatch(/Codeunit:50000#onrun/);
		expect(step0?.file).toBe("ws:src/Cod50000.al");
		expect(step0?.line).toBe(5);
		expect(step0?.note).toBe("calls");
		// callsiteId is NOT in EvidenceStep — only operationId + loopId.
		expect(step0?.operationId).toBeUndefined();
		expect(step0?.loopId).toBeUndefined();

		const step1 = procFinding?.evidencePath?.[1];
		expect(step1?.routineId).toMatch(/Codeunit:50000#proc/);
		expect(step1?.file).toBe("ws:src/Cod50000.al");
		expect(step1?.line).toBe(10);
		expect(step1?.note).toBe("DB read inside loop");
		expect(step1?.operationId).toMatch(/op1/);
		expect(step1?.loopId).toMatch(/loop1/);
	});

	test("findings mode: field-trigger finding carries primaryLocation.enclosingMember", async () => {
		const { binary } = makeTmpStub("findings");
		const result = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 15_000,
		});
		expect(isEngineAnalysis(result)).toBe(true);
		if (!isEngineAnalysis(result)) return;

		const onValFinding = result.findings.find((f) => f.id === "F-ONVAL");
		expect(onValFinding).toBeDefined();
		expect(onValFinding?.primaryLocation.enclosingMember).toBe("Quantity");
		expect(onValFinding?.primaryLocation.originatingObject).toMatch(
			/Table:72100/,
		);
		// No evidencePath on this finding (not emitted by the stub).
		expect(onValFinding?.evidencePath).toBeUndefined();
	});

	test("old-findings mode (1.0.0): parses gracefully — no crash, new fields absent", async () => {
		const { binary } = makeTmpStub("old-findings");
		const result = await runEngine(WS_MIN, {
			engine: binary,
			timeoutMs: 15_000,
		});
		// majorMatches("1.0.0", "1.1.0") → same major "1" → NOT a schema degrade.
		expect(isEngineAnalysis(result)).toBe(true);
		if (!isEngineAnalysis(result)) return;

		// The old inventory row has no enclosingMember / originatingObject.
		const procRow = result.routines.find(
			(r) => r.routineName === "ProcessLine",
		);
		expect(procRow).toBeDefined();
		expect(procRow?.enclosingMember).toBeUndefined();
		expect(procRow?.originatingObject).toBeUndefined();

		// The old finding has no evidencePath.
		const procFinding = result.findings.find((f) => f.id === "F-PROC");
		expect(procFinding).toBeDefined();
		expect(procFinding?.evidencePath).toBeUndefined();
		expect(procFinding?.primaryLocation.enclosingMember).toBeUndefined();
	});
});

// ── (f) goldens drift (gated: AL_SEM_BIN) ────────────────────────────────────

describe("engine-runner: committed goldens are current", () => {
	test.skipIf(!AL_SEM_BIN)(
		"live runEngine(ws-min) matches the committed goldens",
		async () => {
			clearEngineCache();
			const live = await runEngine(WS_MIN, { engine: AL_SEM_BIN });
			expect(isEngineAnalysis(live)).toBe(true);
			if (!isEngineAnalysis(live)) return;

			const inv = JSON.parse(
				await Bun.file(resolve(FIXTURE_DIR, "ws-min.inventory.json")).text(),
			);
			const ana = JSON.parse(
				await Bun.file(resolve(FIXTURE_DIR, "ws-min.analyze.json")).text(),
			);

			// Routine inventory matches the golden (same set + order).
			expect(live.routines).toEqual(inv.payload.routineInventory);
			// Apps match.
			expect(live.apps).toEqual(inv.payload.apps);
			// Findings: the runner sorts by (fingerprint, id); compare as a set.
			const sortKey = (f: { fingerprint: string; id: string }) =>
				`${f.fingerprint} ${f.id}`;
			const liveSorted = [...live.findings].sort((a, b) =>
				sortKey(a).localeCompare(sortKey(b)),
			);
			const goldSorted = [...ana.payload.findings].sort(
				(a: { fingerprint: string; id: string }, b: typeof a) =>
					sortKey(a).localeCompare(sortKey(b)),
			);
			expect(liveSorted).toEqual(goldSorted);
		},
	);
});
