import { Headphones, Mic, MicOff, MonitorUp, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { voicePhaseLabel, voiceStatusDetail } from "./voice-utils";
import type { VoiceConnectionStatus } from "@/lib/voice/types";

type VoiceControlsProps = {
  channelName: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  screenSharing: boolean;
  audioPlaybackBlocked: boolean;
  status: VoiceConnectionStatus;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenshare: () => void;
  onDisconnect: () => void;
  onRetry: () => void;
  onRetryMicrophone: () => void;
  onEnableAudioPlayback: () => void;
};

export function VoiceControls({
  channelName,
  selfMute,
  selfDeaf,
  screenSharing,
  audioPlaybackBlocked,
  status,
  onToggleMute,
  onToggleDeafen,
  onToggleScreenshare,
  onDisconnect,
  onRetry,
  onRetryMicrophone,
  onEnableAudioPlayback,
}: VoiceControlsProps) {
  return (
    <div className="shrink-0 border-t bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {voicePhaseLabel(status.phase)}{channelName ? ` · ${channelName}` : ""}
          </p>
          <p className="truncate text-xs text-muted-foreground">{voiceStatusDetail(status)}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant={selfMute ? "secondary" : "outline"} size="icon-sm" onClick={onToggleMute} aria-label="Toggle mute">
            {selfMute ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </Button>
          <Button variant={selfDeaf ? "secondary" : "outline"} size="icon-sm" onClick={onToggleDeafen} aria-label="Toggle deafen">
            <Headphones className="size-4" />
          </Button>
          <Button
            variant={screenSharing ? "secondary" : "outline"}
            size="icon-sm"
            onClick={onToggleScreenshare}
            disabled={status.phase !== "connected"}
            aria-label="Toggle screenshare"
          >
            <MonitorUp className="size-4" />
          </Button>
          <Button variant="destructive" size="icon-sm" onClick={onDisconnect} aria-label="Disconnect voice">
            <PhoneOff className="size-4" />
          </Button>
          {status.phase === "failed" ? (
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          ) : null}
          {status.media.mic === "denied" ? (
            <Button variant="outline" size="sm" onClick={onRetryMicrophone}>Retry microphone</Button>
          ) : null}
          {audioPlaybackBlocked ? (
            <Button variant="outline" size="sm" onClick={onEnableAudioPlayback}>Enable audio</Button>
          ) : null}
        </div>
      </div>
      {status.error ? <p className="mt-2 text-xs text-destructive">{status.error.message}</p> : null}
    </div>
  );
}

export default VoiceControls;
