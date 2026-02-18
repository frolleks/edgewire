import type { GuildChannelPayload } from "@edgewire/types";
import { byPositionThenId } from "@/components/utils/sort";

export const applyChannelBulkPatch = (
  channels: GuildChannelPayload[],
  payload: Array<{ id: string; position: number; parent_id?: string | null }>,
): GuildChannelPayload[] => {
  const patchById = new Map(payload.map((item) => [item.id, item]));
  return channels
    .map((channel) => {
      const patch = patchById.get(channel.id);
      if (!patch) {
        return channel;
      }

      return {
        ...channel,
        position: patch.position,
        parent_id:
          patch.parent_id === undefined
            ? channel.parent_id
            : (patch.parent_id ?? null),
      };
    })
    .sort(byPositionThenId);
};
