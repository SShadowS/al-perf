import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { formatBatchHtml } from "../src/cli/formatters/batch-html.js";
import { formatAnalysisHtml } from "../src/cli/formatters/html.js";
import { config } from "../src/config.js";
import { analyzeProfile } from "../src/core/analyzer.js";
import { analyzeBatch } from "../src/core/batch-analyzer.js";
import { initIdCounter, nextId } from "../src/debug/ids.js";
import { DebugStore } from "../src/debug/store.js";
import type { DebugCapture } from "../src/debug/types.js";
import { writeCaptureToDisk } from "../src/debug/writer.js";
import {
	type ApiCallCost,
	formatCostSummary,
	summarizeCosts,
} from "../src/explain/api-cost.js";
import type { BatchExplainResult } from "../src/explain/batch-explainer.js";
import { explainBatchAnalysis } from "../src/explain/batch-explainer.js";
import type { DeepExplainResult } from "../src/explain/deep-analyzer.js";
import { deepAnalysis } from "../src/explain/deep-analyzer.js";
import type { ExplainResult } from "../src/explain/explainer.js";
import { explainAnalysis } from "../src/explain/explainer.js";
import { isAlWorkspaceDir } from "../src/semantic/engine-runner.js";
import { fuseProfile } from "../src/semantic/fuse.js";
import { annotateHotspots, prioritizeFindings } from "../src/semantic/views.js";
import { extractCompanionZip } from "../src/source/zip-extractor.js";
import type { MethodBreakdown } from "../src/types/aggregated.js";
import type { ProfileMetadata } from "../src/types/batch.js";
import type { ProcessedProfile } from "../src/types/processed.js";

const PUBLIC_DIR = resolve(import.meta.dir, "public");
// Persisted data root — set AL_PERF_DATA_DIR=/data in Docker so it lands on the
// mounted volume and survives container redeploys. Defaults to web/data for local dev.
const DATA_DIR =
	process.env.AL_PERF_DATA_DIR ?? resolve(import.meta.dir, "data");
const STATS_FILE = resolve(DATA_DIR, "stats.json");
const RECORD_DIR = resolve(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"batch-recorded",
);
const MAX_BODY_SIZE = 100 * 1024 * 1024; // 100MB
const PORT = parseInt(process.env.PORT || "3010", 10);

let recordNextBatch = false;

const DEBUG_MODE = process.env.AL_PERF_DEBUG === "1";
// Debug/consent captures live under the data root so they share the volume.
const DEBUG_DIR = process.env.AL_PERF_DEBUG_DIR ?? resolve(DATA_DIR, "debug");
const CAPTURE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

const debugStore = new DebugStore(CAPTURE_EXPIRY_MS);
// Boot-time identity for deploy/restart detection via /api/debug/status.
const STARTED_AT = new Date();
const APP_VERSION = (
	JSON.parse(
		await readFile(resolve(import.meta.dir, "..", "package.json"), "utf-8"),
	) as { version: string }
).version;
// Ensure the data root exists so stats writes succeed on a fresh local checkout.
await mkdir(DATA_DIR, { recursive: true });
await initIdCounter(DEBUG_DIR);
setInterval(
	() => {
		debugStore.sweep();
		pruneRateBuckets();
	},
	5 * 60 * 1000,
);

interface Stats {
	totalAnalyses: number;
	dailyCounts: Record<string, number>;
}

async function loadStats(): Promise<Stats> {
	try {
		const raw = await readFile(STATS_FILE, "utf-8");
		return JSON.parse(raw);
	} catch {
		return { totalAnalyses: 0, dailyCounts: {} };
	}
}

// Stats updates are serialized through a promise chain — concurrent ingests
// would otherwise interleave read-modify-write and lose counts.
let statsChain: Promise<void> = Promise.resolve();
function recordAnalysis(): Promise<void> {
	statsChain = statsChain
		.then(async () => {
			const stats = await loadStats();
			stats.totalAnalyses++;
			const today = new Date().toISOString().slice(0, 10);
			stats.dailyCounts[today] = (stats.dailyCounts[today] || 0) + 1;
			await writeFile(STATS_FILE, JSON.stringify(stats, null, 2));
		})
		.catch(() => {});
	return statsChain;
}

// ---------------------------------------------------------------------------
// Per-IP rate limiting for the anonymous analyze endpoints. Each request can
// trigger paid AI calls, so unauthenticated volume needs a ceiling.
// ---------------------------------------------------------------------------
const RATE_LIMIT = parseInt(process.env.AL_PERF_RATE_LIMIT || "20", 10);
const RATE_WINDOW_MS =
	parseInt(process.env.AL_PERF_RATE_WINDOW_SEC || "600", 10) * 1000;
const rateBuckets = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
	if (process.env.NODE_ENV === "test" || RATE_LIMIT <= 0) return false;
	const cutoff = Date.now() - RATE_WINDOW_MS;
	const hits = (rateBuckets.get(ip) ?? []).filter((t) => t > cutoff);
	if (hits.length >= RATE_LIMIT) {
		rateBuckets.set(ip, hits);
		return true;
	}
	hits.push(Date.now());
	rateBuckets.set(ip, hits);
	return false;
}

function pruneRateBuckets(): void {
	const cutoff = Date.now() - RATE_WINDOW_MS;
	for (const [ip, hits] of rateBuckets) {
		const live = hits.filter((t) => t > cutoff);
		if (live.length === 0) rateBuckets.delete(ip);
		else rateBuckets.set(ip, live);
	}
}

/**
 * Create a unique temporary directory for a request's uploaded files.
 */
async function makeTempDir(): Promise<string> {
	const dir = resolve(
		tmpdir(),
		`al-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Serve a static file from the public directory.
 * Returns null if the file does not exist.
 */
async function serveStatic(pathname: string): Promise<Response | null> {
	// Default to index.html for root
	const filePath =
		pathname === "/"
			? join(PUBLIC_DIR, "index.html")
			: join(PUBLIC_DIR, pathname);

	// Prevent directory traversal
	if (!filePath.startsWith(PUBLIC_DIR)) {
		return new Response("Forbidden", { status: 403 });
	}

	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		return null;
	}

	// For HTML, stamp local asset refs with the app version and force revalidation.
	// Cloudflare caches JS/CSS aggressively (no cache-busting in filenames), so
	// returning visitors would otherwise hold stale assets for months. Versioned
	// URLs (?v=) produce a fresh URL each release; no-cache on the HTML entry point
	// ensures browsers always fetch the latest asset references.
	if (filePath.endsWith(".html")) {
		const html = (await file.text()).replace(
			/(href|src)="(style\.css|app\.js|marked\.min\.js)"/g,
			`$1="$2?v=${APP_VERSION}"`,
		);
		return new Response(html, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-cache",
			},
		});
	}

	return new Response(file);
}

// ---------------------------------------------------------------------------
// Shared analysis logic
// ---------------------------------------------------------------------------

type ProgressCallback = (step: string, message: string) => void;
const noop: ProgressCallback = () => {};

interface BufferedFile {
	name: string;
	data: Uint8Array;
}

interface AnalyzeInput {
	profile: BufferedFile;
	source?: BufferedFile;
}

interface AnalyzeOutput {
	result: Record<string, unknown>;
	debugToken: string;
}

/**
 * Core single-profile analysis pipeline. Used by both streaming and sync handlers.
 * Accepts pre-buffered file data so it is safe to call from within a ReadableStream.
 */
async function runAnalysis(
	input: AnalyzeInput,
	onProgress: ProgressCallback = noop,
): Promise<AnalyzeOutput> {
	const analyzeStart = Date.now();
	let tempDir: string | undefined;
	let sourceCleanup: (() => Promise<void>) | undefined;

	try {
		const profileBytes = input.profile.data;
		tempDir = await makeTempDir();

		const safeProfileName = basename(
			input.profile.name || "profile.alcpuprofile",
		);
		const profilePath = join(tempDir, safeProfileName);
		await Bun.write(profilePath, profileBytes);

		// Handle optional source zip
		let sourcePath: string | undefined;
		let sourceZipBytes: Uint8Array | undefined;
		if (input.source) {
			sourceZipBytes = input.source.data;
			const safeZipName = basename(input.source.name || "source.zip");
			const zipPath = join(tempDir, safeZipName);
			await Bun.write(zipPath, sourceZipBytes);
			const extracted = await extractCompanionZip(zipPath);
			sourcePath = extracted.extractDir;
			sourceCleanup = extracted.cleanup;
		}

		// Run analysis
		onProgress("analyzing", "Analyzing profile...");
		let processedProfile: ProcessedProfile | undefined;
		let sourceIndex:
			| import("../src/types/source-index.js").SourceIndex
			| undefined;
		let allMethods: MethodBreakdown[] = [];
		const result = await analyzeProfile(profilePath, {
			top: config.analysisTopN,
			includePatterns: true,
			sourcePath,
			onProcessedProfile: (p) => {
				processedProfile = p;
			},
			onSourceIndex: (idx) => {
				sourceIndex = idx;
			},
			onAllMethods: (m) => {
				allMethods = m;
			},
		});

		// al-sem fusion: attach fusionViews when a workspace sourcePath is present
		// and the engine is available. Defensive: a fusion failure must NOT abort
		// the analysis response (wrap so a throw is swallowed → fusionViews absent).
		// Gate so when no workspace, result.fusionViews stays undefined (byte-unchanged).
		if (sourcePath && isAlWorkspaceDir(sourcePath)) {
			try {
				const fuseResult = await fuseProfile(allMethods, sourcePath, {
					patterns: result.patterns,
				});
				if (!("disabled" in fuseResult)) {
					const { weighted, unweighted } = prioritizeFindings(
						fuseResult,
						allMethods,
					);
					result.fusionViews = {
						hotspotAnnotations: annotateHotspots(fuseResult, result.hotspots),
						prioritizedFindings: weighted,
						unweightedFindings: unweighted,
						correlationSummary: fuseResult.correlationSummary,
					};
				}
			} catch {
				// Non-fatal — analysis still returns without fusionViews
			}
		}

		// AI explanation and deep analysis
		// AI_DISABLED=1 skips all AI calls (e.g. during upgrades) while keeping
		// ANTHROPIC_API_KEY in env for non-web work.
		const apiKey =
			process.env.AI_DISABLED === "1"
				? undefined
				: process.env.ANTHROPIC_API_KEY;
		const apiCosts: ApiCallCost[] = [];
		let explainResult: ExplainResult | undefined;
		let deepResult: DeepExplainResult | undefined;

		if (apiKey) {
			onProgress("explaining", "Generating AI explanation...");
			try {
				explainResult = await explainAnalysis(result, {
					apiKey,
					model: config.defaultModel,
				});
				result.explanation = explainResult.text;
				apiCosts.push(explainResult.cost);
			} catch {
				// Non-fatal — analysis still returns without explanation
			}

			// Deep AI analysis (always attempted in web UI)
			if (processedProfile) {
				onProgress("deep-analysis", "Running deep AI analysis...");
				try {
					deepResult = await deepAnalysis(result, processedProfile, {
						apiKey,
						model: config.defaultModel,
						sourceIndex,
					});
					result.aiFindings = deepResult.aiFindings;
					result.aiNarrative = deepResult.aiNarrative;
					apiCosts.push(deepResult.cost);
				} catch {
					// Non-fatal — analysis still returns without deep findings
				}
			}
		}

		if (apiCosts.length > 0) {
			const summary = summarizeCosts(apiCosts);
			console.log(`[api-cost] ${formatCostSummary(summary)}`);
		}

		// Create debug capture
		const capture: DebugCapture = {
			id: nextId(),
			token: crypto.randomUUID(),
			timestamp: new Date(),
			profileData: profileBytes,
			profileName: safeProfileName,
			sourceZipData: sourceZipBytes,
			analysisResult: result,
			costs: apiCosts,
			analysisDurationMs: Date.now() - analyzeStart,
			model: config.defaultModel,
		};

		if (explainResult) {
			capture.explainCapture = {
				debugInfo: explainResult.debugInfo,
				parsedOutput: explainResult.text,
			};
		}
		if (deepResult) {
			capture.deepCapture = {
				debugInfo: deepResult.debugInfo,
				parsedOutput: {
					findings: deepResult.aiFindings,
					narrative: deepResult.aiNarrative,
				},
			};
		}

		if (DEBUG_MODE) {
			writeCaptureToDisk(capture, DEBUG_DIR, "developer-debug").catch((err) =>
				console.error(`[debug] Failed to write capture: ${err}`),
			);
		} else {
			debugStore.add(capture);
		}

		recordAnalysis().catch(() => {});

		return { result, debugToken: capture.token };
	} finally {
		if (sourceCleanup) {
			try {
				await sourceCleanup();
			} catch {
				/* best-effort cleanup */
			}
		}
		if (tempDir) {
			try {
				await rm(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
	}
}

interface BatchInput {
	profiles: BufferedFile[];
	source?: BufferedFile;
	manifestText?: string;
}

interface BatchOutput {
	result: Record<string, unknown>;
	debugToken: string;
}

/**
 * Core batch analysis pipeline. Used by both streaming and sync handlers.
 * Accepts pre-buffered file data so it is safe to call from within a ReadableStream.
 */
async function runBatchAnalysis(
	input: BatchInput,
	onProgress: ProgressCallback = noop,
): Promise<BatchOutput> {
	const batchStart = Date.now();
	let tempDir: string | undefined;
	let sourceCleanup: (() => Promise<void>) | undefined;

	try {
		const bufferedProfiles = input.profiles;

		// Write uploads to a per-request temp directory
		tempDir = await makeTempDir();

		const profilePaths: string[] = [];
		for (const bp of bufferedProfiles) {
			const filePath = join(tempDir, bp.name);
			await Bun.write(filePath, bp.data);
			profilePaths.push(filePath);
		}

		// Parse optional manifest
		let metadata: ProfileMetadata[] | undefined;
		const manifestText = input.manifestText;
		if (manifestText) {
			metadata = JSON.parse(manifestText) as ProfileMetadata[];
		}

		// Record request as test fixture (one-shot)
		if (recordNextBatch) {
			recordNextBatch = false;
			await mkdir(RECORD_DIR, { recursive: true });
			for (let i = 0; i < profilePaths.length; i++) {
				const dest = join(RECORD_DIR, `profile-${i + 1}.alcpuprofile`);
				await Bun.write(dest, Bun.file(profilePaths[i]));
			}
			if (manifestText) {
				await writeFile(join(RECORD_DIR, "manifest.json"), manifestText);
			}
			console.log(
				`[record] Saved ${profilePaths.length} profiles + manifest to ${RECORD_DIR}`,
			);
		}

		// Handle optional source zip
		let sourcePath: string | undefined;
		let sourceZipBytes: Uint8Array | undefined;
		if (input.source) {
			sourceZipBytes = input.source.data;
			const safeZipName = basename(input.source.name || "source.zip");
			const zipPath = join(tempDir, safeZipName);
			await Bun.write(zipPath, sourceZipBytes);
			const extracted = await extractCompanionZip(zipPath);
			sourcePath = extracted.extractDir;
			sourceCleanup = extracted.cleanup;
		}

		// Run batch analysis
		onProgress("analyzing", `Analyzing ${profilePaths.length} profiles...`);
		const result = await analyzeBatch(profilePaths, { metadata, sourcePath });

		// Run AI explanation if API key is available (AI_DISABLED=1 skips it)
		const apiKey =
			process.env.AI_DISABLED === "1"
				? undefined
				: process.env.ANTHROPIC_API_KEY;
		const apiCosts: ApiCallCost[] = [];
		let batchExplainResult: BatchExplainResult | undefined;

		if (apiKey) {
			onProgress("explaining", "Generating AI explanation...");
			try {
				batchExplainResult = await explainBatchAnalysis(result, {
					apiKey,
					model: config.defaultModel,
				});
				result.explanation = batchExplainResult.text;
				apiCosts.push(batchExplainResult.cost);
			} catch {
				// Non-fatal — analysis still returns without explanation
			}
		}

		if (apiCosts.length > 0) {
			const summary = summarizeCosts(apiCosts);
			console.log(`[api-cost] ${formatCostSummary(summary)}`);
		}

		// Create debug capture
		const capture: DebugCapture = {
			id: nextId(),
			token: crypto.randomUUID(),
			timestamp: new Date(),
			profileData: bufferedProfiles[0].data,
			profileName: bufferedProfiles[0].name,
			batchProfiles: bufferedProfiles,
			manifestJson: manifestText,
			sourceZipData: sourceZipBytes,
			analysisResult: result,
			costs: apiCosts,
			analysisDurationMs: Date.now() - batchStart,
			model: config.defaultModel,
		};

		if (batchExplainResult) {
			capture.batchExplainCapture = {
				debugInfo: batchExplainResult.debugInfo,
				parsedOutput: batchExplainResult.text,
			};
		}

		if (DEBUG_MODE) {
			writeCaptureToDisk(capture, DEBUG_DIR, "developer-debug").catch((err) =>
				console.error(`[debug] Failed to write capture: ${err}`),
			);
		} else {
			debugStore.add(capture);
		}

		recordAnalysis().catch(() => {});

		return { result, debugToken: capture.token };
	} finally {
		if (sourceCleanup) {
			try {
				await sourceCleanup();
			} catch {
				/* best-effort cleanup */
			}
		}
		if (tempDir) {
			try {
				await rm(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
	}
}

// ---------------------------------------------------------------------------
// SSE streaming helper
// ---------------------------------------------------------------------------

/**
 * Wrap an async analysis function as an SSE stream with keepalive.
 */
function streamResponse(
	run: (sendProgress: ProgressCallback) => Promise<Record<string, unknown>>,
	errorLabel: string,
): Response {
	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			let closed = false;
			function sendEvent(event: string, data: unknown) {
				if (closed) return;
				try {
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					);
				} catch {
					closed = true;
				}
			}
			function sendKeepAlive() {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					closed = true;
				}
			}
			// Send keepalive every 5s to prevent Bun's idle timeout from closing the connection
			const keepalive = setInterval(sendKeepAlive, 5_000);

			try {
				const data = await run((step, message) =>
					sendEvent("progress", { step, message }),
				);
				sendEvent("done", data);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[${errorLabel}] ${message}`);
				if (err instanceof Error && err.stack) console.error(err.stack);
				sendEvent("error", {
					error: `${errorLabel}. Please check the uploaded file(s).`,
				});
			} finally {
				clearInterval(keepalive);
				if (!closed) {
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				}
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/analyze — accepts multipart/form-data with:
 *   - profile (required): .alcpuprofile file
 *   - source (optional): .zip of AL source files
 *
 * Supports ?stream=1 for SSE streaming (survives Cloudflare 100s timeout).
 */
async function handleAnalyze(req: Request): Promise<Response> {
	const contentType = req.headers.get("content-type") || "";
	if (!contentType.startsWith("multipart/form-data")) {
		return Response.json(
			{ error: "Content-Type must be multipart/form-data" },
			{ status: 400 },
		);
	}

	const url = new URL(req.url);
	const wantsStream = url.searchParams.get("stream") === "1";
	const format = url.searchParams.get("format");

	const formData = await req.formData();
	const profileFile = formData.get("profile");

	if (!profileFile || !(profileFile instanceof File)) {
		return Response.json(
			{ error: "Missing required 'profile' field (must be a file)" },
			{ status: 400 },
		);
	}

	// Buffer file data eagerly — File objects from formData may be invalidated
	// after the handler returns (before the SSE stream callback runs).
	const sourceFile = formData.get("source");
	const input: AnalyzeInput = {
		profile: {
			name: profileFile.name,
			data: new Uint8Array(await profileFile.arrayBuffer()),
		},
		source:
			sourceFile instanceof File
				? {
						name: sourceFile.name,
						data: new Uint8Array(await sourceFile.arrayBuffer()),
					}
				: undefined,
	};

	if (wantsStream) {
		return streamResponse(async (onProgress) => {
			const { result, debugToken } = await runAnalysis(input, onProgress);
			return { ...result, debugToken };
		}, "Analysis failed");
	}

	// Non-streaming path
	try {
		const { result, debugToken } = await runAnalysis(input);

		if (format === "html") {
			const html = formatAnalysisHtml(
				result as Parameters<typeof formatAnalysisHtml>[0],
			);
			return new Response(html, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
		if (format && format !== "json") {
			return Response.json(
				{ error: `Unsupported format '${format}'. Supported: json, html` },
				{ status: 400 },
			);
		}
		return Response.json({ ...result, debugToken });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[analyze error] ${message}`);
		if (err instanceof Error && err.stack) console.error(err.stack);
		return Response.json(
			{ error: "Analysis failed. Please check the uploaded file." },
			{ status: 500 },
		);
	}
}

/**
 * Handle POST /api/analyze-batch — accepts multipart/form-data with:
 *   - profiles[] (required): multiple .alcpuprofile files
 *   - manifest (optional): JSON text with ProfileMetadata[]
 *   - source (optional): .zip of AL source files
 *
 * Supports ?stream=1 for SSE streaming (survives Cloudflare 100s timeout).
 */
async function handleAnalyzeBatch(req: Request): Promise<Response> {
	const contentType = req.headers.get("content-type") || "";
	if (!contentType.startsWith("multipart/form-data")) {
		return Response.json(
			{ error: "Content-Type must be multipart/form-data" },
			{ status: 400 },
		);
	}

	const url = new URL(req.url);
	const wantsStream = url.searchParams.get("stream") === "1";
	const format = url.searchParams.get("format");

	const formData = await req.formData();
	const profileFiles = formData.getAll("profiles[]");

	if (!profileFiles.length || !profileFiles.every((f) => f instanceof File)) {
		return Response.json(
			{
				error:
					"Missing required 'profiles[]' field (must be one or more files)",
			},
			{ status: 400 },
		);
	}

	// Buffer all file data eagerly — File objects from formData may be invalidated
	// after the handler returns (before the SSE stream callback runs).
	const bufferedProfiles: BufferedFile[] = [];
	for (let i = 0; i < profileFiles.length; i++) {
		const file = profileFiles[i] as File;
		const safeName = `${i}-${basename(file.name || `profile-${i}.alcpuprofile`)}`;
		bufferedProfiles.push({
			name: safeName,
			data: new Uint8Array(await file.arrayBuffer()),
		});
	}

	const sourceFile = formData.get("source");
	const manifestField = formData.get("manifest");
	let manifestText: string | undefined;
	if (manifestField) {
		manifestText =
			manifestField instanceof File
				? await manifestField.text()
				: String(manifestField);
	}

	const input: BatchInput = {
		profiles: bufferedProfiles,
		source:
			sourceFile instanceof File
				? {
						name: sourceFile.name,
						data: new Uint8Array(await sourceFile.arrayBuffer()),
					}
				: undefined,
		manifestText,
	};

	if (wantsStream) {
		return streamResponse(async (onProgress) => {
			const { result, debugToken } = await runBatchAnalysis(input, onProgress);
			return { ...result, debugToken };
		}, "Batch analysis failed");
	}

	// Non-streaming path
	try {
		const { result, debugToken } = await runBatchAnalysis(input);

		if (format === "html") {
			const html = formatBatchHtml(
				result as Parameters<typeof formatBatchHtml>[0],
			);
			return new Response(html, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
		if (format && format !== "json") {
			return Response.json(
				{ error: `Unsupported format '${format}'. Supported: json, html` },
				{ status: 400 },
			);
		}
		return Response.json({ ...result, debugToken });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[analyze-batch error] ${message}`);
		if (err instanceof Error && err.stack) console.error(err.stack);
		return Response.json(
			{ error: "Batch analysis failed. Please check the uploaded files." },
			{ status: 500 },
		);
	}
}

const CSP_HEADERS = {
	"Content-Security-Policy":
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
};

function withSecurityHeaders(response: Response): Response {
	for (const [key, value] of Object.entries(CSP_HEADERS)) {
		response.headers.set(key, value);
	}
	return response;
}

export const server = Bun.serve({
	hostname: "0.0.0.0",
	port: PORT,
	maxRequestBodySize: MAX_BODY_SIZE,
	idleTimeout: 255, // max Bun allows; SSE streams need long-lived connections
	async fetch(req) {
		const start = Date.now();
		const ip = server.requestIP(req)?.address ?? "unknown";

		// OPTIONS — used by reverse proxy for upstate checks
		// Must be handled before URL parsing since HAProxy sends bare paths
		if (req.method === "OPTIONS") {
			return new Response(null, { status: 200 });
		}

		const url = new URL(req.url);

		// API routes
		if (url.pathname === "/api/analyze" && req.method === "POST") {
			if (rateLimited(ip)) {
				return withSecurityHeaders(
					Response.json({ error: "rate_limited" }, { status: 429 }),
				);
			}
			const res = await handleAnalyze(req);
			console.log(
				`${new Date().toISOString()} ${ip} POST /api/analyze ${res.status} ${Date.now() - start}ms`,
			);
			return withSecurityHeaders(res);
		}

		if (url.pathname === "/api/record-next-batch" && req.method === "POST") {
			if (process.env.NODE_ENV === "production") {
				return withSecurityHeaders(
					new Response("Not available in production", { status: 403 }),
				);
			}
			// Dev-only fixture recorder, but still admin-gated: an unauthenticated
			// POST must never be able to arm persistence of the next upload.
			const { checkBearerToken, loadAdminSecret } = await import(
				"./poc-secret.ts"
			);
			let adminSecret: string;
			try {
				adminSecret = loadAdminSecret();
			} catch {
				return withSecurityHeaders(
					Response.json(
						{ error: "admin_secret_not_configured" },
						{ status: 403 },
					),
				);
			}
			if (!checkBearerToken(req.headers.get("authorization"), adminSecret)) {
				return withSecurityHeaders(
					Response.json({ error: "unauthorized" }, { status: 401 }),
				);
			}
			recordNextBatch = true;
			console.log(
				"[record] Armed — next batch request will be saved to test fixtures",
			);
			return withSecurityHeaders(Response.json({ status: "armed" }));
		}

		if (url.pathname === "/api/analyze-batch" && req.method === "POST") {
			if (rateLimited(ip)) {
				return withSecurityHeaders(
					Response.json({ error: "rate_limited" }, { status: 429 }),
				);
			}
			const res = await handleAnalyzeBatch(req);
			console.log(
				`${new Date().toISOString()} ${ip} POST /api/analyze-batch ${res.status} ${Date.now() - start}ms`,
			);
			return withSecurityHeaders(res);
		}

		if (url.pathname === "/api/stats" && req.method === "GET") {
			const stats = await loadStats();
			return withSecurityHeaders(Response.json(stats));
		}

		if (url.pathname === "/api/tenants/register" && req.method === "POST") {
			const { handleTenantRegister } = await import("./handlers/tenants.ts");
			// Read env per-request so tests can override the data dir after import.
			const dataDir =
				process.env.AL_PERF_DATA_DIR ?? resolve(import.meta.dir, "data");
			return withSecurityHeaders(await handleTenantRegister(req, dataDir));
		}

		if (url.pathname === "/api/ingest" && req.method === "POST") {
			const { handleIngest } = await import("./handlers/ingest.ts");
			const dataDir =
				process.env.AL_PERF_DATA_DIR ?? resolve(import.meta.dir, "data");
			return withSecurityHeaders(await handleIngest(req, dataDir));
		}

		const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
		if (profileMatch && req.method === "GET") {
			const { handleGetProfile } = await import("./handlers/profiles.ts");
			const dataDir =
				process.env.AL_PERF_DATA_DIR ?? resolve(import.meta.dir, "data");
			return withSecurityHeaders(
				await handleGetProfile(req, url, dataDir, profileMatch[1]),
			);
		}

		if (url.pathname === "/api/debug/save" && req.method === "POST") {
			try {
				const body = (await req.json()) as { debugToken?: string };
				if (!body.debugToken) {
					return withSecurityHeaders(
						Response.json({ error: "Missing debugToken" }, { status: 400 }),
					);
				}
				const capture = debugStore.get(body.debugToken);
				if (!capture) {
					return withSecurityHeaders(
						Response.json(
							{ error: "Capture not found or expired" },
							{ status: 404 },
						),
					);
				}
				const now = new Date();
				const consent = {
					consentedAt: now.toISOString(),
					retentionDays: 7,
					expiresAt: new Date(
						now.getTime() + 7 * 24 * 60 * 60 * 1000,
					).toISOString(),
				};
				const folder = await writeCaptureToDisk(
					capture,
					DEBUG_DIR,
					"user-consent",
					consent,
				);
				debugStore.remove(body.debugToken);
				console.log(`[debug] Consent capture saved to ${folder}`);
				return withSecurityHeaders(
					Response.json({ saved: true, id: capture.id }),
				);
			} catch {
				return withSecurityHeaders(
					Response.json({ error: "Failed to save capture" }, { status: 500 }),
				);
			}
		}

		// ACCEPTED RISK (knowingly left as-is, not a fix-later TODO): this route
		// has no authentication — no bearer check, no admin gate — unlike
		// /api/record-next-batch below, which IS admin-gated even though it's
		// dev-only. Before this stale-algo visibility work, that meant no tenant
		// data leaked here at all. Now `staleAlgoTenants` publishes customer
		// tenant codes to anyone who can reach this endpoint. That has been
		// consciously accepted for now — do NOT quietly "fix" it by gating or
		// aggregating without discussing it first. But before this server is
		// ever reachable from an untrusted network, this route MUST be either
		// gated behind an admin bearer token or reduced to aggregate counts
		// (e.g. total stale-algo tenant count, no names).
		if (url.pathname === "/api/debug/status" && req.method === "GET") {
			const aiEnabled =
				process.env.AI_DISABLED !== "1" && !!process.env.ANTHROPIC_API_KEY;
			// Only query the lifecycle store when lifecycle tracking is actually
			// on — opening one just to answer this status query would create a
			// lifecycle DB on a deployment that never uses lifecycle at all.
			let staleAlgoTenants: Array<{
				tenant: string;
				count: number;
				versions: number[];
			}> = [];
			if (process.env.AL_PERF_LIFECYCLE === "1") {
				const { getLifecycleStore } = await import("./lifecycle-db.ts");
				const { FINGERPRINT_ALGO_VERSION } = await import(
					"../src/lifecycle/fingerprint.ts"
				);
				// Read env per-request so tests can override the data dir after import.
				const dataDir =
					process.env.AL_PERF_DATA_DIR ?? resolve(import.meta.dir, "data");
				staleAlgoTenants = getLifecycleStore(dataDir).listStaleAlgoTenants(
					FINGERPRINT_ALGO_VERSION,
				);
			}
			return withSecurityHeaders(
				Response.json({
					version: APP_VERSION,
					startedAt: STARTED_AT.toISOString(),
					uptimeSec: Math.floor((Date.now() - STARTED_AT.getTime()) / 1000),
					debugMode: DEBUG_MODE,
					pendingCaptures: debugStore.pendingCount,
					aiEnabled,
					staleAlgoTenants,
				}),
			);
		}

		// Static file serving
		if (req.method === "GET") {
			const staticResponse = await serveStatic(url.pathname);
			if (staticResponse) return withSecurityHeaders(staticResponse);
		}

		return withSecurityHeaders(
			Response.json({ error: "Not found" }, { status: 404 }),
		);
	},
});

console.log(
	`AL Profile Analyzer web server running at http://localhost:${server.port}`,
);
console.log(
	`AI explain: ${
		process.env.AI_DISABLED === "1"
			? "disabled (AI_DISABLED=1)"
			: process.env.ANTHROPIC_API_KEY
				? "enabled"
				: "disabled (set ANTHROPIC_API_KEY to enable)"
	}`,
);
console.log(
	`Debug mode: ${DEBUG_MODE ? "enabled (saving all requests)" : "disabled (consent mode available)"}`,
);
