import { describe, expect, test } from "vitest";

import { neighbourTime, shortcutFor } from "./useReplayShortcuts";

const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
  ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: null,
    ...extra
  }) as KeyboardEvent;

describe("replay shortcuts", () => {
  test("maps Space, J/K and brackets", () => {
    expect(shortcutFor(key(" "))).toBe("togglePlay");
    expect(shortcutFor(key("j"))).toBe("previousRequest");
    expect(shortcutFor(key("K"))).toBe("nextRequest");
    expect(shortcutFor(key("["))).toBe("previousFlag");
    expect(shortcutFor(key("]"))).toBe("nextFlag");
    expect(shortcutFor(key("x"))).toBeNull();
  });

  test("is ignored while typing in a field", () => {
    expect(
      shortcutFor(key(" ", { target: { tagName: "INPUT" } as unknown as EventTarget }))
    ).toBeNull();
    expect(
      shortcutFor(
        key("k", { target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget })
      )
    ).toBeNull();
  });

  test("ignores modified keys", () => {
    expect(shortcutFor(key("k", { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key("j", { metaKey: true }))).toBeNull();
  });

  test("finds the previous and next item around the playhead", () => {
    const times = [1000, 5000, 9000];
    expect(neighbourTime(times, 5000, 1)).toBe(9000);
    expect(neighbourTime(times, 5000, -1)).toBe(1000);
    expect(neighbourTime(times, 9500, 1)).toBeNull();
  });
});
