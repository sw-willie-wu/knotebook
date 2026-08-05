CREATE INDEX "note_shares_user_idx" ON "note_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notes_owner_idx" ON "notes" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "uploads_note_idx" ON "uploads" USING btree ("note_id");