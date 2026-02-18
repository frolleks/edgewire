import { createHmac, timingSafeEqual } from "node:crypto";

export type VoiceUser = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

export type VoiceTokenPayload = {
  sub: string;
  roomId?: string;
  room?: {
    kind: "guild" | "dm";
    guildId?: string;
    channelId: string;
  };
  exp: number;
  iat: number;
  sessionId?: string;
  user?: VoiceUser;
};

export type VerifiedVoiceIdentity = {
  userId: string;
  roomId: string;
  user: VoiceUser;
};

const fromBase64Url = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

const sign = (secret: string, payloadPart: string): string =>
  createHmac("sha256", secret).update(payloadPart).digest("base64url");

const roomIdPattern = /^(dm:[^:]+|guild:[^:]+:voice:[^:]+)$/;

const toRoomId = (payload: VoiceTokenPayload): string | null => {
  if (payload.roomId) {
    return payload.roomId;
  }

  if (!payload.room) {
    return null;
  }

  if (payload.room.kind === "dm") {
    return `dm:${payload.room.channelId}`;
  }

  if (!payload.room.guildId) {
    return null;
  }

  return `guild:${payload.room.guildId}:voice:${payload.room.channelId}`;
};

export const verifyVoiceToken = (
  token: string,
  secret: string,
): { identity: VerifiedVoiceIdentity | null; error: "invalid" | "expired" | null } => {
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) {
    return { identity: null, error: "invalid" };
  }

  const expected = sign(secret, payloadPart);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signaturePart);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { identity: null, error: "invalid" };
  }

  try {
    const payload = JSON.parse(fromBase64Url(payloadPart)) as VoiceTokenPayload;
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (!payload.exp || payload.exp <= nowSeconds) {
      return { identity: null, error: "expired" };
    }

    const roomId = toRoomId(payload);
    if (!payload.sub || !roomId) {
      return { identity: null, error: "invalid" };
    }
    if (!roomIdPattern.test(roomId)) {
      return { identity: null, error: "invalid" };
    }
    if (payload.user?.id && payload.user.id !== payload.sub) {
      return { identity: null, error: "invalid" };
    }

    const user: VoiceUser = {
      id: payload.user?.id ?? payload.sub,
      username: payload.user?.username ?? "unknown",
      display_name: payload.user?.display_name ?? payload.user?.username ?? "Unknown",
      avatar_url: payload.user?.avatar_url ?? null,
    };

    return {
      identity: {
        userId: payload.sub,
        roomId,
        user,
      },
      error: null,
    };
  } catch {
    return { identity: null, error: "invalid" };
  }
};
