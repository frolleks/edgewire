import { json } from "../http";

export const getHealth = (request: Request): Response =>
  json(request, {
    ok: true,
  });
