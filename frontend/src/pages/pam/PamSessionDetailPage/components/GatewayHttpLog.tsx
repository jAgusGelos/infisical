import { useMemo, useState } from "react";
import { BanIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { Badge, Button } from "@app/components/v3";
import {
  filterL1Rows,
  formatSessionTime,
  rowIndexAt,
  TL1Filter,
  TL1Row
} from "@app/hooks/api/pam/web-app-replay";

import { VirtualRowList } from "./VirtualRowList";

const FILTERS: { id: TL1Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "writes", label: "Writes" },
  { id: "errors", label: "4xx/5xx" },
  { id: "blocked", label: "Blocked" }
];

const statusVariant = (row: TL1Row) => {
  if (row.kind === "blocked") return "danger" as const;
  if (row.status === null) return "neutral" as const;
  if (row.status >= 500) return "danger" as const;
  if (row.status >= 400) return "warning" as const;
  return "neutral" as const;
};

const HeaderTable = ({ headers }: { headers: [string, string][] }) =>
  headers.length ? (
    <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-xs">
      {headers.map(([name, value], i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={`${name}-${i}`} className="contents">
          <dt className="truncate text-muted">{name}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="text-xs text-muted">No headers</p>
  );

const RowDetail = ({ row }: { row: TL1Row }) => (
  <div className="flex flex-col gap-3 border-t border-border bg-container px-3 py-2">
    {row.blockedReason && <p className="text-xs">Reason: {row.blockedReason}</p>}
    <section className="flex flex-col gap-1">
      <h4 className="text-xs text-label">Request headers</h4>
      <HeaderTable headers={row.requestHeaders} />
    </section>
    {row.requestBody && (
      <section className="flex flex-col gap-1">
        <h4 className="text-xs text-label">Request body ({row.requestBodyBytes} bytes)</h4>
        <pre className="max-h-40 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
          {row.requestBody}
        </pre>
      </section>
    )}
    {row.kind === "request" && (
      <section className="flex flex-col gap-1">
        <h4 className="text-xs text-label">Response headers</h4>
        <HeaderTable headers={row.responseHeaders} />
      </section>
    )}
    {row.responseBody && (
      <section className="flex flex-col gap-1">
        <h4 className="text-xs text-label">Response body ({row.responseBodyBytes} bytes)</h4>
        <pre className="max-h-40 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
          {row.responseBody}
        </pre>
      </section>
    )}
    {row.truncated && <p className="text-xs text-muted">Body truncated by the gateway body cap.</p>}
  </div>
);

type Props = {
  rows: TL1Row[];
  playheadMs: number;
  autoFollow: boolean;
  onSeek: (sessionMs: number) => void;
};

export const GatewayHttpLog = ({ rows, playheadMs, autoFollow, onSeek }: Props) => {
  const [filter, setFilter] = useState<TL1Filter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const visible = useMemo(() => filterL1Rows(rows, filter), [rows, filter]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, filterL1Rows(rows, f.id).length])),
    [rows]
  );
  const activeIndex = rowIndexAt(visible, playheadMs);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Network filters">
        {FILTERS.map((f) => (
          <Button
            key={f.id}
            size="xs"
            variant={filter === f.id ? "neutral" : "ghost"}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            <span className="text-muted" data-testid={`l1-filter-count-${f.id}`}>
              {counts[f.id]}
            </span>
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 rounded-md border border-border">
        {visible.length === 0 ? (
          <p className="p-3 text-sm text-muted">No requests match this filter.</p>
        ) : (
          <VirtualRowList
            rows={visible}
            activeIndex={activeIndex}
            autoFollow={autoFollow}
            estimateSize={36}
            getKey={(r) => r.id}
            ariaLabel="Gateway network log"
            renderRow={(row, isActive) => {
              const isOpen = expanded.has(row.id);
              return (
                <div
                  className={isActive ? "bg-container-hover" : undefined}
                  data-active={isActive || undefined}
                >
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
                    <button
                      type="button"
                      className="text-muted hover:text-foreground"
                      aria-label={isOpen ? "Collapse request" : "Expand request"}
                      aria-expanded={isOpen}
                      onClick={() => toggle(row.id)}
                    >
                      {isOpen ? (
                        <ChevronDownIcon className="size-3.5" />
                      ) : (
                        <ChevronRightIcon className="size-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => onSeek(row.sessionMs)}
                    >
                      <span className="w-12 shrink-0 font-mono text-muted tabular-nums">
                        {formatSessionTime(row.sessionMs)}
                      </span>
                      <span className="w-14 shrink-0 font-mono">{row.method}</span>
                      <span className="min-w-0 flex-1 truncate font-mono">{row.url}</span>
                    </button>
                    {row.action && <Badge variant="info">{row.action.replace("_", " ")}</Badge>}
                    <Badge variant={statusVariant(row)}>
                      {row.kind === "blocked" ? (
                        <>
                          <BanIcon />
                          Blocked
                        </>
                      ) : (
                        (row.status ?? "...")
                      )}
                    </Badge>
                  </div>
                  {isOpen && <RowDetail row={row} />}
                </div>
              );
            }}
          />
        )}
      </div>
    </div>
  );
};
