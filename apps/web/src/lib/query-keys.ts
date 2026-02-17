export const queryKeys = {
  me: ["me"] as const,
  dmChannels: ["dm-channels"] as const,
  guilds: ["guilds"] as const,
  guildSettings: (guildId: string) => ["guild-settings", guildId] as const,
  guildPermissions: (guildId: string) => ["guild-permissions", guildId] as const,
  guildChannels: (guildId: string) => ["guild-channels", guildId] as const,
  guildRoles: (guildId: string) => ["guild-roles", guildId] as const,
  guildMembers: (guildId: string, page: number, limit: number) => ["guild-members", guildId, page, limit] as const,
  messages: (channelId: string) => ["messages", channelId] as const,
  typing: (channelId: string) => ["typing", channelId] as const,
  usersSearch: (query: string) => ["users-search", query] as const,
  invite: (code: string) => ["invite", code] as const,
};
