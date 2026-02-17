import type { ChangeEvent } from "react";
import { useRef } from "react";
import { Modal } from "@/components/layout/modal";
import { getDisplayInitial } from "@/components/utils/format";
import { Button } from "@/components/ui/button";
import type { CurrentUser } from "@/lib/api";

type ProfileSettingsModalProps = {
  open: boolean;
  onClose: () => void;
  me?: CurrentUser;
  sessionUserName?: string;
  isUploading: boolean;
  onPickAvatar: (event: ChangeEvent<HTMLInputElement>) => void | Promise<void>;
};

export function ProfileSettingsModal({
  open,
  onClose,
  me,
  sessionUserName,
  isUploading,
  onPickAvatar,
}: ProfileSettingsModalProps) {
  const avatarInputRef = useRef<HTMLInputElement>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Profile Settings"
      description="Update your avatar."
    >
      <div className="space-y-4">
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            void onPickAvatar(event);
          }}
        />
        <div className="flex items-center gap-3">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full bg-muted grid place-items-center text-sm font-semibold uppercase">
            {me?.avatar_url ? (
              <img
                src={me.avatar_url}
                alt={`${me.display_name} avatar`}
                className="h-full w-full object-cover"
              />
            ) : (
              getDisplayInitial(me?.display_name ?? sessionUserName ?? "You")
            )}
          </div>
          <div className="min-w-0">
            <p className="font-semibold truncate">
              {me?.display_name ?? sessionUserName ?? "You"}
            </p>
            <p className="text-sm truncate">@{me?.username ?? "loading"}</p>
            <p className="text-xs mt-1">
              PNG, JPEG, or WEBP. Max size enforced by server.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() => avatarInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? "Uploading..." : "Change Avatar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default ProfileSettingsModal;
