import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from "react";

import { TPamAccount } from "@app/hooks/api/pam";

import { InputBatcher } from "./input/InputBatcher";
import { mapToFramebuffer, modsOf, normalizeWheel } from "./input/mapping";
import { canSendInput } from "./session/controlReducer";
import { useWebAppSession } from "./useWebAppSession";
import { WebAppOverlays } from "./WebAppOverlays";
import { WebAppStatusBar } from "./WebAppStatusBar";

type Props = {
  account: TPamAccount;
  reason?: string;
  mfaSessionId?: string;
};

const POINTER_BUTTONS = new Set([0, 1, 2]);

const DEFAULT_FRAMEBUFFER = { width: 1280, height: 720 };

const IME_PROCESS_KEY_CODE = 229;

export const WebAppViewer = ({ account, reason, mfaSessionId }: Props) => {
  const { canvasRef, state, reconnectStatus, sendInput, endSession, reconnect } = useWebAppSession({
    accountId: account.id,
    reason,
    mfaSessionId
  });
  const sinkRef = useRef<HTMLTextAreaElement | null>(null);
  const batcherRef = useRef<InputBatcher | null>(null);
  if (!batcherRef.current) batcherRef.current = new InputBatcher(sendInput);
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
    if (event.nativeEvent.isComposing || event.keyCode === IME_PROCESS_KEY_CODE) return;
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
        <WebAppOverlays state={state} reconnectStatus={reconnectStatus} onReconnect={reconnect} />
      </div>
      <WebAppStatusBar
        state={state}
        reconnectStatus={reconnectStatus}
        accountName={account.name}
        onEndSession={endSession}
      />
    </div>
  );
};
