export interface HistoryEntry {
  id: string;
  timestamp: string; // ISO 8601
  profilePath: string;
  profileType: "sampling" | "instrumentation";
  /** Optional git commit hash for correlation */
  gitCommit?: string;
  /** Optional label (e.g., "baseline", "after-optimization") */
  label?: string;
  /** Key metrics snapshot */
  metrics: {
    totalDuration: number;
    totalSelfTime: number;
    idleSelfTime: number;
    nodeCount: number;
    maxDepth: number;
    confidenceScore: number;
    healthScore: number;
    patternCount: { critical: number; warning: number; info: number };
  };
  /** Top 5 hotspot method names + selfTime for trend tracking */
  topHotspots: Array<{
    functionName: string;
    objectType: string;
    objectId: number;
    selfTime: number;
    selfTimePercent: number;
  }>;
}

export interface HistoryQuery {
  /** Filter by profile path (substring match) */
  profilePath?: string;
  /** Only entries after this date */
  since?: string;
  /** Only entries before this date */
  until?: string;
  /** Only entries with this label */
  label?: string;
  /** Maximum number of entries to return */
  limit?: number;
}
