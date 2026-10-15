import { useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { PauseIcon, PlayIcon, Video } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton
} from "@app/components/v3";
import { PageHeader } from "@app/components/v3/platform";
import { PamAccountType, useGetPamSessionById } from "@app/hooks/api/pam";
import { useVerifiedWebAppReplay } from "@app/hooks/api/pam/web-app-replay";
import { ProjectType } from "@app/hooks/api/projects/types";

import { MseVideoPlayer, TMseVideoPlayerHandle } from "./components/MseVideoPlayer";

const ROUTE_ID =
  "/_authenticate/_inject-org-details/_org-layout/organizations/$orgId/pam/_pam-layout/sessions/$sessionId" as const;

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
    includeEvents: false
  });

  const playerRef = useRef<TMseVideoPlayerHandle>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);

  const report = state.phase === "done" ? state.report : null;
  const verifiedVideo = useMemo(() => report?.verifiedVideo ?? [], [report]);

  const title = session?.accountName ?? "Web App session";

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

  let integrity: { label: string; variant: "success" | "warning" | "danger" | "neutral" } = {
    label: "Not verified",
    variant: "neutral"
  };
  if (state.phase === "verifying") {
    integrity = {
      label: `Verifying ${state.progress.done}/${state.progress.total}`,
      variant: "neutral"
    };
  } else if (report && report.ed25519Supported) {
    const tampered = report.keyCertError || report.video.some((v) => v.status === "tampered");
    const missing = report.video.find((v) => v.status === "missing");
    if (tampered) integrity = { label: "Tampered", variant: "danger" };
    else if (missing)
      integrity = { label: `Gap · object ${missing.objectIndex}`, variant: "warning" };
    else if (report.video.length > 0) {
      integrity = { label: "Video verified · chain not checked", variant: "neutral" };
    }
  }

  const fatalError =
    state.phase === "error"
      ? state.message
      : (report?.fetchFailure?.message ?? report?.limitError?.message ?? playerError);

  let body;
  if (fatalError) {
    body = (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Recording unavailable: decryption failed</EmptyTitle>
          <EmptyDescription>{fatalError}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            onClick={() => {
              setPlayerError(null);
              retry();
            }}
          >
            Retry decryption
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else if (!report) {
    const progress = state.phase === "verifying" ? state.progress : null;
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          {progress && progress.total > 0
            ? `Verifying chunk ${progress.done} of ${progress.total}`
            : "Loading recording"}
        </p>
        <Skeleton className="aspect-video w-full" />
      </div>
    );
  } else if (!report.ed25519Supported) {
    body = (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Not verified</EmptyTitle>
          <EmptyDescription>
            This browser cannot check Ed25519 signatures, so the recording is not shown.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (report.keyCertError || verifiedVideo.length === 0) {
    body = (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>
            {report.keyCertError ? "Recording refused: signature mismatch" : "No verified video"}
          </EmptyTitle>
          <EmptyDescription>
            {report.keyCertError?.message ?? "No video object passed verification."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <MseVideoPlayer
          ref={playerRef}
          className="aspect-video w-full rounded-md bg-black"
          mime={replay?.video.mime ?? ""}
          objects={verifiedVideo}
          onPlayingChange={setIsPlaying}
          onError={setPlayerError}
        />
        <div>
          <Button variant="outline" size="xs" onClick={() => playerRef.current?.toggle()}>
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
            {isPlaying ? "Pause" : "Play"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto mb-6 w-full max-w-8xl">
      <Helmet>
        <title>Session Review</title>
      </Helmet>
      <PageHeader
        scope={ProjectType.PAM}
        icon={Video}
        title={title}
        description={
          <span className="flex items-center gap-2">
            <Badge variant="neutral">Web App</Badge>
            <Badge variant={integrity.variant}>{integrity.label}</Badge>
          </span>
        }
      />
      <Card className="mt-4">
        <CardContent className="pt-4">{body}</CardContent>
      </Card>
    </div>
  );
};
