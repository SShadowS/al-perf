import { mkdir, writeFile } from "fs/promises";
import { resolve } from "path";
import type { DebugCapture, CaptureMode, ConsentInfo, CaptureMeta, AiCallCapture } from "./types.js";

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
}

function padId(id: number): string {
  return String(id).padStart(3, "0");
}

async function writeAiCapture(
  dir: string,
  capture: AiCallCapture,
  outputFileName: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(resolve(dir, "system-prompt.txt"), capture.debugInfo.systemPrompt),
    writeFile(resolve(dir, "user-payload.json"), JSON.stringify(capture.debugInfo.userPayload, null, 2)),
    writeFile(resolve(dir, "raw-response.json"), JSON.stringify(capture.debugInfo.rawResponse, null, 2)),
    writeFile(
      resolve(dir, outputFileName),
      typeof capture.parsedOutput === "string"
        ? capture.parsedOutput
        : JSON.stringify(capture.parsedOutput, null, 2),
    ),
  ]);
}

export async function writeCaptureToDisk(
  capture: DebugCapture,
  debugDir: string,
  mode: CaptureMode,
  consent?: ConsentInfo,
): Promise<string> {
  const folderName = `${padId(capture.id)}_${formatTimestamp(capture.timestamp)}`;
  const folder = resolve(debugDir, folderName);
  await mkdir(folder, { recursive: true });

  const meta: CaptureMeta = {
    id: capture.id,
    timestamp: capture.timestamp.toISOString(),
    mode,
    model: "sonnet",
    costs: capture.costs,
    analysisDurationMs: capture.analysisDurationMs,
    ...(consent ?? {}),
  };

  const writes: Promise<void>[] = [];

  writes.push(writeFile(resolve(folder, "meta.json"), JSON.stringify(meta, null, 2)));
  if (capture.analysisResult) {
    writes.push(writeFile(resolve(folder, "analysis-result.json"), JSON.stringify(capture.analysisResult, null, 2)));
  }

  if (capture.batchProfiles && capture.batchProfiles.length > 0) {
    const profilesDir = resolve(folder, "profiles");
    writes.push(
      mkdir(profilesDir, { recursive: true }).then(() =>
        Promise.all(
          capture.batchProfiles!.map((p) =>
            writeFile(resolve(profilesDir, p.name), p.data),
          ),
        ).then(() => {}),
      ),
    );
    if (capture.manifestJson) {
      writes.push(writeFile(resolve(folder, "manifest.json"), capture.manifestJson));
    }
  } else if (capture.profileData) {
    writes.push(writeFile(resolve(folder, "profile.alcpuprofile"), capture.profileData));
  }

  if (capture.sourceZipData) {
    writes.push(writeFile(resolve(folder, "source.zip"), capture.sourceZipData));
  }

  if (capture.explainCapture) {
    writes.push(writeAiCapture(resolve(folder, "explain"), capture.explainCapture, "parsed-output.txt"));
  }
  if (capture.deepCapture) {
    writes.push(writeAiCapture(resolve(folder, "deep"), capture.deepCapture, "parsed-findings.json"));
  }
  if (capture.batchExplainCapture) {
    writes.push(writeAiCapture(resolve(folder, "batch-explain"), capture.batchExplainCapture, "parsed-output.txt"));
  }

  await Promise.all(writes);
  return folder;
}
