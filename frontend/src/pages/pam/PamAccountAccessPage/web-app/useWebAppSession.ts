import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";

import { apiRequest } from "@app/config/request";
import { LIVE_CODEC_PROBES, type TInputEvent } from "@app/lib/pam-web-app/contract";

import { createCanvasPainter } from "./decode/canvasPainter";
import { LiveDecoder } from "./decode/LiveDecoder";
import { ReconnectController, type TReconnectStatus } from "./session/ReconnectController";
import { browserClock, initialViewerState, type TViewerState } from "./session/types";
import { WebAppSessionClient, WS_NORMAL_CLOSURE } from "./session/WebAppSessionClient";
import { ERROR_COPY } from "./copy";
import { getDevMockWsUrl } from "./devMock";
import { toSameOriginWsUrl } from "./socketUrl";

const CLIENT_NAME = "infisical-web/1.0";

const VP9_CODEC_PREFIX = "vp09.";

const buildWebAppSocketUrl = (accountId: string, ticket: string) =>
  toSameOriginWsUrl(
    `/api/v1/pam/accounts/${accountId}/web-access?ticket=${encodeURIComponent(ticket)}`
  );

const isSupported = async (codec: string) => {
  if (typeof VideoDecoder === "undefined") return false;
  try {
    const { supported } = await VideoDecoder.isConfigSupported({ codec });
    return Boolean(supported);
  } catch {
    return false;
  }
};

const probeDecoders = async () => {
  const [vp9, h264] = await Promise.all([
    isSupported(LIVE_CODEC_PROBES.vp9),
    isSupported(LIVE_CODEC_PROBES.h264)
  ]);
  return { vp9, h264 };
};

const connectErrorMessage = (err: unknown) => {
  if (axios.isAxiosError<{ message?: string }>(err) && err.response?.data?.message) {
    return err.response.data.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return ERROR_COPY.client_error;
};

// A 4xx (expired MFA, revoked access) needs the user; a network error or 5xx may clear within the grace period.
const isRetryableTicketError = (err: unknown) =>
  axios.isAxiosError(err) && (!err.response || err.response.status >= 500);

type Options = {
  accountId: string;
  reason?: string;
  mfaSessionId?: string;
};

export const useWebAppSession = ({ accountId, reason, mfaSessionId }: Options) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<WebAppSessionClient | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const generationRef = useRef(0);
  // The live codec cannot change within a link, so a VP9 decode failure falls back to H.264 for the page lifetime.
  const vp9DisabledRef = useRef(false);
  const reconnectRef = useRef<ReconnectController | null>(null);
  const reconnectStatusRef = useRef<TReconnectStatus>("idle");
  const [state, setState] = useState<TViewerState>(initialViewerState);
  const [reconnectStatus, setReconnectStatus] = useState<TReconnectStatus>("idle");

  const updateReconnectStatus = useCallback((status: TReconnectStatus) => {
    reconnectStatusRef.current = status;
    setReconnectStatus(status);
  }, []);

  const teardown = useCallback(() => {
    clientRef.current?.dispose();
    clientRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close(WS_NORMAL_CLOSURE, "viewer closed");
      }
    }
  }, []);

  const applyState = useCallback((next: TViewerState) => {
    setState(next);
    if (next.phase === "disconnected") reconnectRef.current?.onDisconnected();
    if (next.phase === "live") reconnectRef.current?.onLive();
  }, []);

  const connect = useCallback(async () => {
    teardown();
    generationRef.current += 1;
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    setState(initialViewerState);

    const fail = (message: string, code: "client_error" | "no_decoder" = "client_error") =>
      applyState({ ...initialViewerState, phase: "failed", error: { code, message } });

    const probed = await probeDecoders();
    if (!isCurrent()) return;
    const decoders = { vp9: probed.vp9 && !vp9DisabledRef.current, h264: probed.h264 };
    if (!decoders.vp9 && !decoders.h264) {
      fail(ERROR_COPY.no_decoder, "no_decoder");
      return;
    }

    let url = getDevMockWsUrl();
    if (!url) {
      try {
        const { data } = await apiRequest.post<{ ticket: string }>(
          `/api/v1/pam/accounts/${accountId}/web-access-ticket`,
          { reason, mfaSessionId }
        );
        url = buildWebAppSocketUrl(accountId, data.ticket);
      } catch (err) {
        if (!isCurrent()) return;
        if (reconnectStatusRef.current === "waiting" && isRetryableTicketError(err)) {
          applyState({ ...initialViewerState, phase: "disconnected" });
        } else {
          updateReconnectStatus("idle");
          fail(connectErrorMessage(err));
        }
        return;
      }
    }
    if (!isCurrent() || !canvasRef.current) return;

    const paint = createCanvasPainter(canvasRef.current);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      fail(connectErrorMessage(err));
      return;
    }
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    const decoder = new LiveDecoder({
      onFrame: paint,
      onNeedKeyframe: () => clientRef.current?.requestKeyframe(),
      onFatalError: (codec) => {
        if (!isCurrent()) return;
        if (codec.startsWith(VP9_CODEC_PREFIX) && !vp9DisabledRef.current) {
          vp9DisabledRef.current = true;
          connect();
          return;
        }
        clientRef.current?.abort({
          code: "client_error",
          message: "The session video could not be decoded in this browser."
        });
      }
    });
    const client = new WebAppSessionClient({
      socket: {
        send: (data) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data);
        },
        close: (code, closeReason) => socket.close(code, closeReason)
      },
      decoder,
      clock: browserClock,
      hello: {
        protocol: 1,
        client: CLIENT_NAME,
        decoders,
        viewport: {
          width: Math.round(window.innerWidth),
          height: Math.round(window.innerHeight),
          devicePixelRatio: window.devicePixelRatio
        }
      },
      onStateChange: (next) => {
        if (isCurrent()) applyState(next);
      }
    });
    clientRef.current = client;

    socket.onopen = () => {
      client.start();
      if (document.hidden) client.sendControl({ kind: "visibility", hidden: true });
    };
    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) =>
      client.handleMessage(event.data);
    socket.onclose = (event) => client.handleClose(event.code);
  }, [accountId, reason, mfaSessionId, teardown, applyState]);

  const connectRef = useRef(connect);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    const controller = new ReconnectController({
      clock: browserClock,
      connect: () => connectRef.current(),
      onStatusChange: updateReconnectStatus
    });
    reconnectRef.current = controller;
    const onVisibilityChange = () =>
      clientRef.current?.sendControl({ kind: "visibility", hidden: document.hidden });
    document.addEventListener("visibilitychange", onVisibilityChange);
    connectRef.current();
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      controller.stop();
      reconnectRef.current = null;
      generationRef.current += 1;
      teardown();
    };
  }, [connect, teardown, updateReconnectStatus]);

  const sendInput = useCallback(
    (events: TInputEvent[]) => clientRef.current?.sendInput(events) ?? false,
    []
  );

  const endSession = useCallback(() => clientRef.current?.endSession(), []);

  const reconnect = useCallback(() => {
    reconnectRef.current?.stop();
    updateReconnectStatus("idle");
    connectRef.current();
  }, [updateReconnectStatus]);

  return { canvasRef, state, reconnectStatus, sendInput, endSession, reconnect };
};
