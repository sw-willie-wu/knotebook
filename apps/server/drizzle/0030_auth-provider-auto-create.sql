ALTER TABLE "auth_providers" ADD COLUMN "auto_create_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- 既有服務承接升級前的 registration_enabled（PR-C U1）；site_settings 無列 → false（0014 起一定有列，只是保險）。
UPDATE "auth_providers" SET "auto_create_enabled" = coalesce((SELECT "registration_enabled" FROM "site_settings" WHERE "singleton"), false);
