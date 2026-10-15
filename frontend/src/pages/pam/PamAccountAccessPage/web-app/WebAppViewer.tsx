import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";

import { ContentLoader } from "@app/components/v2";
import { Button } from "@app/components/v3";
import { TPamAccount } from "@app/hooks/api/pam";

import { DisconnectedScreen } from "../DisconnectedScreen";
import { WebAccessStatusCard } from "../WebAccessStatusCard";
import { InputBatcher } from "./input/InputBatcher";
import { mapToFramebuffer, modsOf, normalizeWheel } from "./input/mapping";
import { canSendInput } from "./session/controlReducer";
import { ERROR_COPY, SESSION_END_COPY } from "./copy";
import { useWebAppSession } from "./useWebAppSession";

type Props = {
  account: TPamAccount;
  reason?: string;
  mfaSessionId?: string;
};

const POINTER_BUTTONS = new Set([0, 1, 2]);

const DEFAULT_FRAMEBUFFER = { width: 1280, height: 720 };

export const WebAppViewer = ({ account, reason, mfaSessionId }: Props) => {
  const { canvasRef, state, sendInput, endSession, reconnect } = useWebAppSession({
    accountId: account.id,
    reason,
    mfaSessionId
  });
  const sinkRef = useRef<HTMLTextAreaElement | null>(null);
  const batcherRef = useRef<InputBatcher | null>(null);
  if (!batcherRef.current) batcherRef.current = new InputBatcher((events) => sendInput(events));
  const batcher = batcherRef.current;

  const stateRef = useRef(state);
  stateRef.current = state;
  const inputAllowed = canSendInput(state);

  useEffect(() => {
    if (!inputAllowed) batcher.clear();
    else sinkRef.current?.focus({ preventScroll: true });
  }, [inputAllowed, batcher]);

  useEffect(() => () => batcher.clear(), [batcher]);

  const toFramebuffer = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const config = stateRef.current.videoConfig;
    if (!canvas || !config || !canSendInput(stateRef.current)) return null;
    return mapToFramebuffer(
      clientX,
      clientY,
      canvas.getBoundingClientRect(),
      config.width,
      config.height
    );
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    // React registers wheel listeners as passive, which would make preventDefault a no-op.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toFramebuffer(event.clientX, event.clientY);
      if (!point?.inside) return;
      const { dx, dy } = normalizeWheel(event, canvas.clientHeight);
      batcher.push({
        t: "wheel",
        dx,
        dy,
        x: point.x,
        y: point.y,
        mods: modsOf(event),
        ts: performance.now()
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batcher]);

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = toFramebuffer(event.clientX, event.clientY);
    if (!point) return;
    batcher.push({
      t: "move",
      x: point.x,
      y: point.y,
      buttons: event.buttons,
      ts: performance.now()
    });
  };

  const handlePointerButton = (event: PointerEvent<HTMLCanvasElement>, action: "down" | "up") => {
    if (!POINTER_BUTTONS.has(event.button)) return;
    if (action === "down") {
      event.preventDefault();
      sinkRef.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const point = toFramebuffer(event.clientX, event.clientY);
    if (!point || (action === "down" && !point.inside)) return;
    batcher.push({
      t: "button",
      action,
      button: event.button,
      x: point.x,
      y: point.y,
      mods: modsOf(event),
      ts: performance.now()
    });
  };

  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>, action: "down" | "up") => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!canSendInput(stateRef.current)) return;
    event.preventDefault();
    batcher.push({
      t: "key",
      action,
      code: event.code,
      key: event.key,
      mods: modsOf(event),
      repeat: event.repeat,
      ts: performance.now()
    });
  };

  const { phase } = state;
  const isConnecting = phase === "connecting" || phase === "awaiting_ready";
  const isLive = phase === "live";

  let statusLabel = "Connecting";
  let statusDotClass = "bg-warning";
  if (isLive) {
    statusLabel = "Connected";
    statusDotClass = "bg-success";
  } else if (phase === "ending") {
    statusLabel = "Ending session";
  } else if (phase === "failed") {
    statusLabel = "Error";
    statusDotClass = "bg-danger";
  } else if (phase === "ended" || phase === "disconnected") {
    statusLabel = "Disconnected";
    statusDotClass = "bg-muted";
  }

  return (
    <div className="flex h-dvh w-screen flex-col bg-background">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <canvas
          ref={canvasRef}
          width={state.videoConfig?.width ?? DEFAULT_FRAMEBUFFER.width}
          height={state.videoConfig?.height ?? DEFAULT_FRAMEBUFFER.height}
          aria-label={`Live session for ${account.name}`}
          className="size-full touch-none object-contain outline-none"
          onPointerMove={handlePointerMove}
          onPointerDown={(event) => handlePointerButton(event, "down")}
          onPointerUp={(event) => handlePointerButton(event, "up")}
          onContextMenu={(event) => event.preventDefault()}
        />
        <textarea
          ref={sinkRef}
          aria-label="Keyboard input for the remote app"
          className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          tabIndex={-1}
          onKeyDown={(event) => handleKey(event, "down")}
          onKeyUp={(event) => handleKey(event, "up")}
          onChange={() => {
            if (sinkRef.current) sinkRef.current.value = "";
          }}
        />
        {isConnecting && (
          <ContentLoader
            text="Starting the remote browser..."
            className="absolute inset-0 z-10 h-full"
          />
        )}
        {state.hidden === "login" && isLive && (
          <ContentLoader text="Signing in..." className="absolute inset-0 z-10 h-full" />
        )}
        {phase === "failed" && (
          <WebAccessStatusCard
            overlay
            tone="danger"
            icon={TriangleAlert}
            title="Session failed"
            description={state.error?.message || ERROR_COPY[state.error?.code ?? "client_error"]}
          >
            <Button variant="pam" isFullWidth onClick={reconnect}>
              Reconnect
            </Button>
          </WebAccessStatusCard>
        )}
        {phase === "ended" && (
          <DisconnectedScreen
            title="Session ended"
            description={state.endMessage || SESSION_END_COPY[state.endReason ?? "error"]}
            onReconnect={reconnect}
          />
        )}
        {phase === "disconnected" && (
          <DisconnectedScreen
            description="The connection to the session was lost."
            onReconnect={reconnect}
          />
        )}
      </div>
      <div className="flex h-[33px] shrink-0 items-center justify-between border-t border-border bg-card px-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span className={`inline-block size-2 rounded-full ${statusDotClass}`} />
          <span className="text-muted">{statusLabel}</span>
          {isLive && (
            <button
              type="button"
              onClick={endSession}
              className="ml-2 text-muted hover:text-danger"
            >
              End session
            </button>
          )}
        </span>
        <span>
          <span className="text-muted">Account:</span>{" "}
          <span className="text-muted">{account.name}</span>
        </span>
      </div>
    </div>
  );
};
