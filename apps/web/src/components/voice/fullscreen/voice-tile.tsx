import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type VoiceTileProps = {
  active: boolean;
  onSelect: () => void;
  children: ReactNode;
  className?: string;
};

export function VoiceTile({
  active,
  onSelect,
  children,
  className,
}: VoiceTileProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative h-28 w-44 shrink-0 overflow-hidden rounded-xl border border-border/40 bg-card/80 text-left transition",
        "hover:-translate-y-0.5 hover:border-border hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
        active && "ring-2 ring-primary",
        className,
      )}
    >
      {children}
    </button>
  );
}

export default VoiceTile;
