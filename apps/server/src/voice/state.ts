import { emitToGuild } from "../runtime";

export type GuildVoiceParticipant = {
  socket_id: string;
  user: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
  self_mute: boolean;
  self_deaf: boolean;
  screen_sharing: boolean;
};

const guildVoiceStateByGuildId = new Map<string, Map<string, GuildVoiceParticipant[]>>();

export const setGuildVoiceChannelState = async (
  guildId: string,
  channelId: string,
  participants: GuildVoiceParticipant[],
): Promise<void> => {
  const byChannel = guildVoiceStateByGuildId.get(guildId) ?? new Map<string, GuildVoiceParticipant[]>();
  if (participants.length === 0) {
    byChannel.delete(channelId);
  } else {
    byChannel.set(channelId, participants);
  }

  if (byChannel.size === 0) {
    guildVoiceStateByGuildId.delete(guildId);
  } else {
    guildVoiceStateByGuildId.set(guildId, byChannel);
  }

  await emitToGuild(guildId, "VOICE_CHANNEL_STATE_UPDATE", {
    guild_id: guildId,
    channel_id: channelId,
    participants,
  });
};

export const getGuildVoiceState = (guildId: string): Record<string, GuildVoiceParticipant[]> => {
  const byChannel = guildVoiceStateByGuildId.get(guildId);
  if (!byChannel) {
    return {};
  }

  return Object.fromEntries(byChannel.entries());
};
