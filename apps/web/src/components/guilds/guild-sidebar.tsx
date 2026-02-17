import type { GuildChannelPayload } from "@discord/types";
import GuildChannelTree from "@/components/guild-channel-tree";
import { Button } from "@/components/ui/button";
import type { Guild } from "@/lib/api";

type ReorderPayloadItem = {
  id: string;
  position: number;
  parent_id?: string | null;
  lock_permissions?: boolean;
};

type GuildSidebarProps = {
  guildId: string | null;
  activeGuild: Guild | null;
  channels: GuildChannelPayload[];
  activeChannelId: string | null;
  canManageGuild: boolean;
  canManageChannels: boolean;
  onOpenSettings: () => void;
  onOpenChannel: (channelId: string) => void;
  onCreateCategory: () => void;
  onCreateChannel: (parentId: string | null) => void;
  onReorder: (payload: ReorderPayloadItem[]) => Promise<void>;
};

export function GuildSidebar({
  guildId,
  activeGuild,
  channels,
  activeChannelId,
  canManageGuild,
  canManageChannels,
  onOpenSettings,
  onOpenChannel,
  onCreateCategory,
  onCreateChannel,
  onReorder,
}: GuildSidebarProps) {
  return (
    <>
      <div className="p-4 border-b flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold truncate">{activeGuild?.name ?? "Guild"}</p>
        </div>
        <div className="flex items-center gap-1">
          {canManageGuild ? (
            <Button size="sm" variant="outline" onClick={onOpenSettings}>
              Settings
            </Button>
          ) : null}
        </div>
      </div>

      <GuildChannelTree
        guildId={guildId ?? ""}
        channels={channels}
        activeChannelId={activeChannelId}
        canManageChannels={canManageChannels}
        onOpenChannel={onOpenChannel}
        onCreateCategory={onCreateCategory}
        onCreateChannel={onCreateChannel}
        onReorder={onReorder}
      />
    </>
  );
}

export default GuildSidebar;
