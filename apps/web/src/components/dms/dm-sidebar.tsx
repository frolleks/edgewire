import type { UserSummary } from "@discord/types";
import type { DmChannel } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "react-router-dom";

type DmSidebarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  usersSearchResults?: UserSummary[];
  dmChannels: DmChannel[];
  activeChannelId: string | null;
  onCreateDm: (recipientId: string) => void;
};

export function DmSidebar({
  search,
  onSearchChange,
  usersSearchResults,
  dmChannels,
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
          return (
            <Link
              key={channel.id}
              to={`/app/channels/@me/${channel.id}`}
              className={`block rounded-md px-3 py-2 transition ${active ? "bg-accent" : "hover:bg-accent"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">
                  {recipient?.display_name ?? "Unknown"}
                </span>
                {channel.unread ? (
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
