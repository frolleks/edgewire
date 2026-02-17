export const PermissionBits = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_ROLES: 1n << 28n,
  ADMINISTRATOR: 1n << 3n,
} as const;

export const ALL_PERMISSIONS: bigint = Object.values(PermissionBits).reduce((acc, bit) => acc | bit, 0n);

export type PermissionBit = (typeof PermissionBits)[keyof typeof PermissionBits];

export type PermissionOverwriteInput = {
  overwrite_id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
};

export const parsePerms = (value: string | null | undefined): bigint => {
  if (!value) {
    return 0n;
  }

  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
};

export const serializePerms = (value: bigint): string => (value < 0n ? "0" : value.toString());

export const hasPerm = (perms: bigint, bit: PermissionBit): boolean => (perms & bit) === bit;

export const hasAnyPerm = (perms: bigint, bits: PermissionBit[]): boolean => bits.some(bit => hasPerm(perms, bit));

export const computeBasePermissions = (params: {
  everyonePermissions: string;
  rolePermissions: string[];
  isOwner: boolean;
}): bigint => {
  if (params.isOwner) {
    return ALL_PERMISSIONS;
  }

  let permissions = parsePerms(params.everyonePermissions);
  for (const rolePerms of params.rolePermissions) {
    permissions |= parsePerms(rolePerms);
  }

  if (hasPerm(permissions, PermissionBits.ADMINISTRATOR)) {
    return ALL_PERMISSIONS;
  }

  return permissions;
};

export const applyOverwrite = (permissions: bigint, allow: bigint, deny: bigint): bigint => {
  return (permissions & ~deny) | allow;
};

export const computeChannelPermissions = (params: {
  basePermissions: bigint;
  overwrites: PermissionOverwriteInput[];
  memberRoleIds: string[];
  memberUserId: string;
  guildId: string;
}): bigint => {
  if (hasPerm(params.basePermissions, PermissionBits.ADMINISTRATOR)) {
    return ALL_PERMISSIONS;
  }

  let permissions = params.basePermissions;

  const everyoneOverwrite = params.overwrites.find(
    overwrite => overwrite.type === 0 && overwrite.overwrite_id === params.guildId,
  );

  if (everyoneOverwrite) {
    permissions = applyOverwrite(
      permissions,
      parsePerms(everyoneOverwrite.allow),
      parsePerms(everyoneOverwrite.deny),
    );
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  const memberRoleSet = new Set(params.memberRoleIds);
  for (const overwrite of params.overwrites) {
    if (overwrite.type !== 0 || !memberRoleSet.has(overwrite.overwrite_id)) {
      continue;
    }
    roleAllow |= parsePerms(overwrite.allow);
    roleDeny |= parsePerms(overwrite.deny);
  }
  permissions = applyOverwrite(permissions, roleAllow, roleDeny);

  const memberOverwrite = params.overwrites.find(
    overwrite => overwrite.type === 1 && overwrite.overwrite_id === params.memberUserId,
  );

  if (memberOverwrite) {
    permissions = applyOverwrite(permissions, parsePerms(memberOverwrite.allow), parsePerms(memberOverwrite.deny));
  }

  return permissions;
};

export const defaultEveryonePermissions = (): string =>
  serializePerms(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES | PermissionBits.READ_MESSAGE_HISTORY);
