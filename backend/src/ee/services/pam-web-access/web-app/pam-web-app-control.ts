import {
  encodeFrame,
  encodeJsonPayload,
  FLAG_ORIGIN_BACKEND,
  FrameType,
  TControlDown,
  TControlErrorCode,
  TSessionEndReason
} from "@app/ee/services/pam-web-app/contract";
import { logger } from "@app/lib/logger";

import { SessionEndReason, TerminalServerMessageType, TWebSocketServerMessage } from "../pam-web-access-types";

// Web App viewers speak only binary CONTRACTS frames (text is a protocol error), so every message the
// backend itself originates goes out as a CONTROL frame flagged ORIGIN_BACKEND with seq 0 (CONTRACTS 1.2, 1.4).

export const WS_CLOSE_NORMAL = 1000;
export const WS_CLOSE_POLICY_VIOLATION = 1008;
export const WS_CLOSE_INTERNAL_ERROR = 1011;

export type TControlSocket = {
  readonly readyState: number;
  readonly OPEN: number;
  send: (data: Uint8Array, options: { binary: boolean }, cb?: (err?: Error) => void) => void;
  close: (code?: number) => void;
};

export const buildBackendControlFrame = (control: TControlDown, timestampUs = BigInt(0)): Uint8Array =>
  encodeFrame({
    type: FrameType.Control,
    flags: FLAG_ORIGIN_BACKEND,
    seq: 0,
    timestampUs,
    payload: encodeJsonPayload(control)
  });

const SESSION_END_REASON_MAP: Partial<Record<SessionEndReason, TSessionEndReason>> = {
  [SessionEndReason.IdleTimeout]: "idle",
  [SessionEndReason.SessionCompleted]: "expired",
  [SessionEndReason.Terminated]: "admin_terminated",
  [SessionEndReason.ApprovalRevoked]: "policy_change",
  [SessionEndReason.UserQuit]: "user_end"
};

export const mapSessionEndReason = (reason: SessionEndReason): TSessionEndReason =>
  SESSION_END_REASON_MAP[reason] ?? "error";

export const buildSessionEndingControl = (reason: SessionEndReason): TControlDown => ({
  kind: "session_ending",
  reason: mapSessionEndReason(reason),
  message: reason
});

const sendControl = (socket: TControlSocket, control: TControlDown, closeCode?: number) => {
  if (socket.readyState !== socket.OPEN) {
    if (closeCode !== undefined) socket.close(closeCode);
    return;
  }
  try {
    socket.send(buildBackendControlFrame(control), { binary: true }, () => {
      if (closeCode !== undefined) socket.close(closeCode);
    });
  } catch (err) {
    logger.error(err, "web-app session: failed to send control frame");
    if (closeCode !== undefined) socket.close(closeCode);
  }
};

// Translates the service's terminal-style messages: only session_end has a CONTROL equivalent; ready and
// output messages have no meaning on this wire and are dropped.
export const sendWebAppServerMessage = (socket: TControlSocket, message: TWebSocketServerMessage) => {
  if (message.type !== TerminalServerMessageType.SessionEnd) return;
  sendControl(socket, buildSessionEndingControl(message.reason));
};

export const sendWebAppSessionEndAndClose = (socket: TControlSocket, reason: SessionEndReason) => {
  sendControl(socket, buildSessionEndingControl(reason), WS_CLOSE_NORMAL);
};

export const sendWebAppErrorAndClose = (
  socket: TControlSocket,
  code: Extract<TControlErrorCode, "tunnel_failed" | "internal">,
  message: string
) => {
  sendControl(socket, { kind: "error", code, message, fatal: true }, WS_CLOSE_INTERNAL_ERROR);
};
