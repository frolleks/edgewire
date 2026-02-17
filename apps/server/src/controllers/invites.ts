import { ChannelType } from "@discord/types";
import type { BunRequest } from "bun";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { channels, guildMembers, guilds, invites } from "../db/schema";
import { badRequest, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import { PermissionBits } from "../lib/permissions";
import { hasGuildPermission } from "../lib/permission-service";
import {
  buildGuildCreateEvent,
  createInvite,
  createInviteSchema,
  emitToGuild,
  emitToUsers,
  hydrateInvitePayload,
  isInviteExpired,
} from "../runtime";

export const createChannelInvite = async (
  request: BunRequest<"/api/channels/:channelId/invites">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  if (!channelId) {
    return badRequest(request, "Invalid channel id.");
  }

  const channel = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
  if (!channel || !channel.guildId || channel.type !== ChannelType.GUILD_TEXT) {
    return badRequest(request, "Invites can only be created for guild text channels.");
  }

  const canManageChannels = await hasGuildPermission(me.id, channel.guildId, PermissionBits.MANAGE_CHANNELS);
  if (!canManageChannels) {
    return forbidden(request, "Missing MANAGE_CHANNELS.");
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

  return json(request, payload, { status: 201 });
};

export const getInvite = async (request: BunRequest<"/api/invites/:code">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const code = request.params.code;
  if (!code) {
    return badRequest(request, "Invalid invite code.");
  }

  const invite = await db.query.invites.findFirst({ where: eq(invites.code, code) });
  if (!invite || isInviteExpired(invite)) {
    return notFound(request);
  }

  const withCounts = new URL(request.url).searchParams.get("with_counts") === "true";
  const payload = await hydrateInvitePayload(invite, withCounts);
  if (!payload) {
    return notFound(request);
  }

  return json(request, payload);
};

export const acceptInvite = async (request: BunRequest<"/api/invites/:code/accept">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const code = request.params.code;
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
  let joinedAt: Date | null = null;
  await db.transaction(async tx => {
    const membership = await tx.query.guildMembers.findFirst({
      where: and(eq(guildMembers.guildId, guild.id), eq(guildMembers.userId, me.id)),
    });

    if (!membership) {
      joined = true;
      const [createdMembership] = await tx
        .insert(guildMembers)
        .values({
          guildId: guild.id,
          userId: me.id,
          role: "MEMBER",
        })
        .returning({
          joinedAt: guildMembers.joinedAt,
        });

      joinedAt = createdMembership?.joinedAt ?? null;

      await tx.update(invites).set({ uses: invite.uses + 1 }).where(eq(invites.code, code));
    }
  });

  if (joined) {
    await emitToGuild(guild.id, "GUILD_MEMBER_ADD", {
      guild_id: guild.id,
      member: {
        user: me,
        roles: [guild.id],
        joined_at: (joinedAt ?? new Date()).toISOString(),
        nick: null,
        presence: null,
      },
    });

    const guildEvent = await buildGuildCreateEvent(guild.id, me.id);
    if (guildEvent) {
      emitToUsers([me.id], "GUILD_CREATE", guildEvent);
    }
  }

  return json(request, {
    guildId: guild.id,
    channelId: channel.id,
  });
};
