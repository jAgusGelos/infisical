import { describe, expect, it } from "vitest";

import { MAX_UPSTREAM_PAYLOAD } from "@app/lib/pam-web-app/contract";

import { splitInputBatches } from "./InputBatcher";
import { buildImeEvent, buildPasteEvents, isPasteAllowed, MAX_PASTE_BYTES } from "./textInput";

const ID = "6f1c2a7e-0000-4000-8000-000000000000";

describe("buildImeEvent", () => {
  it("sends the committed composition in NFC", () => {
    expect(buildImeEvent("é", 5)).toEqual({ t: "ime", text: "é", ts: 5 });
    expect(buildImeEvent("日本語", 1)).toEqual({ t: "ime", text: "日本語", ts: 1 });
  });

  it("ignores an empty composition", () => {
    expect(buildImeEvent("", 1)).toBeNull();
  });
});

describe("isPasteAllowed", () => {
  it("is off unless the policy allows clipboard to the remote", () => {
    expect(isPasteAllowed(undefined)).toBe(false);
    expect(isPasteAllowed({ clipboard: "off", downloads: "block", uploads: "block" })).toBe(false);
    expect(isPasteAllowed({ clipboard: "from_remote", downloads: "block", uploads: "block" })).toBe(
      false
    );
    expect(isPasteAllowed({ clipboard: "to_remote", downloads: "block", uploads: "block" })).toBe(
      true
    );
    expect(isPasteAllowed({ clipboard: "both", downloads: "block", uploads: "block" })).toBe(true);
  });
});

describe("buildPasteEvents", () => {
  const assemble = (events: Exclude<ReturnType<typeof buildPasteEvents>, "too_large">) =>
    events.map((e) => e.text).join("");

  it("keeps a short paste in one part", () => {
    expect(buildPasteEvents("hello", ID, 3)).toEqual([
      { t: "paste", id: ID, part: 0, total: 1, text: "hello", ts: 3 }
    ]);
    expect(buildPasteEvents("", ID, 3)).toEqual([]);
  });

  it("splits a 1 MiB paste into parts under the payload limit with one id and the right total", () => {
    const text = "a".repeat(MAX_PASTE_BYTES);
    const events = buildPasteEvents(text, ID, 0);
    if (events === "too_large") throw new Error("unexpected");
    expect(events.length).toBeGreaterThan(1);
    events.forEach((event, index) => {
      expect(event).toMatchObject({ id: ID, part: index, total: events.length });
      splitInputBatches([event]).forEach((payload) =>
        expect(payload.length).toBeLessThanOrEqual(MAX_UPSTREAM_PAYLOAD)
      );
    });
    expect(assemble(events)).toBe(text);
  });

  it("handles text that escapes heavily in JSON and surrogate pairs", () => {
    const text = `${"\u0001".repeat(40_000)}${"😀".repeat(20_000)}`;
    const events = buildPasteEvents(text, ID, 0);
    if (events === "too_large") throw new Error("unexpected");
    events.forEach((event) => {
      expect(splitInputBatches([event])).toHaveLength(1);
      expect(event.text).not.toMatch(/[\ud800-\udbff]$/);
    });
    expect(assemble(events)).toBe(text);
  });

  it("refuses more than 1 MiB", () => {
    expect(buildPasteEvents("a".repeat(MAX_PASTE_BYTES + 1), ID, 0)).toBe("too_large");
  });
});
