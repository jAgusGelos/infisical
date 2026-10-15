import { logger } from "@app/lib/logger";
import { TAppConnectionDALFactory } from "@app/services/app-connection/app-connection-dal";
import { AWSRegion } from "@app/services/app-connection/app-connection-enums";
import { decryptAppConnection } from "@app/services/app-connection/app-connection-fns";
import { getAwsConnectionConfig } from "@app/services/app-connection/aws/aws-connection-fns";
import { TAwsConnectionConfig } from "@app/services/app-connection/aws/aws-connection-types";
import { TKmsServiceFactory } from "@app/services/kms/kms-service";

import { TPamAccountDALFactory } from "../pam-account/pam-account-dal";
import {
  PamRecordingS3ConfigSchema,
  PamTemplateSettingsSchema
} from "../pam-account-template/pam-account-template-schemas";
import { PamRecordingStorageBackend } from "./pam-recording-enums";
import { TPamRecordingResolvedConfig } from "./pam-recording-storage-types";

export type TPamRecordingConfigResolverDeps = {
  pamAccountDAL: Pick<TPamAccountDALFactory, "findByIdWithDetails">;
  appConnectionDAL: Pick<TAppConnectionDALFactory, "findById">;
  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
};

// Resolves the effective recording storage config of an account: the account S3 override wins over the template,
// and AWS credentials come from the recording app connection. Returns null when the account or its config is missing.
export const resolvePamRecordingConfig = async (
  { pamAccountDAL, appConnectionDAL, kmsService }: TPamRecordingConfigResolverDeps,
  accountId: string
): Promise<TPamRecordingResolvedConfig | null> => {
  const account = await pamAccountDAL.findByIdWithDetails(accountId);
  if (!account) return null;

  const templateParsed = account.templateSettings
    ? PamTemplateSettingsSchema.safeParse(account.templateSettings)
    : null;
  const templateSettings = templateParsed?.success ? templateParsed.data : null;
  if (!templateSettings) return null;

  const accountS3Parsed = account.settingsOverrides
    ? PamRecordingS3ConfigSchema.safeParse((account.settingsOverrides as Record<string, unknown>).recordingS3Config)
    : null;
  const accountS3 = accountS3Parsed?.success ? accountS3Parsed.data : null;

  if (templateSettings.recordingStorageBackend === PamRecordingStorageBackend.AwsS3) {
    const connectionId = account.recordingConnectionId ?? account.templateRecordingConnectionId;
    const s3Config = accountS3 ?? templateSettings.recordingS3Config;
    if (!connectionId || !s3Config) return null;

    const raw = await appConnectionDAL.findById(connectionId);
    if (!raw) {
      logger.warn({ connectionId, accountId }, `Recording app connection not found [connectionId=${connectionId}]`);
      return null;
    }

    const appConnection = await decryptAppConnection(raw, kmsService);
    const awsConfig = await getAwsConnectionConfig(
      appConnection as unknown as TAwsConnectionConfig,
      (s3Config.region as AWSRegion) ?? AWSRegion.US_EAST_1
    );

    return {
      backend: PamRecordingStorageBackend.AwsS3,
      bucket: s3Config.bucket,
      region: s3Config.region as AWSRegion,
      keyPrefix: s3Config.keyPrefix ?? null,
      endpoint: s3Config.endpoint,
      forcePathStyle: s3Config.forcePathStyle,
      awsCredentials: awsConfig.credentials
    };
  }

  return {
    backend: PamRecordingStorageBackend.Postgres,
    keyPrefix: null
  };
};
