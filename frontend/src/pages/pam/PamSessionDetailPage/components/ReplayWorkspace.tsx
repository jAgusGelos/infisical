import { useCallback, useMemo, useRef, useState } from "react";

import {
  TReplayClock,
  TReplayTimeline,
  TReplayVerificationReport,
  TWebAppReplay
} from "@app/hooks/api/pam/web-app-replay";

import { neighbourTime, useReplayShortcuts } from "../useReplayShortcuts";
import {
  addressUrlAt,
  buildNetworkLanes,
  buildVisualLanes,
  timelineEndMs
} from "../workspaceModel";
import { BrowserFrame } from "./BrowserFrame";
import { MseVideoPlayer, TMseVideoPlayerHandle } from "./MseVideoPlayer";
import { ReplaySidePanel } from "./ReplaySidePanel";
import { TransportBar } from "./TransportBar";
import { TwoLaneTimeline } from "./TwoLaneTimeline";

const IDLE_GAP_MS = 5000;
const IDLE_SKIP_LEAD_MS = 500;

type Props = {
  replay: TWebAppReplay;
  report: TReplayVerificationReport;
  timeline: TReplayTimeline;
  clock: TReplayClock;
  gatewayLabel: string;
  initialSessionMs?: number;
  onPlayheadChange: (sessionMs: number) => void;
  onPlayerError: (message: string) => void;
};

export const ReplayWorkspace = ({
  replay,
  report,
  timeline,
  clock,
  gatewayLabel,
  initialSessionMs,
  onPlayheadChange,
  onPlayerError
}: Props) => {
  const playerRef = useRef<TMseVideoPlayerHandle>(null);
  const [playheadMs, setPlayheadMs] = useState(clock.videoToSessionMs(0));
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [skipIdle, setSkipIdle] = useState(false);

  const seek = useCallback(
    (sessionMs: number) => {
      playerRef.current?.seek(clock.sessionToVideoMs(sessionMs));
      setPlayheadMs(sessionMs);
      onPlayheadChange(sessionMs);
    },
    [clock, onPlayheadChange]
  );

  const activityTimes = useMemo(
    () =>
      [
        ...timeline.l1Rows.map((r) => r.sessionMs),
        ...timeline.inputRows.map((r) => r.sessionMs)
      ].sort((a, b) => a - b),
    [timeline]
  );
  const requestTimes = useMemo(() => timeline.l1Rows.map((r) => r.sessionMs), [timeline]);
  const flagTimes = useMemo(() => timeline.flags.map((f) => f.fromMs), [timeline]);
  const visual = useMemo(() => buildVisualLanes(replay, report), [replay, report]);
  const network = useMemo(() => buildNetworkLanes(report, timeline), [report, timeline]);
  const addressUrl = useMemo(() => addressUrlAt(timeline, playheadMs), [timeline, playheadMs]);
  const endMs = timelineEndMs(timeline, clock);

  const onTimeUpdate = (videoMs: number) => {
    const sessionMs = clock.videoToSessionMs(videoMs);
    setPlayheadMs(sessionMs);
    onPlayheadChange(sessionMs);
    if (!skipIdle || !isPlaying) return;
    const next = activityTimes.find((t) => t > sessionMs);
    if (next !== undefined && next - sessionMs > IDLE_GAP_MS) seek(next - IDLE_SKIP_LEAD_MS);
  };

  const jump = (times: number[], dir: -1 | 1) => {
    const t = neighbourTime(times, playheadMs, dir);
    if (t !== null) seek(t);
  };

  useReplayShortcuts({
    togglePlay: () => playerRef.current?.toggle(),
    previousRequest: () => jump(requestTimes, -1),
    nextRequest: () => jump(requestTimes, 1),
    previousFlag: () => jump(flagTimes, -1),
    nextFlag: () => jump(flagTimes, 1)
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]">
        <div className="flex min-w-0 flex-col gap-3">
          <BrowserFrame url={addressUrl} gateway={gatewayLabel}>
            <MseVideoPlayer
              ref={playerRef}
              className="aspect-video w-full"
              mime={replay.video.mime}
              objects={report.verifiedVideo}
              onTimeUpdate={onTimeUpdate}
              onPlayingChange={setIsPlaying}
              onReady={() => {
                if (initialSessionMs !== undefined) seek(initialSessionMs);
              }}
              onError={onPlayerError}
            />
          </BrowserFrame>
          <TransportBar
            isPlaying={isPlaying}
            currentMs={playheadMs}
            durationMs={endMs}
            rate={rate}
            skipIdle={skipIdle}
            onToggle={() => playerRef.current?.toggle()}
            onRateChange={(r) => {
              setRate(r);
              playerRef.current?.setRate(r);
            }}
            onSkipIdleChange={setSkipIdle}
          />
        </div>
        <ReplaySidePanel timeline={timeline} playheadMs={playheadMs} onSeek={seek} />
      </div>
      <div className="rounded-md border border-border bg-card p-4">
        <TwoLaneTimeline
          startMs={0}
          endMs={endMs}
          playheadMs={playheadMs}
          visualCoverage={visual.coverage}
          networkCoverage={network.coverage}
          visualHoles={visual.holes}
          networkHoles={network.holes}
          inputPins={timeline.inputRows.map((r) => ({
            id: r.id,
            sessionMs: r.sessionMs,
            label: r.text
          }))}
          actionPins={timeline.actionPins}
          flags={timeline.flags}
          onSeek={seek}
        />
      </div>
    </div>
  );
};
