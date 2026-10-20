CREATE TABLE "handle_renames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"renamed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handle_renames" ADD CONSTRAINT "handle_renames_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handle_renames_user_time_idx" ON "handle_renames" USING btree ("user_id","renamed_at");
--> statement-breakpoint
INSERT INTO "handle_renames" ("user_id", "renamed_at") SELECT h."user_id", h."released_at" FROM "handles" h WHERE h."state" = 'released' AND h."released_at" > now() - interval '1 day' AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = h."user_id");
--> statement-breakpoint
DELETE FROM "handles" WHERE "state" = 'released';
