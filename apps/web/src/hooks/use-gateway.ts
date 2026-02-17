import type {
  DmChannelPayload,
  GatewayPacket,
  GuildChannelPayload,
  GuildCreateEvent,
  GuildMemberListItem,
  GuildRole,
  MessagePayload,
  ReadyEvent,
  UserSummary,
} from "@discord/types";
import { useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, type DmChannel, type Guild, type Role, type TypingEvent } from "@/lib/api";
import { GATEWAY_URL } from "@/lib/env";
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
  message: MessagePayload,
): InfiniteData<MessagePayload[]> | undefined => {
  if (!current) {
    return current;
  }

  return {
    ...current,
    pages: current.pages.map(page => page.map(item => (item.id === message.id ? message : item))),
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

export const useGateway = ({ enabled, userId, activeChannelId }: GatewayParams): void => {
  const queryClient = useQueryClient();
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const firstHeartbeatTimeoutRef = useRef<number | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const lastSequenceRef = useRef<number | null>(null);
  const typingTimeoutsRef = useRef<Map<string, number>>(new Map());

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
            const message = packet.d as MessagePayload;
            queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
              queryKeys.messages(message.channel_id),
              old => updateMessage(old, message),
            );

            if (message.guild_id === null) {
              queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old =>
                (old ?? []).map(channel =>
                  channel.last_message_id === message.id ? { ...channel, last_message: message } : channel,
                ),
              );
            }
            break;
          }
          case "MESSAGE_DELETE": {
            const payload = packet.d as { id: string; channel_id: string };
            queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
              queryKeys.messages(payload.channel_id),
              old => deleteMessage(old, payload.id),
            );

            queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old =>
              (old ?? []).map(channel =>
                channel.last_message_id === payload.id
                  ? { ...channel, last_message: null, last_message_id: null }
                  : channel,
              ),
            );
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
            const payload = packet.d as { guild_id: string; user: { id: string }; roles: string[] };
            queryClient.setQueriesData<GuildMemberListItem[]>(
              { queryKey: ["guild-members", payload.guild_id] },
              old =>
                (old ?? []).map(member =>
                  member.user.id === payload.user.id ? { ...member, roles: payload.roles } : member,
                ),
            );
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

            queryClient.setQueryData<UserSummary>(queryKeys.me, old =>
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

            queryClient.setQueriesData<GuildMemberListItem[]>(
              { queryKey: ["guild-members"] },
              old =>
                old
                  ? old.map(member =>
                      member.user.id === user.id
                        ? {
                            ...member,
                            user,
                          }
                        : member,
                    )
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
    };
  }, [activeChannelId, enabled, queryClient, userId]);
};
