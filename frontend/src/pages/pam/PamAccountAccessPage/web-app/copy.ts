import type { TControlErrorCode, TSessionEndReason } from "@app/lib/pam-web-app/contract";

export const SESSION_END_COPY: Record<TSessionEndReason, string> = {
  user_end: "You ended this session.",
  expired: "The session reached its maximum duration.",
  idle: "The session ended after a period of inactivity.",
  admin_terminated: "An administrator terminated this session.",
  policy_change: "The session ended because the access policy changed.",
  runner_exit: "The remote browser stopped unexpectedly.",
  login_failed: "Signing in to the app failed.",
  recording_failed: "The session ended because it could not be recorded.",
  viewer_lost: "The session ended because the viewer was disconnected for too long.",
  error: "The session ended because of an error."
};

export const ERROR_COPY: Record<TControlErrorCode | "client_error", string> = {
  protocol_error: "The stream sent data this viewer could not read.",
  frame_too_large: "The stream sent a frame larger than allowed.",
  no_decoder: "This browser cannot decode the session stream.",
  runner_unavailable: "The remote browser is not available right now.",
  capacity_exhausted: "No remote browser capacity is available. Try again in a moment.",
  login_failed: "Signing in to the app failed.",
  tunnel_failed: "The connection to the gateway failed.",
  session_in_use: "This session is already open in another window.",
  internal: "Something went wrong on the server.",
  client_error: "Unable to start the session."
};
