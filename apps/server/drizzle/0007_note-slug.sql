-- #122 PR2（spec §3a 六步序；drizzle-kit generate 草稿經手改——generate 的一句式會在
-- SET NOT NULL 前對既有列直接套隨機 default，標題派生的 auto slug 就沒了；六步順序
-- **不得重排**：②快照必在⑥trigger 之前（先建 trigger 會炸掉快照 UPDATE 自身）、
-- ③drop 全域索引必在④backfill 之前（多 owner 同標題在舊全域唯一索引下第二列必炸）。
-- snapshot 描述的是最終態，不受此手改影響。
-- 整支 migration 由 drizzle 包在單一 transaction 內執行；本檔不得出現 COMMIT 或並行建索引語法。
--
-- ①加欄（nullable，slug_is_custom 先不帶 NOT NULL/DEFAULT——快照要逐列算）
ALTER TABLE "notes" ADD COLUMN "slug_is_custom" boolean;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "prev_slug" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "legacy_slug" text;--> statement-breakpoint
-- ②快照：既有自訂 slug → custom=true＋legacy 凍結；無 slug 列 → false＋NULL（slug 為
-- NULL 時 legacy_slug 得 NULL，單一 UPDATE 兩欄一次算）。
UPDATE "notes" SET "slug_is_custom" = ("slug" IS NOT NULL), "legacy_slug" = "slug";--> statement-breakpoint
-- ③舊全域唯一索引先退場（④的 per-user backfill 允許跨 owner 同名）
DROP INDEX "notes_slug_idx";--> statement-breakpoint
-- ④backfill（spec §3a 分岔政策就地寫死）：**SQL 版只處理 ASCII**——PG regex 無
-- \p{L}\p{M}、glibc lower 與 JS 在 İ 等案分岔，不追 JS 語意：標題含任何非 ASCII 字元
-- → 一律退 'untitled'（＋去重尾碼）；純 ASCII 標題 → 與 shared 的 autoSlugFromTitle
-- 產物**必須全等**（migrate.test.ts 的 SQL/TS 雙實作對照守著）。管線順序同 TS：
-- lower → 非 [a-z0-9] 段轉 '-' → 去頭尾 dash → 截 60 再 trim 尾 dash →
-- 空/'new'/uuid 形（整串或 -<uuid> 尾）→ 'untitled'。判斷在**截斷後**（同 TS：
-- validateSlug 吃的是 titleSlug 截完的字串）。owner 範圍 WHILE EXISTS 去重（述詞排除
-- 本列；含既有自訂 slug 與已 backfill 列）；上限 100 退 'untitled-'+uuid8。
-- 逐列序 created_at,id＝確定性（migrate.test 以物理插入序≠created_at 的 fixture 釘）。
DO $$
DECLARE
  r RECORD;
  base text;
  cand text;
  n int;
BEGIN
  FOR r IN SELECT id, owner_id, title FROM notes WHERE slug IS NULL ORDER BY created_at, id LOOP
    IF r.title ~ '[^[:ascii:]]' THEN
      base := 'untitled';
    ELSE
      base := lower(r.title);
      base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
      base := regexp_replace(base, '^-+|-+$', '', 'g');
      base := left(base, 60);
      base := regexp_replace(base, '-+$', '');
      IF base = '' OR base = 'new'
         OR base ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR base ~ '-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        base := 'untitled';
      END IF;
    END IF;

    cand := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM notes WHERE owner_id = r.owner_id AND slug = cand AND id <> r.id) AND n < 100 LOOP
      n := n + 1;
      cand := regexp_replace(left(base, 60 - length('-' || n::text)), '-+$', '') || '-' || n::text;
    END LOOP;
    -- n < 100 時 WHILE 正常結束＝cand 已確認可用，不必重查；只有撞到上限才需要再驗一次
    IF n >= 100 AND EXISTS (SELECT 1 FROM notes WHERE owner_id = r.owner_id AND slug = cand AND id <> r.id) THEN
      cand := 'untitled-' || substr(r.id::text, 1, 8);
    END IF;

    UPDATE notes SET slug = cand WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
-- ⑤收緊＋索引（backfill 完才有資格 NOT NULL；default 見 schema.ts 的兩個承重理由）
ALTER TABLE "notes" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "slug" SET DEFAULT 'untitled-' || substr(gen_random_uuid()::text, 1, 8);--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "slug_is_custom" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "slug_is_custom" SET DEFAULT false;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_owner_slug_idx" ON "notes" USING btree ("owner_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_legacy_slug_idx" ON "notes" USING btree ("legacy_slug") WHERE "notes"."legacy_slug" is not null;--> statement-breakpoint
CREATE INDEX "notes_owner_prev_slug_idx" ON "notes" USING btree ("owner_id","prev_slug") WHERE "notes"."prev_slug" is not null;--> statement-breakpoint
-- ⑥legacy_slug 不可變 trigger（必為最末步——②的快照 UPDATE 要先跑完）。WHEN 條件讓
-- 常規 title/slug PATCH 零函式呼叫成本。日後任何要動 legacy_slug 的維護/migration
-- 必須先 DROP TRIGGER "notes_legacy_slug_guard"。
CREATE FUNCTION notes_legacy_slug_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'notes.legacy_slug is immutable (DROP TRIGGER notes_legacy_slug_guard first for maintenance)';
END
$fn$;--> statement-breakpoint
CREATE TRIGGER notes_legacy_slug_guard BEFORE UPDATE ON notes FOR EACH ROW
  WHEN (OLD.legacy_slug IS DISTINCT FROM NEW.legacy_slug)
  EXECUTE FUNCTION notes_legacy_slug_guard();
