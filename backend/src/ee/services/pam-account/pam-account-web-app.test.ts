import { describe, expect, test } from "vitest";

import { PamAccountType } from "../pam/pam-enums";
import { PamTemplateSettingsInputSchema } from "../pam-account-template/pam-account-template-schemas";
import { PamRecordingStorageBackend } from "../pam-session-recording/pam-recording-enums";
import { buildGatewayConnectionTest, TestConnectionMode } from "./pam-account-connection-test";
import {
  accountTypeRequiresRecording,
  buildPamAccountTypeMetadata,
  collectCredentialSecrets,
  extractGatewayTarget,
  isCredentialConfigured,
  sanitizeCredentials,
  validateConnectionDetails,
  validateCredentials
} from "./pam-account-schemas";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

const recipe = {
  loginUrl: "https://app.internal.example/login",
  usernameSelector: "input[name=username]",
  passwordSelector: "input[name=password]",
  submitSelector: "button[type=submit]",
  successCheck: { type: "url_prefix", value: "https://app.internal.example/home" }
};

describe("web-app connection details", () => {
  test("defaults allowedHosts to the URL host and sslRejectUnauthorized to true", () => {
    const parsed = validateConnectionDetails(PamAccountType.WebApp, {
      url: "https://App.Internal.Example:8443/start"
    }) as { allowedHosts: string[]; sslRejectUnauthorized: boolean };

    expect(parsed.allowedHosts).toEqual(["app.internal.example"]);
    expect(parsed.sslRejectUnauthorized).toBe(true);
  });

  test("rejects a URL whose host is not in allowedHosts", () => {
    expect(() =>
      validateConnectionDetails(PamAccountType.WebApp, {
        url: "https://app.internal.example/",
        allowedHosts: ["other.internal.example"]
      })
    ).toThrow(/Allowed hosts must include/);
  });

  test("rejects non-http schemes and wildcard hosts", () => {
    expect(() => validateConnectionDetails(PamAccountType.WebApp, { url: "ftp://app.internal.example/" })).toThrow();
    expect(() =>
      validateConnectionDetails(PamAccountType.WebApp, {
        url: "https://app.internal.example/",
        allowedHosts: ["app.internal.example", "*.internal.example"]
      })
    ).toThrow();
  });

  test("gateway target uses the explicit port, else 443 for https and 80 for http", async () => {
    await expect(
      extractGatewayTarget(PamAccountType.WebApp, { url: "https://app.internal.example:8443/" })
    ).resolves.toEqual({ host: "app.internal.example", port: 8443 });
    await expect(
      extractGatewayTarget(PamAccountType.WebApp, { url: "https://app.internal.example/" })
    ).resolves.toEqual({ host: "app.internal.example", port: 443 });
    await expect(extractGatewayTarget(PamAccountType.WebApp, { url: "http://127.0.0.1/" })).resolves.toEqual({
      host: "127.0.0.1",
      port: 80
    });
  });
});

describe("web-app credentials", () => {
  test("accepts each auth method", () => {
    expect(validateCredentials(PamAccountType.WebApp, { authMethod: "none" })).toEqual({ authMethod: "none" });
    expect(
      validateCredentials(PamAccountType.WebApp, { authMethod: "header", headerScheme: "bearer", token: "t0ken" })
    ).toMatchObject({ authMethod: "header", headerScheme: "bearer" });
    expect(
      validateCredentials(PamAccountType.WebApp, {
        authMethod: "form-login",
        username: "alice",
        password: "s3cret",
        recipe
      })
    ).toMatchObject({ authMethod: "form-login", recipe: { timeoutMs: 15000 } });
  });

  test("rejects form-login without a password and unknown auth methods", () => {
    expect(() =>
      validateCredentials(PamAccountType.WebApp, { authMethod: "form-login", username: "alice", recipe })
    ).toThrow();
    expect(() => validateCredentials(PamAccountType.WebApp, { authMethod: "cookie" })).toThrow();
  });

  test("sanitized credentials never carry password, token or headerValue", () => {
    const sanitized = sanitizeCredentials(PamAccountType.WebApp, {
      authMethod: "header",
      headerScheme: "custom",
      headerName: "X-Api-Key",
      headerValue: "secret-value",
      token: "secret-token",
      password: "secret-password",
      username: "bob"
    });

    expect(sanitized).toEqual({
      authMethod: "header",
      headerScheme: "custom",
      headerName: "X-Api-Key",
      username: "bob"
    });
  });

  test("secrets are collected for scrubbing and authMethod none needs no credential", () => {
    expect(
      collectCredentialSecrets(PamAccountType.WebApp, {
        authMethod: "header",
        headerScheme: "custom",
        headerName: "X-Api-Key",
        headerValue: "secret-value"
      })
    ).toEqual(["secret-value"]);
    expect(isCredentialConfigured(PamAccountType.WebApp, { authMethod: "none" })).toBe(true);
  });

  test("is listed in the account type metadata and requires recording", () => {
    const webApp = buildPamAccountTypeMetadata(new Set()).find((t) => t.type === PamAccountType.WebApp);
    expect(webApp?.name).toBe("Web App");
    expect(webApp?.icon).toBe("WebApp.png");
    expect(webApp?.connectionFields.map((f) => f.key)).toEqual([
      "url",
      "allowedHosts",
      "sslRejectUnauthorized",
      "sslCertificate"
    ]);
    expect(accountTypeRequiresRecording(PamAccountType.WebApp)).toBe(true);
  });
});

describe("web-app connection test", () => {
  test("builds a web-app test on the URL host and port", async () => {
    const result = await buildGatewayConnectionTest(
      PamAccountType.WebApp,
      { url: "https://app.internal.example:8443/" },
      { authMethod: "none" },
      ORG_ID
    );

    expect(result).toMatchObject({
      host: "app.internal.example",
      port: 8443,
      request: { mode: TestConnectionMode.WebApp, authMethod: "none", allowedHosts: ["app.internal.example"] }
    });
  });
});

describe("web-app template settings", () => {
  test("applies contract defaults", () => {
    const parsed = PamTemplateSettingsInputSchema.parse({
      recordingStorageBackend: PamRecordingStorageBackend.AwsS3,
      webApp: {}
    });

    expect(parsed.webApp).toMatchObject({
      requireObjectLock: true,
      onRecorderOverflow: "continue_with_loss",
      clipboard: "off",
      downloads: "quarantine",
      uploads: "block",
      idleTimeoutMinutes: 15,
      liveCodecs: ["vp9", "h264"]
    });
  });

  test("requires recording and S3 storage for Web App recordings", () => {
    expect(() =>
      PamTemplateSettingsInputSchema.parse({
        recordingEnabled: false,
        recordingStorageBackend: PamRecordingStorageBackend.AwsS3,
        webApp: {}
      })
    ).toThrow(/Recording must be enabled/);
    expect(() =>
      PamTemplateSettingsInputSchema.parse({ recordingStorageBackend: PamRecordingStorageBackend.Postgres, webApp: {} })
    ).toThrow(/Object Lock/);
    expect(() =>
      PamTemplateSettingsInputSchema.parse({
        recordingStorageBackend: PamRecordingStorageBackend.Postgres,
        webApp: { requireObjectLock: false }
      })
    ).toThrow(/Object Lock/);
  });

  test("accepts an S3-compatible endpoint with path-style addressing", () => {
    const parsed = PamTemplateSettingsInputSchema.parse({
      recordingStorageBackend: PamRecordingStorageBackend.AwsS3,
      recordingS3Config: {
        bucket: "recordings",
        region: "us-east-1",
        endpoint: "http://127.0.0.1:9000",
        forcePathStyle: true
      }
    });

    expect(parsed.recordingS3Config).toMatchObject({ endpoint: "http://127.0.0.1:9000", forcePathStyle: true });
  });
});
