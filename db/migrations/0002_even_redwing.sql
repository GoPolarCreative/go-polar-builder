ALTER TYPE "public"."order_kind" ADD VALUE 'page' BEFORE 'hosting';--> statement-breakpoint
CREATE TABLE "build_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"version" integer NOT NULL,
	"path" text NOT NULL,
	"url" text NOT NULL,
	"service_slug" text,
	"title" text NOT NULL,
	"blob_key" text NOT NULL,
	"bytes" integer,
	"page_weight_bytes" integer,
	"checks" jsonb,
	"passed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "pages_allowed" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "build_pages" ADD CONSTRAINT "build_pages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "build_pages_version_path_idx" ON "build_pages" USING btree ("job_id","version","path");