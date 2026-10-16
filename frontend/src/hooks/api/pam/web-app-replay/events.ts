import {
  base64ToBytes,
  decodeEnvelopeBody,
  EventType,
  TEnvelope
} from "@app/lib/pam-web-app/contract";

import { WEB_APP_REPLAY_MAX_BODY_PREVIEW_CHARS } from "./limits";
import { TVerifiedEventChunk } from "./verify";

export const MASKED_LABEL = "[MASKED]";

// The gateway scrubber writes "***" for every masked value.
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

// A POST alone is not a write, because single-page apps poll with POST; actions come from Fetch Metadata and
// content headers instead.
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

export const ACTION_LABEL: Record<TActionKind, string> = {
  navigation: "Navigation",
  form_submit: "Form submit",
  download: "Download",
  upload: "Upload"
};

const VIEWER_DEGRADED_LABEL = "Viewer degraded (the recording is unaffected)";

type TL3Event = {
  t?: string;
  action?: string;
  key?: string;
  text?: string;
  button?: number;
  x?: number;
  y?: number;
};

type TInputDescription = Pick<TInputRow, "kind" | "text">;

const describeKey = (k: TL3Event) => (k.key && k.key.length === 1 ? k.key : `[${k.key ?? "?"}]`);

const describeKeys = (keys: TL3Event[], masked: boolean) =>
  unmaskText(masked ? MASKED_LABEL : keys.map(describeKey).join(""));

const describeInput = (events: TL3Event[], masked: boolean): TInputDescription => {
  const keys = events.filter((e) => e.t === "key" && e.action !== "up");
  const releases = events.filter((e) => e.t === "key" && e.action === "up");
  const paste = events.find((e) => e.t === "paste" || e.t === "ime");
  const click = events.find((e) => e.t === "button" && e.action === "down");
  if (paste) {
    return { kind: "paste", text: `Paste: ${unmaskText(paste.text ?? "")}` };
  }
  if (keys.length > 0) {
    return { kind: "keys", text: `Typed ${describeKeys(keys, masked)}` };
  }
  if (click) {
    return { kind: "click", text: `Click at ${click.x ?? "?"}, ${click.y ?? "?"}` };
  }
  if (events.some((e) => e.t === "wheel")) return { kind: "wheel", text: "Scroll" };
  if (releases.length > 0) {
    return { kind: "keys", text: `Released ${describeKeys(releases, masked)}` };
  }
  return { kind: "move", text: "Pointer move" };
};

const describeExt = (body: Record<string, unknown>): TInputDescription => {
  const kind = String(body.kind ?? "event");
  if (kind === "credential_injected") return { kind: "credential", text: "Credential injected" };
  if (kind === "download") {
    return {
      kind: "transfer",
      text: `Download ${unmaskText(String(body.url ?? body.filename ?? ""))}`.trim()
    };
  }
  return { kind: "marker", text: kind.replace(/_/g, " ") };
};

type TRawEvent = { type: number; seq: number; sessionMs: number; body: Record<string, unknown> };

const decodeBodyFields = (env: TEnvelope): Record<string, unknown> => {
  try {
    return decodeEnvelopeBody<Record<string, unknown>>(env);
  } catch {
    return {};
  }
};

const toRawEvent = (env: TEnvelope): TRawEvent => ({
  type: env.type,
  seq: Number(env.seq),
  sessionMs: usToMs(env.monoElapsedUs),
  body: decodeBodyFields(env)
});

const decodeEvents = (chunks: TVerifiedEventChunk[]): TRawEvent[] =>
  chunks.flatMap((chunk) => chunk.envelopes.map(toRawEvent));

const l1Row = (
  ev: TRawEvent,
  fields: Pick<TL1Row, "kind" | "method" | "url"> & Partial<TL1Row>
): TL1Row => ({
  id: `l1-${ev.seq}`,
  seq: ev.seq,
  sessionMs: ev.sessionMs,
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
  blockedReason: null,
  ...fields
});

const requestRow = (ev: TRawEvent) =>
  l1Row(ev, {
    kind: "request",
    method: String(ev.body.method ?? ""),
    url: unmaskText(String(ev.body.url ?? "")),
    requestHeaders: unmaskHeaders(ev.body.headers),
    requestBody: decodeBody(ev.body.body as string | undefined),
    requestBodyBytes: Number(ev.body.bodyBytes ?? 0),
    truncated: Boolean(ev.body.truncated)
  });

const withResponse = (row: TL1Row, body: Record<string, unknown>): TL1Row => ({
  ...row,
  status: Number(body.status ?? 0),
  durationMs: body.durationMs === undefined ? null : Number(body.durationMs),
  responseHeaders: unmaskHeaders(body.headers),
  responseBody: decodeBody(body.body as string | undefined),
  responseBodyBytes: Number(body.bodyBytes ?? 0),
  truncated: row.truncated || Boolean(body.truncated)
});

const wsRow = (ev: TRawEvent) =>
  l1Row(ev, {
    kind: "ws",
    method: ev.body.dir === "s2c" ? "WS <" : "WS >",
    url: unmaskText(String(ev.body.connId ?? "")),
    requestBody: decodeBody(ev.body.payload as string | undefined),
    requestBodyBytes: Number(ev.body.bytes ?? 0),
    truncated: Boolean(ev.body.truncated)
  });

const blockedHost = (body: Record<string, unknown>) =>
  `${String(body.host ?? "")}${body.port ? `:${String(body.port)}` : ""}`;

const blockedRow = (ev: TRawEvent, host: string) =>
  l1Row(ev, {
    kind: "blocked",
    method: String(ev.body.method ?? "CONNECT"),
    url: host,
    blockedReason: String(ev.body.reason ?? "blocked")
  });

const inputRow = (
  ev: TRawEvent,
  description: TInputDescription,
  masked: boolean,
  droppedCount: number
): TInputRow => ({
  id: `l3-${ev.seq}`,
  seq: ev.seq,
  sessionMs: ev.sessionMs,
  ...description,
  masked,
  droppedCount
});

const intervalFlag = (ev: TRawEvent, kind: TFlagKind, label: string): TFlag => ({
  id: `flag-${ev.seq}`,
  kind,
  fromMs: usToMs(Number(ev.body.fromUs ?? 0)),
  toMs: usToMs(Number(ev.body.toUs ?? 0)),
  label
});

type TTimelineDraft = {
  l1Rows: TL1Row[];
  rowIndexByReqId: Map<string, number>;
  inputRows: TInputRow[];
  flags: TFlag[];
  sessionOpen: TSessionOpenInfo | null;
  sessionEnd: TSessionEndInfo | null;
  degradedSince: number | null;
  lastEventMs: number;
};

const EVENT_HANDLERS: Partial<Record<number, (acc: TTimelineDraft, ev: TRawEvent) => void>> = {
  [EventType.SessionOpen]: (acc, { body }) => {
    acc.sessionOpen = {
      gatewayId: body.gatewayId as string | undefined,
      startUrl: body.startUrl as string | undefined,
      userId: body.userId as string | undefined
    };
  },
  [EventType.SessionEnd]: (acc, ev) => {
    acc.sessionEnd = {
      reason: String(ev.body.reason ?? "unknown"),
      finalSeq: Number(ev.body.finalSeq ?? ev.seq),
      vObjects: Number(ev.body.vObjects ?? 0),
      eChunks: Number(ev.body.eChunks ?? 0),
      sessionMs: ev.sessionMs
    };
  },
  [EventType.L1Request]: (acc, ev) => {
    if (typeof ev.body.reqId === "string")
      acc.rowIndexByReqId.set(ev.body.reqId, acc.l1Rows.length);
    acc.l1Rows.push(requestRow(ev));
  },
  [EventType.L1Response]: (acc, { body }) => {
    const index = typeof body.reqId === "string" ? acc.rowIndexByReqId.get(body.reqId) : undefined;
    if (index === undefined) return;
    acc.l1Rows[index] = withResponse(acc.l1Rows[index], body);
  },
  [EventType.L1WsFrame]: (acc, ev) => {
    acc.l1Rows.push(wsRow(ev));
  },
  [EventType.L1Blocked]: (acc, ev) => {
    const host = blockedHost(ev.body);
    acc.l1Rows.push(blockedRow(ev, host));
    acc.flags.push({
      id: `flag-${ev.seq}`,
      kind: "blocked",
      fromMs: ev.sessionMs,
      toMs: ev.sessionMs,
      label: `Blocked: ${host}`
    });
  },
  [EventType.L3Input]: (acc, ev) => {
    const masked = Boolean(ev.body.masked);
    const description = describeInput((ev.body.events as TL3Event[] | undefined) ?? [], masked);
    const dropped = Array.isArray(ev.body.dropped) ? ev.body.dropped.length : 0;
    acc.inputRows.push(inputRow(ev, description, masked, dropped));
  },
  [EventType.ExtEvent]: (acc, ev) => {
    acc.inputRows.push(inputRow(ev, describeExt(ev.body), false, 0));
  },
  [EventType.Loss]: (acc, ev) => {
    const label = `Incomplete (gateway-reported loss): ${String(ev.body.stream ?? "")}`.trim();
    acc.flags.push(intervalFlag(ev, "loss", label));
  },
  [EventType.ContinuityUnknown]: (acc, ev) => {
    acc.flags.push(intervalFlag(ev, "continuity_unknown", "Visual continuity unknown"));
  },
  [EventType.ViewerDegraded]: (acc, ev) => {
    if (ev.body.active === true && acc.degradedSince === null) acc.degradedSince = ev.sessionMs;
    if (ev.body.active === false && acc.degradedSince !== null) {
      acc.flags.push({
        id: `flag-${ev.seq}`,
        kind: "viewer_degraded",
        fromMs: acc.degradedSince,
        toMs: ev.sessionMs,
        label: VIEWER_DEGRADED_LABEL
      });
      acc.degradedSince = null;
    }
  }
};

const classifyRow = (row: TL1Row): TL1Row => {
  if (row.kind !== "request") return row;
  const action = classifyAction(row.method, row.requestHeaders, row.responseHeaders);
  const isWrite =
    action === "form_submit" || action === "upload" || WRITE_METHODS.has(row.method.toUpperCase());
  return { ...row, action, isWrite };
};

const toActionPins = (row: TL1Row): TActionPin[] =>
  row.action
    ? [
        {
          id: `pin-${row.id}`,
          rowId: row.id,
          kind: row.action,
          sessionMs: row.sessionMs,
          label: `${ACTION_LABEL[row.action]}: ${row.url}`
        }
      ]
    : [];

export const buildReplayTimeline = (chunks: TVerifiedEventChunk[]): TReplayTimeline => {
  const draft: TTimelineDraft = {
    l1Rows: [],
    rowIndexByReqId: new Map(),
    inputRows: [],
    flags: [],
    sessionOpen: null,
    sessionEnd: null,
    degradedSince: null,
    lastEventMs: 0
  };
  decodeEvents([...chunks].sort((a, b) => a.objectIndex - b.objectIndex)).forEach((ev) => {
    draft.lastEventMs = Math.max(draft.lastEventMs, ev.sessionMs);
    EVENT_HANDLERS[ev.type]?.(draft, ev);
  });

  if (draft.degradedSince !== null) {
    draft.flags.push({
      id: "flag-degraded-open",
      kind: "viewer_degraded",
      fromMs: draft.degradedSince,
      toMs: draft.lastEventMs,
      label: VIEWER_DEGRADED_LABEL
    });
  }

  const l1Rows = draft.l1Rows.map(classifyRow);
  return {
    l1Rows,
    inputRows: draft.inputRows,
    flags: draft.flags.sort((a, b) => a.fromMs - b.fromMs),
    actionPins: l1Rows.flatMap(toActionPins),
    sessionOpen: draft.sessionOpen,
    sessionEnd: draft.sessionEnd,
    lastEventMs: draft.lastEventMs
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

// Index of the last row at or before the playhead, or -1 when every row is after it.
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
