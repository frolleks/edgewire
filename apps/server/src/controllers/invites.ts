import { ChannelType } from "@discord/types";
import type { BunRequest } from "bun";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { channels, guildMembers, guilds, invites } from "../db/schema";
import { badRequest, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import {
  buildGuildCreateEvent,
  createInvite,
  createInviteSchema,
  emitToUsers,
  hydrateInvitePayload,
  isGuildOwner,
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

      await tx.update(invites).set({ uses: invite.uses + 1 }).where(eq(invites.code, code));
    }
  });

  if (joined) {
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
