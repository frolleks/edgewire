import { ChannelType } from "@edgewire/types";
import type { BunRequest } from "bun";
import { and, asc, eq, gt, ilike, inArray, or } from "drizzle-orm";
import { db } from "../db";
import {
  channelPermissionOverwrites,
  channels,
  guildMemberRoles,
  guildMembers,
  guildRoles,
  guilds,
  users,
} from "../db/schema";
import { badRequest, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import { PermissionBits, defaultEveryonePermissions } from "../lib/permissions";
import { getGuildPermissionContext, hasGuildPermission, listVisibleGuildChannelsForUser } from "../lib/permission-service";
import { getPresenceStatusForViewer } from "../presence/presence-store";
import { resolveAvatarUrl } from "../storage/s3";
import {
  buildGuildCreateEvent,
  createGuildChannelSchema,
  emitToGuild,
  emitToUsers,
  guildNameSchema,
  nextId,
  normalizeName,
  toGuildChannelPayload,
  toGuildChannelPayloadWithOverwrites,
  toGuildPayload,
} from "../runtime";

export const createGuild = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
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

    await tx.insert(guildRoles).values({
      id: guildId,
      guildId,
      name: "@everyone",
      permissions: defaultEveryonePermissions(),
      position: 0,
      color: null,
      hoist: false,
      mentionable: false,
      managed: false,
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

  return json(request, toGuildPayload(guild), { status: 201 });
};

export const getGuild = async (request: BunRequest<"/api/guilds/:guildId">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const allowed = await hasGuildPermission(me.id, guildId, PermissionBits.VIEW_CHANNEL);
  if (!allowed) {
    return forbidden(request);
  }

  const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, guildId) });
  if (!guild) {
    return notFound(request);
  }

  return json(request, toGuildPayload(guild));
};

export const getGuildChannels = async (request: BunRequest<"/api/guilds/:guildId/channels">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const allowed = await hasGuildPermission(me.id, guildId, PermissionBits.VIEW_CHANNEL);
  if (!allowed) {
    return forbidden(request);
  }

  const visibleChannels = await listVisibleGuildChannelsForUser(me.id, guildId);
  const payload = await Promise.all(visibleChannels.map(channel => toGuildChannelPayloadWithOverwrites(channel)));
  return json(request, payload);
};

export const createGuildChannel = async (request: BunRequest<"/api/guilds/:guildId/channels">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const canView = await hasGuildPermission(me.id, guildId, PermissionBits.VIEW_CHANNEL);
  if (!canView) {
    return forbidden(request);
  }

  const canManageChannels = await hasGuildPermission(me.id, guildId, PermissionBits.MANAGE_CHANNELS);
  if (!canManageChannels) {
    return forbidden(request, "Missing MANAGE_CHANNELS.");
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

  if ((input.type === ChannelType.GUILD_TEXT || input.type === ChannelType.GUILD_VOICE) && parentId) {
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

  const payload = await toGuildChannelPayloadWithOverwrites(created);
  await emitToGuild(guildId, "CHANNEL_CREATE", payload);
  return json(request, payload, { status: 201 });
};

export const bulkModifyGuildChannelPositions = async (
  request: BunRequest<"/api/guilds/:guildId/channels">,
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

  const canManageChannels = await hasGuildPermission(me.id, guildId, PermissionBits.MANAGE_CHANNELS);
  if (!canManageChannels) {
    return forbidden(request, "Missing MANAGE_CHANNELS.");
  }

  const body = await parseJson<Array<{ id: string; position: number; parent_id?: string | null; lock_permissions?: boolean }>>(
    request,
  );

  if (!body || !Array.isArray(body)) {
    return badRequest(request, "Invalid channel position payload.");
  }

  const ids = body.map(item => item.id);
  if (ids.length === 0) {
    return json(request, []);
  }

  const existingChannels = await db
    .select()
    .from(channels)
    .where(and(eq(channels.guildId, guildId), inArray(channels.id, ids)));

  if (existingChannels.length !== ids.length) {
    return badRequest(request, "One or more channels were not found in this guild.");
  }

  const existingById = new Map(existingChannels.map(channel => [channel.id, channel]));

  await db.transaction(async tx => {
    for (const item of body) {
      const existing = existingById.get(item.id);
      if (!existing) {
        continue;
      }

      const nextParentId = item.parent_id === undefined ? existing.parentId : item.parent_id ?? null;

      await tx
        .update(channels)
        .set({
          position: item.position,
          parentId: nextParentId,
        })
        .where(eq(channels.id, item.id));

      if (item.lock_permissions && nextParentId) {
        const parentOverwrites = await tx
          .select({
            overwriteId: channelPermissionOverwrites.overwriteId,
            type: channelPermissionOverwrites.type,
            allow: channelPermissionOverwrites.allow,
            deny: channelPermissionOverwrites.deny,
          })
          .from(channelPermissionOverwrites)
          .where(eq(channelPermissionOverwrites.channelId, nextParentId));

        await tx.delete(channelPermissionOverwrites).where(eq(channelPermissionOverwrites.channelId, item.id));

        if (parentOverwrites.length > 0) {
          await tx.insert(channelPermissionOverwrites).values(
            parentOverwrites
              .filter(overwrite => overwrite.type === 0 || overwrite.type === 1)
              .map(overwrite => ({
                channelId: item.id,
                overwriteId: overwrite.overwriteId,
                type: overwrite.type as 0 | 1,
                allow: overwrite.allow,
                deny: overwrite.deny,
              })),
          );
        }
      }
    }
  });

  const updated = await db
    .select()
    .from(channels)
    .where(and(eq(channels.guildId, guildId), inArray(channels.id, ids)));

  const payload = await Promise.all(updated.map(channel => toGuildChannelPayloadWithOverwrites(channel)));
  for (const channel of payload) {
    await emitToGuild(guildId, "CHANNEL_UPDATE", channel);
  }

  return json(request, payload);
};

export const updateGuildSettings = async (request: BunRequest<"/api/guilds/:guildId">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const canManageGuild = await hasGuildPermission(me.id, guildId, PermissionBits.MANAGE_GUILD);
  if (!canManageGuild) {
    return forbidden(request, "Missing MANAGE_GUILD.");
  }

  const body = await parseJson<{
    name?: string;
    icon?: string | null;
    verification_level?: number;
    default_message_notifications?: number;
    explicit_content_filter?: number;
    preferred_locale?: string;
    system_channel_id?: string | null;
    rules_channel_id?: string | null;
    public_updates_channel_id?: string | null;
  }>(request);

  if (!body) {
    return badRequest(request, "Invalid guild settings payload.");
  }

  const updates: Partial<typeof guilds.$inferInsert> = {};

  if (body.name !== undefined) updates.name = normalizeName(body.name);
  if (body.icon !== undefined) updates.icon = body.icon;
  if (body.verification_level !== undefined) updates.verificationLevel = body.verification_level;
  if (body.default_message_notifications !== undefined) {
    updates.defaultMessageNotifications = body.default_message_notifications;
  }
  if (body.explicit_content_filter !== undefined) updates.explicitContentFilter = body.explicit_content_filter;
  if (body.preferred_locale !== undefined) updates.preferredLocale = body.preferred_locale;
  if (body.system_channel_id !== undefined) updates.systemChannelId = body.system_channel_id;
  if (body.rules_channel_id !== undefined) updates.rulesChannelId = body.rules_channel_id;
  if (body.public_updates_channel_id !== undefined) updates.publicUpdatesChannelId = body.public_updates_channel_id;

  if (Object.keys(updates).length === 0) {
    return badRequest(request, "No settings provided.");
  }

  const [updated] = await db.update(guilds).set(updates).where(eq(guilds.id, guildId)).returning();
  if (!updated) {
    return notFound(request);
  }

  const payload = toGuildPayload(updated);
  await emitToGuild(guildId, "GUILD_UPDATE", payload);

  return json(request, payload);
};

const toGuildMemberPayload = (
  guildId: string,
  viewerId: string,
  member: {
    guildId: string;
    userId: string;
    joinedAt: Date;
    role: "OWNER" | "MEMBER";
    username: string;
    displayName: string;
    avatarUrl: string | null;
    avatarS3Key: string | null;
  },
  roleIds: string[],
) => {
  const presence = getPresenceStatusForViewer(member.userId, viewerId);
  return {
  guild_id: member.guildId,
  user: {
    id: member.userId,
    username: member.username,
    display_name: member.displayName,
    avatar_url: resolveAvatarUrl(member.avatarS3Key, member.avatarUrl),
  },
  joined_at: member.joinedAt.toISOString(),
  roles: [guildId, ...roleIds],
  role: member.role,
  presence: {
    status: presence === "invisible" ? "offline" : presence,
  },
  };
};

export const getGuildMember = async (
  request: BunRequest<"/api/guilds/:guildId/members/:userId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  const userId = request.params.userId;
  if (!guildId || !userId) {
    return badRequest(request, "Invalid guild id or user id.");
  }

  const canView = await hasGuildPermission(me.id, guildId, PermissionBits.VIEW_CHANNEL);
  if (!canView) {
    return forbidden(request);
  }

  const member = await db
    .select({
      guildId: guildMembers.guildId,
      userId: guildMembers.userId,
      joinedAt: guildMembers.joinedAt,
      role: guildMembers.role,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      avatarS3Key: users.avatarS3Key,
    })
    .from(guildMembers)
    .innerJoin(users, eq(users.id, guildMembers.userId))
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
    .limit(1);

  const firstMember = member[0];
  if (!firstMember) {
    return notFound(request);
  }

  const roleLinks = await db
    .select({
      roleId: guildMemberRoles.roleId,
    })
    .from(guildMemberRoles)
    .where(and(eq(guildMemberRoles.guildId, guildId), eq(guildMemberRoles.userId, userId)));

  return json(request, toGuildMemberPayload(guildId, me.id, firstMember, roleLinks.map(link => link.roleId)));
};

export const listGuildMembers = async (request: BunRequest<"/api/guilds/:guildId/members">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const membership = await db.query.guildMembers.findFirst({
    columns: { userId: true },
    where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, me.id)),
  });
  if (!membership) {
    return forbidden(request);
  }

  const searchParams = new URL(request.url).searchParams;
  const rawLimit = Number(searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), 1000)) : 50;
  const after = searchParams.get("after")?.trim() || undefined;
  const query = searchParams.get("query")?.trim() || undefined;

  const members = await db
    .select({
      guildId: guildMembers.guildId,
      userId: guildMembers.userId,
      joinedAt: guildMembers.joinedAt,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      avatarS3Key: users.avatarS3Key,
    })
    .from(guildMembers)
    .innerJoin(users, eq(users.id, guildMembers.userId))
    .where(
      and(
        eq(guildMembers.guildId, guildId),
        after ? gt(guildMembers.userId, after) : undefined,
        query ? or(ilike(users.displayName, `${query}%`), ilike(users.username, `${query}%`)) : undefined,
      ),
    )
    .orderBy(asc(guildMembers.userId))
    .limit(limit + 1);

  const hasMore = members.length > limit;
  const pageMembers = hasMore ? members.slice(0, limit) : members;

  const memberIds = pageMembers.map(member => member.userId);
  const roleLinks = memberIds.length
    ? await db
        .select({
          userId: guildMemberRoles.userId,
          roleId: guildMemberRoles.roleId,
        })
        .from(guildMemberRoles)
        .where(and(eq(guildMemberRoles.guildId, guildId), inArray(guildMemberRoles.userId, memberIds)))
    : [];

  const rolesByUser = new Map<string, string[]>();
  for (const roleLink of roleLinks) {
    const current = rolesByUser.get(roleLink.userId) ?? [];
    current.push(roleLink.roleId);
    rolesByUser.set(roleLink.userId, current);
  }

  return json(request, {
    members: pageMembers.map(member => ({
      user: {
        id: member.userId,
        username: member.username,
        display_name: member.displayName,
        avatar_url: resolveAvatarUrl(member.avatarS3Key, member.avatarUrl),
      },
      joined_at: member.joinedAt.toISOString(),
      roles: [guildId, ...(rolesByUser.get(member.userId) ?? [])],
      nick: null,
      presence: {
        status: (() => {
          const presence = getPresenceStatusForViewer(member.userId, me.id);
          return presence === "invisible" ? "offline" : presence;
        })(),
      },
    })),
    next_after: hasMore ? pageMembers[pageMembers.length - 1]?.userId ?? null : null,
  });
};

export const getMyGuildPermissions = async (
  request: BunRequest<"/api/guilds/:guildId/permissions/@me">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const context = await getGuildPermissionContext(authResult.user.id, guildId);
  if (!context) {
    return forbidden(request);
  }

  return json(request, {
    permissions: context.permissions.toString(),
    role_ids: [guildId, ...context.memberRoleIds],
  });
};
