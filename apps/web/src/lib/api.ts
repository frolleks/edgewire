import type { DmChannelPayload, MessagePayload, UserSummary } from "@discord/types";
import { apiFetch } from "./http";

export type CurrentUser = UserSummary;

export type DmChannel = DmChannelPayload & {
  unread: boolean;
  last_message?: MessagePayload | null;
};

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
  listChannels: () => apiFetch<DmChannel[]>("/api/users/@me/channels"),
  createDmChannel: (recipientId: string) =>
    apiFetch<DmChannel>("/api/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: recipientId }),
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
  mintGatewayToken: () =>
    apiFetch<{ token: string }>("/api/gateway/token", {
      method: "POST",
    }),
};
