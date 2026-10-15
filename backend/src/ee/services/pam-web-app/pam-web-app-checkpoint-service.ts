import { z } from "zod";

import { TPamWebAppObjects, TPamWebAppObjectsUpdate, TPamWebAppSessionKeys } from "@app/db/schemas";
import { BadRequestError, ForbiddenRequestError, NotFoundError } from "@app/lib/errors";
import { logger } from "@app/lib/logger";
import { OrgServiceActor } from "@app/lib/types";
import { ActorType } from "@app/services/auth/auth-type";

import { PamAccountType, PamSessionStatus } from "../pam/pam-enums";
import { PamRecordingStorageBackend } from "../pam-session-recording/pam-recording-enums";
import { verifyGatewayUploadToken } from "../pam-session-recording/pam-recording-secrets";
import {
  TPamRecordingResolvedConfig,
  TPamRecordingStorageProvider
} from "../pam-session-recording/pam-recording-storage-types";
import {
  base64ToBytes,
  buildAad,
  bytesToBase64,
  bytesToHex,
  CheckpointKind,
  decodeEnvelopeBody,
  equalBytes,
  EventType,
  fingerprint as computeFingerprint,
  keyCommitment,
  keyIdHex,
  objectKey as buildObjectKey,
  openObject,
  parseCheckpoint,
  parseEnvelopes,
  Series,
  sha256,
  TCheckpoint,
  TEnvelope,
  uuidToBytes,
  verifyChainSegment,
  verifyCheckpoint,
  verifyKeyCert
} from "./contract";
import { TPamWebAppObjectDALFactory, TPamWebAppSessionKeyDALFactory } from "./pam-web-app-dal";
import { PamWebAppError, PamWebAppErrorCode } from "./pam-web-app-errors";

export const PAM_WEB_APP_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
export const PAM_WEB_APP_MAX_EVENTS_SEQ_SPAN = 10_000;
const PAM_WEB_APP_MAX_EVENT_CHUNKS_PER_READ = 100;
const ZERO_HASH = new Uint8Array(32);

export enum PamWebAppSeries {
  E = "E",
  V = "V"
}

export enum PamWebAppObjectKind {
  Events = "events",
  Init = "init",
  Media = "media"
}

export enum PamWebAppBinding {
  Bound = "bound",
  Pending = "pending",
  Mismatch = "mismatch"
}

export enum PamWebAppEventStream {
  L1 = "L1",
  L3 = "L3",
  Lifecycle = "lifecycle",
  V = "V",
  Index = "index"
}

// CONTRACTS 5.1. V events also show on the lifecycle lane, next to the session markers.
const EVENT_TYPES: Record<number, { name: string; streams: PamWebAppEventStream[] }> = {
  [EventType.SessionOpen]: { name: "session_open", streams: [PamWebAppEventStream.Lifecycle] },
  [EventType.Heartbeat]: { name: "heartbeat", streams: [PamWebAppEventStream.Lifecycle] },
  [EventType.SessionEnd]: { name: "session_end", streams: [PamWebAppEventStream.Lifecycle] },
  [EventType.Loss]: { name: "loss", streams: [PamWebAppEventStream.Lifecycle] },
  [EventType.ContinuityUnknown]: { name: "continuity_unknown", streams: [PamWebAppEventStream.Lifecycle] },
  [EventType.ViewerDegraded]: { name: "viewer_degraded", streams: [PamWebAppEventStream.Lifecycle] },
  [EventType.LiveCodec]: { name: "live_codec", streams: [PamWebAppEventStream.Lifecycle] },
  [EventType.VInit]: { name: "v_init", streams: [PamWebAppEventStream.V, PamWebAppEventStream.Lifecycle] },
  [EventType.VSegment]: { name: "v_segment", streams: [PamWebAppEventStream.V, PamWebAppEventStream.Lifecycle] },
  [EventType.L1Request]: { name: "l1_request", streams: [PamWebAppEventStream.L1] },
  [EventType.L1Response]: { name: "l1_response", streams: [PamWebAppEventStream.L1] },
  [EventType.L1WsFrame]: { name: "l1_ws_frame", streams: [PamWebAppEventStream.L1] },
  [EventType.L1Blocked]: { name: "l1_blocked", streams: [PamWebAppEventStream.L1] },
  [EventType.L3Input]: { name: "l3_input", streams: [PamWebAppEventStream.L3] },
  [EventType.ExtEvent]: { name: "ext_event", streams: [PamWebAppEventStream.L3] },
  [EventType.Rrweb]: { name: "rrweb", streams: [PamWebAppEventStream.Index] }
};

// CONTRACTS 5.2; v_init carries only objectIndex and sha256 of these.
const VideoEventBodySchema = z.object({
  objectIndex: z.number().int().nonnegative(),
  sha256: z.string(),
  initIndex: z.number().int().nonnegative().optional(),
  startPtsUs: z.number().int().optional(),
  endPtsUs: z.number().int().optional(),
  monoStartUs: z.number().int().optional(),
  monoEndUs: z.number().int().optional(),
  frameCount: z.number().int().nonnegative().optional(),
  framesDropped: z.number().int().nonnegative().optional()
});

type TDecodedChunk = { envelopes: TEnvelope[]; hashes: Uint8Array[] };

type TVideoRow = Pick<TPamWebAppObjects, "objectIndex" | "kind" | "lastSeq" | "chainHead" | "plaintextSha256">;

// A V object is bound when the event with seq == its lastSeq is its v_init/v_segment, hashes to its chainHead and
// names its plaintext SHA-256 (CONTRACTS 6.7, last paragraph).
const computeVideoBinding = (chunk: TDecodedChunk, row: TVideoRow): TPamWebAppObjectsUpdate => {
  const mismatch = { binding: PamWebAppBinding.Mismatch };
  const seq = BigInt(String(row.lastSeq));
  const i = chunk.envelopes.findIndex((env) => env.seq === seq);
  if (i < 0) return mismatch;

  const env = chunk.envelopes[i];
  const expectedType = row.kind === PamWebAppObjectKind.Init ? EventType.VInit : EventType.VSegment;
  if (env.type !== expectedType || !equalBytes(chunk.hashes[i], new Uint8Array(row.chainHead))) return mismatch;

  let body: z.infer<typeof VideoEventBodySchema>;
  try {
    body = VideoEventBodySchema.parse(decodeEnvelopeBody(env));
  } catch {
    return mismatch;
  }
  if (
    body.objectIndex !== row.objectIndex ||
    body.sha256.toLowerCase() !== bytesToHex(new Uint8Array(row.plaintextSha256))
  ) {
    return mismatch;
  }

  if (row.kind === PamWebAppObjectKind.Init) return { binding: PamWebAppBinding.Bound };
  return {
    binding: PamWebAppBinding.Bound,
    initIndex: body.initIndex ?? null,
    startPtsUs: body.startPtsUs ?? null,
    endPtsUs: body.endPtsUs ?? null,
    monoStartUs: body.monoStartUs ?? null,
    monoEndUs: body.monoEndUs ?? null,
    frameCount: body.frameCount ?? null,
    framesDropped: body.framesDropped ?? null
  };
};

const KIND_TO_CHECKPOINT: Record<PamWebAppObjectKind, CheckpointKind> = {
  [PamWebAppObjectKind.Events]: CheckpointKind.Events,
  [PamWebAppObjectKind.Init]: CheckpointKind.VideoInit,
  [PamWebAppObjectKind.Media]: CheckpointKind.VideoMedia
};

const CHECKPOINT_TO_KIND: Record<CheckpointKind, PamWebAppObjectKind> = {
  [CheckpointKind.Events]: PamWebAppObjectKind.Events,
  [CheckpointKind.VideoInit]: PamWebAppObjectKind.Init,
  [CheckpointKind.VideoMedia]: PamWebAppObjectKind.Media
};

const toSeries = (series: PamWebAppSeries) => (series === PamWebAppSeries.V ? Series.V : Series.E);
const toSeriesLetter = (series: Series) => (series === Series.V ? PamWebAppSeries.V : PamWebAppSeries.E);

// Postgres hands bigint columns back as strings.
const toNumber = (v: unknown) => (v === null || v === undefined ? null : Number(v));

type TWebAppSession = {
  id: string;
  projectId: string;
  accountId?: string | null;
  accountType: string;
  status: string;
  startedAt?: Date | null;
  endedAt?: Date | null;
  createdAt: Date;
  gatewayId?: string | null;
  gatewayIdentityId?: string | null;
  gatewayUploadTokenHash?: Buffer | null;
  encryptedSessionKey?: Buffer | null;
};

export type TPamWebAppStorage = {
  config: TPamRecordingResolvedConfig;
  provider: ReturnType<TPamRecordingStorageProvider>;
};

type TPamWebAppCheckpointServiceFactoryDep = {
  pamSessionDAL: { findById: (id: string) => Promise<TWebAppSession | undefined> };
  pamWebAppSessionKeyDAL: Pick<
    TPamWebAppSessionKeyDALFactory,
    "findBySessionId" | "findBySessionIdForUpdate" | "findGatewayPin" | "create" | "update" | "transaction"
  >;
  pamWebAppObjectDAL: Pick<
    TPamWebAppObjectDALFactory,
    | "findBySessionId"
    | "findObject"
    | "insertIfAbsent"
    | "update"
    | "updateById"
    | "findPendingVideoInRange"
    | "findEventChunkCovering"
    | "findEventChunksInRange"
  >;
  // Resolves where this account's recording objects live; null when it has no recording storage.
  resolveStorage: (accountId: string) => Promise<TPamWebAppStorage | null>;
  getSessionKey: (session: TWebAppSession) => Promise<Uint8Array>;
  assertSessionViewAccess: (session: TWebAppSession, actor: OrgServiceActor) => Promise<void>;
  now?: () => number;
};

export type TPamWebAppCheckpointServiceFactory = ReturnType<typeof pamWebAppCheckpointServiceFactory>;

type TGatewayRequest = { sessionId: string; uploadToken: string | undefined };

export const pamWebAppCheckpointServiceFactory = ({
  pamSessionDAL,
  pamWebAppSessionKeyDAL,
  pamWebAppObjectDAL,
  resolveStorage,
  getSessionKey,
  assertSessionViewAccess,
  now = Date.now
}: TPamWebAppCheckpointServiceFactoryDep) => {
  const getWebAppSession = async (sessionId: string) => {
    const session = await pamSessionDAL.findById(sessionId);
    if (!session || session.accountType !== PamAccountType.WebApp) {
      throw new NotFoundError({ message: `Web App session '${sessionId}' not found` });
    }
    return session;
  };

  const getGatewaySession = async ({ sessionId, uploadToken }: TGatewayRequest, actor: OrgServiceActor) => {
    if (actor.type !== ActorType.IDENTITY && actor.type !== ActorType.GATEWAY) {
      throw new ForbiddenRequestError({ message: "Only gateways can perform this action" });
    }
    const session = await getWebAppSession(sessionId);
    if (actor.type === ActorType.GATEWAY && session.gatewayId && session.gatewayId !== actor.id) {
      throw new ForbiddenRequestError({ message: "Gateway not authorized for this session" });
    }
    if (actor.type === ActorType.IDENTITY && session.gatewayIdentityId && session.gatewayIdentityId !== actor.id) {
      throw new ForbiddenRequestError({ message: "Identity not authorized for this session" });
    }
    verifyGatewayUploadToken(uploadToken, session.gatewayUploadTokenHash ?? null);
    return session;
  };

  const getObjectStorage = async (session: TWebAppSession) => {
    const storage = session.accountId ? await resolveStorage(session.accountId) : null;
    if (!storage) {
      throw new BadRequestError({
        message: `Web App session '${session.id}' has no recording storage. Configure S3 recording storage on the account template.`
      });
    }
    if (storage.config.backend !== PamRecordingStorageBackend.AwsS3) {
      throw new PamWebAppError(
        PamWebAppErrorCode.ObjectLockRequired,
        "Web App recordings require S3 object storage with Object Lock; the account template uses Postgres storage"
      );
    }
    return storage;
  };

  const open = async (
    request: TGatewayRequest & {
      recordingPublicKey: string;
      fingerprint: string;
      keyCert: string;
      keyCertSig: string;
    },
    actor: OrgServiceActor
  ) => {
    const session = await getGatewaySession(request, actor);

    const recordingPublicKey = base64ToBytes(request.recordingPublicKey);
    const keyCertBytes = base64ToBytes(request.keyCert);
    const keyCertSig = base64ToBytes(request.keyCertSig);
    if (recordingPublicKey.length !== 32 || keyCertBytes.length !== 80 || keyCertSig.length !== 64) {
      throw new BadRequestError({
        message: "recordingPublicKey, keyCert and keyCertSig must be 32, 80 and 64 bytes of base64"
      });
    }

    const expectedFingerprint = await computeFingerprint(recordingPublicKey);
    if (expectedFingerprint !== request.fingerprint) {
      throw new BadRequestError({ message: "fingerprint does not match recordingPublicKey" });
    }

    let cert;
    try {
      cert = await verifyKeyCert(recordingPublicKey, keyCertBytes, keyCertSig);
    } catch (err) {
      logger.warn({ sessionId: session.id }, `Web App key cert rejected [sessionId=${session.id}]`);
      throw new PamWebAppError(PamWebAppErrorCode.BadSignature, `Key certificate rejected: ${(err as Error).message}`);
    }
    if (!equalBytes(cert.sessionId, uuidToBytes(session.id))) {
      throw new PamWebAppError(PamWebAppErrorCode.BadSignature, "Key certificate is bound to a different session");
    }
    if (BigInt(now()) > cert.notAfterUnixMs) {
      throw new PamWebAppError(PamWebAppErrorCode.BadSignature, "Key certificate has expired");
    }

    if (session.gatewayId) {
      const pin = await pamWebAppSessionKeyDAL.findGatewayPin(session.gatewayId);
      if (pin && !equalBytes(new Uint8Array(pin.recordingPublicKey), recordingPublicKey)) {
        throw new PamWebAppError(
          PamWebAppErrorCode.RecordingKeyMismatch,
          `Gateway's recording key changed: expected fingerprint ${pin.fingerprint}, got ${request.fingerprint}`
        );
      }
    }

    const existing = await pamWebAppSessionKeyDAL.findBySessionId(session.id);
    if (existing) {
      const same =
        equalBytes(new Uint8Array(existing.keyCert), keyCertBytes) &&
        equalBytes(new Uint8Array(existing.keyCertSig), keyCertSig) &&
        equalBytes(new Uint8Array(existing.recordingPublicKey), recordingPublicKey);
      if (!same) {
        throw new PamWebAppError(PamWebAppErrorCode.Conflict, "This session was already opened with a different key");
      }
      return { ok: true as const };
    }

    await pamWebAppSessionKeyDAL.create({
      sessionId: session.id,
      gatewayId: session.gatewayId ?? null,
      recordingPublicKey: Buffer.from(recordingPublicKey),
      recordingKeyId: await keyIdHex(recordingPublicKey),
      fingerprint: expectedFingerprint,
      keyCert: Buffer.from(keyCertBytes),
      keyCertSig: Buffer.from(keyCertSig),
      sessionPublicKey: Buffer.from(cert.sessionPublicKey),
      sessionKeyId: await keyIdHex(cert.sessionPublicKey)
    });

    logger.info(
      { sessionId: session.id, fingerprint: expectedFingerprint },
      `Web App recording opened [sessionId=${session.id}] [fingerprint=${expectedFingerprint}]`
    );
    return { ok: true as const };
  };

  const presign = async (
    request: TGatewayRequest & {
      series: PamWebAppSeries;
      objectIndex: number;
      kind: PamWebAppObjectKind;
      ciphertextBytes: number;
      ciphertextSha256: string;
    },
    actor: OrgServiceActor
  ) => {
    const session = await getGatewaySession(request, actor);

    const isEventKind = request.kind === PamWebAppObjectKind.Events;
    if ((request.series === PamWebAppSeries.E) !== isEventKind) {
      throw new BadRequestError({
        message: `Object kind '${request.kind}' is not valid for series '${request.series}'`
      });
    }
    if (request.ciphertextBytes > PAM_WEB_APP_MAX_OBJECT_BYTES) {
      throw new BadRequestError({
        message: `Object is too large [bytes=${request.ciphertextBytes}, max=${PAM_WEB_APP_MAX_OBJECT_BYTES}]`
      });
    }
    if (base64ToBytes(request.ciphertextSha256).length !== 32) {
      throw new BadRequestError({ message: "ciphertextSha256 must be a base64 SHA-256 digest" });
    }

    const { config, provider } = await getObjectStorage(session);
    const key = buildObjectKey(
      config.keyPrefix ?? "",
      session.projectId,
      session.id,
      toSeries(request.series),
      KIND_TO_CHECKPOINT[request.kind],
      request.objectIndex
    );

    return provider.mintPresignedCreateOnlyPut({
      config,
      objectKey: key,
      ciphertextBytes: request.ciphertextBytes,
      ciphertextSha256B64: request.ciphertextSha256
    });
  };

  const parseAndVerifyCheckpoint = async (
    session: TWebAppSession,
    keys: TPamWebAppSessionKeys,
    checkpointBytes: Uint8Array,
    signature: Uint8Array
  ) => {
    let cp: TCheckpoint;
    try {
      cp = parseCheckpoint(checkpointBytes);
    } catch (err) {
      throw new BadRequestError({ message: `Malformed checkpoint: ${(err as Error).message}` });
    }

    if (!equalBytes(cp.sessionId, uuidToBytes(session.id))) {
      throw new PamWebAppError(PamWebAppErrorCode.BadSignature, "Checkpoint is bound to a different session");
    }
    if (bytesToHex(cp.signerKeyId) !== keys.sessionKeyId) {
      throw new PamWebAppError(
        PamWebAppErrorCode.UnknownKey,
        "Checkpoint is signed by a key this session never opened"
      );
    }
    try {
      await verifyCheckpoint(new Uint8Array(keys.sessionPublicKey), checkpointBytes, signature);
    } catch {
      throw new PamWebAppError(PamWebAppErrorCode.BadSignature, "Checkpoint signature is invalid");
    }

    const sessionKey = await getSessionKey(session);
    if (!equalBytes(cp.keyCommitment, await keyCommitment(sessionKey))) {
      throw new PamWebAppError(
        PamWebAppErrorCode.BadSignature,
        "Checkpoint key commitment does not match the session key"
      );
    }
    return { cp, sessionKey };
  };

  type TStoredRef = {
    series: PamWebAppSeries;
    objectIndex: number;
    objectKey: string;
    versionId?: string | null;
    ciphertextSha256: Uint8Array;
    plaintextSha256: Uint8Array;
  };

  const readStoredObject = async (
    session: TWebAppSession,
    { config, provider }: TPamWebAppStorage,
    ref: TStoredRef
  ) => {
    const stored = new Uint8Array(
      await provider.getObject({ config, objectKey: ref.objectKey, versionId: ref.versionId ?? undefined })
    );
    if (!equalBytes(await sha256(stored), ref.ciphertextSha256)) {
      logger.warn(
        { sessionId: session.id, series: ref.series, objectIndex: ref.objectIndex },
        `Web App stored object does not match its checkpoint [sessionId=${session.id}] [series=${ref.series}] [objectIndex=${ref.objectIndex}]`
      );
      throw new PamWebAppError(
        PamWebAppErrorCode.ChecksumMismatch,
        `Stored object ${ref.series}/${ref.objectIndex} does not match its signed checkpoint`
      );
    }
    return stored;
  };

  const decryptStoredObject = async (
    session: TWebAppSession,
    sessionKey: Uint8Array,
    ref: TStoredRef,
    stored: Uint8Array
  ) => {
    const aad = await buildAad(session.projectId, session.id, toSeries(ref.series), ref.objectIndex);
    let plaintext: Uint8Array;
    try {
      plaintext = await openObject(sessionKey, stored, aad);
    } catch {
      throw new PamWebAppError(
        PamWebAppErrorCode.ChecksumMismatch,
        `Object ${ref.series}/${ref.objectIndex} failed to decrypt`
      );
    }
    if (!equalBytes(await sha256(plaintext), ref.plaintextSha256)) {
      throw new PamWebAppError(
        PamWebAppErrorCode.BadSignature,
        `Object ${ref.series}/${ref.objectIndex} plaintext does not match its signed checkpoint`
      );
    }
    return plaintext;
  };

  const readPlaintext = async (
    session: TWebAppSession,
    storage: TPamWebAppStorage,
    sessionKey: Uint8Array,
    ref: TStoredRef
  ) => decryptStoredObject(session, sessionKey, ref, await readStoredObject(session, storage, ref));

  const rowRef = (row: TPamWebAppObjects): TStoredRef => ({
    series: row.series as PamWebAppSeries,
    objectIndex: row.objectIndex,
    objectKey: row.objectKey,
    versionId: row.versionId,
    ciphertextSha256: new Uint8Array(row.ciphertextSha256),
    plaintextSha256: new Uint8Array(row.plaintextSha256)
  });

  // The chain is checked from the chunk's own first prevHash; linking it to the previous chunk needs the
  // locked session row and happens inside the transaction.
  const decodeEventChunk = async (plaintext: Uint8Array, firstSeq: bigint, objectIndex: number) => {
    try {
      const [first] = parseEnvelopes(plaintext);
      if (!first) throw new Error("empty chunk");
      const { head, lastSeq, envelopes, hashes } = await verifyChainSegment(plaintext, firstSeq, first.prevHash);
      return { head, lastSeq, envelopes, hashes, prevHash: first.prevHash };
    } catch (err) {
      throw new PamWebAppError(
        PamWebAppErrorCode.BadSignature,
        `Event chunk ${objectIndex} does not form a valid chain: ${(err as Error).message}`
      );
    }
  };

  const assertHeadMatches = async (
    { config, provider }: TPamWebAppStorage,
    request: { objectKey: string; versionId?: string },
    cp: TCheckpoint
  ) => {
    const head = await provider.headObject({ config, objectKey: request.objectKey });
    if (!head) {
      throw new PamWebAppError(
        PamWebAppErrorCode.ChecksumMismatch,
        `Object '${request.objectKey}' is not in the storage bucket; upload it before submitting its checkpoint`
      );
    }
    if (request.versionId && head.versionId !== request.versionId) {
      throw new PamWebAppError(
        PamWebAppErrorCode.VersionMismatch,
        `Stored object version '${head.versionId ?? "none"}' does not match the submitted version '${request.versionId}'`
      );
    }
    if (head.checksumSha256 !== bytesToBase64(cp.ciphertextSha256)) {
      throw new PamWebAppError(
        PamWebAppErrorCode.ChecksumMismatch,
        "Stored object checksum does not match the checkpoint ciphertextSha256"
      );
    }
  };

  // Binds a V object whose covering E chunk was accepted before it. Runs after the accept transaction because it
  // reads and decrypts that chunk; a failure leaves the object pending.
  const bindVideoToAcceptedChunk = async (
    session: TWebAppSession,
    storage: TPamWebAppStorage,
    sessionKey: Uint8Array,
    video: TPamWebAppObjects,
    chunkRow: TPamWebAppObjects
  ) => {
    try {
      const plaintext = await readPlaintext(session, storage, sessionKey, rowRef(chunkRow));
      const chunk = await decodeEventChunk(plaintext, BigInt(String(chunkRow.firstSeq)), chunkRow.objectIndex);
      const update = computeVideoBinding(chunk, video);
      await pamWebAppObjectDAL.update({ id: video.id, binding: PamWebAppBinding.Pending }, update);
      return update.binding as PamWebAppBinding;
    } catch (err) {
      logger.warn(
        { sessionId: session.id, objectIndex: video.objectIndex },
        `Web App video binding deferred [sessionId=${session.id}] [objectIndex=${video.objectIndex}] [reason=${(err as Error).message}]`
      );
      return PamWebAppBinding.Pending;
    }
  };

  const submitCheckpoint = async (
    request: TGatewayRequest & { checkpoint: string; signature: string; objectKey: string; versionId?: string },
    actor: OrgServiceActor
  ) => {
    const session = await getGatewaySession(request, actor);

    const keys = await pamWebAppSessionKeyDAL.findBySessionId(session.id);
    if (!keys) {
      throw new PamWebAppError(
        PamWebAppErrorCode.UnknownKey,
        "Open the Web App recording before submitting checkpoints"
      );
    }

    const checkpointBytes = base64ToBytes(request.checkpoint);
    const signature = base64ToBytes(request.signature);
    if (signature.length !== 64) throw new BadRequestError({ message: "signature must be 64 bytes of base64" });

    const { cp, sessionKey } = await parseAndVerifyCheckpoint(session, keys, checkpointBytes, signature);
    const series = toSeriesLetter(cp.series);
    const isEvents = cp.series === Series.E;

    const storage = await getObjectStorage(session);
    const expectedKey = buildObjectKey(
      storage.config.keyPrefix ?? "",
      session.projectId,
      session.id,
      cp.series,
      cp.kind,
      cp.objectIndex
    );
    if (request.objectKey !== expectedKey) {
      throw new BadRequestError({ message: `objectKey does not match the checkpoint; expected '${expectedKey}'` });
    }

    const duplicateOrConflict = (row: TPamWebAppObjects | undefined) => {
      const same =
        row &&
        equalBytes(new Uint8Array(row.checkpoint), checkpointBytes) &&
        equalBytes(new Uint8Array(row.signature), signature) &&
        (row.versionId ?? null) === (request.versionId ?? null);
      if (same) return { accepted: true as const, duplicate: true as const, checkpoint: cp };
      throw new PamWebAppError(
        PamWebAppErrorCode.Conflict,
        `Object ${series}/${cp.objectIndex} already has a different checkpoint`
      );
    };

    const existing = await pamWebAppObjectDAL.findObject(session.id, series, cp.objectIndex);
    if (existing) return duplicateOrConflict(existing);

    // Network and crypto first: the transaction below only re-checks state and writes.
    await assertHeadMatches(storage, request, cp);

    const ref: TStoredRef = {
      series,
      objectIndex: cp.objectIndex,
      objectKey: request.objectKey,
      versionId: request.versionId,
      ciphertextSha256: cp.ciphertextSha256,
      plaintextSha256: cp.plaintextSha256
    };
    let chunk: Awaited<ReturnType<typeof decodeEventChunk>> | null = null;
    if (isEvents) {
      const plaintext = await readPlaintext(session, storage, sessionKey, ref);
      chunk = await decodeEventChunk(plaintext, cp.firstSeq, cp.objectIndex);
      if (!equalBytes(chunk.head, cp.chainHead) || chunk.lastSeq !== cp.lastSeq) {
        throw new PamWebAppError(
          PamWebAppErrorCode.BadSignature,
          `Event chunk ${cp.objectIndex} does not match its checkpoint chainHead and seq range`
        );
      }
    }

    const outcome = await pamWebAppSessionKeyDAL.transaction(async (tx) => {
      const locked = await pamWebAppSessionKeyDAL.findBySessionIdForUpdate(session.id, tx);
      if (!locked) {
        throw new PamWebAppError(PamWebAppErrorCode.UnknownKey, "The Web App recording of this session is gone");
      }

      const current = await pamWebAppObjectDAL.findObject(session.id, series, cp.objectIndex, tx);
      if (current) return { duplicateOf: current };

      if (chunk) {
        const lastIndex = toNumber(locked.lastEObjectIndex);
        const lastSeq = toNumber(locked.lastESeq);
        const expectedIndex = lastIndex === null ? 0 : lastIndex + 1;
        const expectedFirstSeq = lastSeq === null ? 0 : lastSeq + 1;
        if (cp.objectIndex !== expectedIndex || Number(cp.firstSeq) !== expectedFirstSeq) {
          throw new PamWebAppError(
            PamWebAppErrorCode.SeqGap,
            `Expected event chunk ${expectedIndex} starting at seq ${expectedFirstSeq}, got chunk ${cp.objectIndex} starting at seq ${cp.firstSeq}`
          );
        }
        const prevHead = locked.eChainHead ? new Uint8Array(locked.eChainHead) : ZERO_HASH;
        if (!equalBytes(chunk.prevHash, prevHead)) {
          throw new PamWebAppError(
            PamWebAppErrorCode.BadSignature,
            `Event chunk ${cp.objectIndex} does not link to the previous chunk's chainHead`
          );
        }
      }

      const inserted = await pamWebAppObjectDAL.insertIfAbsent(
        {
          sessionId: session.id,
          series,
          objectIndex: cp.objectIndex,
          kind: CHECKPOINT_TO_KIND[cp.kind],
          objectKey: request.objectKey,
          versionId: request.versionId ?? null,
          checkpoint: Buffer.from(checkpointBytes),
          signature: Buffer.from(signature),
          firstSeq: Number(cp.firstSeq),
          lastSeq: Number(cp.lastSeq),
          chainHead: Buffer.from(cp.chainHead),
          plaintextSha256: Buffer.from(cp.plaintextSha256),
          ciphertextSha256: Buffer.from(cp.ciphertextSha256),
          plaintextBytes: Number(cp.plaintextBytes),
          ciphertextBytes: Number(cp.ciphertextBytes),
          binding: isEvents ? PamWebAppBinding.Bound : PamWebAppBinding.Pending
        },
        tx
      );
      if (!inserted) {
        return { duplicateOf: await pamWebAppObjectDAL.findObject(session.id, series, cp.objectIndex, tx) };
      }

      if (!chunk) {
        const covering = await pamWebAppObjectDAL.findEventChunkCovering(session.id, Number(cp.lastSeq), tx);
        return { inserted, covering: covering ?? null };
      }

      await pamWebAppSessionKeyDAL.update(
        { sessionId: session.id },
        { lastESeq: Number(cp.lastSeq), lastEObjectIndex: cp.objectIndex, eChainHead: Buffer.from(cp.chainHead) },
        tx
      );
      const pending = await pamWebAppObjectDAL.findPendingVideoInRange(
        session.id,
        Number(cp.firstSeq),
        Number(cp.lastSeq),
        tx
      );
      const decoded = chunk;
      await Promise.all(
        pending.map((video) => pamWebAppObjectDAL.updateById(video.id, computeVideoBinding(decoded, video), tx))
      );
      return { inserted, covering: null };
    });

    if ("duplicateOf" in outcome) return duplicateOrConflict(outcome.duplicateOf);

    if (outcome.covering) {
      await bindVideoToAcceptedChunk(session, storage, sessionKey, outcome.inserted, outcome.covering);
    }

    logger.info(
      { sessionId: session.id, series, objectIndex: cp.objectIndex },
      `Web App checkpoint accepted [sessionId=${session.id}] [series=${series}] [objectIndex=${cp.objectIndex}]`
    );
    return { accepted: true as const, duplicate: false as const, checkpoint: cp };
  };

  const getViewableSession = async (sessionId: string, actor: OrgServiceActor) => {
    const session = await getWebAppSession(sessionId);
    await assertSessionViewAccess(session, actor);
    return session;
  };

  const getReplay = async (sessionId: string, actor: OrgServiceActor) => {
    const session = await getViewableSession(sessionId, actor);
    const keys = await pamWebAppSessionKeyDAL.findBySessionId(session.id);
    if (!keys) throw new NotFoundError({ message: `No recording available for session '${sessionId}'` });

    const objects = await pamWebAppObjectDAL.findBySessionId(session.id);
    const isActive = session.status === PamSessionStatus.Active || session.status === PamSessionStatus.Starting;

    const common = (o: TPamWebAppObjects) => ({
      objectIndex: o.objectIndex,
      checkpoint: o.checkpoint.toString("base64"),
      signature: o.signature.toString("base64"),
      objectKey: o.objectKey,
      versionId: o.versionId ?? null,
      binding: o.binding as PamWebAppBinding
    });

    const videoObjects = objects.filter((o) => o.series === PamWebAppSeries.V);
    const firstMedia = videoObjects.find((o) => o.kind === PamWebAppObjectKind.Media && o.startPtsUs !== null);
    const basePtsUs = toNumber(firstMedia?.startPtsUs);
    const relativeMs = (ptsUs: unknown) => {
      const pts = toNumber(ptsUs);
      return pts === null || basePtsUs === null ? null : Math.round((pts - basePtsUs) / 1000);
    };

    return {
      sessionId: session.id,
      projectId: session.projectId,
      status: isActive ? ("active" as const) : ("ended" as const),
      startedAt: (session.startedAt ?? session.createdAt).toISOString(),
      endedAt: session.endedAt ? session.endedAt.toISOString() : null,
      endReason: keys.endReason ?? null,
      recordingKey: {
        publicKey: keys.recordingPublicKey.toString("base64"),
        keyId: keys.recordingKeyId,
        fingerprint: keys.fingerprint
      },
      keyCert: keys.keyCert.toString("base64"),
      keyCertSig: keys.keyCertSig.toString("base64"),
      video: {
        mime: 'video/mp4; codecs="avc1.64001f"',
        objects: videoObjects.map((o) => ({
          ...common(o),
          kind: o.kind as PamWebAppObjectKind.Init | PamWebAppObjectKind.Media,
          ...(o.kind === PamWebAppObjectKind.Media
            ? {
                initIndex: o.initIndex ?? null,
                startMs: relativeMs(o.startPtsUs),
                endMs: relativeMs(o.endPtsUs),
                monoStartUs: toNumber(o.monoStartUs),
                monoEndUs: toNumber(o.monoEndUs),
                frameCount: o.frameCount ?? null,
                framesDropped: o.framesDropped ?? null
              }
            : {})
        }))
      },
      events: {
        chunks: objects
          .filter((o) => o.series === PamWebAppSeries.E)
          .map((o) => ({ ...common(o), firstSeq: Number(o.firstSeq), lastSeq: Number(o.lastSeq) }))
      },
      manifest: null
    };
  };

  const getObject = async (
    {
      sessionId,
      series,
      objectIndex,
      form
    }: { sessionId: string; series: PamWebAppSeries; objectIndex: number; form: "plaintext" | "stored" },
    actor: OrgServiceActor
  ) => {
    const session = await getViewableSession(sessionId, actor);
    const row = await pamWebAppObjectDAL.findObject(session.id, series, objectIndex);
    if (!row)
      throw new NotFoundError({ message: `Object ${series}/${objectIndex} not found in session '${sessionId}'` });

    const storage = await getObjectStorage(session);
    const ref = rowRef(row);
    const stored = await readStoredObject(session, storage, ref);
    if (form === "stored") return { contentType: "application/octet-stream", body: Buffer.from(stored) };

    const plaintext = await decryptStoredObject(session, await getSessionKey(session), ref, stored);
    return {
      contentType: series === PamWebAppSeries.V ? "video/mp4" : "application/octet-stream",
      body: Buffer.from(plaintext)
    };
  };

  const getEvents = async (
    {
      sessionId,
      fromSeq,
      toSeq,
      streams
    }: { sessionId: string; fromSeq: number; toSeq: number; streams: PamWebAppEventStream[] },
    actor: OrgServiceActor
  ) => {
    if (toSeq < fromSeq || toSeq - fromSeq > PAM_WEB_APP_MAX_EVENTS_SEQ_SPAN) {
      throw new BadRequestError({
        message: `toSeq must be between fromSeq and fromSeq + ${PAM_WEB_APP_MAX_EVENTS_SEQ_SPAN}`
      });
    }
    const session = await getViewableSession(sessionId, actor);

    const chunks = await pamWebAppObjectDAL.findEventChunksInRange(
      session.id,
      fromSeq,
      toSeq,
      PAM_WEB_APP_MAX_EVENT_CHUNKS_PER_READ + 1
    );
    if (chunks.length > PAM_WEB_APP_MAX_EVENT_CHUNKS_PER_READ) {
      throw new BadRequestError({
        message: `The seq range spans more than ${PAM_WEB_APP_MAX_EVENT_CHUNKS_PER_READ} event chunks; narrow it`
      });
    }
    if (chunks.length === 0) return { events: [] };

    const storage = await getObjectStorage(session);
    const sessionKey = await getSessionKey(session);
    const wanted = new Set(streams);
    const from = BigInt(fromSeq);
    const to = BigInt(toSeq);

    const events: { seq: number; type: string; wallTimeUnixMs: number; monoElapsedUs: number; body: unknown }[] = [];
    for (const chunkRow of chunks) {
      // Sequential on purpose: one decrypted chunk in memory at a time.
      // eslint-disable-next-line no-await-in-loop
      const plaintext = await readPlaintext(session, storage, sessionKey, rowRef(chunkRow));
      let envelopes: TEnvelope[];
      try {
        envelopes = parseEnvelopes(plaintext);
      } catch (err) {
        throw new PamWebAppError(
          PamWebAppErrorCode.BadSignature,
          `Event chunk ${chunkRow.objectIndex} is malformed: ${(err as Error).message}`
        );
      }
      envelopes.forEach((env) => {
        const meta = EVENT_TYPES[env.type];
        if (env.seq < from || env.seq > to || !meta || !meta.streams.some((st) => wanted.has(st))) return;
        let body: unknown = null;
        try {
          body = decodeEnvelopeBody(env);
        } catch {
          body = null;
        }
        events.push({
          seq: Number(env.seq),
          type: meta.name,
          wallTimeUnixMs: Number(env.wallTimeUnixMs),
          monoElapsedUs: Number(env.monoElapsedUs),
          body
        });
      });
    }
    return { events };
  };

  return { open, presign, submitCheckpoint, getReplay, getObject, getEvents };
};

export const describeCheckpointForAudit = (cp: TCheckpoint) => ({
  series: toSeriesLetter(cp.series),
  objectIndex: cp.objectIndex,
  firstSeq: Number(cp.firstSeq),
  lastSeq: Number(cp.lastSeq),
  chainHead: bytesToHex(cp.chainHead),
  signerKeyId: bytesToHex(cp.signerKeyId)
});
