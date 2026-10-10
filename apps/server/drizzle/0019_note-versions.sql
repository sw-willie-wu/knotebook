CREATE TABLE "note_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"ydoc" "bytea" NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"editors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_versions_kind_chk" CHECK ("note_versions"."kind" in ('auto','manual'))
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "auto_versions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "version_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "version_base_seq" integer;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "version_base_fingerprint" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "version_keep_all_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "version_daily_until_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "auto_versions_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auto_versions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_versions_note_seq_idx" ON "note_versions" USING btree ("note_id","seq");--> statement-breakpoint
CREATE INDEX "note_versions_note_kind_created_idx" ON "note_versions" USING btree ("note_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_version_base_pair_chk" CHECK (("notes"."version_base_seq" is null) = ("notes"."version_base_fingerprint" is null));--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_version_days_chk" CHECK (1 <= "site_settings"."version_keep_all_days" and "site_settings"."version_keep_all_days" <= "site_settings"."version_daily_until_days" and "site_settings"."version_daily_until_days" <= 3650);