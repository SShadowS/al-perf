import type { DebugCapture } from "./types.js";

export class DebugStore {
  private captures = new Map<string, DebugCapture>();
  private readonly expiryMs: number;

  constructor(expiryMs: number) {
    this.expiryMs = expiryMs;
  }

  add(capture: DebugCapture): void {
    this.captures.set(capture.token, capture);
  }

  get(token: string): DebugCapture | undefined {
    return this.captures.get(token);
  }

  remove(token: string): void {
    this.captures.delete(token);
  }

  get pendingCount(): number {
    return this.captures.size;
  }

  sweep(): void {
    const cutoff = Date.now() - this.expiryMs;
    for (const [token, capture] of this.captures) {
      if (capture.timestamp.getTime() < cutoff) {
        this.captures.delete(token);
      }
    }
  }
}
