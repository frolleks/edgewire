import { env } from "../env";
import { getAuthedUser } from "../runtime";

const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization";

const resolveOrigin = (request: Request): string => {
  const requestOrigin = request.headers.get("origin");
  return requestOrigin === env.APP_ORIGIN ? requestOrigin : env.APP_ORIGIN;
};

const mergeVary = (headers: Headers, value: string): void => {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", value);
    return;
  }

  const values = new Set(
    current
      .split(",")
      .map(token => token.trim())
      .filter(Boolean),
  );
  values.add(value);
  headers.set("Vary", [...values].join(", "));
};

const applyCorsHeaders = (request: Request, headers: Headers): void => {
  headers.set("Access-Control-Allow-Origin", resolveOrigin(request));
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  mergeVary(headers, "Origin");
};

export const corsify = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  applyCorsHeaders(request, headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const json = (request: Request, data: unknown, init?: ResponseInit): Response =>
  corsify(request, Response.json(data, init));

export const text = (request: Request, body: string, init?: ResponseInit): Response =>
  corsify(request, new Response(body, init));

export const empty = (request: Request, status = 204): Response =>
  corsify(request, new Response(null, { status }));

export const corsPreflight = (request: Request): Response =>
  corsify(request, new Response(null, { status: 204 }));

export const methodNotAllowed = (request: Request, allowed: string[]): Response =>
  json(
    request,
    {
      error: "Method not allowed",
    },
    {
      status: 405,
      headers: {
        Allow: allowed.join(", "),
      },
    },
  );

export const parseJson = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

export const unauthorized = (request: Request): Response =>
  json(
    request,
    {
      error: "Unauthorized",
    },
    { status: 401 },
  );

export const badRequest = (request: Request, error: string): Response =>
  json(request, { error }, { status: 400 });

export const forbidden = (request: Request, error = "Forbidden"): Response =>
  json(request, { error }, { status: 403 });

export const notFound = (request: Request): Response =>
  json(request, { error: "Not found" }, { status: 404 });

export const requireAuth = async (
  request: Request,
): Promise<Response | { user: NonNullable<Awaited<ReturnType<typeof getAuthedUser>>> }> => {
  const user = await getAuthedUser(request);
  if (!user) {
    return unauthorized(request);
  }

  return { user };
};
