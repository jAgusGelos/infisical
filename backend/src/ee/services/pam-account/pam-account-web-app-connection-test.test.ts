import { describe, expect, test, vi } from "vitest";

import { TestConnectionResponse } from "@app/lib/gateway-v2/test-connection-rpc";

import { PamAccountType } from "../pam/pam-enums";
import {
  buildGatewayConnectionTest,
  runGatewayConnectionTest,
  TestConnectionMode,
  testVerifiesCredential,
  TGatewayConnectionTest
} from "./pam-account-connection-test";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const TOKEN = "s3cr3t-bearer-token";

const connectionDetails = {
  url: "https://app.internal.example/home",
  allowedHosts: ["app.internal.example", "cdn.internal.example"],
  sslRejectUnauthorized: true,
  sslCertificate: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"
};

const buildHeaderTest = async () => {
  const built = await buildGatewayConnectionTest(
    PamAccountType.WebApp,
    connectionDetails,
    { authMethod: "header", headerScheme: "bearer", token: TOKEN },
    ORG_ID
  );
  if (!built) throw new Error("expected a web-app test");
  return built;
};

// Stands in for the gateway: answers the web-app mode with `webApp`, and the tcp fallback with `tcp`.
const stubGateway = (webApp: TestConnectionResponse, tcp: TestConnectionResponse = { ok: true, status: 200 }) =>
  vi.fn(async (built: TGatewayConnectionTest) => (built.request.mode === TestConnectionMode.WebApp ? webApp : tcp));

describe("buildGatewayConnectionTest: web-app", () => {
  test("carries the URL, hosts, trust and header credential the gateway needs", async () => {
    const built = await buildHeaderTest();

    expect(built).toMatchObject({
      host: "app.internal.example",
      port: 443,
      request: {
        mode: TestConnectionMode.WebApp,
        url: connectionDetails.url,
        allowedHosts: connectionDetails.allowedHosts,
        sslRejectUnauthorized: true,
        sslCertificate: connectionDetails.sslCertificate,
        authMethod: "header",
        headerScheme: "bearer",
        token: TOKEN
      }
    });
    expect(testVerifiesCredential(built.request)).toBe(true);
  });

  test("a form login is checked without its secrets and does not count as a verified credential", async () => {
    const built = await buildGatewayConnectionTest(
      PamAccountType.WebApp,
      connectionDetails,
      {
        authMethod: "form-login",
        username: "alice",
        password: "hunter2",
        recipe: {
          loginUrl: "https://app.internal.example/login",
          usernameSelector: "#u",
          passwordSelector: "#p",
          submitSelector: "#s",
          successCheck: { type: "url_prefix", value: "https://app.internal.example/home" }
        }
      },
      ORG_ID
    );

    expect(built?.request).toMatchObject({ mode: TestConnectionMode.WebApp, authMethod: "none" });
    expect(JSON.stringify(built?.request)).not.toContain("hunter2");
    expect(testVerifiesCredential(built!.request)).toBe(false);
  });
});

describe("runGatewayConnectionTest: web-app answers", () => {
  test("ok answer passes", async () => {
    const built = await buildHeaderTest();
    const run = stubGateway({
      ok: true,
      status: 200,
      payload: { result: { ok: true, step: "http", httpStatus: 200, message: "" } }
    });

    const { result, request } = await runGatewayConnectionTest(built, run, { fallbackToTcp: true });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(request.mode).toBe(TestConnectionMode.WebApp);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("tls failure names the step and redacts the credential", async () => {
    const built = await buildHeaderTest();
    const run = stubGateway({
      ok: false,
      status: 502,
      errorMessage: "web app check failed",
      kind: null,
      payload: {
        result: { ok: false, step: "tls", message: `x509: certificate signed by unknown authority (sent ${TOKEN})` }
      }
    });

    const { result } = await runGatewayConnectionTest(built, run, { fallbackToTcp: true });

    expect(result).toMatchObject({ ok: false, kind: "transport" });
    const { errorMessage } = result as { errorMessage: string };
    expect(errorMessage).toBe(
      "Web App check failed at tls: x509: certificate signed by unknown authority (sent [redacted])"
    );
    expect(errorMessage).not.toContain(TOKEN);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("http failure names the step and the status the app answered", async () => {
    const built = await buildHeaderTest();
    const run = stubGateway({
      ok: true,
      status: 200,
      payload: { ok: false, step: "http", httpStatus: 500, message: "Internal Server Error" }
    });

    const { result } = await runGatewayConnectionTest(built, run, { fallbackToTcp: true });

    expect(result).toMatchObject({
      ok: false,
      errorMessage: "Web App check failed at http: the app answered HTTP 500 (Internal Server Error)"
    });
  });

  test("a gateway without the web-app mode falls back to the tcp result", async () => {
    const built = await buildHeaderTest();
    const run = stubGateway({
      ok: false,
      status: 400,
      errorMessage: 'unsupported test-connection mode: "web-app"',
      kind: null,
      payload: { error: { message: 'unsupported test-connection mode: "web-app"' } }
    });

    const { result, request } = await runGatewayConnectionTest(built, run, { fallbackToTcp: true });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(request).toEqual({ mode: TestConnectionMode.Tcp });
    expect(testVerifiesCredential(request)).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toMatchObject({ host: "app.internal.example", port: 443 });
  });

  test("an unrecognized answer falls back to tcp, and a failing tcp result still blocks", async () => {
    const built = await buildHeaderTest();
    const run = stubGateway(
      { ok: true, status: 200, payload: "not json" },
      { ok: false, status: 502, errorMessage: "dial tcp: connection refused", kind: "transport" }
    );

    const { result } = await runGatewayConnectionTest(built, run, { fallbackToTcp: true });

    expect(result).toMatchObject({ ok: false, errorMessage: "dial tcp: connection refused" });
  });

  test("without fallback an unsupported answer reads as missing gateway support", async () => {
    const built = await buildHeaderTest();
    const run = stubGateway({ ok: true, status: 200, payload: { result: { ok: false, step: "warp" } } });

    const { result } = await runGatewayConnectionTest(built, run, { fallbackToTcp: false });

    expect(result).toMatchObject({ ok: false, errorMessage: 'unsupported test-connection mode: "web-app"' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("an offline gateway skips rather than falling back", async () => {
    const built = await buildHeaderTest();
    const run = vi.fn(async () => null);

    const { result } = await runGatewayConnectionTest(built, run, { fallbackToTcp: true });

    expect(result).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
