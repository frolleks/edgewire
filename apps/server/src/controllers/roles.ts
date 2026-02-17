import type { BunRequest } from "bun";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { guildMemberRoles, guildMembers, guildRoles, guilds } from "../db/schema";
import { badRequest, empty, forbidden, json, notFound, parseJson, requireAuth } from "../http";
import { PermissionBits, hasPerm, parsePerms } from "../lib/permissions";
import { hasGuildPermission } from "../lib/permission-service";
import { emitToGuild, nextId, toGuildRolePayload } from "../runtime";

const roleUpdateSchema = {
  name: (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 100);
  },
};

const canGrantAdmin = async (guildId: string, actorId: string): Promise<boolean> => {
  const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, guildId) });
  return guild?.ownerId === actorId;
};

export const listRoles = async (request: BunRequest<"/api/guilds/:guildId/roles">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const canView = await hasGuildPermission(authResult.user.id, guildId, PermissionBits.VIEW_CHANNEL);
  if (!canView) {
    return forbidden(request);
  }

  const roles = await db
    .select()
    .from(guildRoles)
    .where(eq(guildRoles.guildId, guildId))
    .orderBy(desc(guildRoles.position), asc(sql`${guildRoles.id}::bigint`));

  return json(request, roles.map(toGuildRolePayload));
};

export const createRole = async (request: BunRequest<"/api/guilds/:guildId/roles">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const canManageRoles = await hasGuildPermission(me.id, guildId, PermissionBits.MANAGE_ROLES);
  if (!canManageRoles) {
    return forbidden(request, "Missing MANAGE_ROLES.");
  }

  const body = (await parseJson<{
    name?: string;
    permissions?: string;
    color?: number | null;
    hoist?: boolean;
    mentionable?: boolean;
  }>(request)) ?? {};

  const permissions = body.permissions ?? "0";
  const parsedPermissions = parsePerms(permissions);
  if (hasPerm(parsedPermissions, PermissionBits.ADMINISTRATOR) && !(await canGrantAdmin(guildId, me.id))) {
    return forbidden(request, "Only the guild owner can grant ADMINISTRATOR.");
  }

  const [highest] = await db
    .select({ position: guildRoles.position })
    .from(guildRoles)
    .where(eq(guildRoles.guildId, guildId))
    .orderBy(desc(guildRoles.position))
    .limit(1);

  const [created] = await db
    .insert(guildRoles)
    .values({
      id: nextId(),
      guildId,
      name: roleUpdateSchema.name(body.name) ?? "new role",
      permissions,
      position: Number(highest?.position ?? 0) + 1,
      color: body.color ?? null,
      hoist: Boolean(body.hoist),
      mentionable: Boolean(body.mentionable),
      managed: false,
    })
    .returning();

  if (!created) {
    return badRequest(request, "Could not create role.");
  }

  const payload = {
    guild_id: guildId,
    role: toGuildRolePayload(created),
  };

  await emitToGuild(guildId, "GUILD_ROLE_CREATE", payload);

  return json(request, toGuildRolePayload(created), { status: 201 });
};

export const reorderRoles = async (request: BunRequest<"/api/guilds/:guildId/roles">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const canManageRoles = await hasGuildPermission(me.id, guildId, PermissionBits.MANAGE_ROLES);
  if (!canManageRoles) {
    return forbidden(request, "Missing MANAGE_ROLES.");
  }

  const body = await parseJson<Array<{ id: string; position: number }>>(request);
  if (!body || !Array.isArray(body)) {
    return badRequest(request, "Invalid role positions payload.");
  }

  const ids = body.map(item => item.id);
  if (ids.length === 0) {
    return json(request, []);
  }

  const roleRows = await db
    .select()
    .from(guildRoles)
    .where(and(eq(guildRoles.guildId, guildId), inArray(guildRoles.id, ids)));

  if (roleRows.length !== ids.length) {
    return badRequest(request, "One or more roles do not exist in this guild.");
  }

  await db.transaction(async tx => {
    for (const item of body) {
      await tx.update(guildRoles).set({ position: item.position }).where(eq(guildRoles.id, item.id));
    }
  });

  const updatedRoles = await db
    .select()
    .from(guildRoles)
    .where(and(eq(guildRoles.guildId, guildId), inArray(guildRoles.id, ids)));

  for (const role of updatedRoles) {
    await emitToGuild(guildId, "GUILD_ROLE_UPDATE", {
      guild_id: guildId,
      role: toGuildRolePayload(role),
    });
  }

  return json(request, updatedRoles.map(toGuildRolePayload));
};

export const updateRole = async (request: BunRequest<"/api/guilds/:guildId/roles/:roleId">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  const roleId = request.params.roleId;
  if (!guildId || !roleId) {
    return badRequest(request, "Invalid guild id or role id.");
  }

  const canManageRoles = await hasGuildPermission(me.id, guildId, PermissionBits.MANAGE_ROLES);
  if (!canManageRoles) {
    return forbidden(request, "Missing MANAGE_ROLES.");
  }

  const role = await db.query.guildRoles.findFirst({
    where: and(eq(guildRoles.guildId, guildId), eq(guildRoles.id, roleId)),
  });

  if (!role) {
    return notFound(request);
  }

  const body = await parseJson<{
    name?: string;
    permissions?: string;
    color?: number | null;
    hoist?: boolean;
    mentionable?: boolean;
  }>(request);
  if (!body) {
    return badRequest(request, "Invalid role payload.");
  }

  const updates: Partial<typeof guildRoles.$inferInsert> = {};

  if (body.name !== undefined) {
    const name = roleUpdateSchema.name(body.name);
    if (!name) {
      return badRequest(request, "Role name cannot be empty.");
    }
    updates.name = name;
  }

  if (body.permissions !== undefined) {
    const permissions = parsePerms(body.permissions);
    if (hasPerm(permissions, PermissionBits.ADMINISTRATOR) && !(await canGrantAdmin(guildId, me.id))) {
      return forbidden(request, "Only the guild owner can grant ADMINISTRATOR.");
    }
    updates.permissions = body.permissions;
  }

  if (body.color !== undefined) updates.color = body.color;
  if (body.hoist !== undefined) updates.hoist = Boolean(body.hoist);
  if (body.mentionable !== undefined) updates.mentionable = Boolean(body.mentionable);

  if (Object.keys(updates).length === 0) {
    return badRequest(request, "No role fields provided.");
  }

  const [updated] = await db
    .update(guildRoles)
    .set(updates)
    .where(and(eq(guildRoles.guildId, guildId), eq(guildRoles.id, roleId)))
    .returning();

  if (!updated) {
    return notFound(request);
  }

  const payload = {
    guild_id: guildId,
    role: toGuildRolePayload(updated),
  };

  await emitToGuild(guildId, "GUILD_ROLE_UPDATE", payload);

  return json(request, toGuildRolePayload(updated));
};

export const deleteRole = async (request: BunRequest<"/api/guilds/:guildId/roles/:roleId">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  const roleId = request.params.roleId;
  if (!guildId || !roleId) {
    return badRequest(request, "Invalid guild id or role id.");
  }

  const canManageRoles = await hasGuildPermission(me.id, guildId, PermissionBits.MANAGE_ROLES);
  if (!canManageRoles) {
    return forbidden(request, "Missing MANAGE_ROLES.");
  }

  if (roleId === guildId) {
    return badRequest(request, "Cannot delete @everyone role.");
  }

  const [deleted] = await db
    .delete(guildRoles)
    .where(and(eq(guildRoles.guildId, guildId), eq(guildRoles.id, roleId)))
    .returning();

  if (!deleted) {
    return notFound(request);
  }

  await db.delete(guildMemberRoles).where(and(eq(guildMemberRoles.guildId, guildId), eq(guildMemberRoles.roleId, roleId)));

  await emitToGuild(guildId, "GUILD_ROLE_DELETE", {
    guild_id: guildId,
    role_id: roleId,
  });

  return empty(request, 204);
};

export const addMemberRole = async (
  request: BunRequest<"/api/guilds/:guildId/members/:userId/roles/:roleId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  const userId = request.params.userId;
  const roleId = request.params.roleId;
  if (!guildId || !userId || !roleId) {
    return badRequest(request, "Invalid guild id, user id, or role id.");
  }

  const canManageRoles = await hasGuildPermission(me.id, guildId, PermissionBits.MANAGE_ROLES);
  if (!canManageRoles) {
    return forbidden(request, "Missing MANAGE_ROLES.");
  }

  if (roleId === guildId) {
    return badRequest(request, "@everyone role is implicit and cannot be assigned directly.");
  }

  const role = await db.query.guildRoles.findFirst({
    where: and(eq(guildRoles.guildId, guildId), eq(guildRoles.id, roleId)),
  });
  if (!role) {
    return notFound(request);
  }

  if (hasPerm(parsePerms(role.permissions), PermissionBits.ADMINISTRATOR) && !(await canGrantAdmin(guildId, me.id))) {
    return forbidden(request, "Only the guild owner can grant ADMINISTRATOR.");
  }

  const member = await db.query.guildMembers.findFirst({
    where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)),
  });
  if (!member) {
    return notFound(request);
  }

  await db
    .insert(guildMemberRoles)
    .values({ guildId, userId, roleId })
    .onConflictDoNothing();

  const roleRows = await db
    .select({ roleId: guildMemberRoles.roleId })
    .from(guildMemberRoles)
    .where(and(eq(guildMemberRoles.guildId, guildId), eq(guildMemberRoles.userId, userId)));

  await emitToGuild(guildId, "GUILD_MEMBER_UPDATE", {
    guild_id: guildId,
    user: { id: userId },
    roles: [guildId, ...roleRows.map(row => row.roleId)],
  });

  return json(request, {
    guild_id: guildId,
    user_id: userId,
    role_id: roleId,
  });
};

export const removeMemberRole = async (
  request: BunRequest<"/api/guilds/:guildId/members/:userId/roles/:roleId">,
): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const me = authResult.user;
  const guildId = request.params.guildId;
  const userId = request.params.userId;
  const roleId = request.params.roleId;
  if (!guildId || !userId || !roleId) {
    return badRequest(request, "Invalid guild id, user id, or role id.");
  }

  const canManageRoles = await hasGuildPermission(me.id, guildId, PermissionBits.MANAGE_ROLES);
  if (!canManageRoles) {
    return forbidden(request, "Missing MANAGE_ROLES.");
  }

  if (roleId === guildId) {
    return badRequest(request, "Cannot remove the implicit @everyone role.");
  }

  await db
    .delete(guildMemberRoles)
    .where(and(eq(guildMemberRoles.guildId, guildId), eq(guildMemberRoles.userId, userId), eq(guildMemberRoles.roleId, roleId)));

  const roleRows = await db
    .select({ roleId: guildMemberRoles.roleId })
    .from(guildMemberRoles)
    .where(and(eq(guildMemberRoles.guildId, guildId), eq(guildMemberRoles.userId, userId)));

  await emitToGuild(guildId, "GUILD_MEMBER_UPDATE", {
    guild_id: guildId,
    user: { id: userId },
    roles: [guildId, ...roleRows.map(row => row.roleId)],
  });

  return json(request, {
    guild_id: guildId,
    user_id: userId,
    role_id: roleId,
  });
};
