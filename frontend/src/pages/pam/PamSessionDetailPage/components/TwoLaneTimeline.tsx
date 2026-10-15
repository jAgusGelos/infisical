import { KeyboardEvent, MouseEvent, useId } from "react";

import { formatSessionTime, TActionPin, TFlag } from "@app/hooks/api/pam/web-app-replay";

export type TTimelineSpan = { fromMs: number; toMs: number };

export type TTimelineHole = TTimelineSpan & { label: string };

type Props = {
  startMs: number;
  endMs: number;
  playheadMs: number;
  visualCoverage: TTimelineSpan[];
  networkCoverage: TTimelineSpan[];
  visualHoles: TTimelineHole[];
  networkHoles: TTimelineHole[];
  inputPins: { id: string; sessionMs: number; label: string }[];
  actionPins: TActionPin[];
  flags: TFlag[];
  onSeek: (sessionMs: number) => void;
};

const WIDTH = 1000;
const LANE1_Y = 22;
const LANE2_Y = 70;
const LANE_H = 24;
const HEIGHT = 104;
const KEY_STEP_MS = 5000;
const KEY_BIG_STEP_MS = 30000;

const FLAG_CLASS: Record<TFlag["kind"], string> = {
  loss: "text-warning",
  continuity_unknown: "text-warning",
  viewer_degraded: "text-muted",
  blocked: "text-danger"
};

export const describeFlaggedZones = (flags: TFlag[], holes: TTimelineHole[]) => {
  const parts = [
    ...flags.map((f) =>
      f.fromMs === f.toMs
        ? `${f.label} at ${formatSessionTime(f.fromMs)}`
        : `${f.label} from ${formatSessionTime(f.fromMs)} to ${formatSessionTime(f.toMs)}`
    ),
    ...holes.map(
      (h) => `${h.label} from ${formatSessionTime(h.fromMs)} to ${formatSessionTime(h.toMs)}`
    )
  ];
  return parts.length ? `Flagged zones: ${parts.join("; ")}.` : "No flagged zones.";
};

export const msFromPointer = (
  clientX: number,
  rect: { left: number; width: number },
  startMs: number,
  endMs: number
) => {
  const ratio = Math.min(Math.max((clientX - rect.left) / Math.max(rect.width, 1), 0), 1);
  return startMs + ratio * (endMs - startMs);
};

type TScale = {
  x: (ms: number) => number;
  w: (fromMs: number, toMs: number) => number;
};

const CoverageRects = ({
  spans,
  y,
  scale
}: {
  spans: TTimelineSpan[];
  y: number;
  scale: TScale;
}) => (
  <>
    {spans.map((c) => (
      <rect
        key={`${y}-${c.fromMs}-${c.toMs}`}
        x={scale.x(c.fromMs)}
        y={y}
        width={scale.w(c.fromMs, c.toMs)}
        height={LANE_H}
        className="fill-foreground/15"
      />
    ))}
  </>
);

const HoleRect = ({
  hole,
  y,
  scale,
  onClick
}: {
  hole: TTimelineHole;
  y: number;
  scale: TScale;
  onClick: (e: MouseEvent) => void;
}) => (
  <rect
    x={scale.x(hole.fromMs)}
    y={y}
    width={scale.w(hole.fromMs, hole.toMs)}
    height={LANE_H}
    className="fill-page stroke-danger"
    strokeDasharray="4 3"
    data-testid="timeline-hole"
    onClick={onClick}
  >
    <title>{hole.label}</title>
  </rect>
);

const IntervalFlagMark = ({
  flag,
  hatchId,
  scale,
  onClick
}: {
  flag: TFlag;
  hatchId: string;
  scale: TScale;
  onClick: (e: MouseEvent) => void;
}) => (
  <g className={FLAG_CLASS[flag.kind]} onClick={onClick} data-testid={`timeline-flag-${flag.kind}`}>
    <title>{flag.label}</title>
    {flag.kind === "viewer_degraded" ? (
      <rect
        x={scale.x(flag.fromMs)}
        y={LANE1_Y + LANE_H - 4}
        width={scale.w(flag.fromMs, flag.toMs)}
        height={4}
        className="fill-current opacity-60"
      />
    ) : (
      <rect
        x={scale.x(flag.fromMs)}
        y={LANE1_Y}
        width={scale.w(flag.fromMs, flag.toMs)}
        height={LANE2_Y + LANE_H - LANE1_Y}
        fill={`url(#${hatchId})`}
        opacity={0.7}
      />
    )}
  </g>
);

export const TwoLaneTimeline = ({
  startMs,
  endMs,
  playheadMs,
  visualCoverage,
  networkCoverage,
  visualHoles,
  networkHoles,
  inputPins,
  actionPins,
  flags,
  onSeek
}: Props) => {
  const hatchId = `${useId()}-hatch`;
  const span = Math.max(1, endMs - startMs);
  const clamp = (ms: number) => Math.min(Math.max(ms, startMs), endMs);
  const x = (ms: number) => ((clamp(ms) - startMs) / span) * WIDTH;
  const scale: TScale = { x, w: (from, to) => Math.max(2, x(to) - x(from)) };

  const seekFromEvent = (e: MouseEvent<SVGSVGElement>) => {
    onSeek(msFromPointer(e.clientX, e.currentTarget.getBoundingClientRect(), startMs, endMs));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_BIG_STEP_MS : KEY_STEP_MS;
    const map: Record<string, number> = {
      ArrowLeft: playheadMs - step,
      ArrowRight: playheadMs + step,
      Home: startMs,
      End: endMs
    };
    if (e.key in map) {
      e.preventDefault();
      onSeek(clamp(map[e.key]));
    }
  };

  const pinHandler = (ms: number) => (e: MouseEvent) => {
    e.stopPropagation();
    onSeek(clamp(ms));
  };

  const intervalFlags = flags.filter((f) => f.kind !== "blocked");
  const pointFlags = flags.filter((f) => f.kind === "blocked");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between text-xs text-muted">
        <span>{formatSessionTime(startMs)}</span>
        <span>{formatSessionTime(endMs)}</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Session timeline"
        aria-valuemin={Math.round(startMs / 1000)}
        aria-valuemax={Math.round(endMs / 1000)}
        aria-valuenow={Math.round(playheadMs / 1000)}
        aria-valuetext={formatSessionTime(playheadMs)}
        aria-describedby={`${hatchId}-summary`}
        onKeyDown={onKeyDown}
        className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="h-28 w-full cursor-pointer"
          onClick={seekFromEvent}
          aria-hidden
          data-testid="two-lane-timeline"
        >
          <defs>
            <pattern
              className="text-warning"
              id={hatchId}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="2" />
            </pattern>
          </defs>
          <text x={4} y={LANE1_Y - 6} className="fill-muted text-[9px]">
            Visual (isolated browser)
          </text>
          <text x={4} y={LANE2_Y - 6} className="fill-muted text-[9px]">
            Network (gateway)
          </text>
          {[LANE1_Y, LANE2_Y].map((y) => (
            <rect key={y} x={0} y={y} width={WIDTH} height={LANE_H} className="fill-container" />
          ))}
          <CoverageRects spans={visualCoverage} y={LANE1_Y} scale={scale} />
          <CoverageRects spans={networkCoverage} y={LANE2_Y} scale={scale} />
          {visualHoles.map((h) => (
            <HoleRect
              key={`hole-v-${h.label}`}
              hole={h}
              y={LANE1_Y}
              scale={scale}
              onClick={pinHandler(h.fromMs)}
            />
          ))}
          {networkHoles.map((h) => (
            <HoleRect
              key={`hole-n-${h.label}`}
              hole={h}
              y={LANE2_Y}
              scale={scale}
              onClick={pinHandler(h.fromMs)}
            />
          ))}
          {intervalFlags.map((f) => (
            <IntervalFlagMark
              key={f.id}
              flag={f}
              hatchId={hatchId}
              scale={scale}
              onClick={pinHandler(f.fromMs)}
            />
          ))}
          {inputPins.map((p) => (
            <rect
              key={p.id}
              x={x(p.sessionMs) - 1}
              y={LANE1_Y + 4}
              width={2}
              height={LANE_H - 8}
              className="fill-info"
              onClick={pinHandler(p.sessionMs)}
            >
              <title>{p.label}</title>
            </rect>
          ))}
          {actionPins.map((p) => (
            <circle
              key={p.id}
              cx={x(p.sessionMs)}
              cy={LANE2_Y + LANE_H / 2}
              r={4}
              className="fill-foreground"
              onClick={pinHandler(p.sessionMs)}
            >
              <title>{p.label}</title>
            </circle>
          ))}
          {pointFlags.map((f) => (
            <g
              key={f.id}
              onClick={pinHandler(f.fromMs)}
              className="text-danger"
              data-testid="timeline-flag-blocked"
            >
              <title>{f.label}</title>
              <rect
                x={x(f.fromMs) - 1.5}
                y={LANE2_Y - 2}
                width={3}
                height={LANE_H + 4}
                className="fill-current"
              />
            </g>
          ))}
          <line
            x1={x(playheadMs)}
            x2={x(playheadMs)}
            y1={4}
            y2={HEIGHT - 2}
            className="stroke-foreground"
            strokeWidth={2}
          />
        </svg>
      </div>
      <p id={`${hatchId}-summary`} className="sr-only" data-testid="timeline-summary">
        {describeFlaggedZones(flags, [...visualHoles, ...networkHoles])}
      </p>
    </div>
  );
};
