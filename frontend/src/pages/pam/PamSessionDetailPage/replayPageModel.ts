import { format } from "date-fns";

import { createNotification } from "@app/components/notifications";
import { TPamSession } from "@app/hooks/api/pam";
import {
  TIntegrityState,
  TReplayTimeline,
  TReplayVerificationReport,
  TWebAppReplay,
  TWebAppReplayVerificationState
} from "@app/hooks/api/pam/web-app-replay";

import { formatDuration } from "../PamSessionsPage/constants";
import { TMetadataItem } from "./components/MetadataStrip";
import { TIntegrityChipView } from "./components/ReplayHeader";
import { TReplayErrorDetails } from "./components/ReplayStates";

export const CHIP_VARIANT: Record<TIntegrityState, TIntegrityChipView["variant"]> = {
  verified: "success",
  incomplete: "warning",
  gap: "warning",
  tampered: "danger",
  verifying: "neutral",
  not_verified: "neutral"
};

export type TUploadProgress = { verifiedCount: number; listedCount: number; isUploading: boolean };

export const copyWithNotification = (text: string, successText: string, failureText: string) =>
  navigator.clipboard
    .writeText(text)
    .then(() => createNotification({ type: "success", text: successText }))
    .catch(() => createNotification({ type: "error", text: failureText }));

export const gatewayLabelOf = (timeline: TReplayTimeline | null) =>
  timeline?.sessionOpen?.gatewayId
    ? `gateway ${timeline.sessionOpen.gatewayId.slice(0, 8)}`
    : "the gateway";

export const uploadingMessage = (gatewayLabel: string, upload: TUploadProgress) =>
  `Recording still uploading from ${gatewayLabel}. ${upload.verifiedCount} of ${upload.listedCount} chunks received...`;

export const getReplayErrorDetails = (
  state: TWebAppReplayVerificationState,
  report: TReplayVerificationReport | null,
  playerError: string | null
): TReplayErrorDetails | null => {
  if (state.phase === "error") return { step: "replay", message: state.message };
  if (report?.fetchFailure) {
    return {
      step: `fetch ${report.fetchFailure.series}`,
      objectIndex: report.fetchFailure.objectIndex,
      message: report.fetchFailure.message
    };
  }
  if (report?.limitError) return { step: "limits", message: report.limitError.message };
  if (playerError) return { step: "player", message: playerError };
  return null;
};

export const getUploadProgress = (
  replay: TWebAppReplay | undefined,
  report: TReplayVerificationReport | null,
  timeline: TReplayTimeline | null
): TUploadProgress => {
  const verifiedCount = report
    ? [...report.video, ...report.events].filter((r) => r.status === "verified").length
    : 0;
  const listedCount = report ? report.video.length + report.events.length : 0;
  const isUploading =
    replay?.status === "active" ||
    (Boolean(report) && !timeline?.sessionEnd && verifiedCount < listedCount);
  return { verifiedCount, listedCount, isUploading };
};

const sessionWindow = (replay?: TWebAppReplay, session?: TPamSession) => {
  if (!replay?.startedAt) return "-";
  const started = format(new Date(replay.startedAt), "MMM d, h:mm a");
  return session ? `${started} (${formatDuration(session)})` : started;
};

export const buildSessionMetadata = ({
  session,
  replay,
  report,
  timeline,
  gatewayLabel
}: {
  session?: TPamSession;
  replay?: TWebAppReplay;
  report: TReplayVerificationReport | null;
  timeline: TReplayTimeline | null;
  gatewayLabel: string;
}): TMetadataItem[] => [
  { label: "User", value: session?.actorEmail || session?.actorName || "-" },
  { label: "Folder", value: session?.folderName || "-" },
  { label: "Window", value: sessionWindow(replay, session) },
  { label: "Ended", value: timeline?.sessionEnd?.reason ?? replay?.endReason ?? "Ongoing" },
  { label: "Requests", value: timeline ? String(timeline.l1Rows.length) : "-" },
  { label: "Inputs", value: timeline ? String(timeline.inputRows.length) : "-" },
  { label: "Reason", value: session?.reason || "-" },
  { label: "Gateway", value: gatewayLabel },
  {
    label: "Recording key",
    value: report?.sessionKey?.fingerprint ?? replay?.recordingKey.fingerprint ?? "-",
    mono: true
  }
];
