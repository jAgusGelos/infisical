import { TReplayTimeline } from "./events";
import { TObjectResult, TReplayVerificationReport, TVerifyProgress } from "./report";
import { TWebAppReplay, TWebAppReplaySeries } from "./types";

export type TIntegrityState =
  | "tampered"
  | "gap"
  | "incomplete"
  | "verifying"
  | "verified"
  | "not_verified";

export type TIntegrityChip = {
  state: TIntegrityState;
  label: string;
  detail: string;
};

type TUnexplainedGap = { message: string; objectIndex?: number };

const seriesName = (series: TWebAppReplaySeries) =>
  series === "V" ? "video object" : "event chunk";

const firstIndexGap = (indices: number[]) => {
  const sorted = [...indices].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) if (sorted[i] !== i) return i;
  return null;
};

const pendingChip = (progress?: TVerifyProgress | null): TIntegrityChip =>
  progress
    ? {
        state: "verifying",
        label: `Verifying ${progress.done}/${progress.total}`,
        detail: "Checking signatures, hashes and the event chain in this browser."
      }
    : { state: "not_verified", label: "Not verified", detail: "Verification has not run." };

const unverifiableReason = (report: TReplayVerificationReport) => {
  if (!report.ed25519Supported) return "This browser cannot check Ed25519 signatures.";
  if (report.limitError) return report.limitError.message;
  if (report.fetchFailure) return report.fetchFailure.message;
  if (!report.includesEvents) return "The event chain was not checked.";
  return null;
};

const tamperDetail = (report: TReplayVerificationReport, results: TObjectResult[]) => {
  if (report.keyCertError) return `Session key certificate: ${report.keyCertError.message}`;
  const tampered = results.find((r) => r.status === "tampered");
  if (tampered) {
    return `${seriesName(tampered.series)} ${tampered.objectIndex}: ${tampered.message ?? "verification failed"}`;
  }
  if ([...report.bindings.values()].includes("mismatch")) {
    return "A video object does not match its event in the chain.";
  }
  return null;
};

const findUnexplainedGap = (
  report: TReplayVerificationReport,
  results: TObjectResult[],
  timeline: TReplayTimeline | null,
  isEnded: boolean
): TUnexplainedGap | null => {
  const missing = results.find((r) => r.status === "missing");
  if (missing) {
    return {
      objectIndex: missing.objectIndex,
      message: `${seriesName(missing.series)} ${missing.objectIndex} is missing`
    };
  }
  const vGap = firstIndexGap(report.video.map((r) => r.objectIndex));
  if (vGap !== null) return { objectIndex: vGap, message: `video object ${vGap} is not listed` };
  const eGap = firstIndexGap(report.events.map((r) => r.objectIndex));
  if (eGap !== null) return { objectIndex: eGap, message: `event chunk ${eGap} is not listed` };
  const pending = isEnded ? [...report.bindings].find(([, b]) => b === "pending") : undefined;
  if (pending) {
    return {
      objectIndex: pending[0],
      message: `video object ${pending[0]} has no event in the chain`
    };
  }
  const end = timeline?.sessionEnd ?? null;
  if (!end) return isEnded ? { message: "the session end record is missing" } : null;
  if (end.vObjects > report.video.length) {
    return {
      objectIndex: report.video.length,
      message: `video object ${report.video.length} is missing`
    };
  }
  if (end.eChunks > report.events.length) {
    return {
      objectIndex: report.events.length,
      message: `event chunk ${report.events.length} is missing`
    };
  }
  return null;
};

// Priority: Tampered > Gap > Incomplete > Verified; a report that cannot be trusted at all is Not verified.
export const deriveIntegrity = ({
  replay,
  report,
  timeline,
  progress
}: {
  replay?: TWebAppReplay;
  report: TReplayVerificationReport | null;
  timeline: TReplayTimeline | null;
  progress?: TVerifyProgress | null;
}): TIntegrityChip => {
  if (!report) return pendingChip(progress);

  const unverifiable = unverifiableReason(report);
  if (unverifiable) return { state: "not_verified", label: "Not verified", detail: unverifiable };

  const results: TObjectResult[] = [...report.video, ...report.events];
  const tamper = tamperDetail(report, results);
  if (tamper) return { state: "tampered", label: "Tampered", detail: tamper };

  const gap = findUnexplainedGap(report, results, timeline, replay?.status !== "active");
  if (gap) {
    return {
      state: "gap",
      label: gap.objectIndex !== undefined ? `Gap · chunk ${gap.objectIndex}` : "Gap",
      detail: `Unexplained gap: ${gap.message}.`
    };
  }

  const reportedLoss = timeline?.flags.some(
    (f) => f.kind === "loss" || f.kind === "continuity_unknown"
  );
  if (reportedLoss) {
    return {
      state: "incomplete",
      label: "Incomplete · gateway-reported loss",
      detail: "The gateway recorded a signed loss or continuity-unknown interval."
    };
  }

  const total = results.length;
  return {
    state: "verified",
    label: replay?.manifest
      ? `Verified · ${total}/${total} chunks · anchored`
      : "Verified · anchor pending",
    detail: `${total}/${total} objects verified against the recording key.`
  };
};
