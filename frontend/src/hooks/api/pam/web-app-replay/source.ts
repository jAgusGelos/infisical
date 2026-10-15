import { TWebAppReplay, TWebAppReplaySeries } from "./types";

export type TWebAppReplaySource = {
  // In API mode this is the route's session id; the fixture carries its own signed session id.
  expectedSessionId?: string;
  getReplay: () => Promise<TWebAppReplay>;
  getObject: (
    series: TWebAppReplaySeries,
    objectIndex: number,
    signal?: AbortSignal
  ) => Promise<Uint8Array>;
  getStoredObject: (
    series: TWebAppReplaySeries,
    objectIndex: number,
    signal?: AbortSignal
  ) => Promise<Uint8Array>;
};

export class ReplayObjectNotFoundError extends Error {
  constructor(
    public series: TWebAppReplaySeries,
    public objectIndex: number
  ) {
    super(`object ${series}/${objectIndex} not found`);
    this.name = "ReplayObjectNotFoundError";
  }
}
