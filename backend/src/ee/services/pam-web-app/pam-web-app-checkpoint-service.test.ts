import crypto from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { TPamWebAppObjects, TPamWebAppSessionKeys } from "@app/db/schemas";
import { BadRequestError } from "@app/lib/errors";
import { OrgServiceActor } from "@app/lib/types";
import { ActorType } from "@app/services/auth/auth-type";

import { PamAccountType, PamSessionStatus } from "../pam/pam-enums";
import { PamRecordingStorageBackend } from "../pam-session-recording/pam-recording-enums";
import { buildAad, eventHash, EventType, hexToBytes, Series } from "./contract";
import chainVector from "./contract/test-vectors/chain.json";
import checkpointVectors from "./contract/test-vectors/checkpoints.json";
import keyVectors from "./contract/test-vectors/keys.json";
import {
  pamWebAppCheckpointServiceFactory,
  PamWebAppEventStream,
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
const sha256Buf = (b: Buffer) => crypto.createHash("sha256").update(b).digest();

const gatewayActor = { type: ActorType.GATEWAY, id: GATEWAY_ID } as OrgServiceActor;
const userActor = { type: ActorType.USER, id: "user" } as OrgServiceActor;

type TStoredEntry = { bytes: Buffer; versionId: string };

const vectorStore = (): Map<string, TStoredEntry> =>
  new Map([
    [eVector.objectKey, { bytes: Buffer.from(eVector.storedObjectHex, "hex"), versionId: `version-${eVector.name}` }],
    [vVector.objectKey, { bytes: Buffer.from(vVector.storedObjectHex, "hex"), versionId: `version-${vVector.name}` }]
  ]);

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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const matches = (row: Record<string, unknown>, filter: Record<string, unknown>) =>
  Object.entries(filter).every(([k, v]) => row[k] === v);

type TTx = { id: number; releases: (() => void)[] };

const setup = (overrides: { now?: number; store?: Map<string, TStoredEntry> } = {}) => {
  const keys = new Map<string, TPamWebAppSessionKeys>();
  const objects: TPamWebAppObjects[] = [];
  const store = overrides.store ?? vectorStore();
  const presignCalls: unknown[] = [];
  const stats = { openTx: 0, maxOpenTx: 0, callsWithoutTxInsideTx: 0 };
  const hooks: { beforeInsert?: (objectIndex: number, series: string) => Promise<void> } = {};
  const rowLocks = new Map<string, Promise<void>>();
  let txCounter = 0;

  // Flags a DAL call made without the transaction while one is open (the CODE_QUALITY deadlock rule).
  const noteTx = (tx?: unknown) => {
    if (stats.openTx > 0 && !tx) stats.callsWithoutTxInsideTx += 1;
  };

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
      findBySessionId: async (sessionId: string, tx?: TTx) => {
        noteTx(tx);
        return keys.get(sessionId);
      },
      // A real per-row lock: a second caller waits until the holder's transaction ends.
      findBySessionIdForUpdate: async (sessionId: string, tx: TTx) => {
        const prev = rowLocks.get(sessionId) ?? Promise.resolve();
        const mine = deferred();
        rowLocks.set(
          sessionId,
          prev.then(() => mine.promise)
        );
        await prev;
        tx.releases.push(mine.resolve);
        return keys.get(sessionId);
      },
      findGatewayPin: async (gatewayId: string) => [...keys.values()].find((k) => k.gatewayId === gatewayId),
      create: async (data: TPamWebAppSessionKeys) => {
        const row = { ...data, createdAt: new Date(), updatedAt: new Date() } as TPamWebAppSessionKeys;
        keys.set(data.sessionId, row);
        return row;
      },
      update: async (filter: { sessionId: string }, data: Partial<TPamWebAppSessionKeys>, tx?: TTx) => {
        noteTx(tx);
        const row = keys.get(filter.sessionId);
        if (row) keys.set(filter.sessionId, { ...row, ...data });
        return row ? [keys.get(filter.sessionId)] : [];
      },
      transaction: async <T>(cb: (tx: TTx) => Promise<T>) => {
        txCounter += 1;
        const tx: TTx = { id: txCounter, releases: [] };
        stats.openTx += 1;
        stats.maxOpenTx = Math.max(stats.maxOpenTx, stats.openTx);
        try {
          return await cb(tx);
        } finally {
          stats.openTx -= 1;
          tx.releases.forEach((release) => release());
        }
      }
    } as never,
    pamWebAppObjectDAL: {
      findBySessionId: async (sessionId: string) => objects.filter((o) => o.sessionId === sessionId),
      findObject: async (sessionId: string, series: string, objectIndex: number, tx?: TTx) => {
        noteTx(tx);
        return objects.find((o) => o.sessionId === sessionId && o.series === series && o.objectIndex === objectIndex);
      },
      insertIfAbsent: async (data: Omit<TPamWebAppObjects, "id" | "createdAt" | "updatedAt">, tx?: TTx) => {
        noteTx(tx);
        await hooks.beforeInsert?.(data.objectIndex, data.series);
        if (
          objects.some((o) =>
            matches(o, { sessionId: data.sessionId, series: data.series, objectIndex: data.objectIndex })
          )
        )
          return null;
        const row = {
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data
        } as TPamWebAppObjects;
        objects.push(row);
        return row;
      },
      update: async (filter: Record<string, unknown>, data: Partial<TPamWebAppObjects>, tx?: TTx) => {
        noteTx(tx);
        const hits = objects.filter((o) => matches(o, filter));
        hits.forEach((o) => Object.assign(o, data));
        return hits;
      },
      updateById: async (id: string, data: Partial<TPamWebAppObjects>, tx?: TTx) => {
        noteTx(tx);
        const row = objects.find((o) => o.id === id);
        if (row) Object.assign(row, data);
        return row;
      },
      findPendingVideoInRange: async (sessionId: string, firstSeq: number, lastSeq: number, tx?: TTx) => {
        noteTx(tx);
        return objects.filter(
          (o) =>
            matches(o, { sessionId, series: "V", binding: "pending" }) &&
            Number(o.lastSeq) >= firstSeq &&
            Number(o.lastSeq) <= lastSeq
        );
      },
      findEventChunkCovering: async (sessionId: string, seq: number, tx?: TTx) => {
        noteTx(tx);
        return objects.find(
          (o) => matches(o, { sessionId, series: "E" }) && Number(o.firstSeq) <= seq && Number(o.lastSeq) >= seq
        );
      },
      findEventChunksInRange: async (sessionId: string, fromSeq: number, toSeq: number, limit: number) =>
        objects
          .filter(
            (o) => matches(o, { sessionId, series: "E" }) && Number(o.firstSeq) <= toSeq && Number(o.lastSeq) >= fromSeq
          )
          .sort((a, b) => a.objectIndex - b.objectIndex)
          .slice(0, limit)
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
        headObject: async ({ objectKey }: { objectKey: string }) => {
          const entry = store.get(objectKey);
          if (!entry) return null;
          return {
            versionId: entry.versionId,
            checksumSha256: sha256Buf(entry.bytes).toString("base64"),
            contentLength: entry.bytes.length
          };
        },
        getObject: async ({ objectKey }: { objectKey: string }) => {
          const entry = store.get(objectKey);
          if (!entry) throw new BadRequestError({ message: "missing object" });
          return Buffer.from(entry.bytes);
        }
      } as never
    }),
    getSessionKey: async () => hexToBytes(eVector.sessionKeyHex),
    assertSessionViewAccess: async () => {},
    now: () => overrides.now ?? keyVectors.notBeforeUnixMs + 1000
  });

  const gw = { sessionId: session.id, uploadToken: uploadToken.toString("base64") };
  return { service, gw, keys, objects, presignCalls, session, store, stats, hooks };
};

type TCtx = ReturnType<typeof setup>;

// Builders for scenarios the F0 vectors cannot express. Same byte formats as CONTRACTS 6.1, 6.4 and 6.7, signed with
// the F0 session seed; the first test proves the envelope builder reproduces chain.json.
const SESSION_KEY = Buffer.from(eVector.sessionKeyHex, "hex");
const SESSION_SIGNER = crypto.createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(keyVectors.sessionSeedHex, "hex")
  ]),
  format: "der",
  type: "pkcs8"
});
const BASE_WALL_MS = 1760544000000;

type TEvent = { type: number; body: string | Record<string, unknown> };
type TChain = { envelopes: Buffer[]; hashes: Buffer[] };

const buildEnvelope = (type: number, seq: number, prevHash: Buffer, body: Buffer, wallMs: number, monoUs: number) => {
  const h = Buffer.alloc(68);
  h.write("IWE1", 0, "latin1");
  h[4] = 1;
  h[5] = 1;
  h.writeUInt16BE(type, 6);
  h.writeBigUInt64BE(BigInt(seq), 8);
  h.writeBigInt64BE(BigInt(wallMs), 16);
  h.writeBigUInt64BE(BigInt(monoUs), 24);
  prevHash.copy(h, 32);
  h.writeUInt32BE(body.length, 64);
  return Buffer.concat([h, body]);
};

const buildChain = async (events: TEvent[], startSeq = 0, startPrev = Buffer.alloc(32)): Promise<TChain> => {
  const envelopes: Buffer[] = [];
  const hashes: Buffer[] = [];
  let prev = startPrev;
  for (let i = 0; i < events.length; i += 1) {
    const seq = startSeq + i;
    const { type, body } = events[i];
    const bodyBytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const env = buildEnvelope(type, seq, prev, bodyBytes, BASE_WALL_MS + seq * 1000, seq * 1_000_000);
    envelopes.push(env);
    // eslint-disable-next-line no-await-in-loop
    prev = Buffer.from(await eventHash(new Uint8Array(env)));
    hashes.push(prev);
  }
  return { envelopes, hashes };
};

const objectKeyFor = (series: PamWebAppSeries, kind: PamWebAppObjectKind, objectIndex: number) => {
  const ext = { events: "evt", init: "init.mp4", media: "m4s" }[kind];
  return `${eVector.keyPrefix}/web-app/${eVector.projectId}/${keyVectors.sessionId}/${series}/${String(objectIndex).padStart(8, "0")}.${ext}`;
};

const KIND_CODE = { events: 0, init: 1, media: 2 } as const;

type TObjectSpec = {
  series: PamWebAppSeries;
  kind: PamWebAppObjectKind;
  objectIndex: number;
  firstSeq: number;
  lastSeq: number;
  chainHead: Buffer;
  plaintext: Buffer;
  // Signed into the checkpoint instead of the real plaintext hash (to build a mismatch).
  claimedPlaintextSha256?: Buffer;
};

const sealAndSign = async (ctx: TCtx, spec: TObjectSpec) => {
  const aad = Buffer.from(
    await buildAad(
      eVector.projectId,
      keyVectors.sessionId,
      spec.series === PamWebAppSeries.V ? Series.V : Series.E,
      spec.objectIndex
    )
  );
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SESSION_KEY, iv);
  cipher.setAAD(aad);
  const stored = Buffer.concat([iv, cipher.update(spec.plaintext), cipher.final(), cipher.getAuthTag()]);

  const cp = Buffer.alloc(208);
  cp.write("IWC1", 0, "latin1");
  cp[4] = 1;
  cp[5] = 1;
  cp[6] = spec.series === PamWebAppSeries.V ? 2 : 1;
  cp[7] = KIND_CODE[spec.kind];
  Buffer.from(keyVectors.sessionId.replace(/-/g, ""), "hex").copy(cp, 8);
  cp.writeUInt32BE(spec.objectIndex, 24);
  cp.writeBigUInt64BE(BigInt(spec.firstSeq), 28);
  cp.writeBigUInt64BE(BigInt(spec.lastSeq), 36);
  spec.chainHead.copy(cp, 44);
  (spec.claimedPlaintextSha256 ?? sha256Buf(spec.plaintext)).copy(cp, 76);
  sha256Buf(stored).copy(cp, 108);
  cp.writeBigUInt64BE(BigInt(spec.plaintext.length), 140);
  cp.writeBigUInt64BE(BigInt(stored.length), 148);
  Buffer.from(eVector.keyCommitmentHex, "hex").copy(cp, 156);
  cp.writeUInt32BE(1, 188);
  Buffer.from(keyVectors.sessionKeyId, "hex").copy(cp, 192);
  cp.writeBigInt64BE(BigInt(BASE_WALL_MS + 10_000), 200);
  const signature = crypto.sign(
    null,
    Buffer.concat([Buffer.from("infisical-webapp/checkpoint/v1", "utf8"), Buffer.from([0]), cp]),
    SESSION_SIGNER
  );

  const objectKey = objectKeyFor(spec.series, spec.kind, spec.objectIndex);
  const versionId = `v-${spec.series}-${spec.objectIndex}-${crypto.randomUUID()}`;
  ctx.store.set(objectKey, { bytes: stored, versionId });
  return { checkpoint: cp.toString("base64"), signature: signature.toString("base64"), objectKey, versionId };
};

const eChunk = (ctx: TCtx, chain: TChain, objectIndex: number, firstSeq: number, lastSeq: number) =>
  sealAndSign(ctx, {
    series: PamWebAppSeries.E,
    kind: PamWebAppObjectKind.Events,
    objectIndex,
    firstSeq,
    lastSeq,
    chainHead: chain.hashes[lastSeq - Number(chain.envelopes[0].readBigUInt64BE(8))],
    plaintext: Buffer.concat(
      chain.envelopes.filter((env) => {
        const seq = Number(env.readBigUInt64BE(8));
        return seq >= firstSeq && seq <= lastSeq;
      })
    )
  });

const INIT_PLAIN = Buffer.from("ftyp....moov.... init", "latin1");
const SEG_PLAIN = Buffer.from("moof....mdat.... segment one", "latin1");

const segmentBody = {
  objectIndex: 1,
  initIndex: 0,
  segmentIndex: 1,
  sha256: sha256Buf(SEG_PLAIN).toString("hex"),
  bytes: SEG_PLAIN.length,
  startPtsUs: 60_000_000,
  endPtsUs: 70_000_000,
  monoStartUs: 61_250_000,
  monoEndUs: 71_250_000,
  firstFrame: 1800,
  frameCount: 300,
  framesDropped: 2
};

// seq 0 session_open, 1 v_init (V0), 2 l3_input, 3 v_segment (V1), 4 l1_request, 5 heartbeat
const mediaEvents = (): TEvent[] => [
  { type: EventType.SessionOpen, body: { sessionId: keyVectors.sessionId, resourceType: "web-app" } },
  {
    type: EventType.VInit,
    body: {
      objectIndex: 0,
      sha256: sha256Buf(INIT_PLAIN).toString("hex"),
      bytes: INIT_PLAIN.length,
      codec: "avc1.64001f"
    }
  },
  { type: EventType.L3Input, body: { events: [{ t: "key", code: "KeyA" }], dropped: [], masked: false, frameSeq: 1 } },
  { type: EventType.VSegment, body: segmentBody },
  { type: EventType.L1Request, body: { reqId: "r-1", method: "GET", url: "https://app.corp.internal/" } },
  { type: EventType.Heartbeat, body: { lastSeq: 4, uptimeMs: 30000, viewerConnected: true } }
];

const videoObject = (
  ctx: TCtx,
  chain: TChain,
  kind: PamWebAppObjectKind,
  objectIndex: number,
  seq: number,
  plaintext: Buffer,
  claimed?: Buffer
) =>
  sealAndSign(ctx, {
    series: PamWebAppSeries.V,
    kind,
    objectIndex,
    firstSeq: seq,
    lastSeq: seq,
    chainHead: chain.hashes[seq],
    plaintext,
    claimedPlaintextSha256: claimed
  });

const opened = async () => {
  const ctx = setup();
  await ctx.service.open({ ...ctx.gw, ...openBody() }, gatewayActor);
  const submit = (body: Awaited<ReturnType<typeof sealAndSign>> | ReturnType<typeof checkpointBody>) =>
    ctx.service.submitCheckpoint({ ...ctx.gw, ...body }, gatewayActor);
  return { ...ctx, submit };
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

  test("accepts the vector E chunk, advances the session chain state and passes tx on every DAL call", async () => {
    const { submit, objects, keys, stats } = await opened();

    await expect(submit(checkpointBody(eVector))).resolves.toMatchObject({ accepted: true, duplicate: false });

    expect(objects.map((o) => [o.series, o.objectIndex, o.kind, o.binding])).toEqual([["E", 0, "events", "bound"]]);
    const row = keys.get(keyVectors.sessionId);
    expect(row?.lastESeq).toBe(eVector.lastSeq);
    expect(row?.lastEObjectIndex).toBe(0);
    expect(row?.eChainHead?.toString("hex")).toBe(chainVector.chainHeadHex);
    expect(stats.callsWithoutTxInsideTx).toBe(0);
  });

  test("V before E: the vector init is pending, then bound when its E chunk is accepted", async () => {
    const { submit, objects } = await opened();

    await submit(checkpointBody(vVector));
    expect(objects.find((o) => o.series === "V")?.binding).toBe("pending");

    await submit(checkpointBody(eVector));
    expect(objects.find((o) => o.series === "V")?.binding).toBe("bound");
  });

  test("E before V: the vector init is bound on accept", async () => {
    const { submit, objects } = await opened();
    await submit(checkpointBody(eVector));
    await expect(submit(checkpointBody(vVector))).resolves.toMatchObject({ accepted: true, duplicate: false });
    expect(objects.find((o) => o.series === "V")?.binding).toBe("bound");
  });

  test("identical resubmission is a duplicate, different bytes are a conflict", async () => {
    const { submit } = await opened();
    await submit(checkpointBody(eVector));

    await expect(submit(checkpointBody(eVector))).resolves.toMatchObject({ duplicate: true });
    await expectCode(submit({ ...checkpointBody(eVector), versionId: "other-version" }), PamWebAppErrorCode.Conflict);
  });

  test("rejects a bad signature, a tampered checkpoint and a wrong object key", async () => {
    const { submit } = await opened();

    const sig = Buffer.from(eVector.signatureHex, "hex");
    flipByte(sig, 5);
    await expectCode(
      submit({ ...checkpointBody(eVector), signature: sig.toString("base64") }),
      PamWebAppErrorCode.BadSignature
    );

    const cp = Buffer.from(eVector.checkpointHex, "hex");
    flipByte(cp, 40); // lastSeq
    await expectCode(
      submit({ ...checkpointBody(eVector), checkpoint: cp.toString("base64") }),
      PamWebAppErrorCode.BadSignature
    );

    await expect(submit({ ...checkpointBody(eVector), objectKey: vVector.objectKey })).rejects.toThrow(
      /objectKey does not match/
    );
  });

  test("rejects a checkpoint for another session", async () => {
    const { submit } = await opened();
    const cp = Buffer.from(eVector.checkpointHex, "hex");
    flipByte(cp, 8); // sessionId
    await expectCode(
      submit({ ...checkpointBody(eVector), checkpoint: cp.toString("base64") }),
      PamWebAppErrorCode.BadSignature
    );
  });
});

describe("Web App E continuity", () => {
  test("the test envelope builder reproduces the F0 chain vector", async () => {
    const chain = await buildChain(chainVector.events.map((e) => ({ type: e.type, body: e.body })));
    expect(Buffer.concat(chain.envelopes).toString("hex")).toBe(chainVector.chunkPlaintextHex);
    expect(chain.hashes[chain.hashes.length - 1].toString("hex")).toBe(chainVector.chainHeadHex);
  });

  test("accepts chunks in order and answers seq_gap for a gap or a skipped index", async () => {
    const ctx = await opened();
    const chain = await buildChain(mediaEvents());
    const e0 = await eChunk(ctx, chain, 0, 0, 2);
    const e1 = await eChunk(ctx, chain, 1, 3, 5);

    await expectCode(ctx.submit(e1), PamWebAppErrorCode.SeqGap);
    await expect(ctx.submit(e0)).resolves.toMatchObject({ accepted: true, duplicate: false });
    await expect(ctx.submit(e1)).resolves.toMatchObject({ accepted: true, duplicate: false });

    const row = ctx.keys.get(keyVectors.sessionId);
    expect(row?.lastESeq).toBe(5);
    expect(row?.lastEObjectIndex).toBe(1);
    expect(row?.eChainHead?.toString("hex")).toBe(chain.hashes[5].toString("hex"));

    // Duplicate detection runs before continuity.
    await expect(ctx.submit(e0)).resolves.toMatchObject({ duplicate: true });

    const tail = await buildChain(
      [{ type: EventType.Heartbeat, body: { lastSeq: 5, uptimeMs: 60000, viewerConnected: true } }],
      6,
      chain.hashes[5]
    );
    const skipped = await sealAndSign(ctx, {
      series: PamWebAppSeries.E,
      kind: PamWebAppObjectKind.Events,
      objectIndex: 3,
      firstSeq: 6,
      lastSeq: 6,
      chainHead: tail.hashes[0],
      plaintext: tail.envelopes[0]
    });
    await expectCode(ctx.submit(skipped), PamWebAppErrorCode.SeqGap);
    expect(ctx.objects.filter((o) => o.series === "E")).toHaveLength(2);
  });

  test("two interleaved submits are serialized by the session row lock", async () => {
    const ctx = await opened();
    const chain = await buildChain(mediaEvents());
    const e0 = await eChunk(ctx, chain, 0, 0, 2);
    const e1 = await eChunk(ctx, chain, 1, 3, 5);

    const e0Inside = deferred();
    const e0Release = deferred();
    ctx.hooks.beforeInsert = async (objectIndex, series) => {
      if (series === "E" && objectIndex === 0) {
        e0Inside.resolve();
        await e0Release.promise;
      }
    };

    const first = ctx.submit(e0);
    await e0Inside.promise;
    let secondSettled = false;
    const second = ctx.submit(e1).finally(() => {
      secondSettled = true;
    });
    // E1 has done its network checks and opened its transaction, where it waits for the lock E0 holds. Waiting on the
    // transaction count rather than a fixed delay keeps this independent of how long the network checks take.
    await vi.waitFor(() => expect(ctx.stats.openTx).toBe(2), { timeout: 5_000 });
    expect(secondSettled).toBe(false);

    e0Release.resolve();
    await expect(first).resolves.toMatchObject({ accepted: true, duplicate: false });
    await expect(second).resolves.toMatchObject({ accepted: true, duplicate: false });
    expect(ctx.stats.maxOpenTx).toBe(2);
    expect(ctx.keys.get(keyVectors.sessionId)?.lastESeq).toBe(5);
  });

  test("concurrent identical submits store one row and answer one duplicate", async () => {
    const ctx = await opened();
    const results = await Promise.all([ctx.submit(checkpointBody(eVector)), ctx.submit(checkpointBody(eVector))]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(ctx.objects).toHaveLength(1);
  });

  test("a chunk whose chain does not match its checkpoint or does not link is bad_signature", async () => {
    const ctx = await opened();
    const chain = await buildChain(mediaEvents());

    const wrongHead = await sealAndSign(ctx, {
      series: PamWebAppSeries.E,
      kind: PamWebAppObjectKind.Events,
      objectIndex: 0,
      firstSeq: 0,
      lastSeq: 2,
      chainHead: chain.hashes[1],
      plaintext: Buffer.concat(chain.envelopes.slice(0, 3))
    });
    await expectCode(ctx.submit(wrongHead), PamWebAppErrorCode.BadSignature);

    await ctx.submit(await eChunk(ctx, chain, 0, 0, 2));
    const forked = await buildChain(mediaEvents().slice(3), 3, crypto.randomBytes(32));
    const unlinked = await sealAndSign(ctx, {
      series: PamWebAppSeries.E,
      kind: PamWebAppObjectKind.Events,
      objectIndex: 1,
      firstSeq: 3,
      lastSeq: 5,
      chainHead: forked.hashes[2],
      plaintext: Buffer.concat(forked.envelopes)
    });
    await expectCode(ctx.submit(unlinked), PamWebAppErrorCode.BadSignature);
    expect(ctx.keys.get(keyVectors.sessionId)?.lastESeq).toBe(2);
  });
});

describe("Web App S3 HEAD check", () => {
  test("a different version id is version_mismatch", async () => {
    const { submit } = await opened();
    await expectCode(
      submit({ ...checkpointBody(eVector), versionId: "not-the-stored-version" }),
      PamWebAppErrorCode.VersionMismatch
    );
  });

  test("different stored bytes or a missing object is checksum_mismatch", async () => {
    const ctx = await opened();
    const entry = ctx.store.get(vVector.objectKey)!;
    ctx.store.set(vVector.objectKey, {
      ...entry,
      bytes: Buffer.concat([entry.bytes.subarray(0, -1), Buffer.from([0])])
    });
    await expectCode(ctx.submit(checkpointBody(vVector)), PamWebAppErrorCode.ChecksumMismatch);

    ctx.store.delete(eVector.objectKey);
    await expect(ctx.submit(checkpointBody(eVector))).rejects.toThrow(/not in the storage bucket/);
    expect(ctx.objects).toHaveLength(0);
  });
});

describe("Web App V binding", () => {
  test("copies the v_segment media metadata on bind, in both arrival orders", async () => {
    const ctx = await opened();
    const chain = await buildChain(mediaEvents());
    const v1 = await videoObject(ctx, chain, PamWebAppObjectKind.Media, 1, 3, SEG_PLAIN);
    const v0 = await videoObject(ctx, chain, PamWebAppObjectKind.Init, 0, 1, INIT_PLAIN);

    await ctx.submit(v1);
    expect(ctx.objects.find((o) => o.series === "V" && o.objectIndex === 1)?.binding).toBe("pending");

    await ctx.submit(await eChunk(ctx, chain, 0, 0, 5));
    await ctx.submit(v0);

    const media = ctx.objects.find((o) => o.series === "V" && o.objectIndex === 1);
    expect(media).toMatchObject({
      binding: "bound",
      initIndex: 0,
      startPtsUs: 60_000_000,
      endPtsUs: 70_000_000,
      monoStartUs: 61_250_000,
      monoEndUs: 71_250_000,
      frameCount: 300,
      framesDropped: 2
    });
    expect(ctx.objects.find((o) => o.series === "V" && o.objectIndex === 0)?.binding).toBe("bound");

    const replay = await ctx.service.getReplay(keyVectors.sessionId, userActor);
    expect(replay.video.objects.find((o) => o.objectIndex === 1)).toMatchObject({
      startMs: 0,
      endMs: 10000,
      frameCount: 300,
      binding: "bound"
    });
  });

  test("a V object whose hash or event hash differs from the chain event is mismatch", async () => {
    const ctx = await opened();
    const chain = await buildChain(mediaEvents());
    // Signed claim of other plaintext than the v_segment event names.
    const wrongHash = await videoObject(ctx, chain, PamWebAppObjectKind.Media, 1, 3, Buffer.from("other bytes"));
    // Points at the l3_input event instead of its v_init.
    const wrongEvent = await videoObject(ctx, chain, PamWebAppObjectKind.Init, 0, 2, INIT_PLAIN);

    await ctx.submit(wrongHash);
    await ctx.submit(await eChunk(ctx, chain, 0, 0, 5));
    await ctx.submit(wrongEvent);

    expect(ctx.objects.filter((o) => o.series === "V").map((o) => [o.objectIndex, o.binding])).toEqual([
      [1, "mismatch"],
      [0, "mismatch"]
    ]);
    expect(ctx.objects.find((o) => o.objectIndex === 1 && o.series === "V")?.frameCount).toBeUndefined();
  });

  test("a V object whose stored plaintext differs from its signed hash binds, but the plaintext route refuses it", async () => {
    const ctx = await opened();
    const chain = await buildChain(mediaEvents());
    const lying = await videoObject(
      ctx,
      chain,
      PamWebAppObjectKind.Media,
      1,
      3,
      Buffer.from("real"),
      sha256Buf(SEG_PLAIN)
    );
    await ctx.submit(lying);
    await ctx.submit(await eChunk(ctx, chain, 0, 0, 5));
    // The binding matches the signed claim; the viewer's plaintextSha256 check catches the stored bytes.
    expect(ctx.objects.find((o) => o.series === "V")?.binding).toBe("bound");
    await expectCode(
      ctx.service.getObject(
        { sessionId: keyVectors.sessionId, series: PamWebAppSeries.V, objectIndex: 1, form: "plaintext" },
        userActor
      ),
      PamWebAppErrorCode.BadSignature
    );
  });
});

describe("Web App playback", () => {
  const prepare = async () => {
    const ctx = await opened();
    await ctx.submit(checkpointBody(eVector));
    await ctx.submit(checkpointBody(vVector));
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
        binding: "bound",
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
    const ctx = await prepare();
    const entry = ctx.store.get(eVector.objectKey)!;
    ctx.store.set(eVector.objectKey, {
      ...entry,
      bytes: Buffer.concat([entry.bytes.subarray(0, -1), Buffer.from([0])])
    });
    await expectCode(
      ctx.service.getObject(
        { sessionId: keyVectors.sessionId, series: PamWebAppSeries.E, objectIndex: 0, form: "plaintext" },
        userActor
      ),
      PamWebAppErrorCode.ChecksumMismatch
    );
  });
});

describe("Web App events", () => {
  const prepare = async () => {
    const ctx = await opened();
    const chain = await buildChain(mediaEvents());
    await ctx.submit(await eChunk(ctx, chain, 0, 0, 2));
    await ctx.submit(await eChunk(ctx, chain, 1, 3, 5));
    const list = (fromSeq: number, toSeq: number, streams: PamWebAppEventStream[]) =>
      ctx.service.getEvents({ sessionId: keyVectors.sessionId, fromSeq, toSeq, streams }, userActor);
    return { ...ctx, list };
  };

  test("filters by stream across chunks with snake_case type names and decoded bodies", async () => {
    const { list } = await prepare();

    const l3 = await list(0, 100, [PamWebAppEventStream.L3]);
    expect(l3.events).toEqual([
      {
        seq: 2,
        type: "l3_input",
        wallTimeUnixMs: BASE_WALL_MS + 2000,
        monoElapsedUs: 2_000_000,
        body: { events: [{ t: "key", code: "KeyA" }], dropped: [], masked: false, frameSeq: 1 }
      }
    ]);

    const lifecycle = await list(0, 100, [PamWebAppEventStream.Lifecycle]);
    expect(lifecycle.events.map((e) => [e.seq, e.type])).toEqual([
      [0, "session_open"],
      [1, "v_init"],
      [3, "v_segment"],
      [5, "heartbeat"]
    ]);

    const l1AndL3 = await list(0, 100, [PamWebAppEventStream.L1, PamWebAppEventStream.L3]);
    expect(l1AndL3.events.map((e) => e.type)).toEqual(["l3_input", "l1_request"]);
  });

  test("honors the seq bounds inside a chunk and rejects an oversized or inverted range", async () => {
    const { list } = await prepare();
    const all = Object.values(PamWebAppEventStream);

    expect((await list(2, 3, all)).events.map((e) => e.seq)).toEqual([2, 3]);
    expect((await list(6, 9, all)).events).toEqual([]);
    await expect(list(0, 10_001, all)).rejects.toThrow(/toSeq must be between/);
    await expect(list(5, 4, all)).rejects.toThrow(/toSeq must be between/);
  });
});
