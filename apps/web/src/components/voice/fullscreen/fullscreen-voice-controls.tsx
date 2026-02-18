import {
  AlertTriangle,
  Headphones,
  List,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  PhoneOff,
  Signal,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VoiceConnectionStatus } from "@/lib/voice/types";

type FullscreenVoiceControlsProps = {
  status: VoiceConnectionStatus;
  selfState: { muted: boolean; deafened: boolean; screensharing: boolean };
  audioPlaybackBlocked: boolean;
  canScreenshare: boolean;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onStartScreenshare: () => void;
  onStopScreenshare: () => void;
  onDisconnect: () => void;
  onEnableAudioPlayback: () => void;
  onToggleFilmstrip?: () => void;
  onOpenChannels?: () => void;
  onToggleBrowserFullscreen?: () => void;
  onRetryMicrophone?: () => void;
  filmstripVisible?: boolean;
  isBrowserFullscreen?: boolean;
};

type ConnectionPillState = {
  label: "Connecting" | "Connected" | "Reconnecting" | "Failed";
  toneClass: string;
  icon: "spinner" | "dot" | "warning";
};

const connectionPillFromPhase = (
  phase: VoiceConnectionStatus["phase"],
): ConnectionPillState => {
  if (phase === "connected") {
    return {
      label: "Connected",
      toneClass: "border-emerald-300/30 bg-emerald-500/20 text-emerald-100",
      icon: "dot",
    };
  }
  if (phase === "reconnecting") {
    return {
      label: "Reconnecting",
      toneClass: "border-amber-300/30 bg-amber-500/20 text-amber-100",
      icon: "spinner",
    };
  }
  if (phase === "failed") {
    return {
      label: "Failed",
      toneClass: "border-red-300/40 bg-red-500/20 text-red-100",
      icon: "warning",
    };
  }
  return {
    label: "Connecting",
    toneClass: "border-border/60 bg-background/60 text-muted-foreground",
    icon: "spinner",
  };
};

export function FullscreenVoiceControls({
  status,
  selfState,
  audioPlaybackBlocked,
  canScreenshare,
  onToggleMute,
  onToggleDeafen,
  onStartScreenshare,
  onStopScreenshare,
  onDisconnect,
  onEnableAudioPlayback,
  onToggleFilmstrip,
  onOpenChannels,
  onToggleBrowserFullscreen,
  onRetryMicrophone,
  filmstripVisible = true,
  isBrowserFullscreen = false,
}: FullscreenVoiceControlsProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const pill = useMemo(
    () => connectionPillFromPhase(status.phase),
    [status.phase],
  );
  const disableToggleButtons =
    status.phase === "failed" || status.phase === "idle";
  const disableScreenshare =
    status.phase !== "connected" || !canScreenshare;
  const showMicWarning = status.media.mic === "denied";
  const screenshareLabel = selfState.screensharing ? "Stop Share" : "Share";

  return (
    <div className="w-[min(96vw,980px)] rounded-2xl border border-border/50 bg-background/70 px-3 py-2 shadow-xl backdrop-blur-md sm:px-4">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 justify-center">
        <div
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium",
            pill.toneClass,
          )}
        >
          {pill.icon === "spinner" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : pill.icon === "warning" ? (
            <AlertTriangle className="size-3.5" />
          ) : (
            <span className="size-2 rounded-full bg-current" />
          )}
          <span>{pill.label}</span>
          {typeof status.ws.rttMs === "number" ? (
            <span className="inline-flex items-center gap-1 opacity-90">
              <Signal className="size-3" />
              {Math.round(status.ws.rttMs)} ms
            </span>
          ) : null}
        </div>

        {status.error ? (
          <div className="relative">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Voice error details"
              onClick={() => setDetailsOpen((open) => !open)}
            >
              <AlertTriangle className="size-4 text-amber-300" />
            </Button>
            {detailsOpen ? (
              <div className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-lg border border-border/60 bg-popover p-3 text-xs shadow-lg">
                <p className="font-semibold">Connection details</p>
                <p className="mt-1 text-muted-foreground">
                  {status.error.message}
                </p>
                {status.error.detail ? (
                  <p className="mt-1 text-muted-foreground">{status.error.detail}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="h-6 w-px bg-border/70" />

        <Button
          type="button"
          variant={selfState.muted ? "secondary" : "outline"}
          size="sm"
          aria-label={selfState.muted ? "Unmute microphone" : "Mute microphone"}
          disabled={disableToggleButtons}
          onClick={onToggleMute}
          className={cn(
            "gap-2",
            selfState.muted &&
              "border-red-500/50 bg-red-500/15 text-red-100 hover:bg-red-500/20",
          )}
        >
          {selfState.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          <span className="hidden sm:inline">
            {selfState.muted ? "Unmute" : "Mute"}
          </span>
        </Button>

        <Button
          type="button"
          variant={selfState.deafened ? "secondary" : "outline"}
          size="sm"
          aria-label={selfState.deafened ? "Undeafen" : "Deafen"}
          disabled={disableToggleButtons}
          onClick={onToggleDeafen}
          className={cn(
            "gap-2",
            selfState.deafened &&
              "border-red-500/50 bg-red-500/15 text-red-100 hover:bg-red-500/20",
          )}
        >
          <Headphones className="size-4" />
          <span className="hidden sm:inline">
            {selfState.deafened ? "Undeafen" : "Deafen"}
          </span>
        </Button>

        <Button
          type="button"
          variant={selfState.screensharing ? "secondary" : "outline"}
          size="sm"
          aria-label={
            selfState.screensharing
              ? "Stop screen sharing"
              : "Start screen sharing"
          }
          disabled={disableScreenshare}
          onClick={
            selfState.screensharing ? onStopScreenshare : onStartScreenshare
          }
          className={cn(
            "gap-2",
            selfState.screensharing &&
              "border-emerald-500/50 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/20",
          )}
        >
          <MonitorUp className="size-4" />
          <span className="hidden sm:inline">{screenshareLabel}</span>
        </Button>

        <Button
          type="button"
          variant="destructive"
          size="sm"
          aria-label="Disconnect voice"
          onClick={onDisconnect}
          className="gap-2"
        >
          <PhoneOff className="size-4" />
          <span className="hidden sm:inline">Disconnect</span>
        </Button>

        {onToggleFilmstrip || onOpenChannels || onToggleBrowserFullscreen ? (
          <>
            <div className="h-6 w-px bg-border/70" />

            {onToggleFilmstrip ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={filmstripVisible ? "Hide filmstrip" : "Show filmstrip"}
                onClick={onToggleFilmstrip}
              >
                <Users className="size-4" />
              </Button>
            ) : null}

            {onOpenChannels ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Open channels list"
                onClick={onOpenChannels}
              >
                <List className="size-4" />
              </Button>
            ) : null}

            {onToggleBrowserFullscreen ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={
                  isBrowserFullscreen ? "Exit fullscreen" : "Enter fullscreen"
                }
                onClick={onToggleBrowserFullscreen}
              >
                {isBrowserFullscreen ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {showMicWarning ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-1 text-xs text-amber-200">
          <AlertTriangle className="size-3.5" />
          <span>Microphone blocked, listening only</span>
          {onRetryMicrophone ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onRetryMicrophone}
              aria-label="Retry microphone access"
            >
              Retry Mic
            </Button>
          ) : null}
        </div>
      ) : null}
      {audioPlaybackBlocked ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-1 text-xs text-amber-200">
          <AlertTriangle className="size-3.5" />
          <span>Audio playback is blocked by the browser.</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onEnableAudioPlayback}
            aria-label="Enable voice audio playback"
          >
            Enable Audio
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default FullscreenVoiceControls;
