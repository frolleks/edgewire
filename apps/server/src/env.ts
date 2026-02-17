const get = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const toBool = (value: string): boolean => value.toLowerCase() === "true";

export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  DATABASE_URL: get("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/discord_clone"),
  BETTER_AUTH_SECRET: get("BETTER_AUTH_SECRET", "dev-only-secret-change-me"),
  APP_ORIGIN: get("APP_ORIGIN", "http://localhost:3000"),
  COOKIE_SECURE: toBool(process.env.COOKIE_SECURE ?? "false"),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  GATEWAY_TOKEN_TTL_SECONDS: Number(process.env.GATEWAY_TOKEN_TTL_SECONDS ?? 300),
};
