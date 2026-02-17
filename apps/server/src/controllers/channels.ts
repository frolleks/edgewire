import { ChannelType } from "@discord/types";
import type { BunRequest } from "bun";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { channelReads, channels } from "../db/schema";
import { badRequest, empty, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import { emitBadgeUpdateForUserChannel } from "../lib/badges";
import { PermissionBits } from "../lib/permissions";
import { hasChannelPermission, hasGuildPermission } from "../lib/permission-service";
import {
  ID_REGEX,
  canAccessChannel,
  canAccessDm,
  emitToChannelAudience,
  emitToGuild,
  emitToUsers,
  getDmMemberIds,
  getGuildMemberIds,
  normalizeName,
  patchChannelSchema,
  readStateSchema,
  toGuildChannelPayload,
} from "../runtime";

export const patchChannel = async (request: BunRequest<"/api/channels/:channelId">): Promise<Response> => {
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

  const body = await parseJson<unknown>(request);
  const parsed = patchChannelSchema.safeParse(body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return badRequest(request, "Invalid channel patch payload.");
  }

  const updates: Partial<typeof channels.$inferInsert> = {};

  if (access.scope === "GUILD") {
    if (!access.channel.guildId || !(await hasGuildPermission(me.id, access.channel.guildId, PermissionBits.MANAGE_CHANNELS))) {
      return forbidden(request, "Missing MANAGE_CHANNELS.");
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
        if (!parent || parent.type !== ChannelType.GUILD_CATEGORY || parent.guildId !== access.channel.guildId) {
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

  const [updated] = await db.update(channels).set(updates).where(eq(channels.id, channelId)).returning();

  if (!updated) {
    return notFound(request);
  }

  if (updated.guildId) {
    const payload = toGuildChannelPayload(updated);
    await emitToGuild(updated.guildId, "CHANNEL_UPDATE", payload);
    return json(request, payload);
  }

  return json(request, { id: updated.id });
};

export const deleteChannel = async (request: BunRequest<"/api/channels/:channelId">): Promise<Response> => {
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

  if (!access.channel.guildId || !(await hasGuildPermission(me.id, access.channel.guildId, PermissionBits.MANAGE_CHANNELS))) {
    return forbidden(request, "Missing MANAGE_CHANNELS.");
  }

  const payload = toGuildChannelPayload(access.channel);
  await db.delete(channels).where(eq(channels.id, channelId));
  await emitToGuild(access.channel.guildId, "CHANNEL_DELETE", payload);

  return empty(request, 204);
};

export const createTyping = async (request: BunRequest<"/api/channels/:channelId/typing">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  if (!channelId) {
    return badRequest(request, "Invalid channel id.");
  }

  const canView = await hasChannelPermission(me.id, channelId, PermissionBits.VIEW_CHANNEL);
  if (!canView) {
    return forbidden(request);
  }

  const canSend = await hasChannelPermission(me.id, channelId, PermissionBits.SEND_MESSAGES);
  if (!canSend) {
    return forbidden(request, "Missing SEND_MESSAGES.");
  }

  const access = await canAccessChannel(me.id, channelId);
  if (!access) {
    return forbidden(request);
  }

  if (access.channel.type === ChannelType.GUILD_CATEGORY || access.channel.type === ChannelType.GUILD_VOICE) {
    return badRequest(request, "Cannot type in this channel type.");
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

  return empty(request, 204);
};

export const updateReadState = async (request: BunRequest<"/api/channels/:channelId/read">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  if (!channelId) {
    return badRequest(request, "Invalid channel id.");
  }

  const canView = await hasChannelPermission(me.id, channelId, PermissionBits.VIEW_CHANNEL);
  if (!canView) {
    return forbidden(request);
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
    .insert(channelReads)
    .values({
      channelId,
      userId: me.id,
      lastReadMessageId: parsed.data.last_read_message_id,
      lastReadAt: new Date(),
      unreadCount: 0,
      mentionCount: 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [channelReads.userId, channelReads.channelId],
      set: {
        lastReadMessageId: parsed.data.last_read_message_id,
        lastReadAt: new Date(),
        unreadCount: 0,
        mentionCount: 0,
        updatedAt: new Date(),
      },
    });

  const payload = {
    channel_id: channelId,
    user_id: me.id,
    last_read_message_id: parsed.data.last_read_message_id,
  };

  await emitToChannelAudience(access.channel, "READ_STATE_UPDATE", payload);
  await emitBadgeUpdateForUserChannel(me.id, channelId);
  return json(request, payload);
};
