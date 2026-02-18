import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env";

type VoiceTokenPayload = {
  sub: string;
  roomId?: string;
  room: {
    kind: "guild" | "dm";
    guildId?: string;
    channelId: string;
  };
  exp: number;
  iat: number;
  sessionId: string;
  user: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
};

const toBase64Url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

const fromBase64Url = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

const sign = (payloadPart: string): string =>
  createHmac("sha256", env.VOICE_TOKEN_SECRET).update(payloadPart).digest("base64url");

export const createVoiceToken = (payload: Omit<VoiceTokenPayload, "iat" | "exp">, ttlSeconds = 120): string => {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const fullPayload: VoiceTokenPayload = {
    ...payload,
    iat,
    exp,
  };
  const payloadPart = toBase64Url(JSON.stringify(fullPayload));
  return `${payloadPart}.${sign(payloadPart)}`;
};

export const verifyVoiceToken = (token: string): VoiceTokenPayload | null => {
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) {
    return null;
  }

  const expectedSignature = sign(payloadPart);
  const signatureBuffer = Buffer.from(signaturePart);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(payloadPart)) as VoiceTokenPayload;
    const hasLegacyRoom = Boolean(payload.room?.channelId);
    const hasRoomId = typeof payload.roomId === "string" && payload.roomId.length > 0;
    if (!payload.sub || (!hasLegacyRoom && !hasRoomId) || !payload.exp) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};

export type { VoiceTokenPayload };
