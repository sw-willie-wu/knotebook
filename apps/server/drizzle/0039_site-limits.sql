-- #397 站台限制改在管理頁調整：只建 site_limits（管理頁存的值，沒有列＝用預設／自動；key 格式與 value >= 0 的 CHECK）與 site_limit_changes（修改紀錄，actor_user_id FK 刪使用者設 NULL、changed_at DESC 索引）兩張表；單一交易、無非交易式 DDL、不回填。回滾到前一版：舊碼不讀這兩張表，限制回到 env／常數；表留著無害，之後再升回來，表裡的值重新生效。
CREATE TABLE "site_limit_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"old_value" integer,
	"new_value" integer,
	"old_effective" integer NOT NULL,
	"new_effective" integer NOT NULL,
	"actor_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_limits_key_chk" CHECK ("site_limits"."key" ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'),
	CONSTRAINT "site_limits_value_chk" CHECK ("site_limits"."value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "site_limit_changes" ADD CONSTRAINT "site_limit_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_limit_changes_changed_at_idx" ON "site_limit_changes" USING btree ("changed_at" DESC NULLS LAST);