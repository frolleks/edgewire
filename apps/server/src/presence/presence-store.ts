import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { userSettings } from "../db/schema";
import { emitToUsers, getUserAudienceIds } from "../runtime";

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";
export type SelfPresenceStatus = PresenceStatus | "invisible";
export type PersistedPresenceStatus = "online" | "dnd" | "invisible";

type ConnectionPresence = {
  userId: string;
  status: Exclude<SelfPresenceStatus, "offline">;
  lastActiveAt: number;
  lastHeartbeatAt: number;
};

type UserAggregatePresence = {
  statusForSelf: SelfPresenceStatus;
  statusForOthers: PresenceStatus;
  lastSeenAt: number;
  connections: number;
};

type PresenceAudienceCacheEntry = {
  userIds: string[];
  expiresAt: number;
};

const AUDIENCE_TTL_MS = 30_000;

export const connectionPresence = new Map<string, ConnectionPresence>();
export const userAggregatePresence = new Map<string, UserAggregatePresence>();

const userPresencePreference = new Map<string, PersistedPresenceStatus>();
const presenceAudienceCache = new Map<string, PresenceAudienceCacheEntry>();

const now = (): number => Date.now();

const toIso = (value: number): string => new Date(value).toISOString();

const normalizePersistedStatus = (value: string | null | undefined): PersistedPresenceStatus => {
  if (value === "dnd" || value === "invisible") {
    return value;
  }
  return "online";
};

const buildAggregatePresence = (userId: string): UserAggregatePresence => {
  const preference = userPresencePreference.get(userId) ?? "online";
  const userConnections = [...connectionPresence.values()].filter(connection => connection.userId === userId);
  const connectionCount = userConnections.length;
  const latestHeartbeat = userConnections.reduce((latest, connection) => Math.max(latest, connection.lastHeartbeatAt), 0);
  const previous = userAggregatePresence.get(userId);
  const lastSeenAt = latestHeartbeat > 0 ? latestHeartbeat : (previous?.lastSeenAt ?? now());

  if (connectionCount === 0) {
    return {
      statusForSelf: "offline",
      statusForOthers: "offline",
      lastSeenAt,
      connections: 0,
    };
  }

  if (preference === "invisible") {
    return {
      statusForSelf: "invisible",
      statusForOthers: "offline",
      lastSeenAt,
      connections: connectionCount,
    };
  }

  if (userConnections.some(connection => connection.status === "dnd")) {
    return {
      statusForSelf: "dnd",
      statusForOthers: "dnd",
      lastSeenAt,
      connections: connectionCount,
    };
  }

  if (userConnections.some(connection => connection.status === "online")) {
    return {
      statusForSelf: "online",
      statusForOthers: "online",
      lastSeenAt,
      connections: connectionCount,
    };
  }

  return {
    statusForSelf: "idle",
    statusForOthers: "idle",
    lastSeenAt,
    connections: connectionCount,
  };
};

const ensurePresencePreferenceLoaded = async (userId: string): Promise<PersistedPresenceStatus> => {
  const cached = userPresencePreference.get(userId);
  if (cached) {
    return cached;
  }

  const row = await db.query.userSettings.findFirst({
    columns: {
      presenceStatus: true,
    },
    where: eq(userSettings.userId, userId),
  });

  const status = normalizePersistedStatus(row?.presenceStatus);
  userPresencePreference.set(userId, status);
  return status;
};

const resolvePresenceAudience = async (userId: string): Promise<string[]> => {
  const cached = presenceAudienceCache.get(userId);
  const ts = now();
  if (cached && cached.expiresAt > ts) {
    return cached.userIds;
  }

  const userIds = await getUserAudienceIds(userId);
  presenceAudienceCache.set(userId, {
    userIds,
    expiresAt: ts + AUDIENCE_TTL_MS,
  });
  return userIds;
};

const broadcastPresence = async (
  userId: string,
  previous: UserAggregatePresence | undefined,
  next: UserAggregatePresence,
): Promise<void> => {
  const visibleStatusChanged = previous?.statusForOthers !== next.statusForOthers;
  const selfStatusChanged = previous?.statusForSelf !== next.statusForSelf;
  const lastSeenChanged = previous?.lastSeenAt !== next.lastSeenAt;

  if (!visibleStatusChanged && !selfStatusChanged && !lastSeenChanged) {
    return;
  }

  if (visibleStatusChanged || lastSeenChanged) {
    const audience = await resolvePresenceAudience(userId);
    emitToUsers(audience, "PRESENCE_UPDATE", {
      user_id: userId,
      status: next.statusForOthers,
      last_seen_at: toIso(next.lastSeenAt),
    });
  }

  if (selfStatusChanged || lastSeenChanged) {
    emitToUsers([userId], "PRESENCE_SELF_UPDATE", {
      status: next.statusForSelf,
      last_seen_at: toIso(next.lastSeenAt),
    });
  }
};

const recomputeAndBroadcast = async (userId: string): Promise<UserAggregatePresence> => {
  const previous = userAggregatePresence.get(userId);
  const next = buildAggregatePresence(userId);
  userAggregatePresence.set(userId, next);
  await broadcastPresence(userId, previous, next);
  return next;
};

export const getPresenceStatusForViewer = (targetUserId: string, viewerUserId: string): PresenceStatus | SelfPresenceStatus => {
  const aggregate = userAggregatePresence.get(targetUserId);
  if (!aggregate) {
    return "offline";
  }

  if (targetUserId === viewerUserId) {
    return aggregate.statusForSelf;
  }

  return aggregate.statusForOthers;
};

export const getPresenceStatusForOthers = (targetUserId: string): PresenceStatus =>
  userAggregatePresence.get(targetUserId)?.statusForOthers ?? "offline";

export const registerPresenceConnection = async (connectionId: string, userId: string): Promise<void> => {
  const preference = await ensurePresencePreferenceLoaded(userId);
  const ts = now();
  connectionPresence.set(connectionId, {
    userId,
    status: preference,
    lastActiveAt: ts,
    lastHeartbeatAt: ts,
  });

  await recomputeAndBroadcast(userId);
};

export const unregisterPresenceConnection = async (connectionId: string): Promise<void> => {
  const existing = connectionPresence.get(connectionId);
  if (!existing) {
    return;
  }

  connectionPresence.delete(connectionId);
  const previous = userAggregatePresence.get(existing.userId);
  const next = buildAggregatePresence(existing.userId);
  next.lastSeenAt = now();
  userAggregatePresence.set(existing.userId, next);
  await broadcastPresence(existing.userId, previous, next);
};

export const touchPresenceHeartbeat = async (connectionId: string): Promise<void> => {
  const existing = connectionPresence.get(connectionId);
  if (!existing) {
    return;
  }

  const ts = now();
  existing.lastHeartbeatAt = ts;
  existing.lastActiveAt = ts;
  connectionPresence.set(connectionId, existing);

  const previous = userAggregatePresence.get(existing.userId);
  if (!previous) {
    await recomputeAndBroadcast(existing.userId);
    return;
  }

  if (previous.lastSeenAt !== ts) {
    const next = {
      ...previous,
      lastSeenAt: ts,
    };
    userAggregatePresence.set(existing.userId, next);
    await broadcastPresence(existing.userId, previous, next);
  }
};

export const updatePresenceFromGateway = async (
  connectionId: string,
  status: Exclude<SelfPresenceStatus, "offline">,
): Promise<UserAggregatePresence | null> => {
  const existing = connectionPresence.get(connectionId);
  if (!existing) {
    return null;
  }

  const ts = now();
  if (status === "idle") {
    existing.status = "idle";
    existing.lastActiveAt = ts;
    existing.lastHeartbeatAt = ts;
    connectionPresence.set(connectionId, existing);
    return recomputeAndBroadcast(existing.userId);
  }

  const persisted = normalizePersistedStatus(status);
  userPresencePreference.set(existing.userId, persisted);

  for (const [id, presence] of connectionPresence.entries()) {
    if (presence.userId !== existing.userId) {
      continue;
    }
    presence.status = persisted;
    presence.lastActiveAt = ts;
    presence.lastHeartbeatAt = ts;
    connectionPresence.set(id, presence);
  }

  return recomputeAndBroadcast(existing.userId);
};

export const applyPersistedPresencePreference = async (
  userId: string,
  status: PersistedPresenceStatus,
): Promise<void> => {
  userPresencePreference.set(userId, status);
  const ts = now();

  for (const [id, presence] of connectionPresence.entries()) {
    if (presence.userId !== userId) {
      continue;
    }
    presence.status = status;
    presence.lastActiveAt = ts;
    presence.lastHeartbeatAt = ts;
    connectionPresence.set(id, presence);
  }

  await recomputeAndBroadcast(userId);
};

export const persistAndApplyPresencePreference = async (
  userId: string,
  status: PersistedPresenceStatus,
): Promise<void> => {
  await db
    .insert(userSettings)
    .values({
      userId,
      presenceStatus: status,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        presenceStatus: status,
        updatedAt: new Date(),
      },
    });

  await applyPersistedPresencePreference(userId, status);
};

export const warmPresenceForUsers = async (userIds: string[]): Promise<void> => {
  const unique = [...new Set(userIds.filter(Boolean))];
  const missing = unique.filter(userId => !userPresencePreference.has(userId));
  if (missing.length === 0) {
    return;
  }

  const rows = await db
    .select({
      userId: userSettings.userId,
      presenceStatus: userSettings.presenceStatus,
    })
    .from(userSettings)
    .where(inArray(userSettings.userId, missing));

  const statusByUser = new Map(rows.map(row => [row.userId, normalizePersistedStatus(row.presenceStatus)]));
  for (const userId of missing) {
    userPresencePreference.set(userId, statusByUser.get(userId) ?? "online");
  }
};

export const pruneStalePresenceConnections = async (maxIdleMs: number): Promise<string[]> => {
  const ts = now();
  const staleConnectionIds: string[] = [];
  const affectedUsers = new Set<string>();

  for (const [connectionId, presence] of connectionPresence.entries()) {
    if (ts - presence.lastHeartbeatAt <= maxIdleMs) {
      continue;
    }

    staleConnectionIds.push(connectionId);
    affectedUsers.add(presence.userId);
    connectionPresence.delete(connectionId);
  }

  for (const userId of affectedUsers) {
    const previous = userAggregatePresence.get(userId);
    const next = buildAggregatePresence(userId);
    next.lastSeenAt = ts;
    userAggregatePresence.set(userId, next);
    await broadcastPresence(userId, previous, next);
  }

  return staleConnectionIds;
};

export const getPresenceSnapshotForUser = (userId: string): UserAggregatePresence =>
  userAggregatePresence.get(userId) ?? {
    statusForSelf: "offline",
    statusForOthers: "offline",
    lastSeenAt: now(),
    connections: 0,
  };
