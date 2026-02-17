import { ArrowLeft, List } from "lucide-react";
import { useEffect } from "react";
import type { GuildChannelPayload, UserSummary } from "@discord/types";
import type { CurrentUser } from "@/lib/api";
import type { useVoice } from "@/lib/voice/use-voice";
import { Button } from "@/components/ui/button";
import VoiceControls from "./voice-controls";
import VoiceEmptyState from "./voice-empty-state";
import VoiceStage from "./voice-stage";

type VoiceChannelViewProps = {
  guildId: string;
  channel: GuildChannelPayload;
  me: CurrentUser | undefined;
  voice: ReturnType<typeof useVoice>;
  canConnect: boolean;
  onBack: () => void;
  onOpenChannelsOverlay: () => void;
  onOpenProfile: (user: UserSummary) => void;
};

export function VoiceChannelView({
  guildId,
  channel,
  me,
  voice,
  canConnect,
  onBack,
  onOpenChannelsOverlay,
  onOpenProfile,
}: VoiceChannelViewProps) {
  useEffect(() => {
    if (!canConnect) {
      return;
    }

    if (
      voice.channelId === channel.id &&
      voice.status.phase !== "idle" &&
      voice.status.phase !== "failed"
    ) {
      return;
    }

    if (
      voice.status.phase === "idle" &&
      voice.lastDisconnectedChannelId === channel.id
    ) {
      return;
    }

    if (voice.joiningChannelId === channel.id) {
      return;
    }

    void voice.joinGuildVoice(guildId, channel.id, channel.name);
  }, [
    canConnect,
    channel.id,
    channel.name,
    guildId,
    voice.channelId,
    voice.connected,
    voice.joinGuildVoice,
    voice.joiningChannelId,
    voice.lastDisconnectedChannelId,
    voice.status.phase,
  ]);

  if (!canConnect) {
    return (
      <VoiceEmptyState
        title="Cannot join voice"
        message="You do not have permission to connect to this voice channel."
        onBack={onBack}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="h-14 shrink-0 border-b px-4 flex items-center justify-between bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to text channel">
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{channel.name}</p>
            <p className="truncate text-xs text-muted-foreground">{voice.status.phase}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOpenChannelsOverlay} aria-label="Open channels">
            <List className="size-4" />
            Channels
          </Button>
          {me ? <p className="text-xs text-muted-foreground hidden sm:block">Signed in as {me.display_name}</p> : null}
        </div>
      </header>

      <VoiceStage
        peers={voice.participants}
        peersBySocketId={voice.peers}
        remoteScreenStreams={voice.screenStreams}
        localScreenStream={voice.localScreenStream}
        onOpenProfile={onOpenProfile}
      />

      <VoiceControls
        channelName={channel.name}
        selfMute={voice.selfMute}
        selfDeaf={voice.selfDeaf}
        screenSharing={voice.screenSharing}
        status={voice.status}
        onToggleMute={voice.toggleMute}
        onToggleDeafen={voice.toggleDeafen}
        onToggleScreenshare={() => void voice.toggleScreenshare()}
        onDisconnect={voice.disconnect}
        onRetry={voice.retryJoin}
        onRetryMicrophone={() => void voice.retryMicrophone()}
      />
    </div>
  );
}

export default VoiceChannelView;
