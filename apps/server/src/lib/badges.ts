import { ChannelType, type BadgesPayload, type ChannelBadgePayload, type GuildBadgePayload } from "@discord/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { channelMembers, channelReads, channels, guildMembers, messages } from "../db/schema";
import { listVisibleGuildChannelsForUser } from "./permission-service";
import { emitToUsers } from "../runtime";

const toNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
};

const unique = (values: Iterable<string>): string[] => [...new Set([...values].filter(Boolean))];

export const getChannelBadgeForUser = async (
  userId: string,
  channelId: string,
  lastMessageIdOverride?: string | null,
): Promise<ChannelBadgePayload | null> => {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
  });
  if (!channel) {
    return null;
  }

  const readState = await db.query.channelReads.findFirst({
    where: and(eq(channelReads.userId, userId), eq(channelReads.channelId, channelId)),
  });

  let lastMessageId = lastMessageIdOverride ?? null;
  if (lastMessageIdOverride === undefined) {
    const [lastMessage] = await db
      .select({
        id: sql<string | null>`max(${messages.id}::bigint)::text`,
      })
      .from(messages)
      .where(eq(messages.channelId, channelId));
    lastMessageId = lastMessage?.id ?? null;
  }

  return {
    channel_id: channel.id,
    guild_id: channel.guildId,
    unread_count: readState?.unreadCount ?? 0,
    mention_count: readState?.mentionCount ?? 0,
    last_message_id: lastMessageId,
  };
};

export const getGuildBadgeForUser = async (userId: string, guildId: string): Promise<GuildBadgePayload> => {
  const [totals] = await db
    .select({
      unreadCount: sql<number>`coalesce(sum(${channelReads.unreadCount}), 0)`,
      mentionCount: sql<number>`coalesce(sum(${channelReads.mentionCount}), 0)`,
    })
    .from(channelReads)
    .innerJoin(channels, eq(channelReads.channelId, channels.id))
    .where(and(eq(channelReads.userId, userId), eq(channels.guildId, guildId)));

  return {
    guild_id: guildId,
    unread_count: toNumber(totals?.unreadCount),
    mention_count: toNumber(totals?.mentionCount),
  };
};

export const emitBadgeUpdateForUserChannel = async (
  userId: string,
  channelId: string,
  lastMessageIdOverride?: string | null,
): Promise<void> => {
  const channelBadge = await getChannelBadgeForUser(userId, channelId, lastMessageIdOverride);
  if (!channelBadge) {
    return;
  }

  emitToUsers([userId], "CHANNEL_BADGE_UPDATE", channelBadge);
  if (!channelBadge.guild_id) {
    return;
  }

  const guildBadge = await getGuildBadgeForUser(userId, channelBadge.guild_id);
  emitToUsers([userId], "GUILD_BADGE_UPDATE", guildBadge);
};

export const emitBadgeUpdatesForUsers = async (
  userIds: string[],
  channelId: string,
  lastMessageIdOverride?: string | null,
): Promise<void> => {
  for (const userId of unique(userIds)) {
    await emitBadgeUpdateForUserChannel(userId, channelId, lastMessageIdOverride);
  }
};

export const listBadgesForUser = async (userId: string): Promise<BadgesPayload> => {
  const [dmMembershipRows, guildMembershipRows] = await Promise.all([
    db
      .select({ channelId: channelMembers.channelId })
      .from(channelMembers)
      .innerJoin(channels, eq(channelMembers.channelId, channels.id))
      .where(and(eq(channelMembers.userId, userId), eq(channels.type, ChannelType.DM))),
    db
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .where(eq(guildMembers.userId, userId)),
  ]);

  const dmChannelIds = unique(dmMembershipRows.map(row => row.channelId));
  const guildIds = unique(guildMembershipRows.map(row => row.guildId));

  const visibleGuildChannels = await Promise.all(
    guildIds.map(async guildId => {
      const visible = await listVisibleGuildChannelsForUser(userId, guildId);
      return visible.filter(channel => channel.type === ChannelType.GUILD_TEXT);
    }),
  );

  const guildChannels = visibleGuildChannels.flatMap(items => items);
  const allChannelIds = unique([...dmChannelIds, ...guildChannels.map(channel => channel.id)]);

  if (allChannelIds.length === 0) {
    return {
      channels: [],
      guilds: guildIds.map(guildId => ({
        guild_id: guildId,
        unread_count: 0,
        mention_count: 0,
      })),
    };
  }

  const [readRows, lastMessageRows] = await Promise.all([
    db
      .select({
        channelId: channelReads.channelId,
        unreadCount: channelReads.unreadCount,
        mentionCount: channelReads.mentionCount,
      })
      .from(channelReads)
      .where(and(eq(channelReads.userId, userId), inArray(channelReads.channelId, allChannelIds))),
    db
      .select({
        channelId: messages.channelId,
        lastMessageId: sql<string | null>`max(${messages.id}::bigint)::text`,
      })
      .from(messages)
      .where(inArray(messages.channelId, allChannelIds))
      .groupBy(messages.channelId),
  ]);

  const readByChannelId = new Map(readRows.map(row => [row.channelId, row]));
  const lastMessageByChannelId = new Map(lastMessageRows.map(row => [row.channelId, row.lastMessageId]));
  const guildChannelById = new Map(guildChannels.map(channel => [channel.id, channel]));

  const channelBadges: ChannelBadgePayload[] = allChannelIds.map(channelId => {
    const read = readByChannelId.get(channelId);
    const guildChannel = guildChannelById.get(channelId);
    return {
      channel_id: channelId,
      guild_id: guildChannel?.guildId ?? null,
      unread_count: read?.unreadCount ?? 0,
      mention_count: read?.mentionCount ?? 0,
      last_message_id: lastMessageByChannelId.get(channelId) ?? null,
    };
  });

  const guildTotals = new Map<string, { unread: number; mentions: number }>();
  for (const guildId of guildIds) {
    guildTotals.set(guildId, { unread: 0, mentions: 0 });
  }

  for (const badge of channelBadges) {
    if (!badge.guild_id) {
      continue;
    }
    const totals = guildTotals.get(badge.guild_id) ?? { unread: 0, mentions: 0 };
    totals.unread += badge.unread_count;
    totals.mentions += badge.mention_count;
    guildTotals.set(badge.guild_id, totals);
  }

  const guildBadges: GuildBadgePayload[] = [...guildTotals.entries()].map(([guildId, totals]) => ({
    guild_id: guildId,
    unread_count: totals.unread,
    mention_count: totals.mentions,
  }));

  return {
    channels: channelBadges,
    guilds: guildBadges,
  };
};
