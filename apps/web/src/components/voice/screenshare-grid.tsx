import { useMemo, useState } from "react";
import type { VoicePeer } from "@/lib/voice/types";
import ScreenshareTile from "./screenshare-tile";

type ScreenshareGridProps = {
  remoteStreams: Record<string, MediaStream>;
  peersBySocketId: Record<string, VoicePeer>;
  localStream: MediaStream | null;
};

export function ScreenshareGrid({ remoteStreams, peersBySocketId, localStream }: ScreenshareGridProps) {
  const tiles = useMemo(() => {
    const remote = Object.entries(remoteStreams).map(([socketId, stream]) => ({
      id: socketId,
      label: peersBySocketId[socketId]?.user.display_name ?? "Screen share",
      stream,
    }));

    if (localStream) {
      remote.unshift({
        id: "local",
        label: "Your screen",
        stream: localStream,
      });
    }

    return remote;
  }, [localStream, peersBySocketId, remoteStreams]);

  const [focusedId, setFocusedId] = useState<string | null>(null);

  if (tiles.length === 0) {
    return null;
  }

  const activeId = focusedId && tiles.some(tile => tile.id === focusedId) ? focusedId : tiles[0]?.id;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {tiles.map(tile => (
        <ScreenshareTile
          key={tile.id}
          id={tile.id}
          label={tile.label}
          stream={tile.stream}
          focused={tile.id === activeId}
          onFocus={() => setFocusedId(tile.id)}
        />
      ))}
    </div>
  );
}

export default ScreenshareGrid;
