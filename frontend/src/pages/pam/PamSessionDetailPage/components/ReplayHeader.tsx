import { ReactNode } from "react";
import { CheckIcon, DownloadIcon, LinkIcon, Video } from "lucide-react";

import { Badge, Button, Tooltip, TooltipContent, TooltipTrigger } from "@app/components/v3";
import { PageHeader } from "@app/components/v3/platform";
import { ProjectType } from "@app/hooks/api/projects/types";

export type TIntegrityChipView = {
  label: string;
  variant: "success" | "warning" | "danger" | "neutral" | "info";
  detail?: string;
};

export const MARK_REVIEWED_UNAVAILABLE = "Review tracking is not available yet";
export const EXPORT_EVIDENCE_UNAVAILABLE = "Evidence export is not available yet";

const DisabledAction = ({ tooltip, children }: { tooltip: string; children: ReactNode }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      {/* A disabled button gets no pointer events, so the span carries the tooltip. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <span tabIndex={0} className="inline-flex">
        {children}
      </span>
    </TooltipTrigger>
    <TooltipContent>{tooltip}</TooltipContent>
  </Tooltip>
);

type Props = {
  title: string;
  status?: ReactNode;
  integrity: TIntegrityChipView;
  copyLinkLabel: string;
  onCopyLink: () => void;
  exportAction?: ReactNode;
};

export const ReplayHeader = ({
  title,
  status,
  integrity,
  copyLinkLabel,
  onCopyLink,
  exportAction
}: Props) => (
  <PageHeader
    scope={ProjectType.PAM}
    icon={Video}
    title={title}
    className="mb-4"
    description={
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral">Web App</Badge>
        {status}
        {integrity.detail ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={integrity.variant} data-testid="integrity-chip" tabIndex={0}>
                {integrity.label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{integrity.detail}</TooltipContent>
          </Tooltip>
        ) : (
          <Badge variant={integrity.variant} data-testid="integrity-chip">
            {integrity.label}
          </Badge>
        )}
      </span>
    }
  >
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" onClick={onCopyLink}>
        <LinkIcon />
        {copyLinkLabel}
      </Button>
      {exportAction ?? (
        <DisabledAction tooltip={EXPORT_EVIDENCE_UNAVAILABLE}>
          <Button variant="outline" size="sm" isDisabled>
            <DownloadIcon />
            Export evidence
          </Button>
        </DisabledAction>
      )}
      <DisabledAction tooltip={MARK_REVIEWED_UNAVAILABLE}>
        <Button variant="pam" size="sm" isDisabled>
          <CheckIcon />
          Mark reviewed
        </Button>
      </DisabledAction>
    </div>
  </PageHeader>
);
