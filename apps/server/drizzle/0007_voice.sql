ALTER TABLE "channels" DROP CONSTRAINT "channels_type_check";
--> statement-breakpoint

ALTER TABLE "channels" DROP CONSTRAINT "channels_guild_presence_check";
--> statement-breakpoint

ALTER TABLE "channels" DROP CONSTRAINT "channels_name_check";
--> statement-breakpoint

ALTER TABLE "channels"
ADD CONSTRAINT "channels_type_check" CHECK ("channels"."type" in (0, 1, 2, 4));
--> statement-breakpoint

ALTER TABLE "channels"
ADD CONSTRAINT "channels_guild_presence_check" CHECK ((("channels"."type" in (0, 2, 4) and "channels"."guild_id" is not null) or ("channels"."type" = 1 and "channels"."guild_id" is null)));
--> statement-breakpoint

ALTER TABLE "channels"
ADD CONSTRAINT "channels_name_check" CHECK ((("channels"."type" = 1 and "channels"."name" is null) or ("channels"."type" in (0, 2, 4) and "channels"."name" is not null)));
