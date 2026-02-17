import { ChannelType } from "@discord/types";
import type { BunRequest } from "bun";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { messages } from "../db/schema";
import { badRequest, empty, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import {
  MESSAGE_MAX_LENGTH,
  canAccessChannel,
  createMessageSchema,
  emitToChannelAudience,
  listChannelMessages,
  makeMessagePayload,
  nextId,
  parseSnowflake,
  toSummary,
} from "../runtime";

export const getChannelMessages = async (request: BunRequest<"/api/channels/:channelId/messages">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
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

  const searchParams = new URL(request.url).searchParams;
  const limit = Number(searchParams.get("limit") ?? 50);
  const beforeRaw = searchParams.get("before");
  const before = beforeRaw ? parseSnowflake(beforeRaw) : null;
  if (beforeRaw && before === null) {
    return badRequest(request, "Invalid before message id.");
  }

  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
  const items = await listChannelMessages(channelId, boundedLimit, before ?? undefined);
  return json(request, items);
};

export const createChannelMessage = async (request: BunRequest<"/api/channels/:channelId/messages">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
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

  return json(request, payload, { status: 201 });
};

export const updateChannelMessage = async (
  request: BunRequest<"/api/channels/:channelId/messages/:messageId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  const messageId = request.params.messageId;
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
  return json(request, payload);
};

export const deleteChannelMessage = async (
  request: BunRequest<"/api/channels/:channelId/messages/:messageId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  const messageId = request.params.messageId;
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

  await db.delete(messages).where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)));

  await emitToChannelAudience(access.channel, "MESSAGE_DELETE", {
    id: messageId,
    channel_id: channelId,
  });
  return empty(request, 204);
};
