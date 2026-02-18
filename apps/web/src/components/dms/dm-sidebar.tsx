import type { UserSummary } from "@edgewire/types";
import type { DmChannel } from "@/lib/api";
import type { PresenceMap } from "@/lib/presence";
import { presenceDotClassName } from "@/lib/presence";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "react-router-dom";

type DmSidebarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  usersSearchResults?: UserSummary[];
  dmChannels: DmChannel[];
  presences: PresenceMap;
  channelBadges: Map<string, { unread_count: number; mention_count: number }>;
  activeChannelId: string | null;
  onCreateDm: (recipientId: string) => void;
};

export function DmSidebar({
  search,
  onSearchChange,
  usersSearchResults,
  dmChannels,
  presences,
  channelBadges,
  activeChannelId,
  onCreateDm,
}: DmSidebarProps) {
  return (
    <>
      <div className="p-4 border-b">
        <Label>Start a DM</Label>
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search users"
          className="mt-2"
        />
        {usersSearchResults && search.trim().length >= 2 ? (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-md border bg-background">
            {usersSearchResults.length === 0 ? (
              <p className="px-3 py-2 text-xs">No users found.</p>
            ) : (
              usersSearchResults.map((user) => (
                <button
                  key={user.id}
                  className="w-full px-3 py-2 text-left hover:bg-accent flex items-center justify-between gap-2"
                  onClick={() => onCreateDm(user.id)}
                  type="button"
                >
                  <span className="truncate">
                    <span className="font-medium">{user.display_name}</span>
                    <span className="text-xs ml-2">@{user.username}</span>
                  </span>
                  <span className="text-xs">Message</span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>

      <div className="p-3 text-xs uppercase tracking-wide">Direct Messages</div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
        {dmChannels.map((channel) => {
          const recipient = channel.recipients[0];
          const active = activeChannelId === channel.id;
          const presenceStatus = recipient ? (presences[recipient.id] ?? recipient.presence_status ?? "offline") : "offline";
          const badge = channelBadges.get(channel.id);
          const mentionCount = badge?.mention_count ?? 0;
          const unreadCount = badge?.unread_count ?? (channel.unread ? 1 : 0);

          return (
            <Link
              key={channel.id}
              to={`/app/channels/@me/${channel.id}`}
              className={`block rounded-md px-3 py-2 transition ${active ? "bg-accent" : "hover:bg-accent"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${presenceDotClassName(presenceStatus)}`} />
                  <span className="font-medium truncate">
                    {recipient?.display_name ?? "Unknown"}
                  </span>
                </span>
                {mentionCount > 0 ? (
                  <span className="min-w-5 rounded-full bg-destructive px-1.5 py-0.5 text-center text-[10px] font-semibold text-destructive-foreground">
                    {mentionCount > 99 ? "99+" : mentionCount}
                  </span>
                ) : unreadCount > 0 ? (
                  <span className="h-2 w-2 rounded-full bg-primary" />
                ) : null}
              </div>
              <p className="text-xs truncate mt-1">
                {channel.last_message?.content ||
                  (channel.last_message && channel.last_message.attachments.length > 0
                    ? "Attachment"
                    : "No messages yet")}
              </p>
            </Link>
          );
        })}
      </div>
    </>
  );
}

export default DmSidebar;
