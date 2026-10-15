import { describe, expect, it, vi } from "vitest";

import {
  MAX_UPSTREAM_PAYLOAD,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
  type TInputEvent
} from "@app/lib/pam-web-app/contract";

import { InputBatcher, MIN_MOVE_INTERVAL_MS, splitInputBatches } from "./InputBatcher";
import { mapToFramebuffer, modsOf, normalizeWheel } from "./mapping";

describe("mapToFramebuffer", () => {
  // 1000x800 element showing a 1280x720 stream: scale 0.78125, content 1000x562.5, 118.75 px bars top and bottom.
  const rect = { left: 10, top: 20, width: 1000, height: 800 };

  it("maps through the letterbox to framebuffer pixels", () => {
    expect(mapToFramebuffer(10, 20 + 118.75, rect, 1280, 720)).toEqual({
      x: 0,
      y: 0,
      inside: true
    });
    expect(mapToFramebuffer(510, 420, rect, 1280, 720)).toEqual({ x: 640, y: 360, inside: true });
  });

  it("clamps to 0..width-1 and 0..height-1 and flags points in the bars", () => {
    expect(mapToFramebuffer(1010, 20 + 118.75 + 562.5, rect, 1280, 720)).toEqual({
      x: 1279,
      y: 719,
      inside: false
    });
    expect(mapToFramebuffer(0, 25, rect, 1280, 720)).toEqual({ x: 0, y: 0, inside: false });
    expect(mapToFramebuffer(5000, 5000, rect, 1280, 720)).toEqual({
      x: 1279,
      y: 719,
      inside: false
    });
  });

  it("handles pillarboxing", () => {
    const tall = { left: 0, top: 0, width: 2000, height: 720 };
    expect(mapToFramebuffer(360, 0, tall, 1280, 720)).toEqual({ x: 0, y: 0, inside: true });
    expect(mapToFramebuffer(359, 0, tall, 1280, 720).inside).toBe(false);
  });
});

describe("modsOf and normalizeWheel", () => {
  it("builds the modifier bitmask", () => {
    expect(modsOf({ shiftKey: true, ctrlKey: false, altKey: true, metaKey: false })).toBe(
      MOD_SHIFT + MOD_ALT
    );
    expect(modsOf({ shiftKey: true, ctrlKey: true, altKey: true, metaKey: true })).toBe(
      MOD_SHIFT + MOD_CTRL + MOD_ALT + MOD_META
    );
  });

  it("normalizes deltaMode to pixels with 1 line = 40 px", () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: 53.3, deltaMode: 0 }, 600)).toEqual({
      dx: 0,
      dy: 53
    });
    expect(normalizeWheel({ deltaX: 1, deltaY: -3, deltaMode: 1 }, 600)).toEqual({
      dx: 40,
      dy: -120
    });
    expect(normalizeWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toEqual({ dx: 0, dy: 600 });
  });
});

describe("splitInputBatches", () => {
  const move = (i: number): TInputEvent => ({ t: "move", x: i, y: i, buttons: 0, ts: i });

  it("keeps every payload within the limit and preserves order", () => {
    const events = Array.from({ length: 5000 }, (_, i) => move(i));
    const payloads = splitInputBatches(events);
    expect(payloads.length).toBeGreaterThan(1);
    payloads.forEach((p) => expect(p.length).toBeLessThanOrEqual(MAX_UPSTREAM_PAYLOAD));
    const decoded = payloads.flatMap(
      (p) => (JSON.parse(new TextDecoder().decode(p)) as { events: TInputEvent[] }).events
    );
    expect(decoded).toEqual(events);
  });

  it("fills a batch exactly up to the limit", () => {
    const one = new TextEncoder().encode(JSON.stringify({ events: [move(1)] })).length;
    const payloads = splitInputBatches([move(1), move(1)], one);
    expect(payloads).toHaveLength(2);
  });

  it("rejects a single event larger than the limit", () => {
    const huge: TInputEvent = { t: "ime", text: "x".repeat(MAX_UPSTREAM_PAYLOAD), ts: 0 };
    expect(() => splitInputBatches([huge])).toThrow();
  });
});

describe("InputBatcher", () => {
  const setup = () => {
    let now = 0;
    let pending: (() => void) | null = null;
    const send = vi.fn();
    const batcher = new InputBatcher(send, {
      now: () => now,
      requestFrame: (fn) => {
        pending = fn;
        return 1;
      },
      cancelFrame: () => {
        pending = null;
      }
    });
    const frame = (advance = 16.7) => {
      now += advance;
      const fn = pending;
      pending = null;
      fn?.();
    };
    return { batcher, send, frame };
  };
  const move = (x: number): TInputEvent => ({ t: "move", x, y: 0, buttons: 0, ts: x });
  const click: TInputEvent = { t: "button", action: "down", button: 0, x: 1, y: 1, mods: 0, ts: 0 };

  it("coalesces consecutive moves to the latest and flushes once per frame", () => {
    const { batcher, send, frame } = setup();
    batcher.push(move(1));
    batcher.push(move(2));
    batcher.push(move(3));
    frame();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([move(3)]);
  });

  it("keeps order when a button follows a move", () => {
    const { batcher, send, frame } = setup();
    batcher.push(move(1));
    batcher.push(click);
    batcher.push(move(2));
    frame();
    expect(send).toHaveBeenCalledWith([move(1), click, move(2)]);
  });

  it("sends moves at most 60 times per second", () => {
    const { batcher, send, frame } = setup();
    batcher.push(move(1));
    frame();
    batcher.push(move(2));
    frame(MIN_MOVE_INTERVAL_MS / 2);
    expect(send).toHaveBeenCalledTimes(1);
    frame(MIN_MOVE_INTERVAL_MS / 2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith([move(2)]);
  });

  it("clear drops queued events", () => {
    const { batcher, send, frame } = setup();
    batcher.push(click);
    batcher.clear();
    frame();
    expect(send).not.toHaveBeenCalled();
  });
});
