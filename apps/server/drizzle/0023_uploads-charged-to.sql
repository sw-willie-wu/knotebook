ALTER TABLE "uploads" ADD COLUMN "charged_to_id" uuid;--> statement-breakpoint
UPDATE "uploads" SET "charged_to_id" = "uploader_id";--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_charged_to_id_users_id_fk" FOREIGN KEY ("charged_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;