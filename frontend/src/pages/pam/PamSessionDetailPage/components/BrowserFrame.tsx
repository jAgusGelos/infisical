import { ReactNode } from "react";
import { GlobeIcon } from "lucide-react";

export const BROWSER_FRAME_CAPTION =
  "Video, network and input are recorded outside the user's device.";

type Props = {
  url: string | null;
  gateway: string;
  children: ReactNode;
};

export const BrowserFrame = ({ url, gateway, children }: Props) => (
  <figure className="flex flex-col overflow-hidden rounded-md border border-border bg-card">
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-sm bg-container px-2 py-1">
        <GlobeIcon className="size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate font-mono text-xs" data-testid="browser-frame-url">
          {url ?? "about:blank"}
        </span>
      </div>
      <span className="shrink-0 text-xs text-muted">via {gateway}</span>
    </div>
    <div className="bg-black">{children}</div>
    <figcaption className="border-t border-border px-3 py-2 text-xs text-muted">
      {BROWSER_FRAME_CAPTION}
    </figcaption>
  </figure>
);
