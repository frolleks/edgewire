import type { BunRequest } from "bun";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { channelPermissionOverwrites, channels, guildMembers, guildRoles } from "../db/schema";
import { badRequest, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import { PermissionBits, parsePerms, serializePerms } from "../lib/permissions";
import { hasGuildPermission } from "../lib/permission-service";
import { emitToGuild, toGuildChannelPayloadWithOverwrites } from "../runtime";

export const editChannelPermissionOverwrite = async (
  request: BunRequest<"/api/channels/:channelId/permissions/:overwriteId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  const overwriteId = request.params.overwriteId;

  if (!channelId || !overwriteId) {
    return badRequest(request, "Invalid channel id or overwrite id.");
  }

  const channel = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
  if (!channel || !channel.guildId) {
    return notFound(request);
  }

  const canManageRoles = await hasGuildPermission(me.id, channel.guildId, PermissionBits.MANAGE_ROLES);
  if (!canManageRoles) {
    return forbidden(request, "Missing MANAGE_ROLES.");
  }

  const body = await parseJson<{ allow?: string; deny?: string; type?: number }>(request);
  if (!body || typeof body.allow !== "string" || typeof body.deny !== "string" || (body.type !== 0 && body.type !== 1)) {
    return badRequest(request, "Payload must include allow, deny, and type (0 role, 1 member).");
  }

  const allow = serializePerms(parsePerms(body.allow));
  const deny = serializePerms(parsePerms(body.deny));

  if (body.type === 0) {
    const role = await db.query.guildRoles.findFirst({
      where: and(eq(guildRoles.guildId, channel.guildId), eq(guildRoles.id, overwriteId)),
    });
    if (!role) {
      return badRequest(request, "Role overwrite id must belong to this guild.");
    }
  }

  if (body.type === 1) {
    const member = await db.query.guildMembers.findFirst({
      where: and(eq(guildMembers.guildId, channel.guildId), eq(guildMembers.userId, overwriteId)),
    });
    if (!member) {
      return badRequest(request, "Member overwrite id must belong to this guild.");
    }
  }

  await db
    .insert(channelPermissionOverwrites)
    .values({
      channelId,
      overwriteId,
      type: body.type,
      allow,
      deny,
    })
    .onConflictDoUpdate({
      target: [channelPermissionOverwrites.channelId, channelPermissionOverwrites.overwriteId],
      set: {
        type: body.type,
        allow,
        deny,
      },
    });

  const fresh = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
  if (!fresh || !fresh.guildId) {
    return notFound(request);
  }

  const payload = await toGuildChannelPayloadWithOverwrites(fresh);
  await emitToGuild(fresh.guildId, "CHANNEL_UPDATE", payload);

  return json(request, payload);
};

export const deleteChannelPermissionOverwrite = async (
  request: BunRequest<"/api/channels/:channelId/permissions/:overwriteId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const channelId = request.params.channelId;
  const overwriteId = request.params.overwriteId;

  if (!channelId || !overwriteId) {
    return badRequest(request, "Invalid channel id or overwrite id.");
  }

  const channel = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
  if (!channel || !channel.guildId) {
    return notFound(request);
  }

  const canManageRoles = await hasGuildPermission(me.id, channel.guildId, PermissionBits.MANAGE_ROLES);
  if (!canManageRoles) {
    return forbidden(request, "Missing MANAGE_ROLES.");
  }

  await db
    .delete(channelPermissionOverwrites)
    .where(
      and(
        eq(channelPermissionOverwrites.channelId, channelId),
        eq(channelPermissionOverwrites.overwriteId, overwriteId),
      ),
    );

  const fresh = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
  if (!fresh || !fresh.guildId) {
    return notFound(request);
  }

  const payload = await toGuildChannelPayloadWithOverwrites(fresh);
  await emitToGuild(fresh.guildId, "CHANNEL_UPDATE", payload);

  return json(request, payload);
};
