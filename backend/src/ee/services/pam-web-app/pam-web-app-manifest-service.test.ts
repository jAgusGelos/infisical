import { describe, expect, test, vi } from "vitest";

import { TPamWebAppManifests } from "@app/db/schemas";
import { signingService } from "@app/lib/crypto/sign/signing";
import { AsymmetricKeyAlgorithm, SigningAlgorithm } from "@app/lib/crypto/sign/types";

import {
  computeIntegrity,
  PAM_WEB_APP_MANIFEST_KEY_NAME,
  PamWebAppIntegrity,
  pamWebAppManifestServiceFactory,
  TManifestObjectInput
} from "./pam-web-app-manifest-service";

vi.mock("@app/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}));

const SESSION_ID = "8a0c6a4e-1f7b-4e0e-9a43-5d2a6f0b9c11";
const PROJECT_ID = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const FIXED_NOW = Date.UTC(2026, 9, 15, 19, 0, 0);

const object = (overrides: Partial<TManifestObjectInput>): TManifestObjectInput => ({
  series: "E",
  objectIndex: 0,
  kind: "events",
  firstSeq: 0,
  lastSeq: 9,
  objectKey: "k",
  versionId: "v",
  binding: "bound",
  checkpoint: Buffer.alloc(208, 1),
  ...overrides
});

const complete = [
  object({}),
  object({ objectIndex: 1, firstSeq: 10, lastSeq: 19 }),
  object({ series: "V", objectIndex: 0, kind: "init", firstSeq: 3, lastSeq: 3 })
];

describe("computeIntegrity (6.10 chip mapping)", () => {
  test("Verified when E is continuous to finalSeq and every V is bound", () => {
    expect(computeIntegrity({ objects: complete, finalSeq: 19, hasLoss: false })).toBe(PamWebAppIntegrity.Verified);
  });

  test("Tampered on any binding mismatch", () => {
    const objects = [...complete, object({ series: "V", objectIndex: 1, kind: "media", binding: "mismatch" })];
    expect(computeIntegrity({ objects, finalSeq: 19, hasLoss: false })).toBe(PamWebAppIntegrity.Tampered);
  });

  test("Gap on a missing E chunk, an uncovered end or a pending V", () => {
    expect(computeIntegrity({ objects: [complete[1], complete[2]], finalSeq: 19, hasLoss: false })).toBe(
      PamWebAppIntegrity.Gap
    );
    expect(computeIntegrity({ objects: complete, finalSeq: 25, hasLoss: false })).toBe(PamWebAppIntegrity.Gap);
    expect(computeIntegrity({ objects: complete, finalSeq: null, hasLoss: false })).toBe(PamWebAppIntegrity.Gap);
    const pending = [...complete, object({ series: "V", objectIndex: 1, kind: "media", binding: "pending" })];
    expect(computeIntegrity({ objects: pending, finalSeq: 19, hasLoss: false })).toBe(PamWebAppIntegrity.Gap);
  });

  test("Incomplete when the gateway reported loss", () => {
    expect(computeIntegrity({ objects: complete, finalSeq: 19, hasLoss: true })).toBe(PamWebAppIntegrity.Incomplete);
  });
});

describe("pamWebAppManifestService", () => {
  const setup = async () => {
    const ed25519 = signingService(AsymmetricKeyAlgorithm.ED25519);
    const privateKey = await ed25519.generateAsymmetricPrivateKey();
    const publicKey = await ed25519.getPublicKeyFromPrivateKey(privateKey);
    const rows = new Map<string, TPamWebAppManifests>();
    const generateKmsKey = vi.fn<(input: unknown) => Promise<{ id: string }>>(async () => ({
      id: "11111111-1111-4111-8111-111111111111"
    }));
    let keyId: string | null = null;

    const service = pamWebAppManifestServiceFactory({
      pamWebAppManifestDAL: {
        findBySessionId: async (sessionId: string) => rows.get(sessionId),
        upsert: async (data: Omit<TPamWebAppManifests, "createdAt" | "updatedAt">) => {
          const row = { ...data, createdAt: new Date(), updatedAt: new Date() } as TPamWebAppManifests;
          rows.set(data.sessionId, row);
          return row;
        }
      } as never,
      kmsService: {
        generateKmsKey: async (input: unknown) => {
          const key = await generateKmsKey(input);
          keyId = key.id;
          return key;
        },
        signWithKmsKey:
          async () =>
          async ({ data }: { data: Buffer }) => ({
            signature: await ed25519.sign(data, privateKey, SigningAlgorithm.ED25519, false),
            algorithm: SigningAlgorithm.ED25519
          }),
        verifyWithKmsKey:
          async () =>
          async ({ data, signature }: { data: Buffer; signature: Buffer }) => ({
            signatureValid: await ed25519.verify(data, signature, publicKey, SigningAlgorithm.ED25519, false),
            algorithm: SigningAlgorithm.ED25519
          })
      } as never,
      findManifestKeyId: async () => keyId,
      getProjectOrgId: async () => "org-id",
      now: () => FIXED_NOW
    });

    return { service, rows, generateKmsKey };
  };

  const input = {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    recordingKeyFingerprint: "SHA256:abc",
    finalSeq: 19,
    endReason: "user_end",
    objects: complete,
    hasLoss: false
  };

  test("signs a deterministic manifest that verifies, and reuses the project key", async () => {
    const { service, generateKmsKey } = await setup();

    const first = await service.signManifest(input);
    const second = await service.signManifest(input);

    expect(first.manifest).toBe(second.manifest);
    expect(Buffer.compare(first.signature, second.signature)).toBe(0);
    expect(generateKmsKey).toHaveBeenCalledTimes(1);
    expect(generateKmsKey).toHaveBeenCalledWith(
      expect.objectContaining({
        name: PAM_WEB_APP_MANIFEST_KEY_NAME,
        projectId: PROJECT_ID,
        encryptionAlgorithm: AsymmetricKeyAlgorithm.ED25519
      })
    );
    await expect(service.verifyManifest(SESSION_ID)).resolves.toBe(true);

    const doc = JSON.parse(first.manifest) as { status: string; createdAt: string; objects: unknown[] };
    expect(doc.status).toBe(PamWebAppIntegrity.Verified);
    expect(doc.createdAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(doc.objects).toHaveLength(3);
  });

  test("a modified stored manifest no longer verifies", async () => {
    const { service, rows } = await setup();
    await service.signManifest(input);
    const row = rows.get(SESSION_ID) as TPamWebAppManifests;
    rows.set(SESSION_ID, { ...row, manifest: row.manifest.replace("Verified", "Tampered") });

    await expect(service.verifyManifest(SESSION_ID)).resolves.toBe(false);
  });
});
