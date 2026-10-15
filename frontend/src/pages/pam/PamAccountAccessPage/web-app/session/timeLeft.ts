import type { TViewerState } from "./types";

type TTimeSource = Pick<TViewerState, "secondsLeft" | "timeLeftAt" | "expiresAt">;

// Prefers the last `time_left` (monotonic, immune to a skewed local clock) over `expiresAt`.
export const remainingSeconds = (
  { secondsLeft, timeLeftAt, expiresAt }: TTimeSource,
  nowMonotonicMs: number,
  nowWallMs: number
): number | undefined => {
  if (secondsLeft !== undefined && timeLeftAt !== undefined) {
    return Math.max(0, Math.round(secondsLeft - (nowMonotonicMs - timeLeftAt) / 1000));
  }
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isNaN(expiresAtMs)) return undefined;
  return Math.max(0, Math.round((expiresAtMs - nowWallMs) / 1000));
};

const pad = (value: number) => String(value).padStart(2, "0");

export const formatTimeLeft = (totalSeconds: number) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};
