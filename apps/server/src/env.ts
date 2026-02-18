const get = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const getOptional = (name: string): string | undefined => {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getEither = (primary: string, fallback: string): string | undefined =>
  getOptional(primary) ?? getOptional(fallback);

const toBool = (value: string): boolean => value.toLowerCase() === "true";
const toInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toMimeList = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(",")
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
};

const parseIceServers = (value: string | undefined): Array<{ urls: string | string[]; username?: string; credential?: string }> => {
  if (!value) {
    return [{ urls: ["stun:stun.l.google.com:19302"] }];
  }

  try {
    const parsed = JSON.parse(value) as Array<{ urls: string | string[]; username?: string; credential?: string }>;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [{ urls: ["stun:stun.l.google.com:19302"] }];
    }
    return parsed;
  } catch {
    return [{ urls: ["stun:stun.l.google.com:19302"] }];
  }
};

export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  DATABASE_URL: get("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/discord_clone_dm"),
  BETTER_AUTH_SECRET: get("BETTER_AUTH_SECRET", "dev-only-secret-change-me"),
  APP_ORIGIN: get("APP_ORIGIN", "http://localhost:3000"),
  COOKIE_SECURE: toBool(process.env.COOKIE_SECURE ?? "false"),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  GATEWAY_TOKEN_TTL_SECONDS: Number(process.env.GATEWAY_TOKEN_TTL_SECONDS ?? 300),
  VOICE_TOKEN_SECRET: get("VOICE_TOKEN_SECRET", "dev-voice-secret-change-me"),
  VOICE_INTERNAL_SECRET: get("VOICE_INTERNAL_SECRET", "dev-voice-internal-secret-change-me"),
  MEDIASOUP_WS_URL: getEither("MEDIASOUP_WS_URL", "VOICE_WS_URL") ?? "ws://localhost:4000/ws",
  ICE_SERVERS: parseIceServers(getOptional("ICE_SERVERS_JSON")),
  S3_ACCESS_KEY_ID: getEither("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
  S3_SECRET_ACCESS_KEY: getEither("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
  S3_REGION: getEither("S3_REGION", "AWS_REGION"),
  S3_BUCKET: getEither("S3_BUCKET", "AWS_BUCKET"),
  S3_ENDPOINT: getEither("S3_ENDPOINT", "AWS_ENDPOINT"),
  S3_SESSION_TOKEN: getEither("S3_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
  S3_VIRTUAL_HOSTED_STYLE:
    process.env.S3_VIRTUAL_HOSTED_STYLE === undefined
      ? undefined
      : toBool(process.env.S3_VIRTUAL_HOSTED_STYLE),
  FILES_PUBLIC_BASE_URL: getOptional("FILES_PUBLIC_BASE_URL")?.replace(/\/+$/g, ""),
  UPLOAD_MAX_AVATAR_BYTES: toInt(getOptional("UPLOAD_MAX_AVATAR_BYTES"), 2_000_000),
  UPLOAD_MAX_ATTACHMENT_BYTES: toInt(getOptional("UPLOAD_MAX_ATTACHMENT_BYTES"), 25_000_000),
  UPLOAD_ALLOWED_ATTACHMENT_MIME: toMimeList(getOptional("UPLOAD_ALLOWED_ATTACHMENT_MIME"), [
    "image/*",
    "video/*",
    "audio/*",
    "application/pdf",
    "text/plain",
  ]),
  UPLOAD_ALLOWED_AVATAR_MIME: toMimeList(getOptional("UPLOAD_ALLOWED_AVATAR_MIME"), [
    "image/png",
    "image/jpeg",
    "image/webp",
  ]),
  UPLOAD_PRESIGN_EXPIRES_SECONDS: toInt(getOptional("UPLOAD_PRESIGN_EXPIRES_SECONDS"), 600),
  DOWNLOAD_PRESIGN_EXPIRES_SECONDS: toInt(getOptional("DOWNLOAD_PRESIGN_EXPIRES_SECONDS"), 900),
};
