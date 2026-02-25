import { describe, it, expect } from "bun:test";
import { findCompanionZip, extractCompanionZip } from "../../src/source/zip-extractor.js";
import { resolve } from "path";
import { existsSync } from "fs";

const exampleDataDir = resolve(import.meta.dir, "../../exampledata");

describe("findCompanionZip", () => {
  it("should find the companion zip for an instrumentation profile", () => {
    const profilePath = resolve(exampleDataDir, "cedf4512-490d-4252-b9f6-943dd571888f.alcpuprofile");
    const zipPath = findCompanionZip(profilePath);
    expect(zipPath).not.toBeNull();
    expect(zipPath!.endsWith(".zip")).toBe(true);
    expect(existsSync(zipPath!)).toBe(true);
  });

  it("should return null for a sampling profile without companion zip", () => {
    const profilePath = resolve(exampleDataDir, "PerformanceProfile_Session6.alcpuprofile");
    const zipPath = findCompanionZip(profilePath);
    expect(zipPath).toBeNull();
  });
});

describe("extractCompanionZip", () => {
  it("should extract .al files from the companion zip", async () => {
    const zipPath = resolve(exampleDataDir, "cedf4512-490d-4252-b9f6-943dd571888f.zip");
    const result = await extractCompanionZip(zipPath);
    expect(result.extractDir).toBeDefined();
    expect(result.alFileCount).toBeGreaterThan(0);
    expect(existsSync(result.extractDir)).toBe(true);
    await result.cleanup();
  }, 30000); // Allow 30s for large zip
});
