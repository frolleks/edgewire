import type {
  GuildChannelPayload,
  GuildRole,
  MessagePayload,
  UserSummary,
} from "@discord/types";
import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import AttachmentList from "@/components/chat/attachments/attachment-list";
import MentionToken from "@/components/chat/mention-token";
import { formatTime, getDisplayInitial } from "@/components/utils/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PermissionBits, hasPermission } from "@/lib/permissions";

type MessageItemProps = {
  message: MessagePayload;
  groupedWithPrevious: boolean;
  compactMode: boolean;
  showTimestamps: boolean;
  localePreference?: string;
  routeMode: "dm" | "guild";
  currentUserId: string | null;
  currentUserRoleIds: string[];
  guildRoles: GuildRole[];
  guildChannels: GuildChannelPayload[];
  activeGuildChannelPermissions: bigint;
  isDeleting: boolean;
  isEditing: boolean;
  isEditPending: boolean;
  editLocked: boolean;
  onOpenProfile: (user: UserSummary) => void;
  onDeleteMessage: (messageId: string) => void;
  onStartEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (messageId: string, content: string) => void;
};

const MESSAGE_MENTION_TOKEN_REGEX =
  /<@!?[^\s>]+>|<@&[^\s>]+>|<#[^\s>]+>|\B@(?:everyone|here)\b/g;
const USER_MENTION_TOKEN_REGEX = /^<@!?([^\s>]+)>$/;
const ROLE_MENTION_TOKEN_REGEX = /^<@&([^\s>]+)>$/;
const CHANNEL_MENTION_TOKEN_REGEX = /^<#([^\s>]+)>$/;
const MESSAGE_MAX_LENGTH = 2000;

export function MessageItem({
  message,
  groupedWithPrevious,
  compactMode,
  showTimestamps,
  localePreference,
  routeMode,
  currentUserId,
  currentUserRoleIds,
  guildRoles,
  guildChannels,
  activeGuildChannelPermissions,
  isDeleting,
  isEditing,
  isEditPending,
  editLocked,
  onOpenProfile,
  onDeleteMessage,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
}: MessageItemProps) {
  const [draftContent, setDraftContent] = useState(message.content);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const isOwnMessage = Boolean(
    currentUserId && message.author.id === currentUserId,
  );
  const canStartEditing = isOwnMessage && !isDeleting && !isEditPending && !editLocked;
  const canDeleteMessage =
    currentUserId !== null &&
    (routeMode === "dm"
      ? isOwnMessage
      : isOwnMessage ||
        hasPermission(
          activeGuildChannelPermissions,
          PermissionBits.MANAGE_MESSAGES,
        ));
  const canShowDeleteAction = canDeleteMessage && !isEditing;
  const mentionsMe = Boolean(
    currentUserId &&
    (message.mentions.some((user) => user.id === currentUserId) ||
      message.mention_roles.some((roleId) =>
        currentUserRoleIds.includes(roleId),
      ) ||
      message.mention_everyone),
  );

  useEffect(() => {
    if (isEditing) {
      setDraftContent(message.content);
      window.requestAnimationFrame(() => {
        editTextareaRef.current?.focus();
        const length = editTextareaRef.current?.value.length ?? 0;
        editTextareaRef.current?.setSelectionRange(length, length);
      });
    }
  }, [isEditing, message.id]);

  const mentionUserById = useMemo(
    () => new Map(message.mentions.map((user) => [user.id, user])),
    [message.mentions],
  );
  const roleById = useMemo(
    () => new Map(guildRoles.map((role) => [role.id, role])),
    [guildRoles],
  );
  const channelMentionById = useMemo(
    () =>
      new Map(message.mention_channels.map((channel) => [channel.id, channel])),
    [message.mention_channels],
  );
  const guildChannelById = useMemo(
    () => new Map(guildChannels.map((channel) => [channel.id, channel])),
    [guildChannels],
  );

  const renderedContent = useMemo(() => {
    if (!message.content) {
      return null;
    }

    const nodes: React.ReactNode[] = [];
    let cursor = 0;

    for (const match of message.content.matchAll(MESSAGE_MENTION_TOKEN_REGEX)) {
      const token = match[0];
      const index = match.index ?? 0;

      if (index > cursor) {
        nodes.push(message.content.slice(cursor, index));
      }

      const userMatch = token.match(USER_MENTION_TOKEN_REGEX);
      if (userMatch) {
        const userId = userMatch[1];
        const user = userId ? mentionUserById.get(userId) : undefined;
        const fallbackLabel = userId ? `@user-${userId.slice(-4)}` : "@unknown";
        nodes.push(
          <MentionToken
            key={`${message.id}:${index}:user:${userId ?? "unknown"}`}
            label={user ? `@${user.display_name}` : fallbackLabel}
            onClick={user ? () => onOpenProfile(user) : undefined}
          />,
        );
        cursor = index + token.length;
        continue;
      }

      const roleMatch = token.match(ROLE_MENTION_TOKEN_REGEX);
      if (roleMatch) {
        const roleId = roleMatch[1];
        const role = roleId ? roleById.get(roleId) : undefined;
        const roleColor =
          role?.color === null || role?.color === undefined
            ? undefined
            : `#${role.color.toString(16).padStart(6, "0")}`;
        nodes.push(
          <MentionToken
            key={`${message.id}:${index}:role:${roleId ?? "unknown"}`}
            label={role ? `@${role.name}` : "@deleted-role"}
            accentColor={roleColor}
          />,
        );
        cursor = index + token.length;
        continue;
      }

      const channelMatch = token.match(CHANNEL_MENTION_TOKEN_REGEX);
      if (channelMatch) {
        const channelId = channelMatch[1];
        const channelMention = channelId
          ? channelMentionById.get(channelId)
          : undefined;
        const guildChannel = channelId
          ? guildChannelById.get(channelId)
          : undefined;
        const channelName = channelMention?.name ?? guildChannel?.name ?? null;

        nodes.push(
          <MentionToken
            key={`${message.id}:${index}:channel:${channelId ?? "unknown"}`}
            label={channelName ? `#${channelName}` : "#deleted-channel"}
          />,
        );
        cursor = index + token.length;
        continue;
      }

      nodes.push(
        <MentionToken
          key={`${message.id}:${index}:everyone`}
          label={token}
          className="bg-primary/15 text-primary"
        />,
      );
      cursor = index + token.length;
    }

    if (cursor < message.content.length) {
      nodes.push(message.content.slice(cursor));
    }

    return nodes;
  }, [
    guildChannelById,
    mentionUserById,
    channelMentionById,
    roleById,
    message.content,
    message.id,
    onOpenProfile,
  ]);

  return (
    <article
      tabIndex={0}
      onKeyDown={(event) => {
        const wantsEditShortcut =
          event.key === "e" ||
          event.key === "E" ||
          (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey);
        if (!isEditing && canStartEditing && wantsEditShortcut) {
          event.preventDefault();
          onStartEdit(message.id);
        }
      }}
      className={`group relative flex ${compactMode ? "gap-2" : "gap-3"} ${
        groupedWithPrevious ? "py-px" : compactMode ? "py-1" : "py-2"
      } px-2 transition-colors hover:bg-accent/50 ${
        mentionsMe ? "border-l-2 border-primary/80 bg-accent/30" : ""
      } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60`}
    >
      {groupedWithPrevious ? (
        <div
          className={`${compactMode ? "w-9" : "w-11"} relative shrink-0 select-none text-right`}
          aria-hidden
        >
          {showTimestamps ? (
            <span className="absolute right-0 top-0 text-[9px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {formatTime(message.timestamp, localePreference)}
            </span>
          ) : null}
        </div>
      ) : (
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
      )}
      <div className="relative min-w-0 flex-1">
        {!groupedWithPrevious ? (
          <div className="flex items-center gap-2">
            <span
              className={`font-semibold ${compactMode ? "text-xs" : "text-sm"}`}
            >
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
        ) : null}
        {isEditing ? (
          <div className={groupedWithPrevious ? "" : "mt-1"}>
            <Textarea
              ref={editTextareaRef}
              rows={2}
              maxLength={MESSAGE_MAX_LENGTH}
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraftContent(message.content);
                  onCancelEdit();
                  return;
                }

                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const trimmed = draftContent.trim();
                  if (!trimmed && message.attachments.length === 0) {
                    toast.error("Message must include content or attachments.");
                    return;
                  }
                  if (draftContent.length > MESSAGE_MAX_LENGTH) {
                    toast.error(`Message must be ${MESSAGE_MAX_LENGTH} characters or fewer.`);
                    return;
                  }
                  onSaveEdit(message.id, draftContent);
                }
              }}
              className="min-h-20 resize-y"
              disabled={isEditPending}
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const trimmed = draftContent.trim();
                  if (!trimmed && message.attachments.length === 0) {
                    toast.error("Message must include content or attachments.");
                    return;
                  }
                  if (draftContent.length > MESSAGE_MAX_LENGTH) {
                    toast.error(`Message must be ${MESSAGE_MAX_LENGTH} characters or fewer.`);
                    return;
                  }
                  onSaveEdit(message.id, draftContent);
                }}
                disabled={isEditPending}
              >
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraftContent(message.content);
                  onCancelEdit();
                }}
                disabled={isEditPending}
              >
                Cancel
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Enter to save, Shift+Enter for newline, Esc to cancel
              </span>
            </div>
          </div>
        ) : renderedContent ? (
          <p
            className={`whitespace-pre-wrap break-words ${groupedWithPrevious ? "" : "mt-1"} ${compactMode ? "text-xs" : "text-sm"}`}
          >
            {renderedContent}
          </p>
        ) : null}
        <AttachmentList attachments={message.attachments} />

        {canStartEditing || canShowDeleteAction ? (
          <div className="pointer-events-none absolute -right-1 top-0 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <div className="pointer-events-auto flex items-center rounded-md border bg-card shadow-sm">
              {canStartEditing ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Edit message"
                  onClick={() => onStartEdit(message.id)}
                >
                  <Pencil className="size-4" />
                </Button>
              ) : null}
              {canShowDeleteAction ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete message"
                  disabled={isDeleting || isEditPending}
                  onClick={() => onDeleteMessage(message.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default MessageItem;
