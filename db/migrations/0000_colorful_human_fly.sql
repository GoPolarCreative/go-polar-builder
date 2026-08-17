CREATE TYPE "public"."asset_kind" AS ENUM('logo', 'photo');--> statement-breakpoint
CREATE TYPE "public"."discharge_status" AS ENUM('requested', 'awaiting_payment', 'paid', 'prepared', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."domain_branch" AS ENUM('own', 'new', 'locked');--> statement-breakpoint
CREATE TYPE "public"."golive_status" AS ENUM('selecting', 'awaiting_payment', 'paid', 'queued', 'live');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('paid', 'intake', 'generating', 'preview', 'editing', 'go_live_pending', 'live', 'discharged', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('build', 'hosting', 'domain', 'email', 'edit', 'discharge');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"filename" text,
	"content_type" text,
	"original_key" text NOT NULL,
	"original_bytes" integer,
	"width" integer,
	"height" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"stats" jsonb,
	"variants" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"version" integer NOT NULL,
	"blob_key" text NOT NULL,
	"bytes" integer,
	"page_weight_bytes" integer,
	"checks" jsonb,
	"passed" boolean DEFAULT false NOT NULL,
	"repair_passes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discharges" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"status" "discharge_status" DEFAULT 'requested' NOT NULL,
	"customer_web3forms_key" text,
	"version" integer,
	"blob_key" text,
	"file_count" integer,
	"bytes" integer,
	"used_placeholder" boolean,
	"checkout_url" text,
	"paid_at" timestamp with time zone,
	"prepared_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"name" text NOT NULL,
	"branch" "domain_branch" NOT NULL,
	"whois" jsonb,
	"mx" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"vercel_domain_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edits" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"version_from" integer NOT NULL,
	"version_to" integer NOT NULL,
	"prompt" text,
	"diff_summary" text,
	"counted" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "golive" (
	"job_id" text PRIMARY KEY NOT NULL,
	"hosting" boolean DEFAULT true NOT NULL,
	"email_addon" boolean DEFAULT false NOT NULL,
	"domain_addon" boolean DEFAULT false NOT NULL,
	"checkout_url" text,
	"checkout_created_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"status" "golive_status" DEFAULT 'selecting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake" (
	"job_id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"audit_flags" jsonb,
	"submitted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" "job_status" DEFAULT 'paid' NOT NULL,
	"trade" text,
	"business_name" text,
	"edits_used" integer DEFAULT 0 NOT NULL,
	"edits_allowed" integer DEFAULT 10 NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"held" boolean DEFAULT false NOT NULL,
	"held_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"shopify_order_id" text NOT NULL,
	"shopify_customer_id" text,
	"product_handle" text NOT NULL,
	"amount_ex_gst" integer NOT NULL,
	"kind" "order_kind" NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"version" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"hostname" text NOT NULL,
	"version" integer NOT NULL,
	"live" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"first_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"name" text,
	"shopify_customer_id" text,
	"ghl_contact_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discharges" ADD CONSTRAINT "discharges_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edits" ADD CONSTRAINT "edits_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golive" ADD CONSTRAINT "golive_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_job_idx" ON "assets" USING btree ("job_id","kind","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "builds_job_version_idx" ON "builds" USING btree ("job_id","version");--> statement-breakpoint
CREATE INDEX "discharges_job_idx" ON "discharges" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "domains_job_idx" ON "domains" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "edits_job_idx" ON "edits" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "events_job_idx" ON "events" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "jobs_user_idx" ON "jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_line_idx" ON "orders" USING btree ("shopify_order_id","product_handle");--> statement-breakpoint
CREATE INDEX "orders_job_idx" ON "orders" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_job_version_idx" ON "plans" USING btree ("job_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_hostname_idx" ON "sites" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "sites_job_idx" ON "sites" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_hash_idx" ON "tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "tokens_job_idx" ON "tokens" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_shopify_customer_idx" ON "users" USING btree ("shopify_customer_id");