import { useState } from "react";

import { Label, Tabs, TabsContent, TabsList, TabsTrigger, Toggle } from "@app/components/v3";
import { TReplayTimeline } from "@app/hooks/api/pam/web-app-replay";

import { GatewayHttpLog } from "./GatewayHttpLog";
import { InputLog } from "./InputLog";

type Props = {
  timeline: TReplayTimeline;
  playheadMs: number;
  onSeek: (sessionMs: number) => void;
};

export const ReplaySidePanel = ({ timeline, playheadMs, onSeek }: Props) => {
  const [autoFollow, setAutoFollow] = useState(true);
  return (
    <Tabs defaultValue="network" className="flex h-full flex-col lg:absolute lg:inset-0">
      <TabsList variant="pam">
        <TabsTrigger value="network">Network ({timeline.l1Rows.length})</TabsTrigger>
        <TabsTrigger value="input">Input ({timeline.inputRows.length})</TabsTrigger>
      </TabsList>
      <div className="flex items-center justify-end gap-2 py-2">
        <Toggle id="auto-follow" size="sm" checked={autoFollow} onCheckedChange={setAutoFollow} />
        <Label htmlFor="auto-follow">Auto-follow playhead</Label>
      </div>
      <TabsContent value="network" className="min-h-0 flex-1">
        <GatewayHttpLog
          rows={timeline.l1Rows}
          playheadMs={playheadMs}
          autoFollow={autoFollow}
          onSeek={onSeek}
        />
      </TabsContent>
      <TabsContent value="input" className="min-h-0 flex-1">
        <InputLog
          rows={timeline.inputRows}
          playheadMs={playheadMs}
          autoFollow={autoFollow}
          onSeek={onSeek}
        />
      </TabsContent>
    </Tabs>
  );
};
