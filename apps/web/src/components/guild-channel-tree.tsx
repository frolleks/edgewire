import type { GuildChannelPayload } from "@discord/types";
import { ChannelType } from "@discord/types";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, GripVertical, Loader2, Plus, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

type ChannelTreeProps = {
  guildId: string;
  channels: GuildChannelPayload[];
  channelBadges: Map<string, { unread_count: number; mention_count: number }>;
  activeChannelId: string | null;
  canManageChannels: boolean;
  onOpenChannel: (channelId: string) => void;
  onJoinVoiceChannel?: (channelId: string, channelName: string) => void;
  activeVoiceChannelId?: string | null;
  joiningVoiceChannelId?: string | null;
  voiceParticipantsByChannelId?: Record<
    string,
    Array<{ socket_id: string; id: string; display_name: string; presence_status?: string }>
  >;
  onCreateCategory: () => void;
  onCreateChannel: (parentId: string | null) => void;
  onReorder: (
    payload: Array<{
      id: string;
      position: number;
      parent_id: string | null;
      lock_permissions?: boolean;
    }>,
  ) => Promise<void>;
};

type TreeGroup = {
  category: GuildChannelPayload | null;
  channels: GuildChannelPayload[];
};

const byPositionThenId = (
  a: GuildChannelPayload,
  b: GuildChannelPayload,
): number => {
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  return a.id.localeCompare(b.id);
};

const buildGuildTree = (guildChannels: GuildChannelPayload[]): TreeGroup[] => {
  const categories = guildChannels
    .filter((channel) => channel.type === ChannelType.GUILD_CATEGORY)
    .sort(byPositionThenId);

  const textChannels = guildChannels
    .filter(
      (channel) =>
        channel.type === ChannelType.GUILD_TEXT ||
        channel.type === ChannelType.GUILD_VOICE,
    )
    .sort(byPositionThenId);

  const byParent = new Map<string | null, GuildChannelPayload[]>();
  for (const text of textChannels) {
    const key = text.parent_id ?? null;
    const existing = byParent.get(key) ?? [];
    existing.push(text);
    byParent.set(key, existing);
  }

  const result: TreeGroup[] = [];
  const ungrouped = byParent.get(null) ?? [];
  result.push({ category: null, channels: ungrouped });

  for (const category of categories) {
    result.push({
      category,
      channels: byParent.get(category.id) ?? [],
    });
  }

  return result;
};

const isCategoryId = (id: string): boolean => id.startsWith("category:");
const isChannelId = (id: string): boolean => id.startsWith("channel:");
const fromCategoryId = (id: string): string => id.replace(/^category:/, "");
const fromChannelId = (id: string): string => id.replace(/^channel:/, "");

const presenceDotClassName = (status?: string): string => {
  if (status === "online") return "bg-green-500";
  if (status === "idle") return "bg-yellow-500";
  if (status === "dnd") return "bg-red-500";
  return "bg-muted-foreground/50";
};

const DragHandle = ({
  attributes,
  listeners,
  disabled,
}: {
  attributes?: Record<string, unknown>;
  listeners?: Record<string, unknown>;
  disabled?: boolean;
}) => (
  <button
    type="button"
    className="inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-accent disabled:opacity-40"
    onClick={(event) => event.stopPropagation()}
    disabled={disabled}
    {...attributes}
    {...listeners}
    aria-label="Drag item"
  >
    <GripVertical className="h-3.5 w-3.5 opacity-60" />
  </button>
);

const SortableCategoryHeader = ({
  category,
  collapsed,
  onToggle,
  canManageChannels,
  onCreateChannel,
  children,
}: {
  category: GuildChannelPayload;
  collapsed: boolean;
  onToggle: () => void;
  canManageChannels: boolean;
  onCreateChannel: () => void;
  children: React.ReactNode;
}) => {
  const sortable = useSortable({
    id: `category:${category.id}`,
    disabled: !canManageChannels,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={`space-y-1 rounded ${sortable.isOver ? "bg-accent/50 ring-1 ring-primary/40" : ""}`}
    >
      <div className="w-full flex items-center justify-between gap-1 px-1 py-1 rounded-sm hover:bg-accent">
        <button
          type="button"
          className="w-full flex items-center gap-1 min-w-0"
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
          <span className="text-xs uppercase tracking-wide truncate">
            {category.name}
          </span>
        </button>
        <div className="flex items-center gap-1">
          <DragHandle
            attributes={
              sortable.attributes as unknown as Record<string, unknown>
            }
            listeners={sortable.listeners as Record<string, unknown>}
            disabled={!canManageChannels}
          />
          {canManageChannels ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onCreateChannel();
              }}
              aria-label={`Create channel in ${category.name}`}
            >
              <Plus />
            </Button>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  );
};

const SortableChannelRow = ({
  channel,
  badge,
  active,
  onOpen,
  onJoinVoiceChannel,
  activeVoiceChannelId,
  joiningVoiceChannelId,
  voiceParticipants,
  indent = false,
  canManageChannels,
}: {
  channel: GuildChannelPayload;
  badge?: { unread_count: number; mention_count: number };
  active: boolean;
  onOpen: () => void;
  onJoinVoiceChannel?: (channelId: string, channelName: string) => void;
  activeVoiceChannelId?: string | null;
  joiningVoiceChannelId?: string | null;
  voiceParticipants?: Array<{ socket_id: string; id: string; display_name: string; presence_status?: string }>;
  indent?: boolean;
  canManageChannels: boolean;
}) => {
  const sortable = useSortable({
    id: `channel:${channel.id}`,
    disabled: !canManageChannels,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const mentionCount = badge?.mention_count ?? 0;
  const unreadCount = badge?.unread_count ?? 0;
  const isVoice = channel.type === ChannelType.GUILD_VOICE;
  const isVoiceConnected = isVoice && activeVoiceChannelId === channel.id;
  const isVoiceJoining = isVoice && joiningVoiceChannelId === channel.id && !isVoiceConnected;
  const uniqueVoiceParticipants = voiceParticipants
    ? [...new Map(voiceParticipants.map((participant) => [participant.id, participant])).values()]
    : [];

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={`w-full rounded-md px-2 py-1.5 ${
        active ? "bg-accent" : "hover:bg-accent"
      } ${sortable.isOver ? "ring-1 ring-primary" : ""}`}
    >
      <div className="w-full flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            if (isVoice && onJoinVoiceChannel) {
              onJoinVoiceChannel(channel.id, channel.name);
              return;
            }
            onOpen();
          }}
          className="min-w-0 flex flex-1 items-center gap-2 text-left"
        >
          <span>
            {isVoice ? (
              isVoiceJoining ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )
            ) : (
              "#"
            )}
          </span>
          <span className="truncate">{channel.name}</span>
        </button>
        {mentionCount > 0 ? (
          <span className="min-w-5 rounded-full bg-destructive px-1.5 py-0.5 text-center text-[10px] font-semibold text-destructive-foreground">
            {mentionCount > 99 ? "99+" : mentionCount}
          </span>
        ) : unreadCount > 0 ? (
          <span className="h-2 w-2 rounded-full bg-primary" />
        ) : null}
        <DragHandle
          attributes={sortable.attributes as unknown as Record<string, unknown>}
          listeners={sortable.listeners as Record<string, unknown>}
          disabled={!canManageChannels}
        />
      </div>
      {isVoice && uniqueVoiceParticipants.length > 0 ? (
        <div className="pt-1 pl-5 text-xs text-muted-foreground flex flex-wrap gap-x-2 gap-y-1">
          {uniqueVoiceParticipants.map((participant) => (
            <span key={participant.socket_id} className="inline-flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${presenceDotClassName(participant.presence_status)}`} />
              <span className="truncate">{participant.display_name}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const applyCategoryReorder = (
  channels: GuildChannelPayload[],
  activeCategoryId: string,
  overCategoryId: string,
): GuildChannelPayload[] => {
  const categories = channels
    .filter((channel) => channel.type === ChannelType.GUILD_CATEGORY)
    .sort(byPositionThenId);

  const fromIndex = categories.findIndex(
    (category) => category.id === activeCategoryId,
  );
  const toIndex = categories.findIndex(
    (category) => category.id === overCategoryId,
  );
  if (fromIndex === -1 || toIndex === -1) {
    return channels;
  }

  const reordered = arrayMove(categories, fromIndex, toIndex).map(
    (category, index) => ({
      ...category,
      position: index,
    }),
  );

  const byId = new Map(reordered.map((category) => [category.id, category]));
  return channels.map((channel) => {
    if (channel.type !== ChannelType.GUILD_CATEGORY) {
      return channel;
    }
    return byId.get(channel.id) ?? channel;
  });
};

const applyChannelMove = (
  channels: GuildChannelPayload[],
  activeChannelId: string,
  overId: string,
): GuildChannelPayload[] => {
  const activeChannel = channels.find(
    (channel) =>
      channel.id === activeChannelId &&
      (channel.type === ChannelType.GUILD_TEXT ||
        channel.type === ChannelType.GUILD_VOICE),
  );
  if (!activeChannel) {
    return channels;
  }

  let targetParentId: string | null = activeChannel.parent_id;
  let targetIndex = -1;

  if (isChannelId(overId)) {
    const overChannel = channels.find(
      (channel) =>
        channel.id === fromChannelId(overId) &&
        (channel.type === ChannelType.GUILD_TEXT ||
          channel.type === ChannelType.GUILD_VOICE),
    );
    if (!overChannel) {
      return channels;
    }
    targetParentId = overChannel.parent_id;
    const siblings = channels
      .filter(
        (channel) =>
          (channel.type === ChannelType.GUILD_TEXT ||
            channel.type === ChannelType.GUILD_VOICE) &&
          channel.parent_id === targetParentId &&
          channel.id !== activeChannel.id,
      )
      .sort(byPositionThenId);
    targetIndex = siblings.findIndex(
      (channel) => channel.id === overChannel.id,
    );
  } else if (isCategoryId(overId)) {
    targetParentId = fromCategoryId(overId);
  } else if (overId === "uncategorized") {
    targetParentId = null;
  }

  const siblings = channels
    .filter(
      (channel) =>
        (channel.type === ChannelType.GUILD_TEXT ||
          channel.type === ChannelType.GUILD_VOICE) &&
        channel.parent_id === targetParentId &&
        channel.id !== activeChannel.id,
    )
    .sort(byPositionThenId);

  if (targetIndex < 0) {
    targetIndex = siblings.length;
  }

  const nextSiblings = [...siblings];
  nextSiblings.splice(targetIndex, 0, {
    ...activeChannel,
    parent_id: targetParentId,
  });

  const updatedSiblingMap = new Map(
    nextSiblings.map((channel, index) => [
      channel.id,
      {
        ...channel,
        parent_id: targetParentId,
        position: index,
      },
    ]),
  );

  const currentParentSiblings = channels
    .filter(
      (channel) =>
        (channel.type === ChannelType.GUILD_TEXT ||
          channel.type === ChannelType.GUILD_VOICE) &&
        channel.parent_id === activeChannel.parent_id &&
        channel.id !== activeChannel.id &&
        channel.parent_id !== targetParentId,
    )
    .sort(byPositionThenId)
    .map((channel, index) => ({ ...channel, position: index }));

  const currentParentMap = new Map(
    currentParentSiblings.map((channel) => [channel.id, channel]),
  );

  return channels.map((channel) => {
    if (
      channel.type !== ChannelType.GUILD_TEXT &&
      channel.type !== ChannelType.GUILD_VOICE
    ) {
      return channel;
    }

    if (updatedSiblingMap.has(channel.id)) {
      return updatedSiblingMap.get(channel.id)!;
    }

    if (currentParentMap.has(channel.id)) {
      return currentParentMap.get(channel.id)!;
    }

    return channel;
  });
};

const toBulkPayload = (channels: GuildChannelPayload[]) =>
  channels
    .filter(
      (channel) =>
        channel.type === ChannelType.GUILD_TEXT ||
        channel.type === ChannelType.GUILD_VOICE ||
        channel.type === ChannelType.GUILD_CATEGORY,
    )
    .map((channel) => ({
      id: channel.id,
      position: channel.position,
      parent_id: channel.parent_id,
    }));

export const GuildChannelTree = ({
  guildId,
  channels,
  channelBadges,
  activeChannelId,
  canManageChannels,
  onOpenChannel,
  onJoinVoiceChannel,
  activeVoiceChannelId,
  joiningVoiceChannelId,
  voiceParticipantsByChannelId,
  onCreateCategory,
  onCreateChannel,
  onReorder,
}: ChannelTreeProps) => {
  const [localChannels, setLocalChannels] = useState(channels);
  const [collapsedCategories, setCollapsedCategories] = useState<
    Record<string, boolean>
  >({});
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    setLocalChannels(channels);
  }, [channels]);

  useEffect(() => {
    if (!createMenu) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setCreateMenu(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [createMenu]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const tree = useMemo(() => buildGuildTree(localChannels), [localChannels]);
  const uncategorizedDrop = useDroppable({ id: "uncategorized" });

  const categoryIds = tree
    .filter((group) => group.category)
    .map((group) => `category:${group.category!.id}`);
  const uncategorizedIds =
    tree
      .find((group) => group.category === null)
      ?.channels.map((channel) => `channel:${channel.id}`) ?? [];

  const handleDragEnd = async (event: DragEndEvent): Promise<void> => {
    if (!canManageChannels) {
      return;
    }

    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const activeId = String(active.id);
    const overId = String(over.id);

    let nextChannels = localChannels;

    if (isCategoryId(activeId) && isCategoryId(overId)) {
      nextChannels = applyCategoryReorder(
        localChannels,
        fromCategoryId(activeId),
        fromCategoryId(overId),
      );
    } else if (isChannelId(activeId)) {
      nextChannels = applyChannelMove(
        localChannels,
        fromChannelId(activeId),
        overId,
      );
    }

    if (nextChannels === localChannels) {
      return;
    }

    setLocalChannels(nextChannels);
    await onReorder(toBulkPayload(nextChannels));
  };

  return (
    <div
      className="flex-1 overflow-y-auto px-2 pb-2 pt-2 space-y-2"
      data-guild-id={guildId}
      onContextMenu={(event) => {
        if (!canManageChannels) {
          return;
        }

        event.preventDefault();
        const menuWidth = 196;
        const menuHeight = 92;
        const x = Math.max(
          8,
          Math.min(event.clientX, window.innerWidth - menuWidth - 8),
        );
        const y = Math.max(
          8,
          Math.min(event.clientY, window.innerHeight - menuHeight - 8),
        );
        setCreateMenu({ x, y });
      }}
    >
      <div className="px-2">
        <p className="text-xs uppercase tracking-wide">Channels</p>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={categoryIds}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            <SortableContext
              items={["uncategorized", ...uncategorizedIds]}
              strategy={verticalListSortingStrategy}
            >
              <div
                ref={uncategorizedDrop.setNodeRef}
                id="uncategorized"
                className={`space-y-1 rounded-sm ${
                  uncategorizedDrop.isOver
                    ? "ring-1 ring-primary/50 bg-accent/30"
                    : ""
                }`}
              >
                {tree
                  .find((group) => group.category === null)
                  ?.channels.map((channel) => (
                    <SortableChannelRow
                      key={channel.id}
                      channel={channel}
                      badge={channelBadges.get(channel.id)}
                      active={activeChannelId === channel.id}
                      onOpen={() => onOpenChannel(channel.id)}
                      onJoinVoiceChannel={onJoinVoiceChannel}
                      activeVoiceChannelId={activeVoiceChannelId}
                      joiningVoiceChannelId={joiningVoiceChannelId}
                      voiceParticipants={voiceParticipantsByChannelId?.[channel.id]}
                      canManageChannels={canManageChannels}
                    />
                  ))}
              </div>
            </SortableContext>

            {tree
              .filter((group) => group.category)
              .map((group) => {
                const category = group.category!;
                const collapsed = Boolean(collapsedCategories[category.id]);
                const childIds = group.channels.map(
                  (channel) => `channel:${channel.id}`,
                );

                return (
                  <SortableCategoryHeader
                    key={category.id}
                    category={category}
                    collapsed={collapsed}
                    canManageChannels={canManageChannels}
                    onToggle={() =>
                      setCollapsedCategories((previous) => ({
                        ...previous,
                        [category.id]: !Boolean(previous[category.id]),
                      }))
                    }
                    onCreateChannel={() => onCreateChannel(category.id)}
                  >
                    {!collapsed ? (
                      <SortableContext
                        items={childIds}
                        strategy={verticalListSortingStrategy}
                      >
                        <div
                          className="space-y-1"
                          id={`category:${category.id}`}
                        >
                          {group.channels.map((channel) => (
                            <SortableChannelRow
                              key={channel.id}
                              channel={channel}
                              badge={channelBadges.get(channel.id)}
                              active={activeChannelId === channel.id}
                              onOpen={() => onOpenChannel(channel.id)}
                              onJoinVoiceChannel={onJoinVoiceChannel}
                              activeVoiceChannelId={activeVoiceChannelId}
                              joiningVoiceChannelId={joiningVoiceChannelId}
                              voiceParticipants={voiceParticipantsByChannelId?.[channel.id]}
                              indent
                              canManageChannels={canManageChannels}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    ) : null}
                  </SortableCategoryHeader>
                );
              })}
          </div>
        </SortableContext>
      </DndContext>

      {channels.length === 0 ? (
        <p className="px-2 text-sm">No channels yet.</p>
      ) : null}
      {canManageChannels ? (
        <p className="px-2 text-[11px]">
          Right-click to create channels. Drag channels to reorder or move
          between categories.
        </p>
      ) : null}

      {createMenu && canManageChannels ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label="Close channel creation menu"
            onClick={() => setCreateMenu(null)}
            onContextMenu={(event) => event.preventDefault()}
          />
          <div
            role="menu"
            aria-label="Create channel menu"
            className="fixed z-50 w-48 rounded-md border bg-card p-1 shadow-md"
            style={{ left: createMenu.x, top: createMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              role="menuitem"
              className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setCreateMenu(null);
                onCreateCategory();
              }}
            >
              Create Category
            </button>
            <button
              type="button"
              role="menuitem"
              className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setCreateMenu(null);
                onCreateChannel(null);
              }}
            >
              Create Text Channel
            </button>
            <button
              type="button"
              role="menuitem"
              className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setCreateMenu(null);
                onCreateChannel("voice-root");
              }}
            >
              Create Voice Channel
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
};

export default GuildChannelTree;
