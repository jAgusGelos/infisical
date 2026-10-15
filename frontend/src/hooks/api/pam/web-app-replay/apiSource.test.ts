import { beforeEach, describe, expect, test, vi } from "vitest";

import { createApiReplaySource } from "./apiSource";
import { ReplayObjectNotFoundError } from "./source";

type TCall = [string, Record<string, unknown> | undefined];

const state: { calls: TCall[]; respond: () => Promise<unknown> } = {
  calls: [],
  respond: async () => ({ data: null })
};

// A plain function instead of vi.fn: the spy reports a rejected mock result as a test failure.
vi.mock("@app/config/request", () => ({
  apiRequest: {
    get: (url: string, config?: Record<string, unknown>) => {
      state.calls.push([url, config]);
      return state.respond();
    }
  }
}));

const SESSION_ID = "8a0c6a4e-1f7b-4e0e-9a43-5d2a6f0b9c11";

describe("web app replay API source", () => {
  beforeEach(() => {
    state.calls = [];
  });

  test("requests the CONTRACTS 6.10 replay path", async () => {
    state.respond = async () => ({ data: { sessionId: SESSION_ID } });
    await createApiReplaySource(SESSION_ID).getReplay();
    expect(state.calls[0][0]).toBe(`/api/v1/pam/sessions/${SESSION_ID}/web-app/replay`);
  });

  test("requests plaintext and stored objects as array buffers", async () => {
    state.respond = async () => ({ data: new Uint8Array([1, 2, 3]).buffer });
    const source = createApiReplaySource(SESSION_ID);

    expect(Array.from(await source.getObject("V", 7))).toEqual([1, 2, 3]);
    expect(state.calls[0][0]).toBe(`/api/v1/pam/sessions/${SESSION_ID}/web-app/objects/V/7`);
    expect(state.calls[0][1]).toMatchObject({ responseType: "arraybuffer", params: undefined });

    await source.getStoredObject("E", 0);
    expect(state.calls[1][0]).toBe(`/api/v1/pam/sessions/${SESSION_ID}/web-app/objects/E/0`);
    expect(state.calls[1][1]).toMatchObject({ params: { form: "stored" } });
  });

  test("maps a 404 to a missing object", async () => {
    state.respond = () =>
      Promise.reject(
        Object.assign(new Error("not found"), { isAxiosError: true, response: { status: 404 } })
      );
    await expect(createApiReplaySource(SESSION_ID).getObject("V", 2)).rejects.toBeInstanceOf(
      ReplayObjectNotFoundError
    );
  });
});
