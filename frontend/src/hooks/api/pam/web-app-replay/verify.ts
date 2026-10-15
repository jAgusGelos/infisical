import {
  base64ToBytes,
  bytesToHex,
  CheckpointKind,
  decodeEnvelopeBody,
  equalBytes,
  EventType,
  fingerprint as computeFingerprint,
  keyIdHex,
  parseEnvelopes,
  Series,
  sha256,
  TCheckpoint,
  TEnvelope,
  TKeyCert,
  uuidToBytes,
  verifyChainSegment,
  verifyCheckpoint,
  verifyKeyCert
} from "@app/lib/pam-web-app/contract";

import { WEB_APP_REPLAY_MAX_EVENTS, WEB_APP_REPLAY_MAX_OBJECT_BYTES } from "./limits";
import {
  TWebAppEventChunkEntry,
  TWebAppReplay,
  TWebAppVideoEntry,
  TWebAppVideoMediaEntry
} from "./types";

export type TReplayVerifyStep =
  | "key_cert"
  | "checkpoint"
  | "plaintext"
  | "chain"
  | "seq"
  | "binding"
  | "limits";

export class ReplayVerifyError extends Error {
  constructor(
    public step: TReplayVerifyStep,
    message: string,
    public series?: "V" | "E",
    public objectIndex?: number
  ) {
    super(message);
    this.name = "ReplayVerifyError";
  }
}

declare const verifiedBrand: unique symbol;

// Only this module creates these values, so anything typed TVerifiedVideoObject passed both the checkpoint
// signature and the plaintext hash check (CONTRACTS.md 6.10: verify before MSE).
export type TVerifiedVideoObject = {
  readonly [verifiedBrand]: true;
  objectIndex: number;
  kind: "init" | "media";
  initIndex: number;
  bytes: Uint8Array;
  checkpoint: TCheckpoint;
  entry: TWebAppVideoEntry;
};

export type TVerifiedEventChunk = {
  readonly [verifiedBrand]: true;
  objectIndex: number;
  checkpoint: TCheckpoint;
  envelopes: TEnvelope[];
  hashes: Uint8Array[];
  firstSeq: bigint;
  lastSeq: bigint;
  head: Uint8Array;
  // false when the previous chunk is missing, so the link into this chunk could not be checked
  linkedToPrevious: boolean;
};

export type TVerifiedSessionKey = {
  sessionPublicKey: Uint8Array;
  sessionIdBytes: Uint8Array;
  keyCert: TKeyCert;
  fingerprint: string;
  keyId: string;
};

const fail = (
  step: TReplayVerifyStep,
  message: string,
  series?: "V" | "E",
  objectIndex?: number
): never => {
  throw new ReplayVerifyError(step, message, series, objectIndex);
};

const decodeB64 = (value: string, what: string, step: TReplayVerifyStep) => {
  try {
    return base64ToBytes(value);
  } catch {
    return fail(step, `${what} is not valid base64`);
  }
};

let ed25519Support: Promise<boolean> | null = null;

export const isEd25519Supported = () => {
  if (!ed25519Support) {
    ed25519Support = (async () => {
      try {
        if (!globalThis.crypto?.subtle) return false;
        await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
        return true;
      } catch {
        return false;
      }
    })();
  }
  return ed25519Support;
};

export const verifySessionKeyCert = async (
  replay: TWebAppReplay,
  expectedSessionId?: string
): Promise<TVerifiedSessionKey> => {
  if (expectedSessionId && replay.sessionId !== expectedSessionId) {
    fail("key_cert", "replay response is for a different session");
  }
  const recordingPublicKey = decodeB64(
    replay.recordingKey.publicKey,
    "recording public key",
    "key_cert"
  );
  if (recordingPublicKey.length !== 32) fail("key_cert", "recording public key is not 32 bytes");

  const keyId = await keyIdHex(recordingPublicKey);
  const fingerprint = await computeFingerprint(recordingPublicKey);
  if (keyId !== replay.recordingKey.keyId) fail("key_cert", "recording key id does not match");
  if (fingerprint !== replay.recordingKey.fingerprint) {
    fail("key_cert", "recording key fingerprint does not match");
  }

  let keyCert: TKeyCert;
  try {
    keyCert = await verifyKeyCert(
      recordingPublicKey,
      decodeB64(replay.keyCert, "key cert", "key_cert"),
      decodeB64(replay.keyCertSig, "key cert signature", "key_cert")
    );
  } catch (err) {
    if (err instanceof ReplayVerifyError) throw err;
    return fail("key_cert", (err as Error).message);
  }

  let sessionIdBytes: Uint8Array;
  try {
    sessionIdBytes = uuidToBytes(replay.sessionId);
  } catch {
    return fail("key_cert", "session id is not a UUID");
  }
  if (!equalBytes(keyCert.sessionId, sessionIdBytes)) {
    fail("key_cert", "key cert is for a different session");
  }

  return {
    sessionPublicKey: keyCert.sessionPublicKey,
    sessionIdBytes,
    keyCert,
    fingerprint,
    keyId
  };
};

const verifyEntryCheckpoint = async (
  entry: { objectIndex: number; checkpoint: string; signature: string },
  series: Series,
  expectedKinds: CheckpointKind[],
  sessionKey: TVerifiedSessionKey
) => {
  const letter = series === Series.V ? "V" : "E";
  let cp: TCheckpoint;
  try {
    cp = await verifyCheckpoint(
      sessionKey.sessionPublicKey,
      decodeB64(entry.checkpoint, "checkpoint", "checkpoint"),
      decodeB64(entry.signature, "checkpoint signature", "checkpoint")
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("checkpoint", message, letter, entry.objectIndex);
  }
  if (!equalBytes(cp.sessionId, sessionKey.sessionIdBytes)) {
    fail("checkpoint", "checkpoint is for a different session", letter, entry.objectIndex);
  }
  if (cp.series !== series) {
    fail("checkpoint", "checkpoint series does not match", letter, entry.objectIndex);
  }
  if (!expectedKinds.includes(cp.kind)) {
    fail("checkpoint", "checkpoint kind does not match", letter, entry.objectIndex);
  }
  if (cp.objectIndex !== entry.objectIndex) {
    fail("checkpoint", "checkpoint object index does not match", letter, entry.objectIndex);
  }
  return cp;
};

const verifyPlaintext = async (
  cp: TCheckpoint,
  plaintext: Uint8Array,
  series: "V" | "E",
  objectIndex: number
) => {
  if (plaintext.length > WEB_APP_REPLAY_MAX_OBJECT_BYTES) {
    fail("limits", "object exceeds the size limit", series, objectIndex);
  }
  if (BigInt(plaintext.length) !== cp.plaintextBytes) {
    fail("plaintext", "plaintext length does not match the checkpoint", series, objectIndex);
  }
  if (!equalBytes(await sha256(plaintext), cp.plaintextSha256)) {
    fail("plaintext", "plaintext hash does not match the checkpoint", series, objectIndex);
  }
};

export const verifyVideoObject = async (
  entry: TWebAppVideoEntry,
  plaintext: Uint8Array,
  sessionKey: TVerifiedSessionKey
): Promise<TVerifiedVideoObject> => {
  const expectedKind = entry.kind === "init" ? CheckpointKind.VideoInit : CheckpointKind.VideoMedia;
  const cp = await verifyEntryCheckpoint(entry, Series.V, [expectedKind], sessionKey);
  await verifyPlaintext(cp, plaintext, "V", entry.objectIndex);
  return {
    objectIndex: entry.objectIndex,
    kind: entry.kind,
    initIndex: entry.kind === "init" ? entry.objectIndex : entry.initIndex,
    bytes: plaintext,
    checkpoint: cp,
    entry
  } as TVerifiedVideoObject;
};

const ZERO_HASH = new Uint8Array(32);

export type TPreviousChunk = { lastSeq: bigint; head: Uint8Array } | null;

export const verifyEventChunk = async (
  entry: TWebAppEventChunkEntry,
  plaintext: Uint8Array,
  sessionKey: TVerifiedSessionKey,
  previous: TPreviousChunk
): Promise<TVerifiedEventChunk> => {
  const idx = entry.objectIndex;
  const cp = await verifyEntryCheckpoint(entry, Series.E, [CheckpointKind.Events], sessionKey);
  await verifyPlaintext(cp, plaintext, "E", idx);

  const linkedToPrevious = cp.firstSeq === 0n || previous !== null;
  if (previous && cp.firstSeq !== previous.lastSeq + 1n) {
    fail("seq", `chunk starts at seq ${cp.firstSeq}, expected ${previous.lastSeq + 1n}`, "E", idx);
  }

  let result: Awaited<ReturnType<typeof verifyChainSegment>>;
  try {
    let prevHash = previous?.head ?? ZERO_HASH;
    if (!linkedToPrevious) {
      // The previous chunk is missing: the chain inside this chunk is still checked from its own first link.
      prevHash = parseEnvelopes(plaintext)[0]?.prevHash ?? ZERO_HASH;
    }
    result = await verifyChainSegment(plaintext, cp.firstSeq, prevHash);
  } catch (err) {
    return fail("chain", (err as Error).message, "E", idx);
  }
  if (result.lastSeq !== cp.lastSeq) {
    fail("seq", "chunk seq range does not match the checkpoint", "E", idx);
  }
  if (!equalBytes(result.head, cp.chainHead)) {
    fail("chain", "chain head does not match the checkpoint", "E", idx);
  }
  if (BigInt(entry.firstSeq) !== cp.firstSeq || BigInt(entry.lastSeq) !== cp.lastSeq) {
    fail("seq", "listed seq range does not match the checkpoint", "E", idx);
  }

  return {
    objectIndex: idx,
    checkpoint: cp,
    envelopes: result.envelopes,
    hashes: result.hashes,
    firstSeq: cp.firstSeq,
    lastSeq: cp.lastSeq,
    head: result.head,
    linkedToPrevious
  } as TVerifiedEventChunk;
};

type TVideoEventBody = { objectIndex: number; sha256: string };

export type TBindingResult = "bound" | "pending" | "mismatch";

// CONTRACTS.md 6.7: the V checkpoint's lastSeq names the v_init/v_segment event that carries its hash.
export const checkVideoBinding = (
  video: TVerifiedVideoObject,
  chunks: TVerifiedEventChunk[]
): TBindingResult => {
  const seq = video.checkpoint.lastSeq;
  const chunk = chunks.find((c) => c.firstSeq <= seq && seq <= c.lastSeq);
  if (!chunk) return "pending";
  const pos = Number(seq - chunk.firstSeq);
  const env = chunk.envelopes[pos];
  const expectedType = video.kind === "init" ? EventType.VInit : EventType.VSegment;
  if (!env || env.type !== expectedType) return "mismatch";
  let body: TVideoEventBody;
  try {
    body = decodeEnvelopeBody<TVideoEventBody>(env);
  } catch {
    return "mismatch";
  }
  if (body.objectIndex !== video.objectIndex) return "mismatch";
  if (body.sha256 !== bytesToHex(video.checkpoint.plaintextSha256)) return "mismatch";
  if (!equalBytes(chunk.hashes[pos], video.checkpoint.chainHead)) return "mismatch";
  return "bound";
};

export const countEnvelopes = (chunks: TVerifiedEventChunk[]) =>
  chunks.reduce((n, c) => n + c.envelopes.length, 0);

export const assertEventLimit = (chunks: TVerifiedEventChunk[]) => {
  if (countEnvelopes(chunks) > WEB_APP_REPLAY_MAX_EVENTS) {
    fail("limits", "recording has more events than the viewer can show");
  }
};

export const isMediaEntry = (entry: TWebAppVideoEntry): entry is TWebAppVideoMediaEntry =>
  entry.kind === "media";
