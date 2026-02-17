export const PermissionBits = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_ROLES: 1n << 28n,
  ADMINISTRATOR: 1n << 3n,
} as const;

export type PermissionBit = (typeof PermissionBits)[keyof typeof PermissionBits];
export const ALL_PERMISSIONS: bigint = Object.values(PermissionBits).reduce((acc, bit) => acc | bit, 0n);

type PermissionOverwriteInput = {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
};

export const parsePermissions = (value: string | null | undefined): bigint => {
  if (!value) {
    return 0n;
  }

  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

export const hasPermission = (permissions: bigint, bit: PermissionBit): boolean => (permissions & bit) === bit;

export const toPermissionString = (permissions: bigint): string => permissions.toString();

const applyOverwrite = (permissions: bigint, allow: bigint, deny: bigint): bigint =>
  (permissions & ~deny) | allow;

export const computeChannelPermissions = (params: {
  basePermissions: bigint;
  overwrites: PermissionOverwriteInput[];
  memberRoleIds: string[];
  memberUserId: string;
  guildId: string;
}): bigint => {
  if (hasPermission(params.basePermissions, PermissionBits.ADMINISTRATOR)) {
    return ALL_PERMISSIONS;
  }

  let permissions = params.basePermissions;

  const everyoneOverwrite = params.overwrites.find(
    overwrite => overwrite.type === 0 && overwrite.id === params.guildId,
  );
  if (everyoneOverwrite) {
    permissions = applyOverwrite(
      permissions,
      parsePermissions(everyoneOverwrite.allow),
      parsePermissions(everyoneOverwrite.deny),
    );
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  const roleIdSet = new Set(params.memberRoleIds);
  for (const overwrite of params.overwrites) {
    if (overwrite.type !== 0 || !roleIdSet.has(overwrite.id)) {
      continue;
    }
    roleAllow |= parsePermissions(overwrite.allow);
    roleDeny |= parsePermissions(overwrite.deny);
  }
  permissions = applyOverwrite(permissions, roleAllow, roleDeny);

  const memberOverwrite = params.overwrites.find(
    overwrite => overwrite.type === 1 && overwrite.id === params.memberUserId,
  );
  if (memberOverwrite) {
    permissions = applyOverwrite(
      permissions,
      parsePermissions(memberOverwrite.allow),
      parsePermissions(memberOverwrite.deny),
    );
  }

  return permissions;
};

export const permissionChecklist = [
  { key: "VIEW_CHANNEL", label: "View Channels", bit: PermissionBits.VIEW_CHANNEL, group: "General" },
  { key: "MANAGE_GUILD", label: "Manage Server", bit: PermissionBits.MANAGE_GUILD, group: "General" },
  { key: "MANAGE_CHANNELS", label: "Manage Channels", bit: PermissionBits.MANAGE_CHANNELS, group: "General" },
  { key: "SEND_MESSAGES", label: "Send Messages", bit: PermissionBits.SEND_MESSAGES, group: "Text" },
  { key: "MANAGE_MESSAGES", label: "Manage Messages", bit: PermissionBits.MANAGE_MESSAGES, group: "Text" },
  {
    key: "READ_MESSAGE_HISTORY",
    label: "Read Message History",
    bit: PermissionBits.READ_MESSAGE_HISTORY,
    group: "Text",
  },
  { key: "MANAGE_ROLES", label: "Manage Roles", bit: PermissionBits.MANAGE_ROLES, group: "Moderation" },
  { key: "ADMINISTRATOR", label: "Administrator", bit: PermissionBits.ADMINISTRATOR, group: "Admin" },
] as const;
