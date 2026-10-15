import { TWebAppVideoEntry, TWebAppVideoMediaEntry } from "./types";

// Video ms = position on the MSE timeline relative to the first media segment (CONTRACTS.md 6.10 startMs/endMs).
// Session ms = gateway monotonic clock (envelope monoElapsedUs). Media entries carry monoStartUs since contract v1.1;
// without it the two clocks are assumed equal.
type TSegmentSpan = { startMs: number; endMs: number; monoStartMs: number; monoEndMs: number };

export type TReplayClock = {
  segments: TSegmentSpan[];
  videoToSessionMs: (videoMs: number) => number;
  sessionToVideoMs: (sessionMs: number) => number;
  durationVideoMs: number;
};

export const createReplayClock = (entries: TWebAppVideoEntry[]): TReplayClock => {
  const segments: TSegmentSpan[] = entries
    .filter((e): e is TWebAppVideoMediaEntry => e.kind === "media")
    .sort((a, b) => a.startMs - b.startMs)
    .map((e) => {
      const monoStartMs = e.monoStartUs !== undefined ? e.monoStartUs / 1000 : e.startMs;
      const monoEndMs =
        e.monoEndUs !== undefined ? e.monoEndUs / 1000 : monoStartMs + (e.endMs - e.startMs);
      return { startMs: e.startMs, endMs: e.endMs, monoStartMs, monoEndMs };
    });

  const videoToSessionMs = (videoMs: number) => {
    if (segments.length === 0) return videoMs;
    const seg = [...segments].reverse().find((s) => s.startMs <= videoMs) ?? segments[0];
    return seg.monoStartMs + (videoMs - seg.startMs);
  };

  const sessionToVideoMs = (sessionMs: number) => {
    if (segments.length === 0) return Math.max(0, sessionMs);
    const inside = segments.find((s) => s.monoStartMs <= sessionMs && sessionMs < s.monoEndMs);
    if (inside) return inside.startMs + (sessionMs - inside.monoStartMs);
    const next = segments.find((s) => s.monoStartMs > sessionMs);
    if (next) return next.startMs;
    const last = segments[segments.length - 1];
    return last.endMs;
  };

  return {
    segments,
    videoToSessionMs,
    sessionToVideoMs,
    durationVideoMs: segments.length ? segments[segments.length - 1].endMs : 0
  };
};

export const formatSessionTime = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
