CREATE TABLE "note_link_conversion" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"converted" integer DEFAULT 0 NOT NULL,
	"unresolved" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_link_conversion_status_chk" CHECK ("note_link_conversion"."status" in ('pending','done','retry','failed'))
);
--> statement-breakpoint
ALTER TABLE "note_link_conversion" ADD CONSTRAINT "note_link_conversion_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "note_link_conversion" ("note_id", "status") SELECT "id", 'pending' FROM "notes";