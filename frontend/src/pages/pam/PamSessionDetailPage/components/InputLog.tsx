import { KeyboardIcon, KeyRoundIcon, MousePointerClickIcon, PaperclipIcon } from "lucide-react";

import { Badge } from "@app/components/v3";
import { cn } from "@app/components/v3/utils";
import { formatSessionTime, rowIndexAt, TInputRow } from "@app/hooks/api/pam/web-app-replay";

import { VirtualRowList } from "./VirtualRowList";

const ICONS: Partial<Record<TInputRow["kind"], typeof KeyboardIcon>> = {
  keys: KeyboardIcon,
  paste: PaperclipIcon,
  click: MousePointerClickIcon,
  credential: KeyRoundIcon
};

type Props = {
  rows: TInputRow[];
  playheadMs: number;
  autoFollow: boolean;
  onSeek: (sessionMs: number) => void;
};

export const InputLog = ({ rows, playheadMs, autoFollow, onSeek }: Props) => {
  const activeIndex = rowIndexAt(rows, playheadMs);
  if (rows.length === 0) {
    return <p className="p-3 text-sm text-muted">No input was recorded.</p>;
  }
  return (
    <div className="h-full min-h-0 rounded-md border border-border">
      <VirtualRowList
        rows={rows}
        activeIndex={activeIndex}
        autoFollow={autoFollow}
        estimateSize={32}
        getKey={(r) => r.id}
        ariaLabel="Input log"
        renderRow={(row, isActive) => {
          const Icon = ICONS[row.kind];
          return (
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-container-hover",
                isActive && "bg-container-hover"
              )}
              data-active={isActive || undefined}
              onClick={() => onSeek(row.sessionMs)}
            >
              <span className="w-12 shrink-0 font-mono text-muted tabular-nums">
                {formatSessionTime(row.sessionMs)}
              </span>
              {Icon ? (
                <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
              ) : (
                <span className="w-3.5" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{row.text}</span>
              {row.kind === "credential" && <Badge variant="info">credential injected</Badge>}
              {row.droppedCount > 0 && <Badge variant="warning">{row.droppedCount} blocked</Badge>}
            </button>
          );
        }}
      />
    </div>
  );
};
