ALTER TABLE "users"
ADD COLUMN "avatar_s3_key" text;
--> statement-breakpoint

CREATE TYPE "public"."upload_session_kind" AS ENUM ('avatar', 'attachment');
--> statement-breakpoint

CREATE TYPE "public"."upload_session_status" AS ENUM ('pending', 'completed', 'aborted', 'expired');
--> statement-breakpoint

CREATE TYPE "public"."attachment_url_kind" AS ENUM ('presigned', 'public');
--> statement-breakpoint

CREATE TABLE "upload_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "kind" "upload_session_kind" NOT NULL,
  "status" "upload_session_status" DEFAULT 'pending' NOT NULL,
  "s3_key" text NOT NULL,
  "filename" text NOT NULL,
  "content_type" text,
  "expected_size" integer,
  "channel_id" text,
  "message_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint

ALTER TABLE "upload_sessions"
ADD CONSTRAINT "upload_sessions_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "upload_sessions"
ADD CONSTRAINT "upload_sessions_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "upload_sessions"
ADD CONSTRAINT "upload_sessions_message_id_messages_id_fk"
FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "upload_sessions_s3_key_unique" ON "upload_sessions" USING btree ("s3_key");
--> statement-breakpoint

CREATE INDEX "upload_sessions_user_id_idx" ON "upload_sessions" USING btree ("user_id");
--> statement-breakpoint

CREATE INDEX "upload_sessions_status_expires_idx" ON "upload_sessions" USING btree ("status", "expires_at");
--> statement-breakpoint

CREATE INDEX "upload_sessions_channel_id_idx" ON "upload_sessions" USING btree ("channel_id");
--> statement-breakpoint

CREATE INDEX "upload_sessions_message_id_idx" ON "upload_sessions" USING btree ("message_id");
--> statement-breakpoint

CREATE TABLE "message_attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "message_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "uploader_id" text NOT NULL,
  "s3_key" text NOT NULL,
  "filename" text NOT NULL,
  "size" integer NOT NULL,
  "content_type" text,
  "url_kind" "attachment_url_kind" DEFAULT 'presigned' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "message_attachments"
ADD CONSTRAINT "message_attachments_message_id_messages_id_fk"
FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "message_attachments"
ADD CONSTRAINT "message_attachments_channel_id_channels_id_fk"
FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "message_attachments"
ADD CONSTRAINT "message_attachments_uploader_id_users_id_fk"
FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "message_attachments_s3_key_unique" ON "message_attachments" USING btree ("s3_key");
--> statement-breakpoint

CREATE INDEX "message_attachments_message_id_idx" ON "message_attachments" USING btree ("message_id");
--> statement-breakpoint

CREATE INDEX "message_attachments_channel_id_idx" ON "message_attachments" USING btree ("channel_id");
--> statement-breakpoint

CREATE INDEX "message_attachments_uploader_id_idx" ON "message_attachments" USING btree ("uploader_id");
