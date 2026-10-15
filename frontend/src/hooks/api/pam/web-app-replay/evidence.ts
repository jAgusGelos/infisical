import { WEB_APP_REPLAY_FETCH_CONCURRENCY } from "./limits";
import { TWebAppReplaySource } from "./source";
import { TWebAppReplay, TWebAppReplaySeries } from "./types";

export type TTarEntry = { path: string; bytes: Uint8Array };

const BLOCK = 512;
const textEncoder = new TextEncoder();

const writeString = (header: Uint8Array, offset: number, length: number, value: string) => {
  const bytes = textEncoder.encode(value);
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  header.set(bytes, offset);
};

const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;

const tarHeader = (path: string, size: number, mtimeSeconds: number) => {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, path);
  writeString(header, 100, 8, octal(0o644, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(size, 12));
  writeString(header, 136, 12, octal(mtimeSeconds, 12));
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, b) => sum + b, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
};

// POSIX ustar, regular files only; `tar -xf` creates the parent directories.
export const buildTar = (entries: TTarEntry[], mtimeSeconds = 0): Uint8Array => {
  const size = entries.reduce(
    (n, e) => n + BLOCK + Math.ceil(e.bytes.length / BLOCK) * BLOCK,
    2 * BLOCK
  );
  const out = new Uint8Array(size);
  let offset = 0;
  entries.forEach((entry) => {
    out.set(tarHeader(entry.path, entry.bytes.length, mtimeSeconds), offset);
    offset += BLOCK;
    out.set(entry.bytes, offset);
    offset += Math.ceil(entry.bytes.length / BLOCK) * BLOCK;
  });
  return out;
};

const storedPath = (series: TWebAppReplaySeries, objectIndex: number) =>
  `objects/${series}/${String(objectIndex).padStart(8, "0")}.stored`;

export const EVIDENCE_README = [
  "Infisical Web App session evidence bundle (CONTRACTS.md 6.11).",
  "",
  "Contents: replay.json (the playback API response) and the stored, encrypted objects listed in it.",
  "session-key.b64 is not included: the viewer has no access to the session key. Add it before running",
  "the offline verifier:",
  "",
  "  webapp-verify --bundle <this directory> --fingerprint SHA256:<recording key fingerprint>",
  ""
].join("\n");

export const evidenceBundleName = (sessionId: string) => `session-${sessionId}-evidence`;

export const buildEvidenceBundle = async (
  source: TWebAppReplaySource,
  replay: TWebAppReplay,
  onProgress?: (done: number, total: number) => void
): Promise<Uint8Array> => {
  const refs: { series: TWebAppReplaySeries; objectIndex: number }[] = [
    ...replay.events.chunks.map((c) => ({ series: "E" as const, objectIndex: c.objectIndex })),
    ...replay.video.objects.map((o) => ({ series: "V" as const, objectIndex: o.objectIndex }))
  ];
  const entries: TTarEntry[] = new Array(refs.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < refs.length) {
      const i = next;
      next += 1;
      const { series, objectIndex } = refs[i];
      // eslint-disable-next-line no-await-in-loop
      const bytes = await source.getStoredObject(series, objectIndex);
      entries[i] = { path: storedPath(series, objectIndex), bytes };
      done += 1;
      onProgress?.(done, refs.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WEB_APP_REPLAY_FETCH_CONCURRENCY, refs.length) }, worker)
  );

  const root = evidenceBundleName(replay.sessionId);
  return buildTar(
    [
      { path: "replay.json", bytes: textEncoder.encode(JSON.stringify(replay, null, 2)) },
      { path: "README.txt", bytes: textEncoder.encode(EVIDENCE_README) },
      ...entries
    ].map((e) => ({ ...e, path: `${root}/${e.path}` })),
    Math.floor(Date.now() / 1000)
  );
};
