import { FastForwardIcon, PauseIcon, PlayIcon } from "lucide-react";

import { Button } from "@app/components/v3";
import { formatSessionTime } from "@app/hooks/api/pam/web-app-replay";

export const PLAYBACK_RATES = [0.5, 1, 2, 8] as const;

type Props = {
  isPlaying: boolean;
  currentMs: number;
  durationMs: number;
  rate: number;
  skipIdle: boolean;
  onToggle: () => void;
  onRateChange: (rate: number) => void;
  onSkipIdleChange: (skip: boolean) => void;
};

export const TransportBar = ({
  isPlaying,
  currentMs,
  durationMs,
  rate,
  skipIdle,
  onToggle,
  onRateChange,
  onSkipIdleChange
}: Props) => (
  <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Playback controls">
    <Button variant="outline" size="sm" onClick={onToggle} aria-keyshortcuts="Space">
      {isPlaying ? <PauseIcon /> : <PlayIcon />}
      {isPlaying ? "Pause" : "Play"}
    </Button>
    <span className="font-mono text-xs text-muted tabular-nums">
      {formatSessionTime(currentMs)} / {formatSessionTime(durationMs)}
    </span>
    <div className="ml-auto flex items-center gap-1" role="group" aria-label="Playback speed">
      {PLAYBACK_RATES.map((r) => (
        <Button
          key={r}
          size="xs"
          variant={rate === r ? "neutral" : "ghost"}
          aria-pressed={rate === r}
          onClick={() => onRateChange(r)}
        >
          {r}x
        </Button>
      ))}
      <Button
        size="xs"
        variant={skipIdle ? "neutral" : "ghost"}
        aria-pressed={skipIdle}
        onClick={() => onSkipIdleChange(!skipIdle)}
      >
        <FastForwardIcon />
        Skip idle
      </Button>
    </div>
  </div>
);
