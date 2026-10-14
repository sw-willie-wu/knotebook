ALTER TABLE "note_versions" ADD COLUMN "base_version_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "version_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "version_pending_editors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "version_pending_ref_fingerprint" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "version_base_version_id" uuid;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "version_auto_wait_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
UPDATE "notes" n SET "version_base_version_id" = v."id" FROM "note_versions" v WHERE v."note_id" = n."id" AND v."seq" = n."version_base_seq";--> statement-breakpoint
UPDATE "note_versions" r SET "base_version_id" = b."id" FROM "note_versions" b WHERE b."note_id" = r."note_id" AND b."seq" = r."base_seq";--> statement-breakpoint
CREATE INDEX "notes_version_pending_idx" ON "notes" USING btree ("version_pending_at") WHERE "notes"."version_pending_at" is not null;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_version_pending_chk" CHECK ("notes"."version_pending_at" is not null or ("notes"."version_pending_editors" = '[]'::jsonb and "notes"."version_pending_ref_fingerprint" is null));--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_version_auto_wait_chk" CHECK (1 <= "site_settings"."version_auto_wait_minutes" and "site_settings"."version_auto_wait_minutes" <= 60);