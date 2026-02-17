import { Headphones, MicOff } from "lucide-react";
import { getDisplayInitial } from "@/components/utils/format";
import type { VoicePeer } from "@/lib/voice/types";

type VoiceMemberTileProps = {
  peer: VoicePeer;
  onOpenProfile: () => void;
};

export function VoiceMemberTile({ peer, onOpenProfile }: VoiceMemberTileProps) {
  return (
    <button
      type="button"
      onClick={onOpenProfile}
      className="rounded-lg border bg-card p-3 text-left hover:bg-accent"
    >
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 overflow-hidden rounded-full bg-muted grid place-items-center text-xs font-semibold uppercase">
          {peer.user.avatar_url ? (
            <img src={peer.user.avatar_url} alt={`${peer.user.display_name} avatar`} className="h-full w-full object-cover" />
          ) : (
            getDisplayInitial(peer.user.display_name)
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{peer.user.display_name}</p>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {peer.state.self_mute ? <MicOff className="size-3.5" /> : null}
            {peer.state.self_deaf ? <Headphones className="size-3.5" /> : null}
            {!peer.state.self_mute && !peer.state.self_deaf ? <span>Listening</span> : null}
          </div>
        </div>
      </div>
    </button>
  );
}

export default VoiceMemberTile;
