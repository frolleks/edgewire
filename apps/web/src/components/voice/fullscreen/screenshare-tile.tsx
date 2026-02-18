import VoiceTile from "./voice-tile";
import { cn } from "@/lib/utils";
import { speakingRingClass } from "./speaking-ring";
import type { ScreenshareTileModel } from "./voice-layout-utils";

type ScreenshareTileProps = {
  tile: ScreenshareTileModel;
  focused: boolean;
  isSpeaking?: boolean;
  onSelect: () => void;
};

export function ScreenshareTile({
  tile,
  focused,
  isSpeaking = false,
  onSelect,
}: ScreenshareTileProps) {
  return (
    <VoiceTile
      active={focused}
      onSelect={onSelect}
      className={cn("w-52 border-border/30 bg-black/80", speakingRingClass(isSpeaking))}
    >
      {tile.stream ? (
        <video
          autoPlay
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          ref={(node) => {
            if (node && node.srcObject !== tile.stream) {
              node.srcObject = tile.stream;
            }
            if (node) {
              void node.play().catch(() => undefined);
            }
          }}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-muted/20">
          <div className="space-y-2 text-center">
            <div className="mx-auto h-2 w-20 animate-pulse rounded-full bg-muted/80" />
            <p className="text-xs text-muted-foreground">Starting...</p>
          </div>
        </div>
      )}

      <span className="absolute left-2 top-2 rounded-full border border-red-300/40 bg-red-600 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white">
        LIVE
      </span>

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-2 pt-6">
        <p className="truncate text-xs font-medium text-white">{tile.name}</p>
      </div>
    </VoiceTile>
  );
}

export default ScreenshareTile;
