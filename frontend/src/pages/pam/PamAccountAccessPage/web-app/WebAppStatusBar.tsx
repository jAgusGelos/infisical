import type { TViewerPhase } from "./session/types";

type Props = {
  phase: TViewerPhase;
  accountName: string;
  onEndSession: () => void;
};

const PHASE_STATUS: Record<TViewerPhase, { label: string; dotClassName: string }> = {
  connecting: { label: "Connecting", dotClassName: "bg-warning" },
  awaiting_ready: { label: "Connecting", dotClassName: "bg-warning" },
  live: { label: "Connected", dotClassName: "bg-success" },
  ending: { label: "Ending session", dotClassName: "bg-warning" },
  ended: { label: "Disconnected", dotClassName: "bg-muted" },
  disconnected: { label: "Disconnected", dotClassName: "bg-muted" },
  failed: { label: "Error", dotClassName: "bg-danger" }
};

export const WebAppStatusBar = ({ phase, accountName, onEndSession }: Props) => {
  const { label, dotClassName } = PHASE_STATUS[phase];
  return (
    <div className="flex h-[33px] shrink-0 items-center justify-between border-t border-border bg-card px-3 text-xs">
      <span className="flex items-center gap-1.5">
        <span className={`inline-block size-2 rounded-full ${dotClassName}`} />
        <span className="text-muted">{label}</span>
        {phase === "live" && (
          <button
            type="button"
            onClick={onEndSession}
            className="ml-2 text-muted hover:text-danger"
          >
            End session
          </button>
        )}
      </span>
      <span>
        <span className="text-muted">Account:</span>{" "}
        <span className="text-muted">{accountName}</span>
      </span>
    </div>
  );
};
