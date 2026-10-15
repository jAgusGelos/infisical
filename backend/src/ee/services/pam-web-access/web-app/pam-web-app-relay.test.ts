/* eslint-disable max-classes-per-file */
import { EventEmitter } from "node:events";

import {
  decodeFrame,
  decodeJsonPayload,
  encodeFrame,
  FLAG_ORIGIN_BACKEND,
  FrameType,
  MAX_DOWNSTREAM_PAYLOAD,
  MAX_UPSTREAM_PAYLOAD,
  TControlDown
} from "@app/ee/services/pam-web-app/contract";

import {
  createWebAppRelay,
  DOWNSTREAM_CHECK_INTERVAL_MS,
  DOWNSTREAM_HIGH_WATER_MARK,
  DOWNSTREAM_STALL_THRESHOLD,
  DOWNSTREAM_STALL_TIMEOUT_MS,
  TRelayWebSocket,
  TWsRawData,
  UPSTREAM_DRAIN_TIMEOUT_MS,
  validateUpstreamMessage,
  WebAppRelayCloseReason
} from "./pam-web-app-relay";

const { loggerWarn, loggerInfo } = vi.hoisted(() => ({ loggerWarn: vi.fn(), loggerInfo: vi.fn() }));
vi.mock("@app/lib/logger", () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: vi.fn(), debug: vi.fn() }
}));

class FakeWs {
  bufferedAmount = 0;

  open = true;

  sent: Uint8Array[] = [];

  closes: number[] = [];

  sendError: Error | undefined;

  private messageListener: ((data: TWsRawData, isBinary: boolean) => void) | null = null;

  private closeListener: (() => void) | null = null;

  readonly port: TRelayWebSocket;

  constructor() {
    const getBufferedAmount = () => this.bufferedAmount;
    this.port = {
      get bufferedAmount() {
        return getBufferedAmount();
      },
      isOpen: () => this.open,
      send: (data, cb) => {
        this.sent.push(data);
        cb(this.sendError);
      },
      close: (code) => {
        this.closes.push(code);
        this.open = false;
      },
      onMessage: (listener) => {
        this.messageListener = listener;
      },
      onClose: (listener) => {
        this.closeListener = listener;
      }
    };
  }

  message(data: TWsRawData, isBinary = true) {
    this.messageListener?.(data, isBinary);
  }

  viewerClosed() {
    this.open = false;
    this.closeListener?.();
  }
}

class FakeTunnel extends EventEmitter {
  written: Uint8Array[] = [];

  acceptWrites = true;

  paused = false;

  destroyed = 0;

  write(data: Uint8Array) {
    this.written.push(data);
    return this.acceptWrites;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  destroy() {
    this.destroyed += 1;
  }
}

class FakeRawSocket {
  paused = false;

  pauses = 0;

  pause() {
    this.paused = true;
    this.pauses += 1;
  }

  resume() {
    this.paused = false;
  }
}

const upstreamFrame = (type: number = FrameType.Input, payload: Uint8Array = new Uint8Array([1, 2, 3]), seq = 7) =>
  Buffer.from(encodeFrame({ type, flags: 0, seq, timestampUs: BigInt(123), payload }));

const downstreamFrame = (type: number, payload: Uint8Array, seq: number, flags = 0) =>
  Buffer.from(encodeFrame({ type, flags, seq, timestampUs: BigInt(seq * 1000), payload }));

const decodeControl = (bytes: Uint8Array) => {
  const frame = decodeFrame(bytes, MAX_DOWNSTREAM_PAYLOAD);
  return { frame, control: decodeJsonPayload<TControlDown>(frame.payload) };
};

const setup = (opts: { earlyMessages?: { data: Buffer; isBinary: boolean }[]; withRawSocket?: boolean } = {}) => {
  const ws = new FakeWs();
  const tunnel = new FakeTunnel();
  const rawSocket = new FakeRawSocket();
  const onTerminate = vi.fn();
  const relay = createWebAppRelay({
    sessionId: "session-1",
    ws: ws.port,
    rawSocket: opts.withRawSocket === false ? undefined : rawSocket,
    tunnel,
    earlyMessages: opts.earlyMessages,
    onTerminate
  });
  return { ws, tunnel, rawSocket, onTerminate, relay };
};

const expectProtocolError = (ctx: ReturnType<typeof setup>) => {
  expect(ctx.tunnel.written).toHaveLength(0);
  expect(ctx.ws.sent).toHaveLength(1);
  const { frame, control } = decodeControl(ctx.ws.sent[0]);
  expect(frame.type).toBe(FrameType.Control);
  expect(frame.flags).toBe(FLAG_ORIGIN_BACKEND);
  expect(frame.seq).toBe(0);
  expect(control).toMatchObject({ kind: "error", code: "protocol_error", fatal: true });
  expect(ctx.ws.closes).toEqual([1008]);
  expect(ctx.onTerminate).toHaveBeenCalledWith(WebAppRelayCloseReason.ProtocolError);
  expect(ctx.tunnel.destroyed).toBe(1);
};

describe("web-app relay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loggerWarn.mockClear();
    loggerInfo.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("upstream validation", () => {
    test("forwards a valid frame unchanged", () => {
      const ctx = setup();
      const frame = upstreamFrame();
      ctx.ws.message(frame);
      expect(ctx.tunnel.written).toHaveLength(1);
      expect(Buffer.from(ctx.tunnel.written[0]).equals(frame)).toBe(true);
      expect(ctx.ws.sent).toHaveLength(0);
    });

    test("accepts every type in 0x20..0x3F and a payload of exactly 61440 bytes", () => {
      const ctx = setup();
      ctx.ws.message(upstreamFrame(0x20));
      ctx.ws.message(upstreamFrame(0x3f));
      ctx.ws.message(upstreamFrame(FrameType.Input, new Uint8Array(MAX_UPSTREAM_PAYLOAD)));
      expect(ctx.tunnel.written).toHaveLength(3);
      expect(ctx.ws.closes).toEqual([]);
    });

    test("forwards a fragmented ws message (Buffer[]) as one frame", () => {
      const ctx = setup();
      const frame = upstreamFrame();
      ctx.ws.message([frame.subarray(0, 5), frame.subarray(5)]);
      expect(Buffer.from(ctx.tunnel.written[0]).equals(frame)).toBe(true);
    });

    test("rejects a text message", () => {
      const ctx = setup();
      ctx.ws.message(Buffer.from('{"type":"input"}'), false);
      expectProtocolError(ctx);
    });

    test("rejects a binary text-looking message shorter than the header", () => {
      const ctx = setup();
      ctx.ws.message(Buffer.from([1, 0x21, 0]));
      expectProtocolError(ctx);
    });

    test("rejects version != 1", () => {
      const ctx = setup();
      const frame = upstreamFrame();
      frame[0] = 2;
      ctx.ws.message(frame);
      expectProtocolError(ctx);
    });

    test("rejects a header length that does not match the message size", () => {
      const ctx = setup();
      const frame = upstreamFrame();
      ctx.ws.message(Buffer.concat([frame, Buffer.from([0])]));
      expectProtocolError(ctx);
    });

    test("rejects a payload over 61440 bytes", () => {
      const ctx = setup();
      ctx.ws.message(upstreamFrame(FrameType.Input, new Uint8Array(MAX_UPSTREAM_PAYLOAD + 1)));
      expectProtocolError(ctx);
    });

    test.each([FrameType.VideoChunk, FrameType.Control, 0x1f, 0x40, FrameType.AgentHello, FrameType.InputInject])(
      "rejects type %i outside 0x20..0x3F",
      (type) => {
        const ctx = setup();
        ctx.ws.message(upstreamFrame(type));
        expectProtocolError(ctx);
      }
    );

    test("ignores messages after a protocol error", () => {
      const ctx = setup();
      ctx.ws.message(Buffer.from("x"), false);
      ctx.ws.message(upstreamFrame());
      expect(ctx.tunnel.written).toHaveLength(0);
      expect(ctx.onTerminate).toHaveBeenCalledTimes(1);
    });

    test("logs the reason without payload bytes", () => {
      const ctx = setup();
      ctx.ws.message(Buffer.from("secret-typed-text"), false);
      expect(ctx.ws.closes).toEqual([1008]);
      const logged = JSON.stringify(loggerWarn.mock.calls);
      expect(logged).toContain("protocol_error");
      expect(logged).not.toContain("secret-typed-text");
    });

    test("validateUpstreamMessage returns null only for valid frames", () => {
      expect(validateUpstreamMessage(upstreamFrame(), true)).toBeNull();
      expect(validateUpstreamMessage(upstreamFrame(), false)).not.toBeNull();
    });
  });

  describe("early buffered messages", () => {
    test("go through the same validation and keep their order", () => {
      const first = upstreamFrame(FrameType.Hello, new Uint8Array([9]), 0);
      const second = upstreamFrame(FrameType.Input, new Uint8Array([8]), 1);
      const ctx = setup({ earlyMessages: [{ data: first, isBinary: true }] });
      ctx.ws.message(second);
      expect(ctx.tunnel.written.map((b) => Buffer.from(b))).toEqual([first, second]);
    });

    test("an invalid early message is a protocol error", () => {
      const ctx = setup({ earlyMessages: [{ data: Buffer.from("hello"), isBinary: false }] });
      expectProtocolError(ctx);
    });
  });

  describe("upstream backpressure", () => {
    test("pauses the raw socket when the tunnel write returns false and resumes on drain", () => {
      const ctx = setup();
      ctx.tunnel.acceptWrites = false;
      ctx.ws.message(upstreamFrame());
      expect(ctx.rawSocket.paused).toBe(true);
      ctx.ws.message(upstreamFrame());
      expect(ctx.rawSocket.pauses).toBe(1);

      ctx.tunnel.acceptWrites = true;
      ctx.tunnel.emit("drain");
      expect(ctx.rawSocket.paused).toBe(false);

      vi.advanceTimersByTime(UPSTREAM_DRAIN_TIMEOUT_MS * 2);
      expect(ctx.ws.closes).toEqual([]);
      expect(ctx.onTerminate).not.toHaveBeenCalled();
    });

    test("sends CONTROL error tunnel_failed and closes after 10 s undrained", () => {
      const ctx = setup();
      ctx.tunnel.acceptWrites = false;
      ctx.ws.message(upstreamFrame());
      vi.advanceTimersByTime(UPSTREAM_DRAIN_TIMEOUT_MS - 1);
      expect(ctx.ws.closes).toEqual([]);
      vi.advanceTimersByTime(1);

      expect(ctx.ws.sent).toHaveLength(1);
      const { frame, control } = decodeControl(ctx.ws.sent[0]);
      expect(frame.flags).toBe(FLAG_ORIGIN_BACKEND);
      expect(frame.seq).toBe(0);
      expect(control).toMatchObject({ kind: "error", code: "tunnel_failed", fatal: true });
      expect(ctx.ws.closes).toHaveLength(1);
      expect(ctx.onTerminate).toHaveBeenCalledWith(WebAppRelayCloseReason.TunnelFailed);
      expect(ctx.rawSocket.paused).toBe(false);
      expect(JSON.stringify(loggerWarn.mock.calls)).toContain("tunnel_failed");
    });

    test("still enforces the drain timeout when no raw socket is available", () => {
      const ctx = setup({ withRawSocket: false });
      ctx.tunnel.acceptWrites = false;
      ctx.ws.message(upstreamFrame());
      vi.advanceTimersByTime(UPSTREAM_DRAIN_TIMEOUT_MS);
      expect(ctx.onTerminate).toHaveBeenCalledWith(WebAppRelayCloseReason.TunnelFailed);
    });
  });

  describe("downstream splitting", () => {
    test("sends one binary WS message per frame when frames are merged in one TCP chunk", () => {
      const ctx = setup();
      const a = downstreamFrame(FrameType.VideoConfig, new TextEncoder().encode('{"codec":"avc1"}'), 0);
      const b = downstreamFrame(FrameType.VideoChunk, new Uint8Array(1000).fill(7), 1, 1);
      const c = downstreamFrame(FrameType.Control, new TextEncoder().encode('{"kind":"stream_shown"}'), 2);
      ctx.tunnel.emit("data", Buffer.concat([a, b, c]));
      expect(ctx.ws.sent.map((m) => Buffer.from(m))).toEqual([a, b, c]);
    });

    test("reassembles a frame split across TCP chunks, including inside the header", () => {
      const ctx = setup();
      const a = downstreamFrame(FrameType.VideoChunk, new Uint8Array(5000).fill(3), 4);
      const b = downstreamFrame(FrameType.VideoChunk, new Uint8Array(10).fill(4), 5);
      const stream = Buffer.concat([a, b]);
      ctx.tunnel.emit("data", stream.subarray(0, 10));
      expect(ctx.ws.sent).toHaveLength(0);
      ctx.tunnel.emit("data", stream.subarray(10, 3000));
      expect(ctx.ws.sent).toHaveLength(0);
      ctx.tunnel.emit("data", stream.subarray(3000, a.length + 5));
      expect(ctx.ws.sent.map((m) => Buffer.from(m))).toEqual([a]);
      ctx.tunnel.emit("data", stream.subarray(a.length + 5));
      expect(ctx.ws.sent.map((m) => Buffer.from(m))).toEqual([a, b]);
    });

    test("closes on a downstream decode error and never logs payload bytes", () => {
      const ctx = setup();
      const bad = downstreamFrame(FrameType.VideoChunk, new TextEncoder().encode("frame-bytes"), 0);
      bad[0] = 9;
      ctx.tunnel.emit("data", bad);
      expect(ctx.onTerminate).toHaveBeenCalledWith(WebAppRelayCloseReason.DownstreamDecodeError);
      expect(ctx.ws.closes).toEqual([1011]);
      const { control } = decodeControl(ctx.ws.sent[0]);
      expect(control).toMatchObject({ kind: "error", fatal: true });
      expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain("frame-bytes");
    });

    test("a downstream frame over 4 MiB is a decode error", () => {
      const ctx = setup();
      const header = Buffer.from(
        encodeFrame({
          type: FrameType.VideoChunk,
          flags: 0,
          seq: 0,
          timestampUs: BigInt(0),
          payload: new Uint8Array(0)
        })
      );
      header.writeUInt32BE(MAX_DOWNSTREAM_PAYLOAD + 1, 16);
      ctx.tunnel.emit("data", header);
      expect(ctx.onTerminate).toHaveBeenCalledWith(WebAppRelayCloseReason.DownstreamDecodeError);
    });
  });

  describe("downstream backpressure", () => {
    test("pauses the tunnel above 1 MiB buffered and resumes under it", () => {
      const ctx = setup();
      ctx.ws.bufferedAmount = DOWNSTREAM_HIGH_WATER_MARK + 1;
      ctx.tunnel.emit("data", downstreamFrame(FrameType.VideoChunk, new Uint8Array(10), 0));
      expect(ctx.tunnel.paused).toBe(true);

      vi.advanceTimersByTime(DOWNSTREAM_CHECK_INTERVAL_MS * 3);
      expect(ctx.tunnel.paused).toBe(true);

      ctx.ws.bufferedAmount = DOWNSTREAM_HIGH_WATER_MARK;
      vi.advanceTimersByTime(DOWNSTREAM_CHECK_INTERVAL_MS);
      expect(ctx.tunnel.paused).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    test("does not pause at or below 1 MiB", () => {
      const ctx = setup();
      ctx.ws.bufferedAmount = DOWNSTREAM_HIGH_WATER_MARK;
      ctx.tunnel.emit("data", downstreamFrame(FrameType.VideoChunk, new Uint8Array(10), 0));
      expect(ctx.tunnel.paused).toBe(false);
    });

    test("closes the WS with 1011 after 10 s above 8 MiB", () => {
      const ctx = setup();
      ctx.ws.bufferedAmount = DOWNSTREAM_STALL_THRESHOLD + 1;
      ctx.tunnel.emit("data", downstreamFrame(FrameType.VideoChunk, new Uint8Array(10), 0));
      vi.advanceTimersByTime(DOWNSTREAM_STALL_TIMEOUT_MS - 1);
      expect(ctx.ws.closes).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(ctx.ws.closes).toEqual([1011]);
      expect(ctx.onTerminate).toHaveBeenCalledWith(WebAppRelayCloseReason.DownstreamStalled);
      expect(JSON.stringify(loggerWarn.mock.calls)).toContain("downstream_stalled");
      expect(vi.getTimerCount()).toBe(0);
    });

    test("does not close when the buffer drops under 8 MiB before 10 s", () => {
      const ctx = setup();
      ctx.ws.bufferedAmount = DOWNSTREAM_STALL_THRESHOLD + 1;
      ctx.tunnel.emit("data", downstreamFrame(FrameType.VideoChunk, new Uint8Array(10), 0));
      vi.advanceTimersByTime(DOWNSTREAM_STALL_TIMEOUT_MS - 1000);
      ctx.ws.bufferedAmount = DOWNSTREAM_HIGH_WATER_MARK + 1;
      vi.advanceTimersByTime(DOWNSTREAM_CHECK_INTERVAL_MS);
      vi.advanceTimersByTime(DOWNSTREAM_STALL_TIMEOUT_MS);
      expect(ctx.ws.closes).toEqual([]);
      expect(ctx.tunnel.paused).toBe(true);
    });

    test("a failed WS send tears down", () => {
      const ctx = setup();
      ctx.ws.sendError = new Error("socket gone");
      ctx.tunnel.emit("data", downstreamFrame(FrameType.VideoChunk, new Uint8Array(10), 0));
      expect(ctx.onTerminate).toHaveBeenCalledWith(WebAppRelayCloseReason.SendFailed);
    });
  });

  describe("teardown", () => {
    test("is idempotent and calls onTerminate once", () => {
      const ctx = setup();
      ctx.tunnel.emit("close");
      ctx.tunnel.emit("close");
      ctx.ws.viewerClosed();
      ctx.relay.teardown();
      expect(ctx.onTerminate).toHaveBeenCalledTimes(1);
      expect(ctx.onTerminate).toHaveBeenCalledWith(WebAppRelayCloseReason.TunnelClosed);
      expect(ctx.tunnel.destroyed).toBe(1);
      expect(ctx.ws.closes).toEqual([1000]);
      expect(ctx.relay.isClosed()).toBe(true);
    });

    test("viewer close destroys the tunnel", () => {
      const ctx = setup();
      ctx.ws.viewerClosed();
      expect(ctx.tunnel.destroyed).toBe(1);
      expect(ctx.onTerminate).toHaveBeenCalledWith(WebAppRelayCloseReason.ViewerClosed);
    });

    test("tunnel error sends tunnel_failed and closes", () => {
      const ctx = setup();
      ctx.tunnel.emit("error", new Error("reset"));
      const { control } = decodeControl(ctx.ws.sent[0]);
      expect(control).toMatchObject({ kind: "error", code: "tunnel_failed", fatal: true });
      expect(ctx.ws.closes).toEqual([1011]);
      expect(ctx.onTerminate).toHaveBeenCalledTimes(1);
    });

    test("an owner-requested teardown does not call back and clears every timer", () => {
      const ctx = setup();
      ctx.tunnel.acceptWrites = false;
      ctx.ws.message(upstreamFrame());
      ctx.ws.bufferedAmount = DOWNSTREAM_STALL_THRESHOLD + 1;
      ctx.tunnel.emit("data", downstreamFrame(FrameType.VideoChunk, new Uint8Array(10), 0));
      ctx.relay.teardown();
      expect(ctx.onTerminate).not.toHaveBeenCalled();
      expect(ctx.rawSocket.paused).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      ctx.tunnel.emit("data", downstreamFrame(FrameType.VideoChunk, new Uint8Array(10), 1));
      expect(ctx.ws.sent).toHaveLength(1);
    });
  });
});
