import type { TControlDown } from "@app/lib/pam-web-app/contract";

import type { TViewerState } from "./types";

const isTerminal = (state: TViewerState) =>
  state.phase === "ended" || state.phase === "failed" || state.phase === "disconnected";

export const controlReducer = (state: TViewerState, control: TControlDown): TViewerState => {
  if (isTerminal(state)) return state;

  switch (control.kind) {
    case "session_ready":
      return {
        ...state,
        phase: state.phase === "ending" ? "ending" : "live",
        sessionId: control.sessionId,
        expiresAt: control.expiresAt,
        inputEnabled: state.phase === "ending" ? false : control.inputEnabled,
        policy: control.policy ?? state.policy
      };
    case "stream_hidden":
      return { ...state, hidden: control.reason };
    case "stream_shown":
      return { ...state, hidden: null };
    case "input_state":
      return { ...state, inputEnabled: state.phase === "ending" ? false : control.enabled };
    case "time_left":
      return { ...state, secondsLeft: control.secondsLeft, expiresAt: control.expiresAt };
    case "session_ending":
      return {
        ...state,
        phase: "ended",
        inputEnabled: false,
        endReason: control.reason,
        endMessage: control.message
      };
    case "viewer_degraded":
      return { ...state, degraded: control.active, droppedFrames: control.droppedFrames };
    case "recording_state":
      return { ...state, recordingLoss: control.state === "loss" };
    case "error":
      if (!control.fatal) return state;
      return {
        ...state,
        phase: "failed",
        inputEnabled: false,
        error: { code: control.code, message: control.message }
      };
    default:
      return state;
  }
};

export const canSendInput = (state: TViewerState) =>
  state.phase === "live" && state.inputEnabled && state.hidden === null;
