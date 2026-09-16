/**
 * markdown 連結語法（`[文字](網址)`）的裁決：**不自己寫語法 regex、不自己維護 scheme
 * 白名單**，整段文字交給剖析器，只認「最後一個 inline content 是 link 且其還原等於文字
 * 尾段」這一種結果——`![a](url)`、`\[a](url)` 這類前綴因此由剖析器自己排除，不必黑名單。
 *
 * 判準的來由、已知例外、以及「為什麼不收窄 scheme」全在
 * `docs/superpowers/specs/2026-09-15-99-markdown-link-input-rule-design.md`。
 */
import { Extension, InputRule } from "@tiptap/core";
import { SuggestionMenu } from "@blocknote/core";
import type { EditorRef } from "@/components/wikilink/menu";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 NoteEditor.tsx、wikilink/menu.ts）
type AnyEditor = any;

export interface TrailingLink {
  /** 連結的顯示文字。 */
  text: string;
  /** 連結的 href，逐字取自剖析結果（不做任何正規化）。 */
  href: string;
  /** 還原出的 markdown 長度＝要被取代掉的尾段長度。⚠ 它含**尚未進文件**的那個 `)`。 */
  matchedLength: number;
}

export function resolveTrailingMarkdownLink(editor: AnyEditor, textBefore: string): TrailingLink | null {
  // 最便宜的早退：絕大多數擊鍵停在這裡，剖析成本只在真的打了 `)` 時才付。
  if (!textBefore.endsWith(")")) return null;

  const blocks = editor.tryParseMarkdownToBlocks(textBefore);
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  // ⚠ 判準寫成**正面條件**，不是逐一排除已知的壞形狀：`content` 實測有三種會爆的形——
  // `image` block 根本沒有這個欄位、空顯示文字的 paragraph 是空陣列、`table` 是物件
  // （`{type:"tableContent",…}`）。逐一排除的寫法漏過 table 那種並丟 TypeError，而
  // 例外會一路打到 DOM 事件處理、整次擊鍵掉。
  const content = blocks[blocks.length - 1]?.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  const last = content[content.length - 1];
  if (!last || last.type !== "link") return null;

  const inner = last.content;
  if (!Array.isArray(inner) || inner.length !== 1) return null;
  const only = inner[0];
  if (!only || only.type !== "text" || typeof only.text !== "string") return null;
  // 帶樣式的顯示文字（`[*a*](url)`）不收：取代成純字串會把樣式吃掉。
  if (only.styles && Object.keys(only.styles).length > 0) return null;

  const href = last.href;
  if (typeof href !== "string" || href === "") return null;

  // 還原比對。組法必須與剖析的切法對稱——不對稱的那一整族（title、角括號網址、
  // 網址前後空白…）一律不觸發，這是刻意的，清單見 spec §9.2。
  const recon = `[${only.text}](${href})`;
  if (!textBefore.endsWith(recon)) return null;

  return { text: only.text, href, matchedLength: recon.length };
}

/** `find` 收到的文字要自己截短的上限。
 *
 * ⚠ 上游的 `getTextContentFromNodes($from, maxMatch = 500)` **不是輸出長度的上界**
 * （`@tiptap/core dist/index.js:2190-2210`）：500 只決定 `nodesBetween` 的起點，每個節點的
 * chunk 只從右邊裁（`chunk.slice(0, sliceEndPos - pos)`），單一 text node 的段落會整段吐出
 * （實測 817 字元段落回 817 字元）。不截的話剖析成本隨段落長度線性成長。 */
export const MAX_LINK_SCAN = 500;

export function createMarkdownLinkExtension({ editorRef }: { editorRef: EditorRef }): Extension {
  return Extension.create({
    name: "knotebookMarkdownLink",
    addInputRules() {
      return [
        new InputRule({
          // 函式型 finder（`InputRuleFinder = RegExp | ((text) => InputRuleMatch | null)`，
          // `dist/index.d.ts:25`）——多候選判斷本來就不是單一 regex 表達得了的事。
          find: (text: string) => {
            if (!text.endsWith(")")) return null; // 最便宜的早退，要擺在最前面
            const editor = editorRef.current;
            if (!editor) return null;
            // **任何建議選單開著時都不觸發**（`shown()` 是跨 trigger 共用的，不只 `[[`）。
            // 與這個 repo 既有的優先序一致：`[[` 偵測掛在 editorProps 層、本來就比
            // plugin 早跑。代價是選單開著打不出連結，按 Esc 關掉即可——已列為已知限制。
            // ⚠ 若改成比對 `triggerCharacter`，這三行註解與 Step 9d-2 的測試名要一併改回 `[[` 專屬。
            // ⚠ 【驗 plan-gate】`shown()` 是**跨 trigger 共用**的（開 `/` 選單時它也是 true）。
            // 要只擋 `[[` 就改成比對 `menu.store.state?.triggerCharacter === "[["`
            // （⚠ `triggerCharacter` **不在 extension 本體上**，repo 內先例：`NoteEditor.test.ts:375`、`:435`）；沒改的話已知限制要寫成
            // 「任何建議選單開著時」而不是「`[[` 選單開著時」（Task 4 Step 3）。
            if (editor.getExtension(SuggestionMenu)?.shown?.()) return null;

            const scanned = text.length > MAX_LINK_SCAN ? text.slice(-MAX_LINK_SCAN) : text;
            const hit = resolveTrailingMarkdownLink(editor, scanned);
            if (!hit) return null;
            // ⚠ 截短會重新製造左界盲點：這個設計之所以免疫 `\[` 與 `![`，是因為剖析器
            // 看得到 `[` 左邊那個字元；比對區間頂到左界時就看不到了。
            if (scanned.length < text.length && hit.matchedLength === scanned.length) return null;

            const index = scanned.length - hit.matchedLength;
            // `run()` 用 `match[0].length - text.length` 算文件範圍 ⇒ `text` 必須是**含尾端
            // `)`** 的還原字串。href 走 `data`。
            //
            // ⚠ **`index` 的基準是截短後的 `scanned`，但 tiptap 自己把 `result.input`
            // 設成未截短的原始 `text`**（`dist/index.js:4046-4047`：`result.input = text`，
            // 不是 `scanned`）——兩個欄位對不上同一個字串的座標系。今天無害，因為
            // `run()` 算文件範圍只用 `match[0].length - text.length`（也就是
            // `text.length`，見上面那句），從頭到尾沒讀過 `match.index` 或
            // `match.input`。**但這兩個值本身互相矛盾**：截短沒發生時（`scanned ===
            // text`）`index` 剛好也是對的；截短發生時，`index` 相對 `scanned`、
            // `input` 卻是完整的 `text`，日後若有人改成用 `match.index`／`match.input`
            // 算位置，這裡就會差一截。
            return { text: scanned.slice(index), index, data: { href: hit.href, label: hit.text } };
          },
          handler: ({ state, range, match, chain }) => {
            const href = (match as { data?: { href?: string } }).data?.href;
            const label = (match as { data?: { label?: string } }).data?.label;
            if (typeof href !== "string" || typeof label !== "string") return null;

            // ⚠ 範圍一律用 `run()` 給的 `range`，**不要拿 matchedLength 自己往左反推**：
            // 偏移量隨入口而異——`handleTextInput` 那條 `)` 還沒進文件（差 1），
            // `compositionend` 那條傳 `text: ""`、`)` 已在文件裡（差 0）。反推必然有一種
            // 入口會錯，而 IME 走的正是後者。
            //
            // 文件端守衛：要被取代的那段範圍裡不得帶任何 mark。`find` 看到的是**展平的
            // 純文字**（`getTextContentFromNodes` 用 `node.textContent`），而 `run()` 的位置
            // 驗證用的是同一份展平文字——「`[` ＋粗體 `a` ＋ `](url)`」兩份都等於
            // `[a](url)`，驗證會通過。不擋的話取代成純字串就把粗體吃掉了。
            // ⚠ 判準是「範圍內不帶 mark」，**不是「是單一 text node」**：後者會因
            // y-prosemirror 同步切出相鄰同 mark 的 node 而讓規則無故失效。
            let hasMark = false;
            state.doc.nodesBetween(range.from, range.to, (node) => {
              if (node.isText && node.marks.length > 0) hasMark = true;
            });
            if (hasMark) return null;

            chain().deleteRange(range).insertContent({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] }).run();
            return undefined;
          },
        }),
      ];
    },
  });
}
