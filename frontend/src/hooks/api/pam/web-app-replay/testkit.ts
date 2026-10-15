// Producer side of the recording format for unit tests and the DEV fixture generator. Never imported by the app:
// the gateway is the only real producer. The relative contract import keeps it runnable by tsx without path aliases.
import {
  CHECKPOINT_SIZE,
  CheckpointKind,
  concatBytes,
  ENVELOPE_HEADER_SIZE,
  eventHash,
  hexToBytes,
  keyId,
  Series
} from "../../../../lib/pam-web-app/contract";

const textEncoder = new TextEncoder();

const PKCS8_ED25519_PREFIX = hexToBytes("302e020100300506032b657004220420");

const toArrayBuffer = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export const ed25519SigningKeyFromSeed = (seed: Uint8Array) =>
  globalThis.crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(concatBytes(PKCS8_ED25519_PREFIX, seed)),
    { name: "Ed25519" },
    false,
    ["sign"]
  );

const domainMessage = (domain: string, msg: Uint8Array) =>
  concatBytes(textEncoder.encode(domain), new Uint8Array([0]), msg);

export const signWithDomain = async (key: CryptoKey, domain: string, msg: Uint8Array) =>
  new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      toArrayBuffer(domainMessage(domain, msg))
    )
  );

export const signCheckpoint = (sessionKey: CryptoKey, checkpoint: Uint8Array) =>
  signWithDomain(sessionKey, "infisical-webapp/checkpoint/v1", checkpoint);

export const signKeyCert = (recordingKey: CryptoKey, keyCert: Uint8Array) =>
  signWithDomain(recordingKey, "infisical-webapp/key-cert/v1", keyCert);

const header = (magic: string) => {
  const out = new Uint8Array(6);
  out.set(textEncoder.encode(magic), 0);
  out[4] = 1;
  out[5] = 1;
  return out;
};

export const buildKeyCert = async (args: {
  sessionIdBytes: Uint8Array;
  sessionPublicKey: Uint8Array;
  notBeforeUnixMs: bigint;
  notAfterUnixMs: bigint;
  recordingPublicKey: Uint8Array;
}) => {
  const b = new Uint8Array(80);
  b.set(header("IWK1"), 0);
  b.set(args.sessionIdBytes, 8);
  b.set(args.sessionPublicKey, 24);
  const view = new DataView(b.buffer);
  view.setBigInt64(56, args.notBeforeUnixMs);
  view.setBigInt64(64, args.notAfterUnixMs);
  b.set(await keyId(args.recordingPublicKey), 72);
  return b;
};

export type TBuildEnvelopeArgs = {
  type: number;
  seq: bigint;
  wallTimeUnixMs: bigint;
  monoElapsedUs: bigint;
  prevHash: Uint8Array;
  body: unknown;
};

export const buildEnvelope = (args: TBuildEnvelopeArgs) => {
  const body = textEncoder.encode(JSON.stringify(args.body));
  const b = new Uint8Array(ENVELOPE_HEADER_SIZE + body.length);
  b.set(header("IWE1"), 0);
  const view = new DataView(b.buffer);
  view.setUint16(6, args.type);
  view.setBigUint64(8, args.seq);
  view.setBigInt64(16, args.wallTimeUnixMs);
  view.setBigUint64(24, args.monoElapsedUs);
  b.set(args.prevHash, 32);
  view.setUint32(64, body.length);
  b.set(body, ENVELOPE_HEADER_SIZE);
  return b;
};

export const buildChain = async (
  events: Omit<TBuildEnvelopeArgs, "seq" | "prevHash">[],
  startSeq = 0n,
  startPrevHash = new Uint8Array(32)
) => {
  const envelopes: Uint8Array[] = [];
  const hashes: Uint8Array[] = [];
  let prev = startPrevHash;
  for (let i = 0; i < events.length; i += 1) {
    const env = buildEnvelope({ ...events[i], seq: startSeq + BigInt(i), prevHash: prev });
    envelopes.push(env);
    // eslint-disable-next-line no-await-in-loop
    prev = await eventHash(env);
    hashes.push(prev);
  }
  return { envelopes, hashes };
};

export type TBuildCheckpointArgs = {
  series: Series;
  kind: CheckpointKind;
  sessionIdBytes: Uint8Array;
  objectIndex: number;
  firstSeq: bigint;
  lastSeq: bigint;
  chainHead: Uint8Array;
  plaintextSha256: Uint8Array;
  ciphertextSha256?: Uint8Array;
  plaintextBytes: bigint;
  ciphertextBytes?: bigint;
  keyCommitment?: Uint8Array;
  maskingPolicyVersion?: number;
  signerPublicKey: Uint8Array;
  createdAtUnixMs: bigint;
};

export const buildCheckpoint = async (args: TBuildCheckpointArgs) => {
  const b = new Uint8Array(CHECKPOINT_SIZE);
  b.set(header("IWC1"), 0);
  const view = new DataView(b.buffer);
  view.setUint8(6, args.series);
  view.setUint8(7, args.kind);
  b.set(args.sessionIdBytes, 8);
  view.setUint32(24, args.objectIndex);
  view.setBigUint64(28, args.firstSeq);
  view.setBigUint64(36, args.lastSeq);
  b.set(args.chainHead, 44);
  b.set(args.plaintextSha256, 76);
  b.set(args.ciphertextSha256 ?? new Uint8Array(32), 108);
  view.setBigUint64(140, args.plaintextBytes);
  view.setBigUint64(148, args.ciphertextBytes ?? args.plaintextBytes + 28n);
  b.set(args.keyCommitment ?? new Uint8Array(32), 156);
  view.setUint32(188, args.maskingPolicyVersion ?? 1);
  b.set(await keyId(args.signerPublicKey), 192);
  view.setBigInt64(200, args.createdAtUnixMs);
  return b;
};
