import { normalizeEmail } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { PIECE_RE, SEGMENT_SEPARATOR_RE } from "@/lib/email-list";

/**
 * 群組成員的批次加入（一次加很多人；純前端、沿用單人的 `PUT /api/groups/:id/members`）。
 * 是**一次性的複製**：從別的群組匯入後，兩邊的名單各自獨立，之後不會同步。
 * 每次的人數不設上限（Willie 2026-10-28 裁定）；`user_not_found` 會透露帳號是否存在、server 沒有逐人節流，
 * 這兩點記在 docs/known-limitations.md。
 * 只被 `GroupMembersSection`／`BulkAddDialog`（lazy 的 GroupSections chunk）與測試 import。
 */

/** 只擋明顯不是 email 的字（server 的 zod `.email()` 才是裁決者：過不了回 400 `invalid_body`，下面一樣歸「格式不對」）。 */
const EMAIL_LIKE_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+$/;

/** 信件收件人欄的 `"Lee, Ann" <ann@x.com>`：引號裡的顯示名可能含逗號，先拿掉（只拿掉緊接著 `<` 的那種，單獨一個 `"ann@x.com"` 不動）。 */
const QUOTED_NAME_BEFORE_ANGLE_RE = /"[^"]*"\s*(?=<)/g;
const HAS_ANGLES_RE = /<[^<>]*>/;
// 分段（SEGMENT_SEPARATOR_RE）與段內切片（PIECE_RE）在 lib/email-list.ts：與加成員框的建議（UserEmailCombobox multiple）共用一份

/**
 * 把貼上的一串地址拆開：先依逗號、分號（半形、全形）、頓號、換行切段，段內再依空白切。
 * 段內有 `<…>`（從信件收件人欄貼過來的 `名字 <地址>`）時，括號內的一律收；括號外像 email 的照收
 * （`a@x.com b@x.com Carol <c@x.com>` 三個都要）；不含 `@` 的是名字，略過、不算錯；含 `@` 但不像 email 的
 * （`bob@@x.com`、`bob@`）是打錯的地址，進 `invalid`。
 * 每個片段去掉包著的引號與殘留的 `<>`。大小寫不分去重（保留第一次出現的寫法）。
 * 看起來不像 email 的片段放進 `invalid`（同樣去重），不送出。
 * `all`＝兩者依輸入順序合起來（停下或有沒加成的時候，依原順序放回輸入框）。
 * 不支援 Outlook 不帶引號的 `Lee, Ann <ann@x.com>`：逗號先切段，`Lee` 會列成 invalid。
 */
export function parseEmailList(text: string): { emails: string[]; invalid: string[]; all: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  const all: string[] = [];
  const seen = new Set<string>();
  for (const segment of text.replace(QUOTED_NAME_BEFORE_ANGLE_RE, "").split(SEGMENT_SEPARATOR_RE)) {
    const hasAngles = HAS_ANGLES_RE.test(segment);
    for (const match of segment.matchAll(PIECE_RE)) {
      const inAngles = match[1] !== undefined;
      const token = (match[1] ?? match[0]).trim().replace(/^[<"']+|[>"']+$/g, "");
      if (token.length === 0) continue;
      if (hasAngles && !inAngles && !token.includes("@")) continue; // 名字（含 `@` 的打錯地址照樣進 invalid、留在輸入框）
      const key = normalizeEmail(token);
      if (seen.has(key)) continue;
      seen.add(key);
      (EMAIL_LIKE_RE.test(token) ? emails : invalid).push(token);
      all.push(token);
    }
  }
  return { emails, invalid, all };
}

/**
 * 每個地址的結果：
 * - `added`：加入成功；`notFound`：404 `user_not_found`（沒有這個帳號）；`alreadyMember`：409 `already_member`
 *   或送出前就在名單裡；`invalid`：格式不對（client 先擋，或 server 400 `invalid_body`）；
 * - `failed`：讓整批停下的那一個；`notProcessed`：停下（出錯或按「停止」）之後沒送出的。
 */
export type BulkAddOutcome = "added" | "notFound" | "alreadyMember" | "invalid" | "failed" | "notProcessed";

export interface BulkAddResult {
  email: string;
  outcome: BulkAddOutcome;
}

export interface BulkAddReport {
  /** 依送出順序。 */
  results: BulkAddResult[];
  /** 讓整批停下的錯誤（權限被收回、群組不見了、角色被刪、5xx、網路錯誤、反代的 429…）；沒出錯則為 null。 */
  stopped: { cause: unknown } | null;
  /** 使用者按了「停止」（或關掉對話框、元件卸載）：正在送的那一筆跑完後停下，其餘記 `notProcessed`。 */
  cancelled: boolean;
}

/** 逐項結果才略過、繼續；其餘一律停下（同選取模式批次的原則：不認得的錯誤不硬跑下去）。 */
export function classifyAddError(err: unknown): Exclude<BulkAddOutcome, "added" | "failed" | "notProcessed"> | "stop" {
  if (!(err instanceof ApiFail)) return "stop";
  if (err.status === 404 && err.code === "user_not_found") return "notFound";
  if (err.status === 409 && err.code === "already_member") return "alreadyMember";
  if (err.status === 400 && err.code === "invalid_body") return "invalid";
  return "stop";
}

/** 是不是節流（429）——停下時給「稍後再加其餘的」提示。群組成員路由本身沒有節流，429 只可能來自反向代理。 */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiFail && err.status === 429;
}

/**
 * 依序（await 完一個才送下一個）。不開批次端點：沿用單人端點的交易、權限與 409 守法；依序才停得住、才回報得出做到哪。
 * `onProgress(processed, total)` 在每項結束（成功、略過）後呼叫。`add` 丟出 classify 為 `stop` 的錯誤時：那一項記 `failed`、
 * 其後全部記 `notProcessed`，回傳 `stopped`。
 * `signal`：每送一筆**之前**檢查；已 abort 就不再送，其餘記 `notProcessed`、`cancelled: true`。正在送的那一筆不中斷
 * （請求已經出去了，等它回來才知道有沒有加成）。
 */
export async function runBulkAdd(
  emails: readonly string[],
  add: (email: string) => Promise<unknown>,
  onProgress?: (processed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<BulkAddReport> {
  const results: BulkAddResult[] = [];
  const rest = (from: number) => emails.slice(from).map((email) => ({ email, outcome: "notProcessed" as const }));
  for (const [index, email] of emails.entries()) {
    if (signal?.aborted) return { results: [...results, ...rest(index)], stopped: null, cancelled: true };
    try {
      await add(email);
      results.push({ email, outcome: "added" });
    } catch (err) {
      const kind = classifyAddError(err);
      if (kind === "stop") {
        results.push({ email, outcome: "failed" });
        return { results: [...results, ...rest(index + 1)], stopped: { cause: err }, cancelled: false };
      }
      results.push({ email, outcome: kind });
    }
    onProgress?.(index + 1, emails.length);
  }
  return { results, stopped: null, cancelled: false };
}
