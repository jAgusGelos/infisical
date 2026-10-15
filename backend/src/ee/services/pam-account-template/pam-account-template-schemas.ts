import { z } from "zod";

import { PasswordRequirementsSchema } from "@app/ee/services/secret-rotation-v2/shared/general/password-requirements-schema";
import { AWSRegion } from "@app/services/app-connection/app-connection-enums";

import { patternsStringSchema } from "../pam/pam-policies";
import { PamRecordingStorageBackend } from "../pam-session-recording/pam-recording-enums";

export const PamRotationConfigSchema = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(3600).max(31_536_000).nullable() // 1 hour .. 1 year, or null for manual
});

export const PamHeartbeatConfigSchema = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(3600).max(31_536_000).nullable() // 1 hour .. 1 year, or null for manual
});

// Daily, matching the interval the template form offers by default.
export const DEFAULT_HEARTBEAT_CONFIG: TPamHeartbeatConfig = { enabled: true, intervalSeconds: 86_400 };

export const PamRecordingS3ConfigSchema = z.object({
  bucket: z.string().trim().min(1),
  region: z.nativeEnum(AWSRegion),
  keyPrefix: z.string().trim().optional(),
  // S3-compatible endpoint (for example MinIO); unset means the AWS regional endpoint
  endpoint: z.string().trim().url().max(2048).optional(),
  forcePathStyle: z.boolean().optional()
});

export const PamAccountSettingsOverridesSchema = z.object({
  recordingS3Config: PamRecordingS3ConfigSchema.optional()
});

export const PamWebAppTemplateSettingsSchema = z.object({
  requireObjectLock: z.boolean().default(true),
  onRecorderOverflow: z.enum(["terminate", "continue_with_loss"]).default("continue_with_loss"),
  maskedSelectors: z.array(z.string().max(512)).max(50).default([]),
  maskedHeaders: z.array(z.string().toLowerCase().max(256)).max(50).default([]),
  maskedQueryParams: z.array(z.string().max(256)).max(50).default([]),
  bodyCapBytes: z.number().int().min(0).max(1048576).default(65536),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  clipboard: z.enum(["off", "to_remote", "from_remote", "both"]).default("off"),
  downloads: z.enum(["block", "quarantine", "allow"]).default("quarantine"),
  uploads: z.enum(["block", "allow"]).default("block"),
  idleTimeoutMinutes: z.number().int().min(1).max(240).default(15),
  liveCodecs: z
    .array(z.enum(["vp9", "h264"]))
    .min(1)
    .default(["vp9", "h264"])
});

export const PamTemplateSettingsSchema = z.object({
  recordingEnabled: z.boolean().default(true),
  recordingStorageBackend: z.nativeEnum(PamRecordingStorageBackend).default(PamRecordingStorageBackend.Postgres),
  recordingS3Config: PamRecordingS3ConfigSchema.optional(),
  passwordRequirements: PasswordRequirementsSchema.optional(),
  rotation: PamRotationConfigSchema.optional(),
  heartbeat: PamHeartbeatConfigSchema.optional(),
  sessionLogMaskingPatterns: z.string().optional(),
  sessionLogMaskingBuiltInDetection: z.boolean().default(false),
  webApp: PamWebAppTemplateSettingsSchema.optional()
});

type TWebAppInvariantInput = {
  recordingEnabled?: boolean;
  recordingStorageBackend?: PamRecordingStorageBackend;
  webApp?: { requireObjectLock?: boolean } | null;
};

// Web App recording is the evidence, so a template that configures Web App must record, and Object
// Lock needs S3 (CONTRACTS 8.3).
export const addWebAppTemplateIssues = (settings: TWebAppInvariantInput, ctx: z.RefinementCtx) => {
  if (!settings.webApp) return;
  if (settings.recordingEnabled === false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recordingEnabled"],
      message: "Recording must be enabled for templates with Web App settings"
    });
  }
  if (
    settings.webApp.requireObjectLock !== false &&
    settings.recordingStorageBackend !== PamRecordingStorageBackend.AwsS3
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recordingStorageBackend"],
      message: "Web App recordings that require Object Lock must be stored in AWS S3 (or an S3-compatible endpoint)"
    });
  }
};

export const PamTemplateSettingsInputSchema = PamTemplateSettingsSchema.extend({
  sessionLogMaskingPatterns: patternsStringSchema().optional(),
  sessionLogMaskingBuiltInDetection: z.boolean().optional()
}).superRefine(addWebAppTemplateIssues);

export type TPamTemplateSettings = z.infer<typeof PamTemplateSettingsSchema>;
export type TPamTemplateSettingsInput = z.infer<typeof PamTemplateSettingsInputSchema>;
export type TPamAccountSettingsOverrides = z.infer<typeof PamAccountSettingsOverridesSchema>;
export type TPamRotationConfig = z.infer<typeof PamRotationConfigSchema>;
export type TPamHeartbeatConfig = z.infer<typeof PamHeartbeatConfigSchema>;
