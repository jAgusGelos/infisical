import { EventEmitter } from "node:events";
import net from "node:net";

import type WebSocket from "ws";

import { PamAccountType } from "@app/ee/services/pam/pam-enums";
import { encodeFrame, FrameType } from "@app/ee/services/pam-web-app/contract";

import { SESSION_HANDLERS } from "../pam-session-handlers";
import { TSessionContext } from "../pam-web-access-types";
import { handleWebAppSession } from "./pam-web-app-session-handler";

vi.mock("@app/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;

  readyState = 1;

  bufferedAmount = 0;

  sent: { data: unknown; binary: boolean }[] = [];

  closes: (number | undefined)[] = [];

  send(data: unknown, options: { binary: boolean }, cb?: (err?: Error) => void) {
    this.sent.push({ data, binary: options.binary });
    cb?.();
  }

  close(code?: number) {
    this.closes.push(code);
    this.readyState = 3;
  }
}

const frame = (type: number, seq: number) =>
  Buffer.from(encodeFrame({ type, flags: 0, seq, timestampUs: BigInt(0), payload: new Uint8Array([seq]) }));

const startServer = async () => {
  const received: Buffer[] = [];
  const connections: net.Socket[] = [];
  const server = net.createServer((conn) => {
    connections.push(conn);
    conn.on("data", (chunk: Buffer) => received.push(chunk));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    received,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        connections.forEach((c) => c.destroy());
        server.close(() => resolve());
      })
  };
};

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  expect(predicate()).toBe(true);
};

const buildContext = (socket: FakeSocket, relayPort: number, overrides: Partial<TSessionContext> = {}) => {
  const onCleanup = vi.fn();
  const releaseEarlyBuffer = vi.fn();
  const ctx: TSessionContext = {
    socket: socket as unknown as WebSocket,
    relayPort,
    resourceName: "app",
    sessionId: "session-1",
    sendMessage: vi.fn(),
    sendSessionEnd: vi.fn(),
    isNearSessionExpiry: () => false,
    onCleanup,
    earlyMessages: [],
    releaseEarlyBuffer,
    ...overrides
  };
  return { ctx, onCleanup, releaseEarlyBuffer };
};

describe("web-app session handler", () => {
  test("is registered for web-app with the web-app gateway account type", () => {
    const entry = SESSION_HANDLERS[PamAccountType.WebApp];
    expect(entry).toBeDefined();
    expect(entry?.gatewayAccountType).toBe(PamAccountType.WebApp);
    expect(entry?.handler).toBe(handleWebAppSession);
  });

  test("leaves the RDP registrations unchanged", () => {
    expect(SESSION_HANDLERS[PamAccountType.Windows]?.gatewayAccountType).toBe(PamAccountType.Windows);
    expect(SESSION_HANDLERS[PamAccountType.WindowsAd]?.gatewayAccountType).toBe(PamAccountType.Windows);
  });

  test("connects to the relay, replays early messages first, then relays live frames both ways", async () => {
    const server = await startServer();
    try {
      const socket = new FakeSocket();
      const early = frame(FrameType.Hello, 0);
      const { ctx, releaseEarlyBuffer } = buildContext(socket, server.port, {
        earlyMessages: [{ data: early, isBinary: true }]
      });

      const result = await handleWebAppSession(ctx);
      expect(releaseEarlyBuffer).toHaveBeenCalled();

      const live = frame(FrameType.Input, 1);
      socket.emit("message", live, true);
      await waitFor(() => Buffer.concat(server.received).length === early.length + live.length);
      expect(Buffer.concat(server.received).equals(Buffer.concat([early, live]))).toBe(true);

      const down = frame(FrameType.VideoChunk, 2);
      await waitFor(() => server.connections.length === 1);
      server.connections[0].write(down);
      await waitFor(() => socket.sent.length === 1);
      expect(socket.sent[0].binary).toBe(true);
      expect(Buffer.from(socket.sent[0].data as Uint8Array).equals(down)).toBe(true);

      await result.cleanup();
    } finally {
      await server.close();
    }
  });

  test("a text early message is a protocol error, closing with 1008", async () => {
    const server = await startServer();
    try {
      const socket = new FakeSocket();
      const { ctx, onCleanup } = buildContext(socket, server.port, {
        earlyMessages: [{ data: Buffer.from("{}"), isBinary: false }]
      });
      await handleWebAppSession(ctx);
      expect(socket.closes).toEqual([1008]);
      expect(socket.sent).toHaveLength(1);
      expect(onCleanup).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  test("rejects when the relay port refuses the connection", async () => {
    const server = await startServer();
    const { port } = server;
    await server.close();
    const socket = new FakeSocket();
    const { ctx, onCleanup } = buildContext(socket, port);
    await expect(handleWebAppSession(ctx)).rejects.toThrow();
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(0);
  });
});
