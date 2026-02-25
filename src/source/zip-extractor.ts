import { existsSync } from "fs";
import { mkdir, writeFile, rm } from "fs/promises";
import { resolve, dirname, basename } from "path";
import { tmpdir } from "os";

/**
 * Find a companion .zip file for a given profile path.
 * Instrumentation profiles typically have a .zip with the same base name.
 */
export function findCompanionZip(profilePath: string): string | null {
  const dir = dirname(profilePath);
  const base = basename(profilePath, ".alcpuprofile");
  const zipPath = resolve(dir, `${base}.zip`);
  return existsSync(zipPath) ? zipPath : null;
}

export interface ExtractResult {
  extractDir: string;
  alFileCount: number;
  cleanup: () => Promise<void>;
}

/**
 * Extract .al files from a companion zip to a temporary directory.
 * Uses DecompressionStream for deflate (no external deps).
 */
export async function extractCompanionZip(zipPath: string): Promise<ExtractResult> {
  const extractDir = resolve(
    tmpdir(),
    `al-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(extractDir, { recursive: true });

  const file = Bun.file(zipPath);
  const arrayBuffer = await file.arrayBuffer();
  const entries = await readZipEntries(arrayBuffer);

  let alFileCount = 0;
  for (const entry of entries) {
    if (entry.name.toLowerCase().endsWith(".al")) {
      const outputPath = resolve(extractDir, entry.name);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, entry.data);
      alFileCount++;
    }
  }

  return {
    extractDir,
    alFileCount,
    cleanup: async () => {
      await rm(extractDir, { recursive: true, force: true });
    },
  };
}

async function readZipEntries(
  buffer: ArrayBuffer,
): Promise<{ name: string; data: Uint8Array }[]> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const entries: { name: string; data: Uint8Array }[] = [];

  let offset = 0;
  while (offset < bytes.length - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // Local file header signature

    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);

    const nameBytes = bytes.slice(offset + 30, offset + 30 + nameLength);
    const name = new TextDecoder().decode(nameBytes);

    const dataStart = offset + 30 + nameLength + extraLength;
    const compressedData = bytes.slice(dataStart, dataStart + compressedSize);

    // Skip directories
    if (name.endsWith("/")) {
      offset = dataStart + compressedSize;
      continue;
    }

    let data: Uint8Array;
    if (compressionMethod === 0) {
      // Stored (no compression)
      data = compressedData;
    } else if (compressionMethod === 8) {
      // Deflate
      data = await inflateData(compressedData, uncompressedSize);
    } else {
      // Unsupported compression method — skip
      offset = dataStart + compressedSize;
      continue;
    }

    entries.push({ name, data });
    offset = dataStart + compressedSize;
  }

  return entries;
}

/**
 * Decompress deflate-raw data using DecompressionStream.
 */
async function inflateData(
  compressedData: Uint8Array,
  _uncompressedSize: number,
): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressedData);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }

  return result;
}
