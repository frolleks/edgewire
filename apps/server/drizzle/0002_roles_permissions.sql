ALTER TABLE "guilds"
ADD COLUMN "verification_level" integer DEFAULT 0 NOT NULL,
ADD COLUMN "default_message_notifications" integer DEFAULT 0 NOT NULL,
ADD COLUMN "explicit_content_filter" integer DEFAULT 0 NOT NULL,
ADD COLUMN "preferred_locale" text DEFAULT 'en-US' NOT NULL,
ADD COLUMN "system_channel_id" text,
ADD COLUMN "rules_channel_id" text,
ADD COLUMN "public_updates_channel_id" text;
--> statement-breakpoint

CREATE TABLE "guild_roles" (
  "id" text PRIMARY KEY NOT NULL,
  "guild_id" text NOT NULL,
  "name" text NOT NULL,
  "permissions" text DEFAULT '0' NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "color" integer,
  "hoist" boolean DEFAULT false NOT NULL,
  "mentionable" boolean DEFAULT false NOT NULL,
  "managed" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "guild_roles"
ADD CONSTRAINT "guild_roles_guild_id_guilds_id_fk"
FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "guild_roles_guild_id_idx" ON "guild_roles" USING btree ("guild_id");
--> statement-breakpoint

CREATE INDEX "guild_roles_guild_position_idx" ON "guild_roles" USING btree ("guild_id", "position");
--> statement-breakpoint

CREATE TABLE "guild_member_roles" (
  "guild_id" text NOT NULL,
  "user_id" text NOT NULL,
  "role_id" text NOT NULL,
  CONSTRAINT "guild_member_roles_pk" PRIMARY KEY ("guild_id", "user_id", "role_id")
);
--> statement-breakpoint

ALTER TABLE "guild_member_roles"
ADD CONSTRAINT "guild_member_roles_guild_id_guilds_id_fk"
FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "guild_member_roles"
ADD CONSTRAINT "guild_member_roles_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "guild_member_roles"
ADD CONSTRAINT "guild_member_roles_role_id_guild_roles_id_fk"
FOREIGN KEY ("role_id") REFERENCES "public"."guild_roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "guild_member_roles_guild_user_idx" ON "guild_member_roles" USING btree ("guild_id", "user_id");
--> statement-breakpoint

CREATE INDEX "guild_member_roles_guild_role_idx" ON "guild_member_roles" USING btree ("guild_id", "role_id");
--> statement-breakpoint

CREATE TABLE "channel_permission_overwrites" (
  "channel_id" text NOT NULL,
  "overwrite_id" text NOT NULL,
  "type" integer NOT NULL,
  "allow" text DEFAULT '0' NOT NULL,
  "deny" text DEFAULT '0' NOT NULL,
  CONSTRAINT "channel_permission_overwrites_pk" PRIMARY KEY ("channel_id", "overwrite_id")
);
--> statement-breakpoint

ALTER TABLE "channel_permission_overwrites"
ADD CONSTRAINT "channel_permission_overwrites_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "channel_permission_overwrites"
ADD CONSTRAINT "channel_permission_overwrites_type_check"
CHECK ("type" in (0, 1));
--> statement-breakpoint

CREATE INDEX "channel_permission_overwrites_channel_idx" ON "channel_permission_overwrites" USING btree ("channel_id");
--> statement-breakpoint

INSERT INTO "guild_roles" (
  "id",
  "guild_id",
  "name",
  "permissions",
  "position",
  "color",
  "hoist",
  "mentionable",
  "managed"
)
SELECT
  g."id",
  g."id",
  '@everyone',
  '68608',
  0,
  NULL,
  false,
  false,
  false
FROM "guilds" g
ON CONFLICT ("id") DO NOTHING;
