import { TPamWebAppObjects, TPamWebAppSessionKeys } from "@app/db/schemas";
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
  bytesToHex,
  CheckpointKind,
  equalBytes,
  fingerprint as computeFingerprint,
  keyCommitment,
  keyIdHex,
  objectKey as buildObjectKey,
  openObject,
  parseCheckpoint,
  Series,
  sha256,
  TCheckpoint,
  uuidToBytes,
  verifyCheckpoint,
  verifyKeyCert
} from "./contract";
import { TPamWebAppObjectDALFactory, TPamWebAppSessionKeyDALFactory } from "./pam-web-app-dal";
import { PamWebAppError, PamWebAppErrorCode } from "./pam-web-app-errors";

export const PAM_WEB_APP_MAX_OBJECT_BYTES = 64 * 1024 * 1024;

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
  pamWebAppSessionKeyDAL: Pick<TPamWebAppSessionKeyDALFactory, "findBySessionId" | "findGatewayPin" | "create">;
  pamWebAppObjectDAL: Pick<TPamWebAppObjectDALFactory, "findBySessionId" | "findObject" | "insertIfAbsent">;
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
  ): Promise<TCheckpoint> => {
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
    return cp;
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

    const cp = await parseAndVerifyCheckpoint(session, keys, checkpointBytes, signature);
    const series = toSeriesLetter(cp.series);

    const { config } = await getObjectStorage(session);
    const expectedKey = buildObjectKey(
      config.keyPrefix ?? "",
      session.projectId,
      session.id,
      cp.series,
      cp.kind,
      cp.objectIndex
    );
    if (request.objectKey !== expectedKey) {
      throw new BadRequestError({ message: `objectKey does not match the checkpoint; expected '${expectedKey}'` });
    }

    const isSameSubmission = (row: TPamWebAppObjects) =>
      equalBytes(new Uint8Array(row.checkpoint), checkpointBytes) &&
      equalBytes(new Uint8Array(row.signature), signature) &&
      (row.versionId ?? null) === (request.versionId ?? null);

    const existing = await pamWebAppObjectDAL.findObject(session.id, series, cp.objectIndex);
    if (existing) {
      if (isSameSubmission(existing)) return { accepted: true as const, duplicate: true as const, checkpoint: cp };
      throw new PamWebAppError(
        PamWebAppErrorCode.Conflict,
        `Object ${series}/${cp.objectIndex} already has a different checkpoint`
      );
    }

    const inserted = await pamWebAppObjectDAL.insertIfAbsent({
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
      binding: cp.series === Series.E ? PamWebAppBinding.Bound : PamWebAppBinding.Pending
    });

    if (!inserted) {
      // Lost a race with a concurrent submission for the same slot.
      const winner = await pamWebAppObjectDAL.findObject(session.id, series, cp.objectIndex);
      if (winner && isSameSubmission(winner))
        return { accepted: true as const, duplicate: true as const, checkpoint: cp };
      throw new PamWebAppError(
        PamWebAppErrorCode.Conflict,
        `Object ${series}/${cp.objectIndex} already has a different checkpoint`
      );
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

    const { config, provider } = await getObjectStorage(session);
    const stored = await provider.getObject({
      config,
      objectKey: row.objectKey,
      versionId: row.versionId ?? undefined
    });
    const storedBytes = new Uint8Array(stored);

    if (!equalBytes(await sha256(storedBytes), new Uint8Array(row.ciphertextSha256))) {
      logger.warn(
        { sessionId, series, objectIndex },
        `Web App stored object does not match its checkpoint [sessionId=${sessionId}] [series=${series}] [objectIndex=${objectIndex}]`
      );
      throw new PamWebAppError(
        PamWebAppErrorCode.ChecksumMismatch,
        `Stored object ${series}/${objectIndex} does not match its signed checkpoint`
      );
    }

    if (form === "stored") return { contentType: "application/octet-stream", body: Buffer.from(storedBytes) };

    const sessionKey = await getSessionKey(session);
    const aad = await buildAad(session.projectId, session.id, toSeries(series), objectIndex);
    let plaintext: Uint8Array;
    try {
      plaintext = await openObject(sessionKey, storedBytes, aad);
    } catch {
      throw new PamWebAppError(
        PamWebAppErrorCode.ChecksumMismatch,
        `Object ${series}/${objectIndex} failed to decrypt`
      );
    }

    return {
      contentType: series === PamWebAppSeries.V ? "video/mp4" : "application/octet-stream",
      body: Buffer.from(plaintext)
    };
  };

  return { open, presign, submitCheckpoint, getReplay, getObject };
};

export const describeCheckpointForAudit = (cp: TCheckpoint) => ({
  series: toSeriesLetter(cp.series),
  objectIndex: cp.objectIndex,
  firstSeq: Number(cp.firstSeq),
  lastSeq: Number(cp.lastSeq),
  chainHead: bytesToHex(cp.chainHead),
  signerKeyId: bytesToHex(cp.signerKeyId)
});
