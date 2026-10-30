import { BlockNoteEditor, type Block } from "@blocknote/core";
import { blocksToNoteMarkdown, createHeadlessNoteSchema, wikilinksToLinks } from "@knotebook/shared";

/**
 * 站內 AI 送出用的序列化器（spec §11.2、§11.6）：與 server 讀路徑同一個 headless schema、同一支 shared
 * `blocksToNoteMarkdown`，兩端只差 DOM 序列化本身。只建一次、重複使用，從不 mount（同 `lib/version-snapshot.ts`）。
 */
let serializer: ReturnType<typeof createSerializer> | null = null;
function createSerializer() {
  return BlockNoteEditor.create({ schema: createHeadlessNoteSchema(window.location.href) });
}

/**
 * 站內 AI 送出的 markdown：`wikilinksToLinks`（`titleOf`＝現行標題查找）→ shared `blocksToNoteMarkdown`。
 * `/notes/` 連結文字的跳脫只在共用序列化裡做一次（spec §11.6 M-4）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 ai/apply.ts）
export function aiMarkdownOf(blocks: readonly Block<any, any, any>[], titleOf: (id: string) => string | undefined): string {
  serializer ??= createSerializer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 筆記頁編輯器與 headless 的 schema 同 config、泛型不同
  return blocksToNoteMarkdown(serializer, wikilinksToLinks(blocks, titleOf) as any);
}
