import type { Role, GuildMemberSummary } from "@/lib/api";

export type MemberStatus = "online" | "idle" | "dnd" | "offline";

export type IndexedRole = {
  position: number;
  name: string;
  color?: number | null;
};

export type TopRole = {
  id: string;
  name: string;
  color?: number | null;
  position: number;
};

export const getMemberDisplayName = (member: GuildMemberSummary): string =>
  member.nick?.trim() || member.user.display_name;

export const getMemberStatus = (member: GuildMemberSummary): MemberStatus =>
  member.presence?.status ?? "offline";

export const buildRoleIndex = (roles: Role[]): Map<string, IndexedRole> =>
  new Map(
    roles.map((role) => [
      role.id,
      {
        position: role.position,
        name: role.name,
        color: role.color,
      },
    ]),
  );

export const getTopRole = (
  member: GuildMemberSummary,
  roleIndex: Map<string, IndexedRole>,
): TopRole | null => {
  let topRole: TopRole | null = null;

  for (const roleId of member.roles) {
    const role = roleIndex.get(roleId);
    if (!role) {
      continue;
    }

    if (
      !topRole ||
      role.position > topRole.position ||
      (role.position === topRole.position && roleId.localeCompare(topRole.id) < 0)
    ) {
      topRole = {
        id: roleId,
        name: role.name,
        color: role.color,
        position: role.position,
      };
    }
  }

  return topRole;
};

export const sortMembers = (
  members: GuildMemberSummary[],
  roleIndex: Map<string, IndexedRole>,
): GuildMemberSummary[] =>
  [...members].sort((left, right) => {
    const leftTop = getTopRole(left, roleIndex);
    const rightTop = getTopRole(right, roleIndex);
    const leftPosition = leftTop?.position ?? Number.NEGATIVE_INFINITY;
    const rightPosition = rightTop?.position ?? Number.NEGATIVE_INFINITY;

    if (leftPosition !== rightPosition) {
      return rightPosition - leftPosition;
    }

    const byName = getMemberDisplayName(left).localeCompare(
      getMemberDisplayName(right),
      undefined,
      { sensitivity: "base" },
    );
    if (byName !== 0) {
      return byName;
    }

    return left.user.id.localeCompare(right.user.id);
  });

