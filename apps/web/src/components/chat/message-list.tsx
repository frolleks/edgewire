import type { MessagePayload, UserSummary } from "@discord/types";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import MessageItem from "./message-item";

type MessageListProps = {
  messages: MessagePayload[];
  compactMode: boolean;
  showTimestamps: boolean;
  localePreference?: string;
  routeMode: "dm" | "guild";
  currentUserId: string | null;
  activeGuildChannelPermissions: bigint;
  typingIndicator: boolean;
  onLoadOlder: () => void;
  canLoadOlder: boolean;
  isLoadingOlder: boolean;
  deletingMessageIds: string[];
  onOpenProfile: (user: UserSummary) => void;
  onDeleteMessage: (messageId: string) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  bottomRef: RefObject<HTMLDivElement | null>;
};

export function MessageList({
  messages,
  compactMode,
  showTimestamps,
  localePreference,
  routeMode,
  currentUserId,
  activeGuildChannelPermissions,
  typingIndicator,
  onLoadOlder,
  canLoadOlder,
  isLoadingOlder,
  deletingMessageIds,
  onOpenProfile,
  onDeleteMessage,
  containerRef,
  bottomRef,
}: MessageListProps) {
  return (
    <section className="flex-1 min-h-0 overflow-hidden">
      <div
        ref={containerRef}
        className="h-full min-h-0 overflow-y-auto bg-card px-4 pt-4 pb-1"
      >
        <div className="space-y-4">
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={!canLoadOlder || isLoadingOlder}
              onClick={onLoadOlder}
            >
              {isLoadingOlder ? "Loading..." : "Load older"}
            </Button>
          </div>

          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              compactMode={compactMode}
              showTimestamps={showTimestamps}
              localePreference={localePreference}
              routeMode={routeMode}
              currentUserId={currentUserId}
              activeGuildChannelPermissions={activeGuildChannelPermissions}
              isDeleting={deletingMessageIds.includes(message.id)}
              onOpenProfile={onOpenProfile}
              onDeleteMessage={onDeleteMessage}
            />
          ))}

          {typingIndicator ? (
            <p className="text-xs italic">Someone is typing...</p>
          ) : null}
        </div>
        <div ref={bottomRef} className="h-0" />
      </div>
    </section>
  );
}

export default MessageList;
