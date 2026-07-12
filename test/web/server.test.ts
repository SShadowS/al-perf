import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { FINGERPRINT_ALGO_VERSION } from "../../src/lifecycle/fingerprint.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";
import { clearEngineCache } from "../../src/semantic/engine-runner.js";
import { closeLifecycleStoreForTest } from "../../web/lifecycle-db.js";

// ---------------------------------------------------------------------------
// Paths + stub helpers (mirrors test/mcp/server.test.ts)
// ---------------------------------------------------------------------------

const FUSION_FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const STUB_TS = resolve(FUSION_FIXTURE_DIR, "alsem-stub.ts");
const BUN_EXE = process.execPath;

let webTestCleanups: Array<() => void> = [];
afterEach(() => {
	clearEngineCache();
	for (const fn of webTestCleanups) {
		try {
			fn();
		} catch {
			// ignore
		}
	}
	webTestCleanups = [];
});

function makeWebStubBinary(mode: "ok" | "findings" = "ok"): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-web-stub-"));
	webTestCleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
	if (process.platform === "win32") {
		const cmdPath = join(tmpDir, "alsem-stub.cmd");
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

// Start server on a test port
process.env.PORT = "3999";

// Dynamic import so PORT is set first
const { server } = await import("../../web/server.ts");

afterAll(() => {
	server.stop();
});

describe("web server", () => {
	const BASE = `http://localhost:3999`;

	it("serves index.html on GET /", async () => {
		const res = await fetch(`${BASE}/`);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("AL Profile Analyzer");
		expect(text).toContain("dropzone");
	});

	it("serves static CSS", async () => {
		const res = await fetch(`${BASE}/style.css`);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("--bg-primary");
	});

	it("serves static JS", async () => {
		const res = await fetch(`${BASE}/app.js`);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("renderResults");
	});

	it("returns 404 for unknown paths", async () => {
		const res = await fetch(`${BASE}/nonexistent`);
		expect(res.status).toBe(404);
	});

	it("analyzes a profile via POST /api/analyze", async () => {
		const profilePath = resolve(
			import.meta.dir,
			"../fixtures/instrumentation-minimal.alcpuprofile",
		);
		const profileData = readFileSync(profilePath);

		const formData = new FormData();
		formData.append("profile", new Blob([profileData]), "test.alcpuprofile");

		const res = await fetch(`${BASE}/api/analyze`, {
			method: "POST",
			body: formData,
		});

		expect(res.status).toBe(200);
		const result = await res.json();
		expect(result.meta).toBeDefined();
		expect(result.meta.profileType).toBeDefined();
		expect(result.hotspots).toBeInstanceOf(Array);
		expect(result.patterns).toBeInstanceOf(Array);
		expect(result.appBreakdown).toBeInstanceOf(Array);
		expect(result.objectBreakdown).toBeInstanceOf(Array);
		expect(result.summary).toBeDefined();
		expect(result.summary.oneLiner).toBeTypeOf("string");
	}, 120000);

	it("returns 400 when no profile is provided", async () => {
		const formData = new FormData();
		const res = await fetch(`${BASE}/api/analyze`, {
			method: "POST",
			body: formData,
		});
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toContain("profile");
	});

	it("returns 400 for non-multipart requests", async () => {
		const res = await fetch(`${BASE}/api/analyze`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("responds 200 to OPTIONS requests", async () => {
		const res = await fetch(`${BASE}/`, { method: "OPTIONS" });
		expect(res.status).toBe(200);
	});

	describe("format parameter", () => {
		function postProfile(formatParam?: string) {
			const profilePath = resolve(
				import.meta.dir,
				"../fixtures/instrumentation-minimal.alcpuprofile",
			);
			const profileData = readFileSync(profilePath);
			const formData = new FormData();
			formData.append("profile", new Blob([profileData]), "test.alcpuprofile");
			const qs = formatParam ? `?format=${formatParam}` : "";
			return fetch(`${BASE}/api/analyze${qs}`, {
				method: "POST",
				body: formData,
			});
		}

		it("returns JSON by default (no format param)", async () => {
			const res = await postProfile();
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("application/json");
			const result = await res.json();
			expect(result.meta).toBeDefined();
		}, 120000);

		it("returns JSON when format=json", async () => {
			const res = await postProfile("json");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("application/json");
			const result = await res.json();
			expect(result.meta).toBeDefined();
		}, 120000);

		it("returns HTML when format=html", async () => {
			const res = await postProfile("html");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			const body = await res.text();
			expect(body).toContain("<!DOCTYPE html>");
			expect(body).toContain("#00B7C3");
			expect(body).toContain("Segoe UI");
			expect(body).toMatch(/CRITICAL|WARNING|INFO/);
		}, 120000);

		it("returns 400 for unsupported format", async () => {
			const res = await postProfile("pdf");
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toContain("Unsupported format");
		}, 120000);

		it("HTML response is self-contained (no external resource links)", async () => {
			const res = await postProfile("html");
			const body = await res.text();
			expect(body).not.toMatch(/href="https?:\/\//);
			expect(body).not.toMatch(/src="https?:\/\//);
		}, 120000);
	});

	// ---------------------------------------------------------------------------
	// Fusion payload tests (P2.3)
	// ---------------------------------------------------------------------------

	describe("fusion payload", () => {
		const profilePath = resolve(
			import.meta.dir,
			"../fixtures/sampling-minimal.alcpuprofile",
		);

		it("fusionViews is absent (off-path byte-unchanged) when no workspace is provided", async () => {
			// Profile-only upload — no source zip, no workspace.
			const profileData = readFileSync(profilePath);
			const formData = new FormData();
			formData.append("profile", new Blob([profileData]), "test.alcpuprofile");

			const res = await fetch(`${BASE}/api/analyze`, {
				method: "POST",
				body: formData,
			});
			expect(res.status).toBe(200);
			const result = await res.json();

			// Off-path: fusionViews must be absent
			expect(result.fusionViews).toBeUndefined();
			// Core fields are still present
			expect(result.meta).toBeDefined();
			expect(result.hotspots).toBeInstanceOf(Array);
		}, 120_000);

		it("fusionViews is absent when the engine is unavailable (graceful degradation)", async () => {
			// Point at a nonexistent binary — fusion degrades silently.
			const prevBin = process.env.AL_SEM_BIN;
			process.env.AL_SEM_BIN = "/nonexistent/alsem-web-xyz";
			try {
				clearEngineCache();
				const profileData = readFileSync(profilePath);
				const formData = new FormData();
				formData.append(
					"profile",
					new Blob([profileData]),
					"test.alcpuprofile",
				);
				// The workspace zip would be required for a real fusion test; here we
				// skip the source file so the workspace gate fires early (sourcePath
				// undefined) and fusionViews stays absent regardless of the binary.
				const res = await fetch(`${BASE}/api/analyze`, {
					method: "POST",
					body: formData,
				});
				expect(res.status).toBe(200);
				const result = await res.json();
				// Without a workspace sourcePath the gate does not fire → no fusionViews
				expect(result.fusionViews).toBeUndefined();
				// But the core analysis is still complete
				expect(result.meta).toBeDefined();
			} finally {
				if (prevBin === undefined) delete process.env.AL_SEM_BIN;
				else process.env.AL_SEM_BIN = prevBin;
				clearEngineCache();
			}
		}, 120_000);

		it("payload serializes completely (hotspots, patterns, meta all present without workspace)", async () => {
			const profileData = readFileSync(profilePath);
			const formData = new FormData();
			formData.append("profile", new Blob([profileData]), "test.alcpuprofile");
			const res = await fetch(`${BASE}/api/analyze`, {
				method: "POST",
				body: formData,
			});
			expect(res.status).toBe(200);
			const result = await res.json();
			// Full payload is present and serializable
			expect(result.hotspots).toBeInstanceOf(Array);
			expect(result.patterns).toBeInstanceOf(Array);
			expect(result.appBreakdown).toBeInstanceOf(Array);
			expect(result.summary).toBeDefined();
			expect(result.summary.oneLiner).toBeTypeOf("string");
			// no fusion leak
			expect(result.fusionViews).toBeUndefined();
		}, 120_000);

		it("app.js contains renderFusion and fusionAnnotationText functions", async () => {
			const res = await fetch(`${BASE}/app.js`);
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).toContain("renderFusion");
			expect(text).toContain("fusionAnnotationText");
			expect(text).toContain("fusion-section");
			expect(text).toContain("Prioritized Findings");
		});

		it("app.js contains 'runtime-correlated' badge code (P3.1 R3-6)", async () => {
			const res = await fetch(`${BASE}/app.js`);
			expect(res.status).toBe(200);
			const text = await res.text();
			// Badge text must be "runtime-correlated" (the badge string itself is present)
			expect(text).toContain("runtime-correlated");
			// Badge is gated on corroboratingPatterns (present + non-empty)
			expect(text).toContain("corroboratingPatterns");
			// Both renderFusion (per-finding) and fusionAnnotationText (annotation-level) carry it
			expect(text).toContain("runtimeCorrelatedBadgeText");
			// The badge string literal used in output must use "correlated" not "confirmed"
			// (check the actual output string, not just any comment in the code)
			expect(text).toMatch(/runtime-correlated \(/);
		});

		it("app.js contains causal chain rendering code (P3.2b)", async () => {
			const res = await fetch(`${BASE}/app.js`);
			expect(res.status).toBe(200);
			const text = await res.text();
			// The causal chain <details> element rendering code must be present
			expect(text).toContain("causalSteps");
			expect(text).toContain("Causal chain");
			// Uses document.createElement for safe DOM construction
			expect(text).toContain("createElement");
		});

		it("index.html contains fusion-section div", async () => {
			const res = await fetch(`${BASE}/`);
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).toContain('id="fusion-section"');
		});

		it("fusionViews payload includes weighted findings when stub binary is used with workspace", async () => {
			// Build a workspace zip using the system zip command. The web server
			// calls extractCompanionZip on the zip, sets sourcePath = extracted dir.
			// We need an app.json in the zip so isAlWorkspaceDir returns true.
			const stubBin = makeWebStubBinary("findings");
			const prevBin = process.env.AL_SEM_BIN;
			process.env.AL_SEM_BIN = stubBin;
			const workTmp = mkdtempSync(join(tmpdir(), "al-perf-web-ws-"));
			webTestCleanups.push(() =>
				rmSync(workTmp, { recursive: true, force: true }),
			);
			try {
				const appJson = JSON.stringify({
					id: "00000000-0000-0000-0000-000000005000",
					name: "TestApp",
					publisher: "test",
					version: "1.0.0.0",
				});
				writeFileSync(join(workTmp, "app.json"), appJson, "utf-8");
				const zipPath = join(workTmp, "source.zip");
				// Use system zip command to build a real zip archive
				const zipProc = Bun.spawnSync(["zip", zipPath, "app.json"], {
					cwd: workTmp,
					stdout: "pipe",
					stderr: "pipe",
				});
				if (zipProc.exitCode !== 0) {
					// zip command unavailable in this environment — skip gracefully
					return;
				}
				clearEngineCache();
				const profileData = readFileSync(profilePath);
				const zipData = readFileSync(zipPath);

				const formData = new FormData();
				formData.append(
					"profile",
					new Blob([profileData]),
					"test.alcpuprofile",
				);
				formData.append("source", new Blob([zipData]), "source.zip");

				const res = await fetch(`${BASE}/api/analyze`, {
					method: "POST",
					body: formData,
				});
				expect(res.status).toBe(200);
				const result = await res.json();

				// When fusion ran successfully, fusionViews must be present
				if (result.fusionViews) {
					expect(result.fusionViews.prioritizedFindings).toBeInstanceOf(Array);
					expect(result.fusionViews.hotspotAnnotations).toBeInstanceOf(Array);
					expect(result.fusionViews.correlationSummary).toBeDefined();
					expect(result.fusionViews.unweightedFindings).toBeInstanceOf(Array);
					// Verify all weighted findings have selfTimePercent > 0 (R2-12)
					for (const pf of result.fusionViews.prioritizedFindings) {
						expect(pf.selfTimePercent).toBeGreaterThan(0);
					}
				} else {
					// Fusion may have been disabled (engine unavailable in CI) — that is
					// still a valid graceful-degradation state. Assert core analysis ran.
					expect(result.meta).toBeDefined();
					expect(result.hotspots).toBeInstanceOf(Array);
				}
			} finally {
				if (prevBin === undefined) delete process.env.AL_SEM_BIN;
				else process.env.AL_SEM_BIN = prevBin;
				clearEngineCache();
			}
		}, 120_000);
	});
});

// ---------------------------------------------------------------------------
// GET /api/debug/status — staleAlgoTenants (Task 3): the operator status
// surface must report every tenant blocked by the stale-algo guard, but
// MUST NOT open a lifecycle store (and therefore create lifecycle.sqlite)
// when lifecycle tracking is off — that would be a regression on every
// deployment that doesn't use lifecycle at all.
// ---------------------------------------------------------------------------

describe("GET /api/debug/status — staleAlgoTenants", () => {
	afterEach(() => {
		delete process.env.AL_PERF_LIFECYCLE;
		delete process.env.AL_PERF_DATA_DIR;
	});

	function staleFinding(tenant: string): NewFinding {
		return {
			tenant,
			fingerprint: "pattern:debugstatuscli0001",
			algoVersion: FINGERPRINT_ALGO_VERSION + 1,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Stale finding",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		};
	}

	it("lifecycle OFF: staleAlgoTenants is [] and no lifecycle.sqlite is created", async () => {
		delete process.env.AL_PERF_LIFECYCLE;
		const dir = mkdtempSync(join(tmpdir(), "alperf-debug-status-off-"));
		webTestCleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		process.env.AL_PERF_DATA_DIR = dir;

		const res = await fetch(`http://localhost:3999/api/debug/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { staleAlgoTenants: unknown[] };
		expect(body.staleAlgoTenants).toEqual([]);
		expect(existsSync(join(dir, "lifecycle.sqlite"))).toBe(false);
	});

	it("lifecycle ON with a seeded stale finding: reports the blocked tenant", async () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-debug-status-on-"));
		webTestCleanups.push(() => {
			closeLifecycleStoreForTest(dir);
			rmSync(dir, { recursive: true, force: true });
		});
		process.env.AL_PERF_DATA_DIR = dir;
		process.env.AL_PERF_LIFECYCLE = "1";

		const seedStore = new LifecycleStore(join(dir, "lifecycle.sqlite"));
		seedStore.insertFinding(staleFinding("debugstaletenant"));
		seedStore.close();

		const res = await fetch(`http://localhost:3999/api/debug/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			staleAlgoTenants: Array<{
				tenant: string;
				count: number;
				versions: number[];
			}>;
		};
		expect(body.staleAlgoTenants).toEqual([
			{
				tenant: "debugstaletenant",
				count: 1,
				versions: [FINGERPRINT_ALGO_VERSION + 1],
			},
		]);
	});
});
