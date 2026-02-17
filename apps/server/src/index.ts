import type { GatewayPacket, MessagePayload, ReadyEvent, UserSummary as SharedUserSummary } from "@discord/types";
import { and, desc, eq, ilike, inArray, lt, ne, or } from "drizzle-orm";
import { auth } from "./auth";
import { db } from "./db";
import { dmChannels, dmMembers, messageReads, messages, users } from "./db/schema";
import { env } from "./env";
import { preflight, withCors } from "./lib/cors";
import { nextSnowflake } from "./lib/snowflake";
import { ensureAppUser, getUserSummaryById, type AuthUserLike, type UserSummary } from "./lib/users";

const HEARTBEAT_INTERVAL_MS = 25_000;
const MESSAGE_MAX_LENGTH = 2_000;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,32}$/;

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
type Snowflake = bigint;

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

type MessageRow = typeof messages.$inferSelect;

type ChannelSummary = {
  id: string;
  type: 1;
  recipients: SharedUserSummary[];
  last_message_id: string | null;
  last_message?: MessagePayload | null;
  unread: boolean;
};

const gatewayConnections = new Map<string, GatewayConnection>();
const connectionsByUserId = new Map<string, Set<string>>();
const channelMembersCache = new Map<string, string[]>();
const gatewayTokens = new Map<string, { userId: string; expiresAt: number }>();

const now = () => Date.now();

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

const parseSnowflake = (value: string | null | undefined): Snowflake | null => {
  if (!value) {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

const toSummary = (user: UserSummary): SharedUserSummary => ({
  id: user.id,
  username: user.username,
  display_name: user.display_name,
  avatar_url: user.avatar_url,
});

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
    // Socket is likely closed.
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

const getChannelMemberIds = async (channelId: Snowflake): Promise<string[]> => {
  const cacheKey = channelId.toString();
  const cached = channelMembersCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const rows = await db
    .select({ userId: dmMembers.userId })
    .from(dmMembers)
    .where(eq(dmMembers.channelId, channelId));

  const members = rows.map(row => row.userId);
  channelMembersCache.set(cacheKey, members);
  return members;
};

const emitToChannel = async (channelId: Snowflake, event: string, data: unknown): Promise<void> => {
  const members = await getChannelMemberIds(channelId);
  emitToUsers(members, event, data);
};

const makeMessagePayload = (message: MessageRow, author: SharedUserSummary): MessagePayload => ({
  id: message.id.toString(),
  channel_id: message.channelId.toString(),
  author,
  content: message.content,
  timestamp: toIso(message.createdAt) ?? new Date().toISOString(),
  edited_timestamp: toIso(message.editedAt),
  type: 0,
});

const userCanAccessChannel = async (userId: string, channelId: Snowflake): Promise<boolean> => {
  const member = await db.query.dmMembers.findFirst({
    where: and(eq(dmMembers.channelId, channelId), eq(dmMembers.userId, userId)),
  });
  return Boolean(member);
};

const findExistingChannel = async (userId: string, recipientId: string): Promise<Snowflake | null> => {
  const myChannels = await db
    .select({ channelId: dmMembers.channelId })
    .from(dmMembers)
    .where(eq(dmMembers.userId, userId));

  for (const row of myChannels) {
    const members = await db
      .select({ userId: dmMembers.userId })
      .from(dmMembers)
      .where(eq(dmMembers.channelId, row.channelId));

    if (members.length === 2 && members.some(member => member.userId === recipientId)) {
      return row.channelId;
    }
  }

  return null;
};

const listChannelMessages = async (channelId: Snowflake, limit: number, before?: Snowflake): Promise<MessagePayload[]> => {
  const where = before
    ? and(eq(messages.channelId, channelId), lt(messages.id, before))
    : eq(messages.channelId, channelId);

  const rows = await db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.id))
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

  return rows.map(row => {
    const author = authors.get(row.authorId);
    return makeMessagePayload(row, {
      id: author?.id ?? row.authorId,
      username: author?.username ?? "unknown",
      display_name: author?.display_name ?? "Unknown",
      avatar_url: author?.avatar_url ?? null,
    });
  });
};

const getChannelSummaryForUser = async (channelId: Snowflake, userId: string): Promise<ChannelSummary | null> => {
  const members = await db
    .select({ userId: dmMembers.userId })
    .from(dmMembers)
    .where(eq(dmMembers.channelId, channelId));

  if (members.length !== 2) {
    return null;
  }

  const recipientId = members.find(member => member.userId !== userId)?.userId;
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
    .where(eq(messages.channelId, channelId))
    .orderBy(desc(messages.id))
    .limit(1);

  const readState = await db.query.messageReads.findFirst({
    where: and(eq(messageReads.channelId, channelId), eq(messageReads.userId, userId)),
  });

  let lastMessagePayload: MessagePayload | null = null;
  if (lastMessage) {
    const author = await getUserSummaryById(lastMessage.authorId);
    lastMessagePayload = makeMessagePayload(lastMessage, {
      id: author?.id ?? lastMessage.authorId,
      username: author?.username ?? "unknown",
      display_name: author?.display_name ?? "Unknown",
      avatar_url: author?.avatar_url ?? null,
    });
  }

  const unread =
    Boolean(lastMessage?.id) &&
    (!readState?.lastReadMessageId || lastMessage!.id > readState.lastReadMessageId);

  return {
    id: channelId.toString(),
    type: 1,
    recipients: [toSummary(recipient)],
    last_message_id: lastMessage ? lastMessage.id.toString() : null,
    last_message: lastMessagePayload,
    unread,
  };
};

const listChannelsForUser = async (userId: string): Promise<ChannelSummary[]> => {
  const memberships = await db
    .select({ channelId: dmMembers.channelId })
    .from(dmMembers)
    .where(eq(dmMembers.userId, userId));

  const channels: ChannelSummary[] = [];
  for (const membership of memberships) {
    const summary = await getChannelSummaryForUser(membership.channelId, userId);
    if (summary) {
      channels.push(summary);
    }
  }

  channels.sort((a, b) => {
    if (!a.last_message_id && !b.last_message_id) return 0;
    if (!a.last_message_id) return 1;
    if (!b.last_message_id) return -1;
    return BigInt(a.last_message_id) > BigInt(b.last_message_id) ? -1 : 1;
  });

  return channels;
};

const buildReadyPayload = async (user: UserSummary): Promise<ReadyEvent> => {
  const channels = await listChannelsForUser(user.id);
  return {
    v: 1,
    user: toSummary(user),
    session_id: crypto.randomUUID(),
    resume_gateway_url: "/gateway",
    private_channels: channels,
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

setInterval(() => {
  for (const [token, value] of gatewayTokens.entries()) {
    if (value.expiresAt < now()) {
      gatewayTokens.delete(token);
    }
  }
}, 30_000);

const createGatewayToken = (userId: string): string => {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  gatewayTokens.set(token, {
    userId,
    expiresAt: now() + env.GATEWAY_TOKEN_TTL_SECONDS * 1_000,
  });
  return token;
};

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
    const channels = await listChannelsForUser(me.id);
    return withCors(request, json(channels));
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

    let channelId = await findExistingChannel(me.id, recipientId);
    if (channelId === null) {
      const createdChannelId = nextSnowflake();
      channelId = createdChannelId;
      await db.transaction(async tx => {
        await tx.insert(dmChannels).values({ id: createdChannelId });
        await tx.insert(dmMembers).values([
          { channelId: createdChannelId, userId: me.id },
          { channelId: createdChannelId, userId: recipientId },
        ]);
        await tx.insert(messageReads).values([
          { channelId: createdChannelId, userId: me.id, lastReadMessageId: null },
          { channelId: createdChannelId, userId: recipientId, lastReadMessageId: null },
        ]);
      });
      channelMembersCache.set(createdChannelId.toString(), [me.id, recipientId]);

      emitToUsers([me.id], "CHANNEL_CREATE", {
        id: createdChannelId.toString(),
        type: 1,
        recipients: [toSummary(recipient)],
        last_message_id: null,
      });

      emitToUsers([recipientId], "CHANNEL_CREATE", {
        id: createdChannelId.toString(),
        type: 1,
        recipients: [toSummary(me)],
        last_message_id: null,
      });
    }

    const summary = await getChannelSummaryForUser(channelId, me.id);
    return withCors(
      request,
      json(
        summary ?? {
          id: channelId.toString(),
          type: 1,
          recipients: [toSummary(recipient)],
          last_message_id: null,
          unread: false,
        },
      ),
    );
  }

  if (pathname === "/api/gateway/token" && request.method === "POST") {
    const token = createGatewayToken(me.id);
    return withCors(request, json({ token }));
  }

  const channelMessagesMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
  if (channelMessagesMatch) {
    const channelId = parseSnowflake(channelMessagesMatch[1]);
    if (channelId === null) {
      return badRequest(request, "Invalid channel id.");
    }
    const canAccess = await userCanAccessChannel(me.id, channelId);
    if (!canAccess) {
      return forbidden(request);
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
      const body = await parseJson<{ content?: string }>(request);
      const content = body?.content?.trim();
      if (!content) {
        return badRequest(request, "content is required.");
      }
      if (content.length > MESSAGE_MAX_LENGTH) {
        return badRequest(request, `content must be <= ${MESSAGE_MAX_LENGTH} characters.`);
      }

      const [created] = await db
        .insert(messages)
        .values({
          id: nextSnowflake(),
          channelId,
          authorId: me.id,
          content,
        })
        .returning();

      if (!created) {
        return badRequest(request, "Failed to create message.");
      }

      const payload = makeMessagePayload(created, toSummary(me));
      await emitToChannel(channelId, "MESSAGE_CREATE", payload);

      return withCors(request, json(payload, 201));
    }

    return withCors(request, json({ error: "Method not allowed" }, 405));
  }

  const messageMutationMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)$/);
  if (messageMutationMatch) {
    const channelId = parseSnowflake(messageMutationMatch[1]);
    const messageId = parseSnowflake(messageMutationMatch[2]);
    if (channelId === null || messageId === null) {
      return badRequest(request, "Invalid channel id or message id.");
    }

    const canAccess = await userCanAccessChannel(me.id, channelId);
    if (!canAccess) {
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
      const body = await parseJson<{ content?: string }>(request);
      const content = body?.content?.trim();
      if (!content) {
        return badRequest(request, "content is required.");
      }
      if (content.length > MESSAGE_MAX_LENGTH) {
        return badRequest(request, `content must be <= ${MESSAGE_MAX_LENGTH} characters.`);
      }

      const [updated] = await db
        .update(messages)
        .set({
          content,
          editedAt: new Date(),
        })
        .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
        .returning();

      if (!updated) {
        return notFound(request);
      }

      const payload = makeMessagePayload(updated, toSummary(me));
      await emitToChannel(channelId, "MESSAGE_UPDATE", payload);
      return withCors(request, json(payload));
    }

    if (request.method === "DELETE") {
      await db.delete(messages).where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)));
      await emitToChannel(channelId, "MESSAGE_DELETE", {
        id: messageId.toString(),
        channel_id: channelId.toString(),
      });
      return withCors(request, empty(204));
    }

    return withCors(request, json({ error: "Method not allowed" }, 405));
  }

  const typingMatch = pathname.match(/^\/api\/channels\/([^/]+)\/typing$/);
  if (typingMatch && request.method === "POST") {
    const channelId = parseSnowflake(typingMatch[1]);
    if (channelId === null) {
      return badRequest(request, "Invalid channel id.");
    }
    const canAccess = await userCanAccessChannel(me.id, channelId);
    if (!canAccess) {
      return forbidden(request);
    }

    const members = await getChannelMemberIds(channelId);
    const targets = members.filter(userId => userId !== me.id);
    emitToUsers(targets, "TYPING_START", {
      channel_id: channelId.toString(),
      user_id: me.id,
      timestamp: Math.floor(Date.now() / 1_000),
    });
    return withCors(request, empty(204));
  }

  const readMatch = pathname.match(/^\/api\/channels\/([^/]+)\/read$/);
  if (readMatch && request.method === "PUT") {
    const channelId = parseSnowflake(readMatch[1]);
    if (channelId === null) {
      return badRequest(request, "Invalid channel id.");
    }
    const canAccess = await userCanAccessChannel(me.id, channelId);
    if (!canAccess) {
      return forbidden(request);
    }

    const body = await parseJson<{ last_read_message_id?: string | null }>(request);
    if (!body || !Object.hasOwn(body, "last_read_message_id")) {
      return badRequest(request, "last_read_message_id is required (can be null).");
    }
    const lastReadMessageId =
      body.last_read_message_id === null
        ? null
        : parseSnowflake(body.last_read_message_id ?? null);
    if (body.last_read_message_id !== null && body.last_read_message_id !== undefined && lastReadMessageId === null) {
      return badRequest(request, "Invalid last_read_message_id.");
    }

    await db
      .insert(messageReads)
      .values({
        channelId,
        userId: me.id,
        lastReadMessageId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [messageReads.channelId, messageReads.userId],
        set: {
          lastReadMessageId,
          updatedAt: new Date(),
        },
      });

    const payload = {
      channel_id: channelId.toString(),
      user_id: me.id,
      last_read_message_id: lastReadMessageId?.toString() ?? null,
    };

    await emitToChannel(channelId, "READ_STATE_UPDATE", payload);
    return withCors(request, json(payload));
  }

  return notFound(request);
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

        const ready = await buildReadyPayload(user);
        connection.sessionId = ready.session_id;
        dispatch(connection, "READY", ready);
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

        const ready = await buildReadyPayload(user);
        ready.session_id = connection.sessionId ?? ready.session_id;
        dispatch(connection, "READY", ready);
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
