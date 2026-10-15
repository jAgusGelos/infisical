import { describe, expect, test } from "vitest";

import { concatBytes, EventType, verifyChainSegment } from "@app/lib/pam-web-app/contract";

import { createReplayClock } from "./clock";
import { buildReplayTimeline, classifyAction, filterL1Rows, rowIndexAt } from "./events";
import { buildChain } from "./testkit";
import { TVerifiedEventChunk } from "./verify";

const b64 = (s: string) => Buffer.from(s).toString("base64");

const ev = (type: number, ms: number, body: unknown) => ({
  type,
  wallTimeUnixMs: 1760544000000n + BigInt(ms),
  monoElapsedUs: BigInt(ms * 1000),
  body
});

const nav: [string, string][] = [
  ["sec-fetch-dest", "document"],
  ["sec-fetch-mode", "navigate"]
];

const chunkFrom = async (events: ReturnType<typeof ev>[]) => {
  const { envelopes } = await buildChain(events);
  const seg = await verifyChainSegment(concatBytes(...envelopes), 0n, new Uint8Array(32));
  return {
    objectIndex: 0,
    envelopes: seg.envelopes,
    hashes: seg.hashes,
    firstSeq: 0n,
    lastSeq: seg.lastSeq,
    head: seg.head,
    linkedToPrevious: true
  } as unknown as TVerifiedEventChunk;
};

const sample = () => [
  ev(EventType.SessionOpen, 0, { gatewayId: "gw-1", startUrl: "https://app/" }),
  ev(EventType.L1Request, 1000, {
    reqId: "r-1",
    method: "GET",
    url: "https://app/",
    headers: [...nav, ["authorization", "Basic ***"]],
    body: ""
  }),
  ev(EventType.L1Response, 1040, { reqId: "r-1", status: 200, headers: [], durationMs: 40 }),
  ev(EventType.L3Input, 2000, {
    events: [{ t: "key", action: "down", key: "*" }],
    masked: true,
    dropped: []
  }),
  ev(EventType.ExtEvent, 2500, { kind: "credential_injected" }),
  ev(EventType.L1Request, 3000, {
    reqId: "r-2",
    method: "POST",
    url: "https://app/login",
    headers: [...nav, ["content-type", "application/x-www-form-urlencoded"]],
    body: b64("user=admin&password=***")
  }),
  ev(EventType.L1Response, 3050, { reqId: "r-2", status: 302, headers: [["set-cookie", "***"]] }),
  ev(EventType.L1Request, 4000, {
    reqId: "r-3",
    method: "POST",
    url: "https://app/api/ds/query",
    headers: [
      ["sec-fetch-dest", "empty"],
      ["sec-fetch-mode", "cors"]
    ]
  }),
  ev(EventType.L1Response, 4050, { reqId: "r-3", status: 500, headers: [] }),
  ev(EventType.L1Request, 5000, {
    reqId: "r-4",
    method: "GET",
    url: "https://app/export.csv",
    headers: nav
  }),
  ev(EventType.L1Response, 5050, {
    reqId: "r-4",
    status: 200,
    headers: [["Content-Disposition", "attachment; filename=x.csv"]]
  }),
  ev(EventType.L1Request, 6000, {
    reqId: "r-5",
    method: "POST",
    url: "https://app/upload",
    headers: [["content-type", "multipart/form-data; boundary=x"]]
  }),
  ev(EventType.L1Blocked, 7000, {
    method: "CONNECT",
    host: "evil.example",
    port: 443,
    reason: "host_not_allowed"
  }),
  ev(EventType.Loss, 8000, { stream: "L1", fromUs: 7500000, toUs: 8000000, count: 2 }),
  ev(EventType.ViewerDegraded, 8500, { active: true }),
  ev(EventType.ViewerDegraded, 9000, { active: false }),
  ev(EventType.SessionEnd, 9500, { reason: "user_end", finalSeq: 16, vObjects: 2, eChunks: 1 })
];

describe("web app replay events view model", () => {
  test("pairs requests and responses and renders masked values", async () => {
    const tl = buildReplayTimeline([await chunkFrom(sample())]);
    const [first, login] = tl.l1Rows;
    expect(first.status).toBe(200);
    expect(first.durationMs).toBe(40);
    expect(first.requestHeaders).toContainEqual(["authorization", "Basic [MASKED]"]);
    expect(login.requestBody).toBe("user=admin&password=[MASKED]");
    expect(login.responseHeaders).toEqual([["set-cookie", "[MASKED]"]]);
    expect(tl.inputRows[0]).toMatchObject({ kind: "keys", text: "Typed [MASKED]", masked: true });
    expect(tl.inputRows[1]).toMatchObject({ kind: "credential", text: "Credential injected" });
    expect(tl.sessionOpen).toMatchObject({ gatewayId: "gw-1" });
    expect(tl.sessionEnd).toMatchObject({ reason: "user_end", vObjects: 2 });
  });

  test("derives action pins from Fetch Metadata; a polling POST is not a write", async () => {
    const tl = buildReplayTimeline([await chunkFrom(sample())]);
    expect(tl.actionPins.map((p) => p.kind)).toEqual([
      "navigation",
      "form_submit",
      "download",
      "upload"
    ]);
    const query = tl.l1Rows.find((r) => r.url.endsWith("/api/ds/query"));
    expect(query?.action).toBeNull();
    expect(query?.isWrite).toBe(false);
    expect(filterL1Rows(tl.l1Rows, "writes").map((r) => r.url)).toEqual([
      "https://app/login",
      "https://app/upload"
    ]);
    expect(filterL1Rows(tl.l1Rows, "errors")).toHaveLength(1);
    expect(filterL1Rows(tl.l1Rows, "blocked")[0]).toMatchObject({ url: "evil.example:443" });
  });

  test("builds loss, blocked and viewer degraded flags with exact intervals", async () => {
    const tl = buildReplayTimeline([await chunkFrom(sample())]);
    expect(tl.flags.map((f) => [f.kind, f.fromMs, f.toMs])).toEqual([
      ["blocked", 7000, 7000],
      ["loss", 7500, 8000],
      ["viewer_degraded", 8500, 9000]
    ]);
  });

  test("classifyAction ignores header case", () => {
    expect(
      classifyAction(
        "GET",
        [
          ["Sec-Fetch-Dest", "Document"],
          ["Sec-Fetch-Mode", "navigate"]
        ],
        []
      )
    ).toBe("navigation");
  });

  test("rowIndexAt finds the last row at or before the playhead", () => {
    const rows = [{ sessionMs: 10 }, { sessionMs: 20 }, { sessionMs: 30 }];
    expect(rowIndexAt(rows, 5)).toBe(-1);
    expect(rowIndexAt(rows, 20)).toBe(1);
    expect(rowIndexAt(rows, 99)).toBe(2);
  });
});

describe("replay clock", () => {
  const media = (objectIndex: number, startMs: number, monoStartUs?: number) => ({
    objectIndex,
    kind: "media" as const,
    initIndex: 0,
    startMs,
    endMs: startMs + 10000,
    monoStartUs,
    monoEndUs: monoStartUs === undefined ? undefined : monoStartUs + 10_000_000,
    checkpoint: "",
    signature: ""
  });

  test("maps session time through monoStartUs and back", () => {
    const clock = createReplayClock([media(1, 0, 1_250_000), media(2, 10000, 11_250_000)]);
    expect(clock.sessionToVideoMs(1250)).toBe(0);
    expect(clock.sessionToVideoMs(12250)).toBe(11000);
    expect(clock.videoToSessionMs(11000)).toBe(12250);
    expect(clock.sessionToVideoMs(500)).toBe(0);
    expect(clock.durationVideoMs).toBe(20000);
  });

  test("jumps to the next segment for a time inside a hole", () => {
    const clock = createReplayClock([media(1, 0, 0), media(3, 20000, 20_000_000)]);
    expect(clock.sessionToVideoMs(15000)).toBe(20000);
  });

  test("falls back to identity without monoStartUs", () => {
    const clock = createReplayClock([media(1, 0)]);
    expect(clock.sessionToVideoMs(4000)).toBe(4000);
    expect(clock.videoToSessionMs(4000)).toBe(4000);
  });
});
