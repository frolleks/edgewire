CREATE TYPE "public"."user_theme" AS ENUM ('system', 'light', 'dark');
--> statement-breakpoint

CREATE TABLE "user_profiles" (
  "user_id" text PRIMARY KEY NOT NULL,
  "username" text NOT NULL,
  "display_name" text,
  "avatar_url" text,
  "banner_url" text,
  "bio" text,
  "pronouns" text,
  "status" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "user_profiles"
ADD CONSTRAINT "user_profiles_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "user_profiles_username_unique" ON "user_profiles" USING btree ("username");
--> statement-breakpoint

CREATE INDEX "user_profiles_username_idx" ON "user_profiles" USING btree ("username");
--> statement-breakpoint

CREATE TABLE "user_settings" (
  "user_id" text PRIMARY KEY NOT NULL,
  "theme" "user_theme" DEFAULT 'system' NOT NULL,
  "compact_mode" boolean DEFAULT false NOT NULL,
  "show_timestamps" boolean DEFAULT true NOT NULL,
  "locale" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "user_settings"
ADD CONSTRAINT "user_settings_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

INSERT INTO "user_profiles" ("user_id", "username", "display_name", "avatar_url", "updated_at")
SELECT
  u."id",
  u."username",
  NULLIF(u."display_name", ''),
  u."avatar_url",
  now()
FROM "users" u
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "user_settings" ("user_id", "theme", "compact_mode", "show_timestamps", "locale", "updated_at")
SELECT
  u."id",
  'system',
  false,
  true,
  NULL,
  now()
FROM "users" u
ON CONFLICT ("user_id") DO NOTHING;
