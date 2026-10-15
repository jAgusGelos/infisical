import { decodeWebAppReconnectLease, encodeWebAppReconnectLease, getReconnectDecision } from "./pam-web-app-reconnect";

const session = (overrides: Partial<Parameters<typeof getReconnectDecision>[0]["session"]> = {}) => ({
  id: "session-1",
  userId: "user-1",
  accountId: "account-1",
  status: "active",
  expiresAt: new Date(2_000),
  ...overrides
});

describe("Web App reconnect lease", () => {
  test("reattaches the same user and account to the existing session", () => {
    const lease = { sessionId: "session-1", state: "grace" as const };
    expect(
      getReconnectDecision({ lease, session: session(), userId: "user-1", accountId: "account-1", now: 1_000 })
    ).toBe("reattach");
  });

  test("rejects a conflicting viewer while the link is attached", () => {
    expect(
      getReconnectDecision({
        lease: { sessionId: "session-1", state: "attached" },
        session: session(),
        userId: "user-1",
        accountId: "account-1",
        now: 1_000
      })
    ).toBe("session_in_use");
    expect(
      getReconnectDecision({
        lease: { sessionId: "session-1", state: "attached" },
        session: session({ status: "ended" }),
        userId: "user-1",
        accountId: "account-1"
      })
    ).toBe("expired");
  });

  test("expires a grace lease when its session is ended, expired, or belongs to another user", () => {
    expect(
      getReconnectDecision({
        lease: { sessionId: "session-1", state: "grace" },
        session: session({ status: "ended" }),
        userId: "user-1",
        accountId: "account-1"
      })
    ).toBe("expired");
    expect(
      getReconnectDecision({
        lease: { sessionId: "session-1", state: "grace" },
        session: session(),
        userId: "user-2",
        accountId: "account-1"
      })
    ).toBe("expired");
    expect(
      getReconnectDecision({
        lease: { sessionId: "session-1", state: "grace" },
        session: session(),
        userId: "user-1",
        accountId: "account-1",
        now: 2_000
      })
    ).toBe("expired");
  });

  test("round-trips the Redis lease and resets the wire sequence independently", () => {
    const encoded = encodeWebAppReconnectLease({ sessionId: "session-1", state: "grace" });
    expect(decodeWebAppReconnectLease(encoded)).toEqual({ sessionId: "session-1", state: "grace" });
  });
});
