import type { GatewayPacket } from "@discord/types";
import { apiNotFoundAfterAuth, internalServerError } from "./controllers/common";
import { startUploadCleanupTask } from "./controllers/uploads";
import { env } from "./env";
import { corsPreflight } from "./http";
import { getUserSummaryById } from "./lib/users";
import { routes } from "./routes";
import {
  persistAndApplyPresencePreference,
  pruneStalePresenceConnections,
  registerPresenceConnection,
  touchPresenceHeartbeat,
  unregisterPresenceConnection,
  updatePresenceFromGateway,
  type SelfPresenceStatus,
} from "./presence/presence-store";
import {
  GatewayOp,
  HEARTBEAT_INTERVAL_MS,
  addConnectionToUser,
  consumeGatewayToken,
  gatewayConnections,
  now,
  removeConnectionFromUser,
  sendPacket,
  sendReadyAndBackfillGuilds,
  startZombieMonitor,
  type GatewayConnection,
  type WsData,
} from "./runtime";

startUploadCleanupTask();

const PRESENCE_STALE_MS = 45_000;
const PRESENCE_CLEANUP_INTERVAL_MS = 15_000;

setInterval(() => {
  void pruneStalePresenceConnections(PRESENCE_STALE_MS).then(staleConnectionIds => {
    for (const connectionId of staleConnectionIds) {
      const connection = gatewayConnections.get(connectionId);
      if (!connection) {
        continue;
      }

      try {
        connection.ws.close(4000, "Heartbeat timeout");
      } catch {
        // ignored
      }
    }
  });
}, PRESENCE_CLEANUP_INTERVAL_MS);

const server = Bun.serve<WsData>({
  port: env.PORT,
  routes,
  fetch: async (request, serverInstance) => {
    const pathname = new URL(request.url).pathname;

    if (request.method === "OPTIONS" && (pathname === "/gateway" || pathname === "/api/gateway")) {
      return corsPreflight(request);
    }

    if ((pathname === "/gateway" || pathname === "/api/gateway") && request.headers.get("upgrade") === "websocket") {
      const upgraded = serverInstance.upgrade(request, {
        data: {
          connectionId: crypto.randomUUID(),
        },
      });

      if (upgraded) {
        return undefined;
      }

      return new Response("Upgrade failed", { status: 400 });
    }

    if (pathname.startsWith("/api")) {
      try {
        return await apiNotFoundAfterAuth(request);
      } catch (error) {
        console.error("Unhandled API error", error);
        return internalServerError(request);
      }
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const connection: GatewayConnection = {
        id: ws.data.connectionId,
        ws,
        userId: null,
        identified: false,
        sessionId: null,
        seq: 0,
        lastHeartbeatAt: now(),
      };

      gatewayConnections.set(connection.id, connection);
      sendPacket(connection, {
        op: GatewayOp.HELLO,
        d: {
          heartbeat_interval: HEARTBEAT_INTERVAL_MS,
        },
        s: null,
        t: null,
      });

      startZombieMonitor(connection);
    },

    async message(ws, message) {
      const connection = gatewayConnections.get(ws.data.connectionId);
      if (!connection) {
        try {
          ws.close(4001, "Unknown connection");
        } catch {
          // ignored
        }
        return;
      }

      let payload: GatewayPacket;
      try {
        const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
        payload = JSON.parse(raw) as GatewayPacket;
      } catch {
        sendPacket(connection, {
          op: GatewayOp.INVALID_SESSION,
          d: false,
          s: null,
          t: null,
        });
        return;
      }

      if (payload.op === GatewayOp.HEARTBEAT) {
        connection.lastHeartbeatAt = now();
        void touchPresenceHeartbeat(connection.id);
        sendPacket(connection, {
          op: GatewayOp.HEARTBEAT_ACK,
          s: null,
          t: null,
        });
        return;
      }

      if (payload.op === GatewayOp.IDENTIFY) {
        const token = (payload.d as { token?: string } | undefined)?.token;
        if (!token) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        const userId = consumeGatewayToken(token);
        if (!userId) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        const user = await getUserSummaryById(userId);
        if (!user) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        connection.userId = userId;
        connection.identified = true;
        connection.sessionId = crypto.randomUUID();
        connection.lastHeartbeatAt = now();

        addConnectionToUser(userId, connection.id);
        await registerPresenceConnection(connection.id, userId);
        await sendReadyAndBackfillGuilds(connection, user);
        return;
      }

      if (payload.op === GatewayOp.RESUME) {
        const resume = payload.d as { token?: string; session_id?: string; seq?: number } | undefined;
        if (!resume?.token) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        const userId = consumeGatewayToken(resume.token);
        if (!userId) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        const user = await getUserSummaryById(userId);
        if (!user) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        connection.userId = userId;
        connection.identified = true;
        connection.seq = typeof resume.seq === "number" ? resume.seq : connection.seq;
        connection.sessionId = resume.session_id ?? crypto.randomUUID();
        connection.lastHeartbeatAt = now();

        addConnectionToUser(userId, connection.id);
        await registerPresenceConnection(connection.id, userId);
        await sendReadyAndBackfillGuilds(connection, user);
        return;
      }

      if (payload.op === 3) {
        if (!connection.identified || !connection.userId) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        const status = (payload.d as { status?: SelfPresenceStatus } | undefined)?.status;
        if (!status || !["online", "idle", "dnd", "invisible"].includes(status)) {
          sendPacket(connection, {
            op: GatewayOp.INVALID_SESSION,
            d: false,
            s: null,
            t: null,
          });
          return;
        }

        if (status === "online" || status === "dnd" || status === "invisible") {
          await persistAndApplyPresencePreference(connection.userId, status);
          return;
        }

        await updatePresenceFromGateway(connection.id, status);
        return;
      }

      sendPacket(connection, {
        op: GatewayOp.INVALID_SESSION,
        d: false,
        s: null,
        t: null,
      });
    },

    close(ws) {
      const connection = gatewayConnections.get(ws.data.connectionId);
      if (!connection) {
        return;
      }

      if (connection.zombieTimer) {
        clearInterval(connection.zombieTimer);
      }

      if (connection.userId) {
        removeConnectionFromUser(connection.userId, connection.id);
      }

      void unregisterPresenceConnection(connection.id);

      gatewayConnections.delete(connection.id);
    },
  },
});

console.log(`API server listening on ${server.url}`);
