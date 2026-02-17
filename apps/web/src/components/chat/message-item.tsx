import type { GuildChannelPayload, GuildRole, MessagePayload, UserSummary } from "@discord/types";
import { Trash2 } from "lucide-react";
import { useMemo } from "react";
import AttachmentList from "@/components/chat/attachments/attachment-list";
import MentionToken from "@/components/chat/mention-token";
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
  currentUserRoleIds: string[];
  guildRoles: GuildRole[];
  guildChannels: GuildChannelPayload[];
  activeGuildChannelPermissions: bigint;
  isDeleting: boolean;
  onOpenProfile: (user: UserSummary) => void;
  onDeleteMessage: (messageId: string) => void;
};

const MESSAGE_MENTION_TOKEN_REGEX = /<@!?[^\s>]+>|<@&[^\s>]+>|<#[^\s>]+>|\B@(?:everyone|here)\b/g;
const USER_MENTION_TOKEN_REGEX = /^<@!?([^\s>]+)>$/;
const ROLE_MENTION_TOKEN_REGEX = /^<@&([^\s>]+)>$/;
const CHANNEL_MENTION_TOKEN_REGEX = /^<#([^\s>]+)>$/;

export function MessageItem({
  message,
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
  const mentionsMe = Boolean(
    currentUserId &&
      (message.mentions.some((user) => user.id === currentUserId) ||
        message.mention_roles.some((roleId) => currentUserRoleIds.includes(roleId)) ||
        message.mention_everyone),
  );

  const mentionUserById = useMemo(
    () => new Map(message.mentions.map((user) => [user.id, user])),
    [message.mentions],
  );
  const roleById = useMemo(
    () => new Map(guildRoles.map((role) => [role.id, role])),
    [guildRoles],
  );
  const channelMentionById = useMemo(
    () => new Map(message.mention_channels.map((channel) => [channel.id, channel])),
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
        const roleColor = role?.color === null || role?.color === undefined
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
        const channelMention = channelId ? channelMentionById.get(channelId) : undefined;
        const guildChannel = channelId ? guildChannelById.get(channelId) : undefined;
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
  }, [guildChannelById, mentionUserById, channelMentionById, roleById, message.content, message.id, onOpenProfile]);

  return (
    <article
      className={`group relative flex ${compactMode ? "gap-2 py-1" : "gap-3"} ${
        mentionsMe ? "rounded-md border-l-2 border-primary/80 bg-accent/30 pl-2 pr-1" : ""
      }`}
    >
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
        {renderedContent ? (
          <p className={`whitespace-pre-wrap break-words mt-1 ${compactMode ? "text-xs" : "text-sm"}`}>
            {renderedContent}
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
