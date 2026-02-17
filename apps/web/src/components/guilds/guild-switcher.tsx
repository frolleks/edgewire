import { Home, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import type { AppRoute } from "@/app/types";
import type { Guild } from "@/lib/api";
import { Button } from "@/components/ui/button";

type GuildSwitcherProps = {
  route: AppRoute;
  guilds: Guild[];
  guildBadges: Map<string, { unread_count: number; mention_count: number }>;
  onCreateGuild: () => void;
};

export function GuildSwitcher({ route, guilds, guildBadges, onCreateGuild }: GuildSwitcherProps) {
  return (
    <aside className="border-r bg-card flex flex-col items-center py-3 gap-3">
      <Button
        asChild
        size="icon"
        variant={route.mode === "dm" ? "secondary" : "ghost"}
      >
        <Link to="/app/channels/@me" aria-label="Direct Messages">
          <Home />
        </Link>
      </Button>

      <div className="h-px w-8 bg-border" />

      <div className="flex-1 w-full space-y-2 overflow-y-auto px-2">
        {guilds.map((guild) => {
          const active = route.mode === "guild" && route.guildId === guild.id;
          const badge = guildBadges.get(guild.id);
          const mentionCount = badge?.mention_count ?? 0;
          const unreadCount = badge?.unread_count ?? 0;
          return (
            <div key={guild.id} className="relative mx-auto w-fit">
              <Button
                asChild
                size="icon"
                variant={active ? "secondary" : "ghost"}
                className="mx-auto rounded-full"
              >
                <Link to={`/app/channels/${guild.id}`} aria-label={guild.name}>
                  {guild.name.slice(0, 1).toUpperCase()}
                </Link>
              </Button>
              {mentionCount > 0 ? (
                <span className="absolute -right-1.5 -top-1 min-w-5 rounded-full bg-destructive px-1.5 py-0.5 text-center text-[10px] font-semibold text-destructive-foreground">
                  {mentionCount > 99 ? "99+" : mentionCount}
                </span>
              ) : unreadCount > 0 ? (
                <span className="absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full bg-primary" />
              ) : null}
            </div>
          );
        })}
      </div>

      <Button
        size="icon"
        variant="outline"
        onClick={onCreateGuild}
        aria-label="Create Guild"
      >
        <Plus />
      </Button>
    </aside>
  );
}

export default GuildSwitcher;
