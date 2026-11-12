import { formatBytes } from "@knotebook/shared";
import type { ApiFail } from "@/api/client";

/** 收插值參數的翻譯函式（i18next `t` 相容）。呼叫端若自己包一層 late-bound，**必須轉傳 `opts`**（`NoteEditor.lateBoundTranslate`）。 */
export type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 409 `storage_quota_exceeded` 的說明句：server 給了用量與上限（呼叫者看得到該空間）→ `storage.quotaDetail`；
 * 否則（看不到、或欄位不完整——上限 `null` 不可能被超過，出現就當沒給）→ `storage.quotaFullGeneric`。
 * toast、FilePanel 與頭貼裁切框共用。
 *
 * 這支刻意放在不依賴編輯器的小模組：設定頁的 chunk 引用它，不能順帶拉進 BlockNote。
 */
export function storageQuotaDescription(err: ApiFail, translate: Translate): string {
  const s = err.storage;
  if (s && typeof s.usedBytes === "number" && typeof s.quotaBytes === "number") {
    return translate("storage.quotaDetail", { used: formatBytes(s.usedBytes), quota: formatBytes(s.quotaBytes) });
  }
  return translate("storage.quotaFullGeneric");
}
