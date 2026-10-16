import { ReplayObjectNotFoundError, TWebAppReplaySource } from "./source";
import { TWebAppReplay, TWebAppReplaySeries } from "./types";

// DEV only: serves the output of scripts/webapp-replay-fixture.ts from public/dev-fixtures (never committed).
const FIXTURE_ROOT = "/dev-fixtures/webapp-replay";

const fetchFixtureBytes = async (url: string, series: TWebAppReplaySeries, objectIndex: number) => {
  const res = await fetch(url);
  // Vite answers unknown public paths with index.html, so a missing object shows up as HTML, not a 404.
  if (res.status === 404 || res.headers.get("content-type")?.includes("text/html")) {
    throw new ReplayObjectNotFoundError(series, objectIndex);
  }
  if (!res.ok) throw new Error(`fixture fetch failed with status ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

export const createFixtureReplaySource = (variant: string): TWebAppReplaySource => {
  const base = `${FIXTURE_ROOT}/${encodeURIComponent(variant)}`;
  return {
    getReplay: async () => {
      const res = await fetch(`${base}/replay.json`);
      if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
        throw new Error(
          `replay fixture "${variant}" not found: run npx tsx scripts/webapp-replay-fixture.ts`
        );
      }
      return (await res.json()) as TWebAppReplay;
    },
    getObject: (series, objectIndex) =>
      fetchFixtureBytes(`${base}/objects/${series}/${objectIndex}`, series, objectIndex),
    getStoredObject: (series, objectIndex) =>
      fetchFixtureBytes(`${base}/stored/${series}/${objectIndex}`, series, objectIndex)
  };
};
