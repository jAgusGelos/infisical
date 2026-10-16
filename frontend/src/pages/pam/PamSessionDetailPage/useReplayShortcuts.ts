import { useEffect, useRef } from "react";

export type TReplayShortcutHandlers = {
  togglePlay: () => void;
  previousRequest: () => void;
  nextRequest: () => void;
  previousFlag: () => void;
  nextFlag: () => void;
};

export const isTypingTarget = (target: EventTarget | null) => {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
};

export const shortcutFor = (
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">
): keyof TReplayShortcutHandlers | null => {
  if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return null;
  switch (e.key) {
    case " ":
      return "togglePlay";
    case "j":
    case "J":
      return "previousRequest";
    case "k":
    case "K":
      return "nextRequest";
    case "[":
      return "previousFlag";
    case "]":
      return "nextFlag";
    default:
      return null;
  }
};

export const useReplayShortcuts = (handlers: TReplayShortcutHandlers) => {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      // Space on a focused button would also click it; the shortcut owns it.
      if (
        action === "togglePlay" &&
        (e.target as { tagName?: string } | null)?.tagName === "BUTTON"
      )
        return;
      e.preventDefault();
      ref.current[action]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
};

// Nearest item strictly before or after the playhead (with a small margin so repeated presses move on).
export const neighbourTime = (times: number[], playheadMs: number, dir: -1 | 1) => {
  const margin = 250;
  if (dir === 1) return times.find((t) => t > playheadMs + margin) ?? null;
  for (let i = times.length - 1; i >= 0; i -= 1)
    if (times[i] < playheadMs - margin) return times[i];
  return null;
};
