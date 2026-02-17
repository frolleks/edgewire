import { ChannelType } from "@discord/types";
import type { BunRequest } from "bun";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  channelMembers,
  channels,
  guildMemberRoles,
  guildMembers,
  guilds,
  messageReads,
  userProfiles,
  userSettings,
  users,
} from "../db/schema";
import { badRequest, empty, json, notFound, parseJson, requireAuth } from "../http";
import { getCurrentUserById, getUserSummaryById, isValidUsername, normalizeUsernameForUpdate } from "../lib/users";
import {
  broadcastUserUpdate,
  emitToGuild,
  emitToUsers,
  emitUserSettingsUpdate,
  findExistingDmChannel,
  getUserGuilds,
  listDmChannelsForUser,
  nextId,
  toDmChannelPayload,
  toSummary,
} from "../runtime";

type PatchMeBody = {
  username?: unknown;
  display_name?: unknown;
  bio?: unknown;
  pronouns?: unknown;
  status?: unknown;
  avatar_url?: unknown;
  banner_url?: unknown;
};

type PatchMeSettingsBody = {
  theme?: unknown;
  compact_mode?: unknown;
  show_timestamps?: unknown;
  locale?: unknown;
};

const USER_THEME_VALUES = new Set(["system", "light", "dark"]);

const ensureSupplementaryRows = async (user: { id: string; username: string; display_name: string; avatar_url: string | null }) => {
  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      bannerUrl: null,
      bio: null,
      pronouns: null,
      status: null,
    })
    .onConflictDoNothing({ target: userProfiles.userId });

  await db
    .insert(userSettings)
    .values({
      userId: user.id,
    })
    .onConflictDoNothing({ target: userSettings.userId });
};

const parseNullableStringField = (
  request: Request,
  value: unknown,
  field: string,
  maxLength: number,
  options?: { minLength?: number; emptyAsNull?: boolean },
): Response | string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return badRequest(request, `${field} must be a string or null.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    if (options?.emptyAsNull) {
      return null;
    }
    return badRequest(request, `${field} cannot be empty.`);
  }

  if (options?.minLength !== undefined && trimmed.length < options.minLength) {
    return badRequest(request, `${field} must be at least ${options.minLength} characters.`);
  }

  if (trimmed.length > maxLength) {
    return badRequest(request, `${field} must be at most ${maxLength} characters.`);
  }

  return trimmed;
};

const applyProfilePatch = async (
  request: Request,
  me: { id: string; username: string; display_name: string; avatar_url: string | null },
  body: PatchMeBody,
): Promise<Response> => {
  await ensureSupplementaryRows(me);

  const profileUpdates: Partial<typeof userProfiles.$inferInsert> = {};
  const legacyUserUpdates: Partial<typeof users.$inferInsert> = {};

  if (body.username !== undefined) {
    if (typeof body.username !== "string") {
      return badRequest(request, "username must be a string.");
    }

    const normalized = normalizeUsernameForUpdate(body.username);
    if (!isValidUsername(normalized)) {
      return badRequest(request, "username must be 2-32 chars matching /^[a-z0-9_.]+$/");
    }

    profileUpdates.username = normalized;
    legacyUserUpdates.username = normalized;
  }

  if (body.display_name !== undefined) {
    const parsed = parseNullableStringField(request, body.display_name, "display_name", 32, { minLength: 1 });
    if (parsed instanceof Response) {
      return parsed;
    }

    profileUpdates.displayName = parsed;
    legacyUserUpdates.displayName = parsed ?? me.display_name;
  }

  if (body.bio !== undefined) {
    const parsed = parseNullableStringField(request, body.bio, "bio", 190, { emptyAsNull: true });
    if (parsed instanceof Response) {
      return parsed;
    }
    profileUpdates.bio = parsed;
  }

  if (body.pronouns !== undefined) {
    const parsed = parseNullableStringField(request, body.pronouns, "pronouns", 32, { emptyAsNull: true });
    if (parsed instanceof Response) {
      return parsed;
    }
    profileUpdates.pronouns = parsed;
  }

  if (body.status !== undefined) {
    const parsed = parseNullableStringField(request, body.status, "status", 60, { emptyAsNull: true });
    if (parsed instanceof Response) {
      return parsed;
    }
    profileUpdates.status = parsed;
  }

  if (body.avatar_url !== undefined) {
    const parsed = parseNullableStringField(request, body.avatar_url, "avatar_url", 2_000, { emptyAsNull: true });
    if (parsed instanceof Response) {
      return parsed;
    }

    profileUpdates.avatarUrl = parsed;
    legacyUserUpdates.avatarUrl = parsed;
    legacyUserUpdates.avatarS3Key = null;
  }

  if (body.banner_url !== undefined) {
    const parsed = parseNullableStringField(request, body.banner_url, "banner_url", 2_000, { emptyAsNull: true });
    if (parsed instanceof Response) {
      return parsed;
    }
    profileUpdates.bannerUrl = parsed;
  }

  if (Object.keys(profileUpdates).length === 0 && Object.keys(legacyUserUpdates).length === 0) {
    return badRequest(request, "No profile fields provided.");
  }

  try {
    await db.transaction(async tx => {
      if (Object.keys(profileUpdates).length > 0) {
        await tx
          .update(userProfiles)
          .set({
            ...profileUpdates,
            updatedAt: new Date(),
          })
          .where(eq(userProfiles.userId, me.id));
      }

      if (Object.keys(legacyUserUpdates).length > 0) {
        await tx.update(users).set(legacyUserUpdates).where(eq(users.id, me.id));
      }
    });
  } catch (error) {
    const message = String(error);
    if (message.includes("users_username_unique") || message.includes("user_profiles_username_unique")) {
      return json(request, { error: "Username is already taken." }, { status: 409 });
    }
    throw error;
  }

  const updated = await getCurrentUserById(me.id);
  if (!updated) {
    return notFound(request);
  }

  const summary = await getUserSummaryById(me.id);
  if (summary) {
    await broadcastUserUpdate(me.id, summary);
  }

  return json(request, updated);
};

export const getMe = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const current = await getCurrentUserById(authResult.user.id);
  if (!current) {
    return notFound(request);
  }

  return json(request, current);
};

export const patchMe = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = await parseJson<PatchMeBody>(request);
  if (!body || typeof body !== "object") {
    return badRequest(request, "Invalid JSON body.");
  }

  return applyProfilePatch(request, authResult.user, body);
};

export const updateMeProfile = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = await parseJson<PatchMeBody>(request);
  if (!body || typeof body !== "object") {
    return badRequest(request, "Invalid JSON body.");
  }

  return applyProfilePatch(request, authResult.user, body);
};

export const patchMeSettings = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const body = await parseJson<PatchMeSettingsBody>(request);
  if (!body || typeof body !== "object") {
    return badRequest(request, "Invalid JSON body.");
  }

  await ensureSupplementaryRows(me);

  const updates: Partial<typeof userSettings.$inferInsert> = {};

  if (body.theme !== undefined) {
    if (typeof body.theme !== "string" || !USER_THEME_VALUES.has(body.theme)) {
      return badRequest(request, "theme must be one of: system, light, dark.");
    }
    updates.theme = body.theme;
  }

  if (body.compact_mode !== undefined) {
    if (typeof body.compact_mode !== "boolean") {
      return badRequest(request, "compact_mode must be a boolean.");
    }
    updates.compactMode = body.compact_mode;
  }

  if (body.show_timestamps !== undefined) {
    if (typeof body.show_timestamps !== "boolean") {
      return badRequest(request, "show_timestamps must be a boolean.");
    }
    updates.showTimestamps = body.show_timestamps;
  }

  if (body.locale !== undefined) {
    if (body.locale !== null && typeof body.locale !== "string") {
      return badRequest(request, "locale must be a string or null.");
    }

    const locale =
      typeof body.locale === "string"
        ? body.locale.trim().slice(0, 32) || null
        : null;
    updates.locale = locale;
  }

  if (Object.keys(updates).length === 0) {
    return badRequest(request, "No settings fields provided.");
  }

  await db
    .update(userSettings)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, me.id));

  const current = await getCurrentUserById(me.id);
  if (!current) {
    return notFound(request);
  }

  emitUserSettingsUpdate(me.id, current.settings);
  return json(request, current.settings);
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

export const leaveMyGuild = async (
  request: BunRequest<"/api/users/@me/guilds/:guildId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const guild = await db.query.guilds.findFirst({
    where: eq(guilds.id, guildId),
  });
  if (!guild) {
    return notFound(request);
  }

  const membership = await db.query.guildMembers.findFirst({
    where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, me.id)),
  });
  if (!membership) {
    return notFound(request);
  }

  if (guild.ownerId === me.id) {
    return badRequest(request, "Guild owners cannot leave their own server.");
  }

  await db.transaction(async tx => {
    await tx
      .delete(guildMemberRoles)
      .where(and(eq(guildMemberRoles.guildId, guildId), eq(guildMemberRoles.userId, me.id)));

    await tx
      .delete(guildMembers)
      .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, me.id)));
  });

  const payload = {
    guild_id: guildId,
    user: { id: me.id },
  };

  await emitToGuild(guildId, "GUILD_MEMBER_REMOVE", payload);
  emitToUsers([me.id], "GUILD_MEMBER_REMOVE", payload);

  return empty(request, 204);
};
