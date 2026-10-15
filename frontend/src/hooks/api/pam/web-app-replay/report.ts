import axios from "axios";

import { WEB_APP_REPLAY_FETCH_CONCURRENCY, WEB_APP_REPLAY_MAX_OBJECTS_PER_SERIES } from "./limits";
import { ReplayObjectNotFoundError, TWebAppReplaySource } from "./source";
import {
  TWebAppEventChunkEntry,
  TWebAppReplay,
  TWebAppReplaySeries,
  TWebAppVideoEntry
} from "./types";
import {
  assertEventLimit,
  checkVideoBinding,
  isEd25519Supported,
  ReplayVerifyError,
  TBindingResult,
  TPreviousChunk,
  TReplayVerifyStep,
  TVerifiedEventChunk,
  TVerifiedSessionKey,
  TVerifiedVideoObject,
  verifyEventChunk,
  verifySessionKeyCert,
  verifyVideoObject
} from "./verify";

export type TObjectResult = {
  series: TWebAppReplaySeries;
  objectIndex: number;
  status: "verified" | "missing" | "tampered";
  step?: TReplayVerifyStep;
  message?: string;
};

export type TReplayFetchFailure = {
  series: TWebAppReplaySeries;
  objectIndex: number;
  message: string;
};

export type TReplayVerificationReport = {
  ed25519Supported: boolean;
  sessionKey: TVerifiedSessionKey | null;
  keyCertError: ReplayVerifyError | null;
  limitError: ReplayVerifyError | null;
  fetchFailure: TReplayFetchFailure | null;
  includesEvents: boolean;
  video: TObjectResult[];
  events: TObjectResult[];
  verifiedVideo: TVerifiedVideoObject[];
  verifiedChunks: TVerifiedEventChunk[];
  bindings: Map<number, TBindingResult>;
  done: number;
  total: number;
};

export type TVerifyProgress = { done: number; total: number };

type TFetched =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "failed"; message: string };

const isRetryable = (err: unknown) => {
  if (axios.isAxiosError(err)) {
    if (err.code === "ERR_CANCELED") return false;
    return !err.response || err.response.status >= 500;
  }
  return err instanceof TypeError;
};

const fetchObject = async (
  source: TWebAppReplaySource,
  series: TWebAppReplaySeries,
  objectIndex: number,
  signal?: AbortSignal
): Promise<TFetched> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return { kind: "ok", bytes: await source.getObject(series, objectIndex, signal) };
    } catch (err) {
      if (err instanceof ReplayObjectNotFoundError) return { kind: "missing" };
      if (attempt === 1 || !isRetryable(err) || signal?.aborted) {
        return { kind: "failed", message: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return { kind: "failed", message: "unreachable" };
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

const toResult = (
  series: TWebAppReplaySeries,
  objectIndex: number,
  err: unknown
): TObjectResult => ({
  series,
  objectIndex,
  status: "tampered",
  step: err instanceof ReplayVerifyError ? err.step : undefined,
  message: err instanceof Error ? err.message : String(err)
});

const emptyReport = (ed25519Supported: boolean, includesEvents: boolean, total: number) => ({
  ed25519Supported,
  sessionKey: null,
  keyCertError: null,
  limitError: null,
  fetchFailure: null,
  includesEvents,
  video: [],
  events: [],
  verifiedVideo: [],
  verifiedChunks: [],
  bindings: new Map<number, TBindingResult>(),
  done: 0,
  total
});

type TVerifyContext = {
  source: TWebAppReplaySource;
  sessionKey: TVerifiedSessionKey;
  report: TReplayVerificationReport;
  tick: () => void;
  signal?: AbortSignal;
};

const verifyEventChunks = async (
  ctx: TVerifyContext,
  chunkEntries: TWebAppEventChunkEntry[]
): Promise<TReplayFetchFailure | null> => {
  const { report } = ctx;
  const fetchedChunks = await mapWithConcurrency(
    chunkEntries,
    WEB_APP_REPLAY_FETCH_CONCURRENCY,
    (entry) => fetchObject(ctx.source, "E", entry.objectIndex, ctx.signal)
  );
  let previous: TPreviousChunk = null;
  let expectedIndex = 0;
  for (let i = 0; i < chunkEntries.length; i += 1) {
    const entry = chunkEntries[i];
    const fetched = fetchedChunks[i];
    if (entry.objectIndex !== expectedIndex) previous = null;
    expectedIndex = entry.objectIndex + 1;
    if (fetched.kind === "failed") {
      return { series: "E", objectIndex: entry.objectIndex, message: fetched.message };
    }
    if (fetched.kind === "missing") {
      report.events.push({ series: "E", objectIndex: entry.objectIndex, status: "missing" });
      previous = null;
    } else {
      try {
        // eslint-disable-next-line no-await-in-loop
        const chunk = await verifyEventChunk(entry, fetched.bytes, ctx.sessionKey, previous);
        report.verifiedChunks.push(chunk);
        report.events.push({ series: "E", objectIndex: entry.objectIndex, status: "verified" });
        previous = { lastSeq: chunk.lastSeq, head: chunk.head };
      } catch (err) {
        report.events.push(toResult("E", entry.objectIndex, err));
        previous = null;
      }
    }
    ctx.tick();
  }
  return null;
};

const verifyVideoEntry = async (
  ctx: TVerifyContext,
  entry: TWebAppVideoEntry
): Promise<TObjectResult | TVerifiedVideoObject | TReplayFetchFailure> => {
  const fetched = await fetchObject(ctx.source, "V", entry.objectIndex, ctx.signal);
  try {
    if (fetched.kind === "failed") {
      return { series: "V", objectIndex: entry.objectIndex, message: fetched.message };
    }
    if (fetched.kind === "missing") {
      return { series: "V", objectIndex: entry.objectIndex, status: "missing" };
    }
    return await verifyVideoObject(entry, fetched.bytes, ctx.sessionKey);
  } catch (err) {
    return toResult("V", entry.objectIndex, err);
  } finally {
    ctx.tick();
  }
};

const verifyVideoObjects = async (
  ctx: TVerifyContext,
  videoEntries: TWebAppVideoEntry[],
  includeEvents: boolean
): Promise<TReplayFetchFailure | null> => {
  const { report } = ctx;
  const videoResults = await mapWithConcurrency(
    videoEntries,
    WEB_APP_REPLAY_FETCH_CONCURRENCY,
    (entry) => verifyVideoEntry(ctx, entry)
  );
  for (let i = 0; i < videoResults.length; i += 1) {
    const r = videoResults[i];
    if ("bytes" in r) {
      report.verifiedVideo.push(r);
      report.video.push({ series: "V", objectIndex: r.objectIndex, status: "verified" });
      if (includeEvents)
        report.bindings.set(r.objectIndex, checkVideoBinding(r, report.verifiedChunks));
    } else if ("status" in r) {
      report.video.push(r);
    } else {
      return r;
    }
  }
  return null;
};

const toLimitError = (err: unknown) =>
  err instanceof ReplayVerifyError ? err : new ReplayVerifyError("limits", String(err));

export const verifyReplay = async (
  source: TWebAppReplaySource,
  replay: TWebAppReplay,
  opts: {
    includeEvents: boolean;
    onProgress?: (p: TVerifyProgress) => void;
    signal?: AbortSignal;
  }
): Promise<TReplayVerificationReport> => {
  const videoEntries = [...replay.video.objects].sort((a, b) => a.objectIndex - b.objectIndex);
  const chunkEntries = opts.includeEvents
    ? [...replay.events.chunks].sort((a, b) => a.objectIndex - b.objectIndex)
    : [];
  const total = videoEntries.length + chunkEntries.length;
  const report: TReplayVerificationReport = emptyReport(
    await isEd25519Supported(),
    opts.includeEvents,
    total
  );
  if (!report.ed25519Supported) return report;

  if (
    videoEntries.length > WEB_APP_REPLAY_MAX_OBJECTS_PER_SERIES ||
    chunkEntries.length > WEB_APP_REPLAY_MAX_OBJECTS_PER_SERIES
  ) {
    report.limitError = new ReplayVerifyError(
      "limits",
      "recording has more objects than the viewer can load"
    );
    return report;
  }

  let sessionKey: TVerifiedSessionKey;
  try {
    sessionKey = await verifySessionKeyCert(replay, source.expectedSessionId);
  } catch (err) {
    report.keyCertError =
      err instanceof ReplayVerifyError ? err : new ReplayVerifyError("key_cert", String(err));
    return report;
  }
  report.sessionKey = sessionKey;

  const ctx: TVerifyContext = {
    source,
    sessionKey,
    report,
    signal: opts.signal,
    tick: () => {
      report.done += 1;
      opts.onProgress?.({ done: report.done, total });
    }
  };
  opts.onProgress?.({ done: 0, total });

  report.fetchFailure = await verifyEventChunks(ctx, chunkEntries);
  if (report.fetchFailure) return report;
  if (opts.includeEvents) {
    try {
      assertEventLimit(report.verifiedChunks);
    } catch (err) {
      report.limitError = toLimitError(err);
      return report;
    }
  }

  report.fetchFailure = await verifyVideoObjects(ctx, videoEntries, opts.includeEvents);
  return report;
};
