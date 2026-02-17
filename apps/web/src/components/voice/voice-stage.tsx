import type { UserSummary } from "@discord/types";
import type { VoicePeer } from "@/lib/voice/types";
import ScreenshareGrid from "./screenshare-grid";
import VoiceMemberGrid from "./voice-member-grid";

type VoiceStageProps = {
  peers: VoicePeer[];
  peersBySocketId: Record<string, VoicePeer>;
  remoteScreenStreams: Record<string, MediaStream>;
  localScreenStream: MediaStream | null;
  onOpenProfile: (user: UserSummary) => void;
};

export function VoiceStage({
  peers,
  peersBySocketId,
  remoteScreenStreams,
  localScreenStream,
  onOpenProfile,
}: VoiceStageProps) {
  const hasScreenshares = Object.keys(remoteScreenStreams).length > 0 || Boolean(localScreenStream);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      {hasScreenshares ? (
        <ScreenshareGrid
          remoteStreams={remoteScreenStreams}
          peersBySocketId={peersBySocketId}
          localStream={localScreenStream}
        />
      ) : null}
      <VoiceMemberGrid peers={peers} onOpenProfile={onOpenProfile} />
    </div>
  );
}

export default VoiceStage;
