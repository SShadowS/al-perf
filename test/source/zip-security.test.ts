import { describe, it, expect, afterEach } from "bun:test";
import { extractCompanionZip } from "../../src/source/zip-extractor.js";
import { resolve, sep } from "path";
import { existsSync, readdirSync } from "fs";
import { writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";

/**
 * Build a minimal zip buffer with stored (uncompressed) entries.
 * Each entry is { name: string, data: Uint8Array }.
 * This only writes local file headers — no central directory — which is
 * sufficient for our custom zip reader.
 */
function buildTestZip(entries: { name: string; data: Uint8Array }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf-8");
    // Local file header: 30 bytes fixed + name
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // compression: stored
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0, 12); // mod date
    header.writeUInt32LE(0, 14); // crc32 (ignored by our reader)
    header.writeUInt32LE(entry.data.length, 18); // compressed size
    header.writeUInt32LE(entry.data.length, 22); // uncompressed size
    header.writeUInt16LE(nameBytes.length, 26); // name length
    header.writeUInt16LE(0, 28); // extra length
    parts.push(header, nameBytes, Buffer.from(entry.data));
  }
  return Buffer.concat(parts);
}

let tempFiles: string[] = [];

async function writeTempZip(buf: Buffer): Promise<string> {
  const dir = resolve(
    tmpdir(),
    `al-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  const zipPath = resolve(dir, "test.zip");
  await writeFile(zipPath, buf);
  tempFiles.push(dir);
  return zipPath;
}

afterEach(async () => {
  for (const dir of tempFiles) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempFiles = [];
});

describe("zip-extractor security", () => {
  describe("zip slip path traversal", () => {
    it("should skip entries with ../ in the path", async () => {
      const maliciousContent = new TextEncoder().encode("// evil code");
      const safeContent = new TextEncoder().encode("// safe code");

      const zip = buildTestZip([
        { name: "../../etc/evil.al", data: maliciousContent },
        { name: "safe/good.al", data: safeContent },
      ]);

      const zipPath = await writeTempZip(zip);
      const result = await extractCompanionZip(zipPath);

      try {
        // Only the safe file should be extracted
        expect(result.alFileCount).toBe(1);

        // Verify the safe file exists
        const safePath = resolve(result.extractDir, "safe", "good.al");
        expect(existsSync(safePath)).toBe(true);
      } finally {
        await result.cleanup();
      }
    });

    it("should skip entries with absolute paths", async () => {
      const content = new TextEncoder().encode("// evil");
      const absPath = sep === "\\" ? "C:\\temp\\evil.al" : "/tmp/evil.al";

      const zip = buildTestZip([
        { name: absPath, data: content },
        { name: "normal.al", data: content },
      ]);

      const zipPath = await writeTempZip(zip);
      const result = await extractCompanionZip(zipPath);

      try {
        // Only the normal file should be extracted
        expect(result.alFileCount).toBe(1);
      } finally {
        await result.cleanup();
      }
    });

    it("should skip entries that escape via ../../ deeply nested", async () => {
      const content = new TextEncoder().encode("// deep escape");

      const zip = buildTestZip([
        { name: "a/b/../../../escape.al", data: content },
        { name: "a/b/legit.al", data: content },
      ]);

      const zipPath = await writeTempZip(zip);
      const result = await extractCompanionZip(zipPath);

      try {
        expect(result.alFileCount).toBe(1);
      } finally {
        await result.cleanup();
      }
    });
  });

  describe("decompression bomb protection", () => {
    it("should skip entries with declared uncompressed size exceeding limit", async () => {
      // Build a zip with a stored entry that claims to be huge
      const nameBytes = Buffer.from("huge.al", "utf-8");
      const data = new TextEncoder().encode("// small");

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(0, 8); // stored
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(0, 14);
      header.writeUInt32LE(data.length, 18); // compressed size (actual)
      // Lie about uncompressed size: claim 100MB (exceeds 50MB limit)
      header.writeUInt32LE(100 * 1024 * 1024, 22);
      header.writeUInt16LE(nameBytes.length, 26);
      header.writeUInt16LE(0, 28);

      const zip = Buffer.concat([header, nameBytes, Buffer.from(data)]);
      const zipPath = await writeTempZip(zip);
      const result = await extractCompanionZip(zipPath);

      try {
        expect(result.alFileCount).toBe(0);
      } finally {
        await result.cleanup();
      }
    });
  });

  describe("normal extraction", () => {
    it("should extract valid .al files from a well-formed zip", async () => {
      const content1 = new TextEncoder().encode("codeunit 50100 MyCode { }");
      const content2 = new TextEncoder().encode("page 50100 MyPage { }");

      const zip = buildTestZip([
        { name: "src/MyCode.al", data: content1 },
        { name: "src/MyPage.al", data: content2 },
        { name: "README.md", data: new TextEncoder().encode("# readme") },
      ]);

      const zipPath = await writeTempZip(zip);
      const result = await extractCompanionZip(zipPath);

      try {
        expect(result.alFileCount).toBe(2);
        expect(existsSync(resolve(result.extractDir, "src", "MyCode.al"))).toBe(true);
        expect(existsSync(resolve(result.extractDir, "src", "MyPage.al"))).toBe(true);
      } finally {
        await result.cleanup();
      }
    });

    it("should handle an empty zip gracefully", async () => {
      const zip = Buffer.alloc(0);
      const zipPath = await writeTempZip(zip);
      const result = await extractCompanionZip(zipPath);

      try {
        expect(result.alFileCount).toBe(0);
      } finally {
        await result.cleanup();
      }
    });
  });
});
