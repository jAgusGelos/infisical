import { PamSessionStatus } from "../pam/pam-enums";

export type TWebAppReconnectLease = { sessionId: string; state: "attached" | "grace" };

export type TReconnectableSession = {
  id: string;
  userId?: string | null;
  accountId?: string | null;
  status: string;
  expiresAt: Date;
};

export const encodeWebAppReconnectLease = (lease: TWebAppReconnectLease) => JSON.stringify(lease);

export const decodeWebAppReconnectLease = (value: string | null): TWebAppReconnectLease | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as TWebAppReconnectLease;
    return parsed.sessionId && (parsed.state === "attached" || parsed.state === "grace") ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const getReconnectDecision = ({
  lease,
  session,
  userId,
  accountId,
  now = Date.now()
}: {
  lease?: TWebAppReconnectLease;
  session?: TReconnectableSession;
  userId: string;
  accountId: string;
  now?: number;
}) => {
  if (!lease) return "new" as const;
  const sessionIsInvalid =
    !session ||
    session.id !== lease.sessionId ||
    session.userId !== userId ||
    session.accountId !== accountId ||
    ![PamSessionStatus.Starting, PamSessionStatus.Active].includes(session.status as PamSessionStatus) ||
    session.expiresAt.getTime() <= now;
  if (sessionIsInvalid) {
    return "expired" as const;
  }
  if (lease.state === "attached") return "session_in_use" as const;
  return "reattach" as const;
};
