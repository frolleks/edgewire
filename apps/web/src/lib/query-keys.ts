export const queryKeys = {
  me: ["me"] as const,
  channels: ["dm-channels"] as const,
  messages: (channelId: string) => ["messages", channelId] as const,
  typing: (channelId: string) => ["typing", channelId] as const,
  usersSearch: (query: string) => ["users-search", query] as const,
};
