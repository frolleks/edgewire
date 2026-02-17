import type { GuildChannelPayload } from "@discord/types";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  channelBadges: Map<string, { unread_count: number; mention_count: number }>;
  activeChannelId: string | null;
  canManageGuild: boolean;
  canLeaveGuild: boolean;
  isLeavingGuild: boolean;
  canManageChannels: boolean;
  onOpenSettings: () => void;
  onLeaveGuild: () => void;
  onOpenChannel: (channelId: string) => void;
  onCreateCategory: () => void;
  onCreateChannel: (parentId: string | null) => void;
  onReorder: (payload: ReorderPayloadItem[]) => Promise<void>;
};

export function GuildSidebar({
  guildId,
  activeGuild,
  channels,
  channelBadges,
  activeChannelId,
  canManageGuild,
  canLeaveGuild,
  isLeavingGuild,
  canManageChannels,
  onOpenSettings,
  onLeaveGuild,
  onOpenChannel,
  onCreateCategory,
  onCreateChannel,
  onReorder,
}: GuildSidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current) {
        return;
      }
      if (event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };

    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
  }, [guildId]);

  const hasMenuItems = canManageGuild || canLeaveGuild;

  return (
    <>
      <div className="relative h-14 shrink-0 border-b px-4 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold truncate">{activeGuild?.name ?? "Guild"}</p>
        </div>
        {hasMenuItems ? (
          <div className="relative" ref={menuRef}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <ChevronDown className="size-4" />
            </Button>
            {menuOpen ? (
              <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border bg-popover p-1 shadow-md">
                {canManageGuild ? (
                  <button
                    type="button"
                    className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenSettings();
                    }}
                  >
                    Server Settings
                  </button>
                ) : null}
                {canLeaveGuild ? (
                  <button
                    type="button"
                    disabled={isLeavingGuild}
                    className="w-full rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent disabled:opacity-50"
                    onClick={() => {
                      setMenuOpen(false);
                      onLeaveGuild();
                    }}
                  >
                    {isLeavingGuild ? "Leaving..." : "Leave Server"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <GuildChannelTree
        guildId={guildId ?? ""}
        channels={channels}
        channelBadges={channelBadges}
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
