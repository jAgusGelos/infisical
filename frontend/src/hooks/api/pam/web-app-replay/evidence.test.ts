import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { buildEvidenceBundle, buildTar, evidenceBundleName } from "./evidence";
import { TWebAppReplaySource } from "./source";
import { TWebAppReplay } from "./types";

const untar = (tar: Uint8Array) => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-test-"));
  writeFileSync(join(dir, "bundle.tar"), tar);
  execFileSync("tar", ["-xf", "bundle.tar"], { cwd: dir });
  return dir;
};

describe("evidence bundle", () => {
  test("buildTar writes a ustar archive that tar extracts byte for byte", () => {
    const big = new Uint8Array(1500).map((_, i) => i % 251);
    const dir = untar(
      buildTar([
        { path: "b/replay.json", bytes: new TextEncoder().encode('{"a":1}') },
        { path: "b/objects/V/00000001.stored", bytes: big }
      ])
    );
    try {
      expect(readFileSync(join(dir, "b/replay.json"), "utf8")).toBe('{"a":1}');
      expect(new Uint8Array(readFileSync(join(dir, "b/objects/V/00000001.stored")))).toEqual(big);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bundles replay.json and every listed stored object in the 6.11 layout", async () => {
    const replay = {
      sessionId: "8a0c6a4e-1f7b-4e0e-9a43-5d2a6f0b9c11",
      video: {
        mime: "",
        objects: [
          { objectIndex: 0, kind: "init" },
          { objectIndex: 1, kind: "media" }
        ]
      },
      events: { chunks: [{ objectIndex: 0 }] }
    } as unknown as TWebAppReplay;
    const requested: string[] = [];
    const source = {
      getStoredObject: async (series: "V" | "E", objectIndex: number) => {
        requested.push(`${series}/${objectIndex}`);
        return new TextEncoder().encode(`${series}${objectIndex}`);
      }
    } as unknown as TWebAppReplaySource;

    const dir = untar(await buildEvidenceBundle(source, replay));
    const root = join(dir, evidenceBundleName(replay.sessionId));
    try {
      expect(requested.sort()).toEqual(["E/0", "V/0", "V/1"]);
      expect(JSON.parse(readFileSync(join(root, "replay.json"), "utf8")).sessionId).toBe(
        replay.sessionId
      );
      expect(readFileSync(join(root, "objects/V/00000001.stored"), "utf8")).toBe("V1");
      expect(readFileSync(join(root, "objects/E/00000000.stored"), "utf8")).toBe("E0");
      expect(readFileSync(join(root, "README.txt"), "utf8")).toContain("session-key.b64");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
