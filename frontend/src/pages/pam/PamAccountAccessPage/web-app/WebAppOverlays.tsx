import { EyeOff, TriangleAlert } from "lucide-react";

import { ContentLoader } from "@app/components/v2";
import { Button } from "@app/components/v3";

import { DisconnectedScreen } from "../DisconnectedScreen";
import { WebAccessStatusCard } from "../WebAccessStatusCard";
import type { TReconnectStatus } from "./session/ReconnectController";
import type { TViewerState } from "./session/types";
import { ERROR_COPY, SESSION_END_COPY } from "./copy";

type Props = {
  state: TViewerState;
  reconnectStatus: TReconnectStatus;
  onReconnect: () => void;
};

const LOADER_CLASS_NAME = "absolute inset-0 z-10 h-full";

const errorDescription = ({ error }: TViewerState) => {
  if (!error) return ERROR_COPY.client_error;
  return error.code === "client_error" ? error.message : ERROR_COPY[error.code];
};

export const WebAppOverlays = ({ state, reconnectStatus, onReconnect }: Props) => {
  const { phase, hidden } = state;

  if (reconnectStatus === "waiting") {
    return <ContentLoader text="Connection lost. Reconnecting..." className={LOADER_CLASS_NAME} />;
  }
  if (phase === "failed") {
    return (
      <WebAccessStatusCard
        overlay
        tone="danger"
        icon={TriangleAlert}
        title="Session failed"
        description={errorDescription(state)}
      >
        <Button variant="pam" isFullWidth onClick={onReconnect}>
          Reconnect
        </Button>
      </WebAccessStatusCard>
    );
  }
  if (phase === "ended") {
    return (
      <DisconnectedScreen
        title="Session ended"
        description={state.endMessage ?? SESSION_END_COPY[state.endReason ?? "error"]}
        onReconnect={onReconnect}
      />
    );
  }
  if (phase === "disconnected") {
    return (
      <DisconnectedScreen
        description="The connection to the session was lost and could not be restored."
        onReconnect={onReconnect}
      />
    );
  }
  if (hidden === "login") {
    return <ContentLoader text="Signing in..." className={LOADER_CLASS_NAME} />;
  }
  if (hidden === "policy") {
    return (
      <WebAccessStatusCard
        overlay
        icon={EyeOff}
        title="Hidden by policy"
        description="The session is still running, but the access policy hides its screen right now."
      />
    );
  }
  if (phase === "connecting" || phase === "awaiting_ready") {
    return <ContentLoader text="Starting the remote browser..." className={LOADER_CLASS_NAME} />;
  }
  if (phase === "ending") {
    return <ContentLoader text="Ending the session..." className={LOADER_CLASS_NAME} />;
  }
  return null;
};
