import {
  isMediaEntry,
  mediaSessionSpan,
  rowIndexAt,
  TObjectResult,
  TReplayClock,
  TReplayTimeline,
  TReplayVerificationReport,
  TVerifiedEventChunk,
  TWebAppReplay
} from "@app/hooks/api/pam/web-app-replay";

import { TTimelineHole, TTimelineSpan } from "./components/TwoLaneTimeline";

type TLanes = { coverage: TTimelineSpan[]; holes: TTimelineHole[] };

type TChunkSpan = TTimelineSpan & { objectIndex: number };

const holeLabel = (what: string, objectIndex: number, status?: TObjectResult["status"]) =>
  status === "tampered"
    ? `${what} ${objectIndex} refused (tampered)`
    : `${what} ${objectIndex} missing`;

export const buildVisualLanes = (
  replay: TWebAppReplay,
  report: TReplayVerificationReport
): TLanes => {
  const status = new Map(report.video.map((v) => [v.objectIndex, v.status]));
  const lanes: TLanes = { coverage: [], holes: [] };
  replay.video.objects.filter(isMediaEntry).forEach((entry) => {
    const span = mediaSessionSpan(entry);
    const objectStatus = status.get(entry.objectIndex);
    if (objectStatus === "verified") lanes.coverage.push(span);
    else
      lanes.holes.push({
        ...span,
        label: holeLabel("Video segment", entry.objectIndex, objectStatus)
      });
  });
  return lanes;
};

const chunkSpan = (chunk: TVerifiedEventChunk): TChunkSpan => ({
  objectIndex: chunk.objectIndex,
  fromMs: Number(chunk.envelopes[0]?.monoElapsedUs ?? 0n) / 1000,
  toMs: Number(chunk.envelopes[chunk.envelopes.length - 1]?.monoElapsedUs ?? 0n) / 1000
});

// Adjacent chunks cover the time between them: the chain links them with no missing event.
const joinAdjacent = (span: TChunkSpan, i: number, all: TChunkSpan[]): TChunkSpan =>
  i > 0 && all[i - 1].objectIndex === span.objectIndex - 1
    ? { ...span, fromMs: all[i - 1].toMs }
    : span;

const eventChunkHole =
  (spans: TChunkSpan[], lastEventMs: number) =>
  (result: TObjectResult): TTimelineHole => {
    const before = [...spans].reverse().find((s) => s.objectIndex < result.objectIndex);
    const after = spans.find((s) => s.objectIndex > result.objectIndex);
    return {
      fromMs: before?.toMs ?? 0,
      toMs: after?.fromMs ?? lastEventMs,
      label: holeLabel("Event chunk", result.objectIndex, result.status)
    };
  };

export const buildNetworkLanes = (
  report: TReplayVerificationReport,
  timeline: TReplayTimeline
): TLanes => {
  const spans = report.verifiedChunks
    .map(chunkSpan)
    .sort((a, b) => a.objectIndex - b.objectIndex)
    .map(joinAdjacent);
  const holes = report.events
    .filter((e) => e.status !== "verified")
    .map(eventChunkHole(spans, timeline.lastEventMs));
  return { coverage: spans, holes };
};

export const addressUrlAt = (timeline: TReplayTimeline, playheadMs: number) => {
  const navigations = timeline.l1Rows.filter(
    (r) => r.action === "navigation" || r.action === "form_submit"
  );
  const idx = rowIndexAt(navigations, playheadMs);
  return idx >= 0 ? navigations[idx].url : (timeline.sessionOpen?.startUrl ?? null);
};

export const timelineEndMs = (timeline: TReplayTimeline, clock: TReplayClock) =>
  Math.max(
    timeline.lastEventMs,
    clock.segments.length ? clock.segments[clock.segments.length - 1].monoEndMs : 0,
    1
  );
