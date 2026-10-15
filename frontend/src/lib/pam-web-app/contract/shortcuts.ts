// The gateway (Go) enforces these rules; this copy lets the viewer show which shortcuts are reserved and lets
// tests check both languages agree.
/* eslint-disable no-bitwise -- modifiers are a bitmask on the wire */

import { MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, TInputEvent } from "./frame";

type TShortcutRule = { name: string; codes: string[] | null; mods: number };

const F_KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];

export const SHORTCUT_RULES: TShortcutRule[] = [
  { name: "Ctrl+Alt+*", codes: [...F_KEYS, "Backspace"], mods: MOD_CTRL | MOD_ALT },
  { name: "Meta+*", codes: null, mods: MOD_META },
  { name: "MetaLeft/MetaRight", codes: ["MetaLeft", "MetaRight", "OSLeft", "OSRight"], mods: 0 },
  { name: "Ctrl+Shift+Delete", codes: ["Delete"], mods: MOD_CTRL | MOD_SHIFT },
  { name: "Ctrl+Shift+I", codes: ["KeyI"], mods: MOD_CTRL | MOD_SHIFT },
  { name: "Ctrl+Shift+J", codes: ["KeyJ"], mods: MOD_CTRL | MOD_SHIFT },
  { name: "Ctrl+Shift+C", codes: ["KeyC"], mods: MOD_CTRL | MOD_SHIFT },
  { name: "Ctrl+Shift+B", codes: ["KeyB"], mods: MOD_CTRL | MOD_SHIFT },
  { name: "Ctrl+Shift+M", codes: ["KeyM"], mods: MOD_CTRL | MOD_SHIFT },
  { name: "Ctrl+Shift+A", codes: ["KeyA"], mods: MOD_CTRL | MOD_SHIFT },
  { name: "Ctrl+N", codes: ["KeyN"], mods: MOD_CTRL },
  { name: "Ctrl+T", codes: ["KeyT"], mods: MOD_CTRL },
  { name: "Ctrl+W", codes: ["KeyW"], mods: MOD_CTRL },
  { name: "Ctrl+F4", codes: ["F4"], mods: MOD_CTRL },
  { name: "Alt+F4", codes: ["F4"], mods: MOD_ALT },
  { name: "Ctrl+Q", codes: ["KeyQ"], mods: MOD_CTRL },
  { name: "Ctrl+H", codes: ["KeyH"], mods: MOD_CTRL },
  { name: "Ctrl+J", codes: ["KeyJ"], mods: MOD_CTRL },
  { name: "F12", codes: ["F12"], mods: 0 },
  { name: "Ctrl+U", codes: ["KeyU"], mods: MOD_CTRL },
  { name: "Ctrl+P", codes: ["KeyP"], mods: MOD_CTRL },
  { name: "Ctrl+S", codes: ["KeyS"], mods: MOD_CTRL },
  { name: "Ctrl+O", codes: ["KeyO"], mods: MOD_CTRL },
  { name: "F11", codes: ["F11"], mods: 0 },
  { name: "Ctrl+L", codes: ["KeyL"], mods: MOD_CTRL },
  { name: "Alt+D", codes: ["KeyD"], mods: MOD_ALT },
  { name: "F6", codes: ["F6"], mods: 0 },
  { name: "Ctrl+K", codes: ["KeyK"], mods: MOD_CTRL },
  { name: "Ctrl+E", codes: ["KeyE"], mods: MOD_CTRL },
  { name: "Ctrl+D", codes: ["KeyD"], mods: MOD_CTRL },
  { name: "Alt+Home", codes: ["Home"], mods: MOD_ALT },
  { name: "Alt+F", codes: ["KeyF"], mods: MOD_ALT },
  { name: "Alt+E", codes: ["KeyE"], mods: MOD_ALT },
  { name: "F10", codes: ["F10"], mods: 0 },
  { name: "F7", codes: ["F7"], mods: 0 },
  { name: "Shift+Escape", codes: ["Escape"], mods: MOD_SHIFT }
];

const ruleMatches = (rule: TShortcutRule, code: string, mods: number) =>
  (mods & rule.mods) === rule.mods && (rule.codes === null || rule.codes.includes(code));

export const matchShortcut = (code: string, mods: number): string | null =>
  SHORTCUT_RULES.find((rule) => ruleMatches(rule, code, mods))?.name ?? null;

// Stateful per session: a keyup whose keydown was dropped is dropped too.
export const createInputFilter = () => {
  const droppedDown = new Map<string, string>();

  const dropRuleFor = (ev: TInputEvent): string | null => {
    if (ev.t === "button") return ev.button < 0 || ev.button > 2 ? "Button>2" : null;
    if (ev.t !== "key") return null;
    if (ev.action === "up") {
      const rule = droppedDown.get(ev.code) ?? null;
      droppedDown.delete(ev.code);
      return rule;
    }
    const rule = matchShortcut(ev.code, ev.mods ?? 0);
    if (rule) droppedDown.set(ev.code, rule);
    return rule;
  };

  return (events: TInputEvent[]) => {
    const kept: TInputEvent[] = [];
    const droppedRules: string[] = [];
    events.forEach((ev) => {
      const rule = dropRuleFor(ev);
      if (rule) droppedRules.push(rule);
      else kept.push(ev);
    });
    return { kept, droppedRules };
  };
};
