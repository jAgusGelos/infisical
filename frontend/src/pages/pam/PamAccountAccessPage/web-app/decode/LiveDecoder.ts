import type { TVideoConfig } from "@app/lib/pam-web-app/contract";

import type { TLiveChunk, TLiveDecoderPort } from "../session/types";

export const MAX_DECODE_QUEUE = 8;

export const MAX_CONSECUTIVE_DECODER_ERRORS = 3;

type TDecoderLike = Pick<
  VideoDecoder,
  "configure" | "decode" | "reset" | "close" | "decodeQueueSize" | "state"
>;

export type TDecoderFactory = {
  createDecoder: (init: VideoDecoderInit) => TDecoderLike;
  createChunk: (init: EncodedVideoChunkInit) => EncodedVideoChunk;
};

const browserDecoderFactory: TDecoderFactory = {
  createDecoder: (init) => new VideoDecoder(init),
  createChunk: (init) => new EncodedVideoChunk(init)
};

type Options = {
  onFrame: (frame: VideoFrame) => void;
  onNeedKeyframe: () => void;
  // Called once when the decoder keeps failing without producing a frame, so the codec is unusable here.
  onFatalError: (codec: string) => void;
  factory?: TDecoderFactory;
};

const toDecoderConfig = (config: TVideoConfig): VideoDecoderConfig => ({
  // Used verbatim: the contract forbids hardcoding a codec string. H.264 is Annex B, so no `description`.
  codec: config.codec,
  codedWidth: config.width,
  codedHeight: config.height,
  optimizeForLatency: true
});

export class LiveDecoder implements TLiveDecoderPort {
  private decoder: TDecoderLike | null = null;

  private config: TVideoConfig | null = null;

  private waitingForKeyframe = true;

  private closed = false;

  private consecutiveErrors = 0;

  private readonly factory: TDecoderFactory;

  constructor(private readonly options: Options) {
    this.factory = options.factory ?? browserDecoderFactory;
  }

  get decodeQueueSize() {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  configure(config: TVideoConfig) {
    if (this.closed) return;
    this.config = config;
    this.ensureDecoder().configure(toDecoderConfig(config));
    this.waitingForKeyframe = true;
  }

  decode(chunk: TLiveChunk): boolean {
    if (this.closed || !this.config || !this.decoder) return false;
    if (this.waitingForKeyframe && !chunk.keyframe) return false;
    if (!chunk.keyframe && this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      this.waitingForKeyframe = true;
      this.options.onNeedKeyframe();
      return false;
    }
    try {
      this.decoder.decode(
        this.factory.createChunk({
          type: chunk.keyframe ? "key" : "delta",
          timestamp: Number(chunk.timestampUs),
          data: chunk.data
        })
      );
    } catch {
      this.recover();
      return false;
    }
    if (chunk.keyframe) this.waitingForKeyframe = false;
    return true;
  }

  close() {
    this.closed = true;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }

  private ensureDecoder() {
    if (!this.decoder || this.decoder.state === "closed") {
      this.decoder = this.factory.createDecoder({
        output: (frame) => {
          if (this.closed) {
            frame.close();
            return;
          }
          this.consecutiveErrors = 0;
          this.options.onFrame(frame);
        },
        error: () => this.recover()
      });
    }
    return this.decoder;
  }

  // A WebCodecs error closes the decoder, so recovery builds a new one from the last config.
  private recover() {
    if (this.closed) return;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
    this.consecutiveErrors += 1;
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_DECODER_ERRORS) {
      this.closed = true;
      this.options.onFatalError(this.config?.codec ?? "");
      return;
    }
    this.waitingForKeyframe = true;
    if (this.config) this.ensureDecoder().configure(toDecoderConfig(this.config));
    this.options.onNeedKeyframe();
  }
}
