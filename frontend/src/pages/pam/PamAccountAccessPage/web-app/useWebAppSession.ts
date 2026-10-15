import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";

import { apiRequest } from "@app/config/request";
import { LIVE_CODEC_PROBES, type TInputEvent } from "@app/lib/pam-web-app/contract";

import { createCanvasPainter } from "./decode/canvasPainter";
import { LiveDecoder } from "./decode/LiveDecoder";
import { browserClock, initialViewerState, type TViewerState } from "./session/types";
import { WebAppSessionClient } from "./session/WebAppSessionClient";
import { getDevMockWsUrl } from "./devMock";

const CLIENT_NAME = "infisical-web/1.0";

export const buildWebAppSocketUrl = (accountId: string, ticket: string) => {
  const { protocol, host } = window.location;
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/api/v1/pam/accounts/${accountId}/web-access?ticket=${encodeURIComponent(ticket)}`;
};

const isSupported = async (codec: string) => {
  if (typeof VideoDecoder === "undefined") return false;
  try {
    const { supported } = await VideoDecoder.isConfigSupported({ codec });
    return Boolean(supported);
  } catch {
    return false;
  }
};

const ticketErrorMessage = (err: unknown) => {
  if (axios.isAxiosError(err)) {
    const apiMessage = (err.response?.data as { message?: string } | undefined)?.message;
    if (apiMessage) return apiMessage;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Unable to start the session.";
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
        socket.close(1000, "viewer closed");
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
      fail("This browser cannot decode the session stream.", "no_decoder");
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
        if (isCurrent()) fail(ticketErrorMessage(err));
        return;
      }
    }
    if (!isCurrent() || !canvasRef.current) return;

    const paint = createCanvasPainter(canvasRef.current);
    const socket = new WebSocket(url);
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
        // VP9 is probed and advertised once the fallback path exists; VS1 is H.264 only.
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
