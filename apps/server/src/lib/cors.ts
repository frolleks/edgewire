import { env } from "../env";

const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization";

export const withCors = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  const requestOrigin = request.headers.get("origin");
  const origin = requestOrigin === env.APP_ORIGIN ? requestOrigin : env.APP_ORIGIN;

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set("Vary", "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const preflight = (request: Request): Response =>
  withCors(request, new Response(null, { status: 204 }));
