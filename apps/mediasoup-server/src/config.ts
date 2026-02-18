import os from "node:os";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

const get = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
};

const toBool = (value: string | undefined, fallback = false): boolean => {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const parseIceServers = (value: string | undefined): IceServerConfig[] | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const servers: IceServerConfig[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const server = entry as Partial<IceServerConfig>;
      if (typeof server.urls !== "string" && !Array.isArray(server.urls)) {
        continue;
      }

      servers.push({
        urls: server.urls,
        ...(typeof server.username === "string" ? { username: server.username } : {}),
        ...(typeof server.credential === "string" ? { credential: server.credential } : {}),
      });
    }

    return servers.length > 0 ? servers : undefined;
  } catch {
    return undefined;
  }
};

const getWorkerCount = (): number => {
  const configured = toNumber(process.env.MEDIASOUP_WORKER_COUNT, 0);
  if (configured > 0) {
    return Math.floor(configured);
  }

  const parallelism = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, parallelism);
};

export type MediasoupConfig = {
  port: number;
  wsPath: string;
  apiBaseUrl: string;
  voiceTokenSecret: string;
  voiceInternalSecret: string;
  debugVoice: boolean;
  workerCount: number;
  listenIp: string;
  announcedAddress?: string;
  rtcMinPort: number;
  rtcMaxPort: number;
  initialAvailableOutgoingBitrate: number;
  iceServers?: IceServerConfig[];
  iceTransportPolicy?: "all" | "relay";
};

const listenIp = get("MEDIASOUP_LISTEN_IP", "127.0.0.1");
const announcedAddress = process.env.MEDIASOUP_ANNOUNCED_ADDRESS?.trim() || undefined;

if ((listenIp === "0.0.0.0" || listenIp === "::") && !announcedAddress) {
  throw new Error(
    "Invalid mediasoup network config: MEDIASOUP_ANNOUNCED_ADDRESS is required when MEDIASOUP_LISTEN_IP is 0.0.0.0 or ::.",
  );
}

export const config: MediasoupConfig = {
  port: toNumber(process.env.PORT, 4000),
  wsPath: get("MEDIASOUP_WS_PATH", "/ws"),
  apiBaseUrl: get("API_BASE_URL", "http://localhost:3001"),
  voiceTokenSecret: get("VOICE_TOKEN_SECRET", "dev-voice-secret-change-me"),
  voiceInternalSecret: get("VOICE_INTERNAL_SECRET", "dev-voice-internal-secret-change-me"),
  debugVoice: toBool(process.env.DEBUG_VOICE),
  workerCount: getWorkerCount(),
  listenIp,
  announcedAddress,
  rtcMinPort: toNumber(process.env.MEDIASOUP_MIN_PORT, 40_000),
  rtcMaxPort: toNumber(process.env.MEDIASOUP_MAX_PORT, 49_999),
  initialAvailableOutgoingBitrate: toNumber(process.env.MEDIASOUP_INITIAL_AVAILABLE_OUTGOING_BITRATE, 1_000_000),
  iceServers: parseIceServers(process.env.ICE_SERVERS_JSON),
  iceTransportPolicy:
    process.env.ICE_TRANSPORT_POLICY === "relay"
      ? "relay"
      : process.env.ICE_TRANSPORT_POLICY === "all"
        ? "all"
        : undefined,
};
