import {
  createFrameReader,
  encodeFrame,
  FRAME_HEADER_SIZE,
  FRAME_VERSION,
  FrameError,
  isUpstreamType,
  MAX_DOWNSTREAM_PAYLOAD,
  MAX_UPSTREAM_PAYLOAD,
  TControlDown,
  TControlErrorCode
} from "@app/ee/services/pam-web-app/contract";
import { logger } from "@app/lib/logger";

import { TEarlyBufferedMsg } from "../pam-web-access-types";
import { buildBackendControlFrame, WS_CLOSE_INTERNAL_ERROR, WS_CLOSE_POLICY_VIOLATION } from "./pam-web-app-control";

export const DOWNSTREAM_HIGH_WATER_MARK = 1024 * 1024;
export const DOWNSTREAM_STALL_THRESHOLD = 8 * 1024 * 1024;
export const DOWNSTREAM_STALL_TIMEOUT_MS = 10_000;
export const DOWNSTREAM_CHECK_INTERVAL_MS = 50;
export const UPSTREAM_DRAIN_TIMEOUT_MS = 10_000;

export type TWsRawData = Buffer | ArrayBuffer | Buffer[];

export type TRelayWebSocket = {
  readonly bufferedAmount: number;
  isOpen: () => boolean;
  send: (data: Uint8Array, cb: (err?: Error) => void) => void;
  close: (code: number) => void;
  onMessage: (listener: (data: TWsRawData, isBinary: boolean) => void) => void;
  onClose: (listener: () => void) => void;
};

export type TRelayRawSocket = {
  pause: () => unknown;
  resume: () => unknown;
};

export type TRelayTunnel = {
  write: (data: Uint8Array) => boolean;
  pause: () => unknown;
  resume: () => unknown;
  destroy: () => unknown;
  on: ((event: "data", listener: (chunk: Buffer) => void) => unknown) &
    ((event: "drain" | "close", listener: () => void) => unknown) &
    ((event: "error", listener: (err: Error) => void) => unknown);
};

type TTimerHandle = ReturnType<typeof setTimeout>;

export type TRelayTimers = {
  setTimeout: (fn: () => void, ms: number) => TTimerHandle;
  clearTimeout: (handle: TTimerHandle) => void;
  setInterval: (fn: () => void, ms: number) => TTimerHandle;
  clearInterval: (handle: TTimerHandle) => void;
  now: () => number;
};

export enum WebAppRelayCloseReason {
  ProtocolError = "protocol_error",
  TunnelFailed = "tunnel_failed",
  DownstreamStalled = "downstream_stalled",
  DownstreamDecodeError = "downstream_decode_error",
  SendFailed = "send_failed",
  TunnelClosed = "tunnel_closed",
  ViewerClosed = "viewer_closed",
  Cleanup = "cleanup"
}

export type TWebAppRelayDeps = {
  sessionId: string;
  ws: TRelayWebSocket;
  rawSocket?: TRelayRawSocket;
  tunnel: TRelayTunnel;
  earlyMessages?: TEarlyBufferedMsg[];
  onTerminate: (reason: WebAppRelayCloseReason) => void;
  timers?: TRelayTimers;
};

const defaultTimers: TRelayTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
  now: () => Date.now()
};

const toBuffer = (raw: TWsRawData): Buffer => {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
};

// Returns the reason a single upstream WS message violates CONTRACTS 1.5, or null when it may be forwarded.
export const validateUpstreamMessage = (buf: Uint8Array, isBinary: boolean): string | null => {
  if (!isBinary) return "text messages are not allowed";
  if (buf.length < FRAME_HEADER_SIZE) return "frame shorter than the header";
  const view = new DataView(buf.buffer, buf.byteOffset, FRAME_HEADER_SIZE);
  if (view.getUint8(0) !== FRAME_VERSION) return "unsupported frame version";
  const length = view.getUint32(16);
  if (length > MAX_UPSTREAM_PAYLOAD) return `payload exceeds ${MAX_UPSTREAM_PAYLOAD} bytes`;
  if (length !== buf.length - FRAME_HEADER_SIZE) return "frame length does not match message size";
  if (!isUpstreamType(view.getUint8(1))) return "frame type is not an upstream type";
  return null;
};

export const createWebAppRelay = ({
  sessionId,
  ws,
  rawSocket,
  tunnel,
  earlyMessages = [],
  onTerminate,
  timers = defaultTimers
}: TWebAppRelayDeps) => {
  const startedAt = timers.now();
  const reader = createFrameReader(MAX_DOWNSTREAM_PAYLOAD);

  let closed = false;
  let rawSocketPaused = false;
  let tunnelPaused = false;
  let drainTimer: TTimerHandle | null = null;
  let stallTimer: TTimerHandle | null = null;
  let checkInterval: TTimerHandle | null = null;

  const elapsedUs = () => BigInt(Math.max(0, timers.now() - startedAt)) * BigInt(1000);

  const clearTimers = () => {
    if (drainTimer) timers.clearTimeout(drainTimer);
    if (stallTimer) timers.clearTimeout(stallTimer);
    if (checkInterval) timers.clearInterval(checkInterval);
    drainTimer = null;
    stallTimer = null;
    checkInterval = null;
  };

  const teardown = (reason: WebAppRelayCloseReason) => {
    if (closed) return;
    closed = true;
    clearTimers();
    // A paused upgrade socket would never deliver the WS close handshake.
    if (rawSocketPaused && rawSocket) {
      rawSocketPaused = false;
      rawSocket.resume();
    }
    try {
      tunnel.destroy();
    } catch (err) {
      logger.debug(err, `web-app relay: error destroying tunnel [sessionId=${sessionId}]`);
    }
    // The owner already knows when it asked for the teardown; calling back would re-enter its cleanup.
    if (reason !== WebAppRelayCloseReason.Cleanup) onTerminate(reason);
  };

  const closeWs = (code: number) => {
    try {
      ws.close(code);
    } catch (err) {
      logger.debug(err, `web-app relay: error closing websocket [sessionId=${sessionId}]`);
    }
  };

  const sendControlAndClose = (control: TControlDown, closeCode: number) => {
    if (!ws.isOpen()) {
      closeWs(closeCode);
      return;
    }
    try {
      ws.send(buildBackendControlFrame(control, elapsedUs()), () => closeWs(closeCode));
    } catch {
      closeWs(closeCode);
    }
  };

  const failWithControlError = (
    code: TControlErrorCode,
    message: string,
    closeCode: number,
    reason: WebAppRelayCloseReason
  ) => {
    if (closed) return;
    teardown(reason);
    sendControlAndClose({ kind: "error", code, message, fatal: true }, closeCode);
  };

  const onDrainTimeout = () => {
    drainTimer = null;
    logger.warn(
      { sessionId, reason: WebAppRelayCloseReason.TunnelFailed },
      `web-app relay: tunnel stayed undrained for ${UPSTREAM_DRAIN_TIMEOUT_MS}ms [sessionId=${sessionId}]`
    );
    failWithControlError(
      "tunnel_failed",
      "The connection to the gateway stopped accepting data",
      WS_CLOSE_INTERNAL_ERROR,
      WebAppRelayCloseReason.TunnelFailed
    );
  };

  const handleUpstreamMessage = (raw: TWsRawData, isBinary: boolean) => {
    if (closed) return;
    const buf = toBuffer(raw);
    const violation = validateUpstreamMessage(buf, isBinary);
    if (violation) {
      logger.warn(
        { sessionId, reason: WebAppRelayCloseReason.ProtocolError, violation },
        `web-app relay: rejected upstream message (${violation}) [sessionId=${sessionId}]`
      );
      failWithControlError(
        "protocol_error",
        violation,
        WS_CLOSE_POLICY_VIOLATION,
        WebAppRelayCloseReason.ProtocolError
      );
      return;
    }

    let accepted: boolean;
    try {
      accepted = tunnel.write(buf);
    } catch (err) {
      logger.warn({ sessionId, err }, `web-app relay: tunnel write failed [sessionId=${sessionId}]`);
      failWithControlError(
        "tunnel_failed",
        "The connection to the gateway failed",
        WS_CLOSE_INTERNAL_ERROR,
        WebAppRelayCloseReason.TunnelFailed
      );
      return;
    }

    if (!accepted && !drainTimer) {
      if (rawSocket && !rawSocketPaused) {
        rawSocketPaused = true;
        rawSocket.pause();
      }
      drainTimer = timers.setTimeout(onDrainTimeout, UPSTREAM_DRAIN_TIMEOUT_MS);
    }
  };

  const onTunnelDrain = () => {
    if (closed) return;
    if (drainTimer) {
      timers.clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (rawSocketPaused && rawSocket) {
      rawSocketPaused = false;
      rawSocket.resume();
    }
  };

  const onStall = () => {
    stallTimer = null;
    if (closed) return;
    logger.warn(
      { sessionId, reason: WebAppRelayCloseReason.DownstreamStalled, bufferedAmount: ws.bufferedAmount },
      `web-app relay: viewer stopped reading for ${DOWNSTREAM_STALL_TIMEOUT_MS}ms, closing websocket [sessionId=${sessionId}]`
    );
    teardown(WebAppRelayCloseReason.DownstreamStalled);
    closeWs(WS_CLOSE_INTERNAL_ERROR);
  };

  const checkDownstream = () => {
    if (closed) return;
    const buffered = ws.bufferedAmount;

    if (buffered > DOWNSTREAM_STALL_THRESHOLD) {
      if (!stallTimer) stallTimer = timers.setTimeout(onStall, DOWNSTREAM_STALL_TIMEOUT_MS);
    } else if (stallTimer) {
      timers.clearTimeout(stallTimer);
      stallTimer = null;
    }

    if (buffered > DOWNSTREAM_HIGH_WATER_MARK) {
      if (!tunnelPaused) {
        tunnelPaused = true;
        tunnel.pause();
      }
      if (!checkInterval) checkInterval = timers.setInterval(checkDownstream, DOWNSTREAM_CHECK_INTERVAL_MS);
      return;
    }

    if (tunnelPaused) {
      tunnelPaused = false;
      tunnel.resume();
    }
    if (checkInterval) {
      timers.clearInterval(checkInterval);
      checkInterval = null;
    }
  };

  const onDownstreamSent = (err?: Error) => {
    if (err) {
      if (closed) return;
      logger.warn({ sessionId, err }, `web-app relay: websocket send failed [sessionId=${sessionId}]`);
      teardown(WebAppRelayCloseReason.SendFailed);
      closeWs(WS_CLOSE_INTERNAL_ERROR);
      return;
    }
    checkDownstream();
  };

  const onTunnelData = (chunk: Buffer) => {
    if (closed) return;
    let frames;
    try {
      frames = reader.push(chunk);
    } catch (err) {
      const code = err instanceof FrameError ? err.code : "unknown";
      logger.warn(
        { sessionId, reason: WebAppRelayCloseReason.DownstreamDecodeError, code },
        `web-app relay: invalid frame from gateway (${code}) [sessionId=${sessionId}]`
      );
      failWithControlError(
        "internal",
        "The gateway sent an invalid stream",
        WS_CLOSE_INTERNAL_ERROR,
        WebAppRelayCloseReason.DownstreamDecodeError
      );
      return;
    }

    if (!ws.isOpen()) return;
    for (const frame of frames) {
      // Re-encoding is byte-identical: the reader enforces version 1 and keeps every header field.
      ws.send(encodeFrame(frame), onDownstreamSent);
    }
    checkDownstream();
  };

  const onTunnelClose = () => {
    if (closed) return;
    logger.info(
      { sessionId, reason: WebAppRelayCloseReason.TunnelClosed },
      `web-app relay: tunnel closed [sessionId=${sessionId}]`
    );
    teardown(WebAppRelayCloseReason.TunnelClosed);
    closeWs(1000);
  };

  const onTunnelError = (err: Error) => {
    if (closed) return;
    logger.warn(
      { sessionId, reason: WebAppRelayCloseReason.TunnelFailed, errMessage: err.message },
      `web-app relay: tunnel error [sessionId=${sessionId}]`
    );
    failWithControlError(
      "tunnel_failed",
      "The connection to the gateway failed",
      WS_CLOSE_INTERNAL_ERROR,
      WebAppRelayCloseReason.TunnelFailed
    );
  };

  const onViewerClose = () => {
    if (closed) return;
    logger.info(
      { sessionId, reason: WebAppRelayCloseReason.ViewerClosed },
      `web-app relay: viewer websocket closed [sessionId=${sessionId}]`
    );
    teardown(WebAppRelayCloseReason.ViewerClosed);
  };

  // Early messages are replayed synchronously before the listener is attached, so their order is kept.
  for (const msg of earlyMessages) {
    handleUpstreamMessage(msg.data, msg.isBinary);
  }

  ws.onMessage(handleUpstreamMessage);
  ws.onClose(onViewerClose);
  tunnel.on("data", onTunnelData);
  tunnel.on("drain", onTunnelDrain);
  tunnel.on("close", onTunnelClose);
  tunnel.on("error", onTunnelError);

  return {
    teardown: () => teardown(WebAppRelayCloseReason.Cleanup),
    isClosed: () => closed
  };
};
