// DEV-only fixture for the Web App replay page (open a session with ?replayFixture=<variant>).
// Usage: npx tsx scripts/webapp-replay-fixture.ts
// Writes public/dev-fixtures/webapp-replay/<variant>/ (git-excluded, never committed). Needs ffmpeg with libx264.
// Signatures are real: the recording and session keys come from the contract test-vector seeds.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCheckpoint,
  buildChain,
  ed25519SigningKeyFromSeed,
  signCheckpoint
} from "../src/hooks/api/pam/web-app-replay/testkit";
import {
  buildAad,
  bytesToBase64,
  bytesToHex,
  CheckpointKind,
  concatBytes,
  EventType,
  hexToBytes,
  keyCommitment,
  Series,
  seriesLetter,
  sha256,
  uuidToBytes
} from "../src/lib/pam-web-app/contract";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = join(here, "../src/lib/pam-web-app/contract/test-vectors");
const outRoot = join(here, "../public/dev-fixtures/webapp-replay");

const keys = JSON.parse(readFileSync(join(vectors, "keys.json"), "utf8")) as Record<string, string>;
const SESSION_ID = keys.sessionId;
const PROJECT_ID = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const SESSION_AES_KEY = hexToBytes("11".repeat(32));
const OPEN_WALL_MS = 1760544000000n;
const PTS_ZERO_MONO_US = 1_250_000;
const SEGMENT_US = 10_000_000;
const SEGMENT_SECONDS = SEGMENT_US / 1_000_000;
const SEGMENTS = 3;
const FRAMES_PER_SEGMENT = 300;
const VIDEO_CODEC = "avc1.64001f";
const MIME = `video/mp4; codecs="${VIDEO_CODEC}"`;
const CHUNK_SPLIT_MONO_US = 15_000_000;
const SESSION_END_MONO_US = 31_500_000;

const encodeVideo = () => {
  const dir = mkdtempSync(join(tmpdir(), "webapp-replay-"));
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30",
      "-t",
      String(SEGMENTS * SEGMENT_SECONDS),
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-level",
      "3.1",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      "80k",
      "-maxrate",
      "120k",
      "-bufsize",
      "240k",
      "-threads",
      "1",
      "-g",
      String(FRAMES_PER_SEGMENT),
      "-keyint_min",
      String(FRAMES_PER_SEGMENT),
      "-sc_threshold",
      "0",
      "-f",
      "hls",
      "-hls_time",
      String(SEGMENT_SECONDS),
      "-hls_segment_type",
      "fmp4",
      "-hls_playlist_type",
      "vod",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_segment_filename",
      join(dir, "seg%d.m4s"),
      join(dir, "out.m3u8")
    ],
    { stdio: "inherit" }
  );
  const init = new Uint8Array(readFileSync(join(dir, "init.mp4")));
  const segments = Array.from(
    { length: SEGMENTS },
    (_, i) => new Uint8Array(readFileSync(join(dir, `seg${i}.m4s`)))
  );
  rmSync(dir, { recursive: true, force: true });
  return { init, segments };
};

type TEventSpec = { type: number; monoUs: number; body: unknown };

const l1 = (
  monoUs: number,
  reqId: string,
  method: string,
  url: string,
  status: number,
  reqHeaders: [string, string][],
  resHeaders: [string, string][] = [],
  body = ""
): TEventSpec[] => [
  {
    type: EventType.L1Request,
    monoUs,
    body: {
      reqId,
      connId: "c-1",
      method,
      url,
      headers: reqHeaders,
      bodyBytes: body.length,
      bodySha256: "",
      body: Buffer.from(body).toString("base64"),
      truncated: false,
      destIp: "172.27.0.10",
      destPort: 443
    }
  },
  {
    type: EventType.L1Response,
    monoUs: monoUs + 40_000,
    body: {
      reqId,
      status,
      headers: resHeaders,
      bodyBytes: 0,
      bodySha256: "",
      body: "",
      truncated: false,
      durationMs: 40
    }
  }
];

const nav: [string, string][] = [
  ["sec-fetch-dest", "document"],
  ["sec-fetch-mode", "navigate"],
  ["authorization", "***"]
];
const xhr: [string, string][] = [
  ["sec-fetch-dest", "empty"],
  ["sec-fetch-mode", "cors"],
  ["content-type", "application/json"]
];

const key = (ch: string, masked: boolean) => ({
  t: "key",
  action: "down",
  code: masked ? "Masked" : `Key${ch.toUpperCase()}`,
  key: masked ? "*" : ch,
  mods: 0,
  repeat: false,
  ts: 0
});

const traffic = (withLoss: boolean): TEventSpec[] => {
  const base = "https://grafana.corp.internal";
  const list: TEventSpec[] = [
    ...l1(2_000_000, "r-1", "GET", `${base}/login`, 200, nav),
    {
      type: EventType.L3Input,
      monoUs: 3_000_000,
      body: {
        events: [{ t: "button", action: "down", button: 0, x: 640, y: 300, ts: 0 }],
        dropped: [],
        masked: false,
        frameSeq: 1
      }
    },
    {
      type: EventType.L3Input,
      monoUs: 4_000_000,
      body: { events: [..."admin"].map((c) => key(c, false)), dropped: [], masked: false, frameSeq: 2 }
    },
    {
      type: EventType.L3Input,
      monoUs: 5_000_000,
      body: { events: [..."secret"].map((c) => key(c, true)), dropped: [], masked: true, frameSeq: 3 }
    },
    { type: EventType.ExtEvent, monoUs: 5_500_000, body: { kind: "credential_injected", field: "password" } },
    ...l1(
      6_000_000,
      "r-2",
      "POST",
      `${base}/login`,
      302,
      [...nav, ["content-type", "application/x-www-form-urlencoded"]],
      [["location", "/"], ["set-cookie", "***"]],
      "user=admin&password=***"
    ),
    ...l1(6_500_000, "r-3", "GET", `${base}/`, 200, nav),
    ...l1(8_000_000, "r-4", "POST", `${base}/api/ds/query`, 200, xhr, [], '{"queries":[]}'),
    {
      type: EventType.L1Blocked,
      monoUs: 12_000_000,
      body: { method: "CONNECT", host: "evil.example", port: 443, reason: "host_not_allowed" }
    },
    ...l1(13_000_000, "r-5", "POST", `${base}/api/ds/query`, 200, xhr, [], '{"queries":[]}'),
    ...l1(16_000_000, "r-6", "GET", `${base}/api/reports/export.csv`, 200, nav, [
      ["content-disposition", 'attachment; filename="export.csv"']
    ]),
    {
      type: EventType.L3Input,
      monoUs: 17_000_000,
      body: { events: [{ t: "paste", text: "SELECT 1", ts: 0 }], dropped: [], masked: false, frameSeq: 4 }
    },
    ...l1(
      19_000_000,
      "r-7",
      "POST",
      `${base}/api/dashboards/import`,
      500,
      [...xhr.slice(0, 2), ["content-type", "multipart/form-data; boundary=x"]],
      [],
      "--x--"
    ),
    { type: EventType.ViewerDegraded, monoUs: 22_000_000, body: { active: true, droppedFrames: 40 } },
    { type: EventType.ViewerDegraded, monoUs: 24_000_000, body: { active: false, droppedFrames: 0 } },
    ...l1(23_000_000, "r-8", "POST", `${base}/api/ds/query`, 200, xhr, [], '{"queries":[]}'),
    {
      type: EventType.Heartbeat,
      monoUs: 30_000_000,
      body: { lastSeq: 0, uptimeMs: 30000, viewerConnected: true }
    }
  ];
  if (withLoss) {
    list.push({
      type: EventType.Loss,
      monoUs: 26_000_000,
      body: { stream: "L1", fromUs: 24_500_000, toUs: 26_000_000, count: 3, reason: "queue_overflow" }
    });
  }
  return list;
};

const encrypt = async (series: Series, objectIndex: number, plaintext: Uint8Array) => {
  const iv = (await sha256(new TextEncoder().encode(`${series}/${objectIndex}`))).slice(0, 12);
  const aad = await buildAad(PROJECT_ID, SESSION_ID, series, objectIndex);
  const key = await crypto.subtle.importKey("raw", SESSION_AES_KEY.slice().buffer, "AES-GCM", false, [
    "encrypt"
  ]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv.slice().buffer, additionalData: aad.slice().buffer, tagLength: 128 },
      key,
      plaintext.slice().buffer
    )
  );
  return concatBytes(iv, ct);
};

type TVariant = { name: string; withLoss?: boolean; active?: boolean };

type TVideo = { init: Uint8Array; segments: Uint8Array[] };

const videoEventSpecs = (video: TVideo, vHashes: Uint8Array[]): TEventSpec[] => [
  {
    type: EventType.VInit,
    monoUs: 1_000_000,
    body: {
      objectIndex: 0,
      sha256: bytesToHex(vHashes[0]),
      bytes: video.init.length,
      codec: VIDEO_CODEC,
      width: 1280,
      height: 720,
      timescale: 90000
    }
  },
  ...video.segments.map((seg, i) => ({
    type: EventType.VSegment,
    monoUs: PTS_ZERO_MONO_US + (i + 1) * SEGMENT_US,
    body: {
      objectIndex: i + 1,
      initIndex: 0,
      segmentIndex: i + 1,
      sha256: bytesToHex(vHashes[i + 1]),
      bytes: seg.length,
      startPtsUs: i * SEGMENT_US,
      endPtsUs: (i + 1) * SEGMENT_US,
      monoStartUs: PTS_ZERO_MONO_US + i * SEGMENT_US,
      monoEndUs: PTS_ZERO_MONO_US + (i + 1) * SEGMENT_US,
      firstFrame: i * FRAMES_PER_SEGMENT,
      frameCount: FRAMES_PER_SEGMENT,
      framesDropped: 0
    }
  }))
];

const sessionOpenSpec = (): TEventSpec => ({
  type: EventType.SessionOpen,
  monoUs: 0,
  body: {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    resourceType: "web-app",
    startUrl: "https://grafana.corp.internal/",
    allowedHosts: ["grafana.corp.internal"],
    recordingKey: {
      keyId: keys.recordingKeyId,
      fingerprint: keys.recordingFingerprint,
      publicKey: bytesToBase64(hexToBytes(keys.recordingPublicKeyHex))
    },
    sessionKeyCert: bytesToBase64(hexToBytes(keys.keyCertHex)),
    sessionKeyCertSig: bytesToBase64(hexToBytes(keys.keyCertSigHex)),
    maskingPolicyVersion: 1,
    liveCodec: null,
    startedAt: new Date(Number(OPEN_WALL_MS)).toISOString()
  }
});

const createObjectSigner = async (write: (rel: string, data: Uint8Array) => void) => {
  const sessionSigner = await ed25519SigningKeyFromSeed(hexToBytes(keys.sessionSeedHex));
  const sessionPublicKey = hexToBytes(keys.sessionPublicKeyHex);
  const sessionIdBytes = uuidToBytes(SESSION_ID);
  const commitment = await keyCommitment(SESSION_AES_KEY);
  return async (
    series: Series,
    kind: CheckpointKind,
    objectIndex: number,
    seqRange: [number, number],
    chainHead: Uint8Array,
    plaintext: Uint8Array
  ) => {
    const stored = await encrypt(series, objectIndex, plaintext);
    const cp = await buildCheckpoint({
      series,
      kind,
      sessionIdBytes,
      objectIndex,
      firstSeq: BigInt(seqRange[0]),
      lastSeq: BigInt(seqRange[1]),
      chainHead,
      plaintextSha256: await sha256(plaintext),
      ciphertextSha256: await sha256(stored),
      plaintextBytes: BigInt(plaintext.length),
      ciphertextBytes: BigInt(stored.length),
      keyCommitment: commitment,
      signerPublicKey: sessionPublicKey,
      createdAtUnixMs: OPEN_WALL_MS + 40_000n
    });
    const letter = seriesLetter(series);
    write(`objects/${letter}/${objectIndex}`, plaintext);
    write(`stored/${letter}/${objectIndex}`, stored);
    return {
      objectIndex,
      checkpoint: bytesToBase64(cp),
      signature: bytesToBase64(await signCheckpoint(sessionSigner, cp)),
      objectKey: `web-app/${PROJECT_ID}/${SESSION_ID}/${letter}/${String(objectIndex).padStart(8, "0")}`,
      versionId: `v-${letter}-${objectIndex}`,
      binding: "bound" as const
    };
  };
};

const mediaEntryFields = (objectIndex: number) => {
  const startUs = (objectIndex - 1) * SEGMENT_US;
  return {
    kind: "media",
    initIndex: 0,
    startMs: startUs / 1000,
    endMs: (startUs + SEGMENT_US) / 1000,
    monoStartUs: PTS_ZERO_MONO_US + startUs,
    monoEndUs: PTS_ZERO_MONO_US + startUs + SEGMENT_US,
    frameCount: FRAMES_PER_SEGMENT,
    framesDropped: 0
  };
};

const replayDocument = (variant: TVariant, videoEntries: unknown[], chunks: unknown[]) => ({
  sessionId: SESSION_ID,
  projectId: PROJECT_ID,
  status: variant.active ? "active" : "ended",
  startedAt: new Date(Number(OPEN_WALL_MS)).toISOString(),
  endedAt: variant.active ? null : new Date(Number(OPEN_WALL_MS) + SESSION_END_MONO_US / 1000).toISOString(),
  endReason: variant.active ? null : "user_end",
  recordingKey: {
    publicKey: bytesToBase64(hexToBytes(keys.recordingPublicKeyHex)),
    keyId: keys.recordingKeyId,
    fingerprint: keys.recordingFingerprint
  },
  keyCert: bytesToBase64(hexToBytes(keys.keyCertHex)),
  keyCertSig: bytesToBase64(hexToBytes(keys.keyCertSigHex)),
  storage: { objectLock: true, mode: "COMPLIANCE", retainUntil: "2026-10-15T00:00:00Z" },
  video: { mime: MIME, objects: videoEntries },
  events: { chunks },
  manifest: null
});

const isVideoSpecFor = (objectIndex: number) => (s: TEventSpec) =>
  (s.type === EventType.VInit || s.type === EventType.VSegment) &&
  (s.body as { objectIndex: number }).objectIndex === objectIndex;

const build = async (video: TVideo, variant: TVariant) => {
  const vObjects = [video.init, ...video.segments];
  const vHashes = await Promise.all(vObjects.map((o) => sha256(o)));
  const specs = [...videoEventSpecs(video, vHashes), ...traffic(Boolean(variant.withLoss))].sort(
    (a, b) => a.monoUs - b.monoUs
  );
  const all = [sessionOpenSpec(), ...specs];
  if (!variant.active) {
    all.push({
      type: EventType.SessionEnd,
      monoUs: SESSION_END_MONO_US,
      body: { reason: "user_end", finalSeq: all.length, vObjects: vObjects.length, eChunks: 2 }
    });
  }
  const { envelopes, hashes } = await buildChain(
    all.map((s) => ({
      type: s.type,
      wallTimeUnixMs: OPEN_WALL_MS + BigInt(Math.floor(s.monoUs / 1000)),
      monoElapsedUs: BigInt(s.monoUs),
      body: s.body
    }))
  );

  const outDir = join(outRoot, variant.name);
  rmSync(outDir, { recursive: true, force: true });
  const write = (rel: string, data: Uint8Array | string) => {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  const signObject = await createObjectSigner(write);

  const split = all.findIndex((s) => s.monoUs >= CHUNK_SPLIT_MONO_US);
  const chunkRanges: [number, number][] = [
    [0, split - 1],
    [split, all.length - 1]
  ];
  const chunks = [];
  for (let i = 0; i < chunkRanges.length; i += 1) {
    const [first, last] = chunkRanges[i];
    if (variant.active && i === chunkRanges.length - 1) break;
    const plaintext = concatBytes(...envelopes.slice(first, last + 1));
    // eslint-disable-next-line no-await-in-loop
    const signed = await signObject(Series.E, CheckpointKind.Events, i, [first, last], hashes[last], plaintext);
    chunks.push({ ...signed, firstSeq: first, lastSeq: last });
  }

  const videoEntries = [];
  for (let i = 0; i < vObjects.length; i += 1) {
    const seq = all.findIndex(isVideoSpecFor(i));
    const kind = i === 0 ? CheckpointKind.VideoInit : CheckpointKind.VideoMedia;
    // eslint-disable-next-line no-await-in-loop
    const signed = await signObject(Series.V, kind, i, [seq, seq], hashes[seq], vObjects[i]);
    videoEntries.push(i === 0 ? { ...signed, kind: "init" } : { ...signed, ...mediaEntryFields(i) });
  }

  write("replay.json", JSON.stringify(replayDocument(variant, videoEntries, chunks), null, 2));
  write("session-key.b64", `${bytesToBase64(SESSION_AES_KEY)}\n`);
  return outDir;
};

const main = async () => {
  const video = encodeVideo();
  const base = await build(video, { name: "base" });
  await build(video, { name: "loss", withLoss: true });
  await build(video, { name: "active", active: true });

  const tamper = await build(video, { name: "tamper" });
  const seg2 = new Uint8Array(readFileSync(join(tamper, "objects/V/2")));
  seg2[Math.floor(seg2.length / 2)] ^= 0xff;
  writeFileSync(join(tamper, "objects/V/2"), seg2);

  const gap = await build(video, { name: "gap" });
  rmSync(join(gap, "objects/V/2"));

  console.log(`fixtures written under ${dirname(base)}: base, loss, active, tamper, gap`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
