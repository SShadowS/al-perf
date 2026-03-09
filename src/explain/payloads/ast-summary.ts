import type { MethodBreakdown } from "../../types/aggregated.js";
import type { SourceIndex, ProcedureFeatures } from "../../types/source-index.js";

export interface AstSummary {
  method: string;
  objectType: string;
  objectId: number;
  loops: number;
  recordOps: number;
  recordOpsInLoops: number;
  nestingDepth: number;
  variables: number;
  dangerousCallsInLoops: number;
  recordOpTypes: string[];
}

const MAX_HOTSPOTS = 15;

export function extractAstSummaries(
  hotspots: MethodBreakdown[],
  sourceIndex: SourceIndex | undefined,
): AstSummary[] {
  if (!sourceIndex) return [];

  const summaries: AstSummary[] = [];

  for (const hotspot of hotspots.slice(0, MAX_HOTSPOTS)) {
    const key = `${hotspot.objectType}_${hotspot.objectId}`;
    const obj = sourceIndex.objects.get(key);
    if (!obj) continue;

    const nameLower = hotspot.functionName.toLowerCase();
    const proc =
      obj.procedures.find((p) => p.name.toLowerCase() === nameLower) ??
      obj.triggers.find((t) => t.name.toLowerCase() === nameLower);
    if (!proc) continue;

    const f: ProcedureFeatures = proc.features;

    const recordOpsInLoops =
      f.recordOpsInLoops?.length ??
      f.recordOps?.filter((op) => op.insideLoop).length ??
      0;

    const opTypes = [
      ...new Set((f.recordOps ?? []).map((op) => op.type)),
    ];

    summaries.push({
      method: hotspot.functionName,
      objectType: hotspot.objectType,
      objectId: hotspot.objectId,
      loops: f.loops?.length ?? 0,
      recordOps: f.recordOps?.length ?? 0,
      recordOpsInLoops,
      nestingDepth: f.nestingDepth ?? 0,
      variables: f.variables?.length ?? 0,
      dangerousCallsInLoops: f.dangerousCallsInLoops?.length ?? 0,
      recordOpTypes: opTypes,
    });
  }

  return summaries;
}
