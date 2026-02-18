type ImportMetaWithEnv = ImportMeta & {
  env?: Record<string, string | undefined>;
};

const readPublicEnv = (key: string): string | undefined => {
  const importMetaEnv = (import.meta as ImportMetaWithEnv | undefined)?.env;
  const fromImportMeta = importMetaEnv?.[key];
  if (typeof fromImportMeta === "string") {
    return fromImportMeta;
  }

  if (typeof process !== "undefined" && process.env) {
    const fromProcess = process.env[key];
    if (typeof fromProcess === "string") {
      return fromProcess;
    }
  }

  return undefined;
};

const isTrue = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

export const API_BASE_URL = readPublicEnv("BUN_PUBLIC_API_BASE_URL") ?? "http://localhost:3001";
export const GATEWAY_URL = readPublicEnv("BUN_PUBLIC_GATEWAY_URL") ?? "ws://localhost:3001/gateway";
export const USE_MEDIASOUP_VOICE = isTrue(
  readPublicEnv("BUN_PUBLIC_USE_MEDIASOUP_VOICE") ?? "true",
);
export const DEBUG_VOICE = isTrue(readPublicEnv("BUN_PUBLIC_DEBUG_VOICE"));
