import {
  decodeFrame,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonPayload,
  FrameType,
  MAX_UPSTREAM_PAYLOAD,
  type TControlDown,
  type TFrame,
  type TVideoConfig
} from "@app/lib/pam-web-app/contract";

import type { TClock, TLiveChunk, TLiveDecoderPort, TSessionSocket } from "./types";

export const createFakeClock = () => {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: TClock & { advance: (ms: number) => void } = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    }
  };
  return clock;
};

export const createFakeSocket = () => {
  const sent: TFrame[] = [];
  const socket: TSessionSocket & { sent: TFrame[]; closed: number | null } = {
    sent,
    closed: null,
    send: (data) => {
      sent.push(decodeFrame(data, MAX_UPSTREAM_PAYLOAD));
    },
    close: (code) => {
      socket.closed = code ?? 1000;
    }
  };
  return socket;
};

export const createFakeDecoder = () => {
  const decoder: TLiveDecoderPort & {
    configs: TVideoConfig[];
    chunks: TLiveChunk[];
    accept: boolean;
    queue: number;
    closed: boolean;
  } = {
    configs: [],
    chunks: [],
    accept: true,
    queue: 0,
    closed: false,
    get decodeQueueSize() {
      return decoder.queue;
    },
    configure: (config) => {
      decoder.configs.push(config);
    },
    decode: (chunk) => {
      decoder.chunks.push(chunk);
      return decoder.accept;
    },
    close: () => {
      decoder.closed = true;
    }
  };
  return decoder;
};

let downstreamSeq = 0;

const toBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export const downstream = (type: FrameType, payload: Uint8Array, flags = 0) => {
  const frame = encodeFrame({ type, flags, seq: downstreamSeq, timestampUs: 0n, payload });
  downstreamSeq += 1;
  return toBuffer(frame);
};

export const controlFrame = (control: TControlDown) =>
  downstream(FrameType.Control, encodeJsonPayload(control));

export const chunkFrame = (seq: number, keyframe: boolean) =>
  toBuffer(
    encodeFrame({
      type: FrameType.VideoChunk,
      flags: keyframe ? 1 : 0,
      seq,
      timestampUs: BigInt(seq * 33333),
      payload: new Uint8Array([0, 0, 0, 1, 9, 16])
    })
  );

export const sessionReady = (
  inputEnabled = true
): Extract<TControlDown, { kind: "session_ready" }> => ({
  kind: "session_ready",
  sessionId: "11111111-1111-1111-1111-111111111111",
  expiresAt: "2026-10-15T20:00:00Z",
  inputEnabled
});

export const sentJson = <T>(frame: TFrame) => decodeJsonPayload<T>(frame.payload);
