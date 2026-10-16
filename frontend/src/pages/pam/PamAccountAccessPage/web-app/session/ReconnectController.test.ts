import { describe, expect, it, vi } from "vitest";

import { FrameType } from "@app/lib/pam-web-app/contract";

import { RECONNECT_WINDOW_MS, ReconnectController, reconnectDelay } from "./ReconnectController";
import {
  controlFrame,
  createFakeClock,
  createFakeDecoder,
  createFakeSocket,
  sessionReady
} from "./testUtils";
import { WebAppSessionClient } from "./WebAppSessionClient";

const hello = {
  protocol: 1 as const,
  client: "infisical-web/1.0",
  decoders: { vp9: false, h264: true },
  viewport: { width: 1280, height: 720, devicePixelRatio: 1 }
};

describe("ReconnectController", () => {
  it("backs off 1, 2, 4, 8, 8 s", () => {
    expect([0, 1, 2, 3, 4, 9].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("reconnects after an unexpected close with a new link that starts with HELLO at seq 0", () => {
    const clock = createFakeClock();
    const sockets: ReturnType<typeof createFakeSocket>[] = [];
    const clients: WebAppSessionClient[] = [];
    const statuses: string[] = [];
    let controller: ReconnectController;

    const openLink = () => {
      const socket = createFakeSocket();
      const client = new WebAppSessionClient({
        socket,
        decoder: createFakeDecoder(),
        clock,
        hello,
        onStateChange: (state) => {
          if (state.phase === "disconnected") controller.onDisconnected();
          if (state.phase === "live") controller.onLive();
        }
      });
      sockets.push(socket);
      clients.push(client);
      client.start();
    };
    controller = new ReconnectController({
      clock,
      connect: openLink,
      onStatusChange: (status) => statuses.push(status)
    });

    openLink();
    clients[0].handleMessage(controlFrame(sessionReady()));
    clients[0].sendInput([{ t: "move", x: 1, y: 1, buttons: 0, ts: 0 }]);
    clients[0].handleClose(1006);
    expect(statuses).toEqual(["waiting"]);

    clock.advance(999);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent[0]).toMatchObject({ type: FrameType.Hello, seq: 0 });

    clients[1].handleMessage(controlFrame(sessionReady()));
    expect(statuses).toEqual(["waiting", "idle"]);
  });

  it("gives up once the next attempt would fall outside the grace window", () => {
    const clock = createFakeClock();
    const connect = vi.fn();
    const onStatusChange = vi.fn();
    const controller = new ReconnectController({ clock, connect, onStatusChange });

    controller.onDisconnected();
    let elapsed = 0;
    while (onStatusChange.mock.calls.at(-1)?.[0] === "waiting") {
      const delay = reconnectDelay(connect.mock.calls.length);
      clock.advance(delay);
      elapsed += delay;
      controller.onDisconnected();
    }
    expect(onStatusChange).toHaveBeenLastCalledWith("gave_up");
    expect(elapsed).toBeLessThanOrEqual(RECONNECT_WINDOW_MS);
    expect(connect.mock.calls.length).toBeGreaterThanOrEqual(8);
  });

  it("ignores repeated disconnect notifications while a retry is pending", () => {
    const clock = createFakeClock();
    const connect = vi.fn();
    const controller = new ReconnectController({ clock, connect, onStatusChange: vi.fn() });
    controller.onDisconnected();
    controller.onDisconnected();
    clock.advance(1000);
    expect(connect).toHaveBeenCalledTimes(1);
    controller.stop();
    clock.advance(10_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
