-- Only adds two tables; no existing column or row is touched, and neither is filled here: a background run builds the rows after the first start.
-- Rollback: old code never reads these tables, so leaving them in place is harmless; after re-upgrading, the background run redoes the notes edited meanwhile.
CREATE TABLE "note_knowledge" (
	"note_id" uuid NOT NULL,
	"knowledge_id" text NOT NULL,
	"block_id" text NOT NULL,
	"ord" integer NOT NULL,
	"level" smallint NOT NULL,
	"heading" text NOT NULL,
	"read_when" text NOT NULL,
	"conclusion" text NOT NULL,
	"evidence" text NOT NULL,
	"verified" date,
	"status" text NOT NULL,
	"icon" text NOT NULL,
	"parent_knowledge_id" text,
	"superseded_note_id" uuid,
	"superseded_knowledge_id" text,
	"desc_total" integer DEFAULT 0 NOT NULL,
	"desc_verified" integer DEFAULT 0 NOT NULL,
	"desc_no_date" integer DEFAULT 0 NOT NULL,
	"desc_needs_review" integer DEFAULT 0 NOT NULL,
	"desc_outdated" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "note_knowledge_pk" PRIMARY KEY("note_id","knowledge_id"),
	CONSTRAINT "nk_knowledge_id_chk" CHECK ("note_knowledge"."knowledge_id" ~ '^k_[0-9a-f]{8}$'),
	CONSTRAINT "nk_block_id_chk" CHECK ("note_knowledge"."block_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "nk_level_chk" CHECK ("note_knowledge"."level" between 1 and 6),
	CONSTRAINT "nk_evidence_chk" CHECK ("note_knowledge"."evidence" in ('', 'tested', 'docs', 'inferred')),
	CONSTRAINT "nk_status_chk" CHECK ("note_knowledge"."status" in ('', 'unverified', 'outdated')),
	CONSTRAINT "nk_icon_chk" CHECK ("note_knowledge"."icon" in ('outdated', 'needsReview', 'noVerifiedDate', 'verified')),
	CONSTRAINT "nk_superseded_chk" CHECK ("note_knowledge"."superseded_knowledge_id" is null or "note_knowledge"."superseded_knowledge_id" ~ '^k_[0-9a-f]{8}$'),
	CONSTRAINT "nk_superseded_pair_chk" CHECK ("note_knowledge"."superseded_note_id" is null or "note_knowledge"."superseded_knowledge_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "note_knowledge_state" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"extractor_version" smallint NOT NULL,
	"source_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"entries" integer NOT NULL,
	"capped" boolean NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_knowledge" ADD CONSTRAINT "note_knowledge_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_knowledge_state" ADD CONSTRAINT "note_knowledge_state_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;