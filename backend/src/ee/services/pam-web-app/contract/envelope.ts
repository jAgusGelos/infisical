// Verification side only: the gateway (Go) produces these structures. WebCrypto (globalThis.crypto.subtle) is
// used so the same file runs in Node and browsers.

const DOMAIN_EVENT = "infisical-webapp/event/v1";
const DOMAIN_KEY_CERT = "infisical-webapp/key-cert/v1";
const DOMAIN_CHECKPOINT = "infisical-webapp/checkpoint/v1";
const DOMAIN_AAD = "infisical-webapp/aad/v1";
const DOMAIN_KEY_COMMIT = "infisical-webapp/key-commit/v1";

export const MAX_ENVELOPE_BODY = 8 * 1024 * 1024;
export const ENVELOPE_HEADER_SIZE = 68;
export const KEY_CERT_SIZE = 80;
export const CHECKPOINT_SIZE = 208;
export const IV_SIZE = 12;

const MAGIC_ENVELOPE = "IWE1";
const MAGIC_KEY_CERT = "IWK1";
const MAGIC_CHECKPOINT = "IWC1";

export enum EventType {
  SessionOpen = 0x0001,
  Heartbeat = 0x0002,
  SessionEnd = 0x0003,
  Loss = 0x0004,
  ContinuityUnknown = 0x0005,
  ViewerDegraded = 0x0006,
  LiveCodec = 0x0007,
  VInit = 0x0100,
  VSegment = 0x0101,
  L1Request = 0x0200,
  L1Response = 0x0201,
  L1WsFrame = 0x0202,
  L1Blocked = 0x0203,
  L3Input = 0x0300,
  ExtEvent = 0x0301,
  Rrweb = 0x0400
}

export enum Series {
  E = 1,
  V = 2
}

export enum CheckpointKind {
  Events = 0,
  VideoInit = 1,
  VideoMedia = 2
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const subtle = () => globalThis.crypto.subtle;

const toArrayBuffer = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  parts.forEach((p) => {
    out.set(p, off);
    off += p.length;
  });
  return out;
};

export const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const hexToBytes = (hex: string): Uint8Array => {
  if (!/^[0-9a-f]*$/i.test(hex)) throw new Error("invalid hex");
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

export const bytesToBase64 = (b: Uint8Array, padded = true) => {
  let bin = "";
  b.forEach((x) => {
    bin += String.fromCharCode(x);
  });
  const out = btoa(bin);
  return padded ? out : out.replace(/=+$/, "");
};

export const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export const sha256 = async (data: Uint8Array) => new Uint8Array(await subtle().digest("SHA-256", toArrayBuffer(data)));

const domainMessage = (domain: string, msg: Uint8Array) =>
  concatBytes(textEncoder.encode(domain), new Uint8Array([0]), msg);

const hasMagic = (b: Uint8Array, magic: string) =>
  textDecoder.decode(b.subarray(0, 4)) === magic && b[4] === 1 && b[5] === 1;

export const keyId = async (rawPublicKey: Uint8Array) => (await sha256(rawPublicKey)).slice(0, 8);

export const keyIdHex = async (rawPublicKey: Uint8Array) => bytesToHex(await keyId(rawPublicKey));

export const fingerprint = async (rawPublicKey: Uint8Array) =>
  `SHA256:${bytesToBase64(await sha256(rawPublicKey), false)}`;

const ed25519Verify = async (rawPublicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
  if (rawPublicKey.length !== 32 || signature.length !== 64) return false;
  const key = await subtle().importKey("raw", toArrayBuffer(rawPublicKey), { name: "Ed25519" }, false, ["verify"]);
  return subtle().verify({ name: "Ed25519" }, key, toArrayBuffer(signature), toArrayBuffer(message));
};

export type TEnvelope = {
  type: number;
  seq: bigint;
  wallTimeUnixMs: bigint;
  monoElapsedUs: bigint;
  prevHash: Uint8Array;
  body: Uint8Array;
  raw: Uint8Array;
};

export const eventHash = (envelopeBytes: Uint8Array) => sha256(domainMessage(DOMAIN_EVENT, envelopeBytes));

export const parseEnvelopes = (chunk: Uint8Array): TEnvelope[] => {
  const out: TEnvelope[] = [];
  let off = 0;
  while (off < chunk.length) {
    if (chunk.length - off < ENVELOPE_HEADER_SIZE) throw new Error("truncated envelope header");
    const h = chunk.subarray(off, off + ENVELOPE_HEADER_SIZE);
    if (!hasMagic(h, MAGIC_ENVELOPE)) throw new Error(`bad envelope magic/version at offset ${off}`);
    const view = new DataView(h.buffer, h.byteOffset, ENVELOPE_HEADER_SIZE);
    const bodyLen = view.getUint32(64);
    if (bodyLen > MAX_ENVELOPE_BODY) throw new Error(`envelope body too large at offset ${off}`);
    const end = off + ENVELOPE_HEADER_SIZE + bodyLen;
    if (end > chunk.length) throw new Error(`bad envelope body length at offset ${off}`);
    out.push({
      type: view.getUint16(6),
      seq: view.getBigUint64(8),
      wallTimeUnixMs: view.getBigInt64(16),
      monoElapsedUs: view.getBigUint64(24),
      prevHash: h.slice(32, 64),
      body: chunk.slice(off + ENVELOPE_HEADER_SIZE, end),
      raw: chunk.slice(off, end)
    });
    off = end;
  }
  return out;
};

export const decodeEnvelopeBody = <T>(env: TEnvelope): T => JSON.parse(textDecoder.decode(env.body)) as T;

// Per-envelope hashes are returned because a V checkpoint's chainHead is the eventHash of its v_init/v_segment.
export const verifyChainSegment = async (chunkPlaintext: Uint8Array, firstSeq: bigint, prevHash: Uint8Array) => {
  const envelopes = parseEnvelopes(chunkPlaintext);
  if (envelopes.length === 0) throw new Error("empty chunk");
  const hashes: Uint8Array[] = [];
  let expected = firstSeq;
  let prev = prevHash;
  for (let i = 0; i < envelopes.length; i += 1) {
    const env = envelopes[i];
    if (env.seq !== expected) throw new Error(`seq gap: expected ${expected} got ${env.seq}`);
    if (!equalBytes(env.prevHash, prev)) throw new Error(`prevHash mismatch at seq ${env.seq}`);
    // eslint-disable-next-line no-await-in-loop
    prev = await eventHash(env.raw);
    hashes.push(prev);
    expected += 1n;
  }
  return { head: prev, lastSeq: expected - 1n, envelopes, hashes };
};

export type TKeyCert = {
  sessionId: Uint8Array;
  sessionPublicKey: Uint8Array;
  notBeforeUnixMs: bigint;
  notAfterUnixMs: bigint;
  issuerKeyId: Uint8Array;
};

export const parseKeyCert = (b: Uint8Array): TKeyCert => {
  if (b.length !== KEY_CERT_SIZE || !hasMagic(b, MAGIC_KEY_CERT)) throw new Error("bad key cert encoding");
  const view = new DataView(b.buffer, b.byteOffset, KEY_CERT_SIZE);
  return {
    sessionId: b.slice(8, 24),
    sessionPublicKey: b.slice(24, 56),
    notBeforeUnixMs: view.getBigInt64(56),
    notAfterUnixMs: view.getBigInt64(64),
    issuerKeyId: b.slice(72, 80)
  };
};

export const verifyKeyCert = async (
  recordingPublicKey: Uint8Array,
  keyCertBytes: Uint8Array,
  signature: Uint8Array
) => {
  const cert = parseKeyCert(keyCertBytes);
  if (!equalBytes(cert.issuerKeyId, await keyId(recordingPublicKey))) {
    throw new Error("key cert issuer does not match recording key");
  }
  if (!(await ed25519Verify(recordingPublicKey, domainMessage(DOMAIN_KEY_CERT, keyCertBytes), signature))) {
    throw new Error("bad key cert signature");
  }
  return cert;
};

export type TCheckpoint = {
  series: Series;
  kind: CheckpointKind;
  sessionId: Uint8Array;
  objectIndex: number;
  firstSeq: bigint;
  lastSeq: bigint;
  chainHead: Uint8Array;
  plaintextSha256: Uint8Array;
  ciphertextSha256: Uint8Array;
  plaintextBytes: bigint;
  ciphertextBytes: bigint;
  keyCommitment: Uint8Array;
  maskingPolicyVersion: number;
  signerKeyId: Uint8Array;
  createdAtUnixMs: bigint;
};

const parseCheckpointKind = (series: Series, kind: number): CheckpointKind => {
  const valid =
    series === Series.E
      ? kind === CheckpointKind.Events
      : kind === CheckpointKind.VideoInit || kind === CheckpointKind.VideoMedia;
  if (!valid) throw new Error(`checkpoint kind ${kind} is invalid for series ${series}`);
  return kind;
};

export const parseCheckpoint = (b: Uint8Array): TCheckpoint => {
  if (b.length !== CHECKPOINT_SIZE || !hasMagic(b, MAGIC_CHECKPOINT)) throw new Error("bad checkpoint encoding");
  const view = new DataView(b.buffer, b.byteOffset, CHECKPOINT_SIZE);
  const series = view.getUint8(6);
  if (series !== Series.E && series !== Series.V) throw new Error(`unknown series ${series}`);
  return {
    series,
    kind: parseCheckpointKind(series, view.getUint8(7)),
    sessionId: b.slice(8, 24),
    objectIndex: view.getUint32(24),
    firstSeq: view.getBigUint64(28),
    lastSeq: view.getBigUint64(36),
    chainHead: b.slice(44, 76),
    plaintextSha256: b.slice(76, 108),
    ciphertextSha256: b.slice(108, 140),
    plaintextBytes: view.getBigUint64(140),
    ciphertextBytes: view.getBigUint64(148),
    keyCommitment: b.slice(156, 188),
    maskingPolicyVersion: view.getUint32(188),
    signerKeyId: b.slice(192, 200),
    createdAtUnixMs: view.getBigInt64(200)
  };
};

export const verifyCheckpoint = async (
  sessionPublicKey: Uint8Array,
  checkpointBytes: Uint8Array,
  signature: Uint8Array
) => {
  const cp = parseCheckpoint(checkpointBytes);
  if (!equalBytes(cp.signerKeyId, await keyId(sessionPublicKey))) {
    throw new Error("checkpoint signer does not match session key");
  }
  if (!(await ed25519Verify(sessionPublicKey, domainMessage(DOMAIN_CHECKPOINT, checkpointBytes), signature))) {
    throw new Error("bad checkpoint signature");
  }
  return cp;
};

export const seriesLetter = (s: Series) => (s === Series.V ? "V" : "E");

export const buildAad = (projectId: string, sessionId: string, series: Series, objectIndex: number) => {
  const zero = new Uint8Array([0]);
  return sha256(
    concatBytes(
      ...[DOMAIN_AAD, projectId, sessionId, seriesLetter(series)].flatMap((p) => [textEncoder.encode(p), zero]),
      textEncoder.encode(String(objectIndex))
    )
  );
};

export const keyCommitment = (sessionKey: Uint8Array) => sha256(domainMessage(DOMAIN_KEY_COMMIT, sessionKey));

// Decrypts a stored object (IV || ciphertext || tag).
export const openObject = async (sessionKey: Uint8Array, stored: Uint8Array, aad: Uint8Array) => {
  if (stored.length < IV_SIZE + 16) throw new Error("stored object too short");
  const key = await subtle().importKey("raw", toArrayBuffer(sessionKey), { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(stored.subarray(0, IV_SIZE)),
      additionalData: toArrayBuffer(aad),
      tagLength: 128
    },
    key,
    toArrayBuffer(stored.subarray(IV_SIZE))
  );
  return new Uint8Array(plain);
};

export const objectKey = (
  keyPrefix: string,
  projectId: string,
  sessionId: string,
  series: Series,
  kind: CheckpointKind,
  objectIndex: number
) => {
  const ext = {
    [CheckpointKind.Events]: "evt",
    [CheckpointKind.VideoInit]: "init.mp4",
    [CheckpointKind.VideoMedia]: "m4s"
  }[kind];
  const key = `web-app/${projectId}/${sessionId}/${seriesLetter(series)}/${String(objectIndex).padStart(8, "0")}.${ext}`;
  const prefix = keyPrefix.replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${key}` : key;
};

export const uuidToBytes = (uuid: string) => hexToBytes(uuid.replace(/-/g, ""));
