import { describe, expect, it } from "vitest";

import { canSendInput, controlReducer } from "./controlReducer";
import { sessionReady } from "./testUtils";
import { initialViewerState, type TViewerState } from "./types";

const awaiting: TViewerState = { ...initialViewerState, phase: "awaiting_ready" };

describe("controlReducer", () => {
  it("session_ready makes the session live with the given input state and policy", () => {
    const policy = { clipboard: "to_remote", downloads: "block", uploads: "block" } as const;
    const next = controlReducer(awaiting, { ...sessionReady(), policy });
    expect(next).toMatchObject({ phase: "live", inputEnabled: true, policy });
    expect(canSendInput(next)).toBe(true);
  });

  it("hidden streams block input until shown", () => {
    const live = controlReducer(awaiting, sessionReady());
    const hidden = controlReducer(live, { kind: "stream_hidden", reason: "login" });
    expect(hidden.hidden).toBe("login");
    expect(canSendInput(hidden)).toBe(false);
    expect(canSendInput(controlReducer(hidden, { kind: "stream_shown" }))).toBe(true);
  });

  it("tracks time_left, viewer_degraded and recording_state", () => {
    let state = controlReducer(awaiting, sessionReady());
    state = controlReducer(state, { kind: "time_left", secondsLeft: 50, expiresAt: "x" });
    state = controlReducer(state, { kind: "viewer_degraded", active: true, droppedFrames: 4 });
    state = controlReducer(state, { kind: "recording_state", state: "loss", lostMs: 10 });
    expect(state).toMatchObject({
      secondsLeft: 50,
      degraded: true,
      droppedFrames: 4,
      recordingLoss: true
    });
  });

  it("ignores control after the session is terminal", () => {
    const ended = controlReducer(awaiting, { kind: "session_ending", reason: "idle" });
    expect(ended.phase).toBe("ended");
    expect(controlReducer(ended, sessionReady())).toBe(ended);
  });

  it("keeps input off while ending", () => {
    const ending: TViewerState = { ...controlReducer(awaiting, sessionReady()), phase: "ending" };
    const next = controlReducer(ending, { kind: "input_state", enabled: true });
    expect(next.inputEnabled).toBe(false);
  });
});
