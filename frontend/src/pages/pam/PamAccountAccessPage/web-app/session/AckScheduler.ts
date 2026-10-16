import type { TClock } from "./types";

// Contract 1.9 bounds the gap at 100 ms; browser timers fire late under load, so aim lower.
export const ACK_INTERVAL_MS = 80;

export class AckScheduler {
  private highestSeq: number | null = null;

  private lastSentSeq: number | null = null;

  private lastSentAt: number | null = null;

  private timer: number | null = null;

  constructor(
    private readonly clock: TClock,
    private readonly sendAck: (ackSeq: number) => void
  ) {}

  onChunk(seq: number, keyframe: boolean) {
    this.highestSeq = seq;
    if (keyframe) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      // Measured from the previous ACK so the gap between two ACKs never exceeds the interval.
      const elapsed = this.lastSentAt === null ? 0 : this.clock.now() - this.lastSentAt;
      this.timer = this.clock.setTimeout(
        () => {
          this.timer = null;
          this.flush();
        },
        Math.max(0, ACK_INTERVAL_MS - elapsed)
      );
    }
  }

  flush() {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.highestSeq === null || this.highestSeq === this.lastSentSeq) return;
    this.lastSentSeq = this.highestSeq;
    this.lastSentAt = this.clock.now();
    this.sendAck(this.highestSeq);
  }

  stop() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
