import { bigint, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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

export const dmChannels = pgTable("dm_channels", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dmMembers = pgTable(
  "dm_members",
  {
    channelId: bigint("channel_id", { mode: "bigint" })
      .notNull()
      .references(() => dmChannels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    primaryKey({ columns: [table.channelId, table.userId], name: "dm_members_pk" }),
    index("dm_members_user_id_idx").on(table.userId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey(),
    channelId: bigint("channel_id", { mode: "bigint" })
      .notNull()
      .references(() => dmChannels.id, { onDelete: "cascade" }),
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
    channelId: bigint("channel_id", { mode: "bigint" })
      .notNull()
      .references(() => dmChannels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadMessageId: bigint("last_read_message_id", { mode: "bigint" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [primaryKey({ columns: [table.channelId, table.userId], name: "message_reads_pk" })],
);

export const schema = {
  users,
  dmChannels,
  dmMembers,
  messages,
  messageReads,
};
