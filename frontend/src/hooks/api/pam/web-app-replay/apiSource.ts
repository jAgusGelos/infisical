import axios from "axios";

import { apiRequest } from "@app/config/request";

import { WEB_APP_REPLAY_FETCH_TIMEOUT_MS } from "./limits";
import { ReplayObjectNotFoundError, TWebAppReplaySource } from "./source";
import { TWebAppReplay, TWebAppReplaySeries } from "./types";

export const webAppReplayPaths = {
  replay: (sessionId: string) => `/api/v1/pam/sessions/${sessionId}/web-app/replay`,
  object: (sessionId: string, series: TWebAppReplaySeries, objectIndex: number) =>
    `/api/v1/pam/sessions/${sessionId}/web-app/objects/${series}/${objectIndex}`
};

const fetchBytes = async (
  url: string,
  series: TWebAppReplaySeries,
  objectIndex: number,
  params: Record<string, string> | undefined,
  signal?: AbortSignal
) => {
  try {
    const { data } = await apiRequest.get<ArrayBuffer>(url, {
      params,
      responseType: "arraybuffer",
      timeout: WEB_APP_REPLAY_FETCH_TIMEOUT_MS,
      signal
    });
    return new Uint8Array(data);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      throw new ReplayObjectNotFoundError(series, objectIndex);
    }
    throw err;
  }
};

export const createApiReplaySource = (sessionId: string): TWebAppReplaySource => ({
  expectedSessionId: sessionId,
  getReplay: async () => {
    const { data } = await apiRequest.get<TWebAppReplay>(webAppReplayPaths.replay(sessionId));
    return data;
  },
  getObject: (series, objectIndex, signal) =>
    fetchBytes(
      webAppReplayPaths.object(sessionId, series, objectIndex),
      series,
      objectIndex,
      undefined,
      signal
    ),
  getStoredObject: (series, objectIndex, signal) =>
    fetchBytes(
      webAppReplayPaths.object(sessionId, series, objectIndex),
      series,
      objectIndex,
      { form: "stored" },
      signal
    )
});
