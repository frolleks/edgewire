import type { BunRequest } from "bun";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { channels, guildMembers, userChannelNotificationSettings, userGuildNotificationSettings } from "../db/schema";
import { badRequest, forbidden, json, parseJson, requireAuth } from "../http";
import { listBadgesForUser } from "../lib/badges";
import { canAccessChannel } from "../runtime";

const notificationLevelSchema = z.union([z.literal("ALL_MESSAGES"), z.literal("ONLY_MENTIONS"), z.literal("NOTHING")]);

const parseMutedUntil = (value: string | null): Date | null => {
  if (value === null) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

export const getBadges = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const badges = await listBadgesForUser(authResult.user.id);
  return json(request, badges);
};

export const patchGuildNotificationSettings = async (
  request: BunRequest<"/api/guilds/:guildId/notification-settings">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const member = await db.query.guildMembers.findFirst({
    where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, authResult.user.id)),
  });
  if (!member) {
    return forbidden(request);
  }

  const body = await parseJson<unknown>(request);
  const parsed = z
    .object({
      level: notificationLevelSchema.optional(),
      suppress_everyone: z.boolean().optional(),
      muted: z.boolean().optional(),
      muted_until: z.union([z.string(), z.null()]).optional(),
    })
    .strict()
    .safeParse(body);

  if (!parsed.success) {
    return badRequest(request, "Invalid notification settings payload.");
  }

  const updates: Partial<typeof userGuildNotificationSettings.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (parsed.data.level !== undefined) {
    updates.level = parsed.data.level;
  }

  if (parsed.data.suppress_everyone !== undefined) {
    updates.suppressEveryone = parsed.data.suppress_everyone;
  }

  if (parsed.data.muted !== undefined) {
    updates.muted = parsed.data.muted;
  }

  if (parsed.data.muted_until !== undefined) {
    const mutedUntil = parseMutedUntil(parsed.data.muted_until);
    if (parsed.data.muted_until !== null && mutedUntil === null) {
      return badRequest(request, "muted_until must be an ISO-8601 timestamp or null.");
    }
    updates.mutedUntil = mutedUntil;
  }

  if (Object.keys(updates).length === 1) {
    return badRequest(request, "No notification setting fields provided.");
  }

  const [row] = await db
    .insert(userGuildNotificationSettings)
    .values({
      userId: authResult.user.id,
      guildId,
      ...updates,
    })
    .onConflictDoUpdate({
      target: [userGuildNotificationSettings.userId, userGuildNotificationSettings.guildId],
      set: updates,
    })
    .returning();

  return json(request, {
    user_id: authResult.user.id,
    guild_id: guildId,
    level: row?.level ?? "ONLY_MENTIONS",
    suppress_everyone: row?.suppressEveryone ?? false,
    muted: row?.muted ?? false,
    muted_until: row?.mutedUntil ? row.mutedUntil.toISOString() : null,
  });
};

export const patchChannelNotificationSettings = async (
  request: BunRequest<"/api/channels/:channelId/notification-settings">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const channelId = request.params.channelId;
  if (!channelId) {
    return badRequest(request, "Invalid channel id.");
  }

  const access = await canAccessChannel(authResult.user.id, channelId);
  if (!access) {
    return forbidden(request);
  }

  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
  });
  if (!channel) {
    return badRequest(request, "Channel not found.");
  }

  const body = await parseJson<unknown>(request);
  const parsed = z
    .object({
      level: z.union([notificationLevelSchema, z.null()]).optional(),
      muted: z.boolean().optional(),
      muted_until: z.union([z.string(), z.null()]).optional(),
    })
    .strict()
    .safeParse(body);

  if (!parsed.success) {
    return badRequest(request, "Invalid notification settings payload.");
  }

  const updates: Partial<typeof userChannelNotificationSettings.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (parsed.data.level !== undefined) {
    updates.level = parsed.data.level;
  }

  if (parsed.data.muted !== undefined) {
    updates.muted = parsed.data.muted;
  }

  if (parsed.data.muted_until !== undefined) {
    const mutedUntil = parseMutedUntil(parsed.data.muted_until);
    if (parsed.data.muted_until !== null && mutedUntil === null) {
      return badRequest(request, "muted_until must be an ISO-8601 timestamp or null.");
    }
    updates.mutedUntil = mutedUntil;
  }

  if (Object.keys(updates).length === 1) {
    return badRequest(request, "No notification setting fields provided.");
  }

  const [row] = await db
    .insert(userChannelNotificationSettings)
    .values({
      userId: authResult.user.id,
      channelId,
      ...updates,
    })
    .onConflictDoUpdate({
      target: [userChannelNotificationSettings.userId, userChannelNotificationSettings.channelId],
      set: updates,
    })
    .returning();

  return json(request, {
    user_id: authResult.user.id,
    channel_id: channelId,
    level: row?.level ?? null,
    muted: row?.muted ?? false,
    muted_until: row?.mutedUntil ? row.mutedUntil.toISOString() : null,
  });
};
