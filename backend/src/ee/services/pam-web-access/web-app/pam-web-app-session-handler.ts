import net from "node:net";

import type WebSocket from "ws";

import { logger } from "@app/lib/logger";

import { TSessionContext, TSessionHandlerResult } from "../pam-web-access-types";
import { createWebAppRelay, TRelayWebSocket, TWsRawData } from "./pam-web-app-relay";

const WEB_APP_TCP_CONNECT_TIMEOUT_MS = 30_000;

export const toRelayWebSocket = (socket: WebSocket): TRelayWebSocket => ({
  get bufferedAmount() {
    return socket.bufferedAmount;
  },
  isOpen: () => socket.readyState === socket.OPEN,
  send: (data, cb) => socket.send(data, { binary: true }, cb),
  close: (code) => socket.close(code),
  onMessage: (listener) => {
    socket.on("message", (data: TWsRawData, isBinary: boolean) => listener(data, isBinary));
  },
  onClose: (listener) => {
    socket.on("close", () => listener());
  }
});

export const handleWebAppSession = async (ctx: TSessionContext): Promise<TSessionHandlerResult> => {
  const { socket, rawSocket, relayPort, sessionId, onCleanup, earlyMessages, releaseEarlyBuffer } = ctx;

  const tcpSocket = new net.Socket();
  let settled = false;

  if (!rawSocket) {
    logger.warn(
      `web-app session: no underlying socket available, upstream backpressure cannot pause the viewer [sessionId=${sessionId}]`
    );
  }

  return new Promise<TSessionHandlerResult>((resolve, reject) => {
    let onViewerClose: () => void = () => {};

    function failConnect(err: Error) {
      if (settled) return;
      settled = true;
      socket.removeListener("close", onViewerClose);
      tcpSocket.destroy();
      onCleanup();
      reject(err);
    }

    onViewerClose = () => failConnect(new Error("Web App viewer disconnected before relay setup"));

    const connectTimeout = setTimeout(() => {
      logger.error(`web-app session: relay connect timed out [sessionId=${sessionId}]`);
      failConnect(new Error("Web App relay connection timed out"));
    }, WEB_APP_TCP_CONNECT_TIMEOUT_MS);

    tcpSocket.once("connect", () => {
      clearTimeout(connectTimeout);
      if (settled) return;
      settled = true;
      socket.removeListener("close", onViewerClose);
      tcpSocket.removeAllListeners("error");
      tcpSocket.setNoDelay(true);

      releaseEarlyBuffer();
      const relay = createWebAppRelay({
        sessionId,
        ws: toRelayWebSocket(socket),
        rawSocket,
        tunnel: tcpSocket,
        earlyMessages: earlyMessages.splice(0, earlyMessages.length),
        onTerminate: () => onCleanup()
      });

      resolve({
        cleanup: async () => {
          relay.teardown();
        }
      });
    });

    tcpSocket.once("error", (err) => {
      clearTimeout(connectTimeout);
      logger.error(err, `web-app session: failed to connect to relay [sessionId=${sessionId}]`);
      failConnect(err);
    });

    socket.once("close", onViewerClose);
    tcpSocket.connect(relayPort, "127.0.0.1");
  });
};
