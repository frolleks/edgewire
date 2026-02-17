import ParticipantTile from "./participant-tile";
import ScreenshareTile from "./screenshare-tile";
import type {
  FocusedTile,
  ParticipantTileModel,
  ScreenshareTileModel,
} from "./voice-layout-utils";
import { matchesFocusedTile } from "./voice-layout-utils";

type VoiceFilmstripProps = {
  screenshareTiles: ScreenshareTileModel[];
  participantTiles: ParticipantTileModel[];
  speakingByPeer: Record<string, boolean>;
  focusedTile: FocusedTile | null;
  onSelectTile: (tile: FocusedTile) => void;
};

export function VoiceFilmstrip({
  screenshareTiles,
  participantTiles,
  speakingByPeer,
  focusedTile,
  onSelectTile,
}: VoiceFilmstripProps) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 border-t border-border/40 bg-card/75 backdrop-blur-md">
      <div className="flex h-36 items-center gap-3 overflow-x-auto overflow-y-visible px-4 py-3 sm:px-6">
        {screenshareTiles.map((tile) => (
          <ScreenshareTile
            key={`screenshare:${tile.peerSocketId}`}
            tile={tile}
            focused={matchesFocusedTile(focusedTile, "screenshare", tile.peerSocketId)}
            isSpeaking={Boolean(speakingByPeer[tile.peerSocketId])}
            onSelect={() =>
              onSelectTile({ kind: "screenshare", peerSocketId: tile.peerSocketId })
            }
          />
        ))}

        {participantTiles.map((tile) => (
          <ParticipantTile
            key={`participant:${tile.peerSocketId}`}
            tile={tile}
            focused={matchesFocusedTile(focusedTile, "participant", tile.peerSocketId)}
            isSpeaking={Boolean(speakingByPeer[tile.peerSocketId])}
            onSelect={() =>
              onSelectTile({ kind: "participant", peerSocketId: tile.peerSocketId })
            }
          />
        ))}
      </div>
    </div>
  );
}

export default VoiceFilmstrip;
