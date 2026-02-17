import { describe, expect, it } from "bun:test";
import {
  PermissionBits,
  computeBasePermissions,
  computeChannelPermissions,
  hasPerm,
  serializePerms,
} from "./permissions";

describe("permissions compute", () => {
  it("owner has all permissions", () => {
    const perms = computeBasePermissions({
      everyonePermissions: "0",
      rolePermissions: [],
      isOwner: true,
    });

    expect(hasPerm(perms, PermissionBits.MANAGE_GUILD)).toBe(true);
    expect(hasPerm(perms, PermissionBits.ADMINISTRATOR)).toBe(true);
  });

  it("administrator bypasses channel overwrites", () => {
    const base = PermissionBits.ADMINISTRATOR;

    const finalPerms = computeChannelPermissions({
      basePermissions: base,
      guildId: "guild",
      memberRoleIds: [],
      memberUserId: "user",
      overwrites: [
        {
          overwrite_id: "guild",
          type: 0,
          allow: "0",
          deny: serializePerms(PermissionBits.SEND_MESSAGES | PermissionBits.VIEW_CHANNEL),
        },
      ],
    });

    expect(hasPerm(finalPerms, PermissionBits.VIEW_CHANNEL)).toBe(true);
    expect(hasPerm(finalPerms, PermissionBits.SEND_MESSAGES)).toBe(true);
  });

  it("applies overwrite order like Discord", () => {
    const base = PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES;

    const finalPerms = computeChannelPermissions({
      basePermissions: base,
      guildId: "guild",
      memberRoleIds: ["role1"],
      memberUserId: "user",
      overwrites: [
        {
          overwrite_id: "guild",
          type: 0,
          allow: "0",
          deny: serializePerms(PermissionBits.SEND_MESSAGES),
        },
        {
          overwrite_id: "role1",
          type: 0,
          allow: serializePerms(PermissionBits.SEND_MESSAGES),
          deny: "0",
        },
        {
          overwrite_id: "user",
          type: 1,
          allow: "0",
          deny: serializePerms(PermissionBits.SEND_MESSAGES),
        },
      ],
    });

    expect(hasPerm(finalPerms, PermissionBits.SEND_MESSAGES)).toBe(false);
  });

  it("base permissions merge everyone and roles", () => {
    const base = computeBasePermissions({
      everyonePermissions: serializePerms(PermissionBits.VIEW_CHANNEL),
      rolePermissions: [serializePerms(PermissionBits.SEND_MESSAGES)],
      isOwner: false,
    });

    expect(hasPerm(base, PermissionBits.VIEW_CHANNEL)).toBe(true);
    expect(hasPerm(base, PermissionBits.SEND_MESSAGES)).toBe(true);
  });
});
