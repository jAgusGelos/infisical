import { AWSRegion } from "@app/services/app-connection/app-connection-enums";

import { PamRecordingStorageBackend } from "./pam-recording-enums";

export type TPamRecordingChunkRef = {
  storageBackend: PamRecordingStorageBackend;
  externalChunkObjectKey?: string | null;
  encryptedEventsBlob?: Buffer | null;
};

export type TPamRecordingResolvedConfig = {
  backend: PamRecordingStorageBackend;
  bucket?: string;
  region?: AWSRegion;
  keyPrefix?: string | null;
  // S3-compatible endpoint (for example MinIO); unset means the AWS regional endpoint
  endpoint?: string;
  forcePathStyle?: boolean;

  awsCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
};

export type TPamRecordingValidateConfig = (input: { config: TPamRecordingResolvedConfig }) => Promise<void>;

export type TPamRecordingMintPresignedPut = (input: {
  config: TPamRecordingResolvedConfig;
  projectId: string;
  sessionId: string;
  chunkIndex: number;
  ciphertextBytes: number;
  isKeyframe?: boolean;
}) => Promise<{ url: string; objectKey: string; expiresInSeconds: number; method: "PUT" }>;

export type TPamRecordingMintPresignedGet = (input: {
  config: TPamRecordingResolvedConfig;
  objectKey: string;
}) => Promise<{ url: string; expiresInSeconds: number }>;

export type TPamRecordingDeleteSession = (input: {
  config: TPamRecordingResolvedConfig;
  projectId: string;
  sessionId: string;
}) => Promise<void>;

// Create-only PUT: the URL signs Content-Length, If-None-Match and x-amz-checksum-sha256, so the uploader must send
// exactly the returned headers and the store refuses a second write to the same key.
export type TPamRecordingMintPresignedCreateOnlyPut = (input: {
  config: TPamRecordingResolvedConfig;
  objectKey: string;
  ciphertextBytes: number;
  ciphertextSha256B64: string;
}) => Promise<{
  url: string;
  objectKey: string;
  method: "PUT";
  headers: { "x-amz-checksum-sha256": string; "If-None-Match": "*" };
  expiresInSeconds: number;
}>;

export type TPamRecordingObjectHead = {
  versionId?: string;
  checksumSha256?: string;
  contentLength?: number;
};

// Resolves to null when the object does not exist
export type TPamRecordingHeadObject = (input: {
  config: TPamRecordingResolvedConfig;
  objectKey: string;
}) => Promise<TPamRecordingObjectHead | null>;

export type TPamRecordingAssertObjectLock = (input: { config: TPamRecordingResolvedConfig }) => Promise<boolean>;

export type TPamRecordingGetObject = (input: {
  config: TPamRecordingResolvedConfig;
  objectKey: string;
  versionId?: string;
}) => Promise<Buffer>;

export type TPamRecordingStorageProvider = () => {
  validateConfig: TPamRecordingValidateConfig;
  mintPresignedPut: TPamRecordingMintPresignedPut;
  mintPresignedGet: TPamRecordingMintPresignedGet;
  deleteSession: TPamRecordingDeleteSession;
  mintPresignedCreateOnlyPut: TPamRecordingMintPresignedCreateOnlyPut;
  headObject: TPamRecordingHeadObject;
  assertObjectLock?: TPamRecordingAssertObjectLock;
  getObject: TPamRecordingGetObject;
};

// Largest stored Web App object the backend reads back: 64 MiB of ciphertext plus the envelope overhead
export const PAM_RECORDING_MAX_STORED_OBJECT_BYTES = 64 * 1024 * 1024 + 64;

export const normalizeKeyPrefix = (keyPrefix: string | null | undefined): string =>
  keyPrefix ? `${keyPrefix.replace(/^\/+|\/+$/g, "")}/` : "";

export const buildExternalChunkObjectKey = (
  keyPrefix: string | null | undefined,
  projectId: string,
  sessionId: string,
  chunkIndex: number,
  isKeyframe: boolean
): string => {
  const prefix = normalizeKeyPrefix(keyPrefix);
  const suffix = isKeyframe ? "keyframe.png.enc" : "json.enc";
  const padded = chunkIndex.toString().padStart(6, "0");
  return `${prefix}${projectId}/${sessionId}/chunk-${padded}.${suffix}`;
};
