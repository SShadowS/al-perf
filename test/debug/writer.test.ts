import { describe, expect, test, afterEach } from "bun:test";
import { mkdir, rm, readFile, readdir } from "fs/promises";
import { resolve } from "path";
import { writeCaptureToDisk } from "../../src/debug/writer.js";
import type { DebugCapture, AiCallCapture, ConsentInfo } from "../../src/debug/types.js";

const TEST_DIR = resolve(import.meta.dir, "..", "fixtures", "debug-writer-test");

function makeAiCallCapture(prefix: string): AiCallCapture {
  return {
    debugInfo: {
      systemPrompt: `${prefix} system prompt`,
      userPayload: { query: `${prefix} payload` },
      rawResponse: { result: `${prefix} response` },
    },
    parsedOutput: `${prefix} parsed output`,
  };
}

function makeCapture(overrides: Partial<DebugCapture> = {}): DebugCapture {
  return {
    id: 1,
    token: "test-token",
    timestamp: new Date("2026-03-08T14:30:00.000Z"),
    profileData: new Uint8Array([1, 2, 3, 4]),
    profileName: "test-profile.alcpuprofile",
    costs: [{ call: "explain", model: "sonnet", inputTokens: 100, outputTokens: 50, cost: 0.001 }],
    analysisDurationMs: 1500,
    ...overrides,
  };
}

describe("writeCaptureToDisk", () => {
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("writes correct folder structure for developer-debug capture", async () => {
    const capture = makeCapture({
      analysisResult: { hotspots: ["method1"] },
      explainCapture: makeAiCallCapture("explain"),
    });

    const folder = await writeCaptureToDisk(capture, TEST_DIR, "developer-debug");

    // Check folder name format
    expect(folder).toContain("001_2026-03-08T14-30-00");

    // Check meta.json
    const meta = JSON.parse(await readFile(resolve(folder, "meta.json"), "utf-8"));
    expect(meta.id).toBe(1);
    expect(meta.timestamp).toBe("2026-03-08T14:30:00.000Z");
    expect(meta.mode).toBe("developer-debug");
    expect(meta.model).toBe("sonnet");
    expect(meta.analysisDurationMs).toBe(1500);
    expect(meta.costs).toEqual([{ call: "explain", model: "sonnet", inputTokens: 100, outputTokens: 50, cost: 0.001 }]);

    // Check profile data
    const profileBytes = new Uint8Array(await readFile(resolve(folder, "profile.alcpuprofile")));
    expect(profileBytes).toEqual(new Uint8Array([1, 2, 3, 4]));

    // Check analysis-result.json
    const analysisResult = JSON.parse(await readFile(resolve(folder, "analysis-result.json"), "utf-8"));
    expect(analysisResult).toEqual({ hotspots: ["method1"] });

    // Check explain subfolder (4 files)
    const explainDir = resolve(folder, "explain");
    const explainFiles = await readdir(explainDir);
    expect(explainFiles.sort()).toEqual([
      "parsed-output.txt",
      "raw-response.json",
      "system-prompt.txt",
      "user-payload.json",
    ]);
    expect(await readFile(resolve(explainDir, "system-prompt.txt"), "utf-8")).toBe("explain system prompt");
    expect(JSON.parse(await readFile(resolve(explainDir, "user-payload.json"), "utf-8"))).toEqual({ query: "explain payload" });
    expect(JSON.parse(await readFile(resolve(explainDir, "raw-response.json"), "utf-8"))).toEqual({ result: "explain response" });
    expect(await readFile(resolve(explainDir, "parsed-output.txt"), "utf-8")).toBe("explain parsed output");
  });

  test("user-consent capture includes consent metadata in meta.json", async () => {
    const capture = makeCapture();
    const consent: ConsentInfo = {
      consentedAt: "2026-03-08T14:30:00.000Z",
      consentedBy: "testuser@example.com",
      retentionDays: 30,
      expiresAt: "2026-04-07T14:30:00.000Z",
    };

    const folder = await writeCaptureToDisk(capture, TEST_DIR, "user-consent", consent);

    const meta = JSON.parse(await readFile(resolve(folder, "meta.json"), "utf-8"));
    expect(meta.mode).toBe("user-consent");
    expect(meta.consentedAt).toBe("2026-03-08T14:30:00.000Z");
    expect(meta.consentedBy).toBe("testuser@example.com");
    expect(meta.retentionDays).toBe(30);
    expect(meta.expiresAt).toBe("2026-04-07T14:30:00.000Z");
  });

  test("source zip is written when present", async () => {
    const sourceZipData = new Uint8Array([80, 75, 3, 4]); // PK header
    const capture = makeCapture({ sourceZipData });

    const folder = await writeCaptureToDisk(capture, TEST_DIR, "developer-debug");

    const zipBytes = new Uint8Array(await readFile(resolve(folder, "source.zip")));
    expect(zipBytes).toEqual(sourceZipData);
  });

  test("deep subfolder is written when deep capture is present", async () => {
    const deepCapture: AiCallCapture = {
      debugInfo: {
        systemPrompt: "deep system prompt",
        userPayload: { analysis: "deep" },
        rawResponse: { findings: [{ title: "finding1" }] },
      },
      parsedOutput: { findings: [{ title: "finding1" }] },
    };
    const capture = makeCapture({ deepCapture });

    const folder = await writeCaptureToDisk(capture, TEST_DIR, "developer-debug");

    const deepDir = resolve(folder, "deep");
    const deepFiles = await readdir(deepDir);
    expect(deepFiles.sort()).toEqual([
      "parsed-findings.json",
      "raw-response.json",
      "system-prompt.txt",
      "user-payload.json",
    ]);

    expect(await readFile(resolve(deepDir, "system-prompt.txt"), "utf-8")).toBe("deep system prompt");
    // parsedOutput is an object, so it should be JSON-serialized
    const parsedFindings = JSON.parse(await readFile(resolve(deepDir, "parsed-findings.json"), "utf-8"));
    expect(parsedFindings).toEqual({ findings: [{ title: "finding1" }] });
  });

  test("batch profiles are written to profiles/ subfolder with manifest", async () => {
    const capture = makeCapture({
      profileData: new Uint8Array([0]), // should be ignored in favor of batch
      batchProfiles: [
        { name: "profile1.alcpuprofile", data: new Uint8Array([10, 20]) },
        { name: "profile2.alcpuprofile", data: new Uint8Array([30, 40]) },
      ],
      manifestJson: JSON.stringify({ profiles: ["profile1", "profile2"] }),
    });

    const folder = await writeCaptureToDisk(capture, TEST_DIR, "developer-debug");

    // Batch profiles in profiles/ subfolder
    const profilesDir = resolve(folder, "profiles");
    const profileFiles = await readdir(profilesDir);
    expect(profileFiles.sort()).toEqual(["profile1.alcpuprofile", "profile2.alcpuprofile"]);

    const p1 = new Uint8Array(await readFile(resolve(profilesDir, "profile1.alcpuprofile")));
    expect(p1).toEqual(new Uint8Array([10, 20]));
    const p2 = new Uint8Array(await readFile(resolve(profilesDir, "profile2.alcpuprofile")));
    expect(p2).toEqual(new Uint8Array([30, 40]));

    // Manifest at folder root
    const manifest = JSON.parse(await readFile(resolve(folder, "manifest.json"), "utf-8"));
    expect(manifest).toEqual({ profiles: ["profile1", "profile2"] });

    // Single profile.alcpuprofile should NOT exist
    const topFiles = await readdir(folder);
    expect(topFiles).not.toContain("profile.alcpuprofile");
  });

  test("batch-explain subfolder is written when present", async () => {
    const capture = makeCapture({
      batchExplainCapture: makeAiCallCapture("batch"),
    });

    const folder = await writeCaptureToDisk(capture, TEST_DIR, "developer-debug");

    const batchDir = resolve(folder, "batch-explain");
    const files = await readdir(batchDir);
    expect(files.sort()).toEqual([
      "parsed-output.txt",
      "raw-response.json",
      "system-prompt.txt",
      "user-payload.json",
    ]);
    expect(await readFile(resolve(batchDir, "parsed-output.txt"), "utf-8")).toBe("batch parsed output");
  });

  test("omits analysis-result.json when no analysis result", async () => {
    const capture = makeCapture({ analysisResult: undefined });

    const folder = await writeCaptureToDisk(capture, TEST_DIR, "developer-debug");

    const files = await readdir(folder);
    expect(files).not.toContain("analysis-result.json");
  });

  test("folder name pads ID to 3 digits", async () => {
    const capture = makeCapture({ id: 42 });
    const folder = await writeCaptureToDisk(capture, TEST_DIR, "developer-debug");
    expect(folder).toContain("042_");
  });
});
