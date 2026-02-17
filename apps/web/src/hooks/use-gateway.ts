import type {
  ChannelBadgePayload,
  DmChannelPayload,
  GatewayPacket,
  GuildBadgePayload,
  GuildChannelPayload,
  GuildCreateEvent,
  GuildRole,
  MessagePayload,
  ReadyEvent,
  UserSummary,
} from "@discord/types";
import { useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  api,
  type BadgesResponse,
  type CurrentUser,
  type DmChannel,
  type Guild,
  type GuildMemberSummary,
  type GuildVoiceStateMap,
  type PresenceStatus,
  type SelfPresenceStatus,
  type Role,
  type TypingEvent,
} from "@/lib/api";
import { GATEWAY_URL } from "@/lib/env";
import { type PresenceMap, presenceQueryKeys } from "@/lib/presence";
import { queryKeys } from "@/lib/query-keys";

type GatewayParams = {
  enabled: boolean;
  userId: string | null;
  activeChannelId: string | null;
};

const insertNewestMessage = (
  current: InfiniteData<MessagePayload[]> | undefined,
  message: MessagePayload,
): InfiniteData<MessagePayload[]> | undefined => {
  if (!current) {
    return {
      pages: [[message]],
      pageParams: [undefined],
    };
  }

  if (current.pages.some(page => page.some(item => item.id === message.id))) {
    return current;
  }

  return {
    ...current,
    pages: [[message, ...(current.pages[0] ?? [])], ...current.pages.slice(1)],
  };
};

const updateMessage = (
  current: InfiniteData<MessagePayload[]> | undefined,
  update: Partial<MessagePayload> & { id: string },
): InfiniteData<MessagePayload[]> | undefined => {
  if (!current) {
    return current;
  }

  return {
    ...current,
    pages: current.pages.map(page =>
      page.map(item => {
        if (item.id !== update.id) {
          return item;
        }
        return {
          ...item,
          ...update,
          mentions: update.mentions ?? item.mentions,
          mention_roles: update.mention_roles ?? item.mention_roles,
          mention_channels: update.mention_channels ?? item.mention_channels,
        };
      }),
    ),
  };
};

const deleteMessage = (
  current: InfiniteData<MessagePayload[]> | undefined,
  messageId: string,
): InfiniteData<MessagePayload[]> | undefined => {
  if (!current) {
    return current;
  }

  return {
    ...current,
    pages: current.pages.map(page => page.filter(item => item.id !== messageId)),
  };
};

const ensureDmChannel = (input: DmChannelPayload): DmChannel => ({
  ...input,
  unread: Boolean(input.unread),
});

const withUpdatedAuthor = (message: MessagePayload, user: UserSummary): MessagePayload =>
  message.author.id === user.id
    ? {
        ...message,
        author: user,
      }
    : message;

type GuildMembersPage = {
  members: GuildMemberSummary[];
  next_after: string | null;
};

const matchesMemberSearch = (member: GuildMemberSummary, searchQuery: string): boolean => {
  const normalized = searchQuery.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  const displayName = member.user.display_name.toLowerCase();
  const username = member.user.username.toLowerCase();
  const nick = member.nick?.toLowerCase() ?? "";

  return (
    displayName.startsWith(normalized) ||
    username.startsWith(normalized) ||
    nick.startsWith(normalized)
  );
};

const upsertGuildMemberPage = (
  current: GuildMembersPage | undefined,
  member: GuildMemberSummary,
  searchQuery = "",
): GuildMembersPage | undefined => {
  if (!current) {
    return current;
  }

  const index = current.members.findIndex(existing => existing.user.id === member.user.id);
  if (index !== -1) {
    const nextMembers = [...current.members];
    nextMembers[index] = member;
    return {
      ...current,
      members: nextMembers,
    };
  }

  if (!matchesMemberSearch(member, searchQuery)) {
    return current;
  }

  return {
    ...current,
    members: [member, ...current.members],
  };
};

const removeGuildMemberFromPage = (
  current: GuildMembersPage | undefined,
  userId: string,
): GuildMembersPage | undefined => {
  if (!current) {
    return current;
  }

  const nextMembers = current.members.filter(member => member.user.id !== userId);
  if (nextMembers.length === current.members.length) {
    return current;
  }

  return {
    ...current,
    members: nextMembers,
  };
};

const patchGuildMembersInfinite = (
  current: InfiniteData<GuildMembersPage> | undefined,
  userId: string,
  updater: (member: GuildMemberSummary) => GuildMemberSummary,
): InfiniteData<GuildMembersPage> | undefined => {
  if (!current) {
    return current;
  }

  let changed = false;
  const pages = current.pages.map(page => {
    let pageChanged = false;
    const members = page.members.map(member => {
      if (member.user.id !== userId) {
        return member;
      }
      pageChanged = true;
      return updater(member);
    });

    if (!pageChanged) {
      return page;
    }

    changed = true;
    return {
      ...page,
      members,
    };
  });

  if (!changed) {
    return current;
  }

  return {
    ...current,
    pages,
  };
};

const upsertGuildMemberInfinite = (
  current: InfiniteData<GuildMembersPage> | undefined,
  member: GuildMemberSummary,
  searchQuery = "",
): InfiniteData<GuildMembersPage> | undefined => {
  if (!current) {
    return current;
  }

  const patched = patchGuildMembersInfinite(current, member.user.id, () => member);
  if (patched !== current) {
    return patched;
  }

  if (!matchesMemberSearch(member, searchQuery)) {
    return current;
  }

  const [firstPage, ...rest] = current.pages;
  if (!firstPage) {
    return current;
  }

  return {
    ...current,
    pages: [
      {
        ...firstPage,
        members: [member, ...firstPage.members],
      },
      ...rest,
    ],
  };
};

const removeGuildMemberFromInfinite = (
  current: InfiniteData<GuildMembersPage> | undefined,
  userId: string,
): InfiniteData<GuildMembersPage> | undefined => {
  if (!current) {
    return current;
  }

  let changed = false;
  const pages = current.pages.map(page => {
    const members = page.members.filter(member => member.user.id !== userId);
    if (members.length === page.members.length) {
      return page;
    }
    changed = true;
    return {
      ...page,
      members,
    };
  });

  if (!changed) {
    return current;
  }

  return {
    ...current,
    pages,
  };
};

const upsertChannelBadge = (
  current: BadgesResponse | undefined,
  nextBadge: ChannelBadgePayload,
): BadgesResponse => {
  const existing = current ?? { channels: [], guilds: [] };
  const index = existing.channels.findIndex(channel => channel.channel_id === nextBadge.channel_id);

  const nextChannels = [...existing.channels];
  if (index === -1) {
    nextChannels.push(nextBadge);
  } else {
    nextChannels[index] = nextBadge;
  }

  return {
    ...existing,
    channels: nextChannels,
  };
};

const upsertGuildBadge = (
  current: BadgesResponse | undefined,
  nextBadge: GuildBadgePayload,
): BadgesResponse => {
  const existing = current ?? { channels: [], guilds: [] };
  const index = existing.guilds.findIndex(guild => guild.guild_id === nextBadge.guild_id);

  const nextGuilds = [...existing.guilds];
  if (index === -1) {
    nextGuilds.push(nextBadge);
  } else {
    nextGuilds[index] = nextBadge;
  }

  return {
    ...existing,
    guilds: nextGuilds,
  };
};

export const useGateway = ({ enabled, userId, activeChannelId }: GatewayParams) => {
  const queryClient = useQueryClient();
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const firstHeartbeatTimeoutRef = useRef<number | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const lastSequenceRef = useRef<number | null>(null);
  const typingTimeoutsRef = useRef<Map<string, number>>(new Map());
  const sendPresenceUpdateRef = useRef<(status: SelfPresenceStatus) => void>(() => undefined);

  useEffect(() => {
    if (!enabled || !userId) {
      return;
    }

    let closedIntentionally = false;

    const clearTimers = (): void => {
      if (heartbeatIntervalRef.current !== null) {
        window.clearInterval(heartbeatIntervalRef.current);
      }
      if (firstHeartbeatTimeoutRef.current !== null) {
        window.clearTimeout(firstHeartbeatTimeoutRef.current);
      }
      heartbeatIntervalRef.current = null;
      firstHeartbeatTimeoutRef.current = null;
    };

    const setTyping = (event: TypingEvent): void => {
      queryClient.setQueryData<TypingEvent[]>(queryKeys.typing(event.channel_id), old => {
        const next = (old ?? []).filter(item => item.user_id !== event.user_id);
        next.push(event);
        return next;
      });

      const timeoutKey = `${event.channel_id}:${event.user_id}`;
      const existingTimeout = typingTimeoutsRef.current.get(timeoutKey);
      if (existingTimeout) {
        window.clearTimeout(existingTimeout);
      }

      const timeoutId = window.setTimeout(() => {
        queryClient.setQueryData<TypingEvent[]>(queryKeys.typing(event.channel_id), old =>
          (old ?? []).filter(item => item.user_id !== event.user_id),
        );
        typingTimeoutsRef.current.delete(timeoutKey);
      }, 3_000);

      typingTimeoutsRef.current.set(timeoutKey, timeoutId);
    };

    const scheduleReconnect = (): void => {
      if (closedIntentionally) {
        return;
      }

      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }

      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect().catch(() => {
          scheduleReconnect();
        });
      }, 1_500);
    };

    const connect = async (): Promise<void> => {
      clearTimers();
      if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) {
        socketRef.current.close();
      }

      const { token } = await api.mintGatewayToken();
      const socket = new WebSocket(GATEWAY_URL);
      socketRef.current = socket;

      const send = (packet: GatewayPacket): void => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(packet));
        }
      };

      sendPresenceUpdateRef.current = (status: SelfPresenceStatus): void => {
        send({
          op: 3,
          d: {
            status,
          },
        });
      };

      const sendHeartbeat = (): void => {
        send({
          op: 1,
          d: lastSequenceRef.current,
        });
      };

      socket.onmessage = event => {
        let packet: GatewayPacket;
        try {
          packet = JSON.parse(event.data) as GatewayPacket;
        } catch {
          return;
        }

        if (packet.s !== undefined && packet.s !== null) {
          lastSequenceRef.current = packet.s;
        }

        if (packet.op === 10) {
          const heartbeatInterval =
            typeof packet.d === "object" && packet.d !== null && "heartbeat_interval" in packet.d
              ? Number((packet.d as { heartbeat_interval: number }).heartbeat_interval)
              : 25_000;

          const jitter = Math.random();
          firstHeartbeatTimeoutRef.current = window.setTimeout(() => {
            sendHeartbeat();
            heartbeatIntervalRef.current = window.setInterval(() => {
              sendHeartbeat();
            }, heartbeatInterval);
          }, heartbeatInterval * jitter);

          send({
            op: 2,
            d: {
              token,
              properties: {
                os: navigator.platform,
                browser: "discord-clone-web",
                device: "discord-clone-web",
              },
              intents: 0,
            },
          });
          return;
        }

        if (packet.op === 1) {
          sendHeartbeat();
          return;
        }

        if (packet.op === 7 || packet.op === 9) {
          socket.close();
          return;
        }

        if (packet.op !== 0 || !packet.t) {
          return;
        }

        switch (packet.t) {
          case "READY": {
            const ready = packet.d as ReadyEvent;
            queryClient.setQueryData<DmChannel[]>(
              queryKeys.dmChannels,
              ready.private_channels.map(channel => ensureDmChannel(channel)),
            );
            break;
          }
          case "GUILD_CREATE": {
            const guildPayload = packet.d as GuildCreateEvent;
            const guild: Guild = {
              id: guildPayload.id,
              name: guildPayload.name,
              icon: guildPayload.icon,
              owner_id: guildPayload.owner_id,
            };

            queryClient.setQueryData<Guild[]>(queryKeys.guilds, old => {
              const existing = old ?? [];
              const index = existing.findIndex(item => item.id === guild.id);
              if (index === -1) {
                return [...existing, guild].sort((a, b) => a.name.localeCompare(b.name));
              }

              const next = [...existing];
              next[index] = guild;
              return next;
            });

            queryClient.setQueryData<GuildChannelPayload[]>(
              queryKeys.guildChannels(guild.id),
              guildPayload.channels,
            );
            break;
          }
          case "CHANNEL_CREATE": {
            const channel = packet.d as DmChannelPayload | GuildChannelPayload;
            if ((channel as GuildChannelPayload).guild_id) {
              const guildChannel = channel as GuildChannelPayload;
              queryClient.setQueryData<GuildChannelPayload[]>(queryKeys.guildChannels(guildChannel.guild_id), old => {
                const existing = old ?? [];
                if (existing.some(item => item.id === guildChannel.id)) {
                  return existing;
                }
                return [...existing, guildChannel].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
              });
            } else {
              const dmChannel = ensureDmChannel(channel as DmChannelPayload);
              queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old => {
                const existing = old ?? [];
                if (existing.some(item => item.id === dmChannel.id)) {
                  return existing;
                }
                return [dmChannel, ...existing];
              });
            }
            break;
          }
          case "CHANNEL_UPDATE": {
            const channel = packet.d as GuildChannelPayload;
            queryClient.setQueryData<GuildChannelPayload[]>(queryKeys.guildChannels(channel.guild_id), old =>
              (old ?? [])
                .map(item => (item.id === channel.id ? channel : item))
                .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
            );
            break;
          }
          case "CHANNEL_DELETE": {
            const channel = packet.d as GuildChannelPayload;
            queryClient.setQueryData<GuildChannelPayload[]>(queryKeys.guildChannels(channel.guild_id), old =>
              (old ?? []).filter(item => item.id !== channel.id),
            );
            queryClient.removeQueries({ queryKey: queryKeys.messages(channel.id) });
            queryClient.setQueryData<BadgesResponse>(queryKeys.badges, old => {
              if (!old) {
                return old;
              }
              const nextChannels = old.channels.filter(item => item.channel_id !== channel.id);
              const unreadCount = nextChannels
                .filter(item => item.guild_id === channel.guild_id)
                .reduce((sum, item) => sum + item.unread_count, 0);
              const mentionCount = nextChannels
                .filter(item => item.guild_id === channel.guild_id)
                .reduce((sum, item) => sum + item.mention_count, 0);

              const guildIndex = old.guilds.findIndex(item => item.guild_id === channel.guild_id);
              const nextGuilds = [...old.guilds];
              if (guildIndex === -1) {
                nextGuilds.push({
                  guild_id: channel.guild_id,
                  unread_count: unreadCount,
                  mention_count: mentionCount,
                });
              } else {
                nextGuilds[guildIndex] = {
                  guild_id: channel.guild_id,
                  unread_count: unreadCount,
                  mention_count: mentionCount,
                };
              }

              return {
                channels: nextChannels,
                guilds: nextGuilds,
              };
            });
            queryClient.removeQueries({ queryKey: queryKeys.channelBadge(channel.id) });
            break;
          }
          case "MESSAGE_CREATE": {
            const message = packet.d as MessagePayload;
            queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
              queryKeys.messages(message.channel_id),
              old => insertNewestMessage(old, message),
            );

            if (message.guild_id === null) {
              queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old => {
                const channels = old ?? [];
                const index = channels.findIndex(channel => channel.id === message.channel_id);
                if (index === -1) {
                  return channels;
                }

                const next = [...channels];
                const channel = next[index];
                if (!channel) {
                  return channels;
                }

                const unread = message.author.id !== userId && activeChannelId !== message.channel_id;
                const updated: DmChannel = {
                  ...channel,
                  last_message: message,
                  last_message_id: message.id,
                  unread,
                };

                return [updated, ...next.filter((_, i) => i !== index)];
              });
            }
            break;
          }
          case "MESSAGE_UPDATE": {
            const message = packet.d as Partial<MessagePayload> & {
              id: string;
              channel_id: string;
            };
            queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
              queryKeys.messages(message.channel_id),
              old => updateMessage(old, message),
            );

            if (message.guild_id === null || message.guild_id === undefined) {
              queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old =>
                (old ?? []).map(channel =>
                  channel.last_message_id === message.id
                    ? {
                        ...channel,
                        last_message: channel.last_message
                          ? {
                              ...channel.last_message,
                              ...message,
                            }
                          : channel.last_message,
                      }
                    : channel,
                ),
              );
            }
            break;
          }
          case "PRESENCE_UPDATE": {
            const payload = packet.d as {
              user_id: string;
              status: PresenceStatus;
              last_seen_at: string;
            };
            queryClient.setQueryData<PresenceMap>(presenceQueryKeys.presences, old => ({
              ...(old ?? {}),
              [payload.user_id]: payload.status,
            }));
            break;
          }
          case "PRESENCE_SELF_UPDATE": {
            const payload = packet.d as {
              status: SelfPresenceStatus;
              last_seen_at: string;
            };
            queryClient.setQueryData<SelfPresenceStatus>(presenceQueryKeys.selfPresence, payload.status);
            break;
          }
          case "VOICE_CHANNEL_STATE_UPDATE": {
            const payload = packet.d as {
              guild_id: string;
              channel_id: string;
              participants: GuildVoiceStateMap[string];
            };
            queryClient.setQueryData<GuildVoiceStateMap>(
              queryKeys.guildVoiceState(payload.guild_id),
              old => {
                const next = { ...(old ?? {}) };
                if (payload.participants.length === 0) {
                  delete next[payload.channel_id];
                } else {
                  next[payload.channel_id] = payload.participants;
                }
                return next;
              },
            );
            break;
          }
          case "MESSAGE_DELETE": {
            const payload = packet.d as {
              id: string;
              channel_id: string;
              guild_id?: string | null;
            };
            queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
              queryKeys.messages(payload.channel_id),
              old => deleteMessage(old, payload.id),
            );

            const dmChannels = queryClient.getQueryData<DmChannel[]>(queryKeys.dmChannels) ?? [];
            const deletedWasDmPreview = dmChannels.some(
              channel =>
                channel.id === payload.channel_id &&
                channel.last_message_id === payload.id,
            );

            if (deletedWasDmPreview) {
              void queryClient.invalidateQueries({ queryKey: queryKeys.dmChannels });
            }
            break;
          }
          case "TYPING_START": {
            setTyping(packet.d as TypingEvent);
            break;
          }
          case "READ_STATE_UPDATE": {
            const payload = packet.d as {
              channel_id: string;
              user_id: string;
              last_read_message_id: string | null;
            };

            if (payload.user_id === userId) {
              queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old =>
                (old ?? []).map(channel =>
                  channel.id === payload.channel_id ? { ...channel, unread: false } : channel,
                ),
              );
            }
            break;
          }
          case "CHANNEL_BADGE_UPDATE": {
            const payload = packet.d as ChannelBadgePayload;
            queryClient.setQueryData<BadgesResponse>(queryKeys.badges, old => upsertChannelBadge(old, payload));
            queryClient.setQueryData<ChannelBadgePayload>(queryKeys.channelBadge(payload.channel_id), payload);

            queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old =>
              (old ?? []).map(channel =>
                channel.id === payload.channel_id
                  ? {
                      ...channel,
                      unread: payload.unread_count > 0,
                    }
                  : channel,
              ),
            );
            break;
          }
          case "GUILD_BADGE_UPDATE": {
            const payload = packet.d as GuildBadgePayload;
            queryClient.setQueryData<BadgesResponse>(queryKeys.badges, old => upsertGuildBadge(old, payload));
            break;
          }
          case "NOTIFICATION_CREATE": {
            const payload = packet.d as {
              channel_id: string;
              guild_id: string | null;
              message_id: string;
              author: UserSummary;
              mentioned: boolean;
            };

            if (payload.channel_id === activeChannelId) {
              break;
            }

            const authorName = payload.author.display_name || payload.author.username || "Someone";
            const dmChannels = queryClient.getQueryData<DmChannel[]>(queryKeys.dmChannels) ?? [];
            const dmChannel = dmChannels.find(channel => channel.id === payload.channel_id);

            const guildChannels = payload.guild_id
              ? queryClient.getQueryData<GuildChannelPayload[]>(queryKeys.guildChannels(payload.guild_id)) ?? []
              : [];
            const guildChannel = guildChannels.find(channel => channel.id === payload.channel_id);
            const channelLabel = guildChannel?.name ?? dmChannel?.recipients[0]?.display_name ?? "channel";

            const title = payload.mentioned
              ? `Mentioned by ${authorName}`
              : payload.guild_id
                ? "New message"
                : `New DM from ${authorName}`;
            const body = payload.mentioned
              ? `Mentioned in #${channelLabel}`
              : payload.guild_id
                ? `New message in #${channelLabel}`
                : `Message from ${authorName}`;

            toast.message(title, {
              description: body,
            });

            const me = queryClient.getQueryData<CurrentUser>(queryKeys.me);
            const desktopEnabled = Boolean(me?.settings.enable_desktop_notifications);
            if (
              desktopEnabled &&
              document.hidden &&
              typeof window !== "undefined" &&
              "Notification" in window &&
              Notification.permission === "granted"
            ) {
              void new Notification(title, {
                body,
              });
            }
            break;
          }
          case "GUILD_ROLE_CREATE":
          case "GUILD_ROLE_UPDATE": {
            const payload = packet.d as { guild_id: string; role: GuildRole };
            queryClient.setQueryData<Role[]>(queryKeys.guildRoles(payload.guild_id), old => {
              const existing = old ?? [];
              const index = existing.findIndex(role => role.id === payload.role.id);
              if (index === -1) {
                return [...existing, payload.role].sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
              }
              const next = [...existing];
              next[index] = payload.role;
              return next.sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
            });
            break;
          }
          case "GUILD_ROLE_DELETE": {
            const payload = packet.d as { guild_id: string; role_id: string };
            queryClient.setQueryData<Role[]>(queryKeys.guildRoles(payload.guild_id), old =>
              (old ?? []).filter(role => role.id !== payload.role_id),
            );
            break;
          }
          case "GUILD_MEMBER_UPDATE": {
            const payload = packet.d as {
              guild_id: string;
              user: UserSummary | { id: string };
              roles?: string[];
              nick?: string | null;
              joined_at?: string;
            };
            const memberQueries = queryClient.getQueryCache().findAll({
              queryKey: ["guild-members", payload.guild_id],
            });
            for (const query of memberQueries) {
              const searchQuery =
                typeof query.queryKey[2] === "string" ? query.queryKey[2] : "";
              queryClient.setQueryData<InfiniteData<GuildMembersPage>>(
                query.queryKey,
                old => {
                  if (!old) {
                    return old;
                  }

                  const patched = patchGuildMembersInfinite(old, payload.user.id, member => ({
                    ...member,
                    user: {
                      ...member.user,
                      ...payload.user,
                    },
                    roles: payload.roles ?? member.roles,
                    nick: payload.nick !== undefined ? payload.nick : member.nick,
                    joined_at: payload.joined_at ?? member.joined_at,
                  }));

                  if (!patched || !searchQuery) {
                    return patched;
                  }

                  const updatedMember = patched.pages
                    .flatMap(page => page.members)
                    .find(member => member.user.id === payload.user.id);

                  if (updatedMember && !matchesMemberSearch(updatedMember, searchQuery)) {
                    return removeGuildMemberFromInfinite(patched, payload.user.id);
                  }

                  return patched;
                },
              );
            }

            queryClient.setQueriesData<GuildMembersPage>(
              { queryKey: ["guild-members-settings", payload.guild_id] },
              old =>
                old
                  ? {
                      ...old,
                      members: old.members.map(member =>
                        member.user.id === payload.user.id
                          ? {
                              ...member,
                              user: {
                                ...member.user,
                                ...payload.user,
                              },
                              roles: payload.roles ?? member.roles,
                              nick: payload.nick !== undefined ? payload.nick : member.nick,
                              joined_at: payload.joined_at ?? member.joined_at,
                            }
                          : member,
                      ),
                    }
                  : old,
            );

            queryClient.setQueriesData<{ user: UserSummary; roles: string[]; joined_at: string }>(
              { queryKey: ["guild-member", payload.guild_id] },
              old =>
                old && old.user.id === payload.user.id
                  ? {
                      ...old,
                      user: {
                        ...old.user,
                        ...payload.user,
                      },
                      roles: payload.roles ?? old.roles,
                      joined_at: payload.joined_at ?? old.joined_at,
                    }
                  : old,
            );
            break;
          }
          case "GUILD_MEMBER_ADD": {
            const payload = packet.d as {
              guild_id: string;
              member: GuildMemberSummary;
            };

            const memberQueries = queryClient.getQueryCache().findAll({
              queryKey: ["guild-members", payload.guild_id],
            });
            for (const query of memberQueries) {
              const searchQuery =
                typeof query.queryKey[2] === "string" ? query.queryKey[2] : "";
              queryClient.setQueryData<InfiniteData<GuildMembersPage>>(
                query.queryKey,
                old => upsertGuildMemberInfinite(old, payload.member, searchQuery),
              );
            }

            queryClient.setQueriesData<GuildMembersPage>(
              { queryKey: ["guild-members-settings", payload.guild_id] },
              old => upsertGuildMemberPage(old, payload.member),
            );
            break;
          }
          case "GUILD_MEMBER_REMOVE": {
            const payload = packet.d as {
              guild_id: string;
              user: { id: string };
            };

            queryClient.setQueriesData<InfiniteData<GuildMembersPage>>(
              { queryKey: ["guild-members", payload.guild_id] },
              old => removeGuildMemberFromInfinite(old, payload.user.id),
            );

            queryClient.setQueriesData<GuildMembersPage>(
              { queryKey: ["guild-members-settings", payload.guild_id] },
              old => removeGuildMemberFromPage(old, payload.user.id),
            );

            queryClient.removeQueries({
              queryKey: queryKeys.guildMember(payload.guild_id, payload.user.id),
            });

            if (payload.user.id === userId) {
              queryClient.setQueryData<Guild[]>(queryKeys.guilds, old =>
                (old ?? []).filter(guild => guild.id !== payload.guild_id),
              );
              queryClient.removeQueries({
                queryKey: queryKeys.guildChannels(payload.guild_id),
              });
              queryClient.removeQueries({
                queryKey: queryKeys.guildPermissions(payload.guild_id),
              });
              queryClient.removeQueries({
                queryKey: queryKeys.guildRoles(payload.guild_id),
              });
              queryClient.removeQueries({
                queryKey: queryKeys.guildSettings(payload.guild_id),
              });
              queryClient.setQueryData<BadgesResponse>(queryKeys.badges, old =>
                old
                  ? {
                      channels: old.channels.filter(channel => channel.guild_id !== payload.guild_id),
                      guilds: old.guilds.filter(guild => guild.guild_id !== payload.guild_id),
                    }
                  : old,
              );
            }
            break;
          }
          case "GUILD_UPDATE": {
            const guild = packet.d as Guild;
            queryClient.setQueryData<Guild[]>(queryKeys.guilds, old => {
              const existing = old ?? [];
              const index = existing.findIndex(item => item.id === guild.id);
              if (index === -1) {
                return [...existing, guild].sort((a, b) => a.name.localeCompare(b.name));
              }
              const next = [...existing];
              next[index] = guild;
              return next;
            });
            queryClient.setQueryData<Guild>(queryKeys.guildSettings(guild.id), guild);
            break;
          }
          case "USER_UPDATE": {
            const user = packet.d as UserSummary;

            queryClient.setQueryData<CurrentUser>(queryKeys.me, old =>
              old && old.id === user.id ? { ...old, ...user } : old,
            );

            queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old =>
              (old ?? []).map(channel => ({
                ...channel,
                recipients: channel.recipients.map(recipient =>
                  recipient.id === user.id ? { ...recipient, ...user } : recipient,
                ),
                last_message: channel.last_message ? withUpdatedAuthor(channel.last_message, user) : channel.last_message,
              })),
            );

            queryClient.setQueriesData<InfiniteData<MessagePayload[]>>(
              { queryKey: ["messages"] },
              old =>
                old
                  ? {
                      ...old,
                      pages: old.pages.map(page => page.map(message => withUpdatedAuthor(message, user))),
                    }
                  : old,
            );

            const memberQueries = queryClient.getQueryCache().findAll({
              queryKey: ["guild-members"],
            });
            for (const query of memberQueries) {
              const searchQuery =
                typeof query.queryKey[2] === "string" ? query.queryKey[2] : "";
              queryClient.setQueryData<InfiniteData<GuildMembersPage>>(
                query.queryKey,
                old => {
                  if (!old) {
                    return old;
                  }

                  const patched = patchGuildMembersInfinite(old, user.id, member => ({
                    ...member,
                    user: {
                      ...member.user,
                      ...user,
                    },
                  }));

                  if (!patched || !searchQuery) {
                    return patched;
                  }

                  const updatedMember = patched.pages
                    .flatMap(page => page.members)
                    .find(member => member.user.id === user.id);

                  if (updatedMember && !matchesMemberSearch(updatedMember, searchQuery)) {
                    return removeGuildMemberFromInfinite(patched, user.id);
                  }

                  return patched;
                },
              );
            }

            queryClient.setQueriesData<GuildMembersPage>(
              { queryKey: ["guild-members-settings"] },
              old =>
                old
                  ? {
                      ...old,
                      members: old.members.map(member =>
                        member.user.id === user.id
                          ? {
                              ...member,
                              user: {
                                ...member.user,
                                ...user,
                              },
                            }
                          : member,
                      ),
                    }
                  : old,
            );

            queryClient.setQueriesData<{ user: UserSummary }>(
              { queryKey: ["guild-member"] },
              old =>
                old && old.user.id === user.id
                  ? {
                      ...old,
                      user: {
                        ...old.user,
                        ...user,
                      },
                    }
                  : old,
            );
            break;
          }
          case "USER_SETTINGS_UPDATE": {
            const settings = packet.d as CurrentUser["settings"];
            queryClient.setQueryData<CurrentUser>(queryKeys.me, old =>
              old
                ? {
                    ...old,
                    settings: {
                      ...old.settings,
                      ...settings,
                    },
                  }
                : old,
            );
            break;
          }
          default:
            break;
        }
      };

      socket.onclose = () => {
        clearTimers();
        scheduleReconnect();
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    connect().catch(() => {
      scheduleReconnect();
    });

    return () => {
      closedIntentionally = true;
      clearTimers();
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }

      for (const timeoutId of typingTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      typingTimeoutsRef.current.clear();

      if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) {
        socketRef.current.close();
      }
      socketRef.current = null;
      sendPresenceUpdateRef.current = () => undefined;
    };
  }, [activeChannelId, enabled, queryClient, userId]);

  return {
    sendPresenceUpdate: (status: SelfPresenceStatus): void => {
      sendPresenceUpdateRef.current(status);
    },
  } as const;
};
