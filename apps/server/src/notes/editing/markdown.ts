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
  targetFromList,
} from "@knotebook/shared";
import type { VisibleNoteTarget } from "./candidates.js";

export const MAX_BLOCKS = 2000;
export type ParseError = "unsupported_block" | "unsupported_color" | "unsupported_columns" | "unsupported_size" | "empty_content" | "too_many_blocks";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
export interface ParsedMarkdown { blocks: PartialBlock<any, any, any>[]; unbound: number }

/** PUBLIC_URL 的 origin（`EditingRuntime.baseUrl` 是 `<PUBLIC_URL 的 issuer 形>/`）——#269 站內網址判準的 `siteOrigin`。 */
export function siteOriginOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

// 全在開直連前、在讀路徑 fork 的 mounted 編輯器上做：語法檢查（並排 PR-2，spec §11.3 S1–S10，在 `markdownToHTML` 的 DOM 上）
// → parse（`tryParseHTMLToBlocks`）→ mermaid 還原 → 欄寬正規化 → 站內上傳網址還原相對形 → 白名單（未知型別整筆拒絕，
// 不靜默剝除）→ 結構檢查（列／欄的位置、欄數、寬度範圍）→ 色值（#222，不在色盤整筆拒絕）→ 空判準 → block 上限（欄與欄內都計入）
// → wikilink 重綁（唯一命中才綁）→ #269 站內連結轉 wikilink（§8.5：以 lease 前預取的寫入者可見清單比對，**這裡零 DB**；轉址表／prev_slug／legacy slug
// 形不解析、維持一般連結——A9、N1）。轉不成的站內連結不計入 unbound（O5）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
export function parseMarkdownForNote(editor: BlockNoteEditor<any, any, any>, markdown: string, candidates: readonly VisibleNoteTarget[], siteOrigin: string): ParsedMarkdown | { error: ParseError } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  type AnyPartialBlock = PartialBlock<any, any, any>;
  const syntax = checkNoteMarkdownSyntax(markdown, "top");
  if (!syntax.ok) return { error: syntax.error };
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
    return { error: "unsupported_block" };
  }
  // 讀碼發現 15：parse 所用 DOM 的 base（server＝`EditingRuntime` 的全域 document，與 siteOrigin 同 origin）
  const parsed = relativizeSiteUploads(normalizeTableWidths(restoreMermaidBlocks(raw)), new URL(document.baseURI).origin);
  const known = new Set(Object.keys(editor.schema.blockSchema));
  const walk = (bs: AnyPartialBlock[]): boolean => bs.every(b => known.has(b.type as string) && (!b.children || walk(b.children as AnyPartialBlock[])));
  if (!walk(parsed)) return { error: "unsupported_block" };
  const shape = findStructureError(parsed, "top");
  if (shape !== null) return { error: shape };
  // #222：色值只收內建色名（shared 的 `findDisallowedColor`），其他值整筆拒絕——同白名單，不靜默剝除。
  if (findDisallowedColor(parsed) !== null) return { error: "unsupported_color" };
  if (isBlankParseResult(parsed)) return { error: "empty_content" };
  const count = (bs: AnyPartialBlock[]): number => bs.reduce((n, b) => n + 1 + (b.children ? count(b.children as AnyPartialBlock[]) : 0), 0);
  if (count(parsed) > MAX_BLOCKS) return { error: "too_many_blocks" };
  const [rebound, unbound] = rebindWikilinks(parsed, [...candidates], type => editor.schema.blockSchema[type]?.content === "inline");
  const [blocks] = convertSiteLinks(rebound, (_href, p) => targetFromList(p.path, candidates) ?? null, siteOrigin);
  return { blocks, unbound };
}
