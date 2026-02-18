import { ChannelType } from "@edgewire/types";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  channelMembers,
  channelPermissionOverwrites,
  channels,
  guildMemberRoles,
  guildMembers,
  guildRoles,
  guilds,
} from "../db/schema";
import {
  PermissionBits,
  computeBasePermissions,
  computeChannelPermissions,
  hasPerm,
  type PermissionBit,
  type PermissionOverwriteInput,
} from "./permissions";

export type GuildPermissionContext = {
  guildId: string;
  userId: string;
  isOwner: boolean;
  permissions: bigint;
  memberRoleIds: string[];
};

export type ChannelPermissionContext = {
  channel: typeof channels.$inferSelect;
  guildPermissions: GuildPermissionContext | null;
  permissions: bigint | null;
};

export const getGuildPermissionContext = async (
  userId: string,
  guildId: string,
): Promise<GuildPermissionContext | null> => {
  const guild = await db.query.guilds.findFirst({
    where: eq(guilds.id, guildId),
  });

  if (!guild) {
    return null;
  }

  const membership = await db.query.guildMembers.findFirst({
    where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)),
  });

  if (!membership) {
    return null;
  }

  const roleLinks = await db
    .select({ roleId: guildMemberRoles.roleId })
    .from(guildMemberRoles)
    .where(and(eq(guildMemberRoles.guildId, guildId), eq(guildMemberRoles.userId, userId)));

  const roleIds = [...new Set(roleLinks.map(link => link.roleId).filter(roleId => roleId !== guildId))];
  const roleRows = roleIds.length
    ? await db
        .select({ id: guildRoles.id, permissions: guildRoles.permissions })
        .from(guildRoles)
        .where(and(eq(guildRoles.guildId, guildId), inArray(guildRoles.id, roleIds)))
    : [];

  const everyoneRole = await db.query.guildRoles.findFirst({
    where: and(eq(guildRoles.guildId, guildId), eq(guildRoles.id, guildId)),
  });

  const permissions = computeBasePermissions({
    everyonePermissions: everyoneRole?.permissions ?? "0",
    rolePermissions: roleRows.map(role => role.permissions),
    isOwner: guild.ownerId === userId,
  });

  return {
    guildId,
    userId,
    isOwner: guild.ownerId === userId,
    permissions,
    memberRoleIds: roleRows.map(role => role.id),
  };
};

export const hasGuildPermission = async (userId: string, guildId: string, permission: PermissionBit): Promise<boolean> => {
  const context = await getGuildPermissionContext(userId, guildId);
  if (!context) {
    return false;
  }

  return hasPerm(context.permissions, permission);
};

export const getChannelPermissionContext = async (
  userId: string,
  channelId: string,
): Promise<ChannelPermissionContext | null> => {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
  });

  if (!channel) {
    return null;
  }

  if (channel.type === ChannelType.DM) {
    const member = await db.query.channelMembers.findFirst({
      where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)),
    });

    return {
      channel,
      guildPermissions: null,
      permissions: member ? 0n : null,
    };
  }

  if (!channel.guildId) {
    return {
      channel,
      guildPermissions: null,
      permissions: null,
    };
  }

  const guildContext = await getGuildPermissionContext(userId, channel.guildId);
  if (!guildContext) {
    return {
      channel,
      guildPermissions: null,
      permissions: null,
    };
  }

  const overwrites = await db
    .select({
      overwrite_id: channelPermissionOverwrites.overwriteId,
      type: channelPermissionOverwrites.type,
      allow: channelPermissionOverwrites.allow,
      deny: channelPermissionOverwrites.deny,
    })
    .from(channelPermissionOverwrites)
    .where(eq(channelPermissionOverwrites.channelId, channelId));

  const permissions = computeChannelPermissions({
    basePermissions: guildContext.permissions,
    overwrites: toPermissionOverwrites(overwrites),
    memberRoleIds: guildContext.memberRoleIds,
    memberUserId: userId,
    guildId: channel.guildId,
  });

  return {
    channel,
    guildPermissions: guildContext,
    permissions,
  };
};

export const hasChannelPermission = async (
  userId: string,
  channelId: string,
  permission: PermissionBit,
): Promise<boolean> => {
  const context = await getChannelPermissionContext(userId, channelId);
  if (!context) {
    return false;
  }

  if (context.channel.type === ChannelType.DM) {
    return context.permissions !== null;
  }

  if (context.permissions === null) {
    return false;
  }

  return hasPerm(context.permissions, permission);
};

export const listVisibleGuildChannelsForUser = async (
  userId: string,
  guildId: string,
): Promise<Array<typeof channels.$inferSelect>> => {
  const guildContext = await getGuildPermissionContext(userId, guildId);
  if (!guildContext) {
    return [];
  }

  const allChannels = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.guildId, guildId),
        inArray(channels.type, [ChannelType.GUILD_TEXT, ChannelType.GUILD_VOICE, ChannelType.GUILD_CATEGORY]),
      ),
    )
    .orderBy(asc(channels.position), asc(sql`${channels.id}::bigint`));

  const results = await Promise.all(
    allChannels.map(async channel => {
      const overwrites = await db
        .select({
          overwrite_id: channelPermissionOverwrites.overwriteId,
          type: channelPermissionOverwrites.type,
          allow: channelPermissionOverwrites.allow,
          deny: channelPermissionOverwrites.deny,
        })
        .from(channelPermissionOverwrites)
        .where(eq(channelPermissionOverwrites.channelId, channel.id));

      const perms = computeChannelPermissions({
        basePermissions: guildContext.permissions,
        overwrites: toPermissionOverwrites(overwrites),
        memberRoleIds: guildContext.memberRoleIds,
        memberUserId: userId,
        guildId,
      });

      return hasPerm(perms, PermissionBits.VIEW_CHANNEL) ? channel : null;
    }),
  );

  return results.filter((value): value is typeof channels.$inferSelect => Boolean(value));
};

const toPermissionOverwrites = (
  rows: Array<{ overwrite_id: string; type: number; allow: string; deny: string }>,
): PermissionOverwriteInput[] =>
  rows
    .filter(row => row.type === 0 || row.type === 1)
    .map(row => ({
      overwrite_id: row.overwrite_id,
      type: row.type as 0 | 1,
      allow: row.allow,
      deny: row.deny,
    }));
