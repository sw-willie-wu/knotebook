/**
 * 貼上 ```mermaid 程式碼區塊時自動轉成 mermaid block（issue #94）。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 為什麼轉換點在「blocks 層」而不是 `parse` 規則
 * ──────────────────────────────────────────────────────────────────────────
 * **兩條貼上路徑都先變成 `codeBlock(language="mermaid")`**，實測如下：
 * - markdown／純文字：`tryParseMarkdownToBlocks` 直接產出
 *   `{ type: "codeBlock", props: { language: "mermaid" } }`（2026-08-27 瀏覽器實測）。
 *   Windows 剪貼簿的 `text/plain` 正是最常見的貼上來源（見 `collab/paste.ts` 檔頭）。
 * - HTML：`tryParseHTMLToBlocks('<pre><code class="language-mermaid">…')` 也是 codeBlock——
 *   BlockNote 內建 codeBlock 的 `pre` 規則優先序高過自訂 block 的 `parse`（2026-08-28 審查
 *   實測）。`spec.tsx` 因此**沒有** `parse` 規則，`spec.test.tsx` 有一條反向釘住這件事。
 *
 * 所以轉換一律在這一層做：等 BlockNote 插完，再把**這次新插入的**
 * `codeBlock(language="mermaid")` 換成 mermaid block。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 為什麼一定要「只轉這次新插入的」
 * ──────────────────────────────────────────────────────────────────────────
 * 使用者可以把一張圖「轉回程式碼」保留著（雙向轉換）。如果這裡改成掃全文，
 * 那麼**在文件任何地方貼上任何東西**，都會把那個刻意保留的 code block 又轉回圖——
 * 使用者的明確意圖被靜默推翻。因此判定以「貼上前的 block id 集合」為界。
 *
 * ⚠ 這也是**只在本地貼上路徑做**的理由：掛全域 change handler 的話，
 * 共編時兩個 client 會同時嘗試轉換同一個 block，在 Yjs 上打架。
 */

/** 本模組會讀到的 block 形狀（BlockNote 的實際型別泛型太深，這裡只描述用得到的欄位）。 */
interface MinimalBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: MinimalBlock[];
}

export interface MermaidPasteEditor {
  document: MinimalBlock[];
  replaceBlocks(targetIds: string[], blocks: unknown[]): unknown;
}

/** 文件內所有 block 的 id（含巢狀 children）。貼上前後各取一次即可界定「新插入的」。 */
export function collectBlockIds(blocks: MinimalBlock[]): Set<string> {
  const ids = new Set<string>();
  // 迭代走訪（顯式 stack）：巢狀深度由文件內容決定，遞迴在極深的清單上會 RangeError
  // ——同 `collab/store.ts` 走訪的既有理由。
  const stack = [...blocks];
  while (stack.length > 0) {
    const block = stack.pop()!;
    ids.add(block.id);
    if (Array.isArray(block.children)) stack.push(...block.children);
  }
  return ids;
}

/** code block 的純文字內容。`codeBlock` 的 content 是 `{type:"text", text}` 陣列。 */
function codeBlockText(block: MinimalBlock): string {
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((node) => (typeof (node as { text?: unknown }).text === "string" ? (node as { text: string }).text : ""))
    .join("");
}

/** 這次新插入的、語言為 mermaid、且內容非空白的 code block。 */
export function findPastedMermaidCodeBlocks(
  document: MinimalBlock[],
  idsBeforePaste: Set<string>,
): { id: string; code: string }[] {
  const found: { id: string; code: string }[] = [];
  const stack = [...document];
  while (stack.length > 0) {
    const block = stack.pop()!;
    if (Array.isArray(block.children)) stack.push(...block.children);
    if (idsBeforePaste.has(block.id)) continue;
    if (block.type !== "codeBlock") continue;
    if (block.props?.language !== "mermaid") continue;
    const code = codeBlockText(block);
    if (code.trim().length === 0) continue; // 空的 code block 轉成空圖對使用者是降級
    found.push({ id: block.id, code });
  }
  return found;
}

/**
 * 執行轉換，回傳轉了幾個。
 *
 * ⚠ **絕不外拋**：呼叫點在貼上**已經完成之後**，這裡再拋會讓一次成功的貼上看起來像壞掉
 * （`collab/paste.ts` 檔頭記載：handler 拋錯的代價是使用者「按了完全沒反應」）。
 * 逐一 `replaceBlocks` 而非一次做完，一個失敗不影響其他。
 */
export function convertPastedMermaidBlocks(editor: MermaidPasteEditor, idsBeforePaste: Set<string>): number {
  let converted = 0;
  let targets: { id: string; code: string }[];
  try {
    targets = findPastedMermaidCodeBlocks(editor.document, idsBeforePaste);
  } catch {
    return 0;
  }
  for (const target of targets) {
    try {
      editor.replaceBlocks([target.id], [{ type: "mermaid", props: { code: target.code } }]);
      converted += 1;
    } catch {
      /* 這一個轉不了就算了，繼續下一個 */
    }
  }
  return converted;
}
