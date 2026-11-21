-- Only adds two nullable columns; no existing row or column is touched.
-- Rollback: old code never reads them, so leaving them in place is harmless. A base made while old code runs has tags_sha null; after re-upgrading, write-back treats it as a base from before the upgrade.
ALTER TABLE "transfer_bases" ADD COLUMN "tags_sha" "bytea";--> statement-breakpoint
ALTER TABLE "transfer_bases" ADD COLUMN "applied_tags_sha" "bytea";
