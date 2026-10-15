import { Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { TInputRow } from "@app/hooks/api/pam/web-app-replay";

import { InputLog } from "./InputLog";

// The virtualizer measures a scroll element, which static markup never has: render every row instead.
vi.mock("./VirtualRowList", () => ({
  VirtualRowList: <T,>({
    rows,
    renderRow,
    getKey
  }: {
    rows: T[];
    renderRow: (row: T, isActive: boolean) => ReactNode;
    getKey: (row: T) => string;
  }) => (
    <div>
      {rows.map((r) => (
        <Fragment key={getKey(r)}>{renderRow(r, false)}</Fragment>
      ))}
    </div>
  )
}));

const inputRow = (over: Partial<TInputRow>): TInputRow => ({
  id: "l3-1",
  seq: 1,
  sessionMs: 0,
  kind: "keys",
  text: "Typed a",
  masked: false,
  droppedCount: 0,
  ...over
});

describe("InputLog", () => {
  test("marks masked input as typed into a secret field", () => {
    const html = renderToStaticMarkup(
      <InputLog
        rows={[
          inputRow({ id: "l3-1", text: "Typed [MASKED]", masked: true }),
          inputRow({ id: "l3-2", text: "Typed a" })
        ]}
        playheadMs={0}
        autoFollow={false}
        onSeek={() => undefined}
      />
    );
    expect(html.match(/Secret Field/g)).toHaveLength(1);
    expect(html.indexOf("Secret Field")).toBeLessThan(html.indexOf("Typed a"));
  });
});
