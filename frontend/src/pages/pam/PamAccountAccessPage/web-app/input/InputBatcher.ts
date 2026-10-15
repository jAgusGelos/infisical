import { MAX_UPSTREAM_PAYLOAD, type TInputEvent } from "@app/lib/pam-web-app/contract";

export const MIN_MOVE_INTERVAL_MS = 1000 / 60;

const encoder = new TextEncoder();
const BATCH_OVERHEAD = encoder.encode('{"events":[]}').length;

export const splitInputBatches = (
  events: TInputEvent[],
  maxPayload = MAX_UPSTREAM_PAYLOAD
): Uint8Array[] => {
  const payloads: Uint8Array[] = [];
  let current: string[] = [];
  let size = BATCH_OVERHEAD;

  const flush = () => {
    if (current.length === 0) return;
    payloads.push(encoder.encode(`{"events":[${current.join(",")}]}`));
    current = [];
    size = BATCH_OVERHEAD;
  };

  const append = (event: TInputEvent) => {
    const json = JSON.stringify(event);
    const { length } = encoder.encode(json);
    if (BATCH_OVERHEAD + length > maxPayload) {
      throw new Error(`input event of ${length} bytes exceeds the upstream payload limit`);
    }
    if (size + (current.length > 0 ? 1 : 0) + length > maxPayload) flush();
    size += (current.length > 0 ? 1 : 0) + length;
    current.push(json);
  };

  events.forEach(append);
  flush();
  return payloads;
};

type TScheduler = {
  now: () => number;
  requestFrame: (fn: () => void) => number;
  cancelFrame: (handle: number) => void;
};

const browserFrameScheduler: TScheduler = {
  now: () => performance.now(),
  requestFrame: (fn) => window.requestAnimationFrame(fn),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle)
};

export class InputBatcher {
  private queue: TInputEvent[] = [];

  private frame: number | null = null;

  private lastMoveSentAt = -Infinity;

  constructor(
    private readonly send: (events: TInputEvent[]) => void,
    private readonly scheduler: TScheduler = browserFrameScheduler
  ) {}

  push(event: TInputEvent) {
    const last = this.queue[this.queue.length - 1];
    if (event.t === "move" && last?.t === "move") {
      this.queue[this.queue.length - 1] = event;
    } else {
      this.queue.push(event);
    }
    this.schedule();
  }

  flush() {
    this.frame = null;
    if (this.queue.length === 0) return;
    const now = this.scheduler.now();
    const onlyMove = this.queue.length === 1 && this.queue[0].t === "move";
    if (onlyMove && now - this.lastMoveSentAt < MIN_MOVE_INTERVAL_MS) {
      this.schedule();
      return;
    }
    const events = this.queue;
    this.queue = [];
    if (events.some((event) => event.t === "move")) this.lastMoveSentAt = now;
    this.send(events);
  }

  clear() {
    this.queue = [];
    if (this.frame !== null) this.scheduler.cancelFrame(this.frame);
    this.frame = null;
  }

  private schedule() {
    if (this.frame === null) this.frame = this.scheduler.requestFrame(() => this.flush());
  }
}
