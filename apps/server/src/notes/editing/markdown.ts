import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import { convertSiteLinks, isBlankParseResult, rebindWikilinks, restoreMermaidBlocks, targetFromList } from "@knotebook/shared";
import { findDisallowedColor } from "./colors.js";
import type { VisibleNoteTarget } from "./candidates.js";

export const MAX_BLOCKS = 2000;
export type ParseError = "unsupported_block" | "unsupported_color" | "empty_content" | "too_many_blocks";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
export interface ParsedMarkdown { blocks: PartialBlock<any, any, any>[]; unbound: number }

/** PUBLIC_URL 的 origin（`EditingRuntime.baseUrl` 是 `<PUBLIC_URL 的 issuer 形>/`）——#269 站內網址判準的 `siteOrigin`。 */
export function siteOriginOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

// 全在開直連前、在讀路徑 fork 的 mounted 編輯器上做：parse → mermaid 還原 → 白名單（未知型別整筆拒絕，
// 不靜默剝除）→ 色值（#222，不在色盤整筆拒絕）→ 空判準 → block 上限 → wikilink 重綁（唯一命中才綁）
// → #269 站內連結轉 wikilink（§8.5：以 lease 前預取的寫入者可見清單比對，**這裡零 DB**；轉址表／prev_slug／legacy slug
// 形不解析、維持一般連結——A9、N1）。轉不成的站內連結不計入 unbound（O5）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
export function parseMarkdownForNote(editor: BlockNoteEditor<any, any, any>, markdown: string, candidates: readonly VisibleNoteTarget[], siteOrigin: string): ParsedMarkdown | { error: ParseError } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  type AnyPartialBlock = PartialBlock<any, any, any>;
  const parsed = restoreMermaidBlocks(editor.tryParseMarkdownToBlocks(markdown) as AnyPartialBlock[]);
  const known = new Set(Object.keys(editor.schema.blockSchema));
  const walk = (bs: AnyPartialBlock[]): boolean => bs.every(b => known.has(b.type as string) && (!b.children || walk(b.children as AnyPartialBlock[])));
  if (!walk(parsed)) return { error: "unsupported_block" };
  // #222：色值只收內建色名（colors.ts），其他值整筆拒絕——同白名單，不靜默剝除。
  if (findDisallowedColor(parsed) !== null) return { error: "unsupported_color" };
  if (isBlankParseResult(parsed)) return { error: "empty_content" };
  const count = (bs: AnyPartialBlock[]): number => bs.reduce((n, b) => n + 1 + (b.children ? count(b.children as AnyPartialBlock[]) : 0), 0);
  if (count(parsed) > MAX_BLOCKS) return { error: "too_many_blocks" };
  const [rebound, unbound] = rebindWikilinks(parsed, [...candidates], type => editor.schema.blockSchema[type]?.content === "inline");
  const [blocks] = convertSiteLinks(rebound, (_href, p) => targetFromList(p.path, candidates) ?? null, siteOrigin);
  return { blocks, unbound };
}
