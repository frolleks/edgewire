import { ChannelType } from "@discord/types";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { channelMembers, channels, messageReads, users } from "../db/schema";
import { badRequest, json, notFound, parseJson, requireAuth } from "../http";
import { getUserSummaryById } from "../lib/users";
import {
  USERNAME_REGEX,
  emitToUsers,
  findExistingDmChannel,
  getUserGuilds,
  listDmChannelsForUser,
  nextId,
  toDmChannelPayload,
  toSummary,
} from "../runtime";

export const getMe = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  return json(request, authResult.user);
};

export const updateMeProfile = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
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
    const [updated] = await db.update(users).set(updates).where(eq(users.id, me.id)).returning();

    if (!updated) {
      return notFound(request);
    }

    return json(request, {
      id: updated.id,
      username: updated.username,
      display_name: updated.displayName,
      avatar_url: updated.avatarUrl,
    });
  } catch (error) {
    if (String(error).includes("users_username_unique")) {
      return badRequest(request, "Username is already taken.");
    }
    throw error;
  }
};

export const listMyChannels = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const dmChannels = await listDmChannelsForUser(authResult.user.id);
  return json(request, dmChannels);
};

export const createMyChannel = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
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

  return json(request, payload);
};

export const listMyGuilds = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const guildList = await getUserGuilds(authResult.user.id);
  return json(request, guildList);
};
