import { ChannelType, type GuildChannelPayload } from "@discord/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, type Guild, type Role } from "@/lib/api";
import {
  PermissionBits,
  hasPermission,
  parsePermissions,
  permissionChecklist,
  toPermissionString,
} from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type SettingsTab = "overview" | "roles" | "members";

type GuildSettingsModalProps = {
  open: boolean;
  guildId: string | null;
  canManageGuild: boolean;
  canManageRoles: boolean;
  channels: GuildChannelPayload[];
  onClose: () => void;
};

type OverviewDraft = {
  name: string;
  icon: string;
  verification_level: string;
  default_message_notifications: string;
  explicit_content_filter: string;
  preferred_locale: string;
  system_channel_id: string;
  rules_channel_id: string;
  public_updates_channel_id: string;
};

type RoleDraft = {
  name: string;
  permissions: string;
  color: string;
  hoist: boolean;
  mentionable: boolean;
};

const defaultOverviewDraft: OverviewDraft = {
  name: "",
  icon: "",
  verification_level: "0",
  default_message_notifications: "0",
  explicit_content_filter: "0",
  preferred_locale: "en-US",
  system_channel_id: "none",
  rules_channel_id: "none",
  public_updates_channel_id: "none",
};

const roleSortDesc = (a: Role, b: Role): number => {
  if (a.position !== b.position) {
    return b.position - a.position;
  }
  return a.id.localeCompare(b.id);
};

const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const indexById = new Map<string, number>();
  const next: T[] = [];

  for (const item of items) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, next.length);
      next.push(item);
      continue;
    }

    next[existingIndex] = item;
  }

  return next;
};

const makeRoleDraft = (role: Role): RoleDraft => ({
  name: role.name,
  permissions: role.permissions,
  color: role.color === null ? "" : String(role.color),
  hoist: role.hoist,
  mentionable: role.mentionable,
});

const groupOrder = ["General", "Text", "Moderation", "Admin"] as const;

export const GuildSettingsModal = ({
  open,
  guildId,
  canManageGuild,
  canManageRoles,
  channels,
  onClose,
}: GuildSettingsModalProps) => {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<SettingsTab>("overview");
  const [membersCursors, setMembersCursors] = useState<string[]>([""]);
  const [overviewDraft, setOverviewDraft] = useState<OverviewDraft>(defaultOverviewDraft);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<RoleDraft | null>(null);
  const [memberRoleSelection, setMemberRoleSelection] = useState<Record<string, string>>({});

  const membersLimit = 20;
  const membersCursor = membersCursors[membersCursors.length - 1] ?? "";

  const guildSettingsQuery = useQuery({
    queryKey: queryKeys.guildSettings(guildId ?? "none"),
    queryFn: () => api.getGuild(guildId!),
    enabled: open && Boolean(guildId),
  });

  const rolesQuery = useQuery({
    queryKey: queryKeys.guildRoles(guildId ?? "none"),
    queryFn: () => api.listGuildRoles(guildId!),
    enabled: open && Boolean(guildId) && (tab === "roles" || tab === "members"),
  });

  const guildMembersQuery = useQuery({
    queryKey: ["guild-members-settings", guildId ?? "none", membersCursor],
    queryFn: () =>
      api.listGuildMembers(guildId!, {
        limit: membersLimit,
        after: membersCursor || undefined,
      }),
    enabled: open && Boolean(guildId) && tab === "members" && canManageGuild,
  });

  const updateGuildMutation = useMutation({
    mutationFn: (payload: Parameters<typeof api.updateGuild>[1]) => api.updateGuild(guildId!, payload),
    onSuccess: updatedGuild => {
      queryClient.setQueryData<Guild>(queryKeys.guildSettings(updatedGuild.id), updatedGuild);
      queryClient.setQueryData<Guild[]>(queryKeys.guilds, old => {
        const guilds = old ?? [];
        const index = guilds.findIndex(guild => guild.id === updatedGuild.id);
        if (index === -1) {
          return [...guilds, updatedGuild].sort((a, b) => a.name.localeCompare(b.name));
        }
        const next = [...guilds];
        next[index] = { ...next[index], ...updatedGuild };
        return next;
      });
      toast.success("Server settings updated.");
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not update server settings.");
    },
  });

  const createRoleMutation = useMutation({
    mutationFn: () => api.createGuildRole(guildId!, {}),
    onSuccess: createdRole => {
      queryClient.setQueryData<Role[]>(queryKeys.guildRoles(guildId!), old =>
        dedupeById([...(old ?? []), createdRole]).sort(roleSortDesc),
      );
      setSelectedRoleId(createdRole.id);
      toast.success("Role created.");
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not create role.");
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: (payload: { roleId: string; body: Parameters<typeof api.updateGuildRole>[2] }) =>
      api.updateGuildRole(guildId!, payload.roleId, payload.body),
    onSuccess: updatedRole => {
      queryClient.setQueryData<Role[]>(queryKeys.guildRoles(guildId!), old =>
        (old ?? []).map(role => (role.id === updatedRole.id ? updatedRole : role)).sort(roleSortDesc),
      );
      toast.success("Role updated.");
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not update role.");
    },
  });

  const deleteRoleMutation = useMutation({
    mutationFn: (roleId: string) => api.deleteGuildRole(guildId!, roleId),
    onSuccess: (_result, roleId) => {
      queryClient.setQueryData<Role[]>(queryKeys.guildRoles(guildId!), old =>
        (old ?? []).filter(role => role.id !== roleId),
      );
      setSelectedRoleId(current => (current === roleId ? null : current));
      toast.success("Role deleted.");
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not delete role.");
    },
  });

  const reorderRolesMutation = useMutation({
    mutationFn: (payload: Array<{ id: string; position: number }>) => api.reorderGuildRoles(guildId!, payload),
    onSuccess: roles => {
      queryClient.setQueryData<Role[]>(queryKeys.guildRoles(guildId!), roles.sort(roleSortDesc));
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not reorder roles.");
    },
  });

  const addMemberRoleMutation = useMutation({
    mutationFn: (payload: { userId: string; roleId: string }) => api.addGuildMemberRole(guildId!, payload.userId, payload.roleId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["guild-members", guildId] });
      queryClient.invalidateQueries({ queryKey: ["guild-members-settings", guildId] });
      setMemberRoleSelection(previous => ({
        ...previous,
        [variables.userId]: "none",
      }));
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not add role to member.");
    },
  });

  const removeMemberRoleMutation = useMutation({
    mutationFn: (payload: { userId: string; roleId: string }) =>
      api.removeGuildMemberRole(guildId!, payload.userId, payload.roleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["guild-members", guildId] });
      queryClient.invalidateQueries({ queryKey: ["guild-members-settings", guildId] });
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not remove role from member.");
    },
  });

  const guild = guildSettingsQuery.data;
  const roles = useMemo(
    () => dedupeById([...(rolesQuery.data ?? [])]).sort(roleSortDesc),
    [rolesQuery.data],
  );
  const roleById = useMemo(() => new Map(roles.map(role => [role.id, role])), [roles]);
  const members = guildMembersQuery.data?.members ?? [];
  const hasMoreMembers = Boolean(guildMembersQuery.data?.next_after);
  const textChannels = useMemo(
    () => dedupeById(channels).filter(channel => channel.type === ChannelType.GUILD_TEXT),
    [channels],
  );

  const selectedRole =
    (selectedRoleId ? roles.find(role => role.id === selectedRoleId) : null) ?? roles[0] ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }

    setMembersCursors([""]);
    setMemberRoleSelection({});
    setTab("overview");
  }, [open, guildId]);

  useEffect(() => {
    if (!guild) {
      return;
    }

    setOverviewDraft({
      name: guild.name,
      icon: guild.icon ?? "",
      verification_level: String(guild.verification_level ?? 0),
      default_message_notifications: String(guild.default_message_notifications ?? 0),
      explicit_content_filter: String(guild.explicit_content_filter ?? 0),
      preferred_locale: guild.preferred_locale ?? "en-US",
      system_channel_id: guild.system_channel_id ?? "none",
      rules_channel_id: guild.rules_channel_id ?? "none",
      public_updates_channel_id: guild.public_updates_channel_id ?? "none",
    });
  }, [guild?.id, guild]);

  useEffect(() => {
    if (!selectedRole && roles.length > 0) {
      setSelectedRoleId(roles[0]!.id);
      return;
    }

    if (!selectedRole) {
      setRoleDraft(null);
      return;
    }

    setRoleDraft(makeRoleDraft(selectedRole));
  }, [roles, selectedRole]);

  if (!open) {
    return null;
  }

  const submitOverview = async (): Promise<void> => {
    if (!guildId) {
      return;
    }

    const trimmedName = overviewDraft.name.trim();
    if (!trimmedName) {
      toast.error("Server name is required.");
      return;
    }

    await updateGuildMutation.mutateAsync({
      name: trimmedName,
      icon: overviewDraft.icon.trim() ? overviewDraft.icon.trim() : null,
      verification_level: Number(overviewDraft.verification_level) || 0,
      default_message_notifications: Number(overviewDraft.default_message_notifications) || 0,
      explicit_content_filter: Number(overviewDraft.explicit_content_filter) || 0,
      preferred_locale: overviewDraft.preferred_locale.trim() || "en-US",
      system_channel_id: overviewDraft.system_channel_id === "none" ? null : overviewDraft.system_channel_id,
      rules_channel_id: overviewDraft.rules_channel_id === "none" ? null : overviewDraft.rules_channel_id,
      public_updates_channel_id:
        overviewDraft.public_updates_channel_id === "none" ? null : overviewDraft.public_updates_channel_id,
    });
  };

  const moveRole = async (roleId: string, direction: "up" | "down"): Promise<void> => {
    if (!guildId) {
      return;
    }

    const index = roles.findIndex(role => role.id === roleId);
    if (index === -1) {
      return;
    }

    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= roles.length) {
      return;
    }

    const reordered = [...roles];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved!);

    const payload = reordered.map((role, positionIndex) => ({
      id: role.id,
      position: reordered.length - positionIndex - 1,
    }));

    await reorderRolesMutation.mutateAsync(payload);
  };

  const submitRoleUpdate = async (): Promise<void> => {
    if (!guildId || !selectedRole || !roleDraft) {
      return;
    }

    const trimmedName = roleDraft.name.trim();
    if (!trimmedName) {
      toast.error("Role name is required.");
      return;
    }

    await updateRoleMutation.mutateAsync({
      roleId: selectedRole.id,
      body: {
        name: trimmedName,
        permissions: roleDraft.permissions,
        color: roleDraft.color.trim() === "" ? null : Number(roleDraft.color),
        hoist: roleDraft.hoist,
        mentionable: roleDraft.mentionable,
      },
    });
  };

  const groupedPermissions = groupOrder.map(group => ({
    group,
    items: permissionChecklist.filter(item => item.group === group),
  }));

  const rolePermissions = roleDraft ? parsePermissions(roleDraft.permissions) : 0n;
  const roleHasAdmin = hasPermission(rolePermissions, PermissionBits.ADMINISTRATOR);
  const enabledPermissionNames = permissionChecklist
    .filter(item => roleHasAdmin || hasPermission(rolePermissions, item.bit))
    .map(item => item.label);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4">
      <Card className="w-full max-w-5xl max-h-[90vh] overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Server Settings</CardTitle>
              <CardDescription>{guild?.name ?? "Configure this server"}</CardDescription>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close settings">
              <X />
            </Button>
          </div>
        </CardHeader>
        <div className="grid md:grid-cols-[220px_1fr] h-[72vh]">
          <aside className="border-r p-3 space-y-2 overflow-y-auto">
            <Button
              className="w-full justify-start"
              variant={tab === "overview" ? "secondary" : "ghost"}
              onClick={() => setTab("overview")}
            >
              Overview
            </Button>
            <Button
              className="w-full justify-start"
              variant={tab === "roles" ? "secondary" : "ghost"}
              onClick={() => setTab("roles")}
            >
              Roles
            </Button>
            <Button
              className="w-full justify-start"
              variant={tab === "members" ? "secondary" : "ghost"}
              onClick={() => setTab("members")}
            >
              Members
            </Button>
          </aside>

          <CardContent className="overflow-y-auto p-4 md:p-6">
            {!canManageGuild ? (
              <p className="text-sm">Missing `MANAGE_GUILD` permission.</p>
            ) : null}

            {canManageGuild && tab === "overview" ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="settings-guild-name">Server Name</Label>
                  <Input
                    id="settings-guild-name"
                    value={overviewDraft.name}
                    onChange={event => setOverviewDraft(previous => ({ ...previous, name: event.target.value }))}
                    maxLength={100}
                    className="mt-2"
                  />
                </div>

                <div>
                  <Label htmlFor="settings-guild-icon">Icon URL</Label>
                  <Input
                    id="settings-guild-icon"
                    value={overviewDraft.icon}
                    onChange={event => setOverviewDraft(previous => ({ ...previous, icon: event.target.value }))}
                    placeholder="https://..."
                    className="mt-2"
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label>Verification Level</Label>
                    <Select
                      value={overviewDraft.verification_level}
                      onValueChange={value =>
                        setOverviewDraft(previous => ({
                          ...previous,
                          verification_level: value,
                        }))
                      }
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">None</SelectItem>
                        <SelectItem value="1">Low</SelectItem>
                        <SelectItem value="2">Medium</SelectItem>
                        <SelectItem value="3">High</SelectItem>
                        <SelectItem value="4">Very High</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Default Notifications</Label>
                    <Select
                      value={overviewDraft.default_message_notifications}
                      onValueChange={value =>
                        setOverviewDraft(previous => ({
                          ...previous,
                          default_message_notifications: value,
                        }))
                      }
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">All Messages</SelectItem>
                        <SelectItem value="1">Only Mentions</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label>Explicit Content Filter</Label>
                    <Select
                      value={overviewDraft.explicit_content_filter}
                      onValueChange={value =>
                        setOverviewDraft(previous => ({
                          ...previous,
                          explicit_content_filter: value,
                        }))
                      }
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">Disabled</SelectItem>
                        <SelectItem value="1">Members Without Roles</SelectItem>
                        <SelectItem value="2">All Members</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="settings-preferred-locale">Preferred Locale</Label>
                    <Input
                      id="settings-preferred-locale"
                      value={overviewDraft.preferred_locale}
                      onChange={event =>
                        setOverviewDraft(previous => ({ ...previous, preferred_locale: event.target.value }))
                      }
                      className="mt-2"
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <Label>System Channel</Label>
                    <Select
                      value={overviewDraft.system_channel_id}
                      onValueChange={value => setOverviewDraft(previous => ({ ...previous, system_channel_id: value }))}
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {textChannels.map(channel => (
                          <SelectItem key={channel.id} value={channel.id}>
                            #{channel.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Rules Channel</Label>
                    <Select
                      value={overviewDraft.rules_channel_id}
                      onValueChange={value => setOverviewDraft(previous => ({ ...previous, rules_channel_id: value }))}
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {textChannels.map(channel => (
                          <SelectItem key={channel.id} value={channel.id}>
                            #{channel.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Public Updates Channel</Label>
                    <Select
                      value={overviewDraft.public_updates_channel_id}
                      onValueChange={value =>
                        setOverviewDraft(previous => ({ ...previous, public_updates_channel_id: value }))
                      }
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {textChannels.map(channel => (
                          <SelectItem key={channel.id} value={channel.id}>
                            #{channel.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button onClick={() => submitOverview()} disabled={updateGuildMutation.isPending}>
                    {updateGuildMutation.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </div>
            ) : null}

            {canManageGuild && tab === "roles" ? (
              !canManageRoles ? (
                <p className="text-sm">Missing `MANAGE_ROLES` permission.</p>
              ) : (
                <div className="grid gap-6 lg:grid-cols-[250px_1fr]">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Roles</p>
                      <Button
                        size="sm"
                        onClick={() => createRoleMutation.mutate()}
                        disabled={createRoleMutation.isPending}
                      >
                        Create Role
                      </Button>
                    </div>
                    <div className="space-y-1">
                      {roles.map((role, index) => (
                        <div
                          key={role.id}
                          className={`rounded border p-2 ${selectedRole?.id === role.id ? "bg-accent" : ""}`}
                        >
                          <button
                            type="button"
                            className="w-full text-left"
                            onClick={() => setSelectedRoleId(role.id)}
                          >
                            <p className="font-medium truncate">{role.name}</p>
                            <p className="text-xs">Position: {role.position}</p>
                          </button>
                          <div className="mt-2 flex gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={index === 0 || reorderRolesMutation.isPending}
                              onClick={() => moveRole(role.id, "up")}
                            >
                              Up
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={index === roles.length - 1 || reorderRolesMutation.isPending}
                              onClick={() => moveRole(role.id, "down")}
                            >
                              Down
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    {!selectedRole || !roleDraft ? (
                      <p className="text-sm">Select a role to edit.</p>
                    ) : (
                      <>
                        <div>
                          <Label htmlFor="role-name">Role Name</Label>
                          <Input
                            id="role-name"
                            value={roleDraft.name}
                            onChange={event =>
                              setRoleDraft(previous => (previous ? { ...previous, name: event.target.value } : previous))
                            }
                            className="mt-2"
                            maxLength={100}
                          />
                        </div>
                        <div>
                          <Label htmlFor="role-color">Color (integer)</Label>
                          <Input
                            id="role-color"
                            type="number"
                            value={roleDraft.color}
                            onChange={event =>
                              setRoleDraft(previous => (previous ? { ...previous, color: event.target.value } : previous))
                            }
                            className="mt-2"
                          />
                        </div>
                        <div className="grid gap-2 md:grid-cols-2">
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={roleDraft.hoist}
                              onChange={event =>
                                setRoleDraft(previous =>
                                  previous ? { ...previous, hoist: event.target.checked } : previous,
                                )
                              }
                            />
                            Hoist
                          </label>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={roleDraft.mentionable}
                              onChange={event =>
                                setRoleDraft(previous =>
                                  previous ? { ...previous, mentionable: event.target.checked } : previous,
                                )
                              }
                            />
                            Mentionable
                          </label>
                        </div>

                        <div className="space-y-4">
                          {groupedPermissions.map(group => (
                            <div key={group.group}>
                              <p className="text-sm font-semibold mb-2">{group.group}</p>
                              <div className="space-y-2">
                                {group.items.map(item => {
                                  const enabled = roleHasAdmin || hasPermission(rolePermissions, item.bit);
                                  return (
                                    <label key={item.key} className="flex items-center gap-2 text-sm">
                                      <input
                                        type="checkbox"
                                        checked={enabled}
                                        onChange={event => {
                                          const checked = event.target.checked;
                                          setRoleDraft(previous => {
                                            if (!previous) {
                                              return previous;
                                            }
                                            const current = parsePermissions(previous.permissions);
                                            const next = checked ? current | item.bit : current & ~item.bit;
                                            return { ...previous, permissions: toPermissionString(next) };
                                          });
                                        }}
                                      />
                                      {item.label}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>

                        <div className="rounded border p-3 text-xs">
                          <p className="font-semibold mb-1">This role can:</p>
                          <p>{enabledPermissionNames.length > 0 ? enabledPermissionNames.join(", ") : "No permissions"}</p>
                        </div>

                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            variant="destructive"
                            onClick={() => deleteRoleMutation.mutate(selectedRole.id)}
                            disabled={selectedRole.id === guildId || deleteRoleMutation.isPending}
                          >
                            Delete Role
                          </Button>
                          <Button onClick={() => submitRoleUpdate()} disabled={updateRoleMutation.isPending}>
                            {updateRoleMutation.isPending ? "Saving..." : "Save Role"}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )
            ) : null}

            {canManageGuild && tab === "members" ? (
              <div className="space-y-4">
                <p className="text-sm">Members</p>
                {guildMembersQuery.isLoading ? <p className="text-sm">Loading members...</p> : null}
                {members.map(member => {
                  const currentRoleIds = member.roles.filter(roleId => roleId !== guildId);
                  const availableRoles = roles.filter(
                    role => role.id !== guildId && !member.roles.includes(role.id),
                  );
                  const selectedRoleToAdd = memberRoleSelection[member.user.id] ?? "none";

                  return (
                    <div key={member.user.id} className="rounded border p-3 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold truncate">{member.user.display_name}</p>
                          <p className="text-xs truncate">@{member.user.username}</p>
                        </div>
                        <p className="text-xs">Joined: {new Date(member.joined_at).toLocaleDateString()}</p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {currentRoleIds.length === 0 ? <p className="text-xs">No extra roles.</p> : null}
                        {currentRoleIds.map(roleId => {
                          const role = roleById.get(roleId);
                          if (!role) {
                            return null;
                          }

                          return (
                            <div key={roleId} className="inline-flex items-center gap-2 rounded bg-accent px-2 py-1 text-xs">
                              <span>{role.name}</span>
                              {canManageRoles ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    removeMemberRoleMutation.mutate({
                                      userId: member.user.id,
                                      roleId: role.id,
                                    })
                                  }
                                >
                                  Remove
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      {canManageRoles ? (
                        <div className="flex items-center gap-2">
                          <Select
                            value={selectedRoleToAdd}
                            onValueChange={value =>
                              setMemberRoleSelection(previous => ({
                                ...previous,
                                [member.user.id]: value,
                              }))
                            }
                          >
                            <SelectTrigger className="w-56">
                              <SelectValue placeholder="Select role" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Select role</SelectItem>
                              {availableRoles.map(role => (
                                <SelectItem key={role.id} value={role.id}>
                                  {role.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            disabled={selectedRoleToAdd === "none" || addMemberRoleMutation.isPending}
                            onClick={() =>
                              addMemberRoleMutation.mutate({
                                userId: member.user.id,
                                roleId: selectedRoleToAdd,
                              })
                            }
                          >
                            Add Role
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={membersCursors.length <= 1 || guildMembersQuery.isFetching}
                    onClick={() =>
                      setMembersCursors(previous =>
                        previous.length <= 1 ? previous : previous.slice(0, previous.length - 1),
                      )
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!hasMoreMembers || guildMembersQuery.isFetching}
                    onClick={() => {
                      const nextAfter = guildMembersQuery.data?.next_after;
                      if (!nextAfter) {
                        return;
                      }
                      setMembersCursors(previous => [...previous, nextAfter]);
                    }}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </div>
      </Card>
    </div>
  );
};

export default GuildSettingsModal;
