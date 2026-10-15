import crypto from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { TPamWebAppObjects, TPamWebAppSessionKeys } from "@app/db/schemas";
import { OrgServiceActor } from "@app/lib/types";
import { ActorType } from "@app/services/auth/auth-type";

import { PamAccountType, PamSessionStatus } from "../pam/pam-enums";
import { PamRecordingStorageBackend } from "../pam-session-recording/pam-recording-enums";
import { hexToBytes } from "./contract";
import checkpointVectors from "./contract/test-vectors/checkpoints.json";
import keyVectors from "./contract/test-vectors/keys.json";
import {
  pamWebAppCheckpointServiceFactory,
  PamWebAppObjectKind,
  PamWebAppSeries
} from "./pam-web-app-checkpoint-service";
import { PamWebAppError, PamWebAppErrorCode } from "./pam-web-app-errors";

vi.mock("@app/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}));

const flipByte = (buf: Buffer, index: number) => {
  // eslint-disable-next-line no-bitwise, no-param-reassign
  buf[index] ^= 1;
};

const [eVector, vVector] = checkpointVectors;
const GATEWAY_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const uploadToken = crypto.randomBytes(32);
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

const gatewayActor = { type: ActorType.GATEWAY, id: GATEWAY_ID } as OrgServiceActor;
const userActor = { type: ActorType.USER, id: "user" } as OrgServiceActor;

const storedByKey: Record<string, string> = {
  [eVector.objectKey]: eVector.storedObjectHex,
  [vVector.objectKey]: vVector.storedObjectHex
};

const openBody = () => ({
  recordingPublicKey: b64(keyVectors.recordingPublicKeyHex),
  fingerprint: keyVectors.recordingFingerprint,
  keyCert: b64(keyVectors.keyCertHex),
  keyCertSig: b64(keyVectors.keyCertSigHex)
});

const checkpointBody = (v: typeof eVector) => ({
  checkpoint: b64(v.checkpointHex),
  signature: b64(v.signatureHex),
  objectKey: v.objectKey,
  versionId: `version-${v.name}`
});

const expectCode = async (promise: Promise<unknown>, code: PamWebAppErrorCode) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(PamWebAppError);
  expect((err as PamWebAppError).code).toBe(code);
};

const setup = (overrides: { now?: number; stored?: Record<string, string> } = {}) => {
  const keys = new Map<string, TPamWebAppSessionKeys>();
  const objects: TPamWebAppObjects[] = [];
  const stored = overrides.stored ?? storedByKey;
  const presignCalls: unknown[] = [];
  const session = {
    id: keyVectors.sessionId,
    projectId: eVector.projectId,
    accountId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    accountType: PamAccountType.WebApp,
    status: PamSessionStatus.Active,
    createdAt: new Date("2025-10-15T16:00:00Z"),
    startedAt: new Date("2025-10-15T16:00:01Z"),
    gatewayId: GATEWAY_ID,
    gatewayUploadTokenHash: crypto.createHash("sha256").update(uploadToken).digest()
  };

  const service = pamWebAppCheckpointServiceFactory({
    pamSessionDAL: { findById: async (id) => (id === session.id ? session : undefined) },
    pamWebAppSessionKeyDAL: {
      findBySessionId: async (sessionId: string) => keys.get(sessionId),
      findGatewayPin: async (gatewayId: string) => [...keys.values()].find((k) => k.gatewayId === gatewayId),
      create: async (data: TPamWebAppSessionKeys) => {
        const row = { ...data, createdAt: new Date(), updatedAt: new Date() } as TPamWebAppSessionKeys;
        keys.set(data.sessionId, row);
        return row;
      }
    } as never,
    pamWebAppObjectDAL: {
      findBySessionId: async (sessionId: string) => objects.filter((o) => o.sessionId === sessionId),
      findObject: async (sessionId: string, series: string, objectIndex: number) =>
        objects.find((o) => o.sessionId === sessionId && o.series === series && o.objectIndex === objectIndex),
      insertIfAbsent: async (data: Omit<TPamWebAppObjects, "id" | "createdAt" | "updatedAt">) => {
        const row = {
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data
        } as TPamWebAppObjects;
        objects.push(row);
        return row;
      }
    } as never,
    resolveStorage: async () => ({
      config: { backend: PamRecordingStorageBackend.AwsS3, bucket: "recordings", keyPrefix: eVector.keyPrefix },
      provider: {
        mintPresignedCreateOnlyPut: async (input: { objectKey: string; ciphertextSha256B64: string }) => {
          presignCalls.push(input);
          return {
            url: `http://minio/${input.objectKey}`,
            objectKey: input.objectKey,
            method: "PUT" as const,
            headers: { "x-amz-checksum-sha256": input.ciphertextSha256B64, "If-None-Match": "*" as const },
            expiresInSeconds: 300
          };
        },
        getObject: async ({ objectKey }: { objectKey: string }) => Buffer.from(stored[objectKey], "hex")
      } as never
    }),
    getSessionKey: async () => hexToBytes(eVector.sessionKeyHex),
    assertSessionViewAccess: async () => {},
    now: () => overrides.now ?? keyVectors.notBeforeUnixMs + 1000
  });

  const gw = { sessionId: session.id, uploadToken: uploadToken.toString("base64") };
  return { service, gw, keys, objects, presignCalls, session };
};

describe("Web App open", () => {
  test("stores the verified key material", async () => {
    const { service, gw, keys } = setup();
    await expect(service.open({ ...gw, ...openBody() }, gatewayActor)).resolves.toEqual({ ok: true });

    const row = keys.get(keyVectors.sessionId);
    expect(row?.recordingKeyId).toBe(keyVectors.recordingKeyId);
    expect(row?.sessionKeyId).toBe(keyVectors.sessionKeyId);
    expect(row?.fingerprint).toBe(keyVectors.recordingFingerprint);
  });

  test("is idempotent for the same key material", async () => {
    const { service, gw } = setup();
    await service.open({ ...gw, ...openBody() }, gatewayActor);
    await expect(service.open({ ...gw, ...openBody() }, gatewayActor)).resolves.toEqual({ ok: true });
  });

  test("rejects a tampered key cert signature, an expired cert and a wrong upload token", async () => {
    const { service, gw } = setup();
    const badSig = Buffer.from(keyVectors.keyCertSigHex, "hex");
    flipByte(badSig, 0);
    await expectCode(
      service.open({ ...gw, ...openBody(), keyCertSig: badSig.toString("base64") }, gatewayActor),
      PamWebAppErrorCode.BadSignature
    );

    const late = setup({ now: keyVectors.notAfterUnixMs + 1 });
    await expectCode(late.service.open({ ...late.gw, ...openBody() }, gatewayActor), PamWebAppErrorCode.BadSignature);

    await expect(
      service.open({ ...gw, uploadToken: crypto.randomBytes(32).toString("base64"), ...openBody() }, gatewayActor)
    ).rejects.toThrow(/Invalid upload token/);
  });

  test("rejects a fingerprint that does not match the public key and non-gateway actors", async () => {
    const { service, gw } = setup();
    await expect(service.open({ ...gw, ...openBody(), fingerprint: "SHA256:AAAA" }, gatewayActor)).rejects.toThrow(
      /fingerprint/
    );
    await expect(service.open({ ...gw, ...openBody() }, userActor)).rejects.toThrow(/Only gateways/);
  });
});

describe("Web App presign", () => {
  test("returns the signed create-only headers and the contract object key", async () => {
    const { service, gw } = setup();
    const result = await service.presign(
      {
        ...gw,
        series: PamWebAppSeries.E,
        objectIndex: 0,
        kind: PamWebAppObjectKind.Events,
        ciphertextBytes: eVector.storedObjectHex.length / 2,
        ciphertextSha256: b64(eVector.ciphertextSha256Hex)
      },
      gatewayActor
    );

    expect(result.objectKey).toBe(eVector.objectKey);
    expect(result.headers).toEqual({ "x-amz-checksum-sha256": b64(eVector.ciphertextSha256Hex), "If-None-Match": "*" });
  });

  test("rejects oversize objects and a kind that does not fit the series", async () => {
    const { service, gw } = setup();
    const base = { ...gw, objectIndex: 0, ciphertextSha256: b64(eVector.ciphertextSha256Hex) };
    await expect(
      service.presign(
        { ...base, series: PamWebAppSeries.V, kind: PamWebAppObjectKind.Media, ciphertextBytes: 64 * 1024 * 1024 + 1 },
        gatewayActor
      )
    ).rejects.toThrow(/too large/);
    await expect(
      service.presign(
        { ...base, series: PamWebAppSeries.E, kind: PamWebAppObjectKind.Init, ciphertextBytes: 10 },
        gatewayActor
      )
    ).rejects.toThrow(/not valid for series/);
  });
});

describe("Web App checkpoints", () => {
  test("requires open first", async () => {
    const { service, gw } = setup();
    await expectCode(
      service.submitCheckpoint({ ...gw, ...checkpointBody(eVector) }, gatewayActor),
      PamWebAppErrorCode.UnknownKey
    );
  });

  test("accepts the vector checkpoints, E bound and V pending", async () => {
    const { service, gw, objects } = setup();
    await service.open({ ...gw, ...openBody() }, gatewayActor);

    await expect(service.submitCheckpoint({ ...gw, ...checkpointBody(eVector) }, gatewayActor)).resolves.toMatchObject({
      accepted: true,
      duplicate: false
    });
    await expect(service.submitCheckpoint({ ...gw, ...checkpointBody(vVector) }, gatewayActor)).resolves.toMatchObject({
      accepted: true,
      duplicate: false
    });

    expect(objects.map((o) => [o.series, o.objectIndex, o.kind, o.binding])).toEqual([
      ["E", 0, "events", "bound"],
      ["V", 0, "init", "pending"]
    ]);
    expect(objects[0].lastSeq).toBe(eVector.lastSeq);
  });

  test("identical resubmission is a duplicate, different bytes are a conflict", async () => {
    const { service, gw } = setup();
    await service.open({ ...gw, ...openBody() }, gatewayActor);
    await service.submitCheckpoint({ ...gw, ...checkpointBody(eVector) }, gatewayActor);

    await expect(service.submitCheckpoint({ ...gw, ...checkpointBody(eVector) }, gatewayActor)).resolves.toMatchObject({
      duplicate: true
    });
    await expectCode(
      service.submitCheckpoint({ ...gw, ...checkpointBody(eVector), versionId: "other-version" }, gatewayActor),
      PamWebAppErrorCode.Conflict
    );
  });

  test("rejects a bad signature, a tampered checkpoint and a wrong object key", async () => {
    const { service, gw } = setup();
    await service.open({ ...gw, ...openBody() }, gatewayActor);

    const sig = Buffer.from(eVector.signatureHex, "hex");
    flipByte(sig, 5);
    await expectCode(
      service.submitCheckpoint({ ...gw, ...checkpointBody(eVector), signature: sig.toString("base64") }, gatewayActor),
      PamWebAppErrorCode.BadSignature
    );

    const cp = Buffer.from(eVector.checkpointHex, "hex");
    flipByte(cp, 40); // lastSeq
    await expectCode(
      service.submitCheckpoint({ ...gw, ...checkpointBody(eVector), checkpoint: cp.toString("base64") }, gatewayActor),
      PamWebAppErrorCode.BadSignature
    );

    await expect(
      service.submitCheckpoint({ ...gw, ...checkpointBody(eVector), objectKey: vVector.objectKey }, gatewayActor)
    ).rejects.toThrow(/objectKey does not match/);
  });

  test("rejects a checkpoint for another session", async () => {
    const { service, gw, session } = setup();
    await service.open({ ...gw, ...openBody() }, gatewayActor);
    const cp = Buffer.from(eVector.checkpointHex, "hex");
    flipByte(cp, 8); // sessionId
    session.id = keyVectors.sessionId;
    await expectCode(
      service.submitCheckpoint({ ...gw, ...checkpointBody(eVector), checkpoint: cp.toString("base64") }, gatewayActor),
      PamWebAppErrorCode.BadSignature
    );
  });
});

describe("Web App playback", () => {
  const prepare = async (stored?: Record<string, string>) => {
    const ctx = setup({ stored });
    await ctx.service.open({ ...ctx.gw, ...openBody() }, gatewayActor);
    await ctx.service.submitCheckpoint({ ...ctx.gw, ...checkpointBody(eVector) }, gatewayActor);
    await ctx.service.submitCheckpoint({ ...ctx.gw, ...checkpointBody(vVector) }, gatewayActor);
    return ctx;
  };

  test("replay uses the 6.10 field names", async () => {
    const { service } = await prepare();
    const replay = await service.getReplay(keyVectors.sessionId, userActor);

    expect(Object.keys(replay).sort()).toEqual(
      [
        "endReason",
        "endedAt",
        "events",
        "keyCert",
        "keyCertSig",
        "manifest",
        "projectId",
        "recordingKey",
        "sessionId",
        "startedAt",
        "status",
        "video"
      ].sort()
    );
    expect(replay.status).toBe("active");
    expect(replay.recordingKey).toEqual({
      publicKey: b64(keyVectors.recordingPublicKeyHex),
      keyId: keyVectors.recordingKeyId,
      fingerprint: keyVectors.recordingFingerprint
    });
    expect(replay.events.chunks).toEqual([
      expect.objectContaining({
        objectIndex: 0,
        firstSeq: 0,
        lastSeq: 3,
        binding: "bound",
        objectKey: eVector.objectKey
      })
    ]);
    expect(replay.video.objects).toEqual([
      expect.objectContaining({
        objectIndex: 0,
        kind: "init",
        binding: "pending",
        checkpoint: b64(vVector.checkpointHex)
      })
    ]);
  });

  test("the plaintext route returns bytes whose SHA-256 is the checkpoint plaintextSha256", async () => {
    const { service } = await prepare();
    for (const [series, v] of [
      [PamWebAppSeries.E, eVector],
      [PamWebAppSeries.V, vVector]
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const result = await service.getObject(
        { sessionId: keyVectors.sessionId, series, objectIndex: v.objectIndex, form: "plaintext" },
        userActor
      );
      expect(crypto.createHash("sha256").update(result.body).digest("hex")).toBe(v.plaintextSha256Hex);
      expect(result.contentType).toBe(series === PamWebAppSeries.V ? "video/mp4" : "application/octet-stream");
    }
  });

  test("the stored form is the object exactly as stored", async () => {
    const { service } = await prepare();
    const result = await service.getObject(
      { sessionId: keyVectors.sessionId, series: PamWebAppSeries.E, objectIndex: 0, form: "stored" },
      userActor
    );
    expect(crypto.createHash("sha256").update(result.body).digest("hex")).toBe(eVector.ciphertextSha256Hex);
  });

  test("a stored object that no longer matches its checkpoint is refused", async () => {
    const tampered = `${eVector.storedObjectHex.slice(0, -2)}00`;
    const { service } = await prepare({ ...storedByKey, [eVector.objectKey]: tampered });
    await expectCode(
      service.getObject(
        { sessionId: keyVectors.sessionId, series: PamWebAppSeries.E, objectIndex: 0, form: "plaintext" },
        userActor
      ),
      PamWebAppErrorCode.ChecksumMismatch
    );
  });
});
