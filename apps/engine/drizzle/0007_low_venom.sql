ALTER TYPE "public"."notification_channel_kind" ADD VALUE 'slack';--> statement-breakpoint
ALTER TYPE "public"."notification_channel_kind" ADD VALUE 'telegram';--> statement-breakpoint
ALTER TYPE "public"."reminder_delivery_status" ADD VALUE 'uncertain' BEFORE 'pending';--> statement-breakpoint
ALTER TABLE "reminder_deliveries" DROP CONSTRAINT "reminder_deliveries_reminder_channel_key";--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "config_digest" text;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD COLUMN "reminder_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD COLUMN "channel_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_occurrence_key" UNIQUE("reminder_id","channel_id","reminder_version");