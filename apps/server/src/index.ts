import type {
  DmChannelPayload,
  GatewayPacket,
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
  channels,
  guildMembers,
  guilds,
  invites,
  messageReads,
  messages,
  users,
} from "./db/schema";
import { env } from "./env";
import { preflight, withCors } from "./lib/cors";
import { nextSnowflake } from "./lib/snowflake";
import { ensureAppUser, getUserSummaryById, type AuthUserLike, type UserSummary } from "./lib/users";

const HEARTBEAT_INTERVAL_MS = 25_000;
const MESSAGE_MAX_LENGTH = 2_000;
const MAX_NAME_LENGTH = 100;
const MAX_TOPIC_LENGTH = 1_024;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,32}$/;
const ID_REGEX = /^\d+$/;
const INVITE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const guildNameSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
});

const createGuildChannelSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  type: z.union([z.literal(0), z.literal(4)]),
  parent_id: z.string().trim().min(1).max(32).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  topic: z.string().trim().min(0).max(MAX_TOPIC_LENGTH).nullable().optional(),
});

const patchChannelSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  topic: z.string().trim().max(MAX_TOPIC_LENGTH).nullable().optional(),
  parent_id: z.string().trim().min(1).max(32).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});

const createMessageSchema = z.object({
  content: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
});

const readStateSchema = z.object({
  last_read_message_id: z.string().trim().min(1).max(32).nullable(),
});

const createInviteSchema = z
  .object({
    max_age: z.number().int().min(0).max(7 * 24 * 60 * 60).optional(),
    max_uses: z.number().int().min(0).max(10_000).optional(),
  })
  .passthrough();

enum GatewayOp {
  DISPATCH = 0,
  HEARTBEAT = 1,
  IDENTIFY = 2,
  RESUME = 6,
  RECONNECT = 7,
  INVALID_SESSION = 9,
  HELLO = 10,
  HEARTBEAT_ACK = 11,
}

type WsData = { connectionId: string };

type GatewayConnection = {
  id: string;
  ws: Bun.ServerWebSocket<WsData>;
  userId: string | null;
  identified: boolean;
  sessionId: string | null;
  seq: number;
  lastHeartbeatAt: number;
  zombieTimer?: ReturnType<typeof setInterval>;
};

type ChannelRow = typeof channels.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type GuildRow = typeof guilds.$inferSelect;
type InviteRow = typeof invites.$inferSelect;

const gatewayConnections = new Map<string, GatewayConnection>();
const connectionsByUserId = new Map<string, Set<string>>();
const gatewayTokens = new Map<string, { userId: string; expiresAt: number }>();

const now = () => Date.now();
const nextId = () => nextSnowflake().toString();

const json = (data: unknown, status = 200): Response =>
  Response.json(data, {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

const empty = (status = 204): Response => new Response(null, { status });

const parseJson = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

const toIso = (value: Date | string | null): string | null => {
  if (!value) {
    return null;
  }
  return new Date(value).toISOString();
};

const toSummary = (user: UserSummary): SharedUserSummary => ({
  id: user.id,
  username: user.username,
  display_name: user.display_name,
  avatar_url: user.avatar_url,
});

const parseSnowflake = (value: string | null | undefined): bigint | null => {
  if (!value || !ID_REGEX.test(value)) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

const compareSnowflakesDesc = (a: string | null, b: string | null): number => {
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

const normalizeName = (value: string): string => value.trim().slice(0, MAX_NAME_LENGTH);

const randomInviteCode = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += INVITE_CODE_CHARS[byte % INVITE_CODE_CHARS.length] ?? "A";
  }
  return code;
};

const getAuthedUser = async (request: Request): Promise<UserSummary | null> => {
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

const sendPacket = (conn: GatewayConnection, packet: GatewayPacket): void => {
  try {
    conn.ws.send(JSON.stringify(packet));
  } catch {
    // Socket likely closed.
  }
};

const dispatch = (conn: GatewayConnection, event: string, data: unknown): void => {
  conn.seq += 1;
  sendPacket(conn, {
    op: GatewayOp.DISPATCH,
    t: event,
    d: data,
    s: conn.seq,
  });
};

const addConnectionToUser = (userId: string, connectionId: string): void => {
  const existing = connectionsByUserId.get(userId);
  if (existing) {
    existing.add(connectionId);
    return;
  }
  connectionsByUserId.set(userId, new Set([connectionId]));
};

const removeConnectionFromUser = (userId: string, connectionId: string): void => {
  const existing = connectionsByUserId.get(userId);
  if (!existing) {
    return;
  }
  existing.delete(connectionId);
  if (existing.size === 0) {
    connectionsByUserId.delete(userId);
  }
};

const emitToUsers = (userIds: string[], event: string, data: unknown): void => {
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

const getGuildMemberIds = async (guildId: string): Promise<string[]> => {
  const rows = await db
    .select({ userId: guildMembers.userId })
    .from(guildMembers)
    .where(eq(guildMembers.guildId, guildId));

  return rows.map(row => row.userId);
};

const getDmMemberIds = async (channelId: string): Promise<string[]> => {
  const rows = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId));

  return rows.map(row => row.userId);
};

const emitToGuild = async (guildId: string, event: string, data: unknown): Promise<void> => {
  const members = await getGuildMemberIds(guildId);
  emitToUsers(members, event, data);
};

const emitToDm = async (channelId: string, event: string, data: unknown): Promise<void> => {
  const members = await getDmMemberIds(channelId);
  emitToUsers(members, event, data);
};

const emitToChannelAudience = async (channel: ChannelRow, event: string, data: unknown): Promise<void> => {
  if (channel.type === ChannelType.DM) {
    await emitToDm(channel.id, event, data);
    return;
  }

  if (channel.guildId) {
    await emitToGuild(channel.guildId, event, data);
  }
};

const makeMessagePayload = (message: MessageRow, author: SharedUserSummary, guildId: string | null): MessagePayload => ({
  id: message.id,
  channel_id: message.channelId,
  guild_id: guildId,
  author,
  content: message.content,
  timestamp: toIso(message.createdAt) ?? new Date().toISOString(),
  edited_timestamp: toIso(message.editedAt),
  type: 0,
});

const toGuildPayload = (guild: GuildRow): PartialGuild => ({
  id: guild.id,
  name: guild.name,
  icon: guild.icon,
  owner_id: guild.ownerId,
});

const toGuildChannelPayload = (channel: ChannelRow): GuildChannelPayload => ({
  id: channel.id,
  type: channel.type === ChannelType.GUILD_CATEGORY ? ChannelType.GUILD_CATEGORY : ChannelType.GUILD_TEXT,
  guild_id: channel.guildId ?? "",
  parent_id: channel.parentId,
  name: channel.name ?? "",
  topic: channel.topic,
  position: channel.position,
});

const toDmChannelPayload = async (channel: ChannelRow, viewerId: string): Promise<DmChannelPayload | null> => {
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
    lastMessagePayload = makeMessagePayload(
      lastMessage,
      {
        id: author?.id ?? lastMessage.authorId,
        username: author?.username ?? "unknown",
        display_name: author?.display_name ?? "Unknown",
        avatar_url: author?.avatar_url ?? null,
      },
      null,
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

const listDmChannelsForUser = async (userId: string): Promise<DmChannelPayload[]> => {
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

const getUserGuilds = async (userId: string): Promise<PartialGuild[]> => {
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

const getGuildChannels = async (guildId: string): Promise<GuildChannelPayload[]> => {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.guildId, guildId), inArray(channels.type, [ChannelType.GUILD_TEXT, ChannelType.GUILD_CATEGORY])))
    .orderBy(asc(channels.position), asc(sql`${channels.id}::bigint`));

  return rows.map(toGuildChannelPayload);
};

const getGuildChannelTree = async (
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

const getGuildWithChannels = async (
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

const isGuildOwner = async (userId: string, guildId: string): Promise<boolean> => {
  const guild = await db.query.guilds.findFirst({
    where: and(eq(guilds.id, guildId), eq(guilds.ownerId, userId)),
  });

  return Boolean(guild);
};

const canAccessGuild = async (userId: string, guildId: string): Promise<boolean> => {
  const member = await db.query.guildMembers.findFirst({
    where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)),
  });

  return Boolean(member);
};

const canAccessDm = async (userId: string, channelId: string): Promise<boolean> => {
  const member = await db.query.channelMembers.findFirst({
    where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)),
  });
  return Boolean(member);
};

const canAccessChannel = async (
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

const findExistingDmChannel = async (userId: string, recipientId: string): Promise<string | null> => {
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

const listChannelMessages = async (
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
      display_name: users.displayName,
      avatar_url: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, authorIds));

  const authors = new Map(authorRows.map(row => [row.id, row]));

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
    );
  });
};

const createInvite = async (
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

const hydrateInvitePayload = async (
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

const isInviteExpired = (invite: InviteRow): boolean => {
  if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
    return true;
  }

  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    return true;
  }

  return false;
};

const buildGuildCreateEvent = async (guildId: string, userId: string): Promise<GuildCreateEvent | null> => {
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

const startZombieMonitor = (connection: GatewayConnection): void => {
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

const consumeGatewayToken = (token: string): string | null => {
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

const createGatewayToken = (userId: string): string => {
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

const unauthorized = (request: Request): Response =>
  withCors(
    request,
    json(
      {
        error: "Unauthorized",
      },
      401,
    ),
  );

const badRequest = (request: Request, error: string): Response => withCors(request, json({ error }, 400));
const forbidden = (request: Request, error = "Forbidden"): Response => withCors(request, json({ error }, 403));
const notFound = (request: Request): Response => withCors(request, json({ error: "Not found" }, 404));

const handleApiRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;

  if (request.method === "OPTIONS") {
    return preflight(request);
  }

  if (pathname.startsWith("/api/auth")) {
    const response = await auth.handler(request);
    return withCors(request, response);
  }

  if (pathname === "/api/health" && request.method === "GET") {
    return withCors(request, json({ ok: true }));
  }

  const me = await getAuthedUser(request);
  if (!me) {
    return unauthorized(request);
  }

  if (pathname === "/api/users/@me" && request.method === "GET") {
    return withCors(request, json(me));
  }

  if (pathname === "/api/users/@me/profile" && request.method === "PUT") {
    const body = await parseJson<{
      username?: string;
      display_name?: string;
      avatar_url?: string | null;
    }>(request);

    if (!body) {
      return badRequest(request, "Invalid JSON body.");
    }

    const updates: Partial<typeof users.$inferInsert> = {};

    if (body.username !== undefined) {
      if (!USERNAME_REGEX.test(body.username)) {
        return badRequest(request, "username must match /^[a-zA-Z0-9_]{3,32}$/");
      }
      updates.username = body.username;
    }

    if (body.display_name !== undefined) {
      const value = body.display_name.trim();
      if (!value) {
        return badRequest(request, "display_name cannot be empty.");
      }
      updates.displayName = value.slice(0, 64);
    }

    if (body.avatar_url !== undefined) {
      updates.avatarUrl = body.avatar_url;
    }

    if (Object.keys(updates).length === 0) {
      return badRequest(request, "No profile fields provided.");
    }

    try {
      const [updated] = await db
        .update(users)
        .set(updates)
        .where(eq(users.id, me.id))
        .returning();

      if (!updated) {
        return notFound(request);
      }

      return withCors(
        request,
        json({
          id: updated.id,
          username: updated.username,
          display_name: updated.displayName,
          avatar_url: updated.avatarUrl,
        }),
      );
    } catch (error) {
      if (String(error).includes("users_username_unique")) {
        return badRequest(request, "Username is already taken.");
      }
      throw error;
    }
  }

  if (pathname === "/api/users" && request.method === "GET") {
    const query = (searchParams.get("q") ?? searchParams.get("query") ?? "").trim();
    const where = query
      ? and(
          ne(users.id, me.id),
          or(ilike(users.username, `%${query}%`), ilike(users.displayName, `%${query}%`)),
        )
      : ne(users.id, me.id);

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        display_name: users.displayName,
        avatar_url: users.avatarUrl,
      })
      .from(users)
      .where(where)
      .orderBy(users.username)
      .limit(20);

    return withCors(request, json(rows));
  }

  if (pathname === "/api/users/@me/channels" && request.method === "GET") {
    const dmChannels = await listDmChannelsForUser(me.id);
    return withCors(request, json(dmChannels));
  }

  if (pathname === "/api/users/@me/channels" && request.method === "POST") {
    const body = await parseJson<{ recipient_id?: string }>(request);
    const recipientId = body?.recipient_id;

    if (!recipientId) {
      return badRequest(request, "recipient_id is required.");
    }

    if (recipientId === me.id) {
      return badRequest(request, "Cannot create a DM with yourself.");
    }

    const recipient = await getUserSummaryById(recipientId);
    if (!recipient) {
      return notFound(request);
    }

    let channelId = await findExistingDmChannel(me.id, recipientId);
    if (!channelId) {
      const createdChannelId = nextId();
      channelId = createdChannelId;

      await db.transaction(async tx => {
        await tx.insert(channels).values({
          id: createdChannelId,
          type: ChannelType.DM,
          guildId: null,
          parentId: null,
          name: null,
          topic: null,
          position: 0,
        });

        await tx.insert(channelMembers).values([
          { channelId: createdChannelId, userId: me.id },
          { channelId: createdChannelId, userId: recipientId },
        ]);

        await tx.insert(messageReads).values([
          { channelId: createdChannelId, userId: me.id, lastReadMessageId: null },
          { channelId: createdChannelId, userId: recipientId, lastReadMessageId: null },
        ]);
      });

      emitToUsers([me.id], "CHANNEL_CREATE", {
        id: createdChannelId,
        type: 1,
        guild_id: null,
        parent_id: null,
        name: null,
        topic: null,
        position: 0,
        recipients: [toSummary(recipient)],
        last_message_id: null,
      });

      emitToUsers([recipientId], "CHANNEL_CREATE", {
        id: createdChannelId,
        type: 1,
        guild_id: null,
        parent_id: null,
        name: null,
        topic: null,
        position: 0,
        recipients: [toSummary(me)],
        last_message_id: null,
      });
    }

    const channel = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
    if (!channel) {
      return notFound(request);
    }

    const payload = await toDmChannelPayload(channel, me.id);
    if (!payload) {
      return badRequest(request, "Failed to create DM channel.");
    }

    return withCors(request, json(payload));
  }

  if (pathname === "/api/users/@me/guilds" && request.method === "GET") {
    const guildList = await getUserGuilds(me.id);
    return withCors(request, json(guildList));
  }

  if (pathname === "/api/guilds" && request.method === "POST") {
    const body = await parseJson<unknown>(request);
    const parsed = guildNameSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(request, "Invalid guild payload.");
    }

    const guildId = nextId();
    const categoryId = nextId();
    const generalChannelId = nextId();

    await db.transaction(async tx => {
      await tx.insert(guilds).values({
        id: guildId,
        name: normalizeName(parsed.data.name),
        icon: null,
        ownerId: me.id,
      });

      await tx.insert(guildMembers).values({
        guildId,
        userId: me.id,
        role: "OWNER",
      });

      await tx.insert(channels).values([
        {
          id: categoryId,
          type: ChannelType.GUILD_CATEGORY,
          guildId,
          name: "Text Channels",
          topic: null,
          parentId: null,
          position: 0,
        },
        {
          id: generalChannelId,
          type: ChannelType.GUILD_TEXT,
          guildId,
          name: "general",
          topic: null,
          parentId: categoryId,
          position: 0,
        },
      ]);
    });

    const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, guildId) });
    if (!guild) {
      return badRequest(request, "Could not create guild.");
    }

    const guildEvent = await buildGuildCreateEvent(guildId, me.id);
    if (guildEvent) {
      emitToUsers([me.id], "GUILD_CREATE", guildEvent);
    }

    return withCors(request, json(toGuildPayload(guild), 201));
  }

  const guildMatch = pathname.match(/^\/api\/guilds\/([^/]+)$/);
  if (guildMatch && request.method === "GET") {
    const guildId = guildMatch[1];
    if (!guildId) {
      return badRequest(request, "Invalid guild id.");
    }

    const allowed = await canAccessGuild(me.id, guildId);
    if (!allowed) {
      return forbidden(request);
    }

    const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, guildId) });
    if (!guild) {
      return notFound(request);
    }

    return withCors(request, json(toGuildPayload(guild)));
  }

  const guildChannelsMatch = pathname.match(/^\/api\/guilds\/([^/]+)\/channels$/);
  if (guildChannelsMatch) {
    const guildId = guildChannelsMatch[1];
    if (!guildId) {
      return badRequest(request, "Invalid guild id.");
    }

    const allowed = await canAccessGuild(me.id, guildId);
    if (!allowed) {
      return forbidden(request);
    }

    if (request.method === "GET") {
      const guildChannels = await getGuildChannels(guildId);
      return withCors(request, json(guildChannels));
    }

    if (request.method === "POST") {
      const isOwner = await isGuildOwner(me.id, guildId);
      if (!isOwner) {
        return forbidden(request, "Only the guild owner can create channels.");
      }

      const body = await parseJson<unknown>(request);
      const parsed = createGuildChannelSchema.safeParse(body);
      if (!parsed.success) {
        return badRequest(request, "Invalid channel payload.");
      }

      const input = parsed.data;

      if (input.type === ChannelType.GUILD_CATEGORY && input.parent_id !== undefined && input.parent_id !== null) {
        return badRequest(request, "Category channels cannot have a parent_id.");
      }

      let parentId: string | null = input.parent_id ?? null;

      if (input.type === ChannelType.GUILD_TEXT && parentId) {
        const parent = await db.query.channels.findFirst({ where: eq(channels.id, parentId) });
        if (!parent || parent.guildId !== guildId || parent.type !== ChannelType.GUILD_CATEGORY) {
          return badRequest(request, "parent_id must be a category channel in the same guild.");
        }
      }

      if (input.type === ChannelType.GUILD_CATEGORY) {
        parentId = null;
      }

      const [created] = await db
        .insert(channels)
        .values({
          id: nextId(),
          type: input.type,
          guildId,
          name: normalizeName(input.name),
          topic: input.type === ChannelType.GUILD_TEXT ? (input.topic ?? null) : null,
          parentId,
          position: input.position ?? 0,
        })
        .returning();

      if (!created || !created.guildId) {
        return badRequest(request, "Failed to create channel.");
      }

      const payload = toGuildChannelPayload(created);
      await emitToGuild(guildId, "CHANNEL_CREATE", payload);
      return withCors(request, json(payload, 201));
    }

    return withCors(request, json({ error: "Method not allowed" }, 405));
  }

  const channelInviteMatch = pathname.match(/^\/api\/channels\/([^/]+)\/invites$/);
  if (channelInviteMatch && request.method === "POST") {
    const channelId = channelInviteMatch[1];
    if (!channelId) {
      return badRequest(request, "Invalid channel id.");
    }

    const channel = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
    if (!channel || !channel.guildId || channel.type !== ChannelType.GUILD_TEXT) {
      return badRequest(request, "Invites can only be created for guild text channels.");
    }

    const isOwner = await isGuildOwner(me.id, channel.guildId);
    if (!isOwner) {
      return forbidden(request, "Only the guild owner can create invites.");
    }

    const body = (await parseJson<unknown>(request)) ?? {};
    const parsed = createInviteSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(request, "Invalid invite payload.");
    }

    const createdInvite = await createInvite(channel.id, channel.guildId, me.id, {
      max_age: parsed.data.max_age,
      max_uses: parsed.data.max_uses,
    });

    const payload = await hydrateInvitePayload(createdInvite, true);
    if (!payload) {
      return badRequest(request, "Failed to create invite.");
    }

    return withCors(request, json(payload, 201));
  }

  const inviteMatch = pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteMatch && request.method === "GET") {
    const code = inviteMatch[1];
    if (!code) {
      return badRequest(request, "Invalid invite code.");
    }

    const invite = await db.query.invites.findFirst({ where: eq(invites.code, code) });
    if (!invite || isInviteExpired(invite)) {
      return notFound(request);
    }

    const withCounts = searchParams.get("with_counts") === "true";
    const payload = await hydrateInvitePayload(invite, withCounts);
    if (!payload) {
      return notFound(request);
    }

    return withCors(request, json(payload));
  }

  const inviteAcceptMatch = pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
  if (inviteAcceptMatch && request.method === "POST") {
    const code = inviteAcceptMatch[1];
    if (!code) {
      return badRequest(request, "Invalid invite code.");
    }

    const invite = await db.query.invites.findFirst({ where: eq(invites.code, code) });
    if (!invite || isInviteExpired(invite)) {
      return notFound(request);
    }

    const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, invite.guildId) });
    const channel = await db.query.channels.findFirst({ where: eq(channels.id, invite.channelId) });
    if (!guild || !channel || channel.guildId !== guild.id) {
      return notFound(request);
    }

    let joined = false;
    await db.transaction(async tx => {
      const membership = await tx.query.guildMembers.findFirst({
        where: and(eq(guildMembers.guildId, guild.id), eq(guildMembers.userId, me.id)),
      });

      if (!membership) {
        joined = true;
        await tx.insert(guildMembers).values({
          guildId: guild.id,
          userId: me.id,
          role: "MEMBER",
        });

        await tx
          .update(invites)
          .set({ uses: invite.uses + 1 })
          .where(eq(invites.code, code));
      }
    });

    if (joined) {
      const guildEvent = await buildGuildCreateEvent(guild.id, me.id);
      if (guildEvent) {
        emitToUsers([me.id], "GUILD_CREATE", guildEvent);
      }
    }

    return withCors(
      request,
      json({
        guildId: guild.id,
        channelId: channel.id,
      }),
    );
  }

  if (pathname === "/api/gateway/token" && request.method === "POST") {
    const token = createGatewayToken(me.id);
    return withCors(request, json({ token }));
  }

  const channelMessagesMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
  if (channelMessagesMatch) {
    const channelId = channelMessagesMatch[1];
    if (!channelId) {
      return badRequest(request, "Invalid channel id.");
    }

    const access = await canAccessChannel(me.id, channelId);
    if (!access) {
      return forbidden(request);
    }

    if (access.channel.type === ChannelType.GUILD_CATEGORY) {
      return badRequest(request, "Cannot send messages to a category channel.");
    }

    if (request.method === "GET") {
      const limit = Number(searchParams.get("limit") ?? 50);
      const beforeRaw = searchParams.get("before");
      const before = beforeRaw ? parseSnowflake(beforeRaw) : null;
      if (beforeRaw && before === null) {
        return badRequest(request, "Invalid before message id.");
      }

      const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
      const items = await listChannelMessages(channelId, boundedLimit, before ?? undefined);
      return withCors(request, json(items));
    }

    if (request.method === "POST") {
      const body = await parseJson<unknown>(request);
      const parsed = createMessageSchema.safeParse(body);
      if (!parsed.success) {
        return badRequest(request, `content must be between 1 and ${MESSAGE_MAX_LENGTH} characters.`);
      }

      const [created] = await db
        .insert(messages)
        .values({
          id: nextId(),
          channelId,
          authorId: me.id,
          content: parsed.data.content,
        })
        .returning();

      if (!created) {
        return badRequest(request, "Failed to create message.");
      }

      const payload = makeMessagePayload(created, toSummary(me), access.channel.guildId ?? null);
      await emitToChannelAudience(access.channel, "MESSAGE_CREATE", payload);

      return withCors(request, json(payload, 201));
    }

    return withCors(request, json({ error: "Method not allowed" }, 405));
  }

  const messageMutationMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)$/);
  if (messageMutationMatch) {
    const channelId = messageMutationMatch[1];
    const messageId = messageMutationMatch[2];
    if (!channelId || !messageId) {
      return badRequest(request, "Invalid channel id or message id.");
    }

    const access = await canAccessChannel(me.id, channelId);
    if (!access) {
      return forbidden(request);
    }

    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), eq(messages.channelId, channelId)),
    });

    if (!message) {
      return notFound(request);
    }

    if (message.authorId !== me.id) {
      return forbidden(request, "Only the author can modify this message.");
    }

    if (request.method === "PATCH") {
      const body = await parseJson<unknown>(request);
      const parsed = createMessageSchema.safeParse(body);
      if (!parsed.success) {
        return badRequest(request, `content must be between 1 and ${MESSAGE_MAX_LENGTH} characters.`);
      }

      const [updated] = await db
        .update(messages)
        .set({
          content: parsed.data.content,
          editedAt: new Date(),
        })
        .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
        .returning();

      if (!updated) {
        return notFound(request);
      }

      const payload = makeMessagePayload(updated, toSummary(me), access.channel.guildId ?? null);
      await emitToChannelAudience(access.channel, "MESSAGE_UPDATE", payload);
      return withCors(request, json(payload));
    }

    if (request.method === "DELETE") {
      await db
        .delete(messages)
        .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)));

      await emitToChannelAudience(access.channel, "MESSAGE_DELETE", {
        id: messageId,
        channel_id: channelId,
      });
      return withCors(request, empty(204));
    }

    return withCors(request, json({ error: "Method not allowed" }, 405));
  }

  const typingMatch = pathname.match(/^\/api\/channels\/([^/]+)\/typing$/);
  if (typingMatch && request.method === "POST") {
    const channelId = typingMatch[1];
    if (!channelId) {
      return badRequest(request, "Invalid channel id.");
    }

    const access = await canAccessChannel(me.id, channelId);
    if (!access) {
      return forbidden(request);
    }

    if (access.channel.type === ChannelType.GUILD_CATEGORY) {
      return badRequest(request, "Cannot type in a category channel.");
    }

    const payload = {
      channel_id: channelId,
      user_id: me.id,
      timestamp: Math.floor(Date.now() / 1_000),
    };

    if (access.scope === "DM") {
      const members = await getDmMemberIds(channelId);
      emitToUsers(
        members.filter(userId => userId !== me.id),
        "TYPING_START",
        payload,
      );
    } else if (access.channel.guildId) {
      const members = await getGuildMemberIds(access.channel.guildId);
      emitToUsers(
        members.filter(userId => userId !== me.id),
        "TYPING_START",
        payload,
      );
    }

    return withCors(request, empty(204));
  }

  const readMatch = pathname.match(/^\/api\/channels\/([^/]+)\/read$/);
  if (readMatch && request.method === "PUT") {
    const channelId = readMatch[1];
    if (!channelId) {
      return badRequest(request, "Invalid channel id.");
    }

    const access = await canAccessChannel(me.id, channelId);
    if (!access) {
      return forbidden(request);
    }

    const body = await parseJson<unknown>(request);
    const parsed = readStateSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(request, "last_read_message_id is required (can be null).");
    }

    if (parsed.data.last_read_message_id !== null && !ID_REGEX.test(parsed.data.last_read_message_id)) {
      return badRequest(request, "Invalid last_read_message_id.");
    }

    await db
      .insert(messageReads)
      .values({
        channelId,
        userId: me.id,
        lastReadMessageId: parsed.data.last_read_message_id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [messageReads.channelId, messageReads.userId],
        set: {
          lastReadMessageId: parsed.data.last_read_message_id,
          updatedAt: new Date(),
        },
      });

    const payload = {
      channel_id: channelId,
      user_id: me.id,
      last_read_message_id: parsed.data.last_read_message_id,
    };

    await emitToChannelAudience(access.channel, "READ_STATE_UPDATE", payload);
    return withCors(request, json(payload));
  }

  const channelPatchMatch = pathname.match(/^\/api\/channels\/([^/]+)$/);
  if (channelPatchMatch) {
    const channelId = channelPatchMatch[1];
    if (!channelId) {
      return badRequest(request, "Invalid channel id.");
    }

    const access = await canAccessChannel(me.id, channelId);
    if (!access) {
      return forbidden(request);
    }

    if (request.method === "PATCH") {
      const body = await parseJson<unknown>(request);
      const parsed = patchChannelSchema.safeParse(body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        return badRequest(request, "Invalid channel patch payload.");
      }

      const updates: Partial<typeof channels.$inferInsert> = {};

      if (access.scope === "GUILD") {
        if (!access.channel.guildId || !(await isGuildOwner(me.id, access.channel.guildId))) {
          return forbidden(request, "Only the guild owner can update channels.");
        }

        if (parsed.data.name !== undefined) {
          updates.name = normalizeName(parsed.data.name);
        }

        if (parsed.data.topic !== undefined) {
          updates.topic = parsed.data.topic;
        }

        if (parsed.data.position !== undefined) {
          updates.position = parsed.data.position;
        }

        if (parsed.data.parent_id !== undefined) {
          if (access.channel.type === ChannelType.GUILD_CATEGORY && parsed.data.parent_id !== null) {
            return badRequest(request, "Category channels cannot have a parent_id.");
          }

          if (parsed.data.parent_id) {
            const parent = await db.query.channels.findFirst({ where: eq(channels.id, parsed.data.parent_id) });
            if (
              !parent ||
              parent.type !== ChannelType.GUILD_CATEGORY ||
              parent.guildId !== access.channel.guildId
            ) {
              return badRequest(request, "parent_id must reference a category channel in the same guild.");
            }
          }

          updates.parentId = parsed.data.parent_id;
        }
      } else {
        const member = await canAccessDm(me.id, channelId);
        if (!member) {
          return forbidden(request);
        }
      }

      if (Object.keys(updates).length === 0) {
        return badRequest(request, "No updatable fields provided.");
      }

      const [updated] = await db
        .update(channels)
        .set(updates)
        .where(eq(channels.id, channelId))
        .returning();

      if (!updated) {
        return notFound(request);
      }

      if (updated.guildId) {
        const payload = toGuildChannelPayload(updated);
        await emitToGuild(updated.guildId, "CHANNEL_UPDATE", payload);
        return withCors(request, json(payload));
      }

      return withCors(request, json({ id: updated.id }));
    }

    if (request.method === "DELETE") {
      if (!access.channel.guildId || !(await isGuildOwner(me.id, access.channel.guildId))) {
        return forbidden(request, "Only the guild owner can delete channels.");
      }

      const payload = toGuildChannelPayload(access.channel);
      await db.delete(channels).where(eq(channels.id, channelId));
      await emitToGuild(access.channel.guildId, "CHANNEL_DELETE", payload);
      return withCors(request, empty(204));
    }

    return withCors(request, json({ error: "Method not allowed" }, 405));
  }

  return notFound(request);
};

const sendReadyAndBackfillGuilds = async (connection: GatewayConnection, user: UserSummary): Promise<void> => {
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

const server = Bun.serve<WsData>({
  port: env.PORT,
  fetch: async (request, serverInstance) => {
    const pathname = new URL(request.url).pathname;

    if (request.method === "OPTIONS" && (pathname.startsWith("/api") || pathname === "/gateway" || pathname === "/api/gateway")) {
      return preflight(request);
    }

    if ((pathname === "/gateway" || pathname === "/api/gateway") && request.headers.get("upgrade") === "websocket") {
      const upgraded = serverInstance.upgrade(request, {
        data: {
          connectionId: crypto.randomUUID(),
        },
      });

      if (upgraded) {
        return undefined;
      }

      return new Response("Upgrade failed", { status: 400 });
    }

    if (pathname.startsWith("/api")) {
      try {
        return await handleApiRequest(request);
      } catch (error) {
        console.error("Unhandled API error", error);
        return withCors(request, json({ error: "Internal server error" }, 500));
      }
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const connection: GatewayConnection = {
        id: ws.data.connectionId,
        ws,
        userId: null,
        identified: false,
        sessionId: null,
        seq: 0,
        lastHeartbeatAt: now(),
      };

      gatewayConnections.set(connection.id, connection);
      sendPacket(connection, {
        op: GatewayOp.HELLO,
        d: {
          heartbeat_interval: HEARTBEAT_INTERVAL_MS,
        },
        s: null,
        t: null,
      });

      startZombieMonitor(connection);
    },

    async message(ws, message) {
      const connection = gatewayConnections.get(ws.data.connectionId);
      if (!connection) {
        try {
          ws.close(4001, "Unknown connection");
        } catch {
          // ignored
        }
        return;
      }

      let payload: GatewayPacket;
      try {
        const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
        payload = JSON.parse(raw) as GatewayPacket;
      } catch {
        sendPacket(connection, {
          op: GatewayOp.INVALID_SESSION,
          d: false,
          s: null,
          t: null,
        });
        return;
      }

      if (payload.op === GatewayOp.HEARTBEAT) {
        connection.lastHeartbeatAt = now();
        sendPacket(connection, {
          op: GatewayOp.HEARTBEAT_ACK,
          s: null,
          t: null,
        });
        return;
      }

      if (payload.op === GatewayOp.IDENTIFY) {
        const token = (payload.d as { token?: string } | undefined)?.token;
        if (!token) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        const userId = consumeGatewayToken(token);
        if (!userId) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        const user = await getUserSummaryById(userId);
        if (!user) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        connection.userId = userId;
        connection.identified = true;
        connection.sessionId = crypto.randomUUID();
        connection.lastHeartbeatAt = now();

        addConnectionToUser(userId, connection.id);
        await sendReadyAndBackfillGuilds(connection, user);
        return;
      }

      if (payload.op === GatewayOp.RESUME) {
        const resume = payload.d as { token?: string; session_id?: string; seq?: number } | undefined;
        if (!resume?.token) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        const userId = consumeGatewayToken(resume.token);
        if (!userId) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        const user = await getUserSummaryById(userId);
        if (!user) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        connection.userId = userId;
        connection.identified = true;
        connection.seq = typeof resume.seq === "number" ? resume.seq : connection.seq;
        connection.sessionId = resume.session_id ?? crypto.randomUUID();
        connection.lastHeartbeatAt = now();

        addConnectionToUser(userId, connection.id);
        await sendReadyAndBackfillGuilds(connection, user);
        return;
      }

      sendPacket(connection, {
        op: GatewayOp.INVALID_SESSION,
        d: false,
        s: null,
        t: null,
      });
    },

    close(ws) {
      const connection = gatewayConnections.get(ws.data.connectionId);
      if (!connection) {
        return;
      }

      if (connection.zombieTimer) {
        clearInterval(connection.zombieTimer);
      }

      if (connection.userId) {
        removeConnectionFromUser(connection.userId, connection.id);
      }

      gatewayConnections.delete(connection.id);
    },
  },
});

console.log(`API server listening on ${server.url}`);
