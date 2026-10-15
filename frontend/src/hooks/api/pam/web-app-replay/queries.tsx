import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { createApiReplaySource } from "./apiSource";
import { WEB_APP_REPLAY_POLL_INTERVAL_MS } from "./limits";
import { TReplayVerificationReport, TVerifyProgress, verifyReplay } from "./report";
import { TWebAppReplaySource } from "./source";

export const webAppReplayKeys = {
  all: ["pam", "web-app-replay"] as const,
  replay: (sessionId: string, fixtureVariant?: string) =>
    [...webAppReplayKeys.all, sessionId, fixtureVariant ?? "api"] as const
};

const loadSource = async (
  sessionId: string,
  fixtureVariant?: string
): Promise<TWebAppReplaySource> => {
  if (import.meta.env.DEV && fixtureVariant) {
    const { createFixtureReplaySource } = await import("./fixtureSource");
    return createFixtureReplaySource(fixtureVariant);
  }
  return createApiReplaySource(sessionId);
};

export const useGetWebAppReplay = (sessionId: string, fixtureVariant?: string) =>
  useQuery({
    queryKey: webAppReplayKeys.replay(sessionId, fixtureVariant),
    enabled: Boolean(sessionId),
    queryFn: async () => {
      const source = await loadSource(sessionId, fixtureVariant);
      return { source, replay: await source.getReplay() };
    },
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data?.replay.status === "active" ? WEB_APP_REPLAY_POLL_INTERVAL_MS : false
  });

export type TWebAppReplayVerificationState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "verifying"; progress: TVerifyProgress }
  | { phase: "done"; report: TReplayVerificationReport };

export const useVerifiedWebAppReplay = ({
  sessionId,
  fixtureVariant,
  includeEvents
}: {
  sessionId: string;
  fixtureVariant?: string;
  includeEvents: boolean;
}) => {
  const replayQuery = useGetWebAppReplay(sessionId, fixtureVariant);
  const [state, setState] = useState<TWebAppReplayVerificationState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  const { data } = replayQuery;
  // Polling returns a new object every 5 s; only a changed response is verified again.
  const replayFingerprint = useMemo(() => (data ? JSON.stringify(data.replay) : null), [data]);

  useEffect(() => {
    if (!data || !replayFingerprint) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setState({ phase: "verifying", progress: { done: 0, total: 0 } });
    verifyReplay(data.source, data.replay, {
      includeEvents,
      signal: controller.signal,
      onProgress: (progress) => {
        if (!cancelled) setState({ phase: "verifying", progress });
      }
    })
      .then((report) => {
        if (!cancelled) setState({ phase: "done", report });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayFingerprint, includeEvents, attempt]);

  const retry = useCallback(() => {
    setState({ phase: "loading" });
    setAttempt((n) => n + 1);
    replayQuery.refetch();
  }, [replayQuery]);

  if (replayQuery.isError) {
    return {
      replay: undefined,
      state: { phase: "error", message: replayQuery.error.message } as const,
      retry
    };
  }
  return { replay: data?.replay, state, retry };
};
