import { ReactNode, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

type Props<T> = {
  rows: T[];
  activeIndex: number;
  autoFollow: boolean;
  estimateSize: number;
  getKey: (row: T) => string;
  renderRow: (row: T, isActive: boolean) => ReactNode;
  ariaLabel: string;
};

export const VirtualRowList = <T,>({
  rows,
  activeIndex,
  autoFollow,
  estimateSize,
  getKey,
  renderRow,
  ariaLabel
}: Props<T>) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (i) => getKey(rows[i]),
    overscan: 12
  });

  useEffect(() => {
    if (autoFollow && activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "center" });
  }, [autoFollow, activeIndex, virtualizer]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto" role="list" aria-label={ariaLabel}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            role="listitem"
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {renderRow(rows[item.index], item.index === activeIndex)}
          </div>
        ))}
      </div>
    </div>
  );
};
