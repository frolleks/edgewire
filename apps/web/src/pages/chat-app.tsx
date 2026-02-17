import type {
  GuildChannelPayload,
  MessagePayload,
  UserSummary,
} from "@discord/types";
import { ChannelType } from "@discord/types";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { Cog, X } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { ComposerAttachment, ProfileDialogState } from "@/app/types";
import ChatHeader from "@/components/chat/chat-header";
import Composer from "@/components/chat/composer";
import MessageList from "@/components/chat/message-list";
import DmSidebar from "@/components/dms/dm-sidebar";
import { getSessionUser } from "@/components/auth/session";
import CreateChannelModal from "@/components/guilds/create-channel-modal";
import CreateGuildModal from "@/components/guilds/create-guild-modal";
import GuildSidebar from "@/components/guilds/guild-sidebar";
import GuildSwitcher from "@/components/guilds/guild-switcher";
import InviteModal from "@/components/guilds/invite-modal";
import AppShell from "@/components/layout/app-shell";
import ProfileDialog from "@/components/profile/profile-dialog";
import ProfileSettingsModal from "@/components/profile/profile-settings-modal";
import GuildSettingsModal from "@/components/guild-settings-modal";
import MemberList from "@/components/members/member-list";
import { getDisplayInitial } from "@/components/utils/format";
import { applyChannelBulkPatch } from "@/components/utils/channel-patch";
import { dedupeById, dedupeChronological } from "@/components/utils/dedupe";
import { parseRoute } from "@/components/utils/route";
import { byPositionThenId, roleSortDesc } from "@/components/utils/sort";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";
import { authClient } from "@/lib/auth-client";
import {
  api,
  type CurrentUser,
  type DmChannel,
  type Guild,
  type Invite,
  type Role,
  type TypingEvent,
} from "@/lib/api";
import { ApiError } from "@/lib/http";
import {
  PermissionBits,
  computeChannelPermissions,
  hasPermission,
  parsePermissions,
} from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import {
  completeUpload,
  initAttachmentUpload,
  initAvatarUpload,
  putToS3,
  runUploadsWithLimit,
} from "@/lib/uploads";
import { syncDocumentTheme } from "@/lib/theme";

type ReorderPayloadItem = {
  id: string;
  position: number;
  parent_id?: string | null;
  lock_permissions?: boolean;
};

const removeMessageFromInfinite = (
  current: InfiniteData<MessagePayload[]> | undefined,
  messageId: string,
): InfiniteData<MessagePayload[]> | undefined => {
  if (!current) {
    return current;
  }

  return {
    ...current,
    pages: current.pages.map((page) => page.filter((item) => item.id !== messageId)),
  };
};

export function ChatApp() {
  const session = authClient.useSession();
  const sessionUser = getSessionUser(session.data);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const route = useMemo(
    () => parseRoute(location.pathname),
    [location.pathname],
  );

  const [search, setSearch] = useState("");
  const [composerValue, setComposerValue] = useState("");
  const [createGuildOpen, setCreateGuildOpen] = useState(false);
  const [createGuildName, setCreateGuildName] = useState("");
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [createChannelType, setCreateChannelType] = useState<"0" | "4">("0");
  const [createChannelName, setCreateChannelName] = useState("");
  const [createChannelParentId, setCreateChannelParentId] =
    useState<string>("none");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<Invite | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileDialog, setProfileDialog] = useState<ProfileDialogState | null>(
    null,
  );
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);
  const [composerAttachments, setComposerAttachments] = useState<
    ComposerAttachment[]
  >([]);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [deletingMessageIds, setDeletingMessageIds] = useState<string[]>([]);
  const [mobileMembersOpen, setMobileMembersOpen] = useState(false);

  const typingThrottleRef = useRef(0);
  const messageListContainerRef = useRef<HTMLDivElement>(null);
  const listBottomRef = useRef<HTMLDivElement>(null);

  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: api.getMe,
    enabled: Boolean(sessionUser?.id),
  });

  const dmChannelsQuery = useQuery({
    queryKey: queryKeys.dmChannels,
    queryFn: api.listDmChannels,
    enabled: Boolean(sessionUser?.id),
  });

  const guildsQuery = useQuery({
    queryKey: queryKeys.guilds,
    queryFn: api.listGuilds,
    enabled: Boolean(sessionUser?.id),
  });

  const guildChannelsQuery = useQuery({
    queryKey: queryKeys.guildChannels(route.guildId ?? "none"),
    queryFn: () => api.listGuildChannels(route.guildId!),
    enabled: route.mode === "guild" && Boolean(route.guildId),
  });

  const guildPermissionsQuery = useQuery({
    queryKey: queryKeys.guildPermissions(route.guildId ?? "none"),
    queryFn: () => api.getMyGuildPermissions(route.guildId!),
    enabled: route.mode === "guild" && Boolean(route.guildId),
  });

  const profileMemberQuery = useQuery({
    queryKey: queryKeys.guildMember(
      profileDialog?.guildId ?? "none",
      profileDialog?.user.id ?? "none",
    ),
    queryFn: () =>
      api.getGuildMember(profileDialog!.guildId!, profileDialog!.user.id),
    enabled: Boolean(profileDialog?.guildId && profileDialog?.user.id),
  });

  const profileRolesQuery = useQuery({
    queryKey: queryKeys.guildRoles(profileDialog?.guildId ?? "none"),
    queryFn: () => api.listGuildRoles(profileDialog!.guildId!),
    enabled: Boolean(profileDialog?.guildId),
  });

  const usersSearchQuery = useQuery({
    queryKey: queryKeys.usersSearch(search),
    queryFn: () => api.searchUsers(search),
    enabled: search.trim().length >= 2,
  });

  const dmChannels = useMemo(
    () => dedupeById(dmChannelsQuery.data ?? []),
    [dmChannelsQuery.data],
  );
  const guilds = useMemo(
    () => dedupeById(guildsQuery.data ?? []),
    [guildsQuery.data],
  );
  const guildChannels = useMemo(
    () => dedupeById(guildChannelsQuery.data ?? []).sort(byPositionThenId),
    [guildChannelsQuery.data],
  );
  const guildPermissions = parsePermissions(
    guildPermissionsQuery.data?.permissions,
  );
  const myGuildRoleIds = guildPermissionsQuery.data?.role_ids ?? [];
  const hasGuildPermission = (bit: bigint): boolean =>
    hasPermission(guildPermissions, PermissionBits.ADMINISTRATOR) ||
    hasPermission(guildPermissions, bit);

  const activeDm =
    route.mode === "dm"
      ? (dmChannels.find((channel) => channel.id === route.channelId) ?? null)
      : null;

  const activeGuild =
    route.mode === "guild"
      ? (guilds.find((guild) => guild.id === route.guildId) ?? null)
      : null;

  const activeGuildChannel =
    route.mode === "guild"
      ? (guildChannels.find((channel) => channel.id === route.channelId) ??
        null)
      : null;

  const isGuildTextChannel =
    route.mode === "guild" &&
    Boolean(route.guildId) &&
    activeGuildChannel?.type === ChannelType.GUILD_TEXT;

  const activeMessageChannelId =
    route.mode === "dm"
      ? (activeDm?.id ?? null)
      : isGuildTextChannel
        ? activeGuildChannel.id
        : null;

  const activeChannelName =
    route.mode === "dm"
      ? (activeDm?.recipients[0]?.display_name ?? null)
      : (activeGuildChannel?.name ?? null);

  const canManageGuild =
    route.mode === "guild" && hasGuildPermission(PermissionBits.MANAGE_GUILD);
  const canManageRoles =
    route.mode === "guild" && hasGuildPermission(PermissionBits.MANAGE_ROLES);
  const canManageChannels =
    route.mode === "guild" &&
    hasGuildPermission(PermissionBits.MANAGE_CHANNELS);

  useGateway({
    enabled: Boolean(sessionUser?.id),
    userId: sessionUser?.id ?? null,
    activeChannelId: activeMessageChannelId,
  });

  const messagesQuery = useInfiniteQuery({
    queryKey: queryKeys.messages(activeMessageChannelId ?? "none"),
    queryFn: ({ pageParam }) =>
      api.listMessages(
        activeMessageChannelId!,
        pageParam ? String(pageParam) : undefined,
        50,
      ),
    enabled: Boolean(activeMessageChannelId),
    initialPageParam: "",
    getNextPageParam: (lastPage) => {
      if (lastPage.length === 0) {
        return undefined;
      }

      return lastPage[lastPage.length - 1]?.id;
    },
  });

  const typingQuery = useQuery({
    queryKey: activeMessageChannelId
      ? queryKeys.typing(activeMessageChannelId)
      : ["typing", "none"],
    queryFn: async () => [] as TypingEvent[],
    enabled: false,
    initialData: [] as TypingEvent[],
  });

  const createDmMutation = useMutation({
    mutationFn: (recipientId: string) => api.createDmChannel(recipientId),
    onSuccess: (channel) => {
      queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, (old) => {
        const existing = old ?? [];
        if (existing.some((item) => item.id === channel.id)) {
          return existing;
        }
        return [channel, ...existing];
      });

      setSearch("");
      navigate(`/app/channels/@me/${channel.id}`);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not create DM.",
      );
    },
  });

  const createGuildMutation = useMutation({
    mutationFn: (name: string) => api.createGuild(name),
    onSuccess: (guild) => {
      queryClient.setQueryData<Guild[]>(queryKeys.guilds, (old) => {
        const existing = old ?? [];
        if (existing.some((item) => item.id === guild.id)) {
          return existing;
        }
        return [...existing, guild].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      });
      setCreateGuildOpen(false);
      setCreateGuildName("");
      navigate(`/app/channels/${guild.id}`);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not create guild.",
      );
    },
  });

  const createGuildChannelMutation = useMutation({
    mutationFn: (payload: {
      name: string;
      type: 0 | 4;
      parent_id?: string | null;
    }) => api.createGuildChannel(route.guildId!, payload),
    onSuccess: (channel) => {
      queryClient.setQueryData<GuildChannelPayload[]>(
        queryKeys.guildChannels(route.guildId!),
        (old) => {
          const existing = old ?? [];
          if (existing.some((item) => item.id === channel.id)) {
            return existing;
          }
          return [...existing, channel].sort(byPositionThenId);
        },
      );

      setCreateChannelOpen(false);
      setCreateChannelName("");
      setCreateChannelParentId("none");
      setCreateChannelType("0");

      if (channel.type === ChannelType.GUILD_TEXT) {
        navigate(`/app/channels/${channel.guild_id}/${channel.id}`);
      }
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not create channel.",
      );
    },
  });

  const reorderGuildChannelsMutation = useMutation({
    mutationFn: (payload: ReorderPayloadItem[]) =>
      api.reorderGuildChannels(route.guildId!, payload),
    onMutate: async (payload) => {
      if (!route.guildId) {
        return { previous: undefined as GuildChannelPayload[] | undefined };
      }

      await queryClient.cancelQueries({
        queryKey: queryKeys.guildChannels(route.guildId),
      });
      const previous = queryClient.getQueryData<GuildChannelPayload[]>(
        queryKeys.guildChannels(route.guildId),
      );
      if (previous) {
        queryClient.setQueryData<GuildChannelPayload[]>(
          queryKeys.guildChannels(route.guildId),
          applyChannelBulkPatch(previous, payload),
        );
      }
      return { previous };
    },
    onError: (error, _payload, context) => {
      if (route.guildId && context?.previous) {
        queryClient.setQueryData<GuildChannelPayload[]>(
          queryKeys.guildChannels(route.guildId),
          context.previous,
        );
      }
      toast.error(
        error instanceof Error ? error.message : "Could not reorder channels.",
      );
    },
    onSuccess: (channels) => {
      if (!route.guildId) {
        return;
      }
      queryClient.setQueryData<GuildChannelPayload[]>(
        queryKeys.guildChannels(route.guildId),
        channels.sort(byPositionThenId),
      );
    },
  });

  const createInviteMutation = useMutation({
    mutationFn: (channelId: string) => api.createInvite(channelId, {}),
    onSuccess: (invite) => {
      setInviteResult(invite);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not create invite.",
      );
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: (payload: {
      channelId: string;
      content?: string;
      attachmentUploadIds?: string[];
    }) =>
      api.createMessage(payload.channelId, {
        content: payload.content,
        attachment_upload_ids: payload.attachmentUploadIds,
      }),
    onSuccess: (message) => {
      queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
        queryKeys.messages(message.channel_id),
        (old) => {
          if (!old) {
            return {
              pages: [[message]],
              pageParams: [undefined],
            };
          }
          if (
            old.pages.some((page) =>
              page.some((item) => item.id === message.id),
            )
          ) {
            return old;
          }
          return {
            ...old,
            pages: [[message, ...(old.pages[0] ?? [])], ...old.pages.slice(1)],
          };
        },
      );

      if (message.guild_id === null) {
        queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, (old) => {
          const existing = old ?? [];
          const index = existing.findIndex(
            (channel) => channel.id === message.channel_id,
          );
          if (index === -1) {
            return existing;
          }
          const next = [...existing];
          const currentChannel = next[index];
          if (!currentChannel) {
            return existing;
          }
          const updatedChannel: DmChannel = {
            ...currentChannel,
            last_message: message,
            last_message_id: message.id,
            unread: false,
          };
          return [updatedChannel, ...next.filter((_, i) => i !== index)];
        });
      }
    },
  });

  const deleteMessageMutation = useMutation({
    mutationFn: (payload: { channelId: string; messageId: string }) =>
      api.deleteMessage(payload.channelId, payload.messageId),
    onMutate: async ({ channelId, messageId }) => {
      setDeletingMessageIds((old) =>
        old.includes(messageId) ? old : [...old, messageId],
      );

      await queryClient.cancelQueries({
        queryKey: queryKeys.messages(channelId),
      });

      const previousMessages = queryClient.getQueryData<InfiniteData<MessagePayload[]>>(
        queryKeys.messages(channelId),
      );
      const previousDmChannels = queryClient.getQueryData<DmChannel[]>(
        queryKeys.dmChannels,
      );

      queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
        queryKeys.messages(channelId),
        (old) => removeMessageFromInfinite(old, messageId),
      );

      if (
        (previousDmChannels ?? []).some(
          (channel) => channel.id === channelId && channel.last_message_id === messageId,
        )
      ) {
        queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, (old) =>
          (old ?? []).map((channel) =>
            channel.id === channelId && channel.last_message_id === messageId
              ? { ...channel, last_message: null, last_message_id: null }
              : channel,
          ),
        );
      }
      const shouldRefreshDmPreview = (previousDmChannels ?? []).some(
        (channel) => channel.id === channelId && channel.last_message_id === messageId,
      );

      return {
        channelId,
        messageId,
        previousMessages,
        previousDmChannels,
        shouldRefreshDmPreview,
      };
    },
    onError: (error, _variables, context) => {
      if (error instanceof ApiError && error.status === 404) {
        if (context?.channelId) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.messages(context.channelId),
          });
        }
        return;
      }

      if (context?.previousMessages !== undefined) {
        queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
          queryKeys.messages(context.channelId),
          context.previousMessages,
        );
      }

      if (context?.previousDmChannels !== undefined) {
        queryClient.setQueryData<DmChannel[]>(
          queryKeys.dmChannels,
          context.previousDmChannels,
        );
      }

      toast.error(
        error instanceof Error ? error.message : "Could not delete message.",
      );
    },
    onSuccess: (_data, { channelId, messageId }, context) => {
      queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
        queryKeys.messages(channelId),
        (old) => removeMessageFromInfinite(old, messageId),
      );

      if (context?.shouldRefreshDmPreview) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.dmChannels });
      }
    },
    onSettled: (_data, _error, variables) => {
      setDeletingMessageIds((old) =>
        old.filter((messageId) => messageId !== variables.messageId),
      );
    },
  });

  useEffect(() => {
    if (location.pathname === "/app") {
      navigate("/app/channels/@me", { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (!isGuildTextChannel && mobileMembersOpen) {
      setMobileMembersOpen(false);
    }
  }, [isGuildTextChannel, mobileMembersOpen]);

  useEffect(() => {
    setMobileMembersOpen(false);
  }, [route.channelId, route.guildId, route.mode]);

  useEffect(() => {
    if (
      route.mode !== "guild" ||
      !route.guildId ||
      guildChannels.length === 0
    ) {
      return;
    }

    const selected = guildChannels.find(
      (channel) => channel.id === route.channelId,
    );
    const firstText = guildChannels
      .filter((channel) => channel.type === ChannelType.GUILD_TEXT)
      .sort(byPositionThenId)[0];

    if (!firstText) {
      return;
    }

    if (!selected || selected.type !== ChannelType.GUILD_TEXT) {
      navigate(`/app/channels/${route.guildId}/${firstText.id}`, {
        replace: true,
      });
    }
  }, [route, guildChannels, navigate]);

  const messagesData = messagesQuery.data as
    | InfiniteData<MessagePayload[]>
    | undefined;
  const newestMessageId = messagesData?.pages?.[0]?.[0]?.id;

  useEffect(() => {
    if (!activeMessageChannelId || !newestMessageId) {
      return;
    }

    api
      .markRead(activeMessageChannelId, newestMessageId)
      .catch(() => undefined);
  }, [activeMessageChannelId, newestMessageId]);

  useEffect(() => {
    if (!activeMessageChannelId) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      const listContainer = messageListContainerRef.current;
      if (!listContainer) {
        return;
      }
      listContainer.scrollTo({
        top: listContainer.scrollHeight,
        behavior: "auto",
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeMessageChannelId]);

  useEffect(() => {
    if (!newestMessageId) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      const listContainer = messageListContainerRef.current;
      if (!listContainer) {
        return;
      }
      listContainer.scrollTo({
        top: listContainer.scrollHeight,
        behavior: "smooth",
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [newestMessageId]);

  useEffect(() => {
    const listContainer = messageListContainerRef.current;
    if (!listContainer) {
      return;
    }

    const onLoad = (event: Event): void => {
      if (!(event.target instanceof HTMLImageElement)) {
        return;
      }

      const distanceFromBottom =
        listContainer.scrollHeight -
        (listContainer.scrollTop + listContainer.clientHeight);

      if (distanceFromBottom <= 96) {
        listContainer.scrollTo({
          top: listContainer.scrollHeight,
          behavior: "auto",
        });
      }
    };

    listContainer.addEventListener("load", onLoad, true);
    return () => {
      listContainer.removeEventListener("load", onLoad, true);
    };
  }, [activeMessageChannelId]);

  useEffect(() => {
    setComposerAttachments([]);
  }, [activeMessageChannelId]);

  const messagesNewestFirst = messagesData?.pages.flatMap((page) => page) ?? [];
  const chronologicalMessages = useMemo(
    () => dedupeChronological(messagesNewestFirst),
    [messagesNewestFirst],
  );

  const typingEvents = typingQuery.data;
  const typingUserIds = useMemo(
    () => [...new Set((typingEvents ?? []).map((event) => event.user_id))],
    [typingEvents],
  );
  const profileRoles = useMemo(() => {
    if (
      !profileDialog?.guildId ||
      !profileMemberQuery.data ||
      !profileRolesQuery.data
    ) {
      return [];
    }

    const roleById = new Map(
      profileRolesQuery.data.map((role) => [role.id, role]),
    );
    return profileMemberQuery.data.roles
      .map((roleId) => roleById.get(roleId))
      .filter((role): role is Role => Boolean(role))
      .sort(roleSortDesc);
  }, [profileDialog?.guildId, profileMemberQuery.data, profileRolesQuery.data]);

  const categoryOptions = guildChannels.filter(
    (channel) => channel.type === ChannelType.GUILD_CATEGORY,
  );
  const activeGuildChannelPermissions = useMemo(() => {
    if (
      route.mode !== "guild" ||
      !route.guildId ||
      !activeGuildChannel ||
      !sessionUser?.id
    ) {
      return guildPermissions;
    }

    return computeChannelPermissions({
      basePermissions: guildPermissions,
      overwrites: activeGuildChannel.permission_overwrites ?? [],
      memberRoleIds: myGuildRoleIds.filter(
        (roleId) => roleId !== route.guildId,
      ),
      memberUserId: sessionUser.id,
      guildId: route.guildId,
    });
  }, [
    activeGuildChannel,
    guildPermissions,
    myGuildRoleIds,
    route.guildId,
    route.mode,
    sessionUser?.id,
  ]);

  const canSendInActiveChannel =
    route.mode === "dm" ||
    (route.mode === "guild" &&
      activeGuildChannel?.type === ChannelType.GUILD_TEXT &&
      hasPermission(
        activeGuildChannelPermissions,
        PermissionBits.SEND_MESSAGES,
      ));

  const isUploadingAttachments = composerAttachments.some(
    (attachment) => attachment.status === "uploading",
  );

  const updateComposerAttachment = (
    localId: string,
    patch: Partial<ComposerAttachment>,
  ): void => {
    setComposerAttachments((old) =>
      old.map((attachment) =>
        attachment.local_id === localId
          ? {
              ...attachment,
              ...patch,
            }
          : attachment,
      ),
    );
  };

  const handleAvatarFileChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!file || isAvatarUploading) {
      return;
    }

    setIsAvatarUploading(true);
    try {
      const init = await initAvatarUpload(file);
      await putToS3(init.put_url, file, init.headers);
      const completed = await completeUpload(init.upload_id);
      if (completed.kind !== "avatar") {
        throw new Error("Unexpected avatar upload completion response.");
      }

      queryClient.setQueryData<CurrentUser>(
        queryKeys.me,
        completed.user as CurrentUser,
      );
      toast.success("Avatar updated.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update avatar.",
      );
    } finally {
      setIsAvatarUploading(false);
    }
  };

  const handleAttachmentInputChange = (
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) {
      return;
    }

    setComposerAttachments((old) => [
      ...old,
      ...files.map((file) => ({
        local_id: crypto.randomUUID(),
        file,
        filename: file.name,
        size: file.size,
        content_type: file.type || "application/octet-stream",
        status: "queued" as const,
      })),
    ]);
  };

  const removeComposerAttachment = (localId: string): void => {
    if (isSendingMessage || isUploadingAttachments) {
      return;
    }
    setComposerAttachments((old) =>
      old.filter((attachment) => attachment.local_id !== localId),
    );
  };

  const uploadComposerAttachments = async (
    channelId: string,
  ): Promise<string[]> => {
    const current = [...composerAttachments];
    const uploadIds: string[] = [];
    const pending = current.filter((attachment) => !attachment.upload_id);

    for (const attachment of current) {
      if (attachment.upload_id) {
        uploadIds.push(attachment.upload_id);
      }
    }

    const failed = new Set<string>();
    await runUploadsWithLimit(pending, async (attachment) => {
      if (!attachment.file) {
        failed.add(attachment.local_id);
        updateComposerAttachment(attachment.local_id, {
          status: "failed",
          error: "Missing local file reference.",
        });
        return;
      }

      updateComposerAttachment(attachment.local_id, {
        status: "uploading",
        error: undefined,
      });

      try {
        const init = await initAttachmentUpload(channelId, attachment.file);
        await putToS3(init.put_url, attachment.file, init.headers);
        const completed = await completeUpload(init.upload_id);
        if (completed.kind !== "attachment") {
          throw new Error("Unexpected attachment upload completion response.");
        }

        uploadIds.push(completed.upload_id);
        updateComposerAttachment(attachment.local_id, {
          status: "uploaded",
          upload_id: completed.upload_id,
          error: undefined,
        });
      } catch (error) {
        failed.add(attachment.local_id);
        updateComposerAttachment(attachment.local_id, {
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed.",
        });
      }
    });

    if (failed.size > 0) {
      throw new Error("Some attachments failed to upload.");
    }

    return [...new Set(uploadIds)];
  };

  const sendMessage = async (): Promise<void> => {
    if (
      !activeMessageChannelId ||
      !canSendInActiveChannel ||
      isSendingMessage
    ) {
      return;
    }

    const content = composerValue.trim();
    if (!content && composerAttachments.length === 0) {
      return;
    }

    setIsSendingMessage(true);
    try {
      const attachmentUploadIds = await uploadComposerAttachments(
        activeMessageChannelId,
      );
      await sendMessageMutation.mutateAsync({
        channelId: activeMessageChannelId,
        content: content || undefined,
        attachmentUploadIds:
          attachmentUploadIds.length > 0 ? attachmentUploadIds : undefined,
      });
      setComposerValue("");
      setComposerAttachments([]);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not send message.",
      );
    } finally {
      setIsSendingMessage(false);
    }
  };

  const triggerTyping = (): void => {
    if (!activeMessageChannelId) {
      return;
    }

    const ts = Date.now();
    if (ts - typingThrottleRef.current < 2_000) {
      return;
    }

    typingThrottleRef.current = ts;
    api.triggerTyping(activeMessageChannelId).catch(() => undefined);
  };

  const openProfile = (user: UserSummary): void => {
    setProfileDialog({
      user,
      guildId: route.mode === "guild" ? route.guildId : null,
    });
  };

  const openInvite = (): void => {
    if (
      !activeMessageChannelId ||
      route.mode !== "guild" ||
      !canManageChannels
    ) {
      return;
    }

    setInviteOpen(true);
    setInviteResult(null);
    createInviteMutation.mutate(activeMessageChannelId);
  };

  const submitCreateGuild = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const name = createGuildName.trim();
    if (!name) {
      return;
    }
    await createGuildMutation.mutateAsync(name);
  };

  const submitCreateChannel = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (!route.guildId) {
      return;
    }

    const name = createChannelName.trim();
    if (!name) {
      return;
    }

    const type = Number(createChannelType) as 0 | 4;
    const parentId =
      type === ChannelType.GUILD_TEXT && createChannelParentId !== "none"
        ? createChannelParentId
        : null;

    await createGuildChannelMutation.mutateAsync({
      name,
      type,
      parent_id: parentId,
    });
  };

  const me = meQuery.data as CurrentUser | undefined;
  const compactMode = me?.settings?.compact_mode ?? false;
  const showTimestamps = me?.settings?.show_timestamps ?? true;
  const localePreference = me?.settings?.locale ?? undefined;

  useEffect(() => {
    return syncDocumentTheme(me?.settings?.theme ?? "system");
  }, [me?.settings?.theme]);

  return (
    <>
      <AppShell
        className={
          isGuildTextChannel ? "xl:grid-cols-[72px_300px_1fr_260px]" : undefined
        }
      >
        <GuildSwitcher
          route={route}
          guilds={guilds}
          onCreateGuild={() => setCreateGuildOpen(true)}
        />

        <aside className="border-r bg-card flex flex-col overflow-hidden">
          {route.mode === "dm" ? (
            <DmSidebar
              search={search}
              onSearchChange={setSearch}
              usersSearchResults={usersSearchQuery.data}
              dmChannels={dmChannels}
              activeChannelId={route.channelId}
              onCreateDm={(recipientId) => createDmMutation.mutate(recipientId)}
            />
          ) : (
            <GuildSidebar
              guildId={route.guildId}
              activeGuild={activeGuild}
              channels={guildChannels}
              activeChannelId={route.channelId}
              canManageGuild={canManageGuild}
              canManageChannels={canManageChannels}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenChannel={(channelId) => {
                if (!route.guildId) {
                  return;
                }
                navigate(`/app/channels/${route.guildId}/${channelId}`);
              }}
              onCreateCategory={() => {
                setCreateChannelType("4");
                setCreateChannelParentId("none");
                setCreateChannelOpen(true);
              }}
              onCreateChannel={(parentId) => {
                setCreateChannelType("0");
                setCreateChannelParentId(parentId ?? "none");
                setCreateChannelOpen(true);
              }}
              onReorder={async (payload) => {
                if (!route.guildId) {
                  return;
                }
                await reorderGuildChannelsMutation.mutateAsync(payload);
              }}
            />
          )}

          <div className="border-t px-3 py-3 flex items-center justify-between gap-2">
            <div className="min-w-0 flex items-center gap-2">
              <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-muted grid place-items-center text-xs font-semibold uppercase">
                {me?.avatar_url ? (
                  <img
                    src={me.avatar_url}
                    alt={`${me.display_name} avatar`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  getDisplayInitial(
                    me?.display_name ?? sessionUser?.name ?? "You",
                  )
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">
                  {me?.display_name ?? sessionUser?.name ?? "You"}
                </p>
                <p className="text-xs truncate">@{me?.username ?? "loading"}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => navigate("/settings/account")}
                aria-label="Open user settings"
                title="User Settings"
              >
                <Cog className="size-4" />
              </Button>
            </div>
          </div>
        </aside>

        <main className="flex h-full min-h-0 flex-col bg-background">
          {activeMessageChannelId ? (
            <>
              <ChatHeader
                routeMode={route.mode}
                channelName={activeChannelName}
                dmUsername={activeDm?.recipients[0]?.username}
                canCreateInvite={canManageChannels && route.mode === "guild"}
                onCreateInvite={openInvite}
                showMembersToggle={isGuildTextChannel}
                onToggleMembers={() => setMobileMembersOpen(true)}
              />

              <MessageList
                messages={chronologicalMessages}
                compactMode={compactMode}
                showTimestamps={showTimestamps}
                localePreference={localePreference}
                routeMode={route.mode}
                currentUserId={me?.id ?? sessionUser?.id ?? null}
                activeGuildChannelPermissions={activeGuildChannelPermissions}
                typingIndicator={typingUserIds.length > 0}
                onLoadOlder={() => messagesQuery.fetchNextPage()}
                canLoadOlder={Boolean(messagesQuery.hasNextPage)}
                isLoadingOlder={messagesQuery.isFetchingNextPage}
                deletingMessageIds={deletingMessageIds}
                onOpenProfile={openProfile}
                onDeleteMessage={(messageId) => {
                  if (!activeMessageChannelId || deletingMessageIds.includes(messageId)) {
                    return;
                  }

                  deleteMessageMutation.mutate({
                    channelId: activeMessageChannelId,
                    messageId,
                  });
                }}
                containerRef={messageListContainerRef}
                bottomRef={listBottomRef}
              />

              <Composer
                value={composerValue}
                onValueChange={setComposerValue}
                canSendInActiveChannel={canSendInActiveChannel}
                routeMode={route.mode}
                dmUsername={activeDm?.recipients[0]?.username}
                channelName={activeGuildChannel?.name}
                attachments={composerAttachments}
                isSendingMessage={isSendingMessage}
                isSendMutationPending={sendMessageMutation.isPending}
                onAttachmentInputChange={handleAttachmentInputChange}
                onRemoveAttachment={removeComposerAttachment}
                onSend={() => {
                  void sendMessage();
                }}
                onTriggerTyping={triggerTyping}
              />
            </>
          ) : (
            <div className="h-full grid place-items-center text-center px-6">
              <div>
                <h2 className="text-xl font-semibold mb-2">No channel selected</h2>
                <p>Select a DM or a text channel from the sidebar.</p>
              </div>
            </div>
          )}
        </main>

        {isGuildTextChannel && route.guildId ? (
          <div className="hidden xl:block">
            <MemberList
              guildId={route.guildId}
              currentUserId={me?.id ?? sessionUser?.id ?? ""}
              onOpenProfile={openProfile}
              onStartDm={(userId) => createDmMutation.mutate(userId)}
              typingUserIds={typingUserIds}
            />
          </div>
        ) : null}
      </AppShell>

      {isGuildTextChannel && route.guildId && mobileMembersOpen ? (
        <div className="fixed inset-0 z-40 xl:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-background/70"
            onClick={() => setMobileMembersOpen(false)}
            aria-label="Close members panel"
          />
          <div className="absolute inset-y-0 right-0 w-[min(100vw-56px,320px)]">
            <div className="relative h-full">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-2 top-2 z-10"
                onClick={() => setMobileMembersOpen(false)}
                aria-label="Close members panel"
              >
                <X className="size-4" />
              </Button>
              <MemberList
                guildId={route.guildId}
                currentUserId={me?.id ?? sessionUser?.id ?? ""}
                onOpenProfile={(user) => {
                  setMobileMembersOpen(false);
                  openProfile(user);
                }}
                onStartDm={(userId) => {
                  setMobileMembersOpen(false);
                  createDmMutation.mutate(userId);
                }}
                typingUserIds={typingUserIds}
              />
            </div>
          </div>
        </div>
      ) : null}

      <ProfileDialog
        state={profileDialog}
        onClose={() => setProfileDialog(null)}
        roles={profileRoles}
        joinedAt={profileMemberQuery.data?.joined_at}
        isLoadingRoles={profileMemberQuery.isPending || profileRolesQuery.isPending}
        hasRolesError={profileMemberQuery.isError || profileRolesQuery.isError}
      />

      <ProfileSettingsModal
        open={profileSettingsOpen}
        onClose={() => setProfileSettingsOpen(false)}
        me={me}
        sessionUserName={sessionUser?.name}
        isUploading={isAvatarUploading}
        onPickAvatar={handleAvatarFileChange}
      />

      <CreateGuildModal
        open={createGuildOpen}
        onClose={() => setCreateGuildOpen(false)}
        name={createGuildName}
        setName={setCreateGuildName}
        onSubmit={submitCreateGuild}
        isSubmitting={createGuildMutation.isPending}
      />

      <CreateChannelModal
        open={createChannelOpen}
        onClose={() => setCreateChannelOpen(false)}
        type={createChannelType}
        setType={setCreateChannelType}
        name={createChannelName}
        setName={setCreateChannelName}
        parentId={createChannelParentId}
        setParentId={setCreateChannelParentId}
        categories={categoryOptions}
        onSubmit={submitCreateChannel}
        isSubmitting={createGuildChannelMutation.isPending}
      />

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        isGenerating={createInviteMutation.isPending}
        invite={inviteResult}
        onCopyLink={() => {
          if (!inviteResult) {
            return;
          }
          void navigator.clipboard.writeText(
            `${window.location.origin}/invite/${inviteResult.code}`,
          );
        }}
      />

      <GuildSettingsModal
        open={settingsOpen}
        guildId={route.mode === "guild" ? route.guildId : null}
        canManageGuild={canManageGuild}
        canManageRoles={canManageRoles}
        channels={guildChannels}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}

export default ChatApp;
