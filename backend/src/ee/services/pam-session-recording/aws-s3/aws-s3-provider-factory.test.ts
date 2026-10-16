import { describe, expect, test, vi } from "vitest";

import { AWSRegion } from "@app/services/app-connection/app-connection-enums";

import { PamRecordingStorageBackend } from "../pam-recording-enums";
import { TPamRecordingResolvedConfig } from "../pam-recording-storage-types";
import { buildPamRecordingS3Client, createAwsS3RecordingStorageProvider } from "./aws-s3-provider-factory";

vi.mock("@app/lib/crypto/cryptography", async () => ({
  crypto: { isFipsModeEnabled: () => false, nativeCrypto: await import("node:crypto") }
}));

vi.mock("@app/lib/config/env", () => ({
  getConfig: () => ({ isDevelopmentMode: false, ALLOW_INTERNAL_IP_CONNECTIONS: false })
}));

const SHA256_B64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

const baseConfig: TPamRecordingResolvedConfig = {
  backend: PamRecordingStorageBackend.AwsS3,
  bucket: "recordings",
  region: AWSRegion.US_EAST_1,
  keyPrefix: null,
  awsCredentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "example-secret" }
};

const minioConfig: TPamRecordingResolvedConfig = {
  ...baseConfig,
  endpoint: "http://minio.example.test:9000",
  forcePathStyle: true
};

const allowAll = vi.fn(async () => {});

describe("buildPamRecordingS3Client", () => {
  test("passes endpoint and forcePathStyle to the S3 client when they are set", async () => {
    const guard = vi.fn(async () => {});
    const client = await buildPamRecordingS3Client(minioConfig, guard);

    expect(guard).toHaveBeenCalledWith("http://minio.example.test:9000");
    expect(client.config.forcePathStyle).toBe(true);
    expect(client.config.endpoint).toBeDefined();
    const endpoint = await client.config.endpoint!();
    expect(endpoint.hostname).toBe("minio.example.test");
    expect(endpoint.port).toBe(9000);
    expect(endpoint.protocol).toBe("http:");
  });

  test("leaves endpoint and forcePathStyle unset when the config has neither", async () => {
    const guard = vi.fn(async () => {});
    const client = await buildPamRecordingS3Client(baseConfig, guard);

    expect(guard).not.toHaveBeenCalled();
    expect(client.config.endpoint).toBeUndefined();
    expect(client.config.forcePathStyle).toBe(false);
  });

  test("rejects a configured endpoint on a private address through the default SSRF guard", async () => {
    await expect(buildPamRecordingS3Client({ ...baseConfig, endpoint: "http://127.0.0.1:9000" })).rejects.toThrow(
      "Local IPs not allowed as URL"
    );
  });
});

describe("mintPresignedCreateOnlyPut", () => {
  const provider = createAwsS3RecordingStorageProvider({ guardEndpoint: allowAll })();

  test("signs if-none-match, the checksum and the length into the URL and returns the two headers", async () => {
    const objectKey = "web-app/p1/s1/E/00000000.evt";
    const presigned = await provider.mintPresignedCreateOnlyPut({
      config: minioConfig,
      objectKey,
      ciphertextBytes: 42,
      ciphertextSha256B64: SHA256_B64
    });

    const url = new URL(presigned.url);
    const signed = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
    expect(signed).toContain("if-none-match");
    expect(signed).toContain("x-amz-checksum-sha256");
    expect(signed).toContain("content-length");
    expect(url.searchParams.has("x-amz-checksum-sha256")).toBe(false);
    expect(url.host).toBe("minio.example.test:9000");
    expect(url.pathname).toBe(`/recordings/${objectKey}`);

    expect(presigned).toMatchObject({
      objectKey,
      method: "PUT",
      headers: { "x-amz-checksum-sha256": SHA256_B64, "If-None-Match": "*" },
      expiresInSeconds: 300
    });
  });

  test("rejects a checksum that is not a base64 SHA-256 digest", async () => {
    await expect(
      provider.mintPresignedCreateOnlyPut({
        config: minioConfig,
        objectKey: "k",
        ciphertextBytes: 42,
        ciphertextSha256B64: "not-a-digest"
      })
    ).rejects.toThrow("base64 SHA-256");
  });

  test("rejects a size above the stored object cap", async () => {
    await expect(
      provider.mintPresignedCreateOnlyPut({
        config: minioConfig,
        objectKey: "k",
        ciphertextBytes: 64 * 1024 * 1024 + 65,
        ciphertextSha256B64: SHA256_B64
      })
    ).rejects.toThrow("out of range");
  });
});
