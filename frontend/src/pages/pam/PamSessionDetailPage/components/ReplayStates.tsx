import { Link } from "@tanstack/react-router";
import { CopyIcon, KeyRoundIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton
} from "@app/components/v3";

export const RECORDING_UNAVAILABLE_TITLE = "Recording unavailable: decryption failed";

export const ReplayLoadingState = ({ done, total }: { done: number; total: number }) => (
  <div className="flex flex-col gap-3" data-testid="replay-loading">
    <p className="text-sm text-muted" role="status">
      {total > 0 ? `Verifying chunk ${done} of ${total}` : "Loading recording"}
    </p>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]">
      <Skeleton className="aspect-video w-full" />
      <Skeleton className="h-full min-h-48 w-full" />
    </div>
    <Skeleton className="h-28 w-full" />
  </div>
);

export type TReplayErrorDetails = { step: string; objectIndex?: number; message: string };

export const ReplayErrorState = ({
  orgId,
  details,
  onRetry,
  onCopy
}: {
  orgId: string;
  details: TReplayErrorDetails;
  onRetry: () => void;
  onCopy: () => void;
}) => (
  <Empty className="border" data-testid="replay-error">
    <EmptyHeader>
      <EmptyTitle>{RECORDING_UNAVAILABLE_TITLE}</EmptyTitle>
      <EmptyDescription>{details.message}</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon />
          Retry decryption
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link
            to="/organizations/$orgId/settings"
            params={{ orgId }}
            search={{ selectedTab: "tab-org-encryption" }}
          >
            <KeyRoundIcon />
            Open KMS settings
          </Link>
        </Button>
        <Button variant="ghost" size="sm" onClick={onCopy}>
          <CopyIcon />
          Copy error details
        </Button>
      </div>
    </EmptyContent>
  </Empty>
);

export const ReplayEmptyState = ({
  title,
  description
}: {
  title: string;
  description?: string;
}) => (
  <Empty className="border" data-testid="replay-empty">
    <EmptyHeader>
      <EmptyTitle>{title}</EmptyTitle>
      {description && <EmptyDescription>{description}</EmptyDescription>}
    </EmptyHeader>
  </Empty>
);

export const IntegrityIssueBanner = ({
  variant,
  title,
  detail
}: {
  variant: "danger" | "warning";
  title: string;
  detail: string;
}) => (
  <Alert variant={variant} data-testid="integrity-issue">
    <ShieldAlertIcon />
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription>{detail}</AlertDescription>
  </Alert>
);

export const NotWebAppSessionState = ({ orgId }: { orgId: string }) => (
  <Empty className="mt-4 border">
    <EmptyHeader>
      <EmptyTitle>This view is for Web App sessions</EmptyTitle>
      <EmptyDescription>Open this session from the sessions list instead.</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <Button asChild variant="outline">
        <Link to="/organizations/$orgId/pam/sessions" params={{ orgId }}>
          Back to sessions
        </Link>
      </Button>
    </EmptyContent>
  </Empty>
);
