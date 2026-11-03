import { TOP_SECTION_ID } from "@knotebook/shared";
import { foldedIndexOf } from "@/lib/search-match";

/**
 * #93 PR2：在編輯器 DOM 裡，找「某個段落範圍內第一個含查詢字的 block」（側欄全文搜尋點片段 → 跳到命中的那一行，不只是段落標題）。
 *
 * - **段落範圍＝`note-sections.ts` 的 `sectionize`**：只看頂層單位（`.bn-editor > .bn-block-group` 的直接子節點：`.bn-block-outer` 與
 *   並排列 `columnList`）；頂層 heading 開新段的條件與 `sectionize` 相同（`level <= 目前段的 level`，或目前是 `_top`）——較深的子標題不另成段、
 *   欄內的 heading 不切段。`_top` ＝筆記開頭到第一個切段 heading 之前。
 * - 範圍內依文件順序（前序：父先於子）逐個 `.bn-block-outer[data-id]`，比對的是**該 block 自己的文字**（不含巢狀子 block），
 *   所以嵌套清單子項、欄內命中會回最內層真正含字的那個 block。
 * - 比對用 `foldedIndexOf`（與標亮同一支）。查詢字是**一整段子字串**（server 也這樣比），沒有「多個詞」要選：`findText` 就是 `forQuery`。
 * - 找不到 → null（呼叫端退回段落標題）。
 */
const GROUP = ".bn-editor > .bn-block-group";
const OUTER_SELF = ":scope > .bn-block > .bn-block-content";

function headingLevel(unit: HTMLElement): number | null {
  const content = unit.matches(".bn-block-outer") ? unit.querySelector<HTMLElement>(`${OUTER_SELF}[data-content-type="heading"]`) : null;
  if (!content) return null;
  const level = Number(content.getAttribute("data-level") ?? "1");
  return Number.isFinite(level) ? level : 1;
}

/**
 * block 自己的文字：行內內容、`<pre>`（程式碼區塊）與表格格子（`td, th`——格子是 `<td><p>`，沒有 `.bn-inline-content`）；
 * mermaid 讀 `data-code`（server 索引收的就是 mermaid 的 `code` 屬性，`search-text.ts`）。不收 `<select>`（語言選單的選項）與巢狀子 block。
 */
function ownText(outer: HTMLElement): string {
  const content = outer.querySelector<HTMLElement>(OUTER_SELF);
  if (!content) return "";
  if (content.getAttribute("data-content-type") === "mermaid") return content.getAttribute("data-code") ?? "";
  return Array.from(content.querySelectorAll<HTMLElement>(".bn-inline-content, pre, td, th"))
    .map((el) => el.textContent ?? "")
    .join("\n");
}

/** 頂層單位依文件順序；root 內還沒有編輯器（尚未掛上）→ null。 */
export function topUnits(root: HTMLElement): HTMLElement[] | null {
  const group = root.querySelector<HTMLElement>(GROUP);
  if (!group) return null;
  return Array.from(group.querySelectorAll<HTMLElement>(':scope > :is(.bn-block-outer, [data-node-type="columnList"])'));
}

/** 這個段落的頂層單位；找不到該 heading（`sectionId` 不在 DOM）→ null。 */
export function sectionUnits(root: HTMLElement, sectionId: string): HTMLElement[] | null {
  const units = topUnits(root);
  if (units === null) return null;
  let curId = TOP_SECTION_ID;
  let curLevel = 0;
  let found = sectionId === TOP_SECTION_ID;
  const picked: HTMLElement[] = [];
  for (const unit of units) {
    const level = headingLevel(unit);
    if (level !== null && (curLevel === 0 || level <= curLevel)) {
      curId = unit.getAttribute("data-id") ?? "";
      curLevel = level;
      // 同 id 的段出現第二次（複製貼上留下的重複 id）：server 只收第一段，這裡也只取第一段。
      if (curId === sectionId && found && sectionId !== TOP_SECTION_ID) break;
      if (curId === sectionId) found = true;
    }
    if (curId === sectionId) picked.push(unit);
  }
  return found ? picked : null;
}

const COLLAPSED = ':scope > .bn-block > :is(.bn-block-content, .react-renderer) .bn-toggle-wrapper[data-show-children="false"]';

/**
 * 命中的 block 若在收合的 toggle（toggleListItem、可收合的 heading）底下，子 block 被 `display:none` 藏起來，捲不到、也量不到。
 * 改回**最外層**那個收合的 toggle 的 `.bn-block-outer`（用 `data-show-children="false"` 判斷）。
 */
function visibleTarget(root: HTMLElement, outer: HTMLElement): HTMLElement {
  let result = outer;
  for (let node = outer.parentElement?.closest<HTMLElement>(".bn-block-outer") ?? null; node && root.contains(node); node = node.parentElement?.closest<HTMLElement>(".bn-block-outer") ?? null) {
    if (node.querySelector(COLLAPSED) !== null) result = node;
  }
  return result;
}

/** 回範圍內第一個含 `findText` 的 block（`.bn-block-outer[data-id]`；在收合的 toggle 底下則回最外層收合的 toggle）；沒有（或範圍不存在）→ null。 */
export function findMatchBlock(root: HTMLElement, sectionId: string, findText: string): HTMLElement | null {
  const lowerQuery = findText.toLowerCase();
  if (lowerQuery === "") return null;
  const units = sectionUnits(root, sectionId);
  if (units === null) return null;
  for (const unit of units) {
    const outers = [
      ...(unit.matches(".bn-block-outer[data-id]") ? [unit] : []),
      ...Array.from(unit.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]")),
    ];
    for (const outer of outers) {
      if (foldedIndexOf(ownText(outer), lowerQuery) >= 0) return visibleTarget(root, outer);
    }
  }
  return null;
}
