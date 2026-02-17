import { drizzle } from "drizzle-orm/bun-sql";
import { env } from "../env";
import * as appSchema from "./schema";
import * as authSchema from "./auth-schema";
import { SQL } from "bun";

export const sql = new SQL(env.DATABASE_URL, {
  max: 10,
  prepare: false,
});

export const db = drizzle(sql, {
  schema: {
    ...appSchema,
    ...authSchema,
  },
});

export type DB = typeof db;
