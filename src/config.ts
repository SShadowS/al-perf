import type { ExplainModel } from "./explain/explainer.js";
import type { CallTreeStrategy } from "./explain/deep-analyzer.js";

export const config = {
  /** Default AI model for all explain/deep calls */
  defaultModel: (process.env.AL_PERF_MODEL as ExplainModel) || "sonnet",

  /** Number of hotspots to include in analysis results */
  analysisTopN: 20,

  /** Max source snippets to attach to hotspots */
  snippetLimit: 15,

  explain: {
    /** Max output tokens for --explain */
    maxTokens: 2048,
    /** Hotspots sent in trimmed payload */
    trimmedHotspots: 20,
    /** Patterns sent in trimmed payload */
    trimmedPatterns: 15,
  },

  deep: {
    /** Max output tokens for --deep */
    maxTokens: 16384,
    /** Default call tree serialization strategy */
    strategy: "adjacency" as CallTreeStrategy,
    /** Top methods for adjacency summary */
    adjacencyTopMethods: 10,
    /** Max subtrees for pruned strategy */
    prunedMaxSubtrees: 5,
    /** Max depth for pruned strategy */
    prunedMaxDepth: 5,
    /** Min percent for pruned strategy */
    prunedMinPercent: 1,
    /** Max chains for chains strategy */
    chainsMaxChains: 10,
  },

  batchExplain: {
    /** Max output tokens for batch explain */
    maxTokens: 2048,
    /** Recurring patterns in trimmed payload */
    trimmedPatterns: 15,
    /** Cumulative hotspots in trimmed payload */
    trimmedHotspots: 20,
    /** Activity breakdown rows in trimmed payload */
    trimmedActivities: 20,
    /** App breakdown entries in trimmed payload */
    trimmedApps: 10,
  },
} as const;
