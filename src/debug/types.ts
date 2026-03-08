import type { AiDebugInfo } from "../explain/explainer.js";
import type { ApiCallCost } from "../explain/api-cost.js";

export type CaptureMode = "developer-debug" | "user-consent";

export interface DebugCapture {
  id: number;
  token: string;
  timestamp: Date;
  profileData: Uint8Array;
  profileName: string;
  sourceZipData?: Uint8Array;
  batchProfiles?: Array<{ name: string; data: Uint8Array }>;
  manifestJson?: string;
  explainCapture?: AiCallCapture;
  deepCapture?: AiCallCapture;
  batchExplainCapture?: AiCallCapture;
  analysisResult?: object;
  costs: ApiCallCost[];
  analysisDurationMs: number;
}

export interface AiCallCapture {
  debugInfo: AiDebugInfo;
  parsedOutput: string | object;
}

export interface ConsentInfo {
  consentedAt: string;
  consentedBy: string;
  retentionDays: number;
  expiresAt: string;
}

export interface CaptureMeta {
  id: number;
  timestamp: string;
  mode: CaptureMode;
  model: string;
  costs: object;
  analysisDurationMs: number;
  consentedAt?: string;
  consentedBy?: string;
  retentionDays?: number;
  expiresAt?: string;
}
