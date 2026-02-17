export const ChannelType = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_CATEGORY: 4,
} as const;

export type ChannelTypeValue = (typeof ChannelType)[keyof typeof ChannelType];

export interface UserSummary {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export interface ChannelPermissionOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface MessagePayload {
  id: string;
  channel_id: string;
  guild_id: string | null;
  author: UserSummary;
  content: string;
  attachments: APIAttachment[];
  timestamp: string;
  edited_timestamp: string | null;
  type: 0;
}

export interface APIAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url: string;
  content_type?: string | null;
}

export interface DmChannelPayload {
  id: string;
  type: 1;
  guild_id: null;
  parent_id: null;
  name: null;
  topic: null;
  position: 0;
  recipients: UserSummary[];
  last_message_id: string | null;
  last_message?: MessagePayload | null;
  unread?: boolean;
}

export interface GuildChannelPayload {
  id: string;
  type: 0 | 4;
  guild_id: string;
  parent_id: string | null;
  name: string;
  topic: string | null;
  position: number;
  permission_overwrites?: ChannelPermissionOverwrite[];
}

export type ChannelPayload = DmChannelPayload | GuildChannelPayload;

export interface Guild {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string;
  verification_level?: number;
  default_message_notifications?: number;
  explicit_content_filter?: number;
  preferred_locale?: string;
  system_channel_id?: string | null;
  rules_channel_id?: string | null;
  public_updates_channel_id?: string | null;
}

export interface PartialGuild {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string;
  verification_level?: number;
  default_message_notifications?: number;
  explicit_content_filter?: number;
  preferred_locale?: string;
  system_channel_id?: string | null;
  rules_channel_id?: string | null;
  public_updates_channel_id?: string | null;
}

export interface GuildRole {
  id: string;
  guild_id: string;
  name: string;
  permissions: string;
  position: number;
  color: number | null;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
}

export interface GuildMemberListItem {
  guild_id: string;
  user: UserSummary;
  joined_at: string;
  roles: string[];
  role: "OWNER" | "MEMBER";
}

export interface InvitePayload {
  code: string;
  guild: PartialGuild;
  channel: Pick<GuildChannelPayload, "id" | "name" | "type" | "guild_id" | "parent_id">;
  inviter: UserSummary;
  created_at: string;
  expires_at: string | null;
  max_age: number;
  max_uses: number;
  uses: number;
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

export interface GuildMemberPayload {
  user: UserSummary;
  joined_at: string;
  role: "OWNER" | "MEMBER";
}

export interface GatewayPacket<T = unknown> {
  op: number;
  d?: T;
  s?: number | null;
  t?: string | null;
}

export interface ReadyGuildStub {
  id: string;
  unavailable: true;
}

export interface ReadyEvent {
  v: 1;
  user: UserSummary;
  session_id: string;
  resume_gateway_url: string;
  private_channels: DmChannelPayload[];
  guilds: ReadyGuildStub[];
}

export interface GuildCreateEvent extends Guild {
  joined_at: string;
  member_count: number;
  channels: GuildChannelPayload[];
  members: GuildMemberPayload[];
}

export interface TypingStartEvent {
  channel_id: string;
  user_id: string;
  timestamp: number;
}

export interface ReadStateUpdateEvent {
  channel_id: string;
  user_id: string;
  last_read_message_id: string | null;
}

export interface GuildRoleEvent {
  guild_id: string;
  role: GuildRole;
}

export interface GuildRoleDeleteEvent {
  guild_id: string;
  role_id: string;
}

export interface GuildMemberUpdateEvent {
  guild_id: string;
  user: Pick<UserSummary, "id">;
  roles?: string[];
  nick?: string | null;
  joined_at?: string;
}

export interface GuildMemberAddEvent {
  guild_id: string;
  member: {
    user: UserSummary;
    roles: string[];
    joined_at: string;
    nick?: string | null;
    presence?: {
      status: "online" | "idle" | "dnd" | "offline";
    } | null;
  };
}

export interface GuildMemberRemoveEvent {
  guild_id: string;
  user: Pick<UserSummary, "id">;
}

export interface GatewayHello {
  heartbeat_interval: number;
}
