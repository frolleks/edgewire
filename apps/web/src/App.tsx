import type { MessagePayload } from "@discord/types";
import { QueryClient, QueryClientProvider, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";
import { api, type CurrentUser, type DmChannel, type TypingEvent } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useGateway } from "@/hooks/use-gateway";
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

const getSessionUser = (data: unknown): SessionUser | null => {
  if (!data || typeof data !== "object" || !("user" in data)) {
    return null;
  }

  const user = (data as { user?: SessionUser }).user;
  return user?.id ? user : null;
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

const ProtectedRoute = () => {
  const session = authClient.useSession();
  const sessionUser = getSessionUser(session.data);

  if (session.isPending) {
    return <div className="h-screen grid place-items-center">Loading...</div>;
  }

  if (!sessionUser) {
    return <Navigate to="/login" replace />;
  }

  return <ChatApp sessionUser={sessionUser} />;
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
      navigate("/app", { replace: true });
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

      navigate("/app", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-screen grid place-items-center px-4">
      <form
        className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-2xl backdrop-blur"
        onSubmit={submit}
      >
        <h1 className="text-2xl font-semibold mb-2">{mode === "login" ? "Welcome Back" : "Create Account"}</h1>
        <p className="text-sm mb-6">
          {mode === "login" ? "Sign in to continue chatting." : "Create your account to start DMs."}
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

const ChatApp = ({ sessionUser }: { sessionUser: SessionUser }) => {
  const params = useParams<{ channelId?: string }>();
  const channelId = params.channelId ?? null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [composerValue, setComposerValue] = useState("");
  const typingThrottleRef = useRef(0);
  const listBottomRef = useRef<HTMLDivElement>(null);

  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: api.getMe,
  });

  const channelsQuery = useQuery({
    queryKey: queryKeys.channels,
    queryFn: api.listChannels,
  });

  const usersSearchQuery = useQuery({
    queryKey: queryKeys.usersSearch(search),
    queryFn: () => api.searchUsers(search),
    enabled: search.trim().length >= 2,
  });

  useGateway({
    enabled: Boolean(sessionUser.id),
    userId: sessionUser.id,
    activeChannelId: channelId,
  });

  const messagesQuery = useInfiniteQuery({
    queryKey: queryKeys.messages(channelId ?? "none"),
    queryFn: ({ pageParam }) =>
      api.listMessages(channelId!, pageParam ? String(pageParam) : undefined, 50),
    enabled: Boolean(channelId),
    initialPageParam: "",
    getNextPageParam: lastPage => {
      if (lastPage.length === 0) {
        return undefined;
      }

      return lastPage[lastPage.length - 1]?.id;
    },
  });

  const typingQuery = useQuery({
    queryKey: channelId ? queryKeys.typing(channelId) : ["typing", "none"],
    queryFn: async () => [] as TypingEvent[],
    enabled: false,
    initialData: [] as TypingEvent[],
  });

  const createDmMutation = useMutation({
    mutationFn: (recipientId: string) => api.createDmChannel(recipientId),
    onSuccess: channel => {
      queryClient.setQueryData<DmChannel[]>(queryKeys.channels, old => {
        const existing = old ?? [];
        if (existing.some(item => item.id === channel.id)) {
          return existing;
        }
        return [channel, ...existing];
      });

      setSearch("");
      navigate(`/app/channels/${channel.id}`);
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not create DM.");
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

      queryClient.setQueryData<DmChannel[]>(queryKeys.channels, old => {
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
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Could not send message.");
    },
  });

  useEffect(() => {
    if (channelId || !channelsQuery.data || channelsQuery.data.length === 0) {
      return;
    }

    const firstChannel = channelsQuery.data[0];
    if (!firstChannel) {
      return;
    }
    navigate(`/app/channels/${firstChannel.id}`, { replace: true });
  }, [channelId, channelsQuery.data, navigate]);

  const messagesData = messagesQuery.data as InfiniteData<MessagePayload[]> | undefined;
  const newestMessageId = messagesData?.pages?.[0]?.[0]?.id;
  useEffect(() => {
    if (!channelId || !newestMessageId) {
      return;
    }

    api.markRead(channelId, newestMessageId).catch(() => undefined);
  }, [channelId, newestMessageId]);

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

  const channels = channelsQuery.data ?? [];
  const activeChannel = channels.find(channel => channel.id === channelId) ?? null;
  const recipient = activeChannel?.recipients?.[0] ?? null;

  const typingEvents = typingQuery.data;
  const recipientTyping = recipient
    ? typingEvents.some(event => event.user_id === recipient.id)
    : false;

  const sendMessage = async (): Promise<void> => {
    if (!channelId) {
      return;
    }

    const content = composerValue.trim();
    if (!content) {
      return;
    }

    await sendMessageMutation.mutateAsync({ channelId, content });
    setComposerValue("");
  };

  const triggerTyping = (): void => {
    if (!channelId) {
      return;
    }

    const ts = Date.now();
    if (ts - typingThrottleRef.current < 2_000) {
      return;
    }

    typingThrottleRef.current = ts;
    api.triggerTyping(channelId).catch(() => undefined);
  };

  const signOut = async (): Promise<void> => {
    await authClient.signOut();
    queryClient.clear();
    navigate("/login", { replace: true });
  };

  const me = meQuery.data as CurrentUser | undefined;

  return (
    <div className="h-screen overflow-hidden">
      <div className="h-full grid grid-cols-[300px_1fr] bg-background">
        <aside className="border-r bg-card backdrop-blur overflow-hidden flex flex-col">
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
            {channels.map(channel => {
              const channelRecipient = channel.recipients[0];
              return (
                <Link
                  key={channel.id}
                  to={`/app/channels/${channel.id}`}
                  className={`block rounded-md px-3 py-2 transition ${
                    channel.id === channelId
                      ? "bg-accent"
                      : "hover:bg-accent"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{channelRecipient?.display_name ?? "Unknown"}</span>
                    {channel.unread ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
                  </div>
                  <p className="text-xs truncate mt-1">
                    {channel.last_message?.content ?? "No messages yet"}
                  </p>
                </Link>
              );
            })}
          </div>

          <div className="border-t px-3 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{me?.display_name ?? sessionUser.name ?? "You"}</p>
              <p className="text-xs truncate">@{me?.username ?? "loading"}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </aside>

        <main className="flex h-full flex-col bg-background">
          {activeChannel && recipient ? (
            <>
              <header className="h-14 border-b px-4 flex items-center justify-between bg-card">
                <div className="min-w-0">
                  <h2 className="font-semibold truncate">{recipient.display_name}</h2>
                  <p className="text-xs truncate">@{recipient.username}</p>
                </div>
                {activeChannel.unread ? <span className="text-xs">Unread messages</span> : null}
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

                {recipientTyping ? (
                  <p className="text-xs italic">{recipient.display_name} is typing...</p>
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
                  placeholder={`Message @${recipient.username}`}
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
                <h2 className="text-xl font-semibold mb-2">No DM selected</h2>
                <p>Choose a conversation from the sidebar or search for a user to start chatting.</p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="/app" element={<ProtectedRoute />} />
        <Route path="/app/channels/:channelId" element={<ProtectedRoute />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
      <Toaster richColors closeButton position="top-right" />
    </QueryClientProvider>
  );
}

export default App;
