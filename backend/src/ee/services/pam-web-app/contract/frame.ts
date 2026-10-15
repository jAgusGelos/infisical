// Uses only Uint8Array/DataView so the same file runs in Node and in the browser.

export const FRAME_VERSION = 1;
export const FRAME_HEADER_SIZE = 20;

export const MAX_UPSTREAM_PAYLOAD = 61440;
export const MAX_DOWNSTREAM_PAYLOAD = 4 * 1024 * 1024;
export const MAX_AGENT_PAYLOAD = 32 * 1024 * 1024;

export enum FrameType {
  VideoConfig = 0x01,
  VideoChunk = 0x02,
  Control = 0x03,
  ClipboardDown = 0x04,
  Hello = 0x20,
  Input = 0x21,
  Ack = 0x22,
  KeyframeRequest = 0x23,
  ControlUp = 0x24,
  ClipboardUp = 0x25,
  AgentHello = 0x80,
  AgentWelcome = 0x81,
  RecInit = 0x82,
  RecSegment = 0x83,
  RecLoss = 0x84,
  InputInject = 0x85,
  AgentControl = 0x86,
  AgentEvent = 0x87,
  ExtCommand = 0x88
}

export const FLAG_KEYFRAME = 1; // VIDEO_CHUNK
export const FLAG_ORIGIN_BACKEND = 1; // CONTROL

export const isDownstreamType = (t: number) => t >= 0x01 && t <= 0x1f;
export const isUpstreamType = (t: number) => t >= 0x20 && t <= 0x3f;
export const isAgentOnlyType = (t: number) => t >= 0x80 && t <= 0x9f;

export type TFrame = {
  type: number;
  flags: number;
  seq: number;
  timestampUs: bigint;
  payload: Uint8Array;
};

export class FrameError extends Error {
  constructor(
    public readonly code: "protocol_error" | "frame_too_large",
    message: string
  ) {
    super(message);
    this.name = "FrameError";
  }
}

export const encodeFrame = (frame: TFrame): Uint8Array => {
  const out = new Uint8Array(FRAME_HEADER_SIZE + frame.payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint8(1, frame.type);
  view.setUint16(2, frame.flags);
  view.setUint32(4, frame.seq);
  view.setBigUint64(8, frame.timestampUs);
  view.setUint32(16, frame.payload.length);
  out.set(frame.payload, FRAME_HEADER_SIZE);
  return out;
};

const readHeader = (buf: Uint8Array, maxPayload: number) => {
  const view = new DataView(buf.buffer, buf.byteOffset, FRAME_HEADER_SIZE);
  if (view.getUint8(0) !== FRAME_VERSION) throw new FrameError("protocol_error", "unsupported frame version");
  const length = view.getUint32(16);
  if (length > maxPayload) throw new FrameError("frame_too_large", `payload ${length} exceeds ${maxPayload}`);
  return {
    type: view.getUint8(1),
    flags: view.getUint16(2),
    seq: view.getUint32(4),
    timestampUs: view.getBigUint64(8),
    length
  };
};

// Decodes exactly one frame (one WebSocket message).
export const decodeFrame = (buf: Uint8Array, maxPayload: number): TFrame => {
  if (buf.length < FRAME_HEADER_SIZE) throw new FrameError("protocol_error", "short frame");
  const { length, ...header } = readHeader(buf, maxPayload);
  if (buf.length !== FRAME_HEADER_SIZE + length) {
    throw new FrameError("protocol_error", "frame length does not match message size");
  }
  return { ...header, payload: buf.slice(FRAME_HEADER_SIZE) };
};

// For byte streams (the TCP tunnel), where one frame can span several chunks.
export const createFrameReader = (maxPayload: number) => {
  let pending = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): TFrame[] {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      const frames: TFrame[] = [];
      let off = 0;
      while (merged.length - off >= FRAME_HEADER_SIZE) {
        const { length, ...header } = readHeader(merged.subarray(off, off + FRAME_HEADER_SIZE), maxPayload);
        if (merged.length - off - FRAME_HEADER_SIZE < length) break;
        const start = off + FRAME_HEADER_SIZE;
        frames.push({ ...header, payload: merged.slice(start, start + length) });
        off = start + length;
      }
      pending = merged.slice(off);
      return frames;
    }
  };
};

export const encodeAck = (ackSeq: number, decodeQueue: number): Uint8Array => {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, ackSeq);
  view.setUint16(4, decodeQueue);
  return out;
};

export const decodeAck = (payload: Uint8Array) => {
  if (payload.length !== 8) throw new FrameError("protocol_error", "ack payload must be 8 bytes");
  const view = new DataView(payload.buffer, payload.byteOffset, 8);
  return { ackSeq: view.getUint32(0), decodeQueue: view.getUint16(4) };
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const encodeJsonPayload = (value: unknown) => textEncoder.encode(JSON.stringify(value));
export const decodeJsonPayload = <T>(payload: Uint8Array): T => JSON.parse(textDecoder.decode(payload)) as T;

export const decodeMetaPrefixed = <T>(payload: Uint8Array): { meta: T; body: Uint8Array } => {
  if (payload.length < 4) throw new FrameError("protocol_error", "short meta-prefixed payload");
  const metaLen = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
  if (metaLen > payload.length - 4) throw new FrameError("protocol_error", "meta length exceeds payload");
  return { meta: decodeJsonPayload<T>(payload.subarray(4, 4 + metaLen)), body: payload.slice(4 + metaLen) };
};

export type TVideoConfig = {
  codec: string;
  format?: "annexb";
  width: number;
  height: number;
  framerate: number;
  epoch: number;
  shared?: boolean;
};

export type TViewerHello = {
  protocol: 1;
  client: string;
  decoders: { vp9: boolean; h264: boolean };
  viewport: { width: number; height: number; devicePixelRatio: number };
};

export const LIVE_CODEC_PROBES = { vp9: "vp09.00.10.08", h264: "avc1.42E01F" } as const;

export type TSessionEndReason =
  | "user_end"
  | "expired"
  | "idle"
  | "admin_terminated"
  | "policy_change"
  | "runner_exit"
  | "login_failed"
  | "recording_failed"
  | "viewer_lost"
  | "error";

export type TControlErrorCode =
  | "protocol_error"
  | "frame_too_large"
  | "no_decoder"
  | "runner_unavailable"
  | "capacity_exhausted"
  | "login_failed"
  | "tunnel_failed"
  | "session_in_use"
  | "internal";

export type TSessionPolicy = {
  clipboard: "off" | "to_remote" | "from_remote" | "both";
  downloads: "block" | "quarantine" | "allow";
  uploads: "block" | "allow";
};

export const monoFromPts = (ptsZeroUnixMs: number, sessionOpenWallTimeUnixMs: number, ptsUs: number) =>
  (ptsZeroUnixMs - sessionOpenWallTimeUnixMs) * 1000 + ptsUs;

export type TControlDown =
  | {
      kind: "session_ready";
      sessionId: string;
      expiresAt: string;
      inputEnabled: boolean;
      policy?: TSessionPolicy;
    }
  | { kind: "stream_hidden"; reason: "login" | "policy" }
  | { kind: "stream_shown" }
  | { kind: "input_state"; enabled: boolean }
  | { kind: "time_left"; secondsLeft: number; expiresAt: string }
  | { kind: "session_ending"; reason: TSessionEndReason; message?: string }
  | { kind: "viewer_degraded"; active: boolean; droppedFrames: number }
  | { kind: "recording_state"; state: "ok" | "loss"; lostMs: number }
  | { kind: "error"; code: TControlErrorCode; message: string; fatal: boolean };

export type TControlUp = { kind: "end_session" } | { kind: "visibility"; hidden: boolean };

export const MOD_SHIFT = 1;
export const MOD_CTRL = 2;
export const MOD_ALT = 4;
export const MOD_META = 8;

export type TInputEvent =
  | { t: "key"; action: "down" | "up"; code: string; key: string; mods: number; repeat: boolean; ts: number }
  | { t: "move"; x: number; y: number; buttons: number; ts: number }
  | { t: "button"; action: "down" | "up"; button: number; x: number; y: number; mods: number; ts: number }
  | { t: "wheel"; dx: number; dy: number; x: number; y: number; mods: number; ts: number }
  | { t: "ime"; text: string; ts: number }
  | { t: "paste"; id: string; part: number; total: number; text: string; ts: number };

export type TInputBatch = { events: TInputEvent[] };
