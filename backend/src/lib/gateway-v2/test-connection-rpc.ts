import { postGatewayRpc } from "./gateway-rpc";

// Older gateways send no kind, which the caller must treat as unclassified rather than as either outcome.
export type GatewayFailureKind = "auth" | "transport" | "unknown";

// payload is the parsed response body, for modes whose answer carries more than the HTTP status
export type TestConnectionResponse =
  | { ok: true; status: number; payload?: unknown }
  | { ok: false; status: number; errorMessage: string; kind: GatewayFailureKind | null; payload?: unknown };

export const TEST_CONNECTION_RPC_TIMEOUT_MS = 60_000;

const MAX_RPC_RESPONSE_BYTES = 1024 * 1024;

// calls the gateway's /v1/test-connection handler with an opaque request body
export const callTestConnection = async (args: {
  port: number;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<TestConnectionResponse> => {
  const { status, text } = await postGatewayRpc({
    port: args.port,
    path: "/v1/test-connection",
    payload: JSON.stringify({ ...args.body, timeoutMs: args.timeoutMs }),
    timeoutMs: TEST_CONNECTION_RPC_TIMEOUT_MS,
    maxResponseBytes: MAX_RPC_RESPONSE_BYTES,
    signal: args.signal,
    label: "Test connection"
  });

  const payload = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();

  if (status >= 200 && status < 300) return { ok: true, status, payload };

  const errEnv = (payload as { error?: { message?: string; kind?: GatewayFailureKind } } | undefined)?.error;
  return {
    ok: false,
    status,
    errorMessage: errEnv?.message ?? `Gateway returned HTTP ${status}`,
    kind: errEnv?.kind ?? null,
    payload
  };
};
