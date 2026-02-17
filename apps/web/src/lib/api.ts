import type {
  DmChannelPayload,
  GuildChannelPayload,
  InvitePayload,
  MessagePayload,
  PartialGuild,
  UserSummary,
} from "@discord/types";
import { apiFetch } from "./http";

export type CurrentUser = UserSummary;

export type DmChannel = DmChannelPayload & {
  unread: boolean;
  last_message?: MessagePayload | null;
};

export type Guild = PartialGuild;
export type GuildChannel = GuildChannelPayload;
export type Invite = InvitePayload;

export type TypingEvent = {
  channel_id: string;
  user_id: string;
  timestamp: number;
};

export const api = {
  getMe: () => apiFetch<CurrentUser>("/api/users/@me"),
  updateProfile: (body: { username?: string; display_name?: string; avatar_url?: string | null }) =>
    apiFetch<CurrentUser>("/api/users/@me/profile", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  searchUsers: (q: string) =>
    apiFetch<UserSummary[]>(`/api/users?q=${encodeURIComponent(q)}`),

  listDmChannels: () => apiFetch<DmChannel[]>("/api/users/@me/channels"),
  createDmChannel: (recipientId: string) =>
    apiFetch<DmChannel>("/api/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: recipientId }),
    }),

  listGuilds: () => apiFetch<Guild[]>("/api/users/@me/guilds"),
  createGuild: (name: string) =>
    apiFetch<Guild>("/api/guilds", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  getGuild: (guildId: string) => apiFetch<Guild>(`/api/guilds/${guildId}`),
  listGuildChannels: (guildId: string) => apiFetch<GuildChannel[]>(`/api/guilds/${guildId}/channels`),
  createGuildChannel: (
    guildId: string,
    payload: {
      name: string;
      type: 0 | 4;
      parent_id?: string | null;
      position?: number;
      topic?: string | null;
    },
  ) =>
    apiFetch<GuildChannel>(`/api/guilds/${guildId}/channels`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  patchChannel: (
    channelId: string,
    payload: {
      name?: string;
      topic?: string | null;
      parent_id?: string | null;
      position?: number;
    },
  ) =>
    apiFetch<GuildChannel | { id: string }>(`/api/channels/${channelId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteChannel: (channelId: string) =>
    apiFetch<void>(`/api/channels/${channelId}`, {
      method: "DELETE",
    }),

  listMessages: (channelId: string, before?: string, limit = 50) => {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (before) {
      params.set("before", before);
    }
    return apiFetch<MessagePayload[]>(`/api/channels/${channelId}/messages?${params.toString()}`);
  },
  createMessage: (channelId: string, content: string) =>
    apiFetch<MessagePayload>(`/api/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  editMessage: (channelId: string, messageId: string, content: string) =>
    apiFetch<MessagePayload>(`/api/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }),
  deleteMessage: (channelId: string, messageId: string) =>
    apiFetch<void>(`/api/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
    }),

  triggerTyping: (channelId: string) =>
    apiFetch<void>(`/api/channels/${channelId}/typing`, {
      method: "POST",
    }),
  markRead: (channelId: string, lastReadMessageId: string | null) =>
    apiFetch<{ channel_id: string; user_id: string; last_read_message_id: string | null }>(
      `/api/channels/${channelId}/read`,
      {
        method: "PUT",
        body: JSON.stringify({ last_read_message_id: lastReadMessageId }),
      },
    ),

  createInvite: (channelId: string, payload?: { max_age?: number; max_uses?: number }) =>
    apiFetch<Invite>(`/api/channels/${channelId}/invites`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  getInvite: (code: string, withCounts = true) =>
    apiFetch<Invite>(`/api/invites/${code}?with_counts=${withCounts ? "true" : "false"}`),
  acceptInvite: (code: string) =>
    apiFetch<{ guildId: string; channelId: string }>(`/api/invites/${code}/accept`, {
      method: "POST",
    }),

  mintGatewayToken: () =>
    apiFetch<{ token: string }>("/api/gateway/token", {
      method: "POST",
    }),
};
