import { ChannelType } from "@discord/types";
import type { BunRequest } from "bun";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { channels, guildMembers, guilds } from "../db/schema";
import { badRequest, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import {
  buildGuildCreateEvent,
  canAccessGuild,
  createGuildChannelSchema,
  emitToGuild,
  emitToUsers,
  getGuildChannels as listGuildChannels,
  guildNameSchema,
  isGuildOwner,
  nextId,
  normalizeName,
  toGuildChannelPayload,
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

  const allowed = await canAccessGuild(me.id, guildId);
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

  const allowed = await canAccessGuild(me.id, guildId);
  if (!allowed) {
    return forbidden(request);
  }

  const guildChannels = await listGuildChannels(guildId);
  return json(request, guildChannels);
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

  const allowed = await canAccessGuild(me.id, guildId);
  if (!allowed) {
    return forbidden(request);
  }

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
  return json(request, payload, { status: 201 });
};
