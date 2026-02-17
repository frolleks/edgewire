import { Phone, Users } from "lucide-react";
import { Button } from "@/components/ui/button";

type ChatHeaderProps = {
  routeMode: "dm" | "guild";
  channelName: string | null;
  dmUsername?: string;
  canCreateInvite: boolean;
  onCreateInvite: () => void;
  onCall?: () => void;
  showMembersToggle?: boolean;
  onToggleMembers?: () => void;
};

export function ChatHeader({
  routeMode,
  channelName,
  dmUsername,
  canCreateInvite,
  onCreateInvite,
  onCall,
  showMembersToggle,
  onToggleMembers,
}: ChatHeaderProps) {
  return (
    <header className="h-14 shrink-0 border-b px-4 flex items-center justify-between bg-card">
      <div className="min-w-0">
        <h2 className="font-semibold truncate">
          {routeMode === "dm" ? channelName : `# ${channelName ?? "channel"}`}
        </h2>
        {routeMode === "dm" && dmUsername ? (
          <p className="text-xs truncate">@{dmUsername}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {showMembersToggle && onToggleMembers ? (
          <Button
            variant="outline"
            size="sm"
            className="xl:hidden"
            onClick={onToggleMembers}
          >
            <Users className="size-4" />
            Members
          </Button>
        ) : null}
        {canCreateInvite ? (
          <Button variant="outline" size="sm" onClick={onCreateInvite}>
            Create Invite
          </Button>
        ) : null}
        {routeMode === "dm" && onCall ? (
          <Button variant="outline" size="sm" onClick={onCall}>
            <Phone className="size-4" />
            Call
          </Button>
        ) : null}
      </div>
    </header>
  );
}

export default ChatHeader;
