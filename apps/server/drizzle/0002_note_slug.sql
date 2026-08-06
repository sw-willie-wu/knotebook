ALTER TABLE "notes" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_slug_idx" ON "notes" USING btree ("slug") WHERE "notes"."slug" is not null;