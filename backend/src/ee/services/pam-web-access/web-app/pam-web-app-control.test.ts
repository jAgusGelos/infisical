import {
  decodeFrame,
  decodeJsonPayload,
  FLAG_ORIGIN_BACKEND,
  FrameType,
  MAX_DOWNSTREAM_PAYLOAD,
  TControlDown,
  TSessionEndReason
} from "@app/ee/services/pam-web-app/contract";

import { SessionEndReason, TerminalServerMessageType } from "../pam-web-access-types";
import {
  mapSessionEndReason,
  sendWebAppErrorAndClose,
  sendWebAppServerMessage,
  sendWebAppSessionEndAndClose,
  TControlSocket
} from "./pam-web-app-control";

vi.mock("@app/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const createSocket = (readyState = 1) => {
  const sends: { data: unknown; binary: boolean }[] = [];
  const closes: (number | undefined)[] = [];
  const socket: TControlSocket = {
    readyState,
    OPEN: 1,
    send: (data, options, cb) => {
      sends.push({ data, binary: options.binary });
      cb?.();
    },
    close: (code) => {
      closes.push(code);
    }
  };
  return { socket, sends, closes };
};

const decodeControl = (data: unknown) => {
  expect(data).toBeInstanceOf(Uint8Array);
  const frame = decodeFrame(data as Uint8Array, MAX_DOWNSTREAM_PAYLOAD);
  expect(frame.type).toBe(FrameType.Control);
  expect(frame.flags).toBe(FLAG_ORIGIN_BACKEND);
  expect(frame.seq).toBe(0);
  return decodeJsonPayload<TControlDown>(frame.payload);
};

const EXPECTED_REASONS: Record<SessionEndReason, TSessionEndReason> = {
  [SessionEndReason.SessionCompleted]: "expired",
  [SessionEndReason.UserQuit]: "user_end",
  [SessionEndReason.ConnectionLost]: "error",
  [SessionEndReason.SetupFailed]: "error",
  [SessionEndReason.IdleTimeout]: "idle",
  [SessionEndReason.SessionLimitReached]: "error",
  [SessionEndReason.ApprovalRevoked]: "policy_change",
  [SessionEndReason.Terminated]: "admin_terminated",
  [SessionEndReason.ReplyTooLarge]: "error"
};

describe("web-app control translation", () => {
  const reasons = Object.values(SessionEndReason);

  test("covers every SessionEndReason", () => {
    expect(Object.keys(EXPECTED_REASONS).sort()).toEqual([...reasons].sort());
  });

  test.each(reasons)("sendSessionEndAndClose(%s) sends exactly one binary session_ending frame", (reason) => {
    const { socket, sends, closes } = createSocket();
    sendWebAppSessionEndAndClose(socket, reason);
    expect(sends).toHaveLength(1);
    expect(sends[0].binary).toBe(true);
    expect(typeof sends[0].data).not.toBe("string");
    expect(decodeControl(sends[0].data)).toEqual({
      kind: "session_ending",
      reason: EXPECTED_REASONS[reason],
      message: reason
    });
    expect(mapSessionEndReason(reason)).toBe(EXPECTED_REASONS[reason]);
    expect(closes).toEqual([1000]);
  });

  test.each(reasons)("sendSessionEnd(%s) sends exactly one binary session_ending frame without closing", (reason) => {
    const { socket, sends, closes } = createSocket();
    sendWebAppServerMessage(socket, { type: TerminalServerMessageType.SessionEnd, reason });
    expect(sends).toHaveLength(1);
    expect(sends[0].binary).toBe(true);
    expect(decodeControl(sends[0].data)).toMatchObject({
      kind: "session_ending",
      reason: EXPECTED_REASONS[reason]
    });
    expect(closes).toEqual([]);
  });

  test.each([TerminalServerMessageType.Ready, TerminalServerMessageType.Output] as const)(
    "drops %s messages instead of sending text",
    (type) => {
      const { socket, sends } = createSocket();
      sendWebAppServerMessage(socket, { type, data: "Goodbye\n" });
      expect(sends).toHaveLength(0);
    }
  );

  test.each(["tunnel_failed", "internal"] as const)(
    "setup failure %s sends a fatal CONTROL error and closes",
    (code) => {
      const { socket, sends, closes } = createSocket();
      sendWebAppErrorAndClose(socket, code, SessionEndReason.SetupFailed);
      expect(sends).toHaveLength(1);
      expect(decodeControl(sends[0].data)).toEqual({
        kind: "error",
        code,
        message: SessionEndReason.SetupFailed,
        fatal: true
      });
      expect(closes).toEqual([1011]);
    }
  );

  test("a socket that is no longer open is closed without sending", () => {
    const { socket, sends, closes } = createSocket(3);
    sendWebAppSessionEndAndClose(socket, SessionEndReason.IdleTimeout);
    expect(sends).toHaveLength(0);
    expect(closes).toEqual([1000]);
  });
});
