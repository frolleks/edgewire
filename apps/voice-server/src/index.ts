import { verifyVoiceToken } from "./auth";
import { getConnectionBySocketId, listRoomConnections, registerConnection, removeConnection } from "./rooms";
import type { VoiceConnection, VoicePeerState, VoiceSocketData } from "./types";

const PORT = Number(process.env.VOICE_PORT ?? 3002);
const VOICE_TOKEN_SECRET = process.env.VOICE_TOKEN_SECRET ?? "dev-voice-secret-change-me";
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3001";
const VOICE_INTERNAL_SECRET = process.env.VOICE_INTERNAL_SECRET ?? "dev-voice-internal-secret-change-me";
const MAX_ICE_PER_WINDOW = 120;
const ICE_WINDOW_MS = 10_000;

const initialState: VoicePeerState = {
  self_mute: false,
  self_deaf: false,
  screen_sharing: false,
};

const send = (ws: Bun.ServerWebSocket<VoiceSocketData>, op: string, d: Record<string, unknown>): void => {
  try {
    ws.send(JSON.stringify({ op, d }));
  } catch {
    // ignored
  }
};

const broadcastRoom = (roomId: string, op: string, d: Record<string, unknown>, excludeSocketId?: string): void => {
  for (const peer of listRoomConnections(roomId)) {
    if (excludeSocketId && peer.socketId === excludeSocketId) {
      continue;
    }
    send(peer.ws, op, d);
  }
};

const parsePacket = (raw: string): { op: string; d: Record<string, unknown> } | null => {
  try {
    const parsed = JSON.parse(raw) as { op?: string; d?: Record<string, unknown> };
    if (!parsed.op || typeof parsed.op !== "string") {
      return null;
    }
    return {
      op: parsed.op,
      d: parsed.d ?? {},
    };
  } catch {
    return null;
  }
};

const connectionById = new Map<string, VoiceConnection>();

const parseGuildRoom = (roomId: string): { guildId: string; channelId: string } | null => {
  const match = roomId.match(/^guild:([^:]+):voice:([^:]+)$/);
  if (!match) {
    return null;
  }
  return {
    guildId: match[1] ?? "",
    channelId: match[2] ?? "",
  };
};

const syncGuildVoiceState = async (roomId: string): Promise<void> => {
  const parsed = parseGuildRoom(roomId);
  if (!parsed) {
    return;
  }

  const participants = listRoomConnections(roomId).map((connection) => ({
    socket_id: connection.socketId,
    user: connection.user,
    self_mute: connection.state.self_mute,
    self_deaf: connection.state.self_deaf,
    screen_sharing: connection.state.screen_sharing,
  }));

  await fetch(`${API_BASE_URL}/api/internal/voice/state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-voice-internal-secret": VOICE_INTERNAL_SECRET,
    },
    body: JSON.stringify({
      guild_id: parsed.guildId,
      channel_id: parsed.channelId,
      participants,
    }),
  }).catch(() => undefined);
};

const server = Bun.serve<VoiceSocketData>({
  port: PORT,
  fetch(request, serverInstance) {
    const url = new URL(request.url);
    if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") {
      const upgraded = serverInstance.upgrade(request, {
        data: {
          connectionId: crypto.randomUUID(),
          token: url.searchParams.get("token"),
        },
      });
      if (upgraded) {
        return undefined;
      }
      return new Response("Upgrade failed", { status: 400 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const token = ws.data.token;
      if (!token) {
        send(ws, "ERROR", { message: "Missing token." });
        ws.close(4001, "Missing token");
        return;
      }

      const verification = verifyVoiceToken(token, VOICE_TOKEN_SECRET);
      const payload = verification.payload;
      if (!payload) {
        if (verification.error === "expired") {
          send(ws, "ERROR", { message: "Voice token expired." });
          ws.close(4002, "Expired token");
          return;
        }

        send(ws, "ERROR", { message: "Voice token invalid." });
        ws.close(4001, "Invalid token");
        return;
      }

      const roomId =
        payload.room.kind === "dm"
          ? `dm:${payload.room.channelId}`
          : `guild:${payload.room.guildId}:voice:${payload.room.channelId}`;

      if (payload.room.kind === "guild" && !payload.room.guildId) {
        send(ws, "ERROR", { message: "Not authorized for room." });
        ws.close(4003, "Not authorized for room");
        return;
      }

      const socketId = crypto.randomUUID();
      const connection: VoiceConnection = {
        connectionId: ws.data.connectionId,
        socketId,
        userId: payload.sub,
        roomId,
        state: { ...initialState },
        iceForwardCount: 0,
        iceForwardWindowStartedAt: Date.now(),
        ws,
        user: payload.user,
      };

      connectionById.set(connection.connectionId, connection);
      registerConnection(connection);

      send(ws, "VOICE_STATE", {
        state: "auth_ok",
        room_id: roomId,
        self_socket_id: socketId,
      });

      const peers = listRoomConnections(roomId)
        .filter((peer) => peer.socketId !== socketId)
        .map((peer) => ({
          socketId: peer.socketId,
          user: peer.user,
          state: peer.state,
        }));

      send(ws, "READY", {
        self: {
          socketId,
          user: payload.user,
          state: connection.state,
        },
        room: {
          roomId,
        },
        peers,
      });

      broadcastRoom(
        roomId,
        "PEER_JOINED",
        {
          peer: {
            socketId,
            user: payload.user,
            state: connection.state,
          },
        },
        socketId,
      );
      void syncGuildVoiceState(roomId);
    },

    message(ws, data) {
      const connection = connectionById.get(ws.data.connectionId);
      if (!connection) {
        return;
      }

      const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      const packet = parsePacket(raw);
      if (!packet) {
        return;
      }

      if (packet.op === "LEAVE") {
        ws.close(1000, "Leave");
        return;
      }

      if (packet.op === "PING") {
        send(ws, "PONG", {
          ts: packet.d.ts ?? Date.now(),
        });
        return;
      }

      if (packet.op === "MUTE_STATE") {
        connection.state = {
          self_mute: Boolean(packet.d.self_mute),
          self_deaf: Boolean(packet.d.self_deaf),
          screen_sharing: Boolean(packet.d.screen_sharing),
        };
        connectionById.set(connection.connectionId, connection);
        broadcastRoom(connection.roomId, "PEER_STATE_UPDATE", {
          socketId: connection.socketId,
          state: connection.state,
        });
        void syncGuildVoiceState(connection.roomId);
        return;
      }

      if (packet.op === "SIGNAL_OFFER" || packet.op === "SIGNAL_ANSWER" || packet.op === "SIGNAL_ICE") {
        const to = typeof packet.d.to === "string" ? packet.d.to : null;
        if (!to) {
          return;
        }

        const target = getConnectionBySocketId(to);
        if (!target || target.roomId !== connection.roomId) {
          return;
        }

        if (packet.op === "SIGNAL_ICE") {
          const now = Date.now();
          if (now - connection.iceForwardWindowStartedAt > ICE_WINDOW_MS) {
            connection.iceForwardWindowStartedAt = now;
            connection.iceForwardCount = 0;
          }
          connection.iceForwardCount += 1;
          if (connection.iceForwardCount > MAX_ICE_PER_WINDOW) {
            return;
          }
        }

        send(target.ws, packet.op, {
          ...packet.d,
          from: connection.socketId,
        });
      }
    },

    close(ws) {
      const connection = connectionById.get(ws.data.connectionId);
      if (!connection) {
        return;
      }

      connectionById.delete(connection.connectionId);
      removeConnection(connection.socketId);
      broadcastRoom(connection.roomId, "PEER_LEFT", { socketId: connection.socketId });
      void syncGuildVoiceState(connection.roomId);
    },
  },
});

console.log(`Voice signaling server listening on ${server.url}`);
