import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import type { HistoryEntry, HistoryQuery } from "../types/history.js";
import type { AnalysisResult } from "../output/types.js";

/**
 * Local JSON-based store for analysis history.
 * Each entry is a separate JSON file in the store directory.
 */
export class HistoryStore {
  private storeDir: string;

  constructor(storeDir: string) {
    this.storeDir = resolve(storeDir);
  }

  /**
   * Store an analysis result as a history entry.
   */
  save(result: AnalysisResult, options?: { gitCommit?: string; label?: string }): HistoryEntry {
    if (!existsSync(this.storeDir)) {
      mkdirSync(this.storeDir, { recursive: true });
    }

    const timestamp = result.meta.analyzedAt;
    const profileHash = createHash("sha256")
      .update(result.meta.profilePath)
      .digest("hex")
      .slice(0, 8);
    const baseId = `${timestamp.replace(/[:.]/g, "-")}_${profileHash}`;

    // Ensure uniqueness: if a file with this ID already exists, append a counter
    let id = baseId;
    let counter = 1;
    while (existsSync(join(this.storeDir, `${id}.json`))) {
      id = `${baseId}_${counter}`;
      counter++;
    }

    const entry: HistoryEntry = {
      id,
      timestamp,
      profilePath: result.meta.profilePath,
      profileType: result.meta.profileType,
      gitCommit: options?.gitCommit,
      label: options?.label,
      metrics: {
        totalDuration: result.meta.totalDuration,
        totalSelfTime: result.meta.totalSelfTime,
        idleSelfTime: result.meta.idleSelfTime,
        nodeCount: result.meta.totalNodes,
        maxDepth: result.meta.maxDepth,
        confidenceScore: result.meta.confidenceScore,
        healthScore: result.summary.healthScore,
        patternCount: result.summary.patternCount,
      },
      topHotspots: result.hotspots.slice(0, 5).map(h => ({
        functionName: h.functionName,
        objectType: h.objectType,
        objectId: h.objectId,
        selfTime: h.selfTime,
        selfTimePercent: h.selfTimePercent,
      })),
    };

    const filePath = join(this.storeDir, `${id}.json`);
    writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");

    return entry;
  }

  /**
   * Query history entries with optional filters.
   */
  query(q?: HistoryQuery): HistoryEntry[] {
    if (!existsSync(this.storeDir)) return [];

    const files = readdirSync(this.storeDir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse(); // newest first

    let entries: HistoryEntry[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.storeDir, file), "utf-8");
        const entry: HistoryEntry = JSON.parse(raw);
        entries.push(entry);
      } catch {
        // Skip corrupted files
      }
    }

    // Apply filters
    if (q?.profilePath) {
      const pathFilter = q.profilePath.toLowerCase();
      entries = entries.filter(e => e.profilePath.toLowerCase().includes(pathFilter));
    }
    if (q?.since) {
      entries = entries.filter(e => e.timestamp >= q.since!);
    }
    if (q?.until) {
      entries = entries.filter(e => e.timestamp <= q.until!);
    }
    if (q?.label) {
      entries = entries.filter(e => e.label === q.label);
    }
    if (q?.limit !== undefined && q.limit > 0) {
      entries = entries.slice(0, q.limit);
    }

    return entries;
  }

  /**
   * Get a specific entry by ID.
   */
  get(id: string): HistoryEntry | null {
    const filePath = join(this.storeDir, `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * Delete a specific entry.
   */
  delete(id: string): boolean {
    const filePath = join(this.storeDir, `${id}.json`);
    if (!existsSync(filePath)) return false;
    rmSync(filePath);
    return true;
  }

  /**
   * Clear all history.
   */
  clearAll(): void {
    if (existsSync(this.storeDir)) {
      rmSync(this.storeDir, { recursive: true });
    }
  }

  /**
   * Count total entries.
   */
  count(): number {
    if (!existsSync(this.storeDir)) return 0;
    return readdirSync(this.storeDir).filter(f => f.endsWith(".json")).length;
  }
}
