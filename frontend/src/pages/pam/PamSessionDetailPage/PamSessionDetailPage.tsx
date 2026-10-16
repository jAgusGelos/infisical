import { useCallback, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { useParams, useSearch } from "@tanstack/react-router";

import { Badge } from "@app/components/v3";
import { ROUTE_PATHS } from "@app/const/routes";
import { PamAccountType, useGetPamSessionById } from "@app/hooks/api/pam";
import {
  buildReplayTimeline,
  createReplayClock,
  deriveIntegrity,
  formatSessionTime,
  useVerifiedWebAppReplay
} from "@app/hooks/api/pam/web-app-replay";

import { capitalize, STATUS_BADGE } from "../PamSessionsPage/constants";
import { MetadataStrip } from "./components/MetadataStrip";
import { ReplayBody } from "./components/ReplayBody";
import { ReplayHeader } from "./components/ReplayHeader";
import { NotWebAppSessionState, SessionLookupErrorState } from "./components/ReplayStates";
import {
  buildSessionMetadata,
  CHIP_VARIANT,
  copyWithNotification,
  gatewayLabelOf,
  getReplayErrorDetails,
  getUploadProgress
} from "./replayPageModel";

const ROUTE_ID = ROUTE_PATHS.Pam.SessionDetailPage.id;

export const PamSessionDetailPage = () => {
  const { orgId, sessionId } = useParams({ from: ROUTE_ID });
  const search = useSearch({ from: ROUTE_ID });
  const fixtureVariant = import.meta.env.DEV ? search.replayFixture : undefined;
  const initialSessionMs = search.t !== undefined ? search.t * 1000 : undefined;

  const {
    data: session,
    error: sessionError,
    isLoading: isSessionLoading,
    refetch: refetchSession
  } = useGetPamSessionById(
    fixtureVariant ? "" : sessionId
  );
  const isWebApp = Boolean(fixtureVariant) || session?.accountType === PamAccountType.WebApp;

  const { replay, state, retry } = useVerifiedWebAppReplay({
    sessionId: isWebApp ? sessionId : "",
    fixtureVariant,
    includeEvents: true
  });
  const [playerError, setPlayerError] = useState<string | null>(null);
  const playheadRef = useRef(initialSessionMs ?? 0);
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

  if (!fixtureVariant && !isSessionLoading && session && !isWebApp) {
    return (
      <div className="mx-auto mb-6 w-full max-w-8xl">
        <NotWebAppSessionState orgId={orgId} />
      </div>
    );
  }

  if (!fixtureVariant && sessionError) {
    return (
      <div className="mx-auto mb-6 w-full max-w-8xl">
        <SessionLookupErrorState onRetry={() => void refetchSession()} />
      </div>
    );
  }

  const accountName = session?.accountName ?? "Web App session";
  const gatewayLabel = gatewayLabelOf(timeline);
  const errorDetails = getReplayErrorDetails(state, report, playerError);

  const copyLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("t", String(Math.floor(playheadRef.current / 1000)));
    copyWithNotification(url.toString(), "Link copied", "Could not copy the link");
  };

  const copyErrorDetails = () => {
    if (!errorDetails) return;
    copyWithNotification(
      JSON.stringify({ sessionId, ...errorDetails }, null, 2),
      "Error details copied",
      "Could not copy the error details"
    );
  };

  return (
    <div className="mx-auto mb-6 flex w-full max-w-8xl flex-col gap-4">
      <Helmet>
        <title>Session Review</title>
      </Helmet>
      <ReplayHeader
        title={accountName}
        status={
          session ? (
            <Badge variant={STATUS_BADGE[session.status].variant}>
              {capitalize(session.status)}
            </Badge>
          ) : null
        }
        integrity={{
          label: integrity.label,
          variant: CHIP_VARIANT[integrity.state],
          detail: integrity.detail
        }}
        copyLinkLabel={`Copy link at ${formatSessionTime(copyLabelMs)}`}
        onCopyLink={copyLink}
      />
      <MetadataStrip
        items={buildSessionMetadata({ session, replay, report, timeline, gatewayLabel })}
      />
      <ReplayBody
        orgId={orgId}
        replay={replay}
        report={report}
        timeline={timeline}
        clock={clock}
        progress={progress}
        integrity={integrity}
        errorDetails={errorDetails}
        upload={getUploadProgress(replay, report, timeline)}
        accountName={accountName}
        gatewayLabel={gatewayLabel}
        initialSessionMs={initialSessionMs}
        onRetry={() => {
          setPlayerError(null);
          retry();
        }}
        onCopyErrorDetails={copyErrorDetails}
        onPlayheadChange={onPlayheadChange}
        onPlayerError={setPlayerError}
      />
    </div>
  );
};
