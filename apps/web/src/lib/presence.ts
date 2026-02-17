import type { PresenceStatus, SelfPresenceStatus } from "@/lib/api";

export type PresenceMap = Record<string, PresenceStatus>;

export const presenceQueryKeys = {
  presences: ["presences"] as const,
  selfPresence: ["self-presence"] as const,
};

export const presenceDotClassName = (status: PresenceStatus | SelfPresenceStatus): string => {
  if (status === "online") {
    return "bg-green-500";
  }

  if (status === "idle") {
    return "bg-yellow-500";
  }

  if (status === "dnd") {
    return "bg-red-500";
  }

  return "bg-muted-foreground/50";
};
