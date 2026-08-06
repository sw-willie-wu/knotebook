import { eq } from "drizzle-orm";
import { extractRefUuid, normalizeSlug, validateSlug } from "@knotebook/shared";
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

/**
 * `GET /api/notes/:ref` 的 ref 解析（spec §11.4 逐字，序位即優先序）：
 * 1. `normalizeSlug(ref)` 精確比對 `notes.slug` 欄位——命中即回該筆 note 的 id。
 * 2. 未命中 → `extractRefUuid(ref)` 擷取尾碼/整串 uuid（涵蓋純 uuid 與
 *    `<vanity>-<uuid>` 兩種形式，見 `canonicalNotePath`）。
 * 3. 兩者皆失敗 → null，呼叫端一律映射成 404 `not_found`（防列舉，不區分
 *    「slug 不存在」與「格式看起來不像 uuid」）。
 *
 * 注意：這裡只負責「ref → noteId」，不做任何權限判斷——呼叫端仍須對解出來的
 * noteId 走 `resolveRole`（none → 404），與其他 notes 路由的防列舉原則一致。
 */
export async function resolveNoteIdFromRef(db: Db, ref: string): Promise<string | null> {
  const normalized = normalizeSlug(ref);
  const [bySlug] = await db.select({ id: notes.id }).from(notes).where(eq(notes.slug, normalized)).limit(1);
  if (bySlug) return bySlug.id;
  return extractRefUuid(ref);
}
