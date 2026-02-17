import { cn } from "@/lib/utils";

export const speakingRingClass = (isSpeaking: boolean): string =>
  cn(
    "transition-shadow transition-colors duration-150",
    isSpeaking &&
      "relative z-10 outline outline-2 outline-primary outline-offset-2 outline-offset-background border-primary/70 shadow-[0_0_0_1px_hsl(var(--primary)/0.6),0_0_16px_hsl(var(--primary)/0.45)]",
  );

export default speakingRingClass;
