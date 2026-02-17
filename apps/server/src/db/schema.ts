import {
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [uniqueIndex("users_username_unique").on(table.username)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index("guilds_owner_id_idx").on(table.ownerId)],
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
    check("channels_type_check", sql`${table.type} in (0, 1, 4)`),
    check(
      "channels_guild_presence_check",
      sql`((${table.type} in (0, 4) and ${table.guildId} is not null) or (${table.type} = 1 and ${table.guildId} is null))`,
    ),
    check("channels_category_parent_check", sql`(${table.type} <> 4 or ${table.parentId} is null)`),
    check(
      "channels_name_check",
      sql`((${table.type} = 1 and ${table.name} is null) or (${table.type} in (0, 4) and ${table.name} is not null))`,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  table => [
    index("messages_channel_created_idx").on(table.channelId, table.createdAt),
    index("messages_channel_id_idx").on(table.channelId),
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
  guilds,
  guildMembers,
  channels,
  channelMembers,
  messages,
  messageReads,
  invites,
};
