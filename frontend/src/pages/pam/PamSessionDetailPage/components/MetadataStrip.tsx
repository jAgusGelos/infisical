import { ReactNode } from "react";

export type TMetadataItem = { label: string; value: ReactNode; mono?: boolean };

export const MetadataStrip = ({ items }: { items: TMetadataItem[] }) => (
  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border border-border bg-card p-4 text-sm md:grid-cols-5 xl:grid-cols-9">
    {items.map((item) => (
      <div key={item.label} className="flex min-w-0 flex-col gap-1">
        <dt className="text-xs text-label">{item.label}</dt>
        <dd
          className={item.mono ? "truncate font-mono text-xs" : "truncate"}
          title={typeof item.value === "string" ? item.value : undefined}
        >
          {item.value}
        </dd>
      </div>
    ))}
  </dl>
);
