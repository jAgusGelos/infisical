import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  base64ToBytes,
  buildAad,
  bytesToHex,
  CheckpointKind,
  createFrameReader,
  createInputFilter,
  decodeAck,
  decodeFrame,
  decodeMetaPrefixed,
  encodeFrame,
  equalBytes,
  fingerprint,
  FrameError,
  FrameType,
  hexToBytes,
  keyCommitment,
  keyIdHex,
  MAX_AGENT_PAYLOAD,
  MAX_UPSTREAM_PAYLOAD,
  objectKey,
  openObject,
  parseEnvelopes,
  Series,
  sha256,
  TInputEvent,
  uuidToBytes,
  verifyChainSegment,
  verifyCheckpoint,
  verifyKeyCert
} from "./index";

const vector = <T>(name: string): T =>
  JSON.parse(readFileSync(path.join(__dirname, "test-vectors", name), "utf8")) as T;

type TFrameVector = {
  name: string;
  type: number;
  flags: number;
  seq: number;
  timestampUs: number;
  payloadHex: string;
  frameHex: string;
};

type TChainVector = {
  events: { type: number; seq: number; body: string; envelopeHex: string; eventHashHex: string; prevHashHex: string }[];
  chunkPlaintextHex: string;
  chainHeadHex: string;
  lastSeq: number;
};

type TKeyVector = {
  recordingPublicKeyHex: string;
  recordingKeyId: string;
  recordingFingerprint: string;
  sessionPublicKeyHex: string;
  sessionKeyId: string;
  sessionId: string;
  keyCertHex: string;
  keyCertSigHex: string;
};

type TCheckpointVector = {
  name: string;
  series: number;
  kind: number;
  sessionId: string;
  projectId: string;
  objectIndex: number;
  firstSeq: number;
  lastSeq: number;
  chainHeadHex: string;
  sessionKeyHex: string;
  aadHex: string;
  plaintextHex: string;
  storedObjectHex: string;
  plaintextSha256Hex: string;
  ciphertextSha256Hex: string;
  keyCommitmentHex: string;
  checkpointHex: string;
  signatureHex: string;
  objectKey: string;
  keyPrefix: string;
};

type TShortcutCase = { name: string; events: TInputEvent[]; kept: TInputEvent[]; droppedRules: string[] };

const frames = vector<TFrameVector[]>("frames.json");
const chain = vector<TChainVector>("chain.json");
const keys = vector<TKeyVector>("keys.json");
const checkpoints = vector<TCheckpointVector[]>("checkpoints.json");
const shortcuts = vector<TShortcutCase[]>("shortcuts.json");

describe("pam web app contract: frames", () => {
  test.each(frames)("$name round-trips", (fv) => {
    const encoded = encodeFrame({
      type: fv.type,
      flags: fv.flags,
      seq: fv.seq,
      timestampUs: BigInt(fv.timestampUs),
      payload: hexToBytes(fv.payloadHex)
    });
    expect(bytesToHex(encoded)).toBe(fv.frameHex);
    const decoded = decodeFrame(hexToBytes(fv.frameHex), MAX_AGENT_PAYLOAD);
    expect(decoded.type).toBe(fv.type);
    expect(decoded.seq).toBe(fv.seq);
    expect(bytesToHex(decoded.payload)).toBe(fv.payloadHex);
  });

  test("stream reader splits concatenated frames across arbitrary chunk boundaries", () => {
    const all = hexToBytes(frames.map((f) => f.frameHex).join(""));
    const reader = createFrameReader(MAX_AGENT_PAYLOAD);
    const out = [];
    for (let i = 0; i < all.length; i += 7) out.push(...reader.push(all.subarray(i, i + 7)));
    expect(out.map((f) => f.type)).toEqual(frames.map((f) => f.type));
  });

  test("ack and meta-prefixed payloads decode", () => {
    const ack = frames.find((f) => f.name === "ack")!;
    expect(decodeAck(hexToBytes(ack.payloadHex))).toEqual({ ackSeq: 41, decodeQueue: 2 });
    const seg = frames.find((f) => f.name === "rec_segment")!;
    const { meta, body } = decodeMetaPrefixed<{ segmentIndex: number }>(hexToBytes(seg.payloadHex));
    expect(meta.segmentIndex).toBe(1);
    expect(new TextDecoder().decode(body)).toBe("moof+mdat");
  });

  test("rejects oversized upstream frames and wrong versions", () => {
    const big = encodeFrame({
      type: FrameType.Input,
      flags: 0,
      seq: 0,
      timestampUs: 0n,
      payload: new Uint8Array(MAX_UPSTREAM_PAYLOAD + 1)
    });
    expect(() => decodeFrame(big, MAX_UPSTREAM_PAYLOAD)).toThrow(FrameError);
    const bad = hexToBytes(frames[0].frameHex);
    bad[0] = 2;
    expect(() => decodeFrame(bad, MAX_UPSTREAM_PAYLOAD)).toThrow(FrameError);
  });
});

describe("pam web app contract: envelope, keys, checkpoints", () => {
  test("event hashes and chain head match", async () => {
    const plain = hexToBytes(chain.chunkPlaintextHex);
    const envelopes = parseEnvelopes(plain);
    expect(envelopes.map((e) => bytesToHex(e.raw))).toEqual(chain.events.map((e) => e.envelopeHex));
    const { head, lastSeq, hashes } = await verifyChainSegment(plain, 0n, new Uint8Array(32));
    expect(bytesToHex(head)).toBe(chain.chainHeadHex);
    expect(lastSeq).toBe(BigInt(chain.lastSeq));
    expect(hashes.map(bytesToHex)).toEqual(chain.events.map((e) => e.eventHashHex));
  });

  test("tampering and gaps are detected", async () => {
    const plain = hexToBytes(chain.chunkPlaintextHex);
    const tampered = plain.slice();
    tampered[tampered.length - 3] = (tampered[tampered.length - 3] + 1) % 256;
    const { head } = await verifyChainSegment(tampered, 0n, new Uint8Array(32));
    expect(bytesToHex(head)).not.toBe(chain.chainHeadHex);
    const gap = hexToBytes(chain.events[0].envelopeHex + chain.events[2].envelopeHex);
    await expect(verifyChainSegment(gap, 0n, new Uint8Array(32))).rejects.toThrow(/seq gap/);
  });

  test("key id and fingerprint", async () => {
    const pub = hexToBytes(keys.recordingPublicKeyHex);
    expect(await keyIdHex(pub)).toBe(keys.recordingKeyId);
    expect(await fingerprint(pub)).toBe(keys.recordingFingerprint);
  });

  test("key cert verifies against the recording key", async () => {
    const cert = await verifyKeyCert(
      hexToBytes(keys.recordingPublicKeyHex),
      hexToBytes(keys.keyCertHex),
      hexToBytes(keys.keyCertSigHex)
    );
    expect(bytesToHex(cert.sessionPublicKey)).toBe(keys.sessionPublicKeyHex);
    expect(equalBytes(cert.sessionId, uuidToBytes(keys.sessionId))).toBe(true);
    await expect(
      verifyKeyCert(hexToBytes(keys.sessionPublicKeyHex), hexToBytes(keys.keyCertHex), hexToBytes(keys.keyCertSigHex))
    ).rejects.toThrow();
  });

  test.each(checkpoints)("checkpoint $name verifies end to end", async (cv) => {
    const cp = await verifyCheckpoint(
      hexToBytes(keys.sessionPublicKeyHex),
      hexToBytes(cv.checkpointHex),
      hexToBytes(cv.signatureHex)
    );
    expect(cp.series).toBe(cv.series);
    expect(cp.objectIndex).toBe(cv.objectIndex);
    expect(cp.lastSeq).toBe(BigInt(cv.lastSeq));
    expect(bytesToHex(cp.chainHead)).toBe(cv.chainHeadHex);

    const stored = hexToBytes(cv.storedObjectHex);
    expect(bytesToHex(await sha256(stored))).toBe(cv.ciphertextSha256Hex);
    const aad = await buildAad(cv.projectId, cv.sessionId, cv.series as Series, cv.objectIndex);
    expect(bytesToHex(aad)).toBe(cv.aadHex);
    const plain = await openObject(hexToBytes(cv.sessionKeyHex), stored, aad);
    expect(bytesToHex(plain)).toBe(cv.plaintextHex);
    expect(bytesToHex(await sha256(plain))).toBe(bytesToHex(cp.plaintextSha256));
    expect(bytesToHex(await keyCommitment(hexToBytes(cv.sessionKeyHex)))).toBe(cv.keyCommitmentHex);
    expect(
      objectKey(cv.keyPrefix, cv.projectId, cv.sessionId, cv.series, cv.kind as CheckpointKind, cv.objectIndex)
    ).toBe(cv.objectKey);
  });

  test("V checkpoint binds to the v_init event in the chain", async () => {
    const v = checkpoints.find((c) => c.series === Series.V)!;
    const { hashes, envelopes } = await verifyChainSegment(hexToBytes(chain.chunkPlaintextHex), 0n, new Uint8Array(32));
    const idx = envelopes.findIndex((e) => e.seq === BigInt(v.lastSeq));
    expect(bytesToHex(hashes[idx])).toBe(v.chainHeadHex);
    const body = JSON.parse(new TextDecoder().decode(envelopes[idx].body)) as { sha256: string };
    expect(body.sha256).toBe(v.plaintextSha256Hex);
  });

  test("a forged checkpoint signature fails", async () => {
    const cv = checkpoints[0];
    const bytes = hexToBytes(cv.checkpointHex);
    bytes[30] = (bytes[30] + 1) % 256;
    await expect(
      verifyCheckpoint(hexToBytes(keys.sessionPublicKeyHex), bytes, hexToBytes(cv.signatureHex))
    ).rejects.toThrow();
  });

  test("decrypting with the wrong object index fails", async () => {
    const cv = checkpoints[0];
    const aad = await buildAad(cv.projectId, cv.sessionId, Series.E, cv.objectIndex + 1);
    await expect(openObject(hexToBytes(cv.sessionKeyHex), hexToBytes(cv.storedObjectHex), aad)).rejects.toThrow();
  });

  test("decrypts with a session key that is a Buffer view at a nonzero offset", async () => {
    const cv = checkpoints[0];
    const unwrapped = Buffer.concat([Buffer.alloc(32, 0xaa), Buffer.from(hexToBytes(cv.sessionKeyHex))]);
    const sessionKey = unwrapped.subarray(32, 64);
    const aad = await buildAad(cv.projectId, cv.sessionId, cv.series as Series, cv.objectIndex);
    const plain = await openObject(sessionKey, hexToBytes(cv.storedObjectHex), aad);
    expect(bytesToHex(plain)).toBe(cv.plaintextHex);
  });

  test("base64 helpers", () => {
    expect(bytesToHex(base64ToBytes("AAEC"))).toBe("000102");
  });
});

describe("pam web app contract: input filter", () => {
  test.each(shortcuts)("$name", (c) => {
    const { kept, droppedRules } = createInputFilter()(c.events);
    expect(droppedRules).toEqual(c.droppedRules);
    expect(kept).toEqual(c.kept);
  });
});
