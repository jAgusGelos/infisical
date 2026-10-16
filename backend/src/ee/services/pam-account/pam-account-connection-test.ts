import ConnectionString from "mongodb-connection-string-url";

import { GatewayFailureKind, TestConnectionResponse } from "@app/lib/gateway-v2/test-connection-rpc";

import {
  PamAccountType,
  PamPostgresAuthMethod,
  PamSshAuthMethod,
  PamWebAppAuthMethod,
  PamWebAppHeaderScheme
} from "../pam/pam-enums";
import {
  AWS_STS_MIN_DURATION_SECONDS,
  generateAwsIamSessionCredentials,
  generateRdsAuthToken
} from "../pam-session/aws-iam/aws-iam-federation";
import { AZURE_SCOPES, getAzureAccessToken } from "../pam-session/azure/azure-federation";
import { mintGcpAccessToken } from "../pam-session/gcp/gcp-federation";
import {
  extractGatewayTarget,
  isCredentialConfigured,
  ORACLE_MAX_PASSWORD_LENGTH,
  ORACLE_MIN_GATEWAY_VERSION,
  qualifyUsernameWithDomain,
  validateConnectionDetails
} from "./pam-account-schemas";

export { ORACLE_MAX_PASSWORD_LENGTH, ORACLE_MIN_GATEWAY_VERSION };

export enum TestConnectionMode {
  SQL = "sql",
  MongoDB = "mongodb",
  Redis = "redis",
  LDAP = "ldap",
  Kubernetes = "kubernetes",
  SSH = "ssh",
  Snowflake = "snowflake",
  ClickHouse = "clickhouse",
  WebApp = "web-app",
  Tcp = "tcp"
}

// the request the gateway's /v1/test-connection handler expects, discriminated by `mode`
export type TestConnectionRequest =
  | {
      mode: TestConnectionMode.SQL;
      dialect: "postgres" | "mysql" | "mssql" | "oracle";
      username: string;
      password?: string;
      database: string;
      sslEnabled?: boolean;
      sslRejectUnauthorized?: boolean;
      sslCertificate?: string;
      authMethod?: string;
      domain?: string;
      realm?: string;
      kdcAddress?: string;
      spn?: string;
    }
  | {
      mode: TestConnectionMode.MongoDB;
      username: string;
      password?: string;
      authSource: string;
      sslEnabled?: boolean;
      sslRejectUnauthorized?: boolean;
      sslCertificate?: string;
    }
  | {
      mode: TestConnectionMode.Redis;
      username?: string;
      password?: string;
      sslEnabled?: boolean;
      sslRejectUnauthorized?: boolean;
      sslCertificate?: string;
    }
  | {
      mode: TestConnectionMode.LDAP;
      username: string;
      password?: string;
      useLdaps?: boolean;
      ldapRejectUnauthorized?: boolean;
      ldapCaCert?: string;
      ldapTlsServerName?: string;
    }
  | {
      mode: TestConnectionMode.Kubernetes;
      authMethod: "service-account-token" | "gateway-kubernetes-auth";
      token?: string;
      namespace?: string;
      serviceAccountName?: string;
      sslRejectUnauthorized?: boolean;
      sslCertificate?: string;
    }
  | {
      mode: TestConnectionMode.SSH;
      authMethod: string;
      username: string;
      password?: string;
      privateKey?: string;
      certificate?: string;
    }
  | {
      mode: TestConnectionMode.Snowflake;
      account: string;
      authMethod: string;
      username: string;
      password?: string;
      token?: string;
      privateKey?: string;
      privateKeyPassphrase?: string;
      warehouse?: string;
      database?: string;
      schema?: string;
      role?: string;
    }
  | {
      mode: TestConnectionMode.ClickHouse;
      username: string;
      password?: string;
      database: string;
      httpPort?: number;
      nativePort?: number;
      sslEnabled?: boolean;
      sslRejectUnauthorized?: boolean;
      sslCertificate?: string;
    }
  | {
      mode: TestConnectionMode.ClickHouse;
      probeOnly: true;
      database: string;
      httpPort?: number;
      nativePort?: number;
      sslEnabled?: boolean;
      sslRejectUnauthorized?: boolean;
      sslCertificate?: string;
    }
  | {
      mode: TestConnectionMode.WebApp;
      url: string;
      allowedHosts: string[];
      sslRejectUnauthorized?: boolean;
      sslCertificate?: string;
      authMethod: PamWebAppAuthMethod.None | PamWebAppAuthMethod.Header;
      headerScheme?: PamWebAppHeaderScheme;
      username?: string;
      password?: string;
      token?: string;
      headerName?: string;
      headerValue?: string;
    }
  | { mode: TestConnectionMode.Tcp };

export type TGatewayConnectionTest = {
  host: string;
  port: number;
  request: TestConnectionRequest;
  additionalPorts?: number[];
};

const SQL_DIALECTS = {
  [PamAccountType.Postgres]: "postgres",
  [PamAccountType.MySQL]: "mysql",
  [PamAccountType.MsSQL]: "mssql",
  [PamAccountType.OracleDB]: "oracle"
} as const;

const tcp = (host: string, port: number) => ({ host, port, request: { mode: TestConnectionMode.Tcp } as const });

export const testVerifiesCredential = (request: TestConnectionRequest): boolean => {
  if (request.mode === TestConnectionMode.WebApp) return request.authMethod === PamWebAppAuthMethod.Header;
  return request.mode !== TestConnectionMode.Tcp && !("probeOnly" in request && request.probeOnly);
};

export const exceedsOraclePasswordLimit = (
  accountType: PamAccountType,
  credentials: Record<string, unknown> | null
): boolean =>
  accountType === PamAccountType.OracleDB &&
  typeof credentials?.password === "string" &&
  credentials.password.length > ORACLE_MAX_PASSWORD_LENGTH;

// resolves the gateway target and the per-type auth request
export const buildGatewayConnectionTest = async (
  accountType: PamAccountType,
  connectionDetails: Record<string, unknown>,
  credentials: Record<string, unknown> | null,
  orgId: string,
  // Off for account create and update, which must not fail against a gateway predating the test they need.
  opts?: { allowNewerGatewayTests?: boolean }
): Promise<TGatewayConnectionTest | null> => {
  const creds = credentials && isCredentialConfigured(accountType, credentials) ? credentials : null;

  const target =
    accountType === PamAccountType.WindowsAd
      ? {
          host: (connectionDetails as { dcAddress: string }).dcAddress,
          port: (connectionDetails as { port: number }).port
        }
      : await extractGatewayTarget(accountType, connectionDetails);
  if (target.port === undefined) return null;
  const { host, port } = target as { host: string; port: number };

  switch (accountType) {
    case PamAccountType.Postgres:
    case PamAccountType.MySQL:
    case PamAccountType.MsSQL:
    case PamAccountType.OracleDB: {
      const cd = connectionDetails as {
        database: string;
        sslEnabled?: boolean;
        sslRejectUnauthorized?: boolean;
        sslCertificate?: string;
      };
      const c = creds as {
        authMethod?: string;
        username: string;
        password?: string;
        awsRegion?: string;
        roleArn?: string;
        domain?: string;
        realm?: string;
        kdcAddress?: string;
        spn?: string;
      } | null;
      if (!c) return tcp(host, port);
      const needsNewerGateway =
        (accountType === PamAccountType.MsSQL && c.authMethod !== "sql-login") ||
        accountType === PamAccountType.OracleDB;
      if (needsNewerGateway && !opts?.allowNewerGatewayTests) return tcp(host, port);
      if (exceedsOraclePasswordLimit(accountType, c)) return tcp(host, port);
      // An IAM login's password is a token Infisical mints per connection, so the test mints its own
      const password =
        c.authMethod === PamPostgresAuthMethod.AwsIam
          ? await generateRdsAuthToken({
              roleArn: c.roleArn!,
              externalId: orgId,
              roleSessionName: "infisical-pam-connection-test",
              region: c.awsRegion!,
              host,
              port,
              username: c.username
            })
          : c.password;
      return {
        host,
        port,
        request: {
          mode: TestConnectionMode.SQL,
          dialect: SQL_DIALECTS[accountType],
          username: c.username,
          password,
          database: cd.database,
          sslEnabled: cd.sslEnabled,
          sslRejectUnauthorized: cd.sslRejectUnauthorized,
          sslCertificate: cd.sslCertificate,
          ...(accountType === PamAccountType.MsSQL
            ? {
                authMethod: c.authMethod,
                domain: c.domain,
                realm: c.realm,
                kdcAddress: c.kdcAddress,
                spn: c.spn
              }
            : {})
        }
      };
    }
    case PamAccountType.MongoDB: {
      const cd = connectionDetails as {
        connectionString: string;
        database: string;
        sslEnabled?: boolean;
        sslRejectUnauthorized?: boolean;
        sslCertificate?: string;
      };
      const c = creds as { username: string; password?: string } | null;
      if (!c) return tcp(host, port);
      const authSource = new ConnectionString(cd.connectionString).searchParams.get("authSource") || cd.database;
      return {
        host,
        port,
        request: {
          mode: TestConnectionMode.MongoDB,
          username: c.username,
          password: c.password,
          authSource,
          sslEnabled: cd.sslEnabled,
          sslRejectUnauthorized: cd.sslRejectUnauthorized,
          sslCertificate: cd.sslCertificate
        }
      };
    }
    case PamAccountType.Redis: {
      const cd = connectionDetails as {
        sslEnabled?: boolean;
        sslRejectUnauthorized?: boolean;
        sslCertificate?: string;
      };
      const c = creds as { username?: string; password?: string } | null;
      if (!c) return tcp(host, port);
      return {
        host,
        port,
        request: {
          mode: TestConnectionMode.Redis,
          username: c.username,
          password: c.password,
          sslEnabled: cd.sslEnabled,
          sslRejectUnauthorized: cd.sslRejectUnauthorized,
          sslCertificate: cd.sslCertificate
        }
      };
    }
    case PamAccountType.Kubernetes: {
      const cd = connectionDetails as { sslRejectUnauthorized?: boolean; sslCertificate?: string };
      const c = creds as {
        authMethod: string;
        serviceAccountToken?: string;
        namespace?: string;
        serviceAccountName?: string;
      } | null;
      if (c?.authMethod === "service-account-token" && c.serviceAccountToken) {
        return {
          host,
          port,
          request: {
            mode: TestConnectionMode.Kubernetes,
            authMethod: "service-account-token",
            token: c.serviceAccountToken,
            sslRejectUnauthorized: cd.sslRejectUnauthorized,
            sslCertificate: cd.sslCertificate
          }
        };
      }
      if (c?.authMethod === "gateway-kubernetes-auth" && c.namespace && c.serviceAccountName) {
        return {
          host,
          port,
          request: {
            mode: TestConnectionMode.Kubernetes,
            authMethod: "gateway-kubernetes-auth",
            namespace: c.namespace,
            serviceAccountName: c.serviceAccountName
          }
        };
      }
      return tcp(host, port);
    }
    case PamAccountType.WindowsAd: {
      const cd = connectionDetails as {
        domain: string;
        useLdaps?: boolean;
        ldapRejectUnauthorized?: boolean;
        ldapCaCert?: string;
        ldapTlsServerName?: string;
      };
      const c = creds as { username: string; password?: string } | null;
      if (!c) return tcp(host, port);
      return {
        host,
        port,
        request: {
          mode: TestConnectionMode.LDAP,
          username: qualifyUsernameWithDomain(c.username, cd.domain),
          password: c.password,
          useLdaps: cd.useLdaps,
          ldapRejectUnauthorized: cd.ldapRejectUnauthorized,
          ldapCaCert: cd.ldapCaCert,
          ldapTlsServerName: cd.ldapTlsServerName
        }
      };
    }
    case PamAccountType.SSH: {
      const c = creds as {
        authMethod: string;
        username: string;
        password?: string;
        privateKey?: string;
        certificate?: string;
      } | null;
      if (!c || (c.authMethod === PamSshAuthMethod.Certificate && !c.certificate)) return tcp(host, port);
      return {
        host,
        port,
        request: {
          mode: TestConnectionMode.SSH,
          authMethod: c.authMethod,
          username: c.username,
          password: c.password,
          privateKey: c.privateKey,
          certificate: c.certificate
        }
      };
    }
    case PamAccountType.Snowflake: {
      const cd = connectionDetails as {
        account: string;
        warehouse?: string;
        database?: string;
        schema?: string;
        role?: string;
      };
      const c = creds as {
        authMethod: string;
        username: string;
        password?: string;
        token?: string;
        privateKey?: string;
        privateKeyPassphrase?: string;
      } | null;
      if (!c) return tcp(host, port);
      return {
        host,
        port,
        request: {
          mode: TestConnectionMode.Snowflake,
          account: cd.account,
          authMethod: c.authMethod,
          username: c.username,
          password: c.password,
          token: c.token,
          privateKey: c.privateKey,
          privateKeyPassphrase: c.privateKeyPassphrase,
          warehouse: cd.warehouse,
          database: cd.database,
          schema: cd.schema,
          role: cd.role
        }
      };
    }
    case PamAccountType.ClickHouse: {
      const cd = connectionDetails as {
        database: string;
        port?: number;
        nativePort?: number;
        sslEnabled?: boolean;
        sslRejectUnauthorized?: boolean;
        sslCertificate?: string;
      };
      const c = creds as { username: string; password?: string } | null;
      const details = {
        database: cd.database,
        httpPort: cd.port,
        nativePort: cd.nativePort,
        sslEnabled: cd.sslEnabled,
        sslRejectUnauthorized: cd.sslRejectUnauthorized,
        sslCertificate: cd.sslCertificate
      };
      const additionalPorts = [cd.port, cd.nativePort].filter((p): p is number => typeof p === "number");
      if (!c) {
        // Only a gateway with native support understands probeOnly, and a native port already requires one.
        if (cd.nativePort === undefined) return tcp(host, port);
        return {
          host,
          port,
          additionalPorts,
          request: { mode: TestConnectionMode.ClickHouse, probeOnly: true, ...details }
        };
      }
      return {
        host,
        port,
        additionalPorts,
        request: { mode: TestConnectionMode.ClickHouse, username: c.username, password: c.password, ...details }
      };
    }
    case PamAccountType.Windows:
      return tcp(host, port);
    // Safe on create and update too: runGatewayConnectionTest falls back to tcp when the gateway predates this mode.
    case PamAccountType.WebApp: {
      const cd = validateConnectionDetails(accountType, connectionDetails) as {
        url: string;
        allowedHosts: string[];
        sslRejectUnauthorized?: boolean;
        sslCertificate?: string;
      };
      const c = creds as {
        authMethod: PamWebAppAuthMethod;
        headerScheme?: PamWebAppHeaderScheme;
        username?: string;
        password?: string;
        token?: string;
        headerName?: string;
        headerValue?: string;
      } | null;
      const base = {
        mode: TestConnectionMode.WebApp,
        url: cd.url,
        allowedHosts: cd.allowedHosts,
        sslRejectUnauthorized: cd.sslRejectUnauthorized,
        sslCertificate: cd.sslCertificate
      } as const;
      // A form login is only checked up to the HTTP answer, so its secrets never leave the backend for it.
      if (c?.authMethod !== PamWebAppAuthMethod.Header || !c.headerScheme) {
        return { host, port, request: { ...base, authMethod: PamWebAppAuthMethod.None } };
      }
      return {
        host,
        port,
        request: {
          ...base,
          authMethod: PamWebAppAuthMethod.Header,
          headerScheme: c.headerScheme,
          username: c.username,
          password: c.password,
          token: c.token,
          headerName: c.headerName,
          headerValue: c.headerValue
        }
      };
    }
    default:
      return null;
  }
};

const WEB_APP_TEST_STEPS = new Set(["resolve", "policy", "tls", "http", "login"]);
const WEB_APP_MESSAGE_MAX_LENGTH = 300;

type TWebAppTestResult = { ok: boolean; step?: string; httpStatus?: number; message?: string };

// CONTRACTS 8.4 result, either bare or inside the handler's usual `result` envelope
const readWebAppTestResult = (payload: unknown): TWebAppTestResult | null => {
  if (!payload || typeof payload !== "object") return null;
  const candidate = "result" in payload ? (payload as { result: unknown }).result : payload;
  if (!candidate || typeof candidate !== "object") return null;
  const { ok, step, httpStatus, message } = candidate as Record<string, unknown>;
  if (typeof ok !== "boolean") return null;
  if (step !== undefined && (typeof step !== "string" || !WEB_APP_TEST_STEPS.has(step))) return null;
  if (!ok && step === undefined) return null;
  return {
    ok,
    step: step as string | undefined,
    httpStatus: typeof httpStatus === "number" ? httpStatus : undefined,
    message: typeof message === "string" ? message : undefined
  };
};

const webAppSecrets = (request: Extract<TestConnectionRequest, { mode: TestConnectionMode.WebApp }>): string[] => {
  const secrets = [request.password, request.token, request.headerValue];
  if (request.username !== undefined && request.password) {
    secrets.push(Buffer.from(`${request.username}:${request.password}`).toString("base64"));
  }
  return secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
};

const redactSecrets = (text: string, secrets: string[]) =>
  secrets.reduce((acc, secret) => acc.split(secret).join("[redacted]"), text);

const describeWebAppFailure = (result: TWebAppTestResult, detail: string | undefined, secrets: string[]) => {
  const raw = (detail ?? "").trim();
  const clean = redactSecrets(raw, secrets).slice(0, WEB_APP_MESSAGE_MAX_LENGTH);
  const at = result.step ? ` at ${result.step}` : "";
  if (result.httpStatus !== undefined) {
    return `Web App check failed${at}: the app answered HTTP ${result.httpStatus}${clean ? ` (${clean})` : ""}`;
  }
  return `Web App check failed${at}${clean ? `: ${clean}` : ""}`;
};

const webAppFailureKind = (result: TWebAppTestResult): GatewayFailureKind => {
  if (result.step === "login" || result.httpStatus === 401 || result.httpStatus === 403) return "auth";
  return "transport";
};

const isUnsupportedModeAnswer = (response: TestConnectionResponse) =>
  !response.ok && response.errorMessage.toLowerCase().includes("unsupported test-connection mode");

// Maps the gateway's Web App answer onto the shared response shape; null when the gateway did not answer the mode.
export const interpretWebAppTestResponse = (
  response: TestConnectionResponse,
  request: Extract<TestConnectionRequest, { mode: TestConnectionMode.WebApp }>
): TestConnectionResponse | null => {
  if (isUnsupportedModeAnswer(response)) return null;
  const secrets = webAppSecrets(request);
  const result = readWebAppTestResult(response.payload);
  if (result?.ok) return { ok: true, status: response.status };
  if (result) {
    return {
      ok: false,
      status: response.status,
      errorMessage: describeWebAppFailure(result, result.message, secrets),
      kind: webAppFailureKind(result)
    };
  }
  if (response.ok) return null;
  const hasErrorEnvelope = Boolean((response.payload as { error?: { message?: unknown } } | undefined)?.error?.message);
  if (!hasErrorEnvelope) return null;
  return {
    ok: false,
    status: response.status,
    errorMessage: describeWebAppFailure({ ok: false }, response.errorMessage, secrets),
    kind: response.kind
  };
};

// Runs a built test through `run`, interpreting the Web App answer. With fallbackToTcp, a gateway that does not
// answer the Web App mode gets a reachability test instead; `request` is the one whose result is returned.
export const runGatewayConnectionTest = async (
  test: TGatewayConnectionTest,
  run: (test: TGatewayConnectionTest) => Promise<TestConnectionResponse | null>,
  opts: { fallbackToTcp: boolean }
): Promise<{ result: TestConnectionResponse | null; request: TestConnectionRequest }> => {
  const response = await run(test);
  const { request } = test;
  if (request.mode !== TestConnectionMode.WebApp || !response) return { result: response, request };

  const interpreted = interpretWebAppTestResponse(response, request);
  if (interpreted) return { result: interpreted, request };

  if (!opts.fallbackToTcp) {
    return {
      result: {
        ok: false,
        status: response.status,
        errorMessage: 'unsupported test-connection mode: "web-app"',
        kind: null
      },
      request
    };
  }
  const fallback = tcp(test.host, test.port);
  return { result: await run(fallback), request: fallback.request };
};

// cloud accounts have no gateway-reachable host; the test validates the brokering credentials instead
type CloudConnectionValidator = (params: {
  connectionDetails: Record<string, unknown>;
  credentials: Record<string, unknown> | null;
  orgId: string;
}) => Promise<void>;

export const CLOUD_CONNECTION_VALIDATORS: Partial<Record<PamAccountType, CloudConnectionValidator>> = {
  [PamAccountType.AwsIam]: async ({ connectionDetails, orgId }) => {
    await generateAwsIamSessionCredentials({
      roleArn: connectionDetails.roleArn as string,
      externalId: orgId,
      roleSessionName: "infisical-pam-connection-test",
      sessionDuration: AWS_STS_MIN_DURATION_SECONDS
    });
  },
  [PamAccountType.AzureCli]: async ({ connectionDetails, credentials }) => {
    if (!credentials) return;
    await getAzureAccessToken({
      tenantId: connectionDetails.tenantId as string,
      clientId: credentials.clientId as string,
      clientSecret: credentials.clientSecret as string,
      scope: AZURE_SCOPES.arm
    });
  },
  [PamAccountType.GcpServiceAccount]: async ({ connectionDetails, credentials }) => {
    if (!credentials) return;
    await mintGcpAccessToken({
      serviceAccountEmail: connectionDetails.serviceAccountEmail as string,
      authMethod: credentials.authMethod as string,
      serviceAccountKeyJson: credentials.serviceAccountKeyJson as string | undefined
    });
  }
};
