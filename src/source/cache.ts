import { existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { createHash } from "crypto";
import type {
  SourceIndex,
  ALFileInfo,
  ObjectInfo,
  ProcedureInfo,
  TriggerInfo,
  TableFieldInfo,
  EventCatalog,
} from "../types/source-index.js";
import { buildSourceIndex } from "./indexer.js";

const CACHE_VERSION = 2;

interface SerializedIndex {
  files: ALFileInfo[];
  objects: Array<[string, SerializedObjectInfo]>;
  procedures: Array<[string, ProcedureInfo[]]>;
  triggers: Array<[string, TriggerInfo[]]>;
  eventCatalog: EventCatalog;
}

/**
 * Serialized form of ObjectInfo — identical except `procedures` and `triggers`
 * are plain arrays (which they already are), so no extra conversion is needed.
 * We store ObjectInfo as-is since its nested structures are all plain objects.
 */
interface SerializedObjectInfo {
  objectType: string;
  objectName: string;
  objectId: number;
  file: ALFileInfo;
  procedures: ProcedureInfo[];
  triggers: TriggerInfo[];
  fields: TableFieldInfo[];
}

interface CacheEntry {
  version: number;
  dirHash: string;
  timestamp: number;
  fileCount: number;
  index: SerializedIndex;
}

/**
 * Recursively walk a directory and collect all .al file paths and their mtimes.
 * Returns sorted entries for deterministic hashing.
 */
function walkALFiles(dirPath: string): Array<{ path: string; mtime: number }> {
  const results: Array<{ path: string; mtime: number }> = [];

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".al")) {
        try {
          const stat = statSync(fullPath);
          results.push({ path: fullPath, mtime: stat.mtimeMs });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  walk(dirPath);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Compute a SHA-256 hash of all .al files in a directory based on their paths and mtimes.
 */
function computeDirHash(dirPath: string): string {
  const files = walkALFiles(dirPath);
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(`${f.path}:${f.mtime}\n`);
  }
  return hash.digest("hex");
}

/**
 * Compute a cache filename from a directory path.
 * Uses the first 16 characters of the SHA-256 of the resolved absolute path.
 */
function cacheKeyForDir(dirPath: string): string {
  const resolved = resolve(dirPath);
  const hash = createHash("sha256").update(resolved).digest("hex");
  return `${hash.slice(0, 16)}.json`;
}

/**
 * Serialize a SourceIndex into a plain JSON-safe structure.
 * Maps are converted to arrays of [key, value] entries.
 */
function serializeIndex(index: SourceIndex): SerializedIndex {
  return {
    files: index.files,
    objects: Array.from(index.objects.entries()),
    procedures: Array.from(index.procedures.entries()),
    triggers: Array.from(index.triggers.entries()),
    eventCatalog: index.eventCatalog,
  };
}

/**
 * Deserialize a SerializedIndex back into a SourceIndex with proper Maps.
 */
function deserializeIndex(serialized: SerializedIndex): SourceIndex {
  return {
    files: serialized.files,
    objects: new Map(serialized.objects),
    procedures: new Map(serialized.procedures),
    triggers: new Map(serialized.triggers),
    eventCatalog: serialized.eventCatalog ?? { publishers: [], subscribers: [] },
  };
}

/**
 * Cache for SourceIndex instances, keyed by directory path.
 * Uses file listing + mtime hashing for cache invalidation.
 */
export class SourceIndexCache {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = resolve(cacheDir);
  }

  /**
   * Check if a valid cache entry exists for the given directory.
   */
  has(dirPath: string): boolean {
    const cacheFile = join(this.cacheDir, cacheKeyForDir(dirPath));
    if (!existsSync(cacheFile)) return false;

    try {
      const raw = readFileSync(cacheFile, "utf-8");
      const entry: CacheEntry = JSON.parse(raw);
      if (entry.version !== CACHE_VERSION) return false;

      const currentHash = computeDirHash(dirPath);
      return entry.dirHash === currentHash;
    } catch {
      return false;
    }
  }

  /**
   * Return cached SourceIndex if valid, otherwise build a new one and cache it.
   */
  async getOrBuild(dirPath: string): Promise<SourceIndex> {
    const resolvedDir = resolve(dirPath);
    const cacheFile = join(this.cacheDir, cacheKeyForDir(resolvedDir));

    // Compute the directory hash once upfront
    const currentHash = computeDirHash(resolvedDir);

    // Try loading from cache
    if (existsSync(cacheFile)) {
      try {
        const raw = readFileSync(cacheFile, "utf-8");
        const entry: CacheEntry = JSON.parse(raw);

        if (entry.version === CACHE_VERSION) {
          if (entry.dirHash === currentHash) {
            return deserializeIndex(entry.index);
          }
        }
      } catch {
        // Cache corrupted — fall through to rebuild
      }
    }

    // Build fresh index
    const index = await buildSourceIndex(resolvedDir);

    // Store in cache — reuse the hash computed above
    this.store(cacheFile, currentHash, resolvedDir, index);

    return index;
  }

  /**
   * Write a cache entry to disk.
   */
  private store(
    cacheFile: string,
    dirHash: string,
    resolvedDir: string,
    index: SourceIndex,
  ): void {
    const alFiles = walkALFiles(resolvedDir);
    const entry: CacheEntry = {
      version: CACHE_VERSION,
      dirHash,
      timestamp: Date.now(),
      fileCount: alFiles.length,
      index: serializeIndex(index),
    };

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }

    writeFileSync(cacheFile, JSON.stringify(entry), "utf-8");
  }

  /**
   * Remove the cache entry for a specific directory.
   */
  invalidate(dirPath: string): void {
    const cacheFile = join(this.cacheDir, cacheKeyForDir(dirPath));
    if (existsSync(cacheFile)) {
      rmSync(cacheFile);
    }
  }

  /**
   * Remove all cache entries.
   */
  clearAll(): void {
    if (existsSync(this.cacheDir)) {
      rmSync(this.cacheDir, { recursive: true });
    }
  }
}
