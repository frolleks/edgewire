import type { GatewayPacket, MessagePayload } from "@discord/types";
import { useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, type DmChannel, type TypingEvent } from "@/lib/api";
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
    pages: current.pages.map(page =>
      page.map(item => (item.id === message.id ? message : item)),
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
            typeof packet.d === "object" &&
            packet.d !== null &&
            "heartbeat_interval" in packet.d
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
            if (packet.d && typeof packet.d === "object" && "private_channels" in packet.d) {
              const channels = (packet.d as { private_channels: DmChannel[] }).private_channels;
              queryClient.setQueryData(queryKeys.channels, channels);
            }
            break;
          }
          case "CHANNEL_CREATE": {
            const channel = packet.d as DmChannel;
            queryClient.setQueryData<DmChannel[]>(queryKeys.channels, old => {
              const existing = old ?? [];
              if (existing.some(item => item.id === channel.id)) {
                return existing;
              }
              return [{ ...channel, unread: Boolean(channel.unread) }, ...existing];
            });
            break;
          }
          case "MESSAGE_CREATE": {
            const message = packet.d as MessagePayload;
            queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
              queryKeys.messages(message.channel_id),
              old => insertNewestMessage(old, message),
            );

            queryClient.setQueryData<DmChannel[]>(queryKeys.channels, old => {
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
              const unread =
                message.author.id !== userId &&
                activeChannelId !== message.channel_id;
              const updatedChannel: DmChannel = {
                ...channel,
                last_message: message,
                last_message_id: message.id,
                unread,
              };

              return [updatedChannel, ...next.filter((_, i) => i !== index)];
            });
            break;
          }
          case "MESSAGE_UPDATE": {
            const message = packet.d as MessagePayload;
            queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
              queryKeys.messages(message.channel_id),
              old => updateMessage(old, message),
            );
            queryClient.setQueryData<DmChannel[]>(queryKeys.channels, old =>
              (old ?? []).map(channel =>
                channel.last_message_id === message.id
                  ? { ...channel, last_message: message }
                  : channel,
              ),
            );
            break;
          }
          case "MESSAGE_DELETE": {
            const payload = packet.d as { id: string; channel_id: string };
            queryClient.setQueryData<InfiniteData<MessagePayload[]>>(
              queryKeys.messages(payload.channel_id),
              old => deleteMessage(old, payload.id),
            );
            queryClient.setQueryData<DmChannel[]>(queryKeys.channels, old =>
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
              queryClient.setQueryData<DmChannel[]>(queryKeys.channels, old =>
                (old ?? []).map(channel =>
                  channel.id === payload.channel_id ? { ...channel, unread: false } : channel,
                ),
              );
            }
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
