import type { TClock } from "./types";

// Contract 1.11: the gateway keeps the session for 60 s after the viewer link drops.
export const RECONNECT_WINDOW_MS = 60_000;

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];

export const reconnectDelay = (attempt: number) =>
  RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];

export type TReconnectStatus = "idle" | "waiting" | "gave_up";

type Options = {
  clock: TClock;
  connect: () => void;
  onStatusChange: (status: TReconnectStatus) => void;
};

export class ReconnectController {
  private droppedAt: number | null = null;

  private attempt = 0;

  private timer: number | null = null;

  constructor(private readonly options: Options) {}

  onDisconnected() {
    if (this.timer !== null) return;
    const now = this.options.clock.now();
    if (this.droppedAt === null) this.droppedAt = now;
    const delay = reconnectDelay(this.attempt);
    if (now - this.droppedAt + delay > RECONNECT_WINDOW_MS) {
      this.reset();
      this.options.onStatusChange("gave_up");
      return;
    }
    this.attempt += 1;
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null;
      this.options.connect();
    }, delay);
    this.options.onStatusChange("waiting");
  }

  onLive() {
    if (this.droppedAt === null && this.timer === null) return;
    this.reset();
    this.options.onStatusChange("idle");
  }

  stop() {
    this.reset();
  }

  private reset() {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
    this.droppedAt = null;
    this.attempt = 0;
  }
}
