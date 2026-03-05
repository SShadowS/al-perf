/** Per-profile metadata sidecar from Business Central's Performance Profiles table. */
export interface ProfileMetadata {
  activityId: string;
  activityType: "WebClient" | "Background" | "WebServiceAPI";
  activityDescription: string;
  startTime: string;
  activityDuration: number;
  alExecutionDuration: number;
  sqlCallDuration: number;
  sqlCallCount: number;
  httpCallDuration: number;
  httpCallCount: number;
  userName: string;
  clientSessionId: number;
  scheduleDescription?: string;
}
