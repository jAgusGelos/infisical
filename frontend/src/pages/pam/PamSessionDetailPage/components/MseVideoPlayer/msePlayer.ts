import { TVerifiedVideoObject } from "@app/hooks/api/pam/web-app-replay";

const NEXT_RANGE_EPSILON_S = 0.01;
const RANGE_END_MARGIN_S = 0.1;

export type TSourceBufferLike = Pick<
  SourceBuffer,
  "appendBuffer" | "addEventListener" | "removeEventListener" | "updating"
>;

// Media whose init did not verify is dropped: it cannot be decoded and stays visible as a hole.
export const orderForAppend = (objects: TVerifiedVideoObject[]): TVerifiedVideoObject[] => {
  const sorted = [...objects].sort((a, b) => a.objectIndex - b.objectIndex);
  const inits = new Map(sorted.filter((o) => o.kind === "init").map((o) => [o.objectIndex, o]));
  const out: TVerifiedVideoObject[] = [];
  let currentInit: number | null = null;
  sorted.forEach((obj) => {
    if (obj.kind === "init") return;
    const init = inits.get(obj.initIndex);
    if (!init) return;
    if (currentInit !== obj.initIndex) {
      out.push(init);
      currentInit = obj.initIndex;
    }
    out.push(obj);
  });
  return out;
};

const appendOne = (sb: TSourceBufferLike, bytes: Uint8Array) =>
  new Promise<void>((resolve, reject) => {
    const listeners = { updateend: () => {}, error: () => {} };
    const detach = () => {
      sb.removeEventListener("updateend", listeners.updateend);
      sb.removeEventListener("error", listeners.error);
    };
    listeners.updateend = () => {
      detach();
      resolve();
    };
    listeners.error = () => {
      detach();
      reject(new Error("the browser could not decode a video segment"));
    };
    sb.addEventListener("updateend", listeners.updateend);
    sb.addEventListener("error", listeners.error);
    try {
      sb.appendBuffer(bytes);
    } catch (err) {
      detach();
      reject(err);
    }
  });

// Takes verified objects only: this is the single path from replay data into a SourceBuffer.
export const appendVerifiedObjects = async (
  sb: TSourceBufferLike,
  objects: TVerifiedVideoObject[],
  isCancelled: () => boolean = () => false
) => {
  const ordered = orderForAppend(objects);
  for (let i = 0; i < ordered.length; i += 1) {
    if (isCancelled()) return;
    if (import.meta.env.DEV) {
      console.debug(`[web-app-replay] append V/${ordered[i].objectIndex} (${ordered[i].kind})`);
    }
    // eslint-disable-next-line no-await-in-loop
    await appendOne(sb, ordered[i].bytes);
  }
};

export const nextBufferedStart = (buffered: TimeRanges, time: number) => {
  for (let i = 0; i < buffered.length; i += 1) {
    if (buffered.start(i) > time + NEXT_RANGE_EPSILON_S) return buffered.start(i);
  }
  return null;
};

const isInBufferedRange = (buffered: TimeRanges, time: number) => {
  for (let i = 0; i < buffered.length; i += 1) {
    if (buffered.start(i) <= time && time < buffered.end(i) - RANGE_END_MARGIN_S) return true;
  }
  return false;
};

export const isMseTypeSupported = (mime: string) =>
  typeof window !== "undefined" &&
  typeof window.MediaSource !== "undefined" &&
  window.MediaSource.isTypeSupported(mime);

export type TMsePlayback = { destroy: () => void };

export const startMsePlayback = ({
  video,
  mime,
  objects,
  onReady,
  onError
}: {
  video: HTMLVideoElement;
  mime: string;
  objects: TVerifiedVideoObject[];
  onReady: (originSeconds: number) => void;
  onError: (message: string) => void;
}): TMsePlayback => {
  let cancelled = false;
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);

  const onWaiting = () => {
    // A missing or refused segment leaves a hole in the buffer; playback continues at the next range.
    const next = nextBufferedStart(video.buffered, video.currentTime);
    if (!isInBufferedRange(video.buffered, video.currentTime) && next !== null) {
      // eslint-disable-next-line no-param-reassign
      video.currentTime = next;
    }
  };

  const onSourceOpen = async () => {
    mediaSource.removeEventListener("sourceopen", onSourceOpen);
    try {
      const sb = mediaSource.addSourceBuffer(mime);
      sb.mode = "segments";
      await appendVerifiedObjects(sb, objects, () => cancelled);
      if (cancelled) return;
      if (mediaSource.readyState === "open") mediaSource.endOfStream();
      const origin = video.buffered.length > 0 ? video.buffered.start(0) : 0;
      // eslint-disable-next-line no-param-reassign
      video.currentTime = origin;
      onReady(origin);
    } catch (err) {
      if (!cancelled) onError(err instanceof Error ? err.message : String(err));
    }
  };

  mediaSource.addEventListener("sourceopen", onSourceOpen);
  video.addEventListener("waiting", onWaiting);
  // eslint-disable-next-line no-param-reassign
  video.src = url;

  return {
    destroy: () => {
      cancelled = true;
      video.removeEventListener("waiting", onWaiting);
      mediaSource.removeEventListener("sourceopen", onSourceOpen);
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  };
};
