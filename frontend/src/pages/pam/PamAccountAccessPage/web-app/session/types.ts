import type {
  TControlErrorCode,
  TSessionEndReason,
  TSessionPolicy,
  TVideoConfig
} from "@app/lib/pam-web-app/contract";

export type TClock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export const browserClock: TClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number)
};

export type TSessionSocket = {
  send: (data: Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
};

export type TLiveChunk = {
  seq: number;
  keyframe: boolean;
  timestampUs: bigint;
  data: Uint8Array;
};

export type TLiveDecoderPort = {
  configure: (config: TVideoConfig) => void;
  // false when the chunk was dropped (no config yet, waiting for a keyframe, queue overflow)
  decode: (chunk: TLiveChunk) => boolean;
  readonly decodeQueueSize: number;
  close: () => void;
};

export type TViewerPhase =
  | "connecting"
  | "awaiting_ready"
  | "live"
  | "ending"
  | "ended"
  | "disconnected"
  | "failed";

export type TViewerError = {
  code: TControlErrorCode | "client_error";
  message: string;
};

export type TViewerState = {
  phase: TViewerPhase;
  sessionId?: string;
  expiresAt?: string;
  inputEnabled: boolean;
  hidden: "login" | "policy" | null;
  secondsLeft?: number;
  policy?: TSessionPolicy;
  videoConfig?: TVideoConfig;
  endReason?: TSessionEndReason;
  endMessage?: string;
  error?: TViewerError;
  closeCode?: number;
  degraded: boolean;
  droppedFrames: number;
  recordingLoss: boolean;
};

export const initialViewerState: TViewerState = {
  phase: "connecting",
  inputEnabled: false,
  hidden: null,
  degraded: false,
  droppedFrames: 0,
  recordingLoss: false
};
