import { Readable } from "node:stream";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import RE2 from "re2";

import { CustomAWSHasher } from "@app/lib/aws/hashing";
import { AWS_REQUEST_TIMEOUTS } from "@app/lib/aws/s3";
import { crypto } from "@app/lib/crypto/cryptography";
import { BadRequestError } from "@app/lib/errors";
import { logger } from "@app/lib/logger";
import { blockLocalAndPrivateIpAddresses } from "@app/lib/validator/validate-url";

import { PAM_RECORDING_MAX_CHUNK_BYTES, PAM_RECORDING_PRESIGNED_URL_EXPIRY_SECONDS } from "../pam-recording-constants";
import {
  buildExternalChunkObjectKey,
  normalizeKeyPrefix,
  PAM_RECORDING_MAX_STORED_OBJECT_BYTES,
  TPamRecordingResolvedConfig,
  TPamRecordingStorageProvider
} from "../pam-recording-storage-types";

// Three attempts at the 15s request timeout fit inside this, and it stays under Infisical's 100s request cut-off.
const S3_CALL_TIMEOUT_MS = 45_000;
const sendOptions = () => ({ abortSignal: AbortSignal.timeout(S3_CALL_TIMEOUT_MS) });

const SHA256_B64_RE = new RE2(/^[A-Za-z0-9+/]{43}=$/);

// Rejects an admin-supplied endpoint that points at a local or private address (honors ALLOW_INTERNAL_IP_CONNECTIONS)
export type TPamRecordingEndpointGuard = (endpoint: string) => Promise<void>;

const defaultEndpointGuard: TPamRecordingEndpointGuard = (endpoint) => blockLocalAndPrivateIpAddresses(endpoint);

export const buildPamRecordingS3Client = async (
  config: TPamRecordingResolvedConfig,
  guardEndpoint: TPamRecordingEndpointGuard = defaultEndpointGuard
): Promise<S3Client> => {
  if (!config.region || !config.awsCredentials) {
    throw new BadRequestError({ message: "AWS S3 storage backend requires region and credentials" });
  }
  if (config.endpoint) {
    await guardEndpoint(config.endpoint);
  }
  return new S3Client({
    region: config.region,
    useFipsEndpoint: crypto.isFipsModeEnabled(),
    sha256: CustomAWSHasher,
    credentials: config.awsCredentials,
    requestHandler: AWS_REQUEST_TIMEOUTS,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {})
  });
};

const isNotFoundError = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};

// Reads the body while counting bytes, so an object larger than the cap is never fully buffered
const readBodyCapped = (body: Readable, maxBytes: number, objectKey: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    body.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        body.destroy();
        reject(
          new BadRequestError({
            message: `Recording object exceeds the maximum readable size [objectKey=${objectKey}] [maxBytes=${maxBytes}]`
          })
        );
        return;
      }
      parts.push(chunk);
    });
    body.on("error", reject);
    body.on("end", () => resolve(Buffer.concat(parts, total)));
  });

export const createAwsS3RecordingStorageProvider = ({
  guardEndpoint = defaultEndpointGuard
}: { guardEndpoint?: TPamRecordingEndpointGuard } = {}): TPamRecordingStorageProvider => {
  const buildClient = (config: TPamRecordingResolvedConfig) => buildPamRecordingS3Client(config, guardEndpoint);

  return () => ({
    validateConfig: async ({ config }) => {
      if (!config.bucket) {
        throw new BadRequestError({ message: "Bucket is required for AWS S3 backend" });
      }
      const client = await buildClient(config);
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch (err) {
        logger.warn({ err, bucket: config.bucket }, `S3 HeadBucket failed [bucket=${config.bucket}]`);
        throw new BadRequestError({
          message: `Unable to access bucket. Verify region, credentials, and bucket policy [bucket=${config.bucket}]`
        });
      }

      const testKey = `${normalizeKeyPrefix(config.keyPrefix)}.test/${crypto.nativeCrypto.randomUUID()}`;

      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: testKey,
            Body: Buffer.from("infisical-pam-recording-config-test"),
            ContentType: "application/octet-stream"
          })
        );
      } catch (err) {
        logger.warn(
          { err, bucket: config.bucket, testKey },
          `S3 round-trip PutObject failed [bucket=${config.bucket}]`
        );
        throw new BadRequestError({
          message: "Bucket reachable but PutObject failed. Grant s3:PutObject on the configured key prefix"
        });
      }

      try {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: [{ Key: testKey }], Quiet: true }
          })
        );
      } catch (err) {
        logger.warn({ err, bucket: config.bucket, testKey }, `S3 test object cleanup failed [testKey=${testKey}]`);
      }
    },

    mintPresignedPut: async ({ config, projectId, sessionId, chunkIndex, ciphertextBytes, isKeyframe }) => {
      if (ciphertextBytes <= 0 || ciphertextBytes > PAM_RECORDING_MAX_CHUNK_BYTES) {
        throw new BadRequestError({
          message: `Chunk size out of range [bytes=${ciphertextBytes}, max=${PAM_RECORDING_MAX_CHUNK_BYTES}]`
        });
      }
      if (!config.bucket) throw new BadRequestError({ message: "Bucket is required" });

      const client = await buildClient(config);
      const objectKey = buildExternalChunkObjectKey(
        config.keyPrefix,
        projectId,
        sessionId,
        chunkIndex,
        Boolean(isKeyframe)
      );

      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        ContentLength: ciphertextBytes,
        ContentType: "application/octet-stream"
      });

      const url = await getSignedUrl(client, command, {
        expiresIn: PAM_RECORDING_PRESIGNED_URL_EXPIRY_SECONDS,
        unhoistableHeaders: new Set(["content-length"])
      });

      return {
        url,
        objectKey,
        method: "PUT" as const,
        expiresInSeconds: PAM_RECORDING_PRESIGNED_URL_EXPIRY_SECONDS
      };
    },

    mintPresignedGet: async ({ config, objectKey }) => {
      if (!config.bucket) throw new BadRequestError({ message: "Bucket is required" });
      const client = await buildClient(config);
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: objectKey });
      const url = await getSignedUrl(client, command, { expiresIn: PAM_RECORDING_PRESIGNED_URL_EXPIRY_SECONDS });
      return { url, expiresInSeconds: PAM_RECORDING_PRESIGNED_URL_EXPIRY_SECONDS };
    },

    deleteSession: async ({ config, projectId, sessionId }) => {
      if (!config.bucket) throw new BadRequestError({ message: "Bucket is required" });
      const client = await buildClient(config);

      const prefix = `${normalizeKeyPrefix(config.keyPrefix)}${projectId}/${sessionId}/`;

      let continuationToken: string | undefined;
      do {
        // eslint-disable-next-line no-await-in-loop
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken
          })
        );
        const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
        if (keys.length > 0) {
          // eslint-disable-next-line no-await-in-loop
          await client.send(
            new DeleteObjectsCommand({
              Bucket: config.bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true }
            })
          );
        }
        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuationToken);
    },

    mintPresignedCreateOnlyPut: async ({ config, objectKey, ciphertextBytes, ciphertextSha256B64 }) => {
      if (
        !Number.isInteger(ciphertextBytes) ||
        ciphertextBytes <= 0 ||
        ciphertextBytes > PAM_RECORDING_MAX_STORED_OBJECT_BYTES
      ) {
        throw new BadRequestError({
          message: `Recording object size out of range [bytes=${ciphertextBytes}] [max=${PAM_RECORDING_MAX_STORED_OBJECT_BYTES}]`
        });
      }
      if (!SHA256_B64_RE.test(ciphertextSha256B64)) {
        throw new BadRequestError({ message: "Recording object checksum must be a base64 SHA-256 digest" });
      }
      if (!config.bucket) throw new BadRequestError({ message: "Bucket is required" });

      const client = await buildClient(config);
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        ContentLength: ciphertextBytes,
        ContentType: "application/octet-stream",
        IfNoneMatch: "*",
        ChecksumSHA256: ciphertextSha256B64
      });

      // Signed (not hoisted to the query string) so the store enforces them: the body must be the declared size and
      // hash to the declared digest, and If-None-Match stops a re-minted URL from overwriting a stored object.
      const url = await getSignedUrl(client, command, {
        expiresIn: PAM_RECORDING_PRESIGNED_URL_EXPIRY_SECONDS,
        unhoistableHeaders: new Set(["content-length", "if-none-match", "x-amz-checksum-sha256"])
      });

      return {
        url,
        objectKey,
        method: "PUT" as const,
        headers: { "x-amz-checksum-sha256": ciphertextSha256B64, "If-None-Match": "*" as const },
        expiresInSeconds: PAM_RECORDING_PRESIGNED_URL_EXPIRY_SECONDS
      };
    },

    headObject: async ({ config, objectKey }) => {
      if (!config.bucket) throw new BadRequestError({ message: "Bucket is required" });
      const client = await buildClient(config);
      try {
        const res = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey, ChecksumMode: "ENABLED" }),
          sendOptions()
        );
        return {
          versionId: res.VersionId,
          checksumSha256: res.ChecksumSHA256,
          contentLength: res.ContentLength
        };
      } catch (err) {
        if (isNotFoundError(err)) return null;
        logger.warn({ err, bucket: config.bucket, objectKey }, `S3 HeadObject failed [bucket=${config.bucket}]`);
        throw new BadRequestError({
          message: `Unable to read recording object metadata from the storage bucket [bucket=${config.bucket}]`
        });
      }
    },

    assertObjectLock: async ({ config }) => {
      if (!config.bucket) return false;
      const client = await buildClient(config);
      try {
        const result = await client.send(new GetObjectLockConfigurationCommand({ Bucket: config.bucket }));
        return result.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled";
      } catch (err) {
        logger.warn(
          { err, bucket: config.bucket },
          `S3 Object Lock configuration check failed [bucket=${config.bucket}]`
        );
        return false;
      }
    },

    getObject: async ({ config, objectKey, versionId }) => {
      if (!config.bucket) throw new BadRequestError({ message: "Bucket is required" });
      const client = await buildClient(config);

      let res;
      try {
        res = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: objectKey, VersionId: versionId }),
          sendOptions()
        );
      } catch (err) {
        logger.warn({ err, bucket: config.bucket, objectKey }, `S3 GetObject failed [bucket=${config.bucket}]`);
        throw new BadRequestError({
          message: `Unable to read recording object from the storage bucket [bucket=${config.bucket}]`
        });
      }

      if (res.ContentLength !== undefined && res.ContentLength > PAM_RECORDING_MAX_STORED_OBJECT_BYTES) {
        (res.Body as Readable | undefined)?.destroy?.();
        throw new BadRequestError({
          message: `Recording object exceeds the maximum readable size [objectKey=${objectKey}] [maxBytes=${PAM_RECORDING_MAX_STORED_OBJECT_BYTES}]`
        });
      }
      if (!res.Body) return Buffer.alloc(0);

      return readBodyCapped(res.Body as Readable, PAM_RECORDING_MAX_STORED_OBJECT_BYTES, objectKey);
    }
  });
};

export const AwsS3RecordingStorageProvider: TPamRecordingStorageProvider = createAwsS3RecordingStorageProvider();
