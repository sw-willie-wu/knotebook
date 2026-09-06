CREATE TABLE "note_ai_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_id" uuid,
	"agent_label" text,
	"op" text NOT NULL,
	"section_id" text,
	"before_blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"after_block_ids" text[] DEFAULT '{}' NOT NULL,
	"after_fingerprint" text,
	"anchor" jsonb,
	"revert_of" uuid,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_ai_edits_op_chk" CHECK ("note_ai_edits"."op" in ('replace_all','replace_section','insert_after','append','delete_section','revert')),
	CONSTRAINT "note_ai_edits_revert_chk" CHECK (("note_ai_edits"."op" = 'revert') = ("note_ai_edits"."revert_of" is not null)),
	CONSTRAINT "note_ai_edits_fingerprint_chk" CHECK ((cardinality("note_ai_edits"."after_block_ids") = 0) = ("note_ai_edits"."after_fingerprint" is null)),
	CONSTRAINT "note_ai_edits_anchor_chk" CHECK (("note_ai_edits"."op" = 'delete_section') = ("note_ai_edits"."anchor" is not null))
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "agent_label" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "last_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "last_edited_by" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "last_edited_token_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "last_edited_agent_label" text;--> statement-breakpoint
ALTER TABLE "note_ai_edits" ADD CONSTRAINT "note_ai_edits_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_ai_edits" ADD CONSTRAINT "note_ai_edits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_ai_edits" ADD CONSTRAINT "note_ai_edits_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_ai_edits" ADD CONSTRAINT "note_ai_edits_revert_of_note_ai_edits_id_fk" FOREIGN KEY ("revert_of") REFERENCES "public"."note_ai_edits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_ai_edits_note_created_idx" ON "note_ai_edits" USING btree ("note_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_last_edited_by_users_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_last_edited_token_id_api_tokens_id_fk" FOREIGN KEY ("last_edited_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_agent_label_chk" CHECK ("api_tokens"."agent_label" is null or "api_tokens"."agent_label" ~ '^[A-Za-z0-9._-]{1,32}$');