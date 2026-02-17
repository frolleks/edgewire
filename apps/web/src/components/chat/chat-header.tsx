import { Button } from "@/components/ui/button";

type ChatHeaderProps = {
  routeMode: "dm" | "guild";
  channelName: string | null;
  dmUsername?: string;
  canCreateInvite: boolean;
  onCreateInvite: () => void;
};

export function ChatHeader({
  routeMode,
  channelName,
  dmUsername,
  canCreateInvite,
  onCreateInvite,
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
      {canCreateInvite && (
        <Button variant="outline" size="sm" onClick={onCreateInvite}>
          Create Invite
        </Button>
      )}
    </header>
  );
}

export default ChatHeader;
