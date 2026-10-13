ALTER TABLE "users" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users" SET "last_active_at" = "last_login_at" WHERE "last_login_at" IS NOT NULL;