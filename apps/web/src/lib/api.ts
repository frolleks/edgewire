import type {
  DmChannelPayload,
  GuildChannelPayload,
  GuildMemberListItem,
  GuildRole,
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
export type Role = GuildRole;
export type GuildMember = GuildMemberListItem;

export type TypingEvent = {
  channel_id: string;
  user_id: string;
  timestamp: number;
};

export type UploadInitResponse = {
  upload_id: string;
  key: string;
  method: "PUT";
  put_url: string;
  headers: {
    "Content-Type": string;
  };
  expires_at: string;
};

export type CompleteUploadResponse =
  | {
      upload_id: string;
      kind: "avatar";
      user: UserSummary;
      avatar_s3_key?: string | null;
    }
  | {
      upload_id: string;
      kind: "attachment";
      filename: string;
      size: number;
      content_type: string | null;
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
  getMyGuildPermissions: (guildId: string) =>
    apiFetch<{ permissions: string; role_ids: string[] }>(`/api/guilds/${guildId}/permissions/@me`),
  updateGuild: (
    guildId: string,
    payload: Partial<{
      name: string;
      icon: string | null;
      verification_level: number;
      default_message_notifications: number;
      explicit_content_filter: number;
      preferred_locale: string;
      system_channel_id: string | null;
      rules_channel_id: string | null;
      public_updates_channel_id: string | null;
    }>,
  ) =>
    apiFetch<Guild>(`/api/guilds/${guildId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  listGuildChannels: (guildId: string) => apiFetch<GuildChannel[]>(`/api/guilds/${guildId}/channels`),
  reorderGuildChannels: (
    guildId: string,
    payload: Array<{ id: string; position: number; parent_id?: string | null; lock_permissions?: boolean }>,
  ) =>
    apiFetch<GuildChannel[]>(`/api/guilds/${guildId}/channels`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
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
  editChannelPermissionOverwrite: (
    channelId: string,
    overwriteId: string,
    payload: { allow: string; deny: string; type: 0 | 1 },
  ) =>
    apiFetch<GuildChannel>(`/api/channels/${channelId}/permissions/${overwriteId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteChannelPermissionOverwrite: (channelId: string, overwriteId: string) =>
    apiFetch<GuildChannel>(`/api/channels/${channelId}/permissions/${overwriteId}`, {
      method: "DELETE",
    }),

  listGuildRoles: (guildId: string) => apiFetch<Role[]>(`/api/guilds/${guildId}/roles`),
  createGuildRole: (
    guildId: string,
    payload?: Partial<Pick<Role, "name" | "permissions" | "color" | "hoist" | "mentionable">>,
  ) =>
    apiFetch<Role>(`/api/guilds/${guildId}/roles`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  reorderGuildRoles: (guildId: string, payload: Array<{ id: string; position: number }>) =>
    apiFetch<Role[]>(`/api/guilds/${guildId}/roles`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  updateGuildRole: (
    guildId: string,
    roleId: string,
    payload: Partial<Pick<Role, "name" | "permissions" | "color" | "hoist" | "mentionable">>,
  ) =>
    apiFetch<Role>(`/api/guilds/${guildId}/roles/${roleId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteGuildRole: (guildId: string, roleId: string) =>
    apiFetch<void>(`/api/guilds/${guildId}/roles/${roleId}`, {
      method: "DELETE",
    }),

  listGuildMembers: (guildId: string, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set("limit", String(params.limit));
    if (params?.offset !== undefined) query.set("offset", String(params.offset));
    const suffix = query.toString();
    return apiFetch<GuildMember[]>(`/api/guilds/${guildId}/members${suffix ? `?${suffix}` : ""}`);
  },
  getGuildMember: (guildId: string, userId: string) =>
    apiFetch<GuildMember>(`/api/guilds/${guildId}/members/${userId}`),
  addGuildMemberRole: (guildId: string, userId: string, roleId: string) =>
    apiFetch<{ guild_id: string; user_id: string; role_id: string }>(
      `/api/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      { method: "PUT" },
    ),
  removeGuildMemberRole: (guildId: string, userId: string, roleId: string) =>
    apiFetch<{ guild_id: string; user_id: string; role_id: string }>(
      `/api/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      { method: "DELETE" },
    ),

  listMessages: (channelId: string, before?: string, limit = 50) => {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (before) {
      params.set("before", before);
    }
    return apiFetch<MessagePayload[]>(`/api/channels/${channelId}/messages?${params.toString()}`);
  },
  createMessage: (
    channelId: string,
    payload: {
      content?: string;
      attachment_upload_ids?: string[];
    },
  ) =>
    apiFetch<MessagePayload>(`/api/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
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

  initAvatarUpload: (payload: { filename: string; content_type: string; size: number }) =>
    apiFetch<UploadInitResponse>("/api/uploads/avatar", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  initAttachmentUpload: (payload: { channel_id: string; filename: string; content_type: string; size: number }) =>
    apiFetch<UploadInitResponse>("/api/uploads/attachment", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  completeUpload: (uploadId: string) =>
    apiFetch<CompleteUploadResponse>(`/api/uploads/${uploadId}/complete`, {
      method: "POST",
      body: "{}",
    }),
  abortUpload: (uploadId: string) =>
    apiFetch<void>(`/api/uploads/${uploadId}/abort`, {
      method: "POST",
      body: "{}",
    }),

  mintGatewayToken: () =>
    apiFetch<{ token: string }>("/api/gateway/token", {
      method: "POST",
    }),
};
