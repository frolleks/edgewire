import type { GuildChannelPayload, MessagePayload } from "@discord/types";
import { ChannelType } from "@discord/types";
import { QueryClient, QueryClientProvider, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Home, Plus, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api, type CurrentUser, type DmChannel, type Guild, type Invite, type TypingEvent } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
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

const formatTime = (timestamp: string): string =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

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

const byPositionThenId = (a: GuildChannelPayload, b: GuildChannelPayload): number => {
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  return a.id.localeCompare(b.id);
};

const buildGuildTree = (guildChannels: GuildChannelPayload[]): Array<{ category: GuildChannelPayload | null; channels: GuildChannelPayload[] }> => {
  const categories = guildChannels
    .filter(channel => channel.type === ChannelType.GUILD_CATEGORY)
    .sort(byPositionThenId);

  const textChannels = guildChannels
    .filter(channel => channel.type === ChannelType.GUILD_TEXT)
    .sort(byPositionThenId);

  const byParent = new Map<string | null, GuildChannelPayload[]>();
  for (const text of textChannels) {
    const key = text.parent_id ?? null;
    const existing = byParent.get(key) ?? [];
    existing.push(text);
    byParent.set(key, existing);
  }

  const result: Array<{ category: GuildChannelPayload | null; channels: GuildChannelPayload[] }> = [];
  const ungrouped = byParent.get(null) ?? [];
  if (ungrouped.length > 0) {
    result.push({ category: null, channels: ungrouped });
  }

  for (const category of categories) {
    result.push({
      category,
      channels: byParent.get(category.id) ?? [],
    });
  }

  return result;
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
              {description ? <CardDescription className="mt-2">{description}</CardDescription> : null}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close dialog">
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
      toast.error(error instanceof Error ? error.message : "Authentication failed.");
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
        <h1 className="text-2xl font-semibold mb-2">{mode === "login" ? "Welcome Back" : "Create Account"}</h1>
        <p className="text-sm mb-6">
          {mode === "login" ? "Sign in to continue chatting." : "Create your account to start chatting."}
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
              onChange={event => setUsername(event.target.value)}
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
              onChange={event => setDisplayName(event.target.value)}
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
          onChange={event => setEmail(event.target.value)}
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
          onChange={event => setPassword(event.target.value)}
          placeholder="********"
          className="mb-6"
        />

        <Button disabled={isSubmitting} type="submit" className="w-full">
          {isSubmitting ? "Please wait..." : mode === "login" ? "Sign In" : "Create Account"}
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
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not join guild.");
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
          {!inviteQuery.isLoading && !invite ? <p>Invite not found or expired.</p> : null}
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
                  Members: {invite.approximate_member_count} · Online: {invite.approximate_presence_count ?? 0}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="flex gap-2 justify-end">
          <Button variant="outline" onClick={() => navigate("/app/channels/@me")}>Home</Button>
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

  const route = useMemo(() => parseRoute(location.pathname), [location.pathname]);

  const [search, setSearch] = useState("");
  const [composerValue, setComposerValue] = useState("");
  const [createGuildOpen, setCreateGuildOpen] = useState(false);
  const [createGuildName, setCreateGuildName] = useState("");
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [createChannelType, setCreateChannelType] = useState<"0" | "4">("0");
  const [createChannelName, setCreateChannelName] = useState("");
  const [createChannelParentId, setCreateChannelParentId] = useState<string>("none");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<Invite | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});

  const typingThrottleRef = useRef(0);
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

  const usersSearchQuery = useQuery({
    queryKey: queryKeys.usersSearch(search),
    queryFn: () => api.searchUsers(search),
    enabled: search.trim().length >= 2,
  });

  const dmChannels = dmChannelsQuery.data ?? [];
  const guilds = guildsQuery.data ?? [];
  const guildChannels = guildChannelsQuery.data ?? [];

  const activeDm = route.mode === "dm"
    ? dmChannels.find(channel => channel.id === route.channelId) ?? null
    : null;

  const activeGuild = route.mode === "guild"
    ? guilds.find(guild => guild.id === route.guildId) ?? null
    : null;

  const activeGuildChannel = route.mode === "guild"
    ? guildChannels.find(channel => channel.id === route.channelId) ?? null
    : null;

  const activeMessageChannelId = route.mode === "dm"
    ? activeDm?.id ?? null
    : activeGuildChannel?.type === ChannelType.GUILD_TEXT
      ? activeGuildChannel.id
      : null;

  const activeChannelName = route.mode === "dm"
    ? activeDm?.recipients[0]?.display_name ?? null
    : activeGuildChannel?.name ?? null;

  const canManageGuild = Boolean(
    route.mode === "guild" &&
      activeGuild &&
      meQuery.data &&
      activeGuild.owner_id === meQuery.data.id,
  );

  useGateway({
    enabled: Boolean(sessionUser?.id),
    userId: sessionUser?.id ?? null,
    activeChannelId: activeMessageChannelId,
  });

  const messagesQuery = useInfiniteQuery({
    queryKey: queryKeys.messages(activeMessageChannelId ?? "none"),
    queryFn: ({ pageParam }) =>
      api.listMessages(activeMessageChannelId!, pageParam ? String(pageParam) : undefined, 50),
    enabled: Boolean(activeMessageChannelId),
    initialPageParam: "",
    getNextPageParam: lastPage => {
      if (lastPage.length === 0) {
        return undefined;
      }

      return lastPage[lastPage.length - 1]?.id;
    },
  });

  const typingQuery = useQuery({
    queryKey: activeMessageChannelId ? queryKeys.typing(activeMessageChannelId) : ["typing", "none"],
    queryFn: async () => [] as TypingEvent[],
    enabled: false,
    initialData: [] as TypingEvent[],
  });

  const createDmMutation = useMutation({
    mutationFn: (recipientId: string) => api.createDmChannel(recipientId),
    onSuccess: channel => {
      queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old => {
        const existing = old ?? [];
        if (existing.some(item => item.id === channel.id)) {
          return existing;
        }
        return [channel, ...existing];
      });

      setSearch("");
      navigate(`/app/channels/@me/${channel.id}`);
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not create DM.");
    },
  });

  const createGuildMutation = useMutation({
    mutationFn: (name: string) => api.createGuild(name),
    onSuccess: guild => {
      queryClient.setQueryData<Guild[]>(queryKeys.guilds, old => {
        const existing = old ?? [];
        if (existing.some(item => item.id === guild.id)) {
          return existing;
        }
        return [...existing, guild].sort((a, b) => a.name.localeCompare(b.name));
      });
      setCreateGuildOpen(false);
      setCreateGuildName("");
      navigate(`/app/channels/${guild.id}`);
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not create guild.");
    },
  });

  const createGuildChannelMutation = useMutation({
    mutationFn: (payload: { name: string; type: 0 | 4; parent_id?: string | null }) =>
      api.createGuildChannel(route.guildId!, payload),
    onSuccess: channel => {
      queryClient.setQueryData<GuildChannelPayload[]>(queryKeys.guildChannels(route.guildId!), old => {
        const existing = old ?? [];
        if (existing.some(item => item.id === channel.id)) {
          return existing;
        }
        return [...existing, channel].sort(byPositionThenId);
      });

      setCreateChannelOpen(false);
      setCreateChannelName("");
      setCreateChannelParentId("none");
      setCreateChannelType("0");

      if (channel.type === ChannelType.GUILD_TEXT) {
        navigate(`/app/channels/${channel.guild_id}/${channel.id}`);
      }
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not create channel.");
    },
  });

  const createInviteMutation = useMutation({
    mutationFn: (channelId: string) => api.createInvite(channelId, {}),
    onSuccess: invite => {
      setInviteResult(invite);
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not create invite.");
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: (payload: { channelId: string; content: string }) =>
      api.createMessage(payload.channelId, payload.content),
    onSuccess: message => {
      queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
        queryKeys.messages(message.channel_id),
        old => {
          if (!old) {
            return {
              pages: [[message]],
              pageParams: [undefined],
            };
          }
          if (old.pages.some(page => page.some(item => item.id === message.id))) {
            return old;
          }
          return {
            ...old,
            pages: [[message, ...(old.pages[0] ?? [])], ...old.pages.slice(1)],
          };
        },
      );

      if (message.guild_id === null) {
        queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old => {
          const existing = old ?? [];
          const index = existing.findIndex(channel => channel.id === message.channel_id);
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
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not send message.");
    },
  });

  useEffect(() => {
    if (location.pathname === "/app") {
      navigate("/app/channels/@me", { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (route.mode !== "guild" || !route.guildId || guildChannels.length === 0) {
      return;
    }

    const selected = guildChannels.find(channel => channel.id === route.channelId);
    const firstText = guildChannels
      .filter(channel => channel.type === ChannelType.GUILD_TEXT)
      .sort(byPositionThenId)[0];

    if (!firstText) {
      return;
    }

    if (!selected || selected.type !== ChannelType.GUILD_TEXT) {
      navigate(`/app/channels/${route.guildId}/${firstText.id}`, { replace: true });
    }
  }, [route, guildChannels, navigate]);

  const messagesData = messagesQuery.data as InfiniteData<MessagePayload[]> | undefined;
  const newestMessageId = messagesData?.pages?.[0]?.[0]?.id;

  useEffect(() => {
    if (!activeMessageChannelId || !newestMessageId) {
      return;
    }

    api.markRead(activeMessageChannelId, newestMessageId).catch(() => undefined);
  }, [activeMessageChannelId, newestMessageId]);

  useEffect(() => {
    if (!newestMessageId) {
      return;
    }
    listBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [newestMessageId]);

  const messagesNewestFirst = messagesData?.pages.flatMap(page => page) ?? [];
  const chronologicalMessages = useMemo(
    () => dedupeChronological(messagesNewestFirst),
    [messagesNewestFirst],
  );

  const typingEvents = typingQuery.data;
  const typingUserIds = new Set(typingEvents.map(event => event.user_id));

  const activeGuildTree = useMemo(() => buildGuildTree(guildChannels), [guildChannels]);
  const categoryOptions = guildChannels.filter(channel => channel.type === ChannelType.GUILD_CATEGORY);

  const sendMessage = async (): Promise<void> => {
    if (!activeMessageChannelId) {
      return;
    }

    const content = composerValue.trim();
    if (!content) {
      return;
    }

    await sendMessageMutation.mutateAsync({ channelId: activeMessageChannelId, content });
    setComposerValue("");
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

  const openInvite = (): void => {
    if (!activeMessageChannelId || route.mode !== "guild") {
      return;
    }

    setInviteOpen(true);
    setInviteResult(null);
    createInviteMutation.mutate(activeMessageChannelId);
  };

  const submitCreateGuild = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = createGuildName.trim();
    if (!name) {
      return;
    }
    await createGuildMutation.mutateAsync(name);
  };

  const submitCreateChannel = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!route.guildId) {
      return;
    }

    const name = createChannelName.trim();
    if (!name) {
      return;
    }

    const type = Number(createChannelType) as 0 | 4;
    const parentId = type === ChannelType.GUILD_TEXT && createChannelParentId !== "none"
      ? createChannelParentId
      : null;

    await createGuildChannelMutation.mutateAsync({
      name,
      type,
      parent_id: parentId,
    });
  };

  const me = meQuery.data as CurrentUser | undefined;

  return (
    <div className="h-screen overflow-hidden bg-background">
      <div className="h-full grid grid-cols-[72px_300px_1fr]">
        <aside className="border-r bg-card flex flex-col items-center py-3 gap-3">
          <Button asChild size="icon" variant={route.mode === "dm" ? "secondary" : "ghost"}>
            <Link to="/app/channels/@me" aria-label="Direct Messages">
              <Home />
            </Link>
          </Button>

          <div className="h-px w-8 bg-border" />

          <div className="flex-1 w-full px-2 space-y-2 overflow-y-auto">
            {guilds.map(guild => {
              const active = route.mode === "guild" && route.guildId === guild.id;
              return (
                <Button
                  key={guild.id}
                  asChild
                  size="icon"
                  variant={active ? "secondary" : "ghost"}
                  className="w-full rounded-xl"
                >
                  <Link to={`/app/channels/${guild.id}`} aria-label={guild.name}>
                    {guild.name.slice(0, 1).toUpperCase()}
                  </Link>
                </Button>
              );
            })}
          </div>

          <Button size="icon" variant="outline" onClick={() => setCreateGuildOpen(true)} aria-label="Create Guild">
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
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Search users"
                  className="mt-2"
                />
                {usersSearchQuery.data && search.trim().length >= 2 ? (
                  <div className="mt-2 max-h-40 overflow-y-auto rounded-md border bg-background">
                    {usersSearchQuery.data.length === 0 ? (
                      <p className="px-3 py-2 text-xs">No users found.</p>
                    ) : (
                      usersSearchQuery.data.map(user => (
                        <button
                          key={user.id}
                          className="w-full px-3 py-2 text-left hover:bg-accent flex items-center justify-between gap-2"
                          onClick={() => createDmMutation.mutate(user.id)}
                          type="button"
                        >
                          <span className="truncate">
                            <span className="font-medium">{user.display_name}</span>
                            <span className="text-xs ml-2">@{user.username}</span>
                          </span>
                          <span className="text-xs">Message</span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              <div className="p-3 text-xs uppercase tracking-wide">Direct Messages</div>
              <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
                {dmChannels.map(channel => {
                  const recipient = channel.recipients[0];
                  const active = route.channelId === channel.id;
                  return (
                    <Link
                      key={channel.id}
                      to={`/app/channels/@me/${channel.id}`}
                      className={`block rounded-md px-3 py-2 transition ${active ? "bg-accent" : "hover:bg-accent"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">{recipient?.display_name ?? "Unknown"}</span>
                        {channel.unread ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
                      </div>
                      <p className="text-xs truncate mt-1">{channel.last_message?.content ?? "No messages yet"}</p>
                    </Link>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="p-4 border-b flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{activeGuild?.name ?? "Guild"}</p>
                  <p className="text-xs truncate">Channels</p>
                </div>
                {canManageGuild ? (
                  <div className="flex gap-1">
                    <Button
                      size="icon-xs"
                      variant="outline"
                      onClick={() => {
                        setCreateChannelType("4");
                        setCreateChannelParentId("none");
                        setCreateChannelOpen(true);
                      }}
                      aria-label="Create category"
                    >
                      <Plus />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="outline"
                      onClick={() => {
                        setCreateChannelType("0");
                        setCreateChannelOpen(true);
                      }}
                      aria-label="Create text channel"
                    >
                      <Plus />
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="flex-1 overflow-y-auto px-2 pb-2 pt-2 space-y-2">
                {activeGuildTree.length === 0 ? <p className="px-2 text-sm">No channels yet.</p> : null}
                {activeGuildTree.map(group => {
                  if (!group.category) {
                    return (
                      <div key="uncategorized" className="space-y-1">
                        <p className="px-2 text-xs uppercase tracking-wide">Text Channels</p>
                        {group.channels.map(channel => {
                          const active = route.channelId === channel.id;
                          return (
                            <Link
                              key={channel.id}
                              to={`/app/channels/${channel.guild_id}/${channel.id}`}
                              className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${active ? "bg-accent" : "hover:bg-accent"}`}
                            >
                              <span>#</span>
                              <span className="truncate">{channel.name}</span>
                            </Link>
                          );
                        })}
                      </div>
                    );
                  }

                  const collapsed = Boolean(collapsedCategories[group.category.id]);
                  return (
                    <div key={group.category.id} className="space-y-1">
                      <button
                        type="button"
                        className="w-full flex items-center gap-1 px-1 py-1 rounded-sm hover:bg-accent"
                        onClick={() =>
                          setCollapsedCategories(old => ({
                            ...old,
                            [group.category!.id]: !Boolean(old[group.category!.id]),
                          }))
                        }
                      >
                        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        <span className="text-xs uppercase tracking-wide truncate">{group.category.name}</span>
                      </button>

                      {!collapsed
                        ? group.channels.map(channel => {
                            const active = route.channelId === channel.id;
                            return (
                              <Link
                                key={channel.id}
                                to={`/app/channels/${channel.guild_id}/${channel.id}`}
                                className={`ml-4 flex items-center gap-2 rounded-md px-2 py-1.5 ${active ? "bg-accent" : "hover:bg-accent"}`}
                              >
                                <span>#</span>
                                <span className="truncate">{channel.name}</span>
                              </Link>
                            );
                          })
                        : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="border-t px-3 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{me?.display_name ?? sessionUser?.name ?? "You"}</p>
              <p className="text-xs truncate">@{me?.username ?? "loading"}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={signOut}>
              Sign out
            </Button>
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
                    <p className="text-xs truncate">@{activeDm.recipients[0].username}</p>
                  ) : null}
                </div>
                {canManageGuild && route.mode === "guild" ? (
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
                    disabled={!messagesQuery.hasNextPage || messagesQuery.isFetchingNextPage}
                    onClick={() => messagesQuery.fetchNextPage()}
                  >
                    {messagesQuery.isFetchingNextPage ? "Loading..." : "Load older"}
                  </Button>
                </div>

                {chronologicalMessages.map(message => (
                  <article key={message.id} className="flex gap-3">
                    <div className="h-9 w-9 rounded-full bg-muted grid place-items-center text-xs font-semibold uppercase">
                      {message.author.display_name.slice(0, 1)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{message.author.display_name}</span>
                        <span className="text-xs">{formatTime(message.timestamp)}</span>
                        {message.edited_timestamp ? <span className="text-[10px]">(edited)</span> : null}
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm mt-1">{message.content}</p>
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
                  onChange={event => {
                    setComposerValue(event.target.value);
                    triggerTyping();
                  }}
                  onKeyDown={event => {
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
                <div className="mt-2 flex justify-end">
                  <Button onClick={() => sendMessage().catch(() => undefined)} disabled={sendMessageMutation.isPending}>
                    Send
                  </Button>
                </div>
              </footer>
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
      </div>

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
              onChange={event => setCreateGuildName(event.target.value)}
              maxLength={100}
              required
              className="mt-2"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateGuildOpen(false)}>
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
            <Select value={createChannelType} onValueChange={value => setCreateChannelType(value as "0" | "4") }>
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
              onChange={event => setCreateChannelName(event.target.value)}
              maxLength={100}
              required
              className="mt-2"
            />
          </div>

          {createChannelType === "0" ? (
            <div>
              <Label>Parent Category</Label>
              <Select value={createChannelParentId} onValueChange={setCreateChannelParentId}>
                <SelectTrigger className="w-full mt-2">
                  <SelectValue placeholder="No category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No category</SelectItem>
                  {categoryOptions.map(category => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateChannelOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createGuildChannelMutation.isPending}>
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
                <p className="text-xs mt-2">Link: {`${window.location.origin}/invite/${inviteResult.code}`}</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(`${window.location.origin}/invite/${inviteResult.code}`)}
                >
                  Copy Link
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Modal>
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
          <Route path="/app/channels/:guildId/:channelId" element={<ChatApp />} />
          <Route path="/invite/:code" element={<JoinGuildPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
      <Toaster richColors closeButton position="top-right" />
    </QueryClientProvider>
  );
}

export default App;
