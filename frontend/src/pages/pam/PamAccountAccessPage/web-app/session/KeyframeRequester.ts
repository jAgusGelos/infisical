import type { TClock } from "./types";

export const KEYFRAME_REQUEST_INTERVAL_MS = 1000;

export class KeyframeRequester {
  private lastSentAt: number | null = null;

  constructor(
    private readonly clock: TClock,
    private readonly send: () => void
  ) {}

  request(): boolean {
    const now = this.clock.now();
    if (this.lastSentAt !== null && now - this.lastSentAt < KEYFRAME_REQUEST_INTERVAL_MS) {
      return false;
    }
    this.lastSentAt = now;
    this.send();
    return true;
  }
}
