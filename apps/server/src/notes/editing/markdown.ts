import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import { isBlankParseResult, rebindWikilinks, restoreMermaidBlocks, type WikilinkTarget } from "@knotebook/shared";

export const MAX_BLOCKS = 2000;
export type ParseError = "unsupported_block" | "empty_content" | "too_many_blocks";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
export interface ParsedMarkdown { blocks: PartialBlock<any, any, any>[]; unbound: number }

// 全在開直連前、在讀路徑 fork 的 mounted 編輯器上做：parse → mermaid 還原 → 白名單（未知型別整筆拒絕，
// 不靜默剝除）→ 空判準 → block 上限 → wikilink 重綁（唯一命中才綁）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
export function parseMarkdownForNote(editor: BlockNoteEditor<any, any, any>, markdown: string, candidates: WikilinkTarget[]): ParsedMarkdown | { error: ParseError } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  type AnyPartialBlock = PartialBlock<any, any, any>;
  const parsed = restoreMermaidBlocks(editor.tryParseMarkdownToBlocks(markdown) as AnyPartialBlock[]);
  const known = new Set(Object.keys(editor.schema.blockSchema));
  const walk = (bs: AnyPartialBlock[]): boolean => bs.every(b => known.has(b.type as string) && (!b.children || walk(b.children as AnyPartialBlock[])));
  if (!walk(parsed)) return { error: "unsupported_block" };
  if (isBlankParseResult(parsed)) return { error: "empty_content" };
  const count = (bs: AnyPartialBlock[]): number => bs.reduce((n, b) => n + 1 + (b.children ? count(b.children as AnyPartialBlock[]) : 0), 0);
  if (count(parsed) > MAX_BLOCKS) return { error: "too_many_blocks" };
  const [blocks, unbound] = rebindWikilinks(parsed, candidates, type => editor.schema.blockSchema[type]?.content === "inline");
  return { blocks, unbound };
}
