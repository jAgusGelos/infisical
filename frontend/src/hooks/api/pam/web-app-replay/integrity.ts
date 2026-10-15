import { TReplayTimeline } from "./events";
import { TObjectResult, TReplayVerificationReport, TVerifyProgress } from "./report";
import { TWebAppReplay } from "./types";

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

const seriesName = (r: { series: "V" | "E" }) =>
  r.series === "V" ? "video object" : "event chunk";

const firstIndexGap = (indices: number[]) => {
  const sorted = [...indices].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) if (sorted[i] !== i) return i;
  return null;
};

// Priority: Tampered > Gap > Incomplete > Verifying > Verified > Not verified (CONTRACTS.md 6.10 chip mapping).
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
  if (!report) {
    if (progress) {
      return {
        state: "verifying",
        label: `Verifying ${progress.done}/${progress.total}`,
        detail: "Checking signatures, hashes and the event chain in this browser."
      };
    }
    return { state: "not_verified", label: "Not verified", detail: "Verification has not run." };
  }
  if (!report.ed25519Supported) {
    return {
      state: "not_verified",
      label: "Not verified",
      detail: "This browser cannot check Ed25519 signatures."
    };
  }
  if (report.limitError || report.fetchFailure || !report.includesEvents) {
    return {
      state: "not_verified",
      label: "Not verified",
      detail:
        report.limitError?.message ??
        report.fetchFailure?.message ??
        "The event chain was not checked."
    };
  }

  const results: TObjectResult[] = [...report.video, ...report.events];
  const tampered = results.find((r) => r.status === "tampered");
  const mismatch = [...report.bindings].find(([, b]) => b === "mismatch");
  if (report.keyCertError || tampered || mismatch) {
    let detail = "A video object does not match its event in the chain.";
    if (report.keyCertError) detail = `Session key certificate: ${report.keyCertError.message}`;
    else if (tampered)
      detail = `${seriesName(tampered)} ${tampered.objectIndex}: ${tampered.message ?? "verification failed"}`;
    return { state: "tampered", label: "Tampered", detail };
  }

  const isEnded = replay?.status !== "active";
  const missing = results.find((r) => r.status === "missing");
  const vGap = firstIndexGap(report.video.map((r) => r.objectIndex));
  const eGap = firstIndexGap(report.events.map((r) => r.objectIndex));
  const end = timeline?.sessionEnd ?? null;
  const pending = isEnded ? [...report.bindings].find(([, b]) => b === "pending") : undefined;
  let gap: string | null = null;
  if (missing) gap = `${seriesName(missing)} ${missing.objectIndex} is missing`;
  else if (vGap !== null) gap = `video object ${vGap} is not listed`;
  else if (eGap !== null) gap = `event chunk ${eGap} is not listed`;
  else if (pending) gap = `video object ${pending[0]} has no event in the chain`;
  else if (isEnded && !end) gap = "the session end record is missing";
  else if (end && end.vObjects > report.video.length)
    gap = `video object ${report.video.length} is missing`;
  else if (end && end.eChunks > report.events.length)
    gap = `event chunk ${report.events.length} is missing`;
  if (gap) {
    const idx = /(\d+)/.exec(gap)?.[1];
    return {
      state: "gap",
      label: idx ? `Gap · chunk ${idx}` : "Gap",
      detail: `Unexplained gap: ${gap}.`
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
