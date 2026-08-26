ALTER TABLE "edits" ADD COLUMN "phase" text DEFAULT 'prelaunch' NOT NULL;--> statement-breakpoint
CREATE INDEX "edits_phase_idx" ON "edits" USING btree ("job_id","phase","created_at");