import type { UserSummary } from "@discord/types";
import type { VoicePeer } from "@/lib/voice/types";
import VoiceMemberTile from "./voice-member-tile";

type VoiceMemberGridProps = {
  peers: VoicePeer[];
  onOpenProfile: (user: UserSummary) => void;
};

export function VoiceMemberGrid({ peers, onOpenProfile }: VoiceMemberGridProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {peers.map(peer => (
        <VoiceMemberTile key={peer.socketId} peer={peer} onOpenProfile={() => onOpenProfile(peer.user)} />
      ))}
    </div>
  );
}

export default VoiceMemberGrid;
