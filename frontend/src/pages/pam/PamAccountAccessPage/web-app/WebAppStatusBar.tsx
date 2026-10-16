import { useEffect, useState } from "react";

import type { TReconnectStatus } from "./session/ReconnectController";
import { formatTimeLeft, remainingSeconds } from "./session/timeLeft";
import type { TViewerPhase, TViewerState } from "./session/types";

type Props = {
  state: TViewerState;
  reconnectStatus: TReconnectStatus;
  accountName: string;
  onEndSession: () => void;
};

const PHASE_STATUS: Record<TViewerPhase, { label: string; dotClassName: string }> = {
  connecting: { label: "Connecting", dotClassName: "bg-warning" },
  awaiting_ready: { label: "Connecting", dotClassName: "bg-warning" },
  live: { label: "Connected", dotClassName: "bg-success" },
  ending: { label: "Ending session", dotClassName: "bg-warning" },
  ended: { label: "Session ended", dotClassName: "bg-muted" },
  disconnected: { label: "Disconnected", dotClassName: "bg-muted" },
  failed: { label: "Error", dotClassName: "bg-danger" }
};

const RECONNECTING_STATUS = { label: "Reconnecting", dotClassName: "bg-warning" };

const TICK_MS = 1000;
const LOW_TIME_SECONDS = 60;

const useTick = (active: boolean) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const interval = window.setInterval(() => setTick((tick) => tick + 1), TICK_MS);
    return () => window.clearInterval(interval);
  }, [active]);
};

export const WebAppStatusBar = ({ state, reconnectStatus, accountName, onEndSession }: Props) => {
  const isLive = state.phase === "live";
  const isActive = isLive || state.phase === "ending";
  useTick(isActive);

  const { label, dotClassName } =
    reconnectStatus === "waiting" ? RECONNECTING_STATUS : PHASE_STATUS[state.phase];
  const secondsLeft = isActive ? remainingSeconds(state, performance.now(), Date.now()) : undefined;

  return (
    <div className="flex h-[33px] shrink-0 items-center justify-between border-t border-border bg-card px-3 text-xs">
      <span className="flex items-center gap-1.5">
        <span className={`inline-block size-2 rounded-full ${dotClassName}`} />
        <span className="text-muted">{label}</span>
        {isLive && (
          <button
            type="button"
            onClick={onEndSession}
            className="ml-2 text-muted hover:text-danger"
          >
            End session
          </button>
        )}
      </span>
      <div className="flex items-center gap-4">
        {isActive && state.degraded && (
          <span
            className="rounded-sm border border-warning px-1.5 text-warning"
            title="The live view skipped frames to catch up. The recording is not affected."
          >
            Viewer degraded
          </span>
        )}
        {isActive && (
          <span className="flex items-center gap-1.5" title="This session is being recorded">
            <span className="inline-block size-2 animate-pulse rounded-full bg-danger" />
            <span className="text-muted">Recording</span>
          </span>
        )}
        {secondsLeft !== undefined && (
          <span>
            <span className="text-muted">Time left:</span>{" "}
            <span
              className={`font-mono ${secondsLeft <= LOW_TIME_SECONDS ? "text-warning" : "text-muted"}`}
            >
              {formatTimeLeft(secondsLeft)}
            </span>
          </span>
        )}
        <span>
          <span className="text-muted">Account:</span>{" "}
          <span className="text-muted">{accountName}</span>
        </span>
      </div>
    </div>
  );
};
