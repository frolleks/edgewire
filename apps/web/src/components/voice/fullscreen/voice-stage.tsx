import type { ReactNode } from "react";
import { Headphones, MicOff } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getDisplayInitial } from "@/components/utils/format";
import { cn } from "@/lib/utils";
import { speakingRingClass } from "./speaking-ring";
import type {
  ParticipantTileModel,
  ScreenshareTileModel,
} from "./voice-layout-utils";

type VoiceStageProps = {
  focusedScreenshare: ScreenshareTileModel | null;
  focusedParticipant: ParticipantTileModel | null;
  isFocusedScreenshareSpeaking?: boolean;
  isFocusedParticipantSpeaking?: boolean;
  fallback: ReactNode;
  showFilmstrip: boolean;
};

export function VoiceStage({
  focusedScreenshare,
  focusedParticipant,
  isFocusedScreenshareSpeaking = false,
  isFocusedParticipantSpeaking = false,
  fallback,
  showFilmstrip,
}: VoiceStageProps) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <div className="pointer-events-none absolute -left-12 top-16 h-56 w-56 rounded-full bg-muted/30 blur-3xl" />
      <div className="pointer-events-none absolute -right-16 bottom-12 h-72 w-72 rounded-full bg-card/60 blur-3xl" />

      <div
        className={cn(
          "relative h-full w-full px-4 pt-20 sm:px-6",
          showFilmstrip ? "pb-40" : "pb-20",
        )}
      >
        {focusedScreenshare ? (
          <div className="mx-auto flex h-full w-full max-w-[1600px] items-center justify-center">
            <div
              className={cn(
                "relative max-h-full max-w-full overflow-hidden rounded-2xl border border-border/40 bg-black/80 p-2 shadow-2xl",
                speakingRingClass(isFocusedScreenshareSpeaking),
              )}
            >
              {focusedScreenshare.stream ? (
                <video
                  autoPlay
                  muted
                  playsInline
                  className="max-h-[calc(100vh-18rem)] max-w-[calc(100vw-5rem)] rounded-xl bg-black object-contain sm:max-h-[calc(100vh-16rem)]"
                  ref={(node) => {
                    if (node && node.srcObject !== focusedScreenshare.stream) {
                      node.srcObject = focusedScreenshare.stream;
                    }
                    if (node) {
                      void node.play().catch(() => undefined);
                    }
                  }}
                />
              ) : (
                <div className="grid h-[min(65vh,720px)] w-[min(88vw,1280px)] place-items-center rounded-xl bg-muted/20">
                  <p className="text-sm text-muted-foreground">Starting screen share...</p>
                </div>
              )}
              <div className="absolute left-4 top-4 rounded-full bg-background/80 px-3 py-1 text-xs font-medium backdrop-blur">
                {focusedScreenshare.name}
              </div>
            </div>
          </div>
        ) : focusedParticipant ? (
          <div className="mx-auto flex h-full w-full max-w-3xl items-center justify-center">
            <div
              className={cn(
                "w-full max-w-md rounded-2xl border border-border/40 bg-card/60 p-8 text-center backdrop-blur",
                speakingRingClass(isFocusedParticipantSpeaking),
              )}
            >
              <Avatar className="mx-auto size-32 border border-border/50">
                {focusedParticipant.avatarUrl ? (
                  <AvatarImage
                    src={focusedParticipant.avatarUrl}
                    alt={`${focusedParticipant.displayName} avatar`}
                  />
                ) : null}
                <AvatarFallback className="text-3xl">
                  {getDisplayInitial(focusedParticipant.displayName)}
                </AvatarFallback>
              </Avatar>
              <p className="mt-5 text-xl font-semibold">
                {focusedParticipant.displayName}
              </p>
              <div className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                {focusedParticipant.selfMute ? <MicOff className="size-3.5" /> : null}
                {focusedParticipant.selfDeaf ? <Headphones className="size-3.5" /> : null}
                {!focusedParticipant.selfMute && !focusedParticipant.selfDeaf ? (
                  <span>Listening</span>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          fallback
        )}
      </div>
    </div>
  );
}

export default VoiceStage;
