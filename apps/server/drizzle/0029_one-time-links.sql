-- #286 一次性連結（spec 2026-10-20-286-admin-password-reset §3.3）：新表 one_time_links，四條 CHECK、兩條 FK（target cascade／created_by set null）、兩個索引（I3 partial unique＋kind,created_at）。單一交易（drizzle migrator 整批），無非交易式 DDL（migrate.test.ts 有輔助 grep）。
CREATE TABLE "one_time_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"target_user_id" uuid,
	"created_by_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "one_time_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "one_time_links_kind_chk" CHECK ("one_time_links"."kind" in ('password_reset')),
	CONSTRAINT "one_time_links_reset_target_chk" CHECK ("one_time_links"."kind" <> 'password_reset' or "one_time_links"."target_user_id" is not null),
	CONSTRAINT "one_time_links_expiry_chk" CHECK ("one_time_links"."expires_at" > "one_time_links"."created_at"),
	CONSTRAINT "one_time_links_end_chk" CHECK ("one_time_links"."used_at" is null or "one_time_links"."revoked_at" is null)
);
--> statement-breakpoint
ALTER TABLE "one_time_links" ADD CONSTRAINT "one_time_links_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_links" ADD CONSTRAINT "one_time_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_time_links_reset_active_uidx" ON "one_time_links" USING btree ("target_user_id") WHERE "one_time_links"."kind" = 'password_reset' and "one_time_links"."used_at" is null and "one_time_links"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "one_time_links_kind_created_idx" ON "one_time_links" USING btree ("kind","created_at");