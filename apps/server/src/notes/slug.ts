import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { autoSlugFromTitle, extractRefUuid, normalizeSlug, validateSlug } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";

/**
 * 把 `validateSlug` 回傳的違規原因轉成使用者看得懂的訊息（spec §11.4 分支順序：
 * length → charset → dash → reserved → uuid_like）——這裡刻意不逐字照抄
 * `validateSlug` 的英文型別名稱，讓 400 回應的 `message` 對終端使用者友善。
 */
function slugErrorMessage(reason: NonNullable<ReturnType<typeof validateSlug>>): string {
  switch (reason) {
    case "length":
      return "網址代稱長度需為 1–100 字元";
    case "charset":
      return "網址代稱只能包含文字、數字與連字號（-）";
    case "dash":
      return "網址代稱不可以連字號開頭/結尾，也不可連續出現";
    case "reserved":
      return "此網址代稱為系統保留字，不可使用";
    case "uuid_like":
      return "網址代稱不可為 UUID 格式（會與系統內部識別碼混淆）";
  }
}

export type SlugValidationResult = { ok: true; value: string } | { ok: false; message: string };

/**
 * PATCH /api/notes/:id 帶非 null `slug` 時的正規化+驗證入口：`normalizeSlug` →
 * `validateSlug`，違者回傳可直接塞進 400 `invalid_body` 的訊息。呼叫端（routes/notes.ts）
 * 只需處理這個聯集，不必自己重複組裝 `normalizeSlug`/`validateSlug` 兩支呼叫。
 */
export function prepareSlugForPatch(raw: string): SlugValidationResult {
  const normalized = normalizeSlug(raw);
  const reason = validateSlug(normalized);
  if (reason) {
    return { ok: false, message: slugErrorMessage(reason) };
  }
  return { ok: true, value: normalized };
}

// auto slug 探測上限（#122 spec §3a，同 auth/handle.ts 的 PROBE_LIMIT 理由與可見性）：
// 探測是 O(同前綴數) 次索引查詢、title PATCH 無節流，上界必須有。超限退 `untitled-<uuid8>`。
const AUTO_SLUG_PROBE_LIMIT = 20;

/** 探測全敗／UPDATE 重試耗盡時的最終退位形（碰撞機率 ~2^-32，撞上就讓唯一索引裁決）。 */
export function fallbackAutoSlug(): string {
  return `untitled-${randomUUID().slice(0, 8)}`;
}

/**
 * auto slug 的 owner 範圍去重探測（#122 spec §3a）：候選＝`autoSlugFromTitle(title)`，
 * 已占用則遞增 `-N` 尾碼（重截基底使總長 ≤60，同 0007 backfill 的 SQL 版）；探測
 * `AUTO_SLUG_PROBE_LIMIT` 次仍撞 → `untitled-<uuid8>`。
 *
 * **述詞必排除本列**（`id <> noteId`）——不排除的話「標題微調但 auto slug 不變」會把
 * 自己判成占用、網址在 `meeting`↔`meeting-2` 間震盪且每次舊網址即死（spec M5-1）。
 *
 * 明文特赦（同 deriveHandle）：這是可用性探測、非唯一性裁決——`(owner_id, slug)`
 * 唯一索引仍是最終裁決者；探測後仍撞（真競態）由呼叫端重探測重發（PATCH 的重試迴圈）。
 */
export async function deriveUniqueAutoSlug(db: Db, ownerId: string, noteId: string, title: string): Promise<string> {
  const base = autoSlugFromTitle(title);
  let cand = base;
  for (let n = 1; n <= AUTO_SLUG_PROBE_LIMIT; n++) {
    const [hit] = await db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.ownerId, ownerId), eq(notes.slug, cand), ne(notes.id, noteId)))
      .limit(1);
    if (!hit) return cand;
    const suffix = `-${n + 1}`;
    const trimmed = Array.from(base).slice(0, 60 - suffix.length).join("").replace(/-+$/, "");
    cand = `${trimmed}${suffix}`;
  }
  return fallbackAutoSlug();
}

/**
 * 舊形 `GET /api/notes/:ref` 的 ref 解析（#122 spec §3a 起，序位即優先序）：
 * 1. `normalizeSlug(ref)` 精確比對 **`notes.legacy_slug`**（0007 凍結快照，全域唯一、
 *    trigger 保證不可變）——**刻意不查現行 `notes.slug`**：slug 已是 per-user 唯一，
 *    跨 owner 同名時全域查找沒有確定答案；舊形連結凍結在 0007 當下的世界。
 *    「A 的 legacy 與 B 之後設的同名現行 custom 並存 → `/notes/<名>` 解到 A」＝
 *    設計意圖（劫持反例測試釘住），新形網址走 by-path 不經這裡。
 * 2. 未命中 → `extractRefUuid(ref)` 擷取尾碼/整串 uuid（涵蓋純 uuid 與舊版
 *    `<vanity>-<uuid>` 兩種形式）——這使 0007 之前發出去的所有連結永久可解。
 * 3. 兩者皆失敗 → null，呼叫端一律映射成 404 `not_found`（防列舉，不區分
 *    「slug 不存在」與「格式看起來不像 uuid」）。
 *
 * 注意：這裡只負責「ref → noteId」，不做任何權限判斷——呼叫端仍須對解出來的
 * noteId 走 `resolveRole`（none → 404），與其他 notes 路由的防列舉原則一致。
 */
export async function resolveNoteIdFromRef(db: Db, ref: string): Promise<string | null> {
  const normalized = normalizeSlug(ref);
  const [byLegacy] = await db.select({ id: notes.id }).from(notes).where(eq(notes.legacySlug, normalized)).limit(1);
  if (byLegacy) return byLegacy.id;
  return extractRefUuid(ref);
}
