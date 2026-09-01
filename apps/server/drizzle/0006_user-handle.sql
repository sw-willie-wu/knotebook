CREATE TABLE "handles" (
	"handle" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"state" text NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "handles_handle_chk" CHECK ("handles"."handle" ~ '^[a-z0-9-]{1,32}$'),
	CONSTRAINT "handles_state_chk" CHECK ("handles"."state" in ('live','released')),
	CONSTRAINT "handles_released_at_chk" CHECK (("handles"."state" = 'released') = ("handles"."released_at" is not null))
);
--> statement-breakpoint
CREATE INDEX "handles_user_idx" ON "handles" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle" text;--> statement-breakpoint
-- #122 backfill（spec §2c；drizzle-kit generate 草稿經手改為「加欄(nullable)→backfill→
-- SET NOT NULL/DEFAULT→ADD CONSTRAINT」段式——generate 的一句式對既有列會直接套隨機
-- default，派生自 email 的 handle 就沒了；snapshot 描述的是最終態，不受此手改影響）。
--
-- 逐列指派（created_at, id 排序＝確定性）：候選＝email local-part 的 SQL 簡化派生
-- （ASCII-only：lower → 非 [a-z0-9] 段轉 '-' → 去頭尾 dash → uuid 形/空 → user-<uuid8>
-- → 截 30 再 trim 尾 dash）；`WHILE EXISTS(handles)` 遞增 `-N` 尾碼（重截基底使總長
-- ≤32；上限 100 後退 user-<uuid8>）。逐列查已寫入值＝跨組撞名（foo＋既有 foo-2＋第二個
-- foo）天然正確——migrate.test.ts 的資料案例守著。uuid 形判斷在**截斷前**（截 30 後的
-- uuid 前綴已非 uuid 形，判不到——plan 注意事項 9）。
-- 整支 migration 由 drizzle 包在單一 transaction 內執行；本檔不得出現 COMMIT 或並行建索引語法。
DO $$
DECLARE
  u RECORD;
  base text;
  cand text;
  n int;
BEGIN
  FOR u IN SELECT id, email FROM users ORDER BY created_at, id LOOP
    base := lower(split_part(u.email, '@', 1));
    base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
    base := regexp_replace(base, '^-+|-+$', '', 'g');
    IF base = '' OR base ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      base := 'user-' || substr(u.id::text, 1, 8);
    END IF;
    base := left(base, 30);
    base := regexp_replace(base, '-+$', '');

    cand := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM handles WHERE handle = cand) AND n < 100 LOOP
      n := n + 1;
      cand := regexp_replace(left(base, 32 - length('-' || n::text)), '-+$', '') || '-' || n::text;
    END LOOP;
    IF EXISTS (SELECT 1 FROM handles WHERE handle = cand) THEN
      cand := 'user-' || substr(u.id::text, 1, 8);
    END IF;

    INSERT INTO handles (handle, user_id, state) VALUES (cand, u.id, 'live');
    UPDATE users SET handle = cand WHERE id = u.id;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "handle" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "handle" SET DEFAULT 'user-' || substr(gen_random_uuid()::text, 1, 8);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_handle_unique" UNIQUE("handle");
