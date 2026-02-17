CREATE TYPE "public"."guild_member_role" AS ENUM('OWNER', 'MEMBER');
--> statement-breakpoint

CREATE TABLE "guilds" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "icon" text,
  "owner_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "channels" (
  "id" text PRIMARY KEY NOT NULL,
  "type" integer NOT NULL,
  "guild_id" text,
  "name" text,
  "topic" text,
  "parent_id" text,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "channels"
ADD CONSTRAINT "channels_parent_id_channels_id_fk"
FOREIGN KEY ("parent_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "channels"
ADD CONSTRAINT "channels_guild_id_guilds_id_fk"
FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "channels"
ADD CONSTRAINT "channels_type_check"
CHECK ("type" IN (0, 1, 4));
--> statement-breakpoint

ALTER TABLE "channels"
ADD CONSTRAINT "channels_guild_presence_check"
CHECK (
  (("type" IN (0, 4)) AND "guild_id" IS NOT NULL)
  OR ("type" = 1 AND "guild_id" IS NULL)
);
--> statement-breakpoint

ALTER TABLE "channels"
ADD CONSTRAINT "channels_category_parent_check"
CHECK (("type" <> 4) OR ("parent_id" IS NULL));
--> statement-breakpoint

ALTER TABLE "channels"
ADD CONSTRAINT "channels_name_check"
CHECK (
  ("type" = 1 AND "name" IS NULL)
  OR ("type" IN (0, 4) AND "name" IS NOT NULL)
);
--> statement-breakpoint

CREATE TABLE "guild_members" (
  "guild_id" text NOT NULL,
  "user_id" text NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "role" "guild_member_role" DEFAULT 'MEMBER' NOT NULL,
  CONSTRAINT "guild_members_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint

CREATE TABLE "channel_members" (
  "channel_id" text NOT NULL,
  "user_id" text NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channel_members_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint

CREATE TABLE "invites" (
  "code" text PRIMARY KEY NOT NULL,
  "guild_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "inviter_id" text NOT NULL,
  "max_age_seconds" integer DEFAULT 86400 NOT NULL,
  "max_uses" integer DEFAULT 0 NOT NULL,
  "uses" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "guilds"
ADD CONSTRAINT "guilds_owner_id_users_id_fk"
FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "guild_members"
ADD CONSTRAINT "guild_members_guild_id_guilds_id_fk"
FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "guild_members"
ADD CONSTRAINT "guild_members_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "channel_members"
ADD CONSTRAINT "channel_members_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "channel_members"
ADD CONSTRAINT "channel_members_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "invites"
ADD CONSTRAINT "invites_guild_id_guilds_id_fk"
FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "invites"
ADD CONSTRAINT "invites_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "invites"
ADD CONSTRAINT "invites_inviter_id_users_id_fk"
FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

INSERT INTO "channels" ("id", "type", "guild_id", "name", "topic", "parent_id", "position", "created_at")
SELECT "id"::text, 1, NULL, NULL, NULL, NULL, 0, "created_at"
FROM "dm_channels";
--> statement-breakpoint

INSERT INTO "channel_members" ("channel_id", "user_id", "joined_at")
SELECT "channel_id"::text, "user_id", "joined_at"
FROM "dm_members";
--> statement-breakpoint

ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_channel_id_dm_channels_id_fk";
--> statement-breakpoint

ALTER TABLE "messages"
ALTER COLUMN "id" TYPE text USING "id"::text;
--> statement-breakpoint

ALTER TABLE "messages"
ALTER COLUMN "channel_id" TYPE text USING "channel_id"::text;
--> statement-breakpoint

ALTER TABLE "messages"
ADD CONSTRAINT "messages_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "message_reads" DROP CONSTRAINT IF EXISTS "message_reads_channel_id_dm_channels_id_fk";
--> statement-breakpoint

ALTER TABLE "message_reads"
ALTER COLUMN "channel_id" TYPE text USING "channel_id"::text;
--> statement-breakpoint

ALTER TABLE "message_reads"
ALTER COLUMN "last_read_message_id" TYPE text USING "last_read_message_id"::text;
--> statement-breakpoint

ALTER TABLE "message_reads"
ADD CONSTRAINT "message_reads_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

DROP TABLE "dm_members";
--> statement-breakpoint

DROP TABLE "dm_channels";
--> statement-breakpoint

CREATE INDEX "guilds_owner_id_idx" ON "guilds" USING btree ("owner_id");
--> statement-breakpoint

CREATE INDEX "channels_guild_id_idx" ON "channels" USING btree ("guild_id");
--> statement-breakpoint

CREATE INDEX "channels_parent_id_idx" ON "channels" USING btree ("parent_id");
--> statement-breakpoint

CREATE INDEX "channels_type_idx" ON "channels" USING btree ("type");
--> statement-breakpoint

CREATE INDEX "channels_guild_position_idx" ON "channels" USING btree ("guild_id", "position");
--> statement-breakpoint

CREATE INDEX "guild_members_user_id_idx" ON "guild_members" USING btree ("user_id");
--> statement-breakpoint

CREATE INDEX "channel_members_user_id_idx" ON "channel_members" USING btree ("user_id");
--> statement-breakpoint

CREATE INDEX "invites_guild_id_idx" ON "invites" USING btree ("guild_id");
--> statement-breakpoint

CREATE INDEX "invites_channel_id_idx" ON "invites" USING btree ("channel_id");
--> statement-breakpoint

CREATE INDEX "invites_expires_at_idx" ON "invites" USING btree ("expires_at");
