import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";

import { apiRequest } from "@app/config/request";
import { LIVE_CODEC_PROBES, type TInputEvent } from "@app/lib/pam-web-app/contract";

import { createCanvasPainter } from "./decode/canvasPainter";
import { LiveDecoder } from "./decode/LiveDecoder";
import { browserClock, initialViewerState, type TViewerState } from "./session/types";
import { WebAppSessionClient, WS_NORMAL_CLOSURE } from "./session/WebAppSessionClient";
import { ERROR_COPY } from "./copy";
import { getDevMockWsUrl } from "./devMock";
import { toSameOriginWsUrl } from "./socketUrl";

const CLIENT_NAME = "infisical-web/1.0";

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

const connectErrorMessage = (err: unknown) => {
  if (axios.isAxiosError<{ message?: string }>(err) && err.response?.data?.message) {
    return err.response.data.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return ERROR_COPY.client_error;
};

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
  const [state, setState] = useState<TViewerState>(initialViewerState);

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

  const connect = useCallback(async () => {
    teardown();
    generationRef.current += 1;
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    setState(initialViewerState);

    const fail = (message: string, code: "client_error" | "no_decoder" = "client_error") =>
      setState({ ...initialViewerState, phase: "failed", error: { code, message } });

    const h264 = await isSupported(LIVE_CODEC_PROBES.h264);
    if (!isCurrent()) return;
    if (!h264) {
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
        if (isCurrent()) fail(connectErrorMessage(err));
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
      onNeedKeyframe: () => clientRef.current?.requestKeyframe()
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
        // Not advertised until the viewer has a VP9 fallback path, even where the browser could decode it.
        decoders: { vp9: false, h264 },
        viewport: {
          width: Math.round(window.innerWidth),
          height: Math.round(window.innerHeight),
          devicePixelRatio: window.devicePixelRatio
        }
      },
      onStateChange: (next) => {
        if (isCurrent()) setState(next);
      }
    });
    clientRef.current = client;

    socket.onopen = () => client.start();
    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) =>
      client.handleMessage(event.data);
    socket.onclose = (event) => client.handleClose(event.code);
  }, [accountId, reason, mfaSessionId, teardown]);

  useEffect(() => {
    connect();
    return () => {
      generationRef.current += 1;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendInput = useCallback(
    (events: TInputEvent[]) => clientRef.current?.sendInput(events) ?? false,
    []
  );

  const endSession = useCallback(() => clientRef.current?.endSession(), []);

  const reconnect = useCallback(() => {
    connect();
  }, [connect]);

  return { canvasRef, state, sendInput, endSession, reconnect };
};
