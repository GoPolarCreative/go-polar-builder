ALTER TABLE "golive" ADD COLUMN "hosting_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "golive" ADD COLUMN "hosting_ended_at" timestamp with time zone;