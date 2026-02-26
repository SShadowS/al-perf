import { resolve, join } from "path";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { analyzeProfile } from "../src/core/analyzer.js";
import { extractCompanionZip } from "../src/source/zip-extractor.js";

const PUBLIC_DIR = resolve(import.meta.dir, "public");
const MAX_BODY_SIZE = 100 * 1024 * 1024; // 100MB
const PORT = parseInt(process.env.PORT || "3000", 10);

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
  const filePath = pathname === "/" ? join(PUBLIC_DIR, "index.html") : join(PUBLIC_DIR, pathname);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return new Response("Forbidden", { status: 403 });
  }

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file);
  }
  return null;
}

/**
 * Handle POST /api/analyze — accepts multipart/form-data with:
 *   - profile (required): .alcpuprofile file
 *   - source (optional): .zip of AL source files
 *
 * Returns AnalysisResult as JSON.
 */
async function handleAnalyze(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return Response.json(
      { error: "Content-Type must be multipart/form-data" },
      { status: 400 },
    );
  }

  let tempDir: string | undefined;
  let sourceCleanup: (() => Promise<void>) | undefined;

  try {
    const formData = await req.formData();
    const profileFile = formData.get("profile");

    if (!profileFile || !(profileFile instanceof File)) {
      return Response.json(
        { error: "Missing required 'profile' field (must be a file)" },
        { status: 400 },
      );
    }

    // Write uploads to a per-request temp directory
    tempDir = await makeTempDir();

    const profilePath = join(tempDir, profileFile.name || "profile.alcpuprofile");
    await Bun.write(profilePath, profileFile);

    // Handle optional source zip
    let sourcePath: string | undefined;
    const sourceFile = formData.get("source");
    if (sourceFile && sourceFile instanceof File) {
      const zipPath = join(tempDir, sourceFile.name || "source.zip");
      await Bun.write(zipPath, sourceFile);
      const extracted = await extractCompanionZip(zipPath);
      sourcePath = extracted.extractDir;
      sourceCleanup = extracted.cleanup;
    }

    // Run analysis
    const result = await analyzeProfile(profilePath, {
      top: 20,
      includePatterns: true,
      sourcePath,
    });

    return Response.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  } finally {
    // Clean up source extraction temp dir
    if (sourceCleanup) {
      try {
        await sourceCleanup();
      } catch {
        // best-effort cleanup
      }
    }
    // Clean up the per-request temp dir
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_BODY_SIZE,
  async fetch(req) {
    const url = new URL(req.url);

    // API routes
    if (url.pathname === "/api/analyze" && req.method === "POST") {
      return handleAnalyze(req);
    }

    // Static file serving
    if (req.method === "GET") {
      const staticResponse = await serveStatic(url.pathname);
      if (staticResponse) return staticResponse;
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`AL Profile Analyzer web server running at http://localhost:${server.port}`);
