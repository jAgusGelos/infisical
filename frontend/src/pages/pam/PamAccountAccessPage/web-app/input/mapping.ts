import { MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT } from "@app/lib/pam-web-app/contract";

import { contentBox, type TRect } from "./geometry";

const WHEEL_LINE_PX = 40;

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

export const mapToFramebuffer = (
  clientX: number,
  clientY: number,
  rect: TRect,
  fbWidth: number,
  fbHeight: number
) => {
  const box = contentBox(rect, fbWidth, fbHeight);
  if (box.scale <= 0) return { x: 0, y: 0, inside: false };
  const rawX = (clientX - box.left) / box.scale;
  const rawY = (clientY - box.top) / box.scale;
  return {
    x: clamp(Math.floor(rawX), fbWidth - 1),
    y: clamp(Math.floor(rawY), fbHeight - 1),
    inside: rawX >= 0 && rawY >= 0 && rawX < fbWidth && rawY < fbHeight
  };
};

type TModifierSource = Pick<KeyboardEvent, "shiftKey" | "ctrlKey" | "altKey" | "metaKey">;

// The MOD_* values are distinct bits, so the sum is the bitmask.
export const modsOf = (event: TModifierSource) =>
  (event.shiftKey ? MOD_SHIFT : 0) +
  (event.ctrlKey ? MOD_CTRL : 0) +
  (event.altKey ? MOD_ALT : 0) +
  (event.metaKey ? MOD_META : 0);

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export const normalizeWheel = (
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">,
  pageHeightPx: number
) => {
  let factor = 1;
  if (event.deltaMode === DOM_DELTA_LINE) factor = WHEEL_LINE_PX;
  else if (event.deltaMode === DOM_DELTA_PAGE) factor = pageHeightPx;
  return { dx: Math.round(event.deltaX * factor), dy: Math.round(event.deltaY * factor) };
};

type TShortcutSource = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey">;

export const isPasteShortcut = (event: TShortcutSource) =>
  (event.ctrlKey || event.metaKey) && !event.altKey && event.code === "KeyV";
