import { describe, it, expect, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

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
    const profilePath = resolve(import.meta.dir, "../fixtures/instrumentation-minimal.alcpuprofile");
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
  }, 60000);

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
      const profilePath = resolve(import.meta.dir, "../fixtures/instrumentation-minimal.alcpuprofile");
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
    }, 60000);

    it("returns JSON when format=json", async () => {
      const res = await postProfile("json");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const result = await res.json();
      expect(result.meta).toBeDefined();
    }, 60000);

    it("returns HTML when format=html", async () => {
      const res = await postProfile("html");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain("#00B7C3");
      expect(body).toContain("Segoe UI");
      expect(body).toMatch(/CRITICAL|WARNING|INFO/);
    }, 60000);

    it("returns 400 for unsupported format", async () => {
      const res = await postProfile("pdf");
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Unsupported format");
    }, 60000);

    it("HTML response is self-contained (no external resource links)", async () => {
      const res = await postProfile("html");
      const body = await res.text();
      expect(body).not.toMatch(/href="https?:\/\//);
      expect(body).not.toMatch(/src="https?:\/\//);
    }, 60000);
  });
});
