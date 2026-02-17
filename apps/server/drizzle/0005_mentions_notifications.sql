CREATE TYPE "public"."notification_level" AS ENUM ('ALL_MESSAGES', 'ONLY_MENTIONS', 'NOTHING');
--> statement-breakpoint

ALTER TABLE "user_settings"
ADD COLUMN "enable_desktop_notifications" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "user_settings"
ADD COLUMN "notification_sounds" boolean DEFAULT true NOT NULL;
--> statement-breakpoint

ALTER TABLE "user_settings"
ADD COLUMN "default_guild_notification_level" "notification_level" DEFAULT 'ONLY_MENTIONS' NOT NULL;
--> statement-breakpoint

ALTER TABLE "messages"
ADD COLUMN "mention_everyone" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "messages"
ADD COLUMN "mention_user_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL;
--> statement-breakpoint

ALTER TABLE "messages"
ADD COLUMN "mention_role_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL;
--> statement-breakpoint

ALTER TABLE "messages"
ADD COLUMN "mention_channel_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL;
--> statement-breakpoint

CREATE TABLE "channel_reads" (
  "user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "last_read_message_id" text,
  "last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
  "unread_count" integer DEFAULT 0 NOT NULL,
  "mention_count" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channel_reads_pk" PRIMARY KEY("user_id", "channel_id")
);
--> statement-breakpoint

ALTER TABLE "channel_reads"
ADD CONSTRAINT "channel_reads_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "channel_reads"
ADD CONSTRAINT "channel_reads_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "channel_reads_channel_id_idx" ON "channel_reads" USING btree ("channel_id");
--> statement-breakpoint

CREATE TABLE "message_mentions" (
  "message_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "guild_id" text,
  "mentioned_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_mentions_pk" PRIMARY KEY("message_id", "mentioned_user_id")
);
--> statement-breakpoint

ALTER TABLE "message_mentions"
ADD CONSTRAINT "message_mentions_message_id_messages_id_fk"
FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "message_mentions"
ADD CONSTRAINT "message_mentions_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "message_mentions"
ADD CONSTRAINT "message_mentions_guild_id_guilds_id_fk"
FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "message_mentions"
ADD CONSTRAINT "message_mentions_mentioned_user_id_users_id_fk"
FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "message_mentions_message_idx" ON "message_mentions" USING btree ("message_id");
--> statement-breakpoint

CREATE INDEX "message_mentions_channel_idx" ON "message_mentions" USING btree ("channel_id");
--> statement-breakpoint

CREATE INDEX "message_mentions_guild_idx" ON "message_mentions" USING btree ("guild_id");
--> statement-breakpoint

CREATE INDEX "message_mentions_mentioned_user_idx" ON "message_mentions" USING btree ("mentioned_user_id");
--> statement-breakpoint

CREATE TABLE "user_guild_notification_settings" (
  "user_id" text NOT NULL,
  "guild_id" text NOT NULL,
  "level" "notification_level" DEFAULT 'ONLY_MENTIONS' NOT NULL,
  "suppress_everyone" boolean DEFAULT false NOT NULL,
  "muted" boolean DEFAULT false NOT NULL,
  "muted_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_guild_notification_settings_pk" PRIMARY KEY("user_id", "guild_id")
);
--> statement-breakpoint

ALTER TABLE "user_guild_notification_settings"
ADD CONSTRAINT "user_guild_notification_settings_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "user_guild_notification_settings"
ADD CONSTRAINT "user_guild_notification_settings_guild_id_guilds_id_fk"
FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE "user_channel_notification_settings" (
  "user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "level" "notification_level",
  "muted" boolean DEFAULT false NOT NULL,
  "muted_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_channel_notification_settings_pk" PRIMARY KEY("user_id", "channel_id")
);
--> statement-breakpoint

ALTER TABLE "user_channel_notification_settings"
ADD CONSTRAINT "user_channel_notification_settings_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "user_channel_notification_settings"
ADD CONSTRAINT "user_channel_notification_settings_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

INSERT INTO "channel_reads" (
  "user_id",
  "channel_id",
  "last_read_message_id",
  "last_read_at",
  "unread_count",
  "mention_count",
  "updated_at"
)
SELECT
  mr."user_id",
  mr."channel_id",
  mr."last_read_message_id",
  now(),
  0,
  0,
  mr."updated_at"
FROM "message_reads" mr
ON CONFLICT ("user_id", "channel_id") DO UPDATE
SET
  "last_read_message_id" = EXCLUDED."last_read_message_id",
  "last_read_at" = EXCLUDED."last_read_at",
  "updated_at" = EXCLUDED."updated_at";
