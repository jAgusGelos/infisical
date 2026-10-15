import { describe, expect, it, vi } from "vitest";

import type { TVideoConfig } from "@app/lib/pam-web-app/contract";

import { LiveDecoder, MAX_DECODE_QUEUE, type TDecoderFactory } from "./LiveDecoder";

const config: TVideoConfig = {
  codec: "avc1.64001F",
  format: "annexb",
  width: 1280,
  height: 720,
  framerate: 30,
  epoch: 1
};

const createFactory = () => {
  const instances: {
    init: VideoDecoderInit;
    configs: VideoDecoderConfig[];
    decoded: EncodedVideoChunkInit[];
    state: CodecState;
    decodeQueueSize: number;
  }[] = [];
  const factory: TDecoderFactory = {
    createDecoder: (init) => {
      const instance = {
        init,
        configs: [] as VideoDecoderConfig[],
        decoded: [] as EncodedVideoChunkInit[],
        state: "unconfigured" as CodecState,
        decodeQueueSize: 0
      };
      instances.push(instance);
      return {
        get state() {
          return instance.state;
        },
        get decodeQueueSize() {
          return instance.decodeQueueSize;
        },
        configure: (c: VideoDecoderConfig) => {
          instance.configs.push(c);
          instance.state = "configured";
        },
        decode: (chunk: EncodedVideoChunk) => {
          instance.decoded.push(chunk as unknown as EncodedVideoChunkInit);
        },
        reset: () => {},
        close: () => {
          instance.state = "closed";
        }
      } as unknown as VideoDecoder;
    },
    createChunk: (init) => init as unknown as EncodedVideoChunk
  };
  return { factory, instances };
};

const chunk = (seq: number, keyframe: boolean) => ({
  seq,
  keyframe,
  timestampUs: BigInt(seq * 33333),
  data: new Uint8Array([seq])
});

describe("LiveDecoder", () => {
  it("configures with the exact codec string and drops chunks until a keyframe", () => {
    const { factory, instances } = createFactory();
    const decoder = new LiveDecoder({ onFrame: vi.fn(), onNeedKeyframe: vi.fn(), factory });

    expect(decoder.decode(chunk(0, true))).toBe(false);
    decoder.configure(config);
    expect(instances[0].configs[0]).toEqual({
      codec: "avc1.64001F",
      codedWidth: 1280,
      codedHeight: 720,
      optimizeForLatency: true
    });
    expect(decoder.decode(chunk(1, false))).toBe(false);
    expect(decoder.decode(chunk(2, true))).toBe(true);
    expect(decoder.decode(chunk(3, false))).toBe(true);
    expect(instances[0].decoded.map((c) => c.type)).toEqual(["key", "delta"]);
    expect(instances[0].decoded[1].timestamp).toBe(3 * 33333);
  });

  it("waits for a keyframe again after a reconfigure (epoch change)", () => {
    const { factory, instances } = createFactory();
    const decoder = new LiveDecoder({ onFrame: vi.fn(), onNeedKeyframe: vi.fn(), factory });
    decoder.configure(config);
    decoder.decode(chunk(0, true));
    decoder.configure({ ...config, epoch: 2, width: 1920, height: 1080 });
    expect(instances[0].configs[1].codedWidth).toBe(1920);
    expect(decoder.decode(chunk(1, false))).toBe(false);
    expect(decoder.decode(chunk(2, true))).toBe(true);
  });

  it("drops deltas and asks for a keyframe when the decode queue overflows", () => {
    const { factory, instances } = createFactory();
    const onNeedKeyframe = vi.fn();
    const decoder = new LiveDecoder({ onFrame: vi.fn(), onNeedKeyframe, factory });
    decoder.configure(config);
    decoder.decode(chunk(0, true));
    instances[0].decodeQueueSize = MAX_DECODE_QUEUE + 1;
    expect(decoder.decode(chunk(1, false))).toBe(false);
    expect(onNeedKeyframe).toHaveBeenCalledTimes(1);
    instances[0].decodeQueueSize = 0;
    expect(decoder.decode(chunk(2, false))).toBe(false);
    expect(decoder.decode(chunk(3, true))).toBe(true);
  });

  it("recovers from a decoder error with a new configured decoder and a keyframe request", () => {
    const { factory, instances } = createFactory();
    const onNeedKeyframe = vi.fn();
    const decoder = new LiveDecoder({ onFrame: vi.fn(), onNeedKeyframe, factory });
    decoder.configure(config);
    decoder.decode(chunk(0, true));
    instances[0].init.error(new DOMException("decode failed"));
    expect(instances[0].state).toBe("closed");
    expect(instances).toHaveLength(2);
    expect(instances[1].configs[0].codec).toBe(config.codec);
    expect(onNeedKeyframe).toHaveBeenCalledTimes(1);
    expect(decoder.decode(chunk(1, false))).toBe(false);
    expect(decoder.decode(chunk(2, true))).toBe(true);
  });

  it("forwards frames to the painter and closes frames after close()", () => {
    const { factory, instances } = createFactory();
    const onFrame = vi.fn();
    const decoder = new LiveDecoder({ onFrame, onNeedKeyframe: vi.fn(), factory });
    decoder.configure(config);
    const frame = { close: vi.fn() } as unknown as VideoFrame;
    instances[0].init.output(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    decoder.close();
    const late = { close: vi.fn() } as unknown as VideoFrame;
    instances[0].init.output(late);
    expect(late.close).toHaveBeenCalled();
    expect(decoder.decode(chunk(5, true))).toBe(false);
  });
});
