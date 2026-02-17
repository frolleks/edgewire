import type { UserSummary } from "@discord/types";
import type { CurrentUser } from "@/lib/api";
import type { VoiceJoinPhase, VoicePeer } from "@/lib/voice/types";

export const LOCAL_TILE_SOCKET_ID = "local:self";

export type FocusedTile = {
  kind: "screenshare" | "participant";
  peerSocketId: string;
};

export type ViewMode = "focus" | "grid";

export type ScreenshareTileModel = {
  peerSocketId: string;
  name: string;
  stream: MediaStream | null;
  isLocal: boolean;
  starting: boolean;
};

export type ParticipantTileModel = {
  peerSocketId: string;
  user: UserSummary | null;
  displayName: string;
  avatarUrl: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  isLocal: boolean;
};

type BuildScreenshareTilesInput = {
  peersBySocketId: Record<string, VoicePeer>;
  remoteScreenStreams: Record<string, MediaStream>;
  localScreenStream: MediaStream | null;
  localScreenSharing: boolean;
  selfSocketId: string | null;
  selfUser?: CurrentUser;
};

type BuildParticipantTilesInput = {
  peersBySocketId: Record<string, VoicePeer>;
  selfSocketId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  selfUser?: CurrentUser;
};

export const buildScreenshareTiles = ({
  peersBySocketId,
  remoteScreenStreams,
  localScreenStream,
  localScreenSharing,
  selfSocketId,
  selfUser,
}: BuildScreenshareTilesInput): ScreenshareTileModel[] => {
  const remoteTiles = Object.values(peersBySocketId)
    .filter(
      (peer) =>
        Boolean(remoteScreenStreams[peer.socketId]) || peer.state.screen_sharing,
    )
    .map((peer) => ({
      peerSocketId: peer.socketId,
      name: peer.user.display_name,
      stream: remoteScreenStreams[peer.socketId] ?? null,
      isLocal: false,
      starting: peer.state.screen_sharing && !remoteScreenStreams[peer.socketId],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (localScreenSharing || localScreenStream) {
    remoteTiles.unshift({
      peerSocketId: selfSocketId ?? LOCAL_TILE_SOCKET_ID,
      name: selfUser?.display_name ? `${selfUser.display_name} (You)` : "Your screen",
      stream: localScreenStream,
      isLocal: true,
      starting: localScreenSharing && !localScreenStream,
    });
  }

  return remoteTiles;
};

export const buildParticipantTiles = ({
  peersBySocketId,
  selfSocketId,
  selfMute,
  selfDeaf,
  selfUser,
}: BuildParticipantTilesInput): ParticipantTileModel[] => {
  const localTile: ParticipantTileModel = {
    peerSocketId: selfSocketId ?? LOCAL_TILE_SOCKET_ID,
    user: selfUser ?? null,
    displayName: selfUser?.display_name ?? "You",
    avatarUrl: selfUser?.avatar_url ?? null,
    selfMute,
    selfDeaf,
    isLocal: true,
  };

  const remoteTiles = Object.values(peersBySocketId)
    .filter((peer) => peer.socketId !== selfSocketId)
    .map((peer) => ({
      peerSocketId: peer.socketId,
      user: peer.user,
      displayName: peer.user.display_name,
      avatarUrl: peer.user.avatar_url,
      selfMute: peer.state.self_mute,
      selfDeaf: peer.state.self_deaf,
      isLocal: false,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return [localTile, ...remoteTiles];
};

export const matchesFocusedTile = (
  focusedTile: FocusedTile | null,
  kind: FocusedTile["kind"],
  peerSocketId: string,
): boolean =>
  Boolean(
    focusedTile &&
      focusedTile.kind === kind &&
      focusedTile.peerSocketId === peerSocketId,
  );

export const connectionStateFromPhase = (
  phase: VoiceJoinPhase,
): { label: "Connecting" | "Connected" | "Reconnecting"; tone: "muted" | "ok" | "warn" } => {
  if (phase === "connected") {
    return { label: "Connected", tone: "ok" };
  }
  if (phase === "reconnecting") {
    return { label: "Reconnecting", tone: "warn" };
  }
  return { label: "Connecting", tone: "muted" };
};
