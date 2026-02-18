import type { UserSummary } from "@edgewire/types";
import { MessageCircle } from "lucide-react";
import { memo, type MouseEvent } from "react";
import { getDisplayInitial } from "@/components/utils/format";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { GuildMemberSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type MemberStatus,
  getMemberDisplayName,
} from "./member-utils";

type MemberRowProps = {
  member: GuildMemberSummary;
  status: MemberStatus;
  topRoleColor?: number | null;
  currentUserId: string;
  onOpenProfile: (user: UserSummary) => void;
  onStartDm: (userId: string) => void | Promise<void>;
};

const statusClassMap: Record<MemberStatus, string> = {
  online: "bg-green-500",
  idle: "bg-yellow-500",
  dnd: "bg-red-500",
  offline: "bg-muted-foreground/50",
};

const colorToHex = (value: number): string =>
  `#${Math.max(0, Math.min(value, 0xffffff)).toString(16).padStart(6, "0")}`;

function MemberRowComponent({
  member,
  status,
  topRoleColor,
  currentUserId,
  onOpenProfile,
  onStartDm,
}: MemberRowProps) {
  const canMessage = member.user.id !== currentUserId;
  const displayName = getMemberDisplayName(member);

  const handleStartDm = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    void onStartDm(member.user.id);
  };

  return (
    <div className="group relative">
      <button
        type="button"
        className={cn(
          "w-full rounded-md px-2 py-2 text-left transition hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
          canMessage ? "pr-10" : "",
        )}
        onClick={() => onOpenProfile(member.user)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="relative">
            <Avatar className="h-8 w-8">
              <AvatarImage
                src={member.user.avatar_url ?? undefined}
                alt={`${displayName} avatar`}
              />
              <AvatarFallback>{getDisplayInitial(displayName)}</AvatarFallback>
            </Avatar>
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card",
                statusClassMap[status],
              )}
            />
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{displayName}</p>
            <p className="hidden truncate text-xs text-muted-foreground group-hover:block group-focus-within:block">
              @{member.user.username}
            </p>
          </div>

          {topRoleColor !== null && topRoleColor !== undefined ? (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: colorToHex(topRoleColor) }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </button>

      {canMessage ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={`Message ${displayName}`}
          title="Message"
          onClick={handleStartDm}
        >
          <MessageCircle className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

export const MemberRow = memo(MemberRowComponent);

export default MemberRow;

