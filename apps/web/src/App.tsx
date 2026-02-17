import type {
  GuildChannelPayload,
  MessagePayload,
  UserSummary,
} from "@discord/types";
import { ChannelType } from "@discord/types";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { Home, Paperclip, Plus, X } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Toaster, toast } from "sonner";
import GuildChannelTree from "@/components/guild-channel-tree";
import GuildSettingsModal from "@/components/guild-settings-modal";
import UserSettingsPage from "@/components/user-settings-page";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

type SessionUser = {
  id: string;
  email?: string;
  name?: string;
  image?: string | null;
};

type AppRoute = {
  mode: "dm" | "guild";
  guildId: string | null;
  channelId: string | null;
};

type ProfileDialogState = {
  user: UserSummary;
  guildId: string | null;
};

type ComposerAttachment = {
  local_id: string;
  file: File | null;
  filename: string;
  size: number;
  content_type: string;
  status: "queued" | "uploading" | "uploaded" | "failed";
  upload_id?: string;
  error?: string;
};

const getSessionUser = (data: unknown): SessionUser | null => {
  if (!data || typeof data !== "object" || !("user" in data)) {
    return null;
  }

  const user = (data as { user?: SessionUser }).user;
  return user?.id ? user : null;
};

const parseRoute = (pathname: string): AppRoute => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "app") {
    return { mode: "dm", guildId: null, channelId: null };
  }

  if (parts[1] !== "channels") {
    return { mode: "dm", guildId: null, channelId: null };
  }

  if (parts[2] === "@me") {
    return {
      mode: "dm",
      guildId: null,
      channelId: parts[3] ?? null,
    };
  }

  if (parts[2]) {
    return {
      mode: "guild",
      guildId: parts[2],
      channelId: parts[3] ?? null,
    };
  }

  return { mode: "dm", guildId: null, channelId: null };
};

const formatTime = (timestamp: string, locale?: string): string =>
  new Date(timestamp).toLocaleTimeString(locale ? [locale] : [], {
    hour: "2-digit",
    minute: "2-digit",
  });

const formatBytes = (value: number): string => {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const getDisplayInitial = (displayName: string): string =>
  displayName.trim().slice(0, 1).toUpperCase() || "?";

const isImageAttachment = (contentType?: string | null): boolean =>
  Boolean(contentType?.startsWith("image/"));

const dedupeChronological = (messages: MessagePayload[]): MessagePayload[] => {
  const seen = new Set<string>();
  const next: MessagePayload[] = [];

  for (const item of [...messages].reverse()) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    next.push(item);
  }

  return next;
};

const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const indexById = new Map<string, number>();
  const next: T[] = [];

  for (const item of items) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, next.length);
      next.push(item);
      continue;
    }

    next[existingIndex] = item;
  }

  return next;
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

const roleSortDesc = (a: Role, b: Role): number => {
  if (a.position !== b.position) {
    return b.position - a.position;
  }
  return a.id.localeCompare(b.id);
};

const applyChannelBulkPatch = (
  channels: GuildChannelPayload[],
  payload: Array<{ id: string; position: number; parent_id?: string | null }>,
): GuildChannelPayload[] => {
  const patchById = new Map(payload.map((item) => [item.id, item]));
  return channels
    .map((channel) => {
      const patch = patchById.get(channel.id);
      if (!patch) {
        return channel;
      }

      return {
        ...channel,
        position: patch.position,
        parent_id:
          patch.parent_id === undefined
            ? channel.parent_id
            : (patch.parent_id ?? null),
      };
    })
    .sort(byPositionThenId);
};

const Modal = ({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) => {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>{title}</CardTitle>
              {description ? (
                <CardDescription className="mt-2">
                  {description}
                </CardDescription>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close dialog"
            >
              <X />
            </Button>
          </div>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
};

const ProtectedRoute = () => {
  const session = authClient.useSession();
  const sessionUser = getSessionUser(session.data);

  if (session.isPending) {
    return <div className="h-screen grid place-items-center">Loading...</div>;
  }

  if (!sessionUser) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};

const AuthPage = ({ mode }: { mode: "login" | "register" }) => {
  const navigate = useNavigate();
  const session = authClient.useSession();
  const sessionUser = getSessionUser(session.data);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (sessionUser) {
      navigate("/app/channels/@me", { replace: true });
    }
  }, [navigate, sessionUser]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setIsSubmitting(true);

    try {
      if (mode === "login") {
        const result = (await authClient.signIn.email({
          email,
          password,
        })) as { error?: { message?: string } };

        if (result?.error) {
          throw new Error(result.error.message ?? "Sign in failed.");
        }
      } else {
        const signUpResult = (await authClient.signUp.email({
          email,
          password,
          name: displayName.trim() || username,
        })) as { error?: { message?: string } };

        if (signUpResult?.error) {
          throw new Error(signUpResult.error.message ?? "Sign up failed.");
        }

        await api.updateProfile({
          username,
          display_name: displayName,
        });
      }

      navigate("/app/channels/@me", { replace: true });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Authentication failed.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-screen grid place-items-center px-4 bg-background">
      <form
        className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-sm"
        onSubmit={submit}
      >
        <h1 className="text-2xl font-semibold mb-2">
          {mode === "login" ? "Welcome Back" : "Create Account"}
        </h1>
        <p className="text-sm mb-6">
          {mode === "login"
            ? "Sign in to continue chatting."
            : "Create your account to start chatting."}
        </p>

        {mode === "register" ? (
          <>
            <Label className="mb-2 block" htmlFor="username">
              Username
            </Label>
            <Input
              id="username"
              required
              minLength={3}
              maxLength={32}
              pattern="[a-zA-Z0-9_]+"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="frolleks"
              className="mb-4"
            />

            <Label className="mb-2 block" htmlFor="display-name">
              Display Name
            </Label>
            <Input
              id="display-name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Frolleks"
              className="mb-4"
            />
          </>
        ) : null}

        <Label className="mb-2 block" htmlFor="email">
          Email
        </Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="mb-4"
        />

        <Label className="mb-2 block" htmlFor="password">
          Password
        </Label>
        <Input
          id="password"
          type="password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="********"
          className="mb-6"
        />

        <Button disabled={isSubmitting} type="submit" className="w-full">
          {isSubmitting
            ? "Please wait..."
            : mode === "login"
              ? "Sign In"
              : "Create Account"}
        </Button>

        <div className="mt-4 text-sm">
          {mode === "login" ? (
            <>
              Need an account?{" "}
              <Link className="hover:underline" to="/register">
                Register
              </Link>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <Link className="hover:underline" to="/login">
                Sign in
              </Link>
            </>
          )}
        </div>
      </form>
    </div>
  );
};

const JoinGuildPage = () => {
  const params = useParams<{ code: string }>();
  const code = params.code ?? "";
  const navigate = useNavigate();

  const inviteQuery = useQuery({
    queryKey: queryKeys.invite(code),
    queryFn: () => api.getInvite(code, true),
    enabled: Boolean(code),
  });

  const acceptMutation = useMutation({
    mutationFn: () => api.acceptInvite(code),
    onSuccess: ({ guildId, channelId }) => {
      navigate(`/app/channels/${guildId}/${channelId}`, { replace: true });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not join guild.",
      );
    },
  });

  const invite = inviteQuery.data;

  return (
    <div className="h-screen grid place-items-center p-4 bg-background">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Server Invite</CardTitle>
          <CardDescription>
            Review the invite and accept to join.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {inviteQuery.isLoading ? <p>Loading invite...</p> : null}
          {!inviteQuery.isLoading && !invite ? (
            <p>Invite not found or expired.</p>
          ) : null}
          {invite ? (
            <div className="space-y-3">
              <div>
                <p className="text-sm">Guild</p>
                <p className="font-semibold">{invite.guild.name}</p>
              </div>
              <div>
                <p className="text-sm">Channel</p>
                <p className="font-semibold">#{invite.channel.name}</p>
              </div>
              <div>
                <p className="text-sm">Inviter</p>
                <p className="font-semibold">{invite.inviter.display_name}</p>
              </div>
              {invite.approximate_member_count !== undefined ? (
                <p className="text-sm">
                  Members: {invite.approximate_member_count} · Online:{" "}
                  {invite.approximate_presence_count ?? 0}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="flex gap-2 justify-end">
          <Button
            variant="outline"
            onClick={() => navigate("/app/channels/@me")}
          >
            Home
          </Button>
          <Button
            disabled={!invite || acceptMutation.isPending}
            onClick={() => acceptMutation.mutate()}
          >
            {acceptMutation.isPending ? "Joining..." : "Accept Invite"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
};

const ChatApp = () => {
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

  const typingThrottleRef = useRef(0);
  const listBottomRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

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

  const activeMessageChannelId =
    route.mode === "dm"
      ? (activeDm?.id ?? null)
      : activeGuildChannel?.type === ChannelType.GUILD_TEXT
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
    mutationFn: (
      payload: Array<{
        id: string;
        position: number;
        parent_id?: string | null;
        lock_permissions?: boolean;
      }>,
    ) => api.reorderGuildChannels(route.guildId!, payload),
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

  useEffect(() => {
    if (location.pathname === "/app") {
      navigate("/app/channels/@me", { replace: true });
    }
  }, [location.pathname, navigate]);

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
    if (!newestMessageId) {
      return;
    }
    listBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [newestMessageId]);

  useEffect(() => {
    setComposerAttachments([]);
  }, [activeMessageChannelId]);

  const messagesNewestFirst = messagesData?.pages.flatMap((page) => page) ?? [];
  const chronologicalMessages = useMemo(
    () => dedupeChronological(messagesNewestFirst),
    [messagesNewestFirst],
  );

  const typingEvents = typingQuery.data;
  const typingUserIds = new Set(typingEvents.map((event) => event.user_id));
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

  const signOut = async (): Promise<void> => {
    await authClient.signOut();
    queryClient.clear();
    navigate("/login", { replace: true });
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
    <div className="h-screen overflow-hidden bg-background">
      <div className="h-full grid grid-cols-[72px_300px_1fr]">
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

          <div className="flex-1 w-full px-2 space-y-2 overflow-y-auto">
            {guilds.map((guild) => {
              const active =
                route.mode === "guild" && route.guildId === guild.id;
              return (
                <Button
                  key={guild.id}
                  asChild
                  size="icon"
                  variant={active ? "secondary" : "ghost"}
                  className="w-full rounded-xl"
                >
                  <Link
                    to={`/app/channels/${guild.id}`}
                    aria-label={guild.name}
                  >
                    {guild.name.slice(0, 1).toUpperCase()}
                  </Link>
                </Button>
              );
            })}
          </div>

          <Button
            size="icon"
            variant="outline"
            onClick={() => setCreateGuildOpen(true)}
            aria-label="Create Guild"
          >
            <Plus />
          </Button>
        </aside>

        <aside className="border-r bg-card flex flex-col overflow-hidden">
          {route.mode === "dm" ? (
            <>
              <div className="p-4 border-b">
                <Label>Start a DM</Label>
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search users"
                  className="mt-2"
                />
                {usersSearchQuery.data && search.trim().length >= 2 ? (
                  <div className="mt-2 max-h-40 overflow-y-auto rounded-md border bg-background">
                    {usersSearchQuery.data.length === 0 ? (
                      <p className="px-3 py-2 text-xs">No users found.</p>
                    ) : (
                      usersSearchQuery.data.map((user) => (
                        <button
                          key={user.id}
                          className="w-full px-3 py-2 text-left hover:bg-accent flex items-center justify-between gap-2"
                          onClick={() => createDmMutation.mutate(user.id)}
                          type="button"
                        >
                          <span className="truncate">
                            <span className="font-medium">
                              {user.display_name}
                            </span>
                            <span className="text-xs ml-2">
                              @{user.username}
                            </span>
                          </span>
                          <span className="text-xs">Message</span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              <div className="p-3 text-xs uppercase tracking-wide">
                Direct Messages
              </div>
              <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
                {dmChannels.map((channel) => {
                  const recipient = channel.recipients[0];
                  const active = route.channelId === channel.id;
                  return (
                    <Link
                      key={channel.id}
                      to={`/app/channels/@me/${channel.id}`}
                      className={`block rounded-md px-3 py-2 transition ${active ? "bg-accent" : "hover:bg-accent"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">
                          {recipient?.display_name ?? "Unknown"}
                        </span>
                        {channel.unread ? (
                          <span className="h-2 w-2 rounded-full bg-primary" />
                        ) : null}
                      </div>
                      <p className="text-xs truncate mt-1">
                        {channel.last_message?.content ||
                          (channel.last_message &&
                          channel.last_message.attachments.length > 0
                            ? "Attachment"
                            : "No messages yet")}
                      </p>
                    </Link>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="p-4 border-b flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">
                    {activeGuild?.name ?? "Guild"}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {canManageGuild ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSettingsOpen(true)}
                    >
                      Settings
                    </Button>
                  ) : null}
                </div>
              </div>

              <GuildChannelTree
                guildId={route.guildId ?? ""}
                channels={guildChannels}
                activeChannelId={route.channelId}
                canManageChannels={canManageChannels}
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
            </>
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
                size="sm"
                onClick={() => navigate("/settings/account")}
              >
                User Settings
              </Button>
              <Button variant="secondary" size="sm" onClick={signOut}>
                Sign out
              </Button>
            </div>
          </div>
        </aside>

        <main className="flex h-full flex-col bg-background">
          {activeMessageChannelId ? (
            <>
              <header className="h-14 border-b px-4 flex items-center justify-between bg-card">
                <div className="min-w-0">
                  <h2 className="font-semibold truncate">
                    {route.mode === "dm"
                      ? activeChannelName
                      : `# ${activeChannelName ?? "channel"}`}
                  </h2>
                  {route.mode === "dm" && activeDm?.recipients[0] ? (
                    <p className="text-xs truncate">
                      @{activeDm.recipients[0].username}
                    </p>
                  ) : null}
                </div>
                {canManageChannels && route.mode === "guild" ? (
                  <Button variant="outline" size="sm" onClick={openInvite}>
                    Create Invite
                  </Button>
                ) : null}
              </header>

              <section className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !messagesQuery.hasNextPage ||
                      messagesQuery.isFetchingNextPage
                    }
                    onClick={() => messagesQuery.fetchNextPage()}
                  >
                    {messagesQuery.isFetchingNextPage
                      ? "Loading..."
                      : "Load older"}
                  </Button>
                </div>

                {chronologicalMessages.map((message) => (
                  <article
                    key={message.id}
                    className={`flex ${compactMode ? "gap-2 py-1" : "gap-3"}`}
                  >
                    <button
                      type="button"
                      onClick={() => openProfile(message.author)}
                      className={`${compactMode ? "h-7 w-7" : "h-9 w-9"} shrink-0 overflow-hidden rounded-full bg-muted grid place-items-center text-xs font-semibold uppercase`}
                      aria-label={`Open profile for ${message.author.display_name}`}
                    >
                      {message.author.avatar_url ? (
                        <img
                          src={message.author.avatar_url}
                          alt={`${message.author.display_name} avatar`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        getDisplayInitial(message.author.display_name)
                      )}
                    </button>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-semibold ${compactMode ? "text-xs" : "text-sm"}`}
                        >
                          {message.author.display_name}
                        </span>
                        {showTimestamps ? (
                          <span className="text-xs">
                            {formatTime(message.timestamp, localePreference)}
                          </span>
                        ) : null}
                        {message.edited_timestamp ? (
                          <span className="text-[10px]">(edited)</span>
                        ) : null}
                      </div>
                      {message.content ? (
                        <p
                          className={`whitespace-pre-wrap break-words mt-1 ${compactMode ? "text-xs" : "text-sm"}`}
                        >
                          {message.content}
                        </p>
                      ) : null}
                      {message.attachments.length > 0 ? (
                        <div className="mt-2 space-y-2">
                          {message.attachments.map((attachment) =>
                            isImageAttachment(attachment.content_type) ? (
                              <a
                                key={attachment.id}
                                href={attachment.url}
                                target="_blank"
                                rel="noreferrer"
                                className="block max-w-sm overflow-hidden rounded-md border bg-card"
                              >
                                <img
                                  src={attachment.url}
                                  alt={attachment.filename}
                                  className="max-h-80 w-full object-cover"
                                  loading="lazy"
                                />
                              </a>
                            ) : (
                              <a
                                key={attachment.id}
                                href={attachment.url}
                                target="_blank"
                                rel="noreferrer"
                                className="block rounded-md border px-3 py-2 text-sm hover:bg-accent"
                              >
                                <p className="font-medium truncate">
                                  {attachment.filename}
                                </p>
                                <p className="text-xs mt-1">
                                  {formatBytes(attachment.size)}
                                  {attachment.content_type
                                    ? ` · ${attachment.content_type}`
                                    : ""}
                                </p>
                              </a>
                            ),
                          )}
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}

                {typingUserIds.size > 0 ? (
                  <p className="text-xs italic">Someone is typing...</p>
                ) : null}
                <div ref={listBottomRef} />
              </section>

              <footer className="border-t p-4 bg-card">
                <Textarea
                  value={composerValue}
                  onChange={(event) => {
                    setComposerValue(event.target.value);
                    triggerTyping();
                  }}
                  disabled={!canSendInActiveChannel || isSendingMessage}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendMessage().catch(() => undefined);
                    }
                  }}
                  placeholder={
                    route.mode === "dm"
                      ? `Message @${activeDm?.recipients[0]?.username ?? "user"}`
                      : `Message #${activeGuildChannel?.name ?? "channel"}`
                  }
                  className="min-h-20"
                />
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleAttachmentInputChange}
                />
                {!canSendInActiveChannel && route.mode === "guild" ? (
                  <p className="mt-2 text-xs">
                    You do not have permission to send messages in this server.
                  </p>
                ) : null}
                {composerAttachments.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {composerAttachments.map((attachment) => (
                      <div
                        key={attachment.local_id}
                        className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {attachment.filename}
                          </p>
                          <p className="text-xs">
                            {formatBytes(attachment.size)} · {attachment.status}
                            {attachment.error ? ` · ${attachment.error}` : ""}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            removeComposerAttachment(attachment.local_id)
                          }
                          disabled={
                            isSendingMessage ||
                            attachment.status === "uploading"
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => attachmentInputRef.current?.click()}
                    disabled={isSendingMessage || !canSendInActiveChannel}
                  >
                    <Paperclip className="mr-2 h-4 w-4" />
                    Attach
                  </Button>
                  <Button
                    onClick={() => sendMessage().catch(() => undefined)}
                    disabled={
                      isSendingMessage ||
                      sendMessageMutation.isPending ||
                      !canSendInActiveChannel
                    }
                  >
                    {isSendingMessage || sendMessageMutation.isPending
                      ? "Sending..."
                      : "Send"}
                  </Button>
                </div>
              </footer>
            </>
          ) : (
            <div className="h-full grid place-items-center text-center px-6">
              <div>
                <h2 className="text-xl font-semibold mb-2">
                  No channel selected
                </h2>
                <p>Select a DM or a text channel from the sidebar.</p>
              </div>
            </div>
          )}
        </main>
      </div>

      <Modal
        open={Boolean(profileDialog)}
        onClose={() => setProfileDialog(null)}
        title={profileDialog?.user.display_name ?? "User Profile"}
        description={
          profileDialog ? `@${profileDialog.user.username}` : undefined
        }
      >
        {profileDialog ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full bg-muted grid place-items-center text-sm font-semibold uppercase">
                {profileDialog.user.avatar_url ? (
                  <img
                    src={profileDialog.user.avatar_url}
                    alt={`${profileDialog.user.display_name} avatar`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  getDisplayInitial(profileDialog.user.display_name)
                )}
              </div>
              <div className="min-w-0">
                <p className="font-semibold truncate">
                  {profileDialog.user.display_name}
                </p>
                <p className="text-sm truncate">
                  @{profileDialog.user.username}
                </p>
                <p className="text-xs mt-1 break-all">
                  ID: {profileDialog.user.id}
                </p>
              </div>
            </div>

            {profileDialog.guildId ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold">Roles in this server</p>
                {profileMemberQuery.isPending || profileRolesQuery.isPending ? (
                  <p className="text-sm">Loading roles...</p>
                ) : null}
                {profileMemberQuery.isError || profileRolesQuery.isError ? (
                  <p className="text-sm">Could not load roles for this user.</p>
                ) : null}
                {!profileMemberQuery.isPending &&
                !profileRolesQuery.isPending &&
                !profileMemberQuery.isError &&
                !profileRolesQuery.isError ? (
                  profileRoles.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {profileRoles.map((role) => (
                        <span
                          key={role.id}
                          className="rounded bg-accent px-2 py-1 text-xs"
                        >
                          {role.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm">No roles found.</p>
                  )
                ) : null}
                {profileMemberQuery.data?.joined_at ? (
                  <p className="text-xs">
                    Joined:{" "}
                    {new Date(
                      profileMemberQuery.data.joined_at,
                    ).toLocaleDateString()}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={profileSettingsOpen}
        onClose={() => setProfileSettingsOpen(false)}
        title="Profile Settings"
        description="Update your avatar."
      >
        <div className="space-y-4">
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              void handleAvatarFileChange(event);
            }}
          />
          <div className="flex items-center gap-3">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full bg-muted grid place-items-center text-sm font-semibold uppercase">
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
              <p className="font-semibold truncate">
                {me?.display_name ?? sessionUser?.name ?? "You"}
              </p>
              <p className="text-sm truncate">@{me?.username ?? "loading"}</p>
              <p className="text-xs mt-1">
                PNG, JPEG, or WEBP. Max size enforced by server.
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              disabled={isAvatarUploading}
            >
              {isAvatarUploading ? "Uploading..." : "Change Avatar"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={createGuildOpen}
        onClose={() => setCreateGuildOpen(false)}
        title="Create Guild"
        description="Create a server with a default Text Channels category and #general."
      >
        <form onSubmit={submitCreateGuild} className="space-y-4">
          <div>
            <Label htmlFor="guild-name">Guild Name</Label>
            <Input
              id="guild-name"
              value={createGuildName}
              onChange={(event) => setCreateGuildName(event.target.value)}
              maxLength={100}
              required
              className="mt-2"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateGuildOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createGuildMutation.isPending}>
              {createGuildMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={createChannelOpen}
        onClose={() => setCreateChannelOpen(false)}
        title="Create Channel"
        description="Create a category or text channel in this guild."
      >
        <form onSubmit={submitCreateChannel} className="space-y-4">
          <div>
            <Label>Channel Type</Label>
            <Select
              value={createChannelType}
              onValueChange={(value) =>
                setCreateChannelType(value as "0" | "4")
              }
            >
              <SelectTrigger className="w-full mt-2">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Text Channel</SelectItem>
                <SelectItem value="4">Category</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="channel-name">Name</Label>
            <Input
              id="channel-name"
              value={createChannelName}
              onChange={(event) => setCreateChannelName(event.target.value)}
              maxLength={100}
              required
              className="mt-2"
            />
          </div>

          {createChannelType === "0" ? (
            <div>
              <Label>Parent Category</Label>
              <Select
                value={createChannelParentId}
                onValueChange={setCreateChannelParentId}
              >
                <SelectTrigger className="w-full mt-2">
                  <SelectValue placeholder="No category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No category</SelectItem>
                  {categoryOptions.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateChannelOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createGuildChannelMutation.isPending}
            >
              {createGuildChannelMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite Link"
        description="Share this invite code to let another user join the guild."
      >
        <div className="space-y-4">
          {createInviteMutation.isPending ? <p>Generating invite...</p> : null}
          {inviteResult ? (
            <>
              <div className="rounded-md border p-3">
                <p className="text-sm">Code</p>
                <p className="font-semibold">{inviteResult.code}</p>
                <p className="text-xs mt-2">
                  Link:{" "}
                  {`${window.location.origin}/invite/${inviteResult.code}`}
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    navigator.clipboard.writeText(
                      `${window.location.origin}/invite/${inviteResult.code}`,
                    )
                  }
                >
                  Copy Link
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Modal>

      <GuildSettingsModal
        open={settingsOpen}
        guildId={route.mode === "guild" ? route.guildId : null}
        canManageGuild={canManageGuild}
        canManageRoles={canManageRoles}
        channels={guildChannels}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
};

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />

        <Route element={<ProtectedRoute />}>
          <Route path="/app" element={<ChatApp />} />
          <Route path="/app/channels/@me" element={<ChatApp />} />
          <Route path="/app/channels/@me/:channelId" element={<ChatApp />} />
          <Route path="/app/channels/:guildId" element={<ChatApp />} />
          <Route
            path="/app/channels/:guildId/:channelId"
            element={<ChatApp />}
          />
          <Route path="/settings/*" element={<UserSettingsPage />} />
          <Route path="/invite/:code" element={<JoinGuildPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
      <Toaster richColors closeButton position="top-right" />
    </QueryClientProvider>
  );
}

export default App;
