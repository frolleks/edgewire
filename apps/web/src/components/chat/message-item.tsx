import type { MessagePayload, UserSummary } from "@discord/types";
import { Trash2 } from "lucide-react";
import AttachmentList from "@/components/chat/attachments/attachment-list";
import { formatTime, getDisplayInitial } from "@/components/utils/format";
import { Button } from "@/components/ui/button";
import { PermissionBits, hasPermission } from "@/lib/permissions";

type MessageItemProps = {
  message: MessagePayload;
  compactMode: boolean;
  showTimestamps: boolean;
  localePreference?: string;
  routeMode: "dm" | "guild";
  currentUserId: string | null;
  activeGuildChannelPermissions: bigint;
  isDeleting: boolean;
  onOpenProfile: (user: UserSummary) => void;
  onDeleteMessage: (messageId: string) => void;
};

export function MessageItem({
  message,
  compactMode,
  showTimestamps,
  localePreference,
  routeMode,
  currentUserId,
  activeGuildChannelPermissions,
  isDeleting,
  onOpenProfile,
  onDeleteMessage,
}: MessageItemProps) {
  const isOwnMessage = Boolean(currentUserId && message.author.id === currentUserId);
  const canDeleteMessage =
    currentUserId !== null &&
    (routeMode === "dm"
      ? isOwnMessage
      : isOwnMessage ||
        hasPermission(
          activeGuildChannelPermissions,
          PermissionBits.MANAGE_MESSAGES,
        ));

  return (
    <article className={`group relative flex ${compactMode ? "gap-2 py-1" : "gap-3"}`}>
      <button
        type="button"
        onClick={() => onOpenProfile(message.author)}
        className={`${compactMode ? "h-7 w-7" : "h-9 w-9"} shrink-0 overflow-hidden rounded-full bg-muted grid place-items-center text-xs font-semibold uppercase`}
        aria-label={`Open profile for ${message.author.display_name}`}
      >
        {message.author.avatar_url ? (
          <img
            src={message.author.avatar_url}
            alt={`${message.author.display_name} avatar`}
            className="h-full w-full object-cover"
          />
        ) : (
          getDisplayInitial(message.author.display_name)
        )}
      </button>
      <div className="relative min-w-0 flex-1 pr-12">
        <div className="flex items-center gap-2">
          <span className={`font-semibold ${compactMode ? "text-xs" : "text-sm"}`}>
            {message.author.display_name}
          </span>
          {showTimestamps ? (
            <span className="text-xs">
              {formatTime(message.timestamp, localePreference)}
            </span>
          ) : null}
          {message.edited_timestamp ? (
            <span className="text-[10px]">(edited)</span>
          ) : null}
        </div>
        {message.content ? (
          <p
            className={`whitespace-pre-wrap break-words mt-1 ${compactMode ? "text-xs" : "text-sm"}`}
          >
            {message.content}
          </p>
        ) : null}
        <AttachmentList attachments={message.attachments} />

        {canDeleteMessage ? (
          <div className="pointer-events-none absolute right-0 top-0 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <div className="pointer-events-auto rounded-md border bg-card shadow-sm">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Delete message"
                disabled={isDeleting}
                onClick={() => onDeleteMessage(message.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default MessageItem;
