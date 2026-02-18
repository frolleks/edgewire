import type { UserSummary } from "@edgewire/types";
import { Headphones, MicOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getDisplayInitial } from "@/components/utils/format";
import { cn } from "@/lib/utils";
import type { CurrentUser } from "@/lib/api";
import type { useVoice } from "@/lib/voice/use-voice";
import FullscreenVoiceControls from "./fullscreen-voice-controls";
import VoiceEmptyState from "./voice-empty-state";
import VoiceFilmstrip from "./voice-filmstrip";
import {
  buildParticipantTiles,
  buildScreenshareTiles,
  connectionStateFromPhase,
  type FocusedTile,
  type ViewMode,
} from "./voice-layout-utils";
import { speakingRingClass } from "./speaking-ring";
import useVoiceActivity from "./use-voice-activity";
import VoiceStage from "./voice-stage";
import VoiceTopbar from "./voice-topbar";

type VoiceFullscreenViewProps = {
  guildId: string;
  channelId: string;
  channelName: string;
  canConnect: boolean;
  onBackToTextChannel: () => void;
  onOpenChannelsOverlay?: () => void;
  voice: ReturnType<typeof useVoice>;
  selfUser?: CurrentUser;
};

export function VoiceFullscreenView({
  guildId,
  channelId,
  channelName,
  canConnect,
  onBackToTextChannel,
  onOpenChannelsOverlay,
  voice,
  selfUser,
}: VoiceFullscreenViewProps) {
  const [focusedTile, setFocusedTile] = useState<FocusedTile | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [hideFilmstrip, setHideFilmstrip] = useState(false);
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false);

  const screenshareTiles = useMemo(
    () =>
      buildScreenshareTiles({
        peersBySocketId: voice.peers,
        remoteScreenStreams: voice.screenStreams,
        localScreenStream: voice.localScreenStream,
        localScreenSharing: voice.screenSharing,
        selfSocketId: voice.selfSocketId,
        selfUser,
      }),
    [
      selfUser,
      voice.localScreenStream,
      voice.peers,
      voice.screenSharing,
      voice.screenStreams,
      voice.selfSocketId,
    ],
  );

  const participantTiles = useMemo(
    () =>
      buildParticipantTiles({
        peersBySocketId: voice.peers,
        selfSocketId: voice.selfSocketId,
        selfMute: voice.selfMute,
        selfDeaf: voice.selfDeaf,
        selfUser,
      }),
    [
      selfUser,
      voice.peers,
      voice.selfDeaf,
      voice.selfMute,
      voice.selfSocketId,
    ],
  );

  const voiceActivityPeers = useMemo(
    () =>
      participantTiles.map((tile) => ({
        socketId: tile.peerSocketId,
        user:
          tile.user ??
          ({
            id: tile.peerSocketId,
            username: tile.displayName,
            display_name: tile.displayName,
            avatar_url: tile.avatarUrl,
          } satisfies UserSummary),
        isSelf: tile.isLocal,
      })),
    [participantTiles],
  );

  const { speakingByPeer } = useVoiceActivity({
    peers: voiceActivityPeers,
    remoteAudioStreamsByPeer: voice.remoteAudioStreams,
    localAudioStream: voice.localAudioStream ?? undefined,
  });

  const hasScreenshares = screenshareTiles.length > 0;
  const voiceChannelMatches =
    voice.channelId === channelId || voice.joiningChannelId === channelId;
  const phase = voiceChannelMatches ? voice.status.phase : "connecting_ws";
  const connectionState = connectionStateFromPhase(phase);
  const joinFailedForChannel =
    voice.status.phase === "failed" &&
    (voice.channelId === channelId || voice.joiningChannelId === channelId);
  const connectedToSelectedChannel =
    voice.channelId === channelId && voice.status.phase === "connected";
  const canScreenshare =
    voice.status.phase === "connected" &&
    typeof voice.toggleScreenshare === "function";

  useEffect(() => {
    const syncFullscreen = () => {
      setIsBrowserFullscreen(Boolean(document.fullscreenElement));
    };

    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
    };
  }, []);

  const onToggleBrowserFullscreen = useCallback(() => {
    const run = async (): Promise<void> => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return;
        }

        await document.documentElement.requestFullscreen();
      } catch {
        // Ignore fullscreen failures; this is a UI-only convenience action.
      }
    };

    void run();
  }, []);

  useEffect(() => {
    if (!canConnect) {
      return;
    }

    if (
      voice.channelId === channelId &&
      voice.status.phase !== "idle" &&
      voice.status.phase !== "failed"
    ) {
      return;
    }

    if (voice.status.phase === "leaving") {
      return;
    }

    if (voice.joiningChannelId === channelId) {
      return;
    }

    void voice.joinGuildVoice(guildId, channelId, channelName);
  }, [
    canConnect,
    channelId,
    channelName,
    guildId,
    voice.channelId,
    voice.joinGuildVoice,
    voice.joiningChannelId,
    voice.status.phase,
  ]);

  useEffect(() => {
    setFocusedTile(null);
    setViewMode(hasScreenshares ? "focus" : "grid");
    setHideFilmstrip(false);
  }, [channelId]);

  useEffect(() => {
    if (!focusedTile) {
      return;
    }

    const stillExists =
      focusedTile.kind === "screenshare"
        ? screenshareTiles.some(
            (tile) => tile.peerSocketId === focusedTile.peerSocketId,
          )
        : participantTiles.some(
            (tile) => tile.peerSocketId === focusedTile.peerSocketId,
          );

    if (stillExists) {
      return;
    }

    if (focusedTile.kind === "screenshare" && screenshareTiles[0]) {
      setFocusedTile({
        kind: "screenshare",
        peerSocketId: screenshareTiles[0].peerSocketId,
      });
      return;
    }

    setFocusedTile(null);
  }, [focusedTile, participantTiles, screenshareTiles]);

  useEffect(() => {
    if (!hasScreenshares) {
      return;
    }

    if (viewMode === "focus") {
      return;
    }

    if (focusedTile?.kind === "participant") {
      return;
    }

    setViewMode("focus");
  }, [focusedTile?.kind, hasScreenshares, viewMode]);

  useEffect(() => {
    if (viewMode !== "focus") {
      return;
    }

    if (!hasScreenshares) {
      if (!focusedTile || focusedTile.kind === "screenshare") {
        setViewMode("grid");
      }
      return;
    }

    if (focusedTile?.kind === "participant") {
      return;
    }

    if (
      focusedTile?.kind === "screenshare" &&
      screenshareTiles.some((tile) => tile.peerSocketId === focusedTile.peerSocketId)
    ) {
      return;
    }

    const firstScreenshare = screenshareTiles[0];
    if (firstScreenshare) {
      setFocusedTile({
        kind: "screenshare",
        peerSocketId: firstScreenshare.peerSocketId,
      });
    }
  }, [focusedTile, hasScreenshares, screenshareTiles, viewMode]);

  const focusedScreenshare = useMemo(() => {
    if (viewMode !== "focus") {
      return null;
    }
    if (focusedTile?.kind === "participant") {
      return null;
    }
    if (focusedTile?.kind === "screenshare") {
      return (
        screenshareTiles.find(
          (tile) => tile.peerSocketId === focusedTile.peerSocketId,
        ) ?? null
      );
    }
    return screenshareTiles[0] ?? null;
  }, [focusedTile, screenshareTiles, viewMode]);

  const focusedParticipant = useMemo(() => {
    if (viewMode !== "focus" || focusedTile?.kind !== "participant") {
      return null;
    }
    return (
      participantTiles.find(
        (tile) => tile.peerSocketId === focusedTile.peerSocketId,
      ) ?? null
    );
  }, [focusedTile, participantTiles, viewMode]);

  const isFocusedParticipantSpeaking = useMemo(
    () =>
      Boolean(
        focusedParticipant &&
          speakingByPeer[focusedParticipant.peerSocketId],
      ),
    [focusedParticipant, speakingByPeer],
  );

  const isFocusedScreenshareSpeaking = useMemo(
    () =>
      Boolean(
        focusedScreenshare && speakingByPeer[focusedScreenshare.peerSocketId],
      ),
    [focusedScreenshare, speakingByPeer],
  );

  if (!canConnect) {
    return (
      <VoiceEmptyState
        title="Cannot join voice"
        message="You do not have permission to connect to this voice channel."
        onBack={onBackToTextChannel}
      />
    );
  }

  if (joinFailedForChannel) {
    return (
      <VoiceEmptyState
        title="Could not join voice"
        message={voice.status.error?.message ?? "Could not join this channel."}
        onRetry={voice.retryJoin}
        onBack={onBackToTextChannel}
      />
    );
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background">
      <VoiceTopbar
        channelName={channelName}
        phase={phase}
        onBackToTextChannel={onBackToTextChannel}
      />

      <VoiceStage
        focusedScreenshare={focusedScreenshare}
        focusedParticipant={focusedParticipant}
        isFocusedScreenshareSpeaking={isFocusedScreenshareSpeaking}
        isFocusedParticipantSpeaking={isFocusedParticipantSpeaking}
        showFilmstrip={!hideFilmstrip}
        fallback={
          hasScreenshares ? (
            <div className="grid h-full place-items-center px-6 text-center">
              <p className="text-sm text-muted-foreground">
                Select a tile in the filmstrip to focus it on stage.
              </p>
            </div>
          ) : (
            <div className="mx-auto h-full w-full max-w-7xl overflow-y-auto">
              <div className="mb-4 px-1">
                <h2 className="text-lg font-semibold">No one is streaming</h2>
                <p className="text-sm text-muted-foreground">
                  Choose a member tile to focus a participant.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 pb-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
                {participantTiles.map((tile) => {
                  const isSpeaking = Boolean(speakingByPeer[tile.peerSocketId]);
                  return (
                    <button
                      key={`grid:${tile.peerSocketId}`}
                      type="button"
                      onClick={() => {
                        setFocusedTile({
                          kind: "participant",
                          peerSocketId: tile.peerSocketId,
                        });
                        setViewMode("focus");
                      }}
                      className={cn(
                        "rounded-2xl border border-border/40 bg-card/70 p-4 text-center transition hover:-translate-y-0.5 hover:border-border hover:shadow-lg",
                        speakingRingClass(isSpeaking),
                      )}
                    >
                      <Avatar className="mx-auto size-16 border border-border/60">
                        {tile.avatarUrl ? (
                          <AvatarImage src={tile.avatarUrl} alt={`${tile.displayName} avatar`} />
                        ) : null}
                        <AvatarFallback className="text-lg">
                          {getDisplayInitial(tile.displayName)}
                        </AvatarFallback>
                      </Avatar>
                      <p className="mt-3 truncate text-sm font-medium">
                        {tile.displayName}
                      </p>
                      <div className="mt-1 flex min-h-4 items-center justify-center gap-1 text-muted-foreground">
                        {tile.selfMute ? <MicOff className="size-3.5" /> : null}
                        {tile.selfDeaf ? <Headphones className="size-3.5" /> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )
        }
      />

      {!connectedToSelectedChannel ? (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <div className="rounded-full border border-border/50 bg-background/65 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur">
            {connectionState.label}
          </div>
        </div>
      ) : null}

      <div
        className={`pointer-events-none absolute left-1/2 z-30 w-full -translate-x-1/2 px-3 sm:px-4 ${hideFilmstrip ? "bottom-4 sm:bottom-6" : "bottom-[9.5rem] sm:bottom-40"}`}
      >
        <div className="pointer-events-auto mx-auto w-fit">
          <FullscreenVoiceControls
            status={voice.status}
            selfState={{
              muted: voice.selfMute,
              deafened: voice.selfDeaf,
              screensharing: voice.screenSharing,
            }}
            audioPlaybackBlocked={voice.audioPlaybackBlocked}
            canScreenshare={canScreenshare}
            onToggleMute={voice.toggleMute}
            onToggleDeafen={voice.toggleDeafen}
            onStartScreenshare={() => {
              void voice.toggleScreenshare();
            }}
            onStopScreenshare={() => {
              void voice.toggleScreenshare();
            }}
            onDisconnect={voice.disconnect}
            onEnableAudioPlayback={() => {
              void voice.enableAudioPlayback();
            }}
            onToggleFilmstrip={() => setHideFilmstrip((value) => !value)}
            onOpenChannels={onOpenChannelsOverlay}
            onToggleBrowserFullscreen={onToggleBrowserFullscreen}
            onRetryMicrophone={() => {
              void voice.retryMicrophone();
            }}
            filmstripVisible={!hideFilmstrip}
            isBrowserFullscreen={isBrowserFullscreen}
          />
        </div>
      </div>

      {!hideFilmstrip ? (
        <VoiceFilmstrip
          screenshareTiles={screenshareTiles}
          participantTiles={participantTiles}
          speakingByPeer={speakingByPeer}
          focusedTile={focusedTile}
          onSelectTile={(tile) => {
            setFocusedTile(tile);
            setViewMode("focus");
          }}
        />
      ) : null}
    </div>
  );
}

export default VoiceFullscreenView;
