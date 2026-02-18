import { ChannelType } from "@discord/types";
import type { BunRequest } from "bun";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { channelMembers, channels } from "../db/schema";
import { env } from "../env";
import { badRequest, forbidden, json, parseJson, requireAuth } from "../http";
import { createVoiceToken } from "../lib/voice-token";
import { PermissionBits } from "../lib/permissions";
import { hasChannelPermission, listVisibleGuildChannelsForUser } from "../lib/permission-service";
import { getGuildVoiceState, setGuildVoiceChannelState, type GuildVoiceParticipant } from "../voice/state";

type CreateVoiceTokenBody = {
  kind?: "guild" | "dm";
  guild_id?: string;
  channel_id?: string;
};

const normalizeRoomId = (params: { kind: "guild" | "dm"; guildId?: string; channelId: string }): string => {
  if (params.kind === "dm") {
    return `dm:${params.channelId}`;
  }

  return `guild:${params.guildId}:voice:${params.channelId}`;
};

const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

const splitHeaderValue = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const first = value.split(",")[0]?.trim();
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

const resolveMediasoupWsUrl = (request: Request): string => {
  const fallback = env.MEDIASOUP_WS_URL;

  let parsed: URL;
  try {
    parsed = new URL(fallback);
  } catch {
    return fallback;
  }

  if (!localHostnames.has(parsed.hostname)) {
    return parsed.toString();
  }

  const forwardedHost = splitHeaderValue(request.headers.get("x-forwarded-host"));
  const requestHost = splitHeaderValue(request.headers.get("host"));
  const originHost = (() => {
    const origin = request.headers.get("origin");
    if (!origin) {
      return null;
    }

    try {
      return new URL(origin).hostname || null;
    } catch {
      return null;
    }
  })();

  const host = stripPort(forwardedHost ?? requestHost ?? "");
  const resolvedHost = host && !localHostnames.has(host) ? host : originHost;
  if (!resolvedHost || localHostnames.has(resolvedHost)) {
    return parsed.toString();
  }

  parsed.hostname = resolvedHost;

  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto === "https") {
    parsed.protocol = "wss:";
  } else if (forwardedProto === "http") {
    parsed.protocol = "ws:";
  }

  return parsed.toString();
};

export const createVoiceTokenEndpoint = async (request: BunRequest<"/api/voice/token">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = (await parseJson<CreateVoiceTokenBody>(request)) as CreateVoiceTokenBody;
  const kind = body?.kind;
  const channelId = body?.channel_id;
  if (!kind || !channelId || (kind !== "guild" && kind !== "dm")) {
    return badRequest(request, "kind and channel_id are required.");
  }

  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
  });
  if (!channel) {
    return forbidden(request);
  }

  if (kind === "guild") {
    if (!channel.guildId || channel.type !== ChannelType.GUILD_VOICE) {
      return forbidden(request);
    }

    const canView = await hasChannelPermission(authResult.user.id, channelId, PermissionBits.VIEW_CHANNEL);
    const canConnect = await hasChannelPermission(authResult.user.id, channelId, PermissionBits.CONNECT);
    if (!canView || !canConnect) {
      return forbidden(request);
    }

    const roomId = normalizeRoomId({
      kind,
      guildId: channel.guildId,
      channelId,
    });

    const token = createVoiceToken({
      sub: authResult.user.id,
      roomId,
      room: {
        kind,
        guildId: channel.guildId,
        channelId,
      },
      sessionId: crypto.randomUUID(),
      user: {
        id: authResult.user.id,
        username: authResult.user.username,
        display_name: authResult.user.display_name,
        avatar_url: authResult.user.avatar_url,
      },
    });

    const mediasoupWsUrl = resolveMediasoupWsUrl(request);
    return json(request, {
      token,
      mediasoup_ws_url: mediasoupWsUrl,
      voice_ws_url: mediasoupWsUrl,
      room_id: roomId,
      ice_servers: env.ICE_SERVERS,
    });
  }

  const dmMembership = await db.query.channelMembers.findFirst({
    where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, authResult.user.id)),
  });
  if (!dmMembership || channel.type !== ChannelType.DM) {
    return forbidden(request);
  }

  const roomId = normalizeRoomId({ kind, channelId });
  const token = createVoiceToken({
    sub: authResult.user.id,
    roomId,
    room: {
      kind,
      channelId,
    },
    sessionId: crypto.randomUUID(),
    user: {
      id: authResult.user.id,
      username: authResult.user.username,
      display_name: authResult.user.display_name,
      avatar_url: authResult.user.avatar_url,
    },
  });

  const mediasoupWsUrl = resolveMediasoupWsUrl(request);
  return json(request, {
    token,
    mediasoup_ws_url: mediasoupWsUrl,
    voice_ws_url: mediasoupWsUrl,
    room_id: roomId,
    ice_servers: env.ICE_SERVERS,
  });
};

export const getGuildVoiceStateEndpoint = async (request: BunRequest<"/api/guilds/:guildId/voice-state">): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const guildId = request.params.guildId;
  if (!guildId) {
    return badRequest(request, "Invalid guild id.");
  }

  const visibleChannels = await listVisibleGuildChannelsForUser(authResult.user.id, guildId);
  const visibleSet = new Set(visibleChannels.map(channel => channel.id));
  const state = getGuildVoiceState(guildId);
  const filtered = Object.fromEntries(
    Object.entries(state).filter(([channelId]) => visibleSet.has(channelId)),
  );

  return json(request, filtered);
};

export const syncGuildVoiceStateEndpoint = async (
  request: BunRequest<"/api/internal/voice/state">,
): Promise<Response> => {
  const token = request.headers.get("x-voice-internal-secret");
  if (!token || token !== env.VOICE_INTERNAL_SECRET) {
    return forbidden(request);
  }

  const body = await parseJson<{
    guild_id?: string;
    channel_id?: string;
    participants?: GuildVoiceParticipant[];
  }>(request);

  if (!body || !body.guild_id || !body.channel_id || !Array.isArray(body.participants)) {
    return badRequest(request, "guild_id, channel_id, participants are required.");
  }

  await setGuildVoiceChannelState(body.guild_id, body.channel_id, body.participants);
  return json(request, { ok: true });
};
