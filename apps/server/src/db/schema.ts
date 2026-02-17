import {
  boolean,
  check,
  index,
  integer,
  type AnyPgColumn,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    avatarS3Key: text("avatar_s3_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [uniqueIndex("users_username_unique").on(table.username)],
);

export const userThemeEnum = pgEnum("user_theme", ["system", "light", "dark"]);
export const notificationLevelEnum = pgEnum("notification_level", ["ALL_MESSAGES", "ONLY_MENTIONS", "NOTHING"]);
export const presenceStatusEnum = pgEnum("presence_status", ["online", "idle", "dnd", "invisible"]);

export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    bannerUrl: text("banner_url"),
    bio: text("bio"),
    pronouns: text("pronouns"),
    status: text("status"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex("user_profiles_username_unique").on(table.username),
    index("user_profiles_username_idx").on(table.username),
  ],
);

export const userSettings = pgTable(
  "user_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    theme: userThemeEnum("theme").notNull().default("system"),
    compactMode: boolean("compact_mode").notNull().default(false),
    showTimestamps: boolean("show_timestamps").notNull().default(true),
    locale: text("locale"),
    enableDesktopNotifications: boolean("enable_desktop_notifications").notNull().default(false),
    notificationSounds: boolean("notification_sounds").notNull().default(true),
    presenceStatus: presenceStatusEnum("presence_status").notNull().default("online"),
    showCurrentActivity: boolean("show_current_activity").notNull().default(false),
    defaultGuildNotificationLevel: notificationLevelEnum("default_guild_notification_level")
      .notNull()
      .default("ONLY_MENTIONS"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const guildMemberRoleEnum = pgEnum("guild_member_role", ["OWNER", "MEMBER"]);

export const guilds = pgTable(
  "guilds",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    icon: text("icon"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verificationLevel: integer("verification_level").notNull().default(0),
    defaultMessageNotifications: integer("default_message_notifications").notNull().default(0),
    explicitContentFilter: integer("explicit_content_filter").notNull().default(0),
    preferredLocale: text("preferred_locale").notNull().default("en-US"),
    systemChannelId: text("system_channel_id"),
    rulesChannelId: text("rules_channel_id"),
    publicUpdatesChannelId: text("public_updates_channel_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index("guilds_owner_id_idx").on(table.ownerId)],
);

export const guildRoles = pgTable(
  "guild_roles",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    permissions: text("permissions").notNull().default("0"),
    position: integer("position").notNull().default(0),
    color: integer("color"),
    hoist: boolean("hoist").notNull().default(false),
    mentionable: boolean("mentionable").notNull().default(false),
    managed: boolean("managed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index("guild_roles_guild_id_idx").on(table.guildId),
    index("guild_roles_guild_position_idx").on(table.guildId, table.position),
  ],
);

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    type: integer("type").notNull(),
    guildId: text("guild_id").references(() => guilds.id, { onDelete: "cascade" }),
    name: text("name"),
    topic: text("topic"),
    parentId: text("parent_id").references((): AnyPgColumn => channels.id, { onDelete: "set null" }),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index("channels_guild_id_idx").on(table.guildId),
    index("channels_parent_id_idx").on(table.parentId),
    index("channels_type_idx").on(table.type),
    index("channels_guild_position_idx").on(table.guildId, table.position),
    check("channels_type_check", sql`${table.type} in (0, 1, 2, 4)`),
    check(
      "channels_guild_presence_check",
      sql`((${table.type} in (0, 2, 4) and ${table.guildId} is not null) or (${table.type} = 1 and ${table.guildId} is null))`,
    ),
    check("channels_category_parent_check", sql`(${table.type} <> 4 or ${table.parentId} is null)`),
    check(
      "channels_name_check",
      sql`((${table.type} = 1 and ${table.name} is null) or (${table.type} in (0, 2, 4) and ${table.name} is not null))`,
    ),
  ],
);

export const guildMembers = pgTable(
  "guild_members",
  {
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    role: guildMemberRoleEnum("role").notNull().default("MEMBER"),
  },
  table => [
    primaryKey({ columns: [table.guildId, table.userId], name: "guild_members_pk" }),
    index("guild_members_user_id_idx").on(table.userId),
  ],
);

export const guildMemberRoles = pgTable(
  "guild_member_roles",
  {
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => guildRoles.id, { onDelete: "cascade" }),
  },
  table => [
    primaryKey({ columns: [table.guildId, table.userId, table.roleId], name: "guild_member_roles_pk" }),
    index("guild_member_roles_guild_user_idx").on(table.guildId, table.userId),
    index("guild_member_roles_guild_role_idx").on(table.guildId, table.roleId),
  ],
);

export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    primaryKey({ columns: [table.channelId, table.userId], name: "channel_members_pk" }),
    index("channel_members_user_id_idx").on(table.userId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    mentionEveryone: boolean("mention_everyone").notNull().default(false),
    mentionUserIds: text("mention_user_ids").array().notNull().default(sql`ARRAY[]::text[]`),
    mentionRoleIds: text("mention_role_ids").array().notNull().default(sql`ARRAY[]::text[]`),
    mentionChannelIds: text("mention_channel_ids").array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  table => [
    index("messages_channel_created_idx").on(table.channelId, table.createdAt),
    index("messages_channel_id_idx").on(table.channelId),
  ],
);

export const uploadSessionKindEnum = pgEnum("upload_session_kind", ["avatar", "attachment"]);
export const uploadSessionStatusEnum = pgEnum("upload_session_status", ["pending", "completed", "aborted", "expired"]);
export const attachmentUrlKindEnum = pgEnum("attachment_url_kind", ["presigned", "public"]);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: uploadSessionKindEnum("kind").notNull(),
    status: uploadSessionStatusEnum("status").notNull().default("pending"),
    s3Key: text("s3_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type"),
    expectedSize: integer("expected_size"),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  table => [
    uniqueIndex("upload_sessions_s3_key_unique").on(table.s3Key),
    index("upload_sessions_user_id_idx").on(table.userId),
    index("upload_sessions_status_expires_idx").on(table.status, table.expiresAt),
    index("upload_sessions_channel_id_idx").on(table.channelId),
    index("upload_sessions_message_id_idx").on(table.messageId),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    uploaderId: text("uploader_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    s3Key: text("s3_key").notNull(),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    contentType: text("content_type"),
    urlKind: attachmentUrlKindEnum("url_kind").notNull().default("presigned"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex("message_attachments_s3_key_unique").on(table.s3Key),
    index("message_attachments_message_id_idx").on(table.messageId),
    index("message_attachments_channel_id_idx").on(table.channelId),
    index("message_attachments_uploader_id_idx").on(table.uploaderId),
  ],
);

export const messageReads = pgTable(
  "message_reads",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadMessageId: text("last_read_message_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [primaryKey({ columns: [table.channelId, table.userId], name: "message_reads_pk" })],
);

export const channelReads = pgTable(
  "channel_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    lastReadMessageId: text("last_read_message_id"),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
    unreadCount: integer("unread_count").notNull().default(0),
    mentionCount: integer("mention_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    primaryKey({ columns: [table.userId, table.channelId], name: "channel_reads_pk" }),
    index("channel_reads_channel_id_idx").on(table.channelId),
  ],
);

export const messageMentions = pgTable(
  "message_mentions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    guildId: text("guild_id").references(() => guilds.id, { onDelete: "cascade" }),
    mentionedUserId: text("mentioned_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    primaryKey({ columns: [table.messageId, table.mentionedUserId], name: "message_mentions_pk" }),
    index("message_mentions_message_idx").on(table.messageId),
    index("message_mentions_channel_idx").on(table.channelId),
    index("message_mentions_guild_idx").on(table.guildId),
    index("message_mentions_mentioned_user_idx").on(table.mentionedUserId),
  ],
);

export const userGuildNotificationSettings = pgTable(
  "user_guild_notification_settings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    level: notificationLevelEnum("level").notNull().default("ONLY_MENTIONS"),
    suppressEveryone: boolean("suppress_everyone").notNull().default(false),
    muted: boolean("muted").notNull().default(false),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [primaryKey({ columns: [table.userId, table.guildId], name: "user_guild_notification_settings_pk" })],
);

export const userChannelNotificationSettings = pgTable(
  "user_channel_notification_settings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    level: notificationLevelEnum("level"),
    muted: boolean("muted").notNull().default(false),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [primaryKey({ columns: [table.userId, table.channelId], name: "user_channel_notification_settings_pk" })],
);

export const channelPermissionOverwrites = pgTable(
  "channel_permission_overwrites",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    overwriteId: text("overwrite_id").notNull(),
    type: integer("type").notNull(),
    allow: text("allow").notNull().default("0"),
    deny: text("deny").notNull().default("0"),
  },
  table => [
    primaryKey({ columns: [table.channelId, table.overwriteId], name: "channel_permission_overwrites_pk" }),
    index("channel_permission_overwrites_channel_idx").on(table.channelId),
    check("channel_permission_overwrites_type_check", sql`${table.type} in (0, 1)`),
  ],
);

export const invites = pgTable(
  "invites",
  {
    code: text("code").primaryKey(),
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    maxAgeSeconds: integer("max_age_seconds").notNull().default(86_400),
    maxUses: integer("max_uses").notNull().default(0),
    uses: integer("uses").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index("invites_guild_id_idx").on(table.guildId),
    index("invites_channel_id_idx").on(table.channelId),
    index("invites_expires_at_idx").on(table.expiresAt),
  ],
);

export const schema = {
  users,
  userProfiles,
  userSettings,
  guilds,
  guildRoles,
  guildMembers,
  guildMemberRoles,
  channels,
  channelMembers,
  messages,
  uploadSessions,
  messageAttachments,
  messageReads,
  channelReads,
  messageMentions,
  userGuildNotificationSettings,
  userChannelNotificationSettings,
  channelPermissionOverwrites,
  invites,
};
