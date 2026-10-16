import { describe, expect, it } from "vitest";

import { formatTimeLeft, remainingSeconds } from "./timeLeft";

describe("remainingSeconds", () => {
  it("counts down from the last time_left on the monotonic clock", () => {
    const source = { secondsLeft: 120, timeLeftAt: 10_000, expiresAt: "2000-01-01T00:00:00Z" };
    expect(remainingSeconds(source, 10_000, 0)).toBe(120);
    expect(remainingSeconds(source, 40_400, 0)).toBe(90);
    expect(remainingSeconds(source, 500_000, 0)).toBe(0);
  });

  it("falls back to expiresAt before the first time_left", () => {
    const now = Date.parse("2026-10-15T18:00:00Z");
    expect(remainingSeconds({ expiresAt: "2026-10-15T18:59:30Z" }, 0, now)).toBe(3570);
    expect(remainingSeconds({ expiresAt: "2026-10-15T17:00:00Z" }, 0, now)).toBe(0);
  });

  it("is undefined without any source", () => {
    expect(remainingSeconds({}, 0, 0)).toBeUndefined();
    expect(remainingSeconds({ expiresAt: "not a date" }, 0, 0)).toBeUndefined();
  });
});

describe("formatTimeLeft", () => {
  it("formats minutes and hours", () => {
    expect(formatTimeLeft(0)).toBe("0:00");
    expect(formatTimeLeft(59)).toBe("0:59");
    expect(formatTimeLeft(605)).toBe("10:05");
    expect(formatTimeLeft(3600)).toBe("1:00:00");
    expect(formatTimeLeft(3725)).toBe("1:02:05");
  });
});
