import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VoiceJoinPhase } from "@/lib/voice/types";
import { connectionStateFromPhase } from "./voice-layout-utils";

type VoiceTopbarProps = {
  channelName: string;
  phase: VoiceJoinPhase;
  onBackToTextChannel: () => void;
};

const badgeToneClass: Record<"muted" | "ok" | "warn", string> = {
  muted: "border-border/60 bg-background/60 text-muted-foreground",
  ok: "border-emerald-300/30 bg-emerald-500/20 text-emerald-100",
  warn: "border-amber-300/30 bg-amber-500/20 text-amber-100",
};

export function VoiceTopbar({
  channelName,
  phase,
  onBackToTextChannel,
}: VoiceTopbarProps) {
  const connectionState = connectionStateFromPhase(phase);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 p-4">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border/40 bg-background/55 px-3 py-2 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-foreground/90"
            onClick={onBackToTextChannel}
            aria-label="Back to text channel"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{channelName}</p>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeToneClass[connectionState.tone]}`}
            >
              {connectionState.label}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VoiceTopbar;
