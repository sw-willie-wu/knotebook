-- Only adds two tables; no existing column or row is touched. note_tags_tag_idx backs the cascade when a tag is deleted (the PK leads with note_id).
-- Rollback: old code never reads these tables, so leaving them in place is harmless, and after re-upgrading their rows take effect again.
-- Two caveats for the time spent on old code: a note moved or copied to another space then isn't re-mapped, so it shows no tags after
-- re-upgrading; and deleting a group and handing its notes to a member cascades away the group's tags, so those notes lose their tags for good.
CREATE TABLE "note_tags" (
	"note_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "note_tags_note_id_tag_id_pk" PRIMARY KEY("note_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"group_id" uuid,
	"name" text NOT NULL,
	"name_key" text GENERATED ALWAYS AS (lower(name)) STORED NOT NULL,
	"color" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_space_chk" CHECK (("tags"."owner_id" is null) <> ("tags"."group_id" is null)),
	CONSTRAINT "tags_name_len_chk" CHECK (length("tags"."name") between 1 and 40),
	CONSTRAINT "tags_color_chk" CHECK ("tags"."color" in ('blue','green','orange','purple','pink','red','yellow','brown','gray'))
);
--> statement-breakpoint
ALTER TABLE "note_tags" ADD CONSTRAINT "note_tags_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_tags" ADD CONSTRAINT "note_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_tags_tag_idx" ON "note_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_owner_name_idx" ON "tags" USING btree ("owner_id","name_key") WHERE "tags"."owner_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_group_name_idx" ON "tags" USING btree ("group_id","name_key") WHERE "tags"."group_id" is not null;