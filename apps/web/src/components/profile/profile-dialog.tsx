import type { ProfileDialogState } from "@/app/types";
import { Modal } from "@/components/layout/modal";
import { getDisplayInitial } from "@/components/utils/format";
import type { Role } from "@/lib/api";
import type { PresenceStatus } from "@/lib/api";
import { presenceDotClassName } from "@/lib/presence";

type ProfileDialogProps = {
  state: ProfileDialogState | null;
  onClose: () => void;
  presenceStatus: PresenceStatus;
  roles: Role[];
  joinedAt?: string;
  isLoadingRoles: boolean;
  hasRolesError: boolean;
};

export function ProfileDialog({
  state,
  onClose,
  presenceStatus,
  roles,
  joinedAt,
  isLoadingRoles,
  hasRolesError,
}: ProfileDialogProps) {
  return (
    <Modal
      open={Boolean(state)}
      onClose={onClose}
      title={state?.user.display_name ?? "User Profile"}
      description={state ? `@${state.user.username}` : undefined}
    >
      {state ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-muted grid place-items-center text-sm font-semibold uppercase">
              {state.user.avatar_url ? (
                <img
                  src={state.user.avatar_url}
                  alt={`${state.user.display_name} avatar`}
                  className="h-full w-full object-cover"
                />
              ) : (
                getDisplayInitial(state.user.display_name)
              )}
              <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-card ${presenceDotClassName(presenceStatus)}`} />
            </div>
            <div className="min-w-0">
              <p className="font-semibold truncate">{state.user.display_name}</p>
              <p className="text-sm truncate">@{state.user.username}</p>
              <p className="text-xs mt-1 break-all">ID: {state.user.id}</p>
            </div>
          </div>

          {state.guildId ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold">Roles in this server</p>
              {isLoadingRoles ? <p className="text-sm">Loading roles...</p> : null}
              {hasRolesError ? (
                <p className="text-sm">Could not load roles for this user.</p>
              ) : null}
              {!isLoadingRoles && !hasRolesError ? (
                roles.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {roles.map((role) => (
                      <span
                        key={role.id}
                        className="rounded bg-accent px-2 py-1 text-xs"
                      >
                        {role.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm">No roles found.</p>
                )
              ) : null}
              {joinedAt ? (
                <p className="text-xs">
                  Joined: {new Date(joinedAt).toLocaleDateString()}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

export default ProfileDialog;
