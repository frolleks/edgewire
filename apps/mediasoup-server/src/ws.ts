import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyVoiceToken } from "./auth.js";
import type { MediasoupConfig } from "./config.js";
import { cleanupSession, handleRequest, SignalingError, type SignalingSession } from "./protocol/handlers.js";
import {
  requestMethods,
  type ClientRequest,
  type NotificationMethod,
  type ServerNotification,
  type ServerResponse,
} from "./protocol/types.js";
import type { RoomRegistry } from "./rooms/rooms.js";

type WsSession = {
  ws: WebSocket;
  session: SignalingSession;
};

const toJson = (value: unknown): string => JSON.stringify(value);

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

const loopbackHosts = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]);

const splitHeaderValue = (value: string | string[] | undefined): string | null => {
  if (!value) {
    return null;
  }

  const first = (Array.isArray(value) ? value[0] : value).split(",")[0]?.trim();
  return first ? first : null;
};

const stripPort = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1 ? trimmed.slice(1, end) : trimmed;
  }

  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon >= 0 && firstColon === lastColon) {
    return trimmed.slice(0, firstColon);
  }

  return trimmed;
};

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return loopbackHosts.has(normalized) || normalized.startsWith("127.");
};

const resolveRequestHost = (request: IncomingMessage): string | null => {
  const forwardedHost = splitHeaderValue(request.headers["x-forwarded-host"]);
  const hostHeader = forwardedHost ?? splitHeaderValue(request.headers.host) ?? null;
  const host = hostHeader ? stripPort(hostHeader) : "";
  if (host && !isLoopbackHost(host)) {
    return host;
  }

  const origin = splitHeaderValue(request.headers.origin) ?? splitHeaderValue(request.headers["sec-websocket-origin"]);
  if (!origin) {
    return host || null;
  }

  try {
    const parsed = new URL(origin);
    const originHost = parsed.hostname || "";
    return originHost || host || null;
  } catch {
    return host || null;
  }
};

const resolveTransportOverride = (
  request: IncomingMessage,
  config: MediasoupConfig,
): { listenIp: string | null; announcedAddress: string | null } => {
  if (config.announcedAddress || !isLoopbackHost(config.listenIp)) {
    return { listenIp: null, announcedAddress: null };
  }

  const host = resolveRequestHost(request);
  if (!host || isLoopbackHost(host)) {
    return { listenIp: null, announcedAddress: null };
  }

  return {
    listenIp: host.includes(":") ? "::" : "0.0.0.0",
    announcedAddress: host,
  };
};

const safeSend = (ws: WebSocket, payload: unknown): void => {
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(toJson(payload));
};

const parseClientRequest = (
  message: string,
): { request: ClientRequest | null; error?: { id: string; code: string; message: string } } => {
  try {
    const parsed = JSON.parse(message) as Partial<ClientRequest>;
    if (!parsed || typeof parsed !== "object") {
      return { request: null };
    }

    if (typeof parsed.id !== "string") {
      return { request: null };
    }

    if (typeof parsed.method !== "string") {
      return {
        request: null,
        error: {
          id: parsed.id,
          code: "bad_request",
          message: "method is required.",
        },
      };
    }

    if (!(requestMethods as readonly string[]).includes(parsed.method)) {
      return {
        request: null,
        error: {
          id: parsed.id,
          code: "unknown_method",
          message: `Unknown method: ${parsed.method}`,
        },
      };
    }

    return {
      request: {
        id: parsed.id,
        method: parsed.method as ClientRequest["method"],
        data: parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : undefined,
      },
    };
  } catch {
    return { request: null };
  }
};

const errorResponse = (id: string, code: string, message: string): ServerResponse => ({
  id,
  ok: false,
  error: {
    code,
    message,
  },
});

const okResponse = (id: string, data: unknown): ServerResponse => ({
  id,
  ok: true,
  data,
});

export const createWsServer = async (config: MediasoupConfig, rooms: RoomRegistry) => {
  const log = (...args: unknown[]) => {
    if (!config.debugVoice) {
      return;
    }

    console.debug(...args);
  };

  const server = createServer((_, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  const wss = new WebSocketServer({ noServer: true });

  const sessionsByConnectionId = new Map<string, WsSession>();
  const sessionsByPeerId = new Map<string, WsSession>();

  const syncGuildVoiceState = async (roomId: string): Promise<void> => {
    const parsed = parseGuildRoom(roomId);
    if (!parsed) {
      return;
    }

    const room = rooms.get(roomId);
    const roomPeers = room?.listPeers() ?? [];
    const participants = roomPeers.map(peer => ({
        socket_id: peer.id,
        user: peer.user,
        self_mute: peer.state.selfMute,
        self_deaf: peer.state.selfDeaf,
        screen_sharing: peer.state.screenSharing,
      }));

    await fetch(`${config.apiBaseUrl}/api/internal/voice/state`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voice-internal-secret": config.voiceInternalSecret,
      },
      body: JSON.stringify({
        guild_id: parsed.guildId,
        channel_id: parsed.channelId,
        participants,
      }),
    }).catch(() => undefined);
  };

  const notifyRoom = (
    roomId: string,
    method: NotificationMethod,
    data: Record<string, unknown>,
    options?: { excludePeerId?: string },
  ): void => {
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    const notification: ServerNotification = {
      notification: true,
      method,
      data,
    };

    for (const peer of room.listPeers()) {
      if (options?.excludePeerId && peer.id === options.excludePeerId) {
        continue;
      }

      const target = sessionsByPeerId.get(peer.id);
      if (!target) {
        continue;
      }

      safeSend(target.ws, notification);
    }
  };

  const cleanup = async (connectionId: string): Promise<void> => {
    const wsSession = sessionsByConnectionId.get(connectionId);
    if (!wsSession) {
      return;
    }

    sessionsByConnectionId.delete(connectionId);
    if (wsSession.session.peerId) {
      sessionsByPeerId.delete(wsSession.session.peerId);
    }

    await cleanupSession({
      session: wsSession.session,
      rooms,
      verifyVoiceToken,
      voiceTokenSecret: config.voiceTokenSecret,
      debugVoice: config.debugVoice,
      log,
      notifyRoom,
      syncGuildVoiceState,
    });
  };

  wss.on("connection", (ws, request) => {
    const transportOverride = resolveTransportOverride(request, config);
    const connectionId = randomUUID();
    const session: SignalingSession = {
      id: connectionId,
      identified: false,
      joined: false,
      userId: null,
      user: null,
      roomId: null,
      peerId: null,
      transportListenIp: transportOverride.listenIp,
      transportAnnouncedAddress: transportOverride.announcedAddress,
    };

    const wsSession: WsSession = { ws, session };
    sessionsByConnectionId.set(connectionId, wsSession);

    ws.on("message", async raw => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const parsed = parseClientRequest(text);
      if (parsed.error) {
        safeSend(ws, errorResponse(parsed.error.id, parsed.error.code, parsed.error.message));
        return;
      }

      const request = parsed.request;
      if (!request) {
        return;
      }

      try {
        const data = await handleRequest(request.method, request.data, {
          session,
          rooms,
          verifyVoiceToken,
          voiceTokenSecret: config.voiceTokenSecret,
          debugVoice: config.debugVoice,
          log,
          notifyRoom,
          syncGuildVoiceState,
        });

        if (session.peerId) {
          sessionsByPeerId.set(session.peerId, wsSession);
        }

        safeSend(ws, okResponse(request.id, data));
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof (error as { code: unknown }).code === "string" &&
          "message" in error &&
          typeof (error as { message: unknown }).message === "string"
        ) {
          const signalingError = error as SignalingError;
          safeSend(ws, errorResponse(request.id, signalingError.code, signalingError.message));
          return;
        }

        safeSend(ws, errorResponse(request.id, "internal_error", "Unhandled signaling error."));
      }
    });

    ws.on("close", () => {
      void cleanup(connectionId);
    });

    ws.on("error", () => {
      void cleanup(connectionId);
    });
  });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const host = request.headers.host ?? "localhost";
    const url = new URL(request.url ?? "", `http://${host}`);
    if (url.pathname !== config.wsPath) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit("connection", ws, request);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, () => resolve());
  });

  const close = async (): Promise<void> => {
    for (const connectionId of [...sessionsByConnectionId.keys()]) {
      await cleanup(connectionId);
    }

    await new Promise<void>((resolve, reject) => {
      wss.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  return {
    close,
    address: `ws://0.0.0.0:${config.port}${config.wsPath}`,
  };
};
