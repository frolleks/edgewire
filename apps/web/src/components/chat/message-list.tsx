import type { GuildChannelPayload, GuildRole, MessagePayload, UserSummary } from "@edgewire/types";
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
  currentUserRoleIds: string[];
  guildRoles: GuildRole[];
  guildChannels: GuildChannelPayload[];
  activeGuildChannelPermissions: bigint;
  onLoadOlder: () => void;
  canLoadOlder: boolean;
  isLoadingOlder: boolean;
  deletingMessageIds: string[];
  editingMessageId: string | null;
  editingInFlightMessageId: string | null;
  onOpenProfile: (user: UserSummary) => void;
  onDeleteMessage: (messageId: string) => void;
  onStartEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (messageId: string, content: string) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  bottomRef: RefObject<HTMLDivElement | null>;
};

const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000;

const shouldGroupWithPreviousMessage = (
  previous: MessagePayload | undefined,
  current: MessagePayload,
): boolean => {
  if (!previous || previous.author.id !== current.author.id) {
    return false;
  }

  const previousTimestamp = Date.parse(previous.timestamp);
  const currentTimestamp = Date.parse(current.timestamp);
  if (Number.isNaN(previousTimestamp) || Number.isNaN(currentTimestamp)) {
    return false;
  }

  return currentTimestamp - previousTimestamp <= MESSAGE_GROUP_WINDOW_MS;
};

export function MessageList({
  messages,
  compactMode,
  showTimestamps,
  localePreference,
  routeMode,
  currentUserId,
  currentUserRoleIds,
  guildRoles,
  guildChannels,
  activeGuildChannelPermissions,
  onLoadOlder,
  canLoadOlder,
  isLoadingOlder,
  deletingMessageIds,
  editingMessageId,
  editingInFlightMessageId,
  onOpenProfile,
  onDeleteMessage,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  containerRef,
  bottomRef,
}: MessageListProps) {
  return (
    <section className="flex-1 min-h-0 overflow-hidden">
      <div
        ref={containerRef}
        className="h-full min-h-0 overflow-y-auto bg-card px-0 pt-4 pb-0"
      >
        <div>
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

          {messages.map((message, index) => {
            const previousMessage = index > 0 ? messages[index - 1] : undefined;
            const groupedWithPrevious = shouldGroupWithPreviousMessage(previousMessage, message);
            return (
              <div
                key={message.id}
                className={`${groupedWithPrevious ? "mt-0" : index === 0 ? "mt-0" : "mt-3"} mx-2`}
              >
                <MessageItem
                  message={message}
                  groupedWithPrevious={groupedWithPrevious}
                  compactMode={compactMode}
                  showTimestamps={showTimestamps}
                  localePreference={localePreference}
                  routeMode={routeMode}
                  currentUserId={currentUserId}
                  currentUserRoleIds={currentUserRoleIds}
                  guildRoles={guildRoles}
                  guildChannels={guildChannels}
                  activeGuildChannelPermissions={activeGuildChannelPermissions}
                  isDeleting={deletingMessageIds.includes(message.id)}
                  isEditing={editingMessageId === message.id}
                  isEditPending={editingInFlightMessageId === message.id}
                  editLocked={
                    (Boolean(editingMessageId) && editingMessageId !== message.id) ||
                    (Boolean(editingInFlightMessageId) && editingInFlightMessageId !== message.id)
                  }
                  onOpenProfile={onOpenProfile}
                  onDeleteMessage={onDeleteMessage}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onSaveEdit={onSaveEdit}
                />
              </div>
            );
          })}
        </div>
        <div ref={bottomRef} className="h-0" />
      </div>
    </section>
  );
}

export default MessageList;
