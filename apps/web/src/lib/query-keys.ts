export const queryKeys = {
  me: ["me"] as const,
  dmChannels: ["dm-channels"] as const,
  guilds: ["guilds"] as const,
  guildChannels: (guildId: string) => ["guild-channels", guildId] as const,
  messages: (channelId: string) => ["messages", channelId] as const,
  typing: (channelId: string) => ["typing", channelId] as const,
  usersSearch: (query: string) => ["users-search", query] as const,
  invite: (code: string) => ["invite", code] as const,
};
