import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { TFlag, TL1Row } from "@app/hooks/api/pam/web-app-replay";

import { BROWSER_FRAME_CAPTION, BrowserFrame } from "./BrowserFrame";
import { GatewayHttpLog } from "./GatewayHttpLog";
import {
  EXPORT_EVIDENCE_UNAVAILABLE,
  MARK_REVIEWED_UNAVAILABLE,
  ReplayHeader
} from "./ReplayHeader";
import { describeFlaggedZones, msFromPointer, TwoLaneTimeline } from "./TwoLaneTimeline";

// Radix keeps tooltip content unmounted until it opens, which static markup never does.
vi.mock("@app/components/v3", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Tooltip: ({ children }: { children: ReactNode }) => children,
    TooltipTrigger: ({ children }: { children: ReactNode }) => children,
    TooltipContent: ({ children }: { children: ReactNode }) =>
      createElement("div", { "data-slot": "tooltip-content" }, children)
  };
});

vi.mock("@app/components/v3/platform", () => ({
  PageHeader: ({
    title,
    description,
    children
  }: {
    title: ReactNode;
    description: ReactNode;
    children: ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      {description}
      {children}
    </header>
  )
}));

const row = (over: Partial<TL1Row>): TL1Row => ({
  id: "r",
  seq: 0,
  sessionMs: 0,
  kind: "request",
  method: "GET",
  url: "https://app/",
  status: 200,
  durationMs: 1,
  requestHeaders: [],
  responseHeaders: [],
  requestBody: "",
  responseBody: "",
  requestBodyBytes: 0,
  responseBodyBytes: 0,
  truncated: false,
  action: null,
  isWrite: false,
  blockedReason: null,
  ...over
});

const flags: TFlag[] = [
  {
    id: "l",
    kind: "loss",
    fromMs: 10000,
    toMs: 20000,
    label: "Incomplete (gateway-reported loss): L1"
  },
  {
    id: "v",
    kind: "viewer_degraded",
    fromMs: 30000,
    toMs: 35000,
    label: "Viewer degraded (the recording is unaffected)"
  },
  { id: "b", kind: "blocked", fromMs: 40000, toMs: 40000, label: "Blocked: evil.example:443" }
];

describe("replay page components", () => {
  test("header renders both unavailable actions disabled with their tooltips", () => {
    const html = renderToStaticMarkup(
      <ReplayHeader
        title="corp-admin"
        integrity={{ label: "Verified · anchor pending", variant: "success" }}
        copyLinkLabel="Copy link at 00:12"
        onCopyLink={() => undefined}
      />
    );
    expect(html).toContain(EXPORT_EVIDENCE_UNAVAILABLE);
    expect(html).toContain(MARK_REVIEWED_UNAVAILABLE);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Verified · anchor pending");
  });

  test("browser frame shows the URL, the gateway and the caption", () => {
    const html = renderToStaticMarkup(
      <BrowserFrame url="https://app/login" gateway="gateway 1234">
        <div />
      </BrowserFrame>
    );
    expect(html).toContain("https://app/login");
    expect(html).toContain("via gateway 1234");
    expect(html).toContain(BROWSER_FRAME_CAPTION.replace("'", "&#x27;"));
  });

  test("timeline renders a hole, a hatched loss interval and a muted degraded flag", () => {
    const html = renderToStaticMarkup(
      <TwoLaneTimeline
        startMs={0}
        endMs={50000}
        playheadMs={0}
        visualCoverage={[{ fromMs: 0, toMs: 10000 }]}
        networkCoverage={[{ fromMs: 0, toMs: 50000 }]}
        visualHoles={[{ fromMs: 10000, toMs: 20000, label: "Video segment 2 missing" }]}
        networkHoles={[]}
        inputPins={[]}
        actionPins={[]}
        flags={flags}
        onSeek={() => undefined}
      />
    );
    expect(html).toContain('data-testid="timeline-hole"');
    expect(html).toMatch(/data-testid="timeline-flag-loss"[\s\S]*?fill="url\(#/);
    expect(html).toMatch(/class="text-muted" data-testid="timeline-flag-viewer_degraded"/);
    expect(html).toContain("Visual (isolated browser)");
    expect(html).toContain("Network (gateway)");
    expect(html).toContain("Flagged zones:");
  });

  test("clicking the timeline maps the pointer to session time", () => {
    expect(msFromPointer(150, { left: 100, width: 200 }, 0, 60000)).toBe(15000);
    expect(msFromPointer(500, { left: 100, width: 200 }, 0, 60000)).toBe(60000);
  });

  test("flagged zone summary lists intervals and point flags", () => {
    expect(describeFlaggedZones(flags, [])).toBe(
      "Flagged zones: Incomplete (gateway-reported loss): L1 from 00:10 to 00:20; Viewer degraded (the recording is unaffected) from 00:30 to 00:35; Blocked: evil.example:443 at 00:40."
    );
  });

  test("network log shows the count for each filter", () => {
    const rows = [
      row({ id: "a", method: "POST", action: "form_submit", isWrite: true }),
      row({ id: "b", status: 503 }),
      row({ id: "c", kind: "blocked", status: null, blockedReason: "host_not_allowed" }),
      row({ id: "d", method: "POST", url: "https://app/api/ds/query" })
    ];
    const html = renderToStaticMarkup(
      <GatewayHttpLog rows={rows} playheadMs={0} autoFollow onSeek={() => undefined} />
    );
    const count = (id: string) =>
      new RegExp(`data-testid="l1-filter-count-${id}">(\\d+)<`).exec(html)?.[1];
    expect([count("all"), count("writes"), count("errors"), count("blocked")]).toEqual([
      "4",
      "1",
      "1",
      "1"
    ]);
  });
});
