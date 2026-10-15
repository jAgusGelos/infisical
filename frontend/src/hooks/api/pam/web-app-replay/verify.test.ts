import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  bytesToBase64,
  CheckpointKind,
  hexToBytes,
  parseCheckpoint,
  Series,
  sha256,
  uuidToBytes
} from "@app/lib/pam-web-app/contract";

import { buildCheckpoint, ed25519SigningKeyFromSeed, signCheckpoint } from "./testkit";
import { TWebAppReplay, TWebAppVideoInitEntry } from "./types";
import {
  checkVideoBinding,
  isEd25519Supported,
  ReplayVerifyError,
  verifyEventChunk,
  verifySessionKeyCert,
  verifyVideoObject
} from "./verify";

const vector = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../../../lib/pam-web-app/contract/test-vectors/${name}`, import.meta.url)
      ),
      "utf8"
    )
  ) as T;

type TKeyVector = {
  recordingPublicKeyHex: string;
  recordingKeyId: string;
  recordingFingerprint: string;
  sessionSeedHex: string;
  sessionPublicKeyHex: string;
  sessionId: string;
  keyCertHex: string;
  keyCertSigHex: string;
};

type TCheckpointVector = {
  name: string;
  objectIndex: number;
  firstSeq: number;
  lastSeq: number;
  plaintextHex: string;
  checkpointHex: string;
  signatureHex: string;
};

const keys = vector<TKeyVector>("keys.json");
const [eVector, vVector] = vector<TCheckpointVector[]>("checkpoints.json");

const b64 = (hex: string) => bytesToBase64(hexToBytes(hex));

const baseReplay = (): TWebAppReplay => ({
  sessionId: keys.sessionId,
  projectId: "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  status: "ended",
  startedAt: "2025-10-15T16:00:00Z",
  recordingKey: {
    publicKey: b64(keys.recordingPublicKeyHex),
    keyId: keys.recordingKeyId,
    fingerprint: keys.recordingFingerprint
  },
  keyCert: b64(keys.keyCertHex),
  keyCertSig: b64(keys.keyCertSigHex),
  video: {
    mime: 'video/mp4; codecs="avc1.64001f"',
    objects: [
      {
        objectIndex: vVector.objectIndex,
        kind: "init",
        checkpoint: b64(vVector.checkpointHex),
        signature: b64(vVector.signatureHex)
      }
    ]
  },
  events: {
    chunks: [
      {
        objectIndex: eVector.objectIndex,
        firstSeq: eVector.firstSeq,
        lastSeq: eVector.lastSeq,
        checkpoint: b64(eVector.checkpointHex),
        signature: b64(eVector.signatureHex)
      }
    ]
  },
  manifest: null
});

const flipByte = (hex: string, index: number) => {
  const b = hexToBytes(hex);
  b[index] = b[index] === 0 ? 1 : 0;
  return b;
};

const expectVerifyError = async (promise: Promise<unknown>, step: string) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ReplayVerifyError);
  expect((err as ReplayVerifyError).step).toBe(step);
};

describe("web app replay verification", () => {
  test("Ed25519 is available in the test runtime", async () => {
    expect(await isEd25519Supported()).toBe(true);
  });

  test("verifies the F0 KeyCert vector and returns the session key", async () => {
    const key = await verifySessionKeyCert(baseReplay(), keys.sessionId);
    expect(Buffer.from(key.sessionPublicKey).toString("hex")).toBe(keys.sessionPublicKeyHex);
    expect(key.fingerprint).toBe(keys.recordingFingerprint);
  });

  test("rejects a tampered KeyCert, a wrong fingerprint and a different session", async () => {
    await expectVerifyError(
      verifySessionKeyCert({
        ...baseReplay(),
        keyCert: bytesToBase64(flipByte(keys.keyCertHex, 30))
      }),
      "key_cert"
    );
    await expectVerifyError(
      verifySessionKeyCert({
        ...baseReplay(),
        keyCertSig: bytesToBase64(flipByte(keys.keyCertSigHex, 3))
      }),
      "key_cert"
    );
    const replay = baseReplay();
    replay.recordingKey.fingerprint = "SHA256:AAAA";
    await expectVerifyError(verifySessionKeyCert(replay), "key_cert");
    await expectVerifyError(
      verifySessionKeyCert(baseReplay(), "00000000-0000-4000-8000-000000000000"),
      "key_cert"
    );
    await expectVerifyError(
      verifySessionKeyCert({ ...baseReplay(), sessionId: "00000000-0000-4000-8000-000000000000" }),
      "key_cert"
    );
  });

  test("verifies the F0 V init vector", async () => {
    const replay = baseReplay();
    const key = await verifySessionKeyCert(replay);
    const verified = await verifyVideoObject(
      replay.video.objects[0],
      hexToBytes(vVector.plaintextHex),
      key
    );
    expect(verified.kind).toBe("init");
    expect(verified.initIndex).toBe(0);
    expect(verified.checkpoint.lastSeq).toBe(2n);
  });

  test("refuses flipped plaintext, flipped signature and a mislabelled entry", async () => {
    const replay = baseReplay();
    const key = await verifySessionKeyCert(replay);
    const entry = replay.video.objects[0] as TWebAppVideoInitEntry;

    await expectVerifyError(
      verifyVideoObject(entry, flipByte(vVector.plaintextHex, 5), key),
      "plaintext"
    );
    await expectVerifyError(
      verifyVideoObject(entry, hexToBytes(`${vVector.plaintextHex}00`), key),
      "plaintext"
    );
    await expectVerifyError(
      verifyVideoObject(
        { ...entry, signature: bytesToBase64(flipByte(vVector.signatureHex, 10)) },
        hexToBytes(vVector.plaintextHex),
        key
      ),
      "checkpoint"
    );
    await expectVerifyError(
      verifyVideoObject({ ...entry, objectIndex: 1 }, hexToBytes(vVector.plaintextHex), key),
      "checkpoint"
    );
    await expectVerifyError(
      verifyVideoObject(
        { ...entry, kind: "media", initIndex: 0, startMs: 0, endMs: 1 },
        hexToBytes(vVector.plaintextHex),
        key
      ),
      "checkpoint"
    );
  });

  test("refuses a correctly signed checkpoint for another session", async () => {
    const replay = baseReplay();
    const key = await verifySessionKeyCert(replay);
    const signer = await ed25519SigningKeyFromSeed(hexToBytes(keys.sessionSeedHex));
    const plaintext = hexToBytes(vVector.plaintextHex);
    const cp = await buildCheckpoint({
      series: Series.V,
      kind: CheckpointKind.VideoInit,
      sessionIdBytes: uuidToBytes("00000000-0000-4000-8000-000000000000"),
      objectIndex: 0,
      firstSeq: 2n,
      lastSeq: 2n,
      chainHead: new Uint8Array(32),
      plaintextSha256: await sha256(plaintext),
      plaintextBytes: BigInt(plaintext.length),
      signerPublicKey: hexToBytes(keys.sessionPublicKeyHex),
      createdAtUnixMs: 0n
    });
    const entry: TWebAppVideoInitEntry = {
      objectIndex: 0,
      kind: "init",
      checkpoint: bytesToBase64(cp),
      signature: bytesToBase64(await signCheckpoint(signer, cp))
    };
    await expectVerifyError(verifyVideoObject(entry, plaintext, key), "checkpoint");
  });

  test("verifies the F0 E chunk vector and binds the V init to it", async () => {
    const replay = baseReplay();
    const key = await verifySessionKeyCert(replay);
    const chunk = await verifyEventChunk(
      replay.events.chunks[0],
      hexToBytes(eVector.plaintextHex),
      key,
      null
    );
    expect(chunk.lastSeq).toBe(3n);
    expect(chunk.envelopes).toHaveLength(4);

    const video = await verifyVideoObject(
      replay.video.objects[0],
      hexToBytes(vVector.plaintextHex),
      key
    );
    expect(checkVideoBinding(video, [chunk])).toBe("bound");
    expect(checkVideoBinding(video, [])).toBe("pending");
  });

  test("refuses an E chunk with a flipped byte or a broken seq link", async () => {
    const replay = baseReplay();
    const key = await verifySessionKeyCert(replay);
    await expectVerifyError(
      verifyEventChunk(replay.events.chunks[0], flipByte(eVector.plaintextHex, 200), key, null),
      "plaintext"
    );
    await expectVerifyError(
      verifyEventChunk(replay.events.chunks[0], hexToBytes(eVector.plaintextHex), key, {
        lastSeq: 5n,
        head: new Uint8Array(32)
      }),
      "seq"
    );
  });

  test("the V vector checkpoint names the E vector's v_init event", () => {
    const cp = parseCheckpoint(hexToBytes(vVector.checkpointHex));
    expect(cp.firstSeq).toBe(BigInt(vVector.firstSeq));
  });
});
