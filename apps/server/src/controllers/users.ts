import { and, ilike, ne, or } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { json, requireAuth } from "../http";
import { toUserSummary } from "../lib/users";

export const searchUsers = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const { user } = authResult;
  const searchParams = new URL(request.url).searchParams;
  const query = (searchParams.get("q") ?? searchParams.get("query") ?? "").trim();
  const where = query
    ? and(ne(users.id, user.id), or(ilike(users.username, `%${query}%`), ilike(users.displayName, `%${query}%`)))
    : ne(users.id, user.id);

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      avatarS3Key: users.avatarS3Key,
    })
    .from(users)
    .where(where)
    .orderBy(users.username)
    .limit(20);

  return json(request, rows.map(toUserSummary));
};
