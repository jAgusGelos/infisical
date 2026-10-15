import { useCallback, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { format } from "date-fns";

import { createNotification } from "@app/components/notifications";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle
} from "@app/components/v3";
import { PamAccountType, useGetPamSessionById } from "@app/hooks/api/pam";
import {
  buildReplayTimeline,
  createReplayClock,
  deriveIntegrity,
  formatSessionTime,
  TIntegrityState,
  useVerifiedWebAppReplay
} from "@app/hooks/api/pam/web-app-replay";

import { capitalize, formatDuration, STATUS_BADGE } from "../PamSessionsPage/constants";
import { MetadataStrip, TMetadataItem } from "./components/MetadataStrip";
import { ReplayHeader, TIntegrityChipView } from "./components/ReplayHeader";
import {
  IntegrityIssueBanner,
  ReplayEmptyState,
  ReplayErrorState,
  ReplayLoadingState,
  TReplayErrorDetails
} from "./components/ReplayStates";
import { ReplayWorkspace } from "./components/ReplayWorkspace";

const ROUTE_ID =
  "/_authenticate/_inject-org-details/_org-layout/organizations/$orgId/pam/_pam-layout/sessions/$sessionId" as const;

const CHIP_VARIANT: Record<TIntegrityState, TIntegrityChipView["variant"]> = {
  verified: "success",
  incomplete: "warning",
  gap: "warning",
  tampered: "danger",
  verifying: "neutral",
  not_verified: "neutral"
};

export const PamSessionDetailPage = () => {
  const { orgId, sessionId } = useParams({ from: ROUTE_ID });
  const search = useSearch({ from: ROUTE_ID });
  const fixtureVariant = import.meta.env.DEV ? search.replayFixture : undefined;

  const { data: session, isLoading: isSessionLoading } = useGetPamSessionById(
    fixtureVariant ? "" : sessionId
  );
  const isWebApp = Boolean(fixtureVariant) || session?.accountType === PamAccountType.WebApp;

  const { replay, state, retry } = useVerifiedWebAppReplay({
    sessionId: isWebApp ? sessionId : "",
    fixtureVariant,
    includeEvents: true
  });
  const [playerError, setPlayerError] = useState<string | null>(null);
  const playheadRef = useRef(search.t !== undefined ? search.t * 1000 : 0);
  const [copyLabelMs, setCopyLabelMs] = useState(playheadRef.current);

  const report = state.phase === "done" ? state.report : null;
  const progress = state.phase === "verifying" ? state.progress : null;
  const timeline = useMemo(
    () => (report ? buildReplayTimeline(report.verifiedChunks) : null),
    [report]
  );
  const clock = useMemo(() => createReplayClock(replay?.video.objects ?? []), [replay]);
  const integrity = deriveIntegrity({ replay, report, timeline, progress });

  const onPlayheadChange = useCallback((ms: number) => {
    playheadRef.current = ms;
    // The button label only needs whole seconds.
    setCopyLabelMs((prev) => (Math.floor(prev / 1000) === Math.floor(ms / 1000) ? prev : ms));
  }, []);

  const copyLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("t", String(Math.floor(playheadRef.current / 1000)));
    navigator.clipboard
      .writeText(url.toString())
      .then(() => createNotification({ type: "success", text: "Link copied" }))
      .catch(() => createNotification({ type: "error", text: "Could not copy the link" }));
  };

  if (!fixtureVariant && !isSessionLoading && session && !isWebApp) {
    return (
      <div className="mx-auto mb-6 w-full max-w-8xl">
        <Empty className="mt-4 border">
          <EmptyHeader>
            <EmptyTitle>This view is for Web App sessions</EmptyTitle>
            <EmptyDescription>Open this session from the sessions list instead.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link to="/organizations/$orgId/pam/sessions" params={{ orgId }}>
                Back to sessions
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const accountName = session?.accountName ?? "Web App session";
  const gatewayLabel = timeline?.sessionOpen?.gatewayId
    ? `gateway ${timeline.sessionOpen.gatewayId.slice(0, 8)}`
    : "the gateway";

  let errorDetails: TReplayErrorDetails | null = null;
  if (state.phase === "error") errorDetails = { step: "replay", message: state.message };
  else if (report?.fetchFailure) {
    errorDetails = {
      step: `fetch ${report.fetchFailure.series}`,
      objectIndex: report.fetchFailure.objectIndex,
      message: report.fetchFailure.message
    };
  } else if (report?.limitError) {
    errorDetails = { step: "limits", message: report.limitError.message };
  } else if (playerError) errorDetails = { step: "player", message: playerError };

  const copyErrorDetails = () => {
    if (!errorDetails) return;
    const text = JSON.stringify({ sessionId, ...errorDetails }, null, 2);
    navigator.clipboard
      .writeText(text)
      .then(() => createNotification({ type: "success", text: "Error details copied" }))
      .catch(() => createNotification({ type: "error", text: "Could not copy the error details" }));
  };

  const verifiedCount = report
    ? [...report.video, ...report.events].filter((r) => r.status === "verified").length
    : 0;
  const listedCount = report ? report.video.length + report.events.length : 0;
  const isUploading =
    replay?.status === "active" ||
    (Boolean(report) && !timeline?.sessionEnd && verifiedCount < listedCount);

  let body;
  if (errorDetails) {
    body = (
      <ReplayErrorState
        orgId={orgId}
        details={errorDetails}
        onRetry={() => {
          setPlayerError(null);
          retry();
        }}
        onCopy={copyErrorDetails}
      />
    );
  } else if (!report || !timeline || !replay) {
    body = <ReplayLoadingState done={progress?.done ?? 0} total={progress?.total ?? 0} />;
  } else if (!report.ed25519Supported) {
    body = (
      <ReplayEmptyState
        title="Not verified"
        description="This browser cannot check Ed25519 signatures, so the recording is not shown."
      />
    );
  } else if (report.keyCertError) {
    body = (
      <IntegrityIssueBanner
        variant="danger"
        title="Recording refused: the session key certificate does not verify"
        detail={integrity.detail}
      />
    );
  } else if (report.verifiedVideo.length === 0 && timeline.l1Rows.length === 0) {
    body = isUploading ? (
      <ReplayEmptyState
        title={`Recording still uploading from ${gatewayLabel}. ${verifiedCount} of ${listedCount} chunks received...`}
      />
    ) : (
      <ReplayEmptyState title={`Session ended with no traffic to ${accountName}`} />
    );
  } else {
    const issue =
      integrity.state === "tampered" ||
      integrity.state === "gap" ||
      integrity.state === "incomplete";
    body = (
      <div className="flex flex-col gap-4">
        {issue && (
          <IntegrityIssueBanner
            variant={integrity.state === "tampered" ? "danger" : "warning"}
            title={integrity.label}
            detail={integrity.detail}
          />
        )}
        {isUploading && (
          <Alert variant="info">
            <AlertTitle>
              Recording still uploading from {gatewayLabel}. {verifiedCount} of {listedCount} chunks
              received...
            </AlertTitle>
            <AlertDescription>The integrity chip covers only what has arrived.</AlertDescription>
          </Alert>
        )}
        <ReplayWorkspace
          replay={replay}
          report={report}
          timeline={timeline}
          clock={clock}
          gatewayLabel={gatewayLabel}
          initialSessionMs={search.t !== undefined ? search.t * 1000 : undefined}
          onPlayheadChange={onPlayheadChange}
          onPlayerError={setPlayerError}
        />
      </div>
    );
  }

  const statusBadge = session ? (
    <Badge variant={STATUS_BADGE[session.status].variant}>{capitalize(session.status)}</Badge>
  ) : null;

  const metadata: TMetadataItem[] = [
    { label: "User", value: session?.actorEmail || session?.actorName || "-" },
    { label: "Folder", value: session?.folderName || "-" },
    {
      label: "Window",
      value: replay?.startedAt
        ? `${format(new Date(replay.startedAt), "MMM d, h:mm a")}${session ? ` (${formatDuration(session)})` : ""}`
        : "-"
    },
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

  return (
    <div className="mx-auto mb-6 flex w-full max-w-8xl flex-col gap-4">
      <Helmet>
        <title>Session Review</title>
      </Helmet>
      <ReplayHeader
        title={accountName}
        status={statusBadge}
        integrity={{
          label: integrity.label,
          variant: CHIP_VARIANT[integrity.state],
          detail: integrity.detail
        }}
        copyLinkLabel={`Copy link at ${formatSessionTime(copyLabelMs)}`}
        onCopyLink={copyLink}
      />
      <MetadataStrip items={metadata} />
      {body}
    </div>
  );
};
