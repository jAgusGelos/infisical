/* eslint-disable no-console */
// Manual harness, not part of test:unit. Proves against a real MinIO that the create-only presign is accepted with
// its signed headers, that a second PUT to the same key is refused with 412, and that HEAD and GET read back the
// stored version, checksum and bytes.
//
// Run: cd backend && npx tsx src/ee/services/pam-web-app/harness/minio-presign.harness.ts
// Needs a MinIO on 127.0.0.1:9311 (override with F3_MINIO_ENDPOINT, F3_MINIO_USER, F3_MINIO_PASSWORD).
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { CreateBucketCommand } from "@aws-sdk/client-s3";

import {
  buildPamRecordingS3Client,
  createAwsS3RecordingStorageProvider,
  TPamRecordingEndpointGuard
} from "@app/ee/services/pam-session-recording/aws-s3/aws-s3-provider-factory";
import { PamRecordingStorageBackend } from "@app/ee/services/pam-session-recording/pam-recording-enums";
import { TPamRecordingResolvedConfig } from "@app/ee/services/pam-session-recording/pam-recording-storage-types";
import { crypto } from "@app/lib/crypto/cryptography";
import { initLogger } from "@app/lib/logger";
import { AWSRegion } from "@app/services/app-connection/app-connection-enums";

const endpoint = process.env.F3_MINIO_ENDPOINT ?? "http://127.0.0.1:9311";

// The harness talks to a loopback MinIO on purpose, which the SSRF guard rejects unless
// ALLOW_INTERNAL_IP_CONNECTIONS is set. It runs without the backend env loader, so the guard is bypassed explicitly
// here and only here.
const loopbackGuard: TPamRecordingEndpointGuard = async (url) => {
  const { hostname } = new URL(url);
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error(`Harness only bypasses the SSRF guard for loopback endpoints [hostname=${hostname}]`);
  }
};

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};

const main = async () => {
  await initLogger();
  await crypto.initialize({} as never, {} as never, {} as never);

  const bucket = `f3-harness-${randomUUID().slice(0, 8)}`;
  const config: TPamRecordingResolvedConfig = {
    backend: PamRecordingStorageBackend.AwsS3,
    bucket,
    region: AWSRegion.US_EAST_1,
    keyPrefix: null,
    endpoint,
    forcePathStyle: true,
    awsCredentials: {
      accessKeyId: process.env.F3_MINIO_USER ?? "f3admin",
      secretAccessKey: process.env.F3_MINIO_PASSWORD ?? "f3f3f3f3"
    }
  };

  const client = await buildPamRecordingS3Client(config, loopbackGuard);
  // Object Lock on create also turns on versioning, which the checkpoint flow relies on for x-amz-version-id
  await client.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
  console.log(`bucket created with object lock (versioned) [bucket=${bucket}] [endpoint=${endpoint}]`);

  const provider = createAwsS3RecordingStorageProvider({ guardEndpoint: loopbackGuard })();
  const objectKey = `web-app/${randomUUID()}/${randomUUID()}/E/00000000.evt`;
  const stored = randomBytes(4096 + 37);
  const sha256B64 = createHash("sha256").update(stored).digest("base64");

  const presigned = await provider.mintPresignedCreateOnlyPut({
    config,
    objectKey,
    ciphertextBytes: stored.length,
    ciphertextSha256B64: sha256B64
  });
  const signedHeaders = new URL(presigned.url).searchParams.get("X-Amz-SignedHeaders") ?? "";
  console.log(`presign signed headers: ${signedHeaders}`);
  console.log(`presign returned headers: ${JSON.stringify(presigned.headers)}`);
  check(
    "signed headers",
    ["content-length", "if-none-match", "x-amz-checksum-sha256"].every((h) => signedHeaders.split(";").includes(h)),
    signedHeaders
  );

  const put = () =>
    fetch(presigned.url, {
      method: presigned.method,
      headers: { ...presigned.headers, "Content-Length": String(stored.length) },
      body: stored
    });

  const first = await put();
  const firstBody = first.ok ? "" : await first.text();
  const versionId = first.headers.get("x-amz-version-id");
  console.log(`first PUT status=${first.status} x-amz-version-id=${versionId ?? "<missing>"}`);
  if (firstBody) console.log(`first PUT error body: ${firstBody}`);
  check("first PUT 200", first.status === 200, `status=${first.status}`);
  check("version id present", Boolean(versionId), `versionId=${versionId ?? "<missing>"}`);

  const second = await put();
  const secondBody = await second.text();
  console.log(`second PUT status=${second.status}`);
  check("second PUT 412", second.status === 412, `status=${second.status} body=${secondBody.slice(0, 200)}`);

  const head = await provider.headObject({ config, objectKey });
  console.log(`headObject: ${JSON.stringify(head)}`);
  check("HEAD versionId equal", head?.versionId === versionId, `head=${head?.versionId} put=${versionId}`);
  check("HEAD checksum equal", head?.checksumSha256 === sha256B64, `head=${head?.checksumSha256} sent=${sha256B64}`);
  check(
    "HEAD length equal",
    head?.contentLength === stored.length,
    `head=${head?.contentLength} sent=${stored.length}`
  );

  const missing = await provider.headObject({ config, objectKey: `${objectKey}.absent` });
  check("HEAD missing is null", missing === null, `result=${JSON.stringify(missing)}`);

  const body = await provider.getObject({ config, objectKey, versionId: versionId ?? undefined });
  check("GET bytes identical", body.equals(stored), `got=${body.length} bytes sent=${stored.length} bytes`);

  // Same length, different bytes: the signed checksum must make the store refuse the body
  const tamperedKey = `${objectKey}.tampered`;
  const tamperedPresign = await provider.mintPresignedCreateOnlyPut({
    config,
    objectKey: tamperedKey,
    ciphertextBytes: stored.length,
    ciphertextSha256B64: sha256B64
  });
  const tampered = await fetch(tamperedPresign.url, {
    method: "PUT",
    headers: { ...tamperedPresign.headers, "Content-Length": String(stored.length) },
    body: randomBytes(stored.length)
  });
  const tamperedBody = await tampered.text();
  check(
    "tampered body refused",
    tampered.status >= 400 && tampered.status < 500,
    `status=${tampered.status} code=${/<Code>([^<]+)<\/Code>/.exec(tamperedBody)?.[1] ?? "<none>"}`
  );
  const tamperedHead = await provider.headObject({ config, objectKey: tamperedKey });
  check("tampered object not stored", tamperedHead === null, `head=${JSON.stringify(tamperedHead)}`);

  if (failures.length) {
    console.log(`HARNESS FAILED [failures=${failures.join(", ")}]`);
    process.exit(1);
  }
  console.log("HARNESS PASSED");
  process.exit(0);
};

main().catch((err) => {
  console.error("HARNESS ERROR", err);
  process.exit(1);
});
