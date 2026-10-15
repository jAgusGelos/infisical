import { Alert, AlertDescription, AlertTitle } from "@app/components/v3";
import {
  TIntegrityChip,
  TReplayClock,
  TReplayTimeline,
  TReplayVerificationReport,
  TVerifyProgress,
  TWebAppReplay
} from "@app/hooks/api/pam/web-app-replay";

import { TUploadProgress, uploadingMessage } from "../replayPageModel";
import {
  IntegrityIssueBanner,
  ReplayEmptyState,
  ReplayErrorState,
  ReplayLoadingState,
  TReplayErrorDetails
} from "./ReplayStates";
import { ReplayWorkspace } from "./ReplayWorkspace";

type Props = {
  orgId: string;
  replay?: TWebAppReplay;
  report: TReplayVerificationReport | null;
  timeline: TReplayTimeline | null;
  clock: TReplayClock;
  progress: TVerifyProgress | null;
  integrity: TIntegrityChip;
  errorDetails: TReplayErrorDetails | null;
  upload: TUploadProgress;
  accountName: string;
  gatewayLabel: string;
  initialSessionMs?: number;
  onRetry: () => void;
  onCopyErrorDetails: () => void;
  onPlayheadChange: (sessionMs: number) => void;
  onPlayerError: (message: string) => void;
};

const ISSUE_STATES = new Set<TIntegrityChip["state"]>(["tampered", "gap", "incomplete"]);

export const ReplayBody = ({
  orgId,
  replay,
  report,
  timeline,
  clock,
  progress,
  integrity,
  errorDetails,
  upload,
  accountName,
  gatewayLabel,
  initialSessionMs,
  onRetry,
  onCopyErrorDetails,
  onPlayheadChange,
  onPlayerError
}: Props) => {
  if (errorDetails) {
    return (
      <ReplayErrorState
        orgId={orgId}
        details={errorDetails}
        onRetry={onRetry}
        onCopy={onCopyErrorDetails}
      />
    );
  }
  if (!report || !timeline || !replay) {
    return <ReplayLoadingState done={progress?.done ?? 0} total={progress?.total ?? 0} />;
  }
  if (!report.ed25519Supported) {
    return (
      <ReplayEmptyState
        title="Not verified"
        description="This browser cannot check Ed25519 signatures, so the recording is not shown."
      />
    );
  }
  if (report.keyCertError) {
    return (
      <IntegrityIssueBanner
        variant="danger"
        title="Recording refused: the session key certificate does not verify"
        detail={integrity.detail}
      />
    );
  }
  if (report.verifiedVideo.length === 0 && timeline.l1Rows.length === 0) {
    return (
      <ReplayEmptyState
        title={
          upload.isUploading
            ? uploadingMessage(gatewayLabel, upload)
            : `Session ended with no traffic to ${accountName}`
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {ISSUE_STATES.has(integrity.state) && (
        <IntegrityIssueBanner
          variant={integrity.state === "tampered" ? "danger" : "warning"}
          title={integrity.label}
          detail={integrity.detail}
        />
      )}
      {upload.isUploading && (
        <Alert variant="info">
          <AlertTitle>{uploadingMessage(gatewayLabel, upload)}</AlertTitle>
          <AlertDescription>The integrity chip covers only what has arrived.</AlertDescription>
        </Alert>
      )}
      <ReplayWorkspace
        replay={replay}
        report={report}
        timeline={timeline}
        clock={clock}
        gatewayLabel={gatewayLabel}
        initialSessionMs={initialSessionMs}
        onPlayheadChange={onPlayheadChange}
        onPlayerError={onPlayerError}
      />
    </div>
  );
};
