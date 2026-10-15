import { describe, expect, test } from "vitest";

import { TVerifiedVideoObject } from "@app/hooks/api/pam/web-app-replay";

import {
  appendVerifiedObjects,
  nextBufferedStart,
  orderForAppend,
  TSourceBufferLike
} from "./msePlayer";

const obj = (objectIndex: number, kind: "init" | "media", initIndex: number) =>
  ({
    objectIndex,
    kind,
    initIndex,
    bytes: new Uint8Array([objectIndex])
  }) as unknown as TVerifiedVideoObject;

class FakeSourceBuffer {
  updating = false;

  appended: number[] = [];

  failOn: number | null = null;

  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }

  appendBuffer(data: BufferSource) {
    if (this.updating) throw new Error("InvalidStateError: append while updating");
    this.updating = true;
    const id = (data as Uint8Array)[0];
    setTimeout(() => {
      this.updating = false;
      if (id === this.failOn) {
        this.listeners.get("error")?.forEach((fn) => fn());
        return;
      }
      this.appended.push(id);
      this.listeners.get("updateend")?.forEach((fn) => fn());
    }, 1);
  }
}

describe("MSE append queue", () => {
  test("orders by objectIndex and puts each init before its segments", () => {
    const ordered = orderForAppend([
      obj(3, "media", 0),
      obj(5, "media", 4),
      obj(0, "init", 0),
      obj(1, "media", 0),
      obj(4, "init", 4)
    ]);
    expect(ordered.map((o) => o.objectIndex)).toEqual([0, 1, 3, 4, 5]);
  });

  test("drops segments whose init was not verified", () => {
    expect(orderForAppend([obj(1, "media", 0), obj(2, "media", 0)])).toEqual([]);
  });

  test("appends one object at a time, waiting for updateend", async () => {
    const sb = new FakeSourceBuffer();
    await appendVerifiedObjects(sb as unknown as TSourceBufferLike, [
      obj(2, "media", 0),
      obj(0, "init", 0),
      obj(1, "media", 0)
    ]);
    expect(sb.appended).toEqual([0, 1, 2]);
  });

  test("a hole in the listed objects never blocks later segments", async () => {
    const sb = new FakeSourceBuffer();
    await appendVerifiedObjects(sb as unknown as TSourceBufferLike, [
      obj(0, "init", 0),
      obj(1, "media", 0),
      obj(3, "media", 0)
    ]);
    expect(sb.appended).toEqual([0, 1, 3]);
  });

  test("a decode error rejects and stops the queue", async () => {
    const sb = new FakeSourceBuffer();
    sb.failOn = 2;
    await expect(
      appendVerifiedObjects(sb as unknown as TSourceBufferLike, [
        obj(0, "init", 0),
        obj(1, "media", 0),
        obj(2, "media", 0),
        obj(3, "media", 0)
      ])
    ).rejects.toThrow("could not decode");
    expect(sb.appended).toEqual([0, 1]);
  });

  test("finds the next buffered range after a hole", () => {
    const ranges = {
      length: 2,
      start: (i: number) => [0, 20][i],
      end: (i: number) => [10, 30][i]
    } as TimeRanges;
    expect(nextBufferedStart(ranges, 10)).toBe(20);
    expect(nextBufferedStart(ranges, 25)).toBeNull();
  });
});
