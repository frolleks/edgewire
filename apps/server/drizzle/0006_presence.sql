CREATE TYPE "public"."presence_status" AS ENUM ('online', 'idle', 'dnd', 'invisible');
--> statement-breakpoint

ALTER TABLE "user_settings"
ADD COLUMN "presence_status" "presence_status" DEFAULT 'online' NOT NULL;
--> statement-breakpoint

ALTER TABLE "user_settings"
ADD COLUMN "show_current_activity" boolean DEFAULT false NOT NULL;
