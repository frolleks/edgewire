import {
  ChannelType,
  type ChannelTypeValue,
  type MessageChannelMention,
  type NotificationLevel,
  type UserSummary as SharedUserSummary,
} from "@edgewire/types";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  channelMembers,
  channels,
  guildMemberRoles,
  guildMembers,
  guildRoles,
  userChannelNotificationSettings,
  userGuildNotificationSettings,
  userSettings,
  users,
} from "../db/schema";
import { hasChannelPermission } from "./permission-service";
import { PermissionBits } from "./permissions";
import { toUserSummary, type UserSummary } from "./users";

type ChannelRow = typeof channels.$inferSelect;

const USER_MENTION_REGEX = /<@!?([^\s>]+)>/g;
const ROLE_MENTION_REGEX = /<@&(\d+)>/g;
const CHANNEL_MENTION_REGEX = /<#(\d+)>/g;
const EVERYONE_MENTION_REGEX = /\B@(everyone|here)\b/;

export type AllowedMentionsInput = {
  parse?: Array<"users" | "roles" | "everyone">;
  users?: string[];
  roles?: string[];
};

export type ParsedMentionTokens = {
  users: string[];
  roles: string[];
  channels: string[];
  everyone: boolean;
};

export type ResolvedMentions = {
  mentionEveryone: boolean;
  mentionUserIds: string[];
  mentionRoleIds: string[];
  mentionChannelIds: string[];
  audienceUserIds: string[];
  directMentionUserIds: string[];
  roleMentionUserIds: string[];
  everyoneMentionUserIds: string[];
};

export type EffectiveNotificationSettings = {
  level: NotificationLevel;
  muted: boolean;
  suppressEveryone: boolean;
};

const unique = (values: Iterable<string>): string[] => [...new Set([...values].filter(Boolean))];

const parseIds = (content: string, regex: RegExp): string[] => {
  const ids = new Set<string>();
  for (const match of content.matchAll(regex)) {
    const id = match[1];
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
};

const parseMentionTokens = (content: string): ParsedMentionTokens => ({
  users: parseIds(content, USER_MENTION_REGEX),
  roles: parseIds(content, ROLE_MENTION_REGEX),
  channels: parseIds(content, CHANNEL_MENTION_REGEX),
  everyone: EVERYONE_MENTION_REGEX.test(content),
});

const applyAllowedMentions = (tokens: ParsedMentionTokens, allowed: AllowedMentionsInput | null | undefined): ParsedMentionTokens => {
  const parseRules = new Set(allowed?.parse ?? ["users", "roles", "everyone"]);
  let users = parseRules.has("users") ? tokens.users : [];
  let roles = parseRules.has("roles") ? tokens.roles : [];
  let everyone = parseRules.has("everyone") ? tokens.everyone : false;

  if (allowed?.users) {
    const userAllow = new Set(allowed.users);
    users = users.filter(userId => userAllow.has(userId));
  }

  if (allowed?.roles) {
    const roleAllow = new Set(allowed.roles);
    roles = roles.filter(roleId => roleAllow.has(roleId));
  }

  // allowed_mentions never creates invisible pings; only entities present in tokens survive.
  users = unique(users);
  roles = unique(roles);

  return {
    users,
    roles,
    channels: unique(tokens.channels),
    everyone,
  };
};

const isMutedActive = (muted: boolean, mutedUntil: Date | null): boolean => {
  if (!muted) {
    return false;
  }
  if (!mutedUntil) {
    return true;
  }
  return mutedUntil.getTime() > Date.now();
};

export const listGuildChannelAudienceMemberIds = async (guildId: string, channelId: string): Promise<string[]> => {
  const memberRows = await db
    .select({ userId: guildMembers.userId })
    .from(guildMembers)
    .where(eq(guildMembers.guildId, guildId));

  if (memberRows.length === 0) {
    return [];
  }

  const visibility = await Promise.all(
    memberRows.map(async member => ({
      userId: member.userId,
      canView: await hasChannelPermission(member.userId, channelId, PermissionBits.VIEW_CHANNEL),
    })),
  );

  return visibility.filter(entry => entry.canView).map(entry => entry.userId);
};

export const resolveMentionsForChannel = async (params: {
  channel: ChannelRow;
  authorId: string;
  content: string;
  allowedMentions?: AllowedMentionsInput | null;
}): Promise<ResolvedMentions> => {
  const parsed = applyAllowedMentions(parseMentionTokens(params.content), params.allowedMentions);

  if (params.channel.type === ChannelType.DM) {
    const dmMembers = await db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, params.channel.id));
    const audienceUserIds = unique(dmMembers.map(member => member.userId));
    const audienceSet = new Set(audienceUserIds);
    const mentionUserIds = parsed.users.filter(userId => audienceSet.has(userId));

    return {
      mentionEveryone: false,
      mentionUserIds,
      mentionRoleIds: [],
      mentionChannelIds: parsed.channels,
      audienceUserIds,
      directMentionUserIds: mentionUserIds.filter(userId => userId !== params.authorId),
      roleMentionUserIds: [],
      everyoneMentionUserIds: [],
    };
  }

  if (!params.channel.guildId) {
    return {
      mentionEveryone: false,
      mentionUserIds: [],
      mentionRoleIds: [],
      mentionChannelIds: parsed.channels,
      audienceUserIds: [],
      directMentionUserIds: [],
      roleMentionUserIds: [],
      everyoneMentionUserIds: [],
    };
  }

  const guildId = params.channel.guildId;
  const senderCanMentionEveryone = await hasChannelPermission(
    params.authorId,
    params.channel.id,
    PermissionBits.MENTION_EVERYONE,
  );

  const audienceUserIds = await listGuildChannelAudienceMemberIds(guildId, params.channel.id);
  const audienceSet = new Set(audienceUserIds);

  const mentionUserIds = parsed.users.filter(userId => audienceSet.has(userId));

  const roleRows =
    parsed.roles.length === 0
      ? []
      : await db
          .select({
            id: guildRoles.id,
            mentionable: guildRoles.mentionable,
          })
          .from(guildRoles)
          .where(and(eq(guildRoles.guildId, guildId), inArray(guildRoles.id, parsed.roles)));

  const mentionRoleIds = unique(
    roleRows
      .filter(role => role.mentionable || senderCanMentionEveryone)
      .map(role => role.id),
  );

  const roleMentionRows =
    mentionRoleIds.length === 0
      ? []
      : await db
          .select({ userId: guildMemberRoles.userId })
          .from(guildMemberRoles)
          .where(
            and(
              eq(guildMemberRoles.guildId, guildId),
              inArray(guildMemberRoles.roleId, mentionRoleIds),
              inArray(guildMemberRoles.userId, audienceUserIds),
            ),
          );

  const roleMentionUserIds = unique(roleMentionRows.map(row => row.userId).filter(userId => userId !== params.authorId));
  const mentionEveryone = parsed.everyone && senderCanMentionEveryone;
  const everyoneMentionUserIds = mentionEveryone
    ? audienceUserIds.filter(userId => userId !== params.authorId)
    : [];

  return {
    mentionEveryone,
    mentionUserIds,
    mentionRoleIds,
    mentionChannelIds: parsed.channels,
    audienceUserIds,
    directMentionUserIds: mentionUserIds.filter(userId => userId !== params.authorId),
    roleMentionUserIds,
    everyoneMentionUserIds,
  };
};

export const resolveMentionUsers = async (userIds: string[]): Promise<Map<string, UserSummary>> => {
  if (userIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      avatarS3Key: users.avatarS3Key,
    })
    .from(users)
    .where(inArray(users.id, userIds));

  return new Map(rows.map(row => [row.id, toUserSummary(row)]));
};

export const resolveMentionChannelPayloads = async (channelIds: string[]): Promise<MessageChannelMention[]> => {
  if (channelIds.length === 0) {
    return [];
  }

  const ids = unique(channelIds);
  const rows = await db
    .select({
      id: channels.id,
      guildId: channels.guildId,
      type: channels.type,
      name: channels.name,
    })
    .from(channels)
    .where(inArray(channels.id, ids));

  const rowById = new Map(rows.map(row => [row.id, row]));
  const payloads: MessageChannelMention[] = [];

  for (const channelId of ids) {
    const row = rowById.get(channelId);
    if (!row) {
      continue;
    }

    payloads.push({
      id: row.id,
      guild_id: row.guildId,
      type: row.type as ChannelTypeValue,
      name: row.name ?? null,
    });
  }

  return payloads;
};

export const resolveMentionUserSummaries = async (userIds: string[]) => {
  const rows = await resolveMentionUsers(userIds);
  const summaries = new Map<string, SharedUserSummary>();

  for (const [userId, user] of rows.entries()) {
    summaries.set(userId, {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
    });
  }

  return summaries;
};

export const getGuildNotificationSettings = async (
  userIds: string[],
  guildId: string,
  channelId: string,
): Promise<Map<string, EffectiveNotificationSettings>> => {
  const ids = unique(userIds);
  if (ids.length === 0) {
    return new Map();
  }

  const [defaultRows, guildRows, channelRows] = await Promise.all([
    db
      .select({
        userId: userSettings.userId,
        defaultGuildNotificationLevel: userSettings.defaultGuildNotificationLevel,
      })
      .from(userSettings)
      .where(inArray(userSettings.userId, ids)),
    db
      .select({
        userId: userGuildNotificationSettings.userId,
        level: userGuildNotificationSettings.level,
        suppressEveryone: userGuildNotificationSettings.suppressEveryone,
        muted: userGuildNotificationSettings.muted,
        mutedUntil: userGuildNotificationSettings.mutedUntil,
      })
      .from(userGuildNotificationSettings)
      .where(
        and(
          eq(userGuildNotificationSettings.guildId, guildId),
          inArray(userGuildNotificationSettings.userId, ids),
        ),
      ),
    db
      .select({
        userId: userChannelNotificationSettings.userId,
        level: userChannelNotificationSettings.level,
        muted: userChannelNotificationSettings.muted,
        mutedUntil: userChannelNotificationSettings.mutedUntil,
      })
      .from(userChannelNotificationSettings)
      .where(
        and(
          eq(userChannelNotificationSettings.channelId, channelId),
          inArray(userChannelNotificationSettings.userId, ids),
        ),
      ),
  ]);

  const defaultsByUser = new Map(defaultRows.map(row => [row.userId, row.defaultGuildNotificationLevel]));
  const guildByUser = new Map(guildRows.map(row => [row.userId, row]));
  const channelByUser = new Map(channelRows.map(row => [row.userId, row]));

  const results = new Map<string, EffectiveNotificationSettings>();
  for (const userId of ids) {
    const defaultLevel = defaultsByUser.get(userId) ?? "ONLY_MENTIONS";
    const guildConfig = guildByUser.get(userId);
    const channelConfig = channelByUser.get(userId);

    const guildMuted = guildConfig ? isMutedActive(guildConfig.muted, guildConfig.mutedUntil) : false;
    const channelMuted = channelConfig ? isMutedActive(channelConfig.muted, channelConfig.mutedUntil) : false;
    const level = channelConfig?.level ?? guildConfig?.level ?? defaultLevel;

    results.set(userId, {
      level,
      muted: guildMuted || channelMuted,
      suppressEveryone: guildConfig?.suppressEveryone ?? false,
    });
  }

  return results;
};

export const getDmNotificationSettings = async (
  userIds: string[],
  channelId: string,
): Promise<Map<string, EffectiveNotificationSettings>> => {
  const ids = unique(userIds);
  if (ids.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      userId: userChannelNotificationSettings.userId,
      level: userChannelNotificationSettings.level,
      muted: userChannelNotificationSettings.muted,
      mutedUntil: userChannelNotificationSettings.mutedUntil,
    })
    .from(userChannelNotificationSettings)
    .where(and(eq(userChannelNotificationSettings.channelId, channelId), inArray(userChannelNotificationSettings.userId, ids)));

  const byUser = new Map(rows.map(row => [row.userId, row]));
  const result = new Map<string, EffectiveNotificationSettings>();

  for (const userId of ids) {
    const row = byUser.get(userId);
    result.set(userId, {
      level: row?.level ?? "ALL_MESSAGES",
      muted: row ? isMutedActive(row.muted, row.mutedUntil) : false,
      suppressEveryone: false,
    });
  }

  return result;
};
