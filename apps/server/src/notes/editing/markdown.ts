import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import {
  BLOCK_PRECHECK_MIN_CHARS,
  MAX_HTML_DEPTH,
  checkNoteMarkdownSyntax,
  convertSiteLinks,
  findParseGuardFailure,
  findStructureError,
  htmlDepth,
  isBlankParseResult,
  normalizeNoteColors,
  normalizeTableWidths,
  plainParagraphFloor,
  premergeParagraphs,
  premergedHtml,
  rebindWikilinks,
  relativizeSiteUploads,
  restoreMermaidBlocks,
  syntaxCheckRoot,
  targetFromList,
  topLevelBlockFloor,
} from "@knotebook/shared";
import type { VisibleNoteTarget } from "./candidates.js";

export const MAX_BLOCKS = 2000;
export type ParseError = "unsupported_block" | "unsupported_color" | "unsupported_columns" | "unsupported_size" | "empty_content" | "too_many_blocks";
/**
 * 錯誤碼之外的成因（只給 HTTP 層的檔案寫回挑訊息用，MCP 的英文訊息不看它）：`event_attr`＝帶事件屬性
 * （onerror 之類）的 HTML；`editor_internal`＝編輯器內部用的 HTML（core parse 丟例外）；`unknown_block`＝parse 出不認得的 block；
 * `dropped_element`＝含 parser 會連內容整個丟掉的元素（`DROPPED_TAGS`），不論在哪；`unclosed_comment`＝`<!--` 沒收尾、吞掉後面；
 * `nested_paragraph`＝段落裡又有段落（經 `<button>`、`<marquee>`、`<svg>` 的 foreignObject、`<math>` 的 mtext 之類）；`too_deep`＝HTML 或
 * 引言巢狀超過 `MAX_HTML_DEPTH` 層（在語法檢查的 DOM 上算；4）；`too_complex`＝解析超過時限、用完記憶體或堆疊
 * （#398：在 worker 裡解析，`parse-pool.ts` 判，不是這支函式回的；MCP 與 REST 的訊息也看它）。
 */
export type ParseDetail = "event_attr" | "editor_internal" | "unknown_block" | "dropped_element" | "unclosed_comment" | "nested_paragraph" | "too_deep" | "too_complex";
export type ParseFailure = { error: ParseError; detail?: ParseDetail };
/**
 * parser 會連裡面的字整個丟掉、不留任何東西的元素（含 noscript／title／template）：出現在任何
 * 位置都整筆回 `unsupported_block`，比照事件屬性，不靜默拿掉。在 DOM 上找（`syntaxCheckRoot`，同語法檢查的片段情境），所以 HTML
 * 註解裡的 `<script>`、code 裡跳脫成 `&lt;script` 的字都不算。`<embed>` 不在內：它會 parse 成 file block，不會被丟。
 * 這份清單是唯一來源：DOM 的 selector 與字串預篩都從它產生。
 */
export const DROPPED_TAGS = ["script", "style", "iframe", "object", "noscript", "title", "template"] as const;
/** `DROPPED_TAGS` 的 DOM selector（測試拿它比對預篩）。 */
export const DROPPED_SELECTOR = DROPPED_TAGS.join(", ");
/**
 * 預篩：DOM 裡的元素一定來自字串裡的開始標籤（實體字元造不出元素），所以字串裡連 `<名稱` 都沒有就不可能有那個元素，
 * 不必建 DOM。`\b` 讓 `<script>`、`<script src>`、`<SCRIPT>` 命中；`<script-x>` 之類也命中，交給 DOM 判（不是 script 元素）。
 */
const DROPPED_PREFILTER = new RegExp(`<(?:${DROPPED_TAGS.join("|")})\\b`, "i");
/** `html` 裡有沒有 `DROPPED_TAGS` 的元素（預篩沒命中直接回 false）。 */
export function hasDroppedElement(html: string): boolean {
  return DROPPED_PREFILTER.test(html) && syntaxCheckRoot(html).querySelector(DROPPED_SELECTOR) !== null;
}
const UNCLOSED_COMMENT = /<!--(?![\s\S]*?-->)/;

// #398：解析前的保護（深度、段落裡的段落、引言／標題／summary 多段落先併、block 數下界）搬到 shared，與網頁站內 AI 共用；這裡轉出給既有呼叫端。
export { BLOCK_PRECHECK_MIN_CHARS, MAX_HTML_DEPTH, htmlDepth, plainParagraphFloor, premergeParagraphs, topLevelBlockFloor };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
export interface ParsedMarkdown { blocks: PartialBlock<any, any, any>[]; unbound: number }

/** PUBLIC_URL 的 origin（`EditingRuntime.baseUrl` 是 `<PUBLIC_URL 的 issuer 形>/`）——#269 站內網址判準的 `siteOrigin`。 */
export function siteOriginOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

// #398：生產上整支在 parse worker 裡跑（`parse-worker.ts`；時限、記憶體上限、排隊在 `parse-pool.ts`），編輯器是 worker 裡那顆不 mount、
// 不連協作的 headless 編輯器（`parse-core.ts`）；這支本身是純函式、零 DB、不碰筆記。
// 順序：block 上限預判（第一層）→ 語法檢查（在 `markdownToHTML` 的 DOM 上）
// → 會連內容丟掉的元素（`DROPPED_TAGS`，整筆拒絕）→ 巢狀深度（`MAX_HTML_DEPTH`）→ 段落裡的段落（整筆拒絕）→ block 上限預判（第二層）→ 引言／標題／summary 的多段落先併 → parse（`tryParseHTMLToBlocks`）→ mermaid 還原 → 欄寬正規化 → 站內上傳網址還原相對形 → 白名單（未知型別整筆拒絕，
// 不靜默剝除）→ 結構檢查（列／欄的位置、欄數、寬度範圍）→ 色值（#222，不在色盤整筆拒絕）→ 空判準 → block 上限（欄與欄內都計入）
// → wikilink 重綁（唯一命中才綁）→ #269 站內連結轉 wikilink（以 lease 前預取的寫入者可見清單比對，**這裡零 DB**；轉址表／prev_slug／legacy slug
// 形不解析、維持一般連結）。轉不成的站內連結不計入 unbound。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
export function parseMarkdownForNote(editor: BlockNoteEditor<any, any, any>, markdown: string, candidates: readonly VisibleNoteTarget[], siteOrigin: string): ParsedMarkdown | ParseFailure {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  type AnyPartialBlock = PartialBlock<any, any, any>;
  // block 上限的兩層便宜預判（見 `plainParagraphFloor`／`topLevelBlockFloor`）——超過一定超過，不進昂貴的解析。
  if (plainParagraphFloor(markdown) > MAX_BLOCKS) return { error: "too_many_blocks" };
  // #398：不再有語法檢查之前的字串估計（它本身平方成長、會誤擋程式碼區塊裡的 `<T>`）：幾千層巢狀讓語法檢查堆疊溢位或拖上數秒的檔，
  // 由 worker 的時限與堆疊上限兜住（回 `too_complex`）。
  const syntax = checkNoteMarkdownSyntax(markdown, "top");
  // shared 的 syntax 檢查只有「事件屬性」這一條會回 unsupported_block。
  if (!syntax.ok) return syntax.error === "unsupported_block" ? { error: syntax.error, detail: "event_attr" } : { error: syntax.error };
  // 下面的檢查與預先併段落共用同一份 DOM（建一次）；預先併段落會就地改它，所以排最後。
  const root = syntaxCheckRoot(syntax.html);
  if (DROPPED_PREFILTER.test(syntax.html) && root.querySelector(DROPPED_SELECTOR) !== null) return { error: "unsupported_block", detail: "dropped_element" };
  // shared 的保護（與網頁站內 AI 同一套）：深度超過 `MAX_HTML_DEPTH`、段落裡又有段落 → 整筆拒絕。
  const guard = findParseGuardFailure(root);
  if (guard !== null) return { error: "unsupported_block", detail: guard };
  if (markdown.length >= BLOCK_PRECHECK_MIN_CHARS && topLevelBlockFloor(root) > MAX_BLOCKS) return { error: "too_many_blocks" };
  let raw: AnyPartialBlock[];
  try {
    // 引言、標題、summary 底下的多段落先併好（BlockNote 自己併是平方成長；見 shared 的 `premergeInto`）。
    const html = premergedHtml(syntax.html, root);
    raw = editor.tryParseHTMLToBlocks(html) as AnyPartialBlock[];
  } catch (err) {
    // core 對部分編輯器內部形會丟例外（例：`<div data-content-type="paragraph">`）：當成存不了的內容整筆拒絕，不回 500。
    // warn 一筆讓維運看得到 core 對合法內容開始丟例外（例如升級 BlockNote 後）；只記例外的類名與 stack 的呼叫框（`    at …` 行），
    // 不記 message——PM 的 `RangeError: Invalid content for node …` 之類會把內容片段拼進訊息，也不記 markdown。
    // 本模組沒有注入的 logger（簽章不變），比照 `version-fingerprint.ts` 的 console.warn。
    // 先丟掉 stack 開頭的「類名: message」那幾行（message 有幾行就丟幾行），再挑呼叫框——message 裡以「    at 」開頭的行不會混進來
    const frames =
      err instanceof Error
        ? (err.stack ?? "").split("\n").slice(err.message.split("\n").length).filter(l => /^\s+at /.test(l))
        : [];
    const e = { name: err instanceof Error ? err.name : typeof err, frames };
    console.warn("parseMarkdownForNote: core parse threw; rejected as unsupported_block", e);
    return { error: "unsupported_block", detail: "editor_internal" };
  }
  // parse 所用 DOM 的 base（server＝`EditingRuntime` 的全域 document，與 siteOrigin 同 origin）
  const parsed = relativizeSiteUploads(normalizeTableWidths(restoreMermaidBlocks(raw)), new URL(document.baseURI).origin);
  const known = new Set(Object.keys(editor.schema.blockSchema));
  const walk = (bs: AnyPartialBlock[]): boolean => bs.every(b => known.has(b.type as string) && (!b.children || walk(b.children as AnyPartialBlock[])));
  if (!walk(parsed)) return { error: "unsupported_block", detail: "unknown_block" };
  const shape = findStructureError(parsed, "top");
  if (shape !== null) return { error: shape };
  // #378：色值收內建色名與色碼，就地正規化成小寫 `#rrggbb`，其他整筆拒絕（不靜默剝除）。
  if (normalizeNoteColors(parsed) !== null) return { error: "unsupported_color" };
  if (isBlankParseResult(parsed)) {
    // 未閉合 `<!--` 吞掉一切 → 照舊 empty_content、帶成因。會被丟掉的元素在 parse 前就整筆拒絕了（見 DROPPED_TAGS）。
    return UNCLOSED_COMMENT.test(markdown) ? { error: "empty_content", detail: "unclosed_comment" } : { error: "empty_content" };
  }
  const count = (bs: AnyPartialBlock[]): number => bs.reduce((n, b) => n + 1 + (b.children ? count(b.children as AnyPartialBlock[]) : 0), 0);
  if (count(parsed) > MAX_BLOCKS) return { error: "too_many_blocks" };
  const [rebound, unbound] = rebindWikilinks(parsed, [...candidates], type => editor.schema.blockSchema[type]?.content === "inline");
  const [blocks] = convertSiteLinks(rebound, (_href, p) => targetFromList(p.path, candidates) ?? null, siteOrigin);
  return { blocks, unbound };
}
