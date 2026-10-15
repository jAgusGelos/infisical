import { describe, expect, it } from "vitest";

import {
  decodeAck,
  encodeJsonPayload,
  FrameType,
  MAX_UPSTREAM_PAYLOAD,
  type TInputBatch,
  type TInputEvent,
  type TViewerHello
} from "@app/lib/pam-web-app/contract";

import { ACK_INTERVAL_MS } from "./AckScheduler";
import { KEYFRAME_REQUEST_INTERVAL_MS } from "./KeyframeRequester";
import {
  chunkFrame,
  controlFrame,
  createFakeClock,
  createFakeDecoder,
  createFakeSocket,
  downstream,
  sentJson,
  sessionReady
} from "./testUtils";
import { END_SESSION_TIMEOUT_MS, WebAppSessionClient } from "./WebAppSessionClient";

const hello: TViewerHello = {
  protocol: 1,
  client: "infisical-web/1.0",
  decoders: { vp9: false, h264: true },
  viewport: { width: 1280, height: 720, devicePixelRatio: 1 }
};

const setup = () => {
  const clock = createFakeClock();
  const socket = createFakeSocket();
  const decoder = createFakeDecoder();
  const client = new WebAppSessionClient({ socket, decoder, clock, hello });
  return { clock, socket, decoder, client };
};

const key: TInputEvent = {
  t: "key",
  action: "down",
  code: "KeyA",
  key: "a",
  mods: 0,
  repeat: false,
  ts: 1
};

const videoConfig = {
  codec: "avc1.42E01F",
  format: "annexb" as const,
  width: 1280,
  height: 720,
  framerate: 30,
  epoch: 1
};

describe("WebAppSessionClient", () => {
  it("sends HELLO as the first upstream frame with seq 0", () => {
    const { client, socket } = setup();
    client.sendInput([key]);
    client.sendControl({ kind: "visibility", hidden: true });
    expect(socket.sent).toHaveLength(0);

    client.start();
    expect(socket.sent[0].type).toBe(FrameType.Hello);
    expect(socket.sent[0].seq).toBe(0);
    expect(sentJson<TViewerHello>(socket.sent[0])).toEqual(hello);
    expect(client.getState().phase).toBe("awaiting_ready");
  });

  it("restarts upstream seq at 0 on a new link and increments per frame", () => {
    const first = setup();
    first.client.start();
    first.client.handleMessage(controlFrame(sessionReady()));
    first.client.sendInput([key]);
    first.client.sendInput([key]);
    expect(first.socket.sent.map((f) => f.seq)).toEqual([0, 1, 2]);

    const second = setup();
    second.client.start();
    expect(second.socket.sent[0].seq).toBe(0);
  });

  it("does not send INPUT before session_ready, while hidden, or while input is disabled", () => {
    const { client, socket } = setup();
    client.start();
    expect(client.sendInput([key])).toBe(false);

    client.handleMessage(controlFrame(sessionReady()));
    client.handleMessage(controlFrame({ kind: "stream_hidden", reason: "login" }));
    expect(client.sendInput([key])).toBe(false);

    client.handleMessage(controlFrame({ kind: "stream_shown" }));
    client.handleMessage(controlFrame({ kind: "input_state", enabled: false }));
    expect(client.sendInput([key])).toBe(false);

    client.handleMessage(controlFrame({ kind: "input_state", enabled: true }));
    expect(client.sendInput([key])).toBe(true);
    const inputs = socket.sent.filter((f) => f.type === FrameType.Input);
    expect(inputs).toHaveLength(1);
    expect(sentJson<TInputBatch>(inputs[0]).events).toEqual([key]);
  });

  it("respects inputEnabled=false in session_ready", () => {
    const { client } = setup();
    client.start();
    client.handleMessage(controlFrame(sessionReady(false)));
    expect(client.sendInput([key])).toBe(false);
  });

  it("splits large input into payloads under the upstream limit", () => {
    const { client, socket } = setup();
    client.start();
    client.handleMessage(controlFrame(sessionReady()));
    const events: TInputEvent[] = Array.from({ length: 2000 }, (_, i) => ({ ...key, ts: i }));
    client.sendInput(events);
    const inputs = socket.sent.filter((f) => f.type === FrameType.Input);
    expect(inputs.length).toBeGreaterThan(1);
    inputs.forEach((f) => expect(f.payload.length).toBeLessThanOrEqual(MAX_UPSTREAM_PAYLOAD));
    expect(inputs.flatMap((f) => sentJson<TInputBatch>(f).events)).toHaveLength(2000);
  });

  it("ACKs immediately after a keyframe and within 100 ms while chunks arrive", () => {
    const { client, socket, clock, decoder } = setup();
    client.start();
    client.handleMessage(downstream(FrameType.VideoConfig, encodeJsonPayload(videoConfig)));
    expect(decoder.configs).toEqual([videoConfig]);

    decoder.queue = 3;
    client.handleMessage(chunkFrame(5, true));
    const acks = () =>
      socket.sent.filter((f) => f.type === FrameType.Ack).map((f) => decodeAck(f.payload));
    expect(acks()).toEqual([{ ackSeq: 5, decodeQueue: 3 }]);

    clock.advance(30);
    client.handleMessage(chunkFrame(6, false));
    clock.advance(30);
    client.handleMessage(chunkFrame(7, false));
    expect(acks()).toHaveLength(1);
    clock.advance(ACK_INTERVAL_MS - 61);
    expect(acks()).toHaveLength(1);
    clock.advance(1);
    expect(acks()).toHaveLength(2);
    expect(acks()[1].ackSeq).toBe(7);
    expect(ACK_INTERVAL_MS).toBeLessThanOrEqual(100);

    clock.advance(500);
    expect(acks()).toHaveLength(2);
  });

  it("acknowledges dropped chunks too", () => {
    const { client, socket, clock, decoder } = setup();
    client.start();
    decoder.accept = false;
    client.handleMessage(chunkFrame(9, false));
    clock.advance(100);
    const ack = socket.sent.find((f) => f.type === FrameType.Ack);
    expect(ack && decodeAck(ack.payload).ackSeq).toBe(9);
  });

  it("treats a text message as a protocol error and closes", () => {
    const { client, socket } = setup();
    client.start();
    client.handleMessage("hello");
    expect(client.getState().phase).toBe("failed");
    expect(client.getState().error?.code).toBe("protocol_error");
    expect(socket.closed).toBe(1000);
  });

  it("treats a malformed frame or an upstream frame type as a protocol error", () => {
    const bad = setup();
    bad.client.start();
    bad.client.handleMessage(new Uint8Array([2, 1, 0]).buffer);
    expect(bad.client.getState().error?.code).toBe("protocol_error");

    const wrongType = setup();
    wrongType.client.start();
    wrongType.client.handleMessage(downstream(FrameType.Input, new Uint8Array(0)));
    expect(wrongType.client.getState().error?.code).toBe("protocol_error");
  });

  it("ignores CLIPBOARD_DOWN", () => {
    const { client } = setup();
    client.start();
    client.handleMessage(downstream(FrameType.ClipboardDown, new Uint8Array([1, 2])));
    expect(client.getState().phase).toBe("awaiting_ready");
  });

  it("goes to ended on session_ending and to failed on a fatal error", () => {
    const ended = setup();
    ended.client.start();
    ended.client.handleMessage(controlFrame(sessionReady()));
    ended.client.handleMessage(controlFrame({ kind: "session_ending", reason: "expired" }));
    expect(ended.client.getState()).toMatchObject({ phase: "ended", endReason: "expired" });
    ended.client.handleClose(1000);
    expect(ended.client.getState().phase).toBe("ended");

    const failed = setup();
    failed.client.start();
    failed.client.handleMessage(
      controlFrame({ kind: "error", code: "tunnel_failed", message: "x", fatal: false })
    );
    expect(failed.client.getState().phase).toBe("awaiting_ready");
    failed.client.handleMessage(
      controlFrame({ kind: "error", code: "runner_unavailable", message: "down", fatal: true })
    );
    expect(failed.client.getState()).toMatchObject({
      phase: "failed",
      error: { code: "runner_unavailable", message: "down" }
    });
  });

  it("marks an unexpected close as disconnected and closes the decoder", () => {
    const { client, decoder } = setup();
    client.start();
    client.handleMessage(controlFrame(sessionReady()));
    client.handleClose(1006);
    expect(client.getState()).toMatchObject({ phase: "disconnected", closeCode: 1006 });
    expect(decoder.closed).toBe(true);
  });

  it("end session sends CONTROL_UP, disables input and closes after the timeout", () => {
    const { client, socket, clock } = setup();
    client.start();
    client.handleMessage(controlFrame(sessionReady()));
    client.endSession();
    const control = socket.sent.find((f) => f.type === FrameType.ControlUp);
    expect(control && sentJson(control)).toEqual({ kind: "end_session" });
    expect(client.getState().phase).toBe("ending");
    expect(client.sendInput([key])).toBe(false);
    clock.advance(END_SESSION_TIMEOUT_MS);
    expect(socket.closed).toBe(1000);
    client.handleClose(1000);
    expect(client.getState()).toMatchObject({ phase: "ended", endReason: "user_end" });
  });

  it("rate-limits KEYFRAME_REQUEST to one per second", () => {
    const { client, socket, clock } = setup();
    client.start();
    expect(client.requestKeyframe()).toBe(true);
    expect(client.requestKeyframe()).toBe(false);
    clock.advance(KEYFRAME_REQUEST_INTERVAL_MS - 1);
    expect(client.requestKeyframe()).toBe(false);
    clock.advance(1);
    expect(client.requestKeyframe()).toBe(true);
    expect(socket.sent.filter((f) => f.type === FrameType.KeyframeRequest)).toHaveLength(2);
  });
});
