/**
 * AI 動作（#263 spec 2026-10-12 §4.1、§4.3）：內建動作的固定 id、Instruct 的長度上限、code point 計數。
 * server（seed、`POST /api/ai`、admin 路由）與 web（chip 的 icon 對應、輸入框上限）共用這一份。
 *
 * 內建 id 一次生成後寫死：seed 以 `ON CONFLICT (id) DO NOTHING` 判斷「已存在」，id 若每次現生就會重複插入。
 * 前四個沿用 Plan 4 的值（DB 裡已有，改了就是另一筆動作）；Instruct 於 2026-10-12 產生。
 */
export const REWRITE_ACTION_ID = "ab0a1517-bec1-4709-b13f-756548375b86";
export const TRANSLATE_ACTION_ID = "362788cb-d2f0-41ce-b697-c929b67bf20e";
export const SUMMARIZE_ACTION_ID = "2e37a47e-a6cd-4f14-b2f6-0cdebd715b2a";
export const CONTINUE_WRITING_ACTION_ID = "4a8e18da-1d9c-4be1-ba32-a0c5429b0a22";
/** 第五個內建動作「Instruct」：使用者自由輸入指令（§4.1）。 */
export const INSTRUCT_ACTION_ID = "58ef60fd-e99e-4f19-aa57-6fea5e652749";

/** 不可刪除、重啟補種的內建動作（§4.1）。 */
export const BUILTIN_ACTION_IDS: readonly string[] = [
  REWRITE_ACTION_ID,
  TRANSLATE_ACTION_ID,
  SUMMARIZE_ACTION_ID,
  CONTINUE_WRITING_ACTION_ID,
  INSTRUCT_ACTION_ID,
];

/** `POST /api/ai` 的 `instruction`（trim 後）上限，以 code point 計（§4.3）。 */
export const INSTRUCTION_MAX_CODE_POINTS = 500;
/** `POST /api/ai` 的 `focus` 上限，以 code point 計（§4.3）。 */
export const FOCUS_MAX_CODE_POINTS = 2000;

/** `"instruct"`＝內建 Instruct（web 畫輸入框）；其餘一律 `"quick"`（web 畫 chip）。 */
export type AiActionKind = "quick" | "instruct";

/** `kind` 只由 id 決定：Instruct 是唯一的 `"instruct"`，管理員新增的自訂動作一律 `"quick"`。 */
export function aiActionKind(actionId: string): AiActionKind {
  return actionId === INSTRUCT_ACTION_ID ? "instruct" : "quick";
}

/** 以 code point 計長度（`Array.from` 依 code point 迭代；`.length` 是 UTF-16 單位，emoji 會算成 2）。 */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

/** 截到前 `max` 個 code point；沒超過就原樣回傳（不切半個 surrogate pair）。 */
export function truncateCodePoints(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join("");
}
