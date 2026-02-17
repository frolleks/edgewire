import { json, notFound, requireAuth } from "../http";

export const apiNotFoundAfterAuth = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  return notFound(request);
};

export const internalServerError = (request: Request): Response =>
  json(request, { error: "Internal server error" }, { status: 500 });
