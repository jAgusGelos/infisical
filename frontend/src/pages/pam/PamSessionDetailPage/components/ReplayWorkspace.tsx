import { useCallback, useMemo, useRef, useState } from "react";

import { Label, Tabs, TabsContent, TabsList, TabsTrigger, Toggle } from "@app/components/v3";
import {
  rowIndexAt,
  TReplayClock,
  TReplayTimeline,
  TReplayVerificationReport,
  TWebAppReplay
} from "@app/hooks/api/pam/web-app-replay";

import { neighbourTime, useReplayShortcuts } from "../useReplayShortcuts";
import { BrowserFrame } from "./BrowserFrame";
import { GatewayHttpLog } from "./GatewayHttpLog";
import { InputLog } from "./InputLog";
import { MseVideoPlayer, TMseVideoPlayerHandle } from "./MseVideoPlayer";
import { TransportBar } from "./TransportBar";
import { TTimelineHole, TTimelineSpan, TwoLaneTimeline } from "./TwoLaneTimeline";

const IDLE_GAP_MS = 5000;

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
  const [autoFollow, setAutoFollow] = useState(true);

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

  const onTimeUpdate = (videoMs: number) => {
    const sessionMs = clock.videoToSessionMs(videoMs);
    setPlayheadMs(sessionMs);
    onPlayheadChange(sessionMs);
    if (!skipIdle || !isPlaying) return;
    const next = activityTimes.find((t) => t > sessionMs);
    if (next !== undefined && next - sessionMs > IDLE_GAP_MS) seek(next - 500);
  };

  const jump = (times: number[], dir: -1 | 1) => {
    const t = neighbourTime(times, playheadMs, dir);
    if (t !== null) seek(t);
  };

  useReplayShortcuts(
    {
      togglePlay: () => playerRef.current?.toggle(),
      previousRequest: () => jump(requestTimes, -1),
      nextRequest: () => jump(requestTimes, 1),
      previousFlag: () => jump(flagTimes, -1),
      nextFlag: () => jump(flagTimes, 1)
    },
    true
  );

  const addressUrl = useMemo(() => {
    const navs = timeline.l1Rows.filter(
      (r) => r.action === "navigation" || r.action === "form_submit"
    );
    const idx = rowIndexAt(navs, playheadMs);
    return idx >= 0 ? navs[idx].url : (timeline.sessionOpen?.startUrl ?? null);
  }, [timeline, playheadMs]);

  const { visualCoverage, visualHoles } = useMemo(() => {
    const status = new Map(report.video.map((v) => [v.objectIndex, v.status]));
    const coverage: TTimelineSpan[] = [];
    const holes: TTimelineHole[] = [];
    replay.video.objects.forEach((entry) => {
      if (entry.kind !== "media") return;
      const fromMs = entry.monoStartUs !== undefined ? entry.monoStartUs / 1000 : entry.startMs;
      const toMs =
        entry.monoEndUs !== undefined
          ? entry.monoEndUs / 1000
          : fromMs + entry.endMs - entry.startMs;
      const s = status.get(entry.objectIndex);
      if (s === "verified") coverage.push({ fromMs, toMs });
      else {
        holes.push({
          fromMs,
          toMs,
          label:
            s === "tampered"
              ? `Video segment ${entry.objectIndex} refused (tampered)`
              : `Video segment ${entry.objectIndex} missing`
        });
      }
    });
    return { visualCoverage: coverage, visualHoles: holes };
  }, [replay, report]);

  const { networkCoverage, networkHoles } = useMemo(() => {
    const spans = report.verifiedChunks
      .map((c) => ({
        objectIndex: c.objectIndex,
        fromMs: Number(c.envelopes[0]?.monoElapsedUs ?? 0n) / 1000,
        toMs: Number(c.envelopes[c.envelopes.length - 1]?.monoElapsedUs ?? 0n) / 1000
      }))
      .sort((a, b) => a.objectIndex - b.objectIndex)
      // Adjacent chunks cover the time between them: the chain links them with no missing event.
      .map((span, i, all) =>
        i > 0 && all[i - 1].objectIndex === span.objectIndex - 1
          ? { ...span, fromMs: all[i - 1].toMs }
          : span
      );
    const holes: TTimelineHole[] = [];
    report.events
      .filter((e) => e.status !== "verified")
      .forEach((e) => {
        const before = [...spans].reverse().find((s) => s.objectIndex < e.objectIndex);
        const after = spans.find((s) => s.objectIndex > e.objectIndex);
        holes.push({
          fromMs: before?.toMs ?? 0,
          toMs: after?.fromMs ?? timeline.lastEventMs,
          label:
            e.status === "tampered"
              ? `Event chunk ${e.objectIndex} refused (tampered)`
              : `Event chunk ${e.objectIndex} missing`
        });
      });
    return { networkCoverage: spans, networkHoles: holes };
  }, [report, timeline]);

  const startMs = 0;
  const endMs = Math.max(
    timeline.lastEventMs,
    clock.segments.length ? clock.segments[clock.segments.length - 1].monoEndMs : 0,
    1
  );

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
        <Tabs defaultValue="network" className="flex min-h-[28rem] flex-col lg:h-[calc(100%)]">
          <TabsList variant="pam">
            <TabsTrigger value="network">Network ({timeline.l1Rows.length})</TabsTrigger>
            <TabsTrigger value="input">Input ({timeline.inputRows.length})</TabsTrigger>
          </TabsList>
          <div className="flex items-center justify-end gap-2 py-2">
            <Toggle
              id="auto-follow"
              size="sm"
              checked={autoFollow}
              onCheckedChange={setAutoFollow}
            />
            <Label htmlFor="auto-follow">Auto-follow playhead</Label>
          </div>
          <TabsContent value="network" className="min-h-0 flex-1">
            <GatewayHttpLog
              rows={timeline.l1Rows}
              playheadMs={playheadMs}
              autoFollow={autoFollow}
              onSeek={seek}
            />
          </TabsContent>
          <TabsContent value="input" className="min-h-0 flex-1">
            <InputLog
              rows={timeline.inputRows}
              playheadMs={playheadMs}
              autoFollow={autoFollow}
              onSeek={seek}
            />
          </TabsContent>
        </Tabs>
      </div>
      <div className="rounded-md border border-border bg-card p-4">
        <TwoLaneTimeline
          startMs={startMs}
          endMs={endMs}
          playheadMs={playheadMs}
          visualCoverage={visualCoverage}
          networkCoverage={networkCoverage}
          visualHoles={visualHoles}
          networkHoles={networkHoles}
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
