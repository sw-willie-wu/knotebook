-- #388 網頁登入改伺服器端 session：只建 sessions 表（id、user_id FK 串刪、created_at、expires_at）與兩個索引；單一交易、無非交易式 DDL、不回填。升級後舊 cookie（JWT 沒有 sid）一律視為未登入，所有人重新登入一次。回滾到前一版：舊碼不讀這張表，照舊只驗簽章與 tv。
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");