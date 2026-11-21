-- Only widens tags_color_chk so a tag can also have a custom #rrggbb color; every existing row already satisfies it, so no row is changed.
-- Rollback: version 0.17 never reads tags, so leaving the wider check in place is harmless.
ALTER TABLE "tags" DROP CONSTRAINT "tags_color_chk";--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_color_chk" CHECK ("tags"."color" in ('blue','green','orange','purple','pink','red','yellow','brown','gray') or "tags"."color" ~ '^#[0-9a-f]{6}$');