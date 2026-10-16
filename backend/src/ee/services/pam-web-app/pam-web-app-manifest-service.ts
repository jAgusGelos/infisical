import { crypto } from "@app/lib/crypto/cryptography";
import { AsymmetricKeyAlgorithm, SigningAlgorithm } from "@app/lib/crypto/sign/types";
import { logger } from "@app/lib/logger";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";
import { KmsKeyUsage } from "@app/services/kms/kms-types";

import { TPamWebAppManifestDALFactory } from "./pam-web-app-manifest-dal";

export const PAM_WEB_APP_MANIFEST_KEY_NAME = "pam-web-app-manifest-signing";

// CONTRACTS 6.10 integrity chip values
export enum PamWebAppIntegrity {
  Verified = "Verified",
  Incomplete = "Incomplete",
  Gap = "Gap",
  Tampered = "Tampered"
}

export type TManifestObjectInput = {
  series: string;
  objectIndex: number;
  kind: string;
  firstSeq: number;
  lastSeq: number;
  objectKey: string;
  versionId?: string | null;
  binding: string;
  checkpoint: Buffer;
};

export const computeIntegrity = ({
  objects,
  finalSeq,
  hasLoss
}: {
  objects: TManifestObjectInput[];
  finalSeq: number | null;
  hasLoss: boolean;
}): PamWebAppIntegrity => {
  if (objects.some((o) => o.binding === "mismatch")) return PamWebAppIntegrity.Tampered;

  const eChunks = objects.filter((o) => o.series === "E").sort((a, b) => a.objectIndex - b.objectIndex);
  let expectedSeq = 0;
  const eContinuous = eChunks.every((c, i) => {
    const ok = c.objectIndex === i && c.firstSeq === expectedSeq;
    expectedSeq = c.lastSeq + 1;
    return ok;
  });
  const coversEnd = finalSeq !== null && expectedSeq - 1 >= finalSeq;
  const vPending = objects.some((o) => o.series === "V" && o.binding !== "bound");

  if (!eContinuous || !coversEnd || vPending) return hasLoss ? PamWebAppIntegrity.Incomplete : PamWebAppIntegrity.Gap;
  if (hasLoss) return PamWebAppIntegrity.Incomplete;
  return PamWebAppIntegrity.Verified;
};

// Key order is fixed here and the exact string is what gets signed and stored.
export const buildManifestDocument = (input: {
  sessionId: string;
  projectId: string;
  recordingKeyFingerprint: string;
  finalSeq: number | null;
  endReason: string | null;
  createdAt: Date;
  objects: TManifestObjectInput[];
  hasLoss: boolean;
}) =>
  JSON.stringify({
    format: "infisical-webapp/manifest/v1",
    sessionId: input.sessionId,
    projectId: input.projectId,
    recordingKeyFingerprint: input.recordingKeyFingerprint,
    finalSeq: input.finalSeq,
    endReason: input.endReason,
    createdAt: input.createdAt.toISOString(),
    status: computeIntegrity(input),
    objects: [...input.objects]
      .sort((a, b) => (a.series === b.series ? a.objectIndex - b.objectIndex : a.series.localeCompare(b.series)))
      .map((o) => ({
        series: o.series,
        objectIndex: o.objectIndex,
        kind: o.kind,
        firstSeq: o.firstSeq,
        lastSeq: o.lastSeq,
        objectKey: o.objectKey,
        versionId: o.versionId ?? null,
        binding: o.binding,
        checkpointSha256: crypto.nativeCrypto.createHash("sha256").update(o.checkpoint).digest("hex")
      }))
  });

type TPamWebAppManifestServiceFactoryDep = {
  pamWebAppManifestDAL: Pick<TPamWebAppManifestDALFactory, "findBySessionId" | "upsert">;
  kmsService: Pick<TKmsServiceFactory, "generateKmsKey" | "signWithKmsKey" | "verifyWithKmsKey">;
  // Returns the project's reserved manifest key id, if one exists.
  findManifestKeyId: (projectId: string) => Promise<string | null>;
  getProjectOrgId: (projectId: string) => Promise<string>;
  now?: () => number;
};

export type TPamWebAppManifestServiceFactory = ReturnType<typeof pamWebAppManifestServiceFactory>;

export const pamWebAppManifestServiceFactory = ({
  pamWebAppManifestDAL,
  kmsService,
  findManifestKeyId,
  getProjectOrgId,
  now = Date.now
}: TPamWebAppManifestServiceFactoryDep) => {
  const getOrCreateManifestKey = async (projectId: string) => {
    const existing = await findManifestKeyId(projectId);
    if (existing) return existing;

    try {
      const key = await kmsService.generateKmsKey({
        orgId: await getProjectOrgId(projectId),
        projectId,
        name: PAM_WEB_APP_MANIFEST_KEY_NAME,
        isReserved: true,
        keyUsage: KmsKeyUsage.SIGN_VERIFY,
        encryptionAlgorithm: AsymmetricKeyAlgorithm.ED25519,
        description: "Signs PAM Web App session manifests"
      });
      return key.id;
    } catch (err) {
      // Lost a race with another session creating the same reserved key.
      const raced = await findManifestKeyId(projectId);
      if (raced) return raced;
      throw err;
    }
  };

  const signManifest = async (input: Omit<Parameters<typeof buildManifestDocument>[0], "createdAt">) => {
    const manifest = buildManifestDocument({ ...input, createdAt: new Date(now()) });
    const kmsKeyId = await getOrCreateManifestKey(input.projectId);
    const sign = await kmsService.signWithKmsKey({ kmsId: kmsKeyId });
    const { signature } = await sign({
      data: Buffer.from(manifest, "utf8"),
      signingAlgorithm: SigningAlgorithm.ED25519,
      isDigest: false
    });

    await pamWebAppManifestDAL.upsert({
      sessionId: input.sessionId,
      manifest,
      signature,
      kmsKeyId,
      signingAlgorithm: SigningAlgorithm.ED25519
    });
    logger.info(
      { sessionId: input.sessionId },
      `Web App manifest signed [sessionId=${input.sessionId}] [kmsKeyId=${kmsKeyId}]`
    );
    return { manifest, signature };
  };

  const getManifest = async (sessionId: string) => {
    const row = await pamWebAppManifestDAL.findBySessionId(sessionId);
    if (!row) return null;
    return {
      document: row.manifest,
      signature: row.signature.toString("base64"),
      kmsKeyId: row.kmsKeyId,
      signingAlgorithm: row.signingAlgorithm
    };
  };

  const verifyManifest = async (sessionId: string) => {
    const row = await pamWebAppManifestDAL.findBySessionId(sessionId);
    if (!row) return false;
    const verify = await kmsService.verifyWithKmsKey({
      kmsId: row.kmsKeyId,
      signingAlgorithm: row.signingAlgorithm as SigningAlgorithm
    });
    const { signatureValid } = await verify({
      data: Buffer.from(row.manifest, "utf8"),
      signature: row.signature,
      isDigest: false
    });
    return signatureValid;
  };

  return { signManifest, getManifest, verifyManifest };
};
