import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import {
  checkNoteMarkdownSyntax,
  convertSiteLinks,
  findDisallowedColor,
  findStructureError,
  isBlankParseResult,
  normalizeTableWidths,
  rebindWikilinks,
  relativizeSiteUploads,
  restoreMermaidBlocks,
  syntaxCheckRoot,
  targetFromList,
} from "@knotebook/shared";
import type { VisibleNoteTarget } from "./candidates.js";

export const MAX_BLOCKS = 2000;
export type ParseError = "unsupported_block" | "unsupported_color" | "unsupported_columns" | "unsupported_size" | "empty_content" | "too_many_blocks";
/**
 * 錯誤碼之外的成因（8000 探索測試 E；只給 HTTP 層的檔案寫回挑訊息用，MCP 的英文訊息不看它）：`event_attr`＝帶事件屬性
 * （onerror 之類）的 HTML；`editor_internal`＝編輯器內部用的 HTML（core parse 丟例外）；`unknown_block`＝parse 出不認得的 block；
 * `dropped_element`＝含 parser 會連內容整個丟掉的元素（`DROPPED_TAGS`），不論在哪；`unclosed_comment`＝`<!--` 沒收尾、吞掉後面。
 */
export type ParseDetail = "event_attr" | "editor_internal" | "unknown_block" | "dropped_element" | "unclosed_comment";
export type ParseFailure = { error: ParseError; detail?: ParseDetail };
/**
 * parser 會連裡面的字整個丟掉、不留任何東西的元素（8000 探索測試 E＋審查裁示、第二輪 F2 加 noscript／title／template）：出現在任何
 * 位置都整筆回 `unsupported_block`，比照事件屬性，不靜默拿掉。在 DOM 上找（`syntaxCheckRoot`，同語法檢查的片段情境），所以 HTML
 * 註解裡的 `<script>`、code 裡跳脫成 `&lt;script` 的字都不算。`<embed>` 不在內：它會 parse 成 file block，不會被丟。
 * 這份清單是唯一來源：DOM 的 selector 與字串預篩（F6）都從它產生。
 */
export const DROPPED_TAGS = ["script", "style", "iframe", "object", "noscript", "title", "template"] as const;
/** `DROPPED_TAGS` 的 DOM selector（測試拿它比對預篩）。 */
export const DROPPED_SELECTOR = DROPPED_TAGS.join(", ");
/**
 * 預篩（審查 F6）：DOM 裡的元素一定來自字串裡的開始標籤（實體字元造不出元素），所以字串裡連 `<名稱` 都沒有就不可能有那個元素，
 * 不必建 DOM。`\b` 讓 `<script>`、`<script src>`、`<SCRIPT>` 命中；`<script-x>` 之類也命中，交給 DOM 判（不是 script 元素）。
 */
const DROPPED_PREFILTER = new RegExp(`<(?:${DROPPED_TAGS.join("|")})\\b`, "i");
/** `html` 裡有沒有 `DROPPED_TAGS` 的元素（預篩沒命中直接回 false）。 */
export function hasDroppedElement(html: string): boolean {
  return DROPPED_PREFILTER.test(html) && syntaxCheckRoot(html).querySelector(DROPPED_SELECTOR) !== null;
}
const UNCLOSED_COMMENT = /<!--(?![\s\S]*?-->)/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
export interface ParsedMarkdown { blocks: PartialBlock<any, any, any>[]; unbound: number }

/** PUBLIC_URL 的 origin（`EditingRuntime.baseUrl` 是 `<PUBLIC_URL 的 issuer 形>/`）——#269 站內網址判準的 `siteOrigin`。 */
export function siteOriginOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

// 全在開直連前、在讀路徑 fork 的 mounted 編輯器上做：語法檢查（並排 PR-2，spec §11.3 S1–S10，在 `markdownToHTML` 的 DOM 上）
// → 會連內容丟掉的元素（`DROPPED_TAGS`，整筆拒絕）→ parse（`tryParseHTMLToBlocks`）→ mermaid 還原 → 欄寬正規化 → 站內上傳網址還原相對形 → 白名單（未知型別整筆拒絕，
// 不靜默剝除）→ 結構檢查（列／欄的位置、欄數、寬度範圍）→ 色值（#222，不在色盤整筆拒絕）→ 空判準 → block 上限（欄與欄內都計入）
// → wikilink 重綁（唯一命中才綁）→ #269 站內連結轉 wikilink（§8.5：以 lease 前預取的寫入者可見清單比對，**這裡零 DB**；轉址表／prev_slug／legacy slug
// 形不解析、維持一般連結——A9、N1）。轉不成的站內連結不計入 unbound（O5）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
export function parseMarkdownForNote(editor: BlockNoteEditor<any, any, any>, markdown: string, candidates: readonly VisibleNoteTarget[], siteOrigin: string): ParsedMarkdown | ParseFailure {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  type AnyPartialBlock = PartialBlock<any, any, any>;
  const syntax = checkNoteMarkdownSyntax(markdown, "top");
  // shared 的 syntax 檢查只有「事件屬性」這一條會回 unsupported_block。
  if (!syntax.ok) return syntax.error === "unsupported_block" ? { error: syntax.error, detail: "event_attr" } : { error: syntax.error };
  if (hasDroppedElement(syntax.html)) return { error: "unsupported_block", detail: "dropped_element" };
  let raw: AnyPartialBlock[];
  try {
    raw = editor.tryParseHTMLToBlocks(syntax.html) as AnyPartialBlock[];
  } catch (err) {
    // core 對部分編輯器內部形會丟例外（例：`<div data-content-type="paragraph">`）：當成存不了的內容整筆拒絕，不回 500。
    // warn 一筆讓維運看得到 core 對合法內容開始丟例外（例如升級 BlockNote 後）；只記例外的類名與 stack 的呼叫框（`    at …` 行），
    // 不記 message——PM 的 `RangeError: Invalid content for node …` 之類會把內容片段拼進訊息（final review Nit 5），也不記 markdown。
    // 本模組沒有注入的 logger（簽章不變），比照 `version-fingerprint.ts` 的 console.warn。
    // 先丟掉 stack 開頭的「類名: message」那幾行（message 有幾行就丟幾行），再挑呼叫框——message 裡以「    at 」開頭的行不會混進來（cleanup r2 Nit 2）
    const frames =
      err instanceof Error
        ? (err.stack ?? "").split("\n").slice(err.message.split("\n").length).filter(l => /^\s+at /.test(l))
        : [];
    const e = { name: err instanceof Error ? err.name : typeof err, frames };
    console.warn("parseMarkdownForNote: core parse threw; rejected as unsupported_block", e);
    return { error: "unsupported_block", detail: "editor_internal" };
  }
  // 讀碼發現 15：parse 所用 DOM 的 base（server＝`EditingRuntime` 的全域 document，與 siteOrigin 同 origin）
  const parsed = relativizeSiteUploads(normalizeTableWidths(restoreMermaidBlocks(raw)), new URL(document.baseURI).origin);
  const known = new Set(Object.keys(editor.schema.blockSchema));
  const walk = (bs: AnyPartialBlock[]): boolean => bs.every(b => known.has(b.type as string) && (!b.children || walk(b.children as AnyPartialBlock[])));
  if (!walk(parsed)) return { error: "unsupported_block", detail: "unknown_block" };
  const shape = findStructureError(parsed, "top");
  if (shape !== null) return { error: shape };
  // #222：色值只收內建色名（shared 的 `findDisallowedColor`），其他值整筆拒絕——同白名單，不靜默剝除。
  if (findDisallowedColor(parsed) !== null) return { error: "unsupported_color" };
  if (isBlankParseResult(parsed)) {
    // 未閉合 `<!--` 吞掉一切 → 照舊 empty_content、帶成因（8000 探索測試 E）。會被丟掉的元素在 parse 前就整筆拒絕了（見 DROPPED_TAGS）。
    return UNCLOSED_COMMENT.test(markdown) ? { error: "empty_content", detail: "unclosed_comment" } : { error: "empty_content" };
  }
  const count = (bs: AnyPartialBlock[]): number => bs.reduce((n, b) => n + 1 + (b.children ? count(b.children as AnyPartialBlock[]) : 0), 0);
  if (count(parsed) > MAX_BLOCKS) return { error: "too_many_blocks" };
  const [rebound, unbound] = rebindWikilinks(parsed, [...candidates], type => editor.schema.blockSchema[type]?.content === "inline");
  const [blocks] = convertSiteLinks(rebound, (_href, p) => targetFromList(p.path, candidates) ?? null, siteOrigin);
  return { blocks, unbound };
}
