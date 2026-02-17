import type {
  APIAttachment,
  ChannelPermissionOverwrite,
  DmChannelPayload,
  GatewayPacket,
  GuildRole,
  GuildChannelPayload,
  GuildCreateEvent,
  InvitePayload,
  MessagePayload,
  PartialGuild,
  ReadyEvent,
  UserSummary as SharedUserSummary,
} from "@discord/types";
import { ChannelType } from "@discord/types";
import { and, asc, count, desc, eq, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { auth } from "./auth";
import { db } from "./db";
import {
  channelMembers,
  channelPermissionOverwrites,
  channels,
  guildMembers,
  guildMemberRoles,
  guildRoles,
  guilds,
  invites,
  messageAttachments,
  messageReads,
  messages,
  users,
} from "./db/schema";
import { env } from "./env";
import { nextSnowflake } from "./lib/snowflake";
import { ensureAppUser, getUserSummaryById, toUserSummary, type AuthUserLike, type UserSummary } from "./lib/users";
import { presignGet, toPublicObjectUrl } from "./storage/s3";

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const MESSAGE_MAX_LENGTH = 2_000;
export const MAX_NAME_LENGTH = 100;
export const MAX_TOPIC_LENGTH = 1_024;
export const ID_REGEX = /^\d+$/;
export const INVITE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export const guildNameSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
});

export const createGuildChannelSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  type: z.union([z.literal(0), z.literal(4)]),
  parent_id: z.string().trim().min(1).max(32).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  topic: z.string().trim().min(0).max(MAX_TOPIC_LENGTH).nullable().optional(),
});

export const patchChannelSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  topic: z.string().trim().max(MAX_TOPIC_LENGTH).nullable().optional(),
  parent_id: z.string().trim().min(1).max(32).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});

export const createMessageSchema = z.object({
  content: z.string().max(MESSAGE_MAX_LENGTH).optional(),
  attachment_upload_ids: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
})
  .superRefine((value, ctx) => {
    const hasContent = Boolean(value.content?.trim());
    const hasAttachments = (value.attachment_upload_ids?.length ?? 0) > 0;

    if (!hasContent && !hasAttachments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message must include content or attachments.",
      });
    }
  });

export const editMessageSchema = z.object({
  content: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
});

export const readStateSchema = z.object({
  last_read_message_id: z.string().trim().min(1).max(32).nullable(),
});

export const createInviteSchema = z
  .object({
    max_age: z.number().int().min(0).max(7 * 24 * 60 * 60).optional(),
    max_uses: z.number().int().min(0).max(10_000).optional(),
  })
  .passthrough();

export enum GatewayOp {
  DISPATCH = 0,
  HEARTBEAT = 1,
  IDENTIFY = 2,
  RESUME = 6,
  RECONNECT = 7,
  INVALID_SESSION = 9,
  HELLO = 10,
  HEARTBEAT_ACK = 11,
}

export type WsData = { connectionId: string };

export type GatewayConnection = {
  id: string;
  ws: Bun.ServerWebSocket<WsData>;
  userId: string | null;
  identified: boolean;
  sessionId: string | null;
  seq: number;
  lastHeartbeatAt: number;
  zombieTimer?: ReturnType<typeof setInterval>;
};

export type ChannelRow = typeof channels.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type MessageAttachmentRow = typeof messageAttachments.$inferSelect;
type GuildRow = typeof guilds.$inferSelect;
type InviteRow = typeof invites.$inferSelect;
type GuildRoleRow = typeof guildRoles.$inferSelect;

export const gatewayConnections = new Map<string, GatewayConnection>();
export const connectionsByUserId = new Map<string, Set<string>>();
export const gatewayTokens = new Map<string, { userId: string; expiresAt: number }>();

export const now = () => Date.now();
export const nextId = () => nextSnowflake().toString();

export const toIso = (value: Date | string | null): string | null => {
  if (!value) {
    return null;
  }
  return new Date(value).toISOString();
};

export const toSummary = (user: UserSummary): SharedUserSummary => ({
  id: user.id,
  username: user.username,
  display_name: user.display_name,
  avatar_url: user.avatar_url,
});

export const parseSnowflake = (value: string | null | undefined): bigint | null => {
  if (!value || !ID_REGEX.test(value)) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

export const compareSnowflakesDesc = (a: string | null, b: string | null): number => {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    if (left === right) return 0;
    return left > right ? -1 : 1;
  } catch {
    return 0;
  }
};

export const normalizeName = (value: string): string => value.trim().slice(0, MAX_NAME_LENGTH);

const randomInviteCode = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += INVITE_CODE_CHARS[byte % INVITE_CODE_CHARS.length] ?? "A";
  }
  return code;
};

export const getAuthedUser = async (request: Request): Promise<UserSummary | null> => {
  const session = (await auth.api.getSession({
    headers: request.headers,
  })) as { user?: AuthUserLike } | null;

  if (!session?.user?.id) {
    return null;
  }

  return ensureAppUser({
    id: String(session.user.id),
    email: session.user.email ?? null,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
  });
};

export const sendPacket = (conn: GatewayConnection, packet: GatewayPacket): void => {
  try {
    conn.ws.send(JSON.stringify(packet));
  } catch {
    // Socket likely closed.
  }
};

export const dispatch = (conn: GatewayConnection, event: string, data: unknown): void => {
  conn.seq += 1;
  sendPacket(conn, {
    op: GatewayOp.DISPATCH,
    t: event,
    d: data,
    s: conn.seq,
  });
};

export const addConnectionToUser = (userId: string, connectionId: string): void => {
  const existing = connectionsByUserId.get(userId);
  if (existing) {
    existing.add(connectionId);
    return;
  }
  connectionsByUserId.set(userId, new Set([connectionId]));
};

export const removeConnectionFromUser = (userId: string, connectionId: string): void => {
  const existing = connectionsByUserId.get(userId);
  if (!existing) {
    return;
  }
  existing.delete(connectionId);
  if (existing.size === 0) {
    connectionsByUserId.delete(userId);
  }
};

export const emitToUsers = (userIds: string[], event: string, data: unknown): void => {
  const deduped = [...new Set(userIds)];
  for (const userId of deduped) {
    const connectionIds = connectionsByUserId.get(userId);
    if (!connectionIds) {
      continue;
    }

    for (const connectionId of connectionIds) {
      const connection = gatewayConnections.get(connectionId);
      if (!connection || !connection.identified) {
        continue;
      }
      dispatch(connection, event, data);
    }
  }
};

export const getGuildMemberIds = async (guildId: string): Promise<string[]> => {
  const rows = await db
    .select({ userId: guildMembers.userId })
    .from(guildMembers)
    .where(eq(guildMembers.guildId, guildId));

  return rows.map(row => row.userId);
};

export const getDmMemberIds = async (channelId: string): Promise<string[]> => {
  const rows = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId));

  return rows.map(row => row.userId);
};

export const getUserAudienceIds = async (userId: string): Promise<string[]> => {
  const audience = new Set<string>([userId]);

  const guildRows = await db
    .select({ guildId: guildMembers.guildId })
    .from(guildMembers)
    .where(eq(guildMembers.userId, userId));

  const guildIds = [...new Set(guildRows.map(row => row.guildId))];
  if (guildIds.length > 0) {
    const guildMembersRows = await db
      .select({ memberId: guildMembers.userId })
      .from(guildMembers)
      .where(inArray(guildMembers.guildId, guildIds));

    for (const member of guildMembersRows) {
      audience.add(member.memberId);
    }
  }

  const dmMemberships = await db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(channels, eq(channelMembers.channelId, channels.id))
    .where(and(eq(channelMembers.userId, userId), eq(channels.type, ChannelType.DM)));

  const dmChannelIds = [...new Set(dmMemberships.map(row => row.channelId))];
  if (dmChannelIds.length > 0) {
    const dmMembersRows = await db
      .select({ memberId: channelMembers.userId })
      .from(channelMembers)
      .where(inArray(channelMembers.channelId, dmChannelIds));

    for (const member of dmMembersRows) {
      audience.add(member.memberId);
    }
  }

  return [...audience];
};

export const broadcastUserUpdate = async (userId: string, user: UserSummary): Promise<void> => {
  const recipients = await getUserAudienceIds(userId);
  emitToUsers(recipients, "USER_UPDATE", toSummary(user));
};

export const emitUserSettingsUpdate = (userId: string, settings: unknown): void => {
  emitToUsers([userId], "USER_SETTINGS_UPDATE", settings);
};

export const emitToGuild = async (guildId: string, event: string, data: unknown): Promise<void> => {
  const members = await getGuildMemberIds(guildId);
  emitToUsers(members, event, data);
};

export const emitToDm = async (channelId: string, event: string, data: unknown): Promise<void> => {
  const members = await getDmMemberIds(channelId);
  emitToUsers(members, event, data);
};

export const emitToChannelAudience = async (channel: ChannelRow, event: string, data: unknown): Promise<void> => {
  if (channel.type === ChannelType.DM) {
    await emitToDm(channel.id, event, data);
    return;
  }

  if (channel.guildId) {
    await emitToGuild(channel.guildId, event, data);
  }
};

const normalizeContentType = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  const normalized = value.split(";")[0]?.trim().toLowerCase();
  return normalized || null;
};

const supportsInlinePreview = (contentType: string | null): boolean => {
  if (!contentType) {
    return false;
  }

  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType === "application/pdf" ||
    contentType.startsWith("text/")
  );
};

const sanitizeDispositionFilename = (filename: string): string => filename.replace(/[\r\n\"\\\\]+/g, "_");

const resolveAttachmentDownloadUrl = (attachment: MessageAttachmentRow): string => {
  if (attachment.urlKind === "public") {
    const publicUrl = toPublicObjectUrl(attachment.s3Key);
    if (publicUrl) {
      return publicUrl;
    }
  }

  const contentType = normalizeContentType(attachment.contentType);
  const dispositionType = supportsInlinePreview(contentType) ? "inline" : "attachment";
  const disposition = `${dispositionType}; filename=\"${sanitizeDispositionFilename(attachment.filename)}\"`;

  return presignGet(attachment.s3Key, {
    expiresIn: env.DOWNLOAD_PRESIGN_EXPIRES_SECONDS,
    contentType: contentType ?? undefined,
    contentDisposition: disposition,
  });
};

export const toAttachmentPayload = (attachment: MessageAttachmentRow): APIAttachment => {
  const url = resolveAttachmentDownloadUrl(attachment);
  return {
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    url,
    proxy_url: url,
    content_type: attachment.contentType ?? null,
  };
};

export const listMessageAttachmentPayloads = async (messageIds: string[]): Promise<Map<string, APIAttachment[]>> => {
  if (messageIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select()
    .from(messageAttachments)
    .where(inArray(messageAttachments.messageId, messageIds))
    .orderBy(asc(messageAttachments.createdAt), asc(sql`${messageAttachments.id}::bigint`));

  const grouped = new Map<string, APIAttachment[]>();
  for (const row of rows) {
    const current = grouped.get(row.messageId) ?? [];
    current.push(toAttachmentPayload(row));
    grouped.set(row.messageId, current);
  }

  return grouped;
};

export const makeMessagePayload = (
  message: MessageRow,
  author: SharedUserSummary,
  guildId: string | null,
  attachments: APIAttachment[] = [],
): MessagePayload => ({
  id: message.id,
  channel_id: message.channelId,
  guild_id: guildId,
  author,
  content: message.content,
  attachments,
  timestamp: toIso(message.createdAt) ?? new Date().toISOString(),
  edited_timestamp: toIso(message.editedAt),
  type: 0,
});

export const toGuildPayload = (guild: GuildRow): PartialGuild => ({
  id: guild.id,
  name: guild.name,
  icon: guild.icon,
  owner_id: guild.ownerId,
  verification_level: guild.verificationLevel,
  default_message_notifications: guild.defaultMessageNotifications,
  explicit_content_filter: guild.explicitContentFilter,
  preferred_locale: guild.preferredLocale,
  system_channel_id: guild.systemChannelId,
  rules_channel_id: guild.rulesChannelId,
  public_updates_channel_id: guild.publicUpdatesChannelId,
});

export const toGuildChannelPayload = (channel: ChannelRow): GuildChannelPayload => ({
  id: channel.id,
  type: channel.type === ChannelType.GUILD_CATEGORY ? ChannelType.GUILD_CATEGORY : ChannelType.GUILD_TEXT,
  guild_id: channel.guildId ?? "",
  parent_id: channel.parentId,
  name: channel.name ?? "",
  topic: channel.topic,
  position: channel.position,
});

export const listChannelPermissionOverwrites = async (channelId: string): Promise<ChannelPermissionOverwrite[]> => {
  const rows = await db
    .select({
      id: channelPermissionOverwrites.overwriteId,
      type: channelPermissionOverwrites.type,
      allow: channelPermissionOverwrites.allow,
      deny: channelPermissionOverwrites.deny,
    })
    .from(channelPermissionOverwrites)
    .where(eq(channelPermissionOverwrites.channelId, channelId));

  return rows
    .filter(row => row.type === 0 || row.type === 1)
    .map(row => ({
      id: row.id,
      type: row.type as 0 | 1,
      allow: row.allow,
      deny: row.deny,
    }));
};

export const toGuildChannelPayloadWithOverwrites = async (channel: ChannelRow): Promise<GuildChannelPayload> => ({
  ...toGuildChannelPayload(channel),
  permission_overwrites: await listChannelPermissionOverwrites(channel.id),
});

export const toGuildRolePayload = (role: GuildRoleRow): GuildRole => ({
  id: role.id,
  guild_id: role.guildId,
  name: role.name,
  permissions: role.permissions,
  position: role.position,
  color: role.color,
  hoist: role.hoist,
  mentionable: role.mentionable,
  managed: role.managed,
});

export const toDmChannelPayload = async (channel: ChannelRow, viewerId: string): Promise<DmChannelPayload | null> => {
  if (channel.type !== ChannelType.DM) {
    return null;
  }

  const members = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channel.id));

  if (members.length !== 2) {
    return null;
  }

  const recipientId = members.find(member => member.userId !== viewerId)?.userId;
  if (!recipientId) {
    return null;
  }

  const recipient = await getUserSummaryById(recipientId);
  if (!recipient) {
    return null;
  }

  const [lastMessage] = await db
    .select()
    .from(messages)
    .where(eq(messages.channelId, channel.id))
    .orderBy(desc(sql`${messages.id}::bigint`))
    .limit(1);

  const readState = await db.query.messageReads.findFirst({
    where: and(eq(messageReads.channelId, channel.id), eq(messageReads.userId, viewerId)),
  });

  let lastMessagePayload: MessagePayload | null = null;
  if (lastMessage) {
    const author = await getUserSummaryById(lastMessage.authorId);
    const attachmentsByMessage = await listMessageAttachmentPayloads([lastMessage.id]);
    lastMessagePayload = makeMessagePayload(
      lastMessage,
      {
        id: author?.id ?? lastMessage.authorId,
        username: author?.username ?? "unknown",
        display_name: author?.display_name ?? "Unknown",
        avatar_url: author?.avatar_url ?? null,
      },
      null,
      attachmentsByMessage.get(lastMessage.id) ?? [],
    );
  }

  const unread =
    Boolean(lastMessage?.id) &&
    (!readState?.lastReadMessageId || compareSnowflakesDesc(lastMessage!.id, readState.lastReadMessageId) === -1);

  return {
    id: channel.id,
    type: 1,
    guild_id: null,
    parent_id: null,
    name: null,
    topic: null,
    position: 0,
    recipients: [toSummary(recipient)],
    last_message_id: lastMessage?.id ?? null,
    last_message: lastMessagePayload,
    unread,
  };
};

export const listDmChannelsForUser = async (userId: string): Promise<DmChannelPayload[]> => {
  const memberships = await db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(channels, eq(channelMembers.channelId, channels.id))
    .where(and(eq(channelMembers.userId, userId), eq(channels.type, ChannelType.DM)));

  const results: DmChannelPayload[] = [];
  for (const membership of memberships) {
    const channel = await db.query.channels.findFirst({
      where: eq(channels.id, membership.channelId),
    });

    if (!channel) {
      continue;
    }

    const payload = await toDmChannelPayload(channel, userId);
    if (payload) {
      results.push(payload);
    }
  }

  results.sort((a, b) => compareSnowflakesDesc(a.last_message_id, b.last_message_id));
  return results;
};

export const getUserGuilds = async (userId: string): Promise<PartialGuild[]> => {
  const rows = await db
    .select({
      id: guilds.id,
      name: guilds.name,
      icon: guilds.icon,
      owner_id: guilds.ownerId,
    })
    .from(guildMembers)
    .innerJoin(guilds, eq(guildMembers.guildId, guilds.id))
    .where(eq(guildMembers.userId, userId))
    .orderBy(asc(guilds.name));

  return rows;
};

export const listGuildRoles = async (guildId: string): Promise<GuildRole[]> => {
  const rows = await db
    .select()
    .from(guildRoles)
    .where(eq(guildRoles.guildId, guildId))
    .orderBy(desc(guildRoles.position), asc(sql`${guildRoles.id}::bigint`));

  return rows.map(toGuildRolePayload);
};

export const listGuildMemberRoleIds = async (guildId: string, userId: string): Promise<string[]> => {
  const rows = await db
    .select({ roleId: guildMemberRoles.roleId })
    .from(guildMemberRoles)
    .where(and(eq(guildMemberRoles.guildId, guildId), eq(guildMemberRoles.userId, userId)));

  return rows.map(row => row.roleId);
};

export const getGuildChannels = async (guildId: string): Promise<GuildChannelPayload[]> => {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.guildId, guildId), inArray(channels.type, [ChannelType.GUILD_TEXT, ChannelType.GUILD_CATEGORY])))
    .orderBy(asc(channels.position), asc(sql`${channels.id}::bigint`));

  return Promise.all(rows.map(toGuildChannelPayloadWithOverwrites));
};

export const getGuildChannelTree = async (
  guildId: string,
): Promise<Array<{ category: GuildChannelPayload | null; channels: GuildChannelPayload[] }>> => {
  const allChannels = await getGuildChannels(guildId);
  const categories = allChannels.filter(channel => channel.type === ChannelType.GUILD_CATEGORY);
  const textChannels = allChannels.filter(channel => channel.type === ChannelType.GUILD_TEXT);

  const grouped = new Map<string | null, GuildChannelPayload[]>();
  for (const channel of textChannels) {
    const key = channel.parent_id;
    const existing = grouped.get(key) ?? [];
    existing.push(channel);
    grouped.set(key, existing);
  }

  for (const channelsInGroup of grouped.values()) {
    channelsInGroup.sort((a, b) => a.position - b.position || compareSnowflakesDesc(b.id, a.id));
  }

  const tree: Array<{ category: GuildChannelPayload | null; channels: GuildChannelPayload[] }> = [];
  const ungrouped = grouped.get(null) ?? [];
  if (ungrouped.length > 0) {
    tree.push({ category: null, channels: ungrouped });
  }

  for (const category of categories) {
    tree.push({
      category,
      channels: grouped.get(category.id) ?? [],
    });
  }

  return tree;
};

export const getGuildWithChannels = async (
  guildId: string,
  userId: string,
): Promise<{ guild: PartialGuild; channels: GuildChannelPayload[] } | null> => {
  const membership = await db.query.guildMembers.findFirst({
    where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)),
  });

  if (!membership) {
    return null;
  }

  const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, guildId) });
  if (!guild) {
    return null;
  }

  const guildChannels = await getGuildChannels(guildId);
  return {
    guild: toGuildPayload(guild),
    channels: guildChannels,
  };
};

export const isGuildOwner = async (userId: string, guildId: string): Promise<boolean> => {
  const guild = await db.query.guilds.findFirst({
    where: and(eq(guilds.id, guildId), eq(guilds.ownerId, userId)),
  });

  return Boolean(guild);
};

export const canAccessGuild = async (userId: string, guildId: string): Promise<boolean> => {
  const member = await db.query.guildMembers.findFirst({
    where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)),
  });

  return Boolean(member);
};

export const canAccessDm = async (userId: string, channelId: string): Promise<boolean> => {
  const member = await db.query.channelMembers.findFirst({
    where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)),
  });
  return Boolean(member);
};

export const canAccessChannel = async (
  userId: string,
  channelId: string,
): Promise<{ channel: ChannelRow; scope: "DM" | "GUILD" } | null> => {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
  });

  if (!channel) {
    return null;
  }

  if (channel.type === ChannelType.DM) {
    const allowed = await canAccessDm(userId, channelId);
    return allowed ? { channel, scope: "DM" } : null;
  }

  if (!channel.guildId) {
    return null;
  }

  const allowed = await canAccessGuild(userId, channel.guildId);
  return allowed ? { channel, scope: "GUILD" } : null;
};

export const findExistingDmChannel = async (userId: string, recipientId: string): Promise<string | null> => {
  const myMemberships = await db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(channels, eq(channelMembers.channelId, channels.id))
    .where(and(eq(channelMembers.userId, userId), eq(channels.type, ChannelType.DM)));

  for (const membership of myMemberships) {
    const members = await db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, membership.channelId));

    if (members.length === 2 && members.some(member => member.userId === recipientId)) {
      return membership.channelId;
    }
  }

  return null;
};

export const listChannelMessages = async (
  channelId: string,
  limit: number,
  before?: bigint,
): Promise<MessagePayload[]> => {
  const where = before
    ? and(eq(messages.channelId, channelId), sql`${messages.id}::bigint < ${before}`)
    : eq(messages.channelId, channelId);

  const rows = await db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(sql`${messages.id}::bigint`))
    .limit(limit);

  if (rows.length === 0) {
    return [];
  }

  const authorIds = [...new Set(rows.map(row => row.authorId))];
  const authorRows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      avatarS3Key: users.avatarS3Key,
    })
    .from(users)
    .where(inArray(users.id, authorIds));

  const authors = new Map(authorRows.map(row => [row.id, toUserSummary(row)]));
  const attachmentsByMessage = await listMessageAttachmentPayloads(rows.map(row => row.id));

  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
  });

  const guildId = channel?.guildId ?? null;

  return rows.map(row => {
    const author = authors.get(row.authorId);
    return makeMessagePayload(
      row,
      {
        id: author?.id ?? row.authorId,
        username: author?.username ?? "unknown",
        display_name: author?.display_name ?? "Unknown",
        avatar_url: author?.avatar_url ?? null,
      },
      guildId,
      attachmentsByMessage.get(row.id) ?? [],
    );
  });
};

export const createInvite = async (
  channelId: string,
  guildId: string,
  inviterId: string,
  options?: { max_age?: number; max_uses?: number },
): Promise<InviteRow> => {
  const maxAgeSeconds = options?.max_age ?? 86_400;
  const maxUses = options?.max_uses ?? 0;
  const expiresAt = maxAgeSeconds > 0 ? new Date(Date.now() + maxAgeSeconds * 1_000) : null;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = randomInviteCode();
    try {
      const [created] = await db
        .insert(invites)
        .values({
          code,
          guildId,
          channelId,
          inviterId,
          maxAgeSeconds,
          maxUses,
          uses: 0,
          expiresAt,
        })
        .returning();

      if (created) {
        return created;
      }
    } catch {
      // Retry on key collisions.
    }
  }

  throw new Error("Failed to create invite code.");
};

export const hydrateInvitePayload = async (
  invite: InviteRow,
  withCounts = false,
): Promise<InvitePayload | null> => {
  const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, invite.guildId) });
  const channel = await db.query.channels.findFirst({ where: eq(channels.id, invite.channelId) });
  const inviter = await getUserSummaryById(invite.inviterId);

  if (!guild || !channel || !inviter || !channel.guildId || !channel.name) {
    return null;
  }

  const payload: InvitePayload = {
    code: invite.code,
    guild: toGuildPayload(guild),
    channel: {
      id: channel.id,
      name: channel.name,
      type: channel.type === ChannelType.GUILD_CATEGORY ? ChannelType.GUILD_CATEGORY : ChannelType.GUILD_TEXT,
      guild_id: channel.guildId,
      parent_id: channel.parentId,
    },
    inviter: toSummary(inviter),
    created_at: toIso(invite.createdAt) ?? new Date().toISOString(),
    expires_at: toIso(invite.expiresAt),
    max_age: invite.maxAgeSeconds,
    max_uses: invite.maxUses,
    uses: invite.uses,
  };

  if (withCounts) {
    const [memberCountRow] = await db
      .select({ value: count() })
      .from(guildMembers)
      .where(eq(guildMembers.guildId, invite.guildId));

    const memberIds = await getGuildMemberIds(invite.guildId);
    let online = 0;
    for (const memberId of memberIds) {
      if ((connectionsByUserId.get(memberId)?.size ?? 0) > 0) {
        online += 1;
      }
    }

    payload.approximate_member_count = Number(memberCountRow?.value ?? 0);
    payload.approximate_presence_count = online;
  }

  return payload;
};

export const isInviteExpired = (invite: InviteRow): boolean => {
  if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
    return true;
  }

  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    return true;
  }

  return false;
};

export const buildGuildCreateEvent = async (guildId: string, userId: string): Promise<GuildCreateEvent | null> => {
  const guild = await db.query.guilds.findFirst({
    where: eq(guilds.id, guildId),
  });

  if (!guild) {
    return null;
  }

  const membership = await db.query.guildMembers.findFirst({
    where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)),
  });

  if (!membership) {
    return null;
  }

  const [memberCountRow] = await db
    .select({ value: count() })
    .from(guildMembers)
    .where(eq(guildMembers.guildId, guildId));

  const memberUser = await getUserSummaryById(userId);
  if (!memberUser) {
    return null;
  }

  const guildChannels = await getGuildChannels(guildId);

  return {
    ...toGuildPayload(guild),
    joined_at: toIso(membership.joinedAt) ?? new Date().toISOString(),
    member_count: Number(memberCountRow?.value ?? 0),
    channels: guildChannels,
    members: [
      {
        user: toSummary(memberUser),
        joined_at: toIso(membership.joinedAt) ?? new Date().toISOString(),
        role: membership.role,
      },
    ],
  };
};

export const startZombieMonitor = (connection: GatewayConnection): void => {
  if (connection.zombieTimer) {
    clearInterval(connection.zombieTimer);
  }

  connection.zombieTimer = setInterval(() => {
    if (now() - connection.lastHeartbeatAt > HEARTBEAT_INTERVAL_MS * 2) {
      try {
        connection.ws.close(4000, "Heartbeat timeout");
      } catch {
        // ignored
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
};

export const consumeGatewayToken = (token: string): string | null => {
  const record = gatewayTokens.get(token);
  if (!record) {
    return null;
  }

  if (record.expiresAt < now()) {
    gatewayTokens.delete(token);
    return null;
  }

  gatewayTokens.delete(token);
  return record.userId;
};

export const createGatewayToken = (userId: string): string => {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  gatewayTokens.set(token, {
    userId,
    expiresAt: now() + env.GATEWAY_TOKEN_TTL_SECONDS * 1_000,
  });
  return token;
};

setInterval(() => {
  for (const [token, value] of gatewayTokens.entries()) {
    if (value.expiresAt < now()) {
      gatewayTokens.delete(token);
    }
  }
}, 30_000);

export const sendReadyAndBackfillGuilds = async (connection: GatewayConnection, user: UserSummary): Promise<void> => {
  const privateChannels = await listDmChannelsForUser(user.id);
  const userGuilds = await getUserGuilds(user.id);

  const ready: ReadyEvent = {
    v: 1,
    user: toSummary(user),
    session_id: connection.sessionId ?? crypto.randomUUID(),
    resume_gateway_url: "/gateway",
    private_channels: privateChannels,
    guilds: userGuilds.map(guild => ({ id: guild.id, unavailable: true as const })),
  };

  connection.sessionId = ready.session_id;
  dispatch(connection, "READY", ready);

  for (const guild of userGuilds) {
    const payload = await buildGuildCreateEvent(guild.id, user.id);
    if (payload) {
      dispatch(connection, "GUILD_CREATE", payload);
    }
  }
};
