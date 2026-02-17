import { Headphones, MicOff } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getDisplayInitial } from "@/components/utils/format";
import { cn } from "@/lib/utils";
import { speakingRingClass } from "./speaking-ring";
import type { ParticipantTileModel } from "./voice-layout-utils";
import VoiceTile from "./voice-tile";

type ParticipantTileProps = {
  tile: ParticipantTileModel;
  focused: boolean;
  isSpeaking: boolean;
  onSelect: () => void;
};

export function ParticipantTile({
  tile,
  focused,
  isSpeaking,
  onSelect,
}: ParticipantTileProps) {
  const showMute = tile.selfMute;
  const showDeaf = tile.selfDeaf;

  return (
    <VoiceTile
      active={focused}
      onSelect={onSelect}
      className={cn(speakingRingClass(isSpeaking))}
    >
      <div className="flex h-full flex-col items-center justify-center gap-2 px-3">
        <Avatar className="size-12 border border-border/60">
          {tile.avatarUrl ? <AvatarImage src={tile.avatarUrl} alt={`${tile.displayName} avatar`} /> : null}
          <AvatarFallback>{getDisplayInitial(tile.displayName)}</AvatarFallback>
        </Avatar>
        <p className="w-full truncate text-center text-xs font-medium">{tile.displayName}</p>
        <div className="flex min-h-4 items-center justify-center gap-1 text-muted-foreground">
          {showMute ? <MicOff className="size-3.5" /> : null}
          {showDeaf ? <Headphones className="size-3.5" /> : null}
        </div>
      </div>

      {tile.isLocal ? (
        <span className="absolute right-2 top-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          You
        </span>
      ) : null}
    </VoiceTile>
  );
}

export default ParticipantTile;
