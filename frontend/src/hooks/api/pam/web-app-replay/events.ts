import { base64ToBytes, decodeEnvelopeBody, EventType } from "@app/lib/pam-web-app/contract";

import { WEB_APP_REPLAY_MAX_BODY_PREVIEW_CHARS } from "./limits";
import { TVerifiedEventChunk } from "./verify";

export const MASKED_LABEL = "[MASKED]";

// The gateway scrubber writes "***" for every masked value (CONTRACTS.md 5.3, 5.3b).
export const unmaskText = (text: string) => text.split("***").join(MASKED_LABEL);

export type THeaderList = [string, string][];

export type TActionKind = "navigation" | "form_submit" | "download" | "upload";

export type TL1Row = {
  id: string;
  seq: number;
  sessionMs: number;
  kind: "request" | "blocked" | "ws";
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  requestHeaders: THeaderList;
  responseHeaders: THeaderList;
  requestBody: string;
  responseBody: string;
  requestBodyBytes: number;
  responseBodyBytes: number;
  truncated: boolean;
  action: TActionKind | null;
  isWrite: boolean;
  blockedReason: string | null;
};

export type TInputRow = {
  id: string;
  seq: number;
  sessionMs: number;
  kind: "click" | "keys" | "paste" | "wheel" | "move" | "transfer" | "credential" | "marker";
  text: string;
  masked: boolean;
  droppedCount: number;
};

export type TFlagKind = "loss" | "continuity_unknown" | "viewer_degraded" | "blocked";

export type TFlag = {
  id: string;
  kind: TFlagKind;
  fromMs: number;
  toMs: number;
  label: string;
};

export type TActionPin = {
  id: string;
  rowId: string;
  kind: TActionKind;
  sessionMs: number;
  label: string;
};

export type TSessionOpenInfo = {
  gatewayId?: string;
  startUrl?: string;
  userId?: string;
};

export type TSessionEndInfo = {
  reason: string;
  finalSeq: number;
  vObjects: number;
  eChunks: number;
  sessionMs: number;
};

export type TReplayTimeline = {
  l1Rows: TL1Row[];
  inputRows: TInputRow[];
  flags: TFlag[];
  actionPins: TActionPin[];
  sessionOpen: TSessionOpenInfo | null;
  sessionEnd: TSessionEndInfo | null;
  lastEventMs: number;
};

const textDecoder = new TextDecoder("utf-8", { fatal: false });

const usToMs = (us: number | bigint) => Number(us) / 1000;

const decodeBody = (b64: string | undefined) => {
  if (!b64) return "";
  try {
    const text = textDecoder.decode(base64ToBytes(b64));
    return unmaskText(
      text.length > WEB_APP_REPLAY_MAX_BODY_PREVIEW_CHARS
        ? `${text.slice(0, WEB_APP_REPLAY_MAX_BODY_PREVIEW_CHARS)}\n[preview truncated]`
        : text
    );
  } catch {
    return "[body could not be decoded]";
  }
};

const unmaskHeaders = (headers: unknown): THeaderList =>
  Array.isArray(headers)
    ? headers
        .filter((h): h is [string, string] => Array.isArray(h) && h.length === 2)
        .map(([name, value]) => [String(name), unmaskText(String(value))])
    : [];

const headerValue = (headers: THeaderList, name: string) =>
  headers.find(([n]) => n.toLowerCase() === name)?.[1]?.toLowerCase() ?? "";

// Generic action detection from Fetch Metadata and content headers (REPLAY-UI-DESIGN data note): a POST alone is
// not a write, because single-page apps poll with POST.
export const classifyAction = (
  method: string,
  requestHeaders: THeaderList,
  responseHeaders: THeaderList
): TActionKind | null => {
  if (headerValue(responseHeaders, "content-disposition").startsWith("attachment")) {
    return "download";
  }
  if (headerValue(requestHeaders, "content-type").startsWith("multipart/form-data"))
    return "upload";
  const isDocumentNavigation =
    headerValue(requestHeaders, "sec-fetch-dest") === "document" &&
    headerValue(requestHeaders, "sec-fetch-mode") === "navigate";
  if (!isDocumentNavigation) return null;
  return method.toUpperCase() === "POST" ? "form_submit" : "navigation";
};

const WRITE_METHODS = new Set(["PUT", "PATCH", "DELETE"]);

const ACTION_LABEL: Record<TActionKind, string> = {
  navigation: "Navigation",
  form_submit: "Form submit",
  download: "Download",
  upload: "Upload"
};

type TL3Event = {
  t?: string;
  action?: string;
  key?: string;
  text?: string;
  button?: number;
  x?: number;
  y?: number;
};

const describeInput = (events: TL3Event[], masked: boolean): Pick<TInputRow, "kind" | "text"> => {
  const keys = events.filter((e) => e.t === "key" && e.action !== "up");
  const paste = events.find((e) => e.t === "paste" || e.t === "ime");
  const click = events.find((e) => e.t === "button" && e.action === "down");
  if (paste) {
    return { kind: "paste", text: `Paste: ${unmaskText(paste.text ?? "")}` };
  }
  if (keys.length > 0) {
    const typed = masked
      ? MASKED_LABEL
      : keys.map((k) => (k.key && k.key.length === 1 ? k.key : `[${k.key ?? "?"}]`)).join("");
    return { kind: "keys", text: `Typed ${unmaskText(typed)}` };
  }
  if (click) {
    return { kind: "click", text: `Click at ${click.x ?? "?"}, ${click.y ?? "?"}` };
  }
  if (events.some((e) => e.t === "wheel")) return { kind: "wheel", text: "Scroll" };
  return { kind: "move", text: "Pointer move" };
};

const describeExt = (body: Record<string, unknown>): Pick<TInputRow, "kind" | "text"> => {
  const kind = String(body.kind ?? "event");
  if (kind === "credential_injected") return { kind: "credential", text: "Credential injected" };
  if (kind === "download") {
    return {
      kind: "transfer",
      text: `Download ${unmaskText(String(body.url ?? body.filename ?? ""))}`.trim()
    };
  }
  return { kind: "marker", text: `${kind.replace(/_/g, " ")}` };
};

type TRawEvent = { type: number; seq: number; sessionMs: number; body: Record<string, unknown> };

const decodeEvents = (chunks: TVerifiedEventChunk[]): TRawEvent[] =>
  chunks.flatMap((chunk) =>
    chunk.envelopes.map((env) => {
      let body: Record<string, unknown> = {};
      try {
        body = decodeEnvelopeBody<Record<string, unknown>>(env);
      } catch {
        body = {};
      }
      return {
        type: env.type,
        seq: Number(env.seq),
        sessionMs: usToMs(env.monoElapsedUs),
        body
      };
    })
  );

export const buildReplayTimeline = (chunks: TVerifiedEventChunk[]): TReplayTimeline => {
  const events = decodeEvents([...chunks].sort((a, b) => a.objectIndex - b.objectIndex));
  const l1Rows: TL1Row[] = [];
  const byReqId = new Map<string, TL1Row>();
  const inputRows: TInputRow[] = [];
  const flags: TFlag[] = [];
  let sessionOpen: TSessionOpenInfo | null = null;
  let sessionEnd: TSessionEndInfo | null = null;
  let degradedSince: number | null = null;
  let lastEventMs = 0;

  events.forEach((ev) => {
    lastEventMs = Math.max(lastEventMs, ev.sessionMs);
    const { body } = ev;
    switch (ev.type) {
      case EventType.SessionOpen:
        sessionOpen = {
          gatewayId: body.gatewayId as string | undefined,
          startUrl: body.startUrl as string | undefined,
          userId: body.userId as string | undefined
        };
        break;
      case EventType.SessionEnd:
        sessionEnd = {
          reason: String(body.reason ?? "unknown"),
          finalSeq: Number(body.finalSeq ?? ev.seq),
          vObjects: Number(body.vObjects ?? 0),
          eChunks: Number(body.eChunks ?? 0),
          sessionMs: ev.sessionMs
        };
        break;
      case EventType.L1Request: {
        const requestHeaders = unmaskHeaders(body.headers);
        const row: TL1Row = {
          id: `l1-${ev.seq}`,
          seq: ev.seq,
          sessionMs: ev.sessionMs,
          kind: "request",
          method: String(body.method ?? ""),
          url: unmaskText(String(body.url ?? "")),
          status: null,
          durationMs: null,
          requestHeaders,
          responseHeaders: [],
          requestBody: decodeBody(body.body as string | undefined),
          responseBody: "",
          requestBodyBytes: Number(body.bodyBytes ?? 0),
          responseBodyBytes: 0,
          truncated: Boolean(body.truncated),
          action: null,
          isWrite: false,
          blockedReason: null
        };
        l1Rows.push(row);
        if (typeof body.reqId === "string") byReqId.set(body.reqId, row);
        break;
      }
      case EventType.L1Response: {
        const row = typeof body.reqId === "string" ? byReqId.get(body.reqId) : undefined;
        if (!row) break;
        row.status = Number(body.status ?? 0);
        row.durationMs = body.durationMs === undefined ? null : Number(body.durationMs);
        row.responseHeaders = unmaskHeaders(body.headers);
        row.responseBody = decodeBody(body.body as string | undefined);
        row.responseBodyBytes = Number(body.bodyBytes ?? 0);
        row.truncated = row.truncated || Boolean(body.truncated);
        break;
      }
      case EventType.L1WsFrame:
        l1Rows.push({
          id: `l1-${ev.seq}`,
          seq: ev.seq,
          sessionMs: ev.sessionMs,
          kind: "ws",
          method: body.dir === "s2c" ? "WS <" : "WS >",
          url: unmaskText(String(body.connId ?? "")),
          status: null,
          durationMs: null,
          requestHeaders: [],
          responseHeaders: [],
          requestBody: decodeBody(body.payload as string | undefined),
          responseBody: "",
          requestBodyBytes: Number(body.bytes ?? 0),
          responseBodyBytes: 0,
          truncated: Boolean(body.truncated),
          action: null,
          isWrite: false,
          blockedReason: null
        });
        break;
      case EventType.L1Blocked: {
        const host = `${String(body.host ?? "")}${body.port ? `:${String(body.port)}` : ""}`;
        l1Rows.push({
          id: `l1-${ev.seq}`,
          seq: ev.seq,
          sessionMs: ev.sessionMs,
          kind: "blocked",
          method: String(body.method ?? "CONNECT"),
          url: host,
          status: null,
          durationMs: null,
          requestHeaders: [],
          responseHeaders: [],
          requestBody: "",
          responseBody: "",
          requestBodyBytes: 0,
          responseBodyBytes: 0,
          truncated: false,
          action: null,
          isWrite: false,
          blockedReason: String(body.reason ?? "blocked")
        });
        flags.push({
          id: `flag-${ev.seq}`,
          kind: "blocked",
          fromMs: ev.sessionMs,
          toMs: ev.sessionMs,
          label: `Blocked: ${host}`
        });
        break;
      }
      case EventType.L3Input: {
        const masked = Boolean(body.masked);
        const described = describeInput((body.events as TL3Event[] | undefined) ?? [], masked);
        inputRows.push({
          id: `l3-${ev.seq}`,
          seq: ev.seq,
          sessionMs: ev.sessionMs,
          ...described,
          masked,
          droppedCount: Array.isArray(body.dropped) ? body.dropped.length : 0
        });
        break;
      }
      case EventType.ExtEvent:
        inputRows.push({
          id: `l3-${ev.seq}`,
          seq: ev.seq,
          sessionMs: ev.sessionMs,
          ...describeExt(body),
          masked: false,
          droppedCount: 0
        });
        break;
      case EventType.Loss:
        flags.push({
          id: `flag-${ev.seq}`,
          kind: "loss",
          fromMs: usToMs(Number(body.fromUs ?? 0)),
          toMs: usToMs(Number(body.toUs ?? 0)),
          label: `Incomplete (gateway-reported loss): ${String(body.stream ?? "")}`.trim()
        });
        break;
      case EventType.ContinuityUnknown:
        flags.push({
          id: `flag-${ev.seq}`,
          kind: "continuity_unknown",
          fromMs: usToMs(Number(body.fromUs ?? 0)),
          toMs: usToMs(Number(body.toUs ?? 0)),
          label: "Visual continuity unknown"
        });
        break;
      case EventType.ViewerDegraded:
        if (body.active === true && degradedSince === null) degradedSince = ev.sessionMs;
        if (body.active === false && degradedSince !== null) {
          flags.push({
            id: `flag-${ev.seq}`,
            kind: "viewer_degraded",
            fromMs: degradedSince,
            toMs: ev.sessionMs,
            label: "Viewer degraded (the recording is unaffected)"
          });
          degradedSince = null;
        }
        break;
      default:
        break;
    }
  });

  if (degradedSince !== null) {
    flags.push({
      id: "flag-degraded-open",
      kind: "viewer_degraded",
      fromMs: degradedSince,
      toMs: lastEventMs,
      label: "Viewer degraded (the recording is unaffected)"
    });
  }

  const actionPins: TActionPin[] = [];
  l1Rows.forEach((row) => {
    if (row.kind !== "request") return;
    // eslint-disable-next-line no-param-reassign
    row.action = classifyAction(row.method, row.requestHeaders, row.responseHeaders);
    // eslint-disable-next-line no-param-reassign
    row.isWrite =
      row.action === "form_submit" ||
      row.action === "upload" ||
      WRITE_METHODS.has(row.method.toUpperCase());
    if (row.action) {
      actionPins.push({
        id: `pin-${row.id}`,
        rowId: row.id,
        kind: row.action,
        sessionMs: row.sessionMs,
        label: `${ACTION_LABEL[row.action]}: ${row.url}`
      });
    }
  });

  return {
    l1Rows,
    inputRows,
    flags: flags.sort((a, b) => a.fromMs - b.fromMs),
    actionPins,
    sessionOpen,
    sessionEnd,
    lastEventMs
  };
};

export type TL1Filter = "all" | "writes" | "errors" | "blocked";

export const filterL1Rows = (rows: TL1Row[], filter: TL1Filter) => {
  switch (filter) {
    case "writes":
      return rows.filter((r) => r.isWrite);
    case "errors":
      return rows.filter((r) => r.status !== null && r.status >= 400);
    case "blocked":
      return rows.filter((r) => r.kind === "blocked");
    default:
      return rows;
  }
};

// Index of the last row at or before the playhead, for auto-follow.
export const rowIndexAt = (rows: { sessionMs: number }[], sessionMs: number) => {
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; // eslint-disable-line no-bitwise
    if (rows[mid].sessionMs <= sessionMs) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
};
