import type { GuildChannelPayload } from "@edgewire/types";
import type { Role } from "@/lib/api";

export const byPositionThenId = (
  a: GuildChannelPayload,
  b: GuildChannelPayload,
): number => {
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  return a.id.localeCompare(b.id);
};

export const roleSortDesc = (a: Role, b: Role): number => {
  if (a.position !== b.position) {
    return b.position - a.position;
  }
  return a.id.localeCompare(b.id);
};
