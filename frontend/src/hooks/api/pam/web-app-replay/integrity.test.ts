import { describe, expect, test } from "vitest";

import { TFlag, TReplayTimeline } from "./events";
import { deriveIntegrity } from "./integrity";
import { TObjectResult, TReplayVerificationReport } from "./report";
import { TWebAppReplay } from "./types";
import { ReplayVerifyError, TBindingResult } from "./verify";

const ok = (series: "V" | "E", objectIndex: number): TObjectResult => ({
  series,
  objectIndex,
  status: "verified"
});

const report = (over: Partial<TReplayVerificationReport> = {}): TReplayVerificationReport => ({
  ed25519Supported: true,
  sessionKey: null,
  keyCertError: null,
  limitError: null,
  fetchFailure: null,
  includesEvents: true,
  video: [ok("V", 0), ok("V", 1)],
  events: [ok("E", 0)],
  verifiedVideo: [],
  verifiedChunks: [],
  bindings: new Map<number, TBindingResult>([
    [0, "bound"],
    [1, "bound"]
  ]),
  done: 3,
  total: 3,
  ...over
});

const timeline = (flags: TFlag[] = [], withEnd = true): TReplayTimeline => ({
  l1Rows: [],
  inputRows: [],
  flags,
  actionPins: [],
  sessionOpen: null,
  sessionEnd: withEnd
    ? { reason: "user_end", finalSeq: 9, vObjects: 2, eChunks: 1, sessionMs: 1 }
    : null,
  lastEventMs: 1
});

const replay = { status: "ended", manifest: null } as unknown as TWebAppReplay;

const flag = (kind: TFlag["kind"]): TFlag => ({ id: kind, kind, fromMs: 0, toMs: 1, label: kind });

describe("deriveIntegrity", () => {
  test.each([
    ["verified", report(), timeline(), "Verified · anchor pending"],
    [
      "viewer degraded alone stays verified",
      report(),
      timeline([flag("viewer_degraded"), flag("blocked")]),
      "Verified · anchor pending"
    ],
    [
      "incomplete on loss",
      report(),
      timeline([flag("loss")]),
      "Incomplete · gateway-reported loss"
    ],
    [
      "incomplete on continuity unknown",
      report(),
      timeline([flag("continuity_unknown")]),
      "Incomplete · gateway-reported loss"
    ],
    [
      "gap on a missing object",
      report({ video: [ok("V", 0), { series: "V", objectIndex: 1, status: "missing" }] }),
      timeline(),
      "Gap · chunk 1"
    ],
    ["gap on an unlisted index", report({ events: [ok("E", 1)] }), timeline(), "Gap · chunk 0"],
    [
      "gap on a pending binding after the end",
      report({ bindings: new Map([[1, "pending" as const]]) }),
      timeline(),
      "Gap · chunk 1"
    ],
    ["gap without an end record", report(), timeline([], false), "Gap"],
    [
      "gap beats loss",
      report({ video: [ok("V", 0), { series: "V", objectIndex: 1, status: "missing" }] }),
      timeline([flag("loss")]),
      "Gap · chunk 1"
    ],
    [
      "tampered on a hash mismatch",
      report({
        video: [
          ok("V", 0),
          { series: "V", objectIndex: 1, status: "tampered", message: "plaintext hash" }
        ]
      }),
      timeline([flag("loss")]),
      "Tampered"
    ],
    [
      "tampered on a binding mismatch",
      report({ bindings: new Map([[1, "mismatch" as const]]) }),
      timeline(),
      "Tampered"
    ],
    [
      "tampered on a bad key cert",
      report({ keyCertError: new ReplayVerifyError("key_cert", "bad") }),
      timeline(),
      "Tampered"
    ],
    [
      "not verified without Ed25519",
      report({ ed25519Supported: false }),
      timeline(),
      "Not verified"
    ]
  ])("%s", (_, r, tl, label) => {
    expect(deriveIntegrity({ replay, report: r, timeline: tl }).label).toBe(label);
  });

  test("verifying shows progress before the report exists", () => {
    expect(
      deriveIntegrity({ report: null, timeline: null, progress: { done: 18, total: 42 } }).label
    ).toBe("Verifying 18/42");
  });

  test("not verified before anything ran", () => {
    expect(deriveIntegrity({ report: null, timeline: null }).state).toBe("not_verified");
  });

  test("anchored when a manifest is present", () => {
    const anchored = { ...replay, manifest: {} } as TWebAppReplay;
    expect(
      deriveIntegrity({ replay: anchored, report: report(), timeline: timeline() }).label
    ).toBe("Verified · 3/3 chunks · anchored");
  });

  test("an active session may still have pending bindings and no end record", () => {
    const active = { ...replay, status: "active" } as TWebAppReplay;
    const r = report({ bindings: new Map([[1, "pending" as const]]) });
    expect(
      deriveIntegrity({ replay: active, report: r, timeline: timeline([], false) }).state
    ).toBe("verified");
  });
});
