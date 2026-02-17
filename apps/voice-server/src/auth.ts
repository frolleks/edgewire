import { createHmac, timingSafeEqual } from "node:crypto";
import type { VoiceTokenPayload } from "./types";

const fromBase64Url = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

const sign = (secret: string, payloadPart: string): string =>
  createHmac("sha256", secret).update(payloadPart).digest("base64url");

export const verifyVoiceToken = (
  token: string,
  secret: string,
): { payload: VoiceTokenPayload | null; error: "invalid" | "expired" | null } => {
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) {
    return { payload: null, error: "invalid" };
  }

  const expected = sign(secret, payloadPart);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signaturePart);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { payload: null, error: "invalid" };
  }

  try {
    const payload = JSON.parse(fromBase64Url(payloadPart)) as VoiceTokenPayload;
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return { payload: null, error: "expired" };
    }
    if (!payload.sub || !payload.room?.channelId || !payload.user?.id) {
      return { payload: null, error: "invalid" };
    }
    return { payload, error: null };
  } catch {
    return { payload: null, error: "invalid" };
  }
};
