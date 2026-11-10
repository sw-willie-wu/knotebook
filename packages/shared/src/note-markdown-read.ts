/**
 * #222：MCP／REST 讀出筆記、站內 AI 送出的 markdown（server 與 web 共用；寫入的色值檢查是 `findDisallowedColor`）。
 *
 * **讀取**（{@link blocksToNoteMarkdown}）：`blocksToMarkdownLossy` ＝ 外部 HTML → markdown，
 * 顏色在 HTML → markdown 那一步全丟。這裡改成：先拿同一份外部 HTML，逐個**頂層節點**判斷——
 * - 有 markdown 表達不了的顏色（整段／清單項／標題／引言的 block 色、表格儲存格色）→ 整個節點輸出成
 *   寫入端認得的 HTML（`data-text-color`／`data-background-color`）；整張清單或整張表格一起。
 * - 只有行內顏色（文字色／文字底色）→ 節點維持 markdown，有色那一段寫成 `<span style="color:NAME">…</span>`
 *   夾在 markdown 裡（#222：讓弱模型讀寫的 HTML 越少越好；見 {@link tokenizeInlineColors}）。
 * - 其餘相鄰節點照舊交給同一支 HTML → markdown。
 * 並排 PR-2（spec 2026-10-21 columns-layout §11.1／§11.2）再加三類：頂層的列（`div[data-kb-columns]`、不帶
 * `data-nesting-level`）輸出成 div 形、每一欄的內容以同一套分類序列化（{@link rowMarkdown}）；有寬度的圖片、
 * 有欄寬的表格（節點本身或後代）整個節點輸出成 HTML，寬度夾回 [32, 4000]（{@link normalizeSizes}）。
 * #386 再加三件（{@link prepareForMarkdown}）：段落內換行寫不回成 `\` 換行的（後一行開頭是空白或標點，或在清單項目／表格儲存格／
 * 標題裡）讀出成行內 `<br>`；粗體等行內樣式開頭、結尾的空白移到樣式外面；文字裡 parser 會當成標記的字元與區塊開頭的標記加反斜線。
 * 整份沒有任何顏色、並排、寬度，而且上面這些都沒有動到任何東西（沒有要跳脫的字元——含站內連結文字（#269 RF1，見
 * {@link escapeNoteLinkText}）——、沒有要改寫的換行、沒有樣式邊緣空白）時直接回 `cleanHTMLToMarkdown(html)`——與 `blocksToMarkdownLossy` 位元組相同。
 * 以「頂層節點」為單位的理由：外部 HTML 已經做完 BlockNote 的攤平（非清單的子 block 被拉到頂層），
 * 用同一份切，攤平行為與純 markdown 路徑一致，讀 → 寫回 → 再讀才會穩定。
 *
 * 函式體用全域 `document`／`Element`（server 由 `EditingRuntime.installGlobals()` 提供、web 是瀏覽器）；import 本檔不碰 DOM。
 */
import { cleanHTMLToMarkdown } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";
import { COLUMNS_OPEN_TAG, columnOpenTag, parseColumnFlex } from "./columns.js";
import { isPaletteColor } from "./note-colors.js";
import { clampSizePx } from "./note-sizes.js";
import { unescapeAttributeAngles } from "./serialized-html.js";
import { escapeLinkText } from "./site-link.js";

const STYLE_CSS = { textColor: "color", backgroundColor: "background-color" } as const;
const BLOCK_COLOR_ATTRS = ["data-text-color", "data-background-color"] as const;
/**
 * 編輯器內部用、寫入端不需要的屬性：留著只是讓模型讀到雜訊（`style` 是 rgb 版的顏色，寫入端會拒）。
 * `data-level`／`data-url`／`data-start` 與標籤（`<h2>`）、`src`、`<ol start>` 重複；拿掉後往返仍一致（單元測試的往返 fixture 守）。
 */
const NOISE_ATTRS = ["class", "classname", "style", "data-editable", "data-nesting-level", "data-inline-content-type", "target", "rel", "data-level", "data-url", "data-start"];
/** 行內元素：有色 span 往上爬到第一個不是這些的祖先為止，爬到的那一層整段輸出成 HTML。 */
const INLINE_TAGS = new Set(["SPAN", "STRONG", "EM", "S", "U", "CODE", "A", "B", "I", "DEL", "MARK", "SUB", "SUP"]);
/** 行內 HTML 佔位符的兩端（Unicode Po 標點：markdown 轉換器把它們當成標點，與最後換上的 `<`／`>` 同類）。 */
const TOKEN_OPEN = "⸀";
const TOKEN_CLOSE = "⸁";

/** 行內顏色 span（外部 HTML 的形：`data-style-type`＋`data-value`）。 */
const colorStyleType = (el: Element): keyof typeof STYLE_CSS | null => {
  if (el.tagName !== "SPAN") return null;
  const t = el.getAttribute("data-style-type");
  return t === "textColor" || t === "backgroundColor" ? t : null;
};
/**
 * 檔案 block 的外部 HTML（無 caption 是 `<a data-url>`、有 caption 是 `<div data-url>`）：它被匯出成
 * 連結，HTML 也還原不回檔案 block，所以它的底色不帶出（與 #222 之前相同）。
 */
const isFileBlock = (el: Element): boolean => el.hasAttribute("data-url") && (el.tagName === "A" || el.tagName === "DIV");
/** 會在編輯器畫面上顯示的顏色：色盤裡、且不是 `default`。#222 之前存進去的非色盤值編輯器本來就不顯示，當成沒有顏色。 */
const shown = (v: string | null): v is string => v !== null && v !== "default" && isPaletteColor(v);
/**
 * 沒有文字也沒有媒體／表格的 block（例如上了底色的空段落）：`<p data-background-color="red"></p>` 寫回時
 * 解析器會把空 `<p>` 丟掉，往返就不一致——所以它的顏色不帶出，讀出與無色相同（#222 審查 I1）。
 * 表格儲存格例外：空的 `<td data-background-color="red"></td>` 解析器會保留（r2 審查 I2 實測），顏色照帶。
 */
const hasContent = (el: Element): boolean => el.matches("td,th") || (el.textContent ?? "").trim() !== "" || el.matches("img,video,audio,table") || el.querySelector("img,video,audio,table") !== null;
const blockColorShown = (el: Element, a: (typeof BLOCK_COLOR_ATTRS)[number]): boolean => !isFileBlock(el) && shown(el.getAttribute(a)) && hasContent(el);

const elementsOf = (root: Element): Element[] => [root, ...Array.from(root.querySelectorAll("*"))];
/** 有 markdown 表達不了的顏色（block／儲存格層級）→ 整個頂層節點輸出成 HTML。 */
const hasBlockColor = (root: Element): boolean => elementsOf(root).some(el => !colorStyleType(el) && BLOCK_COLOR_ATTRS.some(a => blockColorShown(el, a)));
const colorSpans = (root: Element): Element[] => elementsOf(root).filter(el => colorStyleType(el) && shown(el.getAttribute("data-value")));

/** 頂層的列；帶 `data-nesting-level` 的（段落底下縮排的列）不合法，照一般節點攤平（spec §11.2）。 */
const isRow = (el: Element): boolean => el.matches("div[data-kb-columns]") && !el.hasAttribute("data-nesting-level");
/**
 * 有寬度的圖片的寬度（已夾回）；不是或取不到 → null。精確值在 `data-preview-width`——無說明時掛在 `img`、
 * 有說明時掛在父 `figure`；`img` 的 `width` 是截斷過的整數，兩處都沒有才用它。
 */
function imageWidth(el: Element): number | null {
  if (el.tagName !== "IMG" || el.closest("td,th")) return null;
  const fig = el.parentElement?.tagName === "FIGURE" ? el.parentElement : null;
  const src = el.getAttribute("data-preview-width") ?? fig?.getAttribute("data-preview-width") ?? el.getAttribute("width");
  return src === null ? null : clampSizePx(Number(src));
}
/** colwidth 逐段夾回；取不到值的段（空、NaN、≤ 0）寫空字串，保留逗號與段數（合併格的 `120,`、`,`）。 */
const clampColwidth = (v: string): string => v.split(",").map(s => String(clampSizePx(Number(s)) ?? "")).join(",");
/** 有欄寬的表格：第一列至少一格的 colwidth 有一段有效值（合併格沒設寬時 core 也輸出 `colwidth=","`，只有屬性不算）。 */
const isSizedTable = (el: Element): boolean =>
  el.tagName === "TABLE" &&
  Array.from((el as HTMLTableElement).rows[0]?.cells ?? []).some(c => (c.getAttribute("colwidth") ?? "").split(",").some(s => clampSizePx(Number(s)) !== null));
const hasSizes = (root: Element): boolean => elementsOf(root).some(el => imageWidth(el) !== null || isSizedTable(el));

/**
 * 寬度改寫成 §11.1 的形：有寬度的圖片 → `<figure[ data-background-color]><img[ alt] src width>[<figcaption>]</figure>`
 * （底色一律掛在 figure、其餘屬性全剝；alt 空或等於說明時不帶）；所有表格的 colwidth 逐段夾回，有欄寬的表格
 * 第 2 列起不帶 colwidth（其他表格第 2 列起的全空段照留）。
 */
function normalizeSizes(box: Element): void {
  for (const table of Array.from(box.querySelectorAll("table"))) {
    const sized = isSizedTable(table);
    Array.from(table.rows).forEach((tr, i) => {
      for (const cell of Array.from(tr.cells)) {
        const v = cell.getAttribute("colwidth");
        if (v === null) continue;
        if (sized && i > 0) cell.removeAttribute("colwidth");
        else cell.setAttribute("colwidth", clampColwidth(v));
      }
    });
  }
  for (const img of Array.from(box.querySelectorAll("img"))) {
    const w = imageWidth(img);
    if (w === null) continue;
    const fig = img.parentElement?.tagName === "FIGURE" ? img.parentElement : null;
    const cap = fig ? Array.from(fig.children).find(c => c.tagName === "FIGCAPTION") : undefined;
    const figure = document.createElement("figure");
    const bg = [img, fig].map(e => e?.getAttribute("data-background-color") ?? null).find(shown);
    if (bg) figure.setAttribute("data-background-color", bg);
    const out = document.createElement("img");
    const alt = img.getAttribute("alt") ?? "";
    if (alt !== "" && alt !== cap?.textContent) out.setAttribute("alt", alt);
    out.setAttribute("src", img.getAttribute("src") ?? "");
    out.setAttribute("width", String(w));
    figure.append(out);
    if (cap) {
      const fc = document.createElement("figcaption");
      fc.append(...Array.from(cap.childNodes));
      figure.append(fc);
    }
    (fig ?? img).replaceWith(figure);
  }
}

/**
 * 就地改寫 `box` 的後代成寫入端認得的形：顏色 span → `style="color:X"`（字色＋底色合成一個）、block 色留 data-*、
 * 剝雜訊、寬度正規化、拆掉任何深度的 `data-kb-*` 外殼（HTML 輸出不帶並排標記，spec §11.2）。
 */
function rewrite(box: Element): void {
  normalizeSizes(box);
  for (const el of Array.from(box.querySelectorAll("*"))) {
    if (el.matches("div[data-kb-columns],div[data-kb-column]")) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    const st = colorStyleType(el);
    if (st) {
      const v = el.getAttribute("data-value");
      if (!shown(v)) {
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }
      for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
      el.setAttribute("style", `${STYLE_CSS[st]}:${v}`);
      continue;
    }
    for (const a of BLOCK_COLOR_ATTRS) if (el.hasAttribute(a) && !blockColorShown(el, a)) el.removeAttribute(a);
    for (const a of NOISE_ATTRS) el.removeAttribute(a);
    for (const a of ["colspan", "rowspan"]) if (el.getAttribute(a) === "1") el.removeAttribute(a);
    if (el.tagName === "COLGROUP") el.remove();
    // 表格少兩層雜訊：`<tbody>` 與儲存格裡唯一的 `<p>`（解析器兩者都不需要；往返 fixture 守）。
    if (el.tagName === "TBODY") el.replaceWith(...Array.from(el.childNodes));
    if (el.tagName === "P" && (el.parentElement?.tagName === "TD" || el.parentElement?.tagName === "TH") && el.parentElement.childNodes.length === 1) el.replaceWith(...Array.from(el.childNodes));
  }
  // 字色＋底色：外部 HTML 是兩層 span（字色在外），合成一個 `style="color:X;background-color:Y"`。
  for (const outer of Array.from(box.querySelectorAll("span")).filter(e => e.getAttribute("style")?.startsWith("color:"))) {
    const inner = outer.firstChild;
    if (
      outer.childNodes.length === 1 &&
      inner instanceof Element &&
      inner.tagName === "SPAN" &&
      inner.attributes.length === 1 &&
      inner.getAttribute("style")?.startsWith("background-color:")
    ) {
      outer.setAttribute("style", `${outer.getAttribute("style")};${inner.getAttribute("style")}`);
      inner.replaceWith(...Array.from(inner.childNodes));
    }
  }
}

/**
 * 整個節點 → HTML 區塊。markdown 的 HTML 區塊遇到空行就結束：換行（只會出現在 <pre> 內）寫成字元參照。
 * 節點先放進一個盒子再改寫：節點本身可能被換掉（圖片 → figure、`data-kb-*` 外殼被拆掉）。
 */
function toBlockHTML(root: Element): string {
  const box = document.createElement("div");
  box.append(root);
  rewrite(box);
  return unescapeAttributeAngles(box.innerHTML).replace(/\n/g, "&#10;");
}

/**
 * 只有行內顏色的頂層節點：顏色留在 markdown 裡，寫成 `<span style="…">` 包住那一段的 markdown。
 *
 * 外部 HTML 裡顏色 span 在**最內層**（`<strong><span color>b</span></strong>`）；若直接把 span 換成
 * 標籤，markdown 會變成 `**<span …>b</span>**c`——收尾的 `**` 夾在 `>` 與字母之間不成立。所以每一段有色文字
 * 先往上爬到「只包這一段」的最外層行內元素（粗體、連結…），在它**外面**放一對佔位符、把裡面的顏色 span 拆掉，
 * 交給 HTML → markdown 轉換器（它照常處理粗體、連結與跳脫），最後把佔位符換回 `<span style="…">`／`</span>`。
 * 結果是 `<span style="color:red">**b**</span>c`：強調分隔符的兩側永遠是 `>`／`<` 或內文，flanking 規則恆成立。
 * 佔位符用 Unicode 標點（Po），轉換器判斷相鄰字元時把它當標點，與最後換上的 `<`／`>` 同類。
 */
function tokenizeInlineColors(root: Element, tokens: Map<string, string>): void {
  const done = new Set<Element>();
  for (const span of colorSpans(root)) {
    if (done.has(span)) continue;
    let top: Element = span;
    while (top !== root && top.parentElement && top.parentElement !== root && INLINE_TAGS.has(top.parentElement.tagName) && top.parentElement.childNodes.length === 1) top = top.parentElement;
    const inner = elementsOf(top).filter(el => colorStyleType(el));
    const css: string[] = [];
    for (const st of ["textColor", "backgroundColor"] as const) {
      const v = inner.find(el => colorStyleType(el) === st && shown(el.getAttribute("data-value")))?.getAttribute("data-value");
      if (v) css.push(`${STYLE_CSS[st]}:${v}`);
    }
    const open = `${TOKEN_OPEN}${tokens.size}${TOKEN_CLOSE}`;
    tokens.set(open, `<span style="${css.join(";")}">`);
    const close = `${TOKEN_OPEN}${tokens.size}${TOKEN_CLOSE}`;
    tokens.set(close, "</span>");
    top.before(document.createTextNode(open));
    top.after(document.createTextNode(close));
    for (const el of inner) {
      done.add(el);
      el.replaceWith(...Array.from(el.childNodes));
    }
  }
}

/**
 * #269 RF1：要交給 `cleanHTMLToMarkdown` 的節點裡，站內連結（`a[href^="/notes/"]`，`wikilinksToLinks` 的產物與未轉換的
 * `/notes/…` 一般連結）的文字做 markdown 跳脫（shared `escapeLinkText`）——BlockNote 的 HTML → markdown 完全不跳脫文字，
 * `[\[Draft\] …]` 這種連結文字不跳脫就寫不回來。**只在 markdown 分支呼叫**：`toBlockHTML`（上色區塊 → 原始 HTML）
 * 寫回時不做 markdown 反跳脫，跳脫了反而每往返一次多一層反斜線（Task 6 審查 r0 I1）。回傳是否改了任何文字。
 * 必須排在 `tokenizeInlineColors` 之後（有色 span 已拆成佔位符；佔位符字元不在跳脫集合內）。
 */
function escapeNoteLinkText(root: Node): boolean {
  let changed = false;
  const visit = (n: Node, inLink: boolean): void => {
    if (n.nodeType === 3) {
      if (!inLink) return;
      const next = escapeLinkText(n.nodeValue ?? "");
      if (next !== n.nodeValue) {
        n.nodeValue = next;
        changed = true;
      }
      return;
    }
    const here = inLink || (n.nodeType === 1 && (n as Element).tagName === "A" && ((n as Element).getAttribute("href") ?? "").startsWith("/notes/"));
    for (const c of Array.from(n.childNodes)) visit(c, here);
  };
  visit(root, false);
  return changed;
}

/** 行內樣式（粗體、斜體、刪除線）：轉換器把它們寫成強調標記，標記內緊貼的空白寫不回來。 */
const EMPHASIS_TAGS = new Set(["STRONG", "B", "EM", "I", "S", "DEL"]);
/** 往邊緣找文字時可以穿過的元素：行內樣式，與外部 HTML 的顏色 span（`data-style-type`，在樣式最內層）。 */
const passThrough = (n: Node): boolean => n.nodeType === 1 && (EMPHASIS_TAGS.has((n as Element).tagName) || colorStyleType(n as Element) !== null);
/** `el` 開頭（`first`）或結尾的那段文字：沿著第一個（最後一個）子節點往下，只穿過行內樣式元素與顏色 span。 */
function edgeText(el: Element, first: boolean): Text | null {
  let n = first ? el.firstChild : el.lastChild;
  while (n !== null && passThrough(n)) n = first ? n.firstChild : n.lastChild;
  return n !== null && n.nodeType === 3 ? (n as Text) : null;
}
/**
 * 行內樣式開頭（和結尾）的空白移到樣式外面：`<strong> b</strong>` 轉換器寫成 `** b**`，寫回時 parser 不認這種強調、整串變字面
 * （#386 修好前「粗體跨換行」寫入的舊內容就是這個形）。移出去後讀出 ` **b**`，字不變、寫回成立；代價是那格空白不再帶樣式
 * （粗體、斜體的空白看不出差別；刪除線的線不再畫過那格空白；有顏色的粗體，那格空白也一起移出顏色——底色不再蓋過它）。
 * 只動空格與 tab。回傳有沒有改。
 */
function hoistEmphasisWhitespace(root: ParentNode): boolean {
  let changed = false;
  for (const el of Array.from(root.querySelectorAll("strong,b,em,i,s,del"))) {
    for (const first of [true, false]) {
      const t = edgeText(el, first);
      // #398 審查 I1：尾端用 `/[ \t]+$/` 是平方（每個空白位置都往後掃完整段空白再失敗；10 萬個空白接一個字 2.7 秒，讀出在主執行緒）——
      // 兩端都改成數字元（線性）。
      const ws0 = t === null ? 0 : edgeBlankLength(t.data, first);
      if (t === null || ws0 === 0) continue;
      const wsText = first ? t.data.slice(0, ws0) : t.data.slice(t.data.length - ws0);
      t.data = first ? t.data.slice(ws0) : t.data.slice(0, t.data.length - ws0);
      const ws = document.createTextNode(wsText);
      if (first) el.before(ws);
      else el.after(ws);
      changed = true;
    }
  }
  return changed;
}

/** `s` 開頭（`first`）或結尾連續的空格與 tab 有幾個（線性）。 */
function edgeBlankLength(s: string, first: boolean): number {
  const blank = (c: number) => c === 32 || c === 9;
  let n = 0;
  if (first) while (n < s.length && blank(s.charCodeAt(n))) n++;
  else while (n < s.length && blank(s.charCodeAt(s.length - 1 - n))) n++;
  return n;
}

/**
 * 換行的下一個兄弟是不是以空格或 tab 開頭的文字。呼叫前已 {@link hoistEmphasisWhitespace}：粗體等樣式開頭的空白已經是 `<br>` 的兄弟。
 * 下一個是其他元素（行內 code、連結、有色 span）就不是——那一行開頭是 `` ` ``／`[`／`<`，空白在它們裡面，寫回照留。
 * （外部 HTML 把換行放在樣式元素外面——粗體跨換行是 `<strong>a</strong><br><strong> b</strong>`——所以不必往樣式元素裡找。）
 */
function spacedAfter(br: Element): boolean {
  const next = br.nextSibling;
  return next !== null && next.nodeType === 3 && /^[ \t]/.test(next.nodeValue ?? "");
}
/**
 * 換行的下一個兄弟是不是以 ASCII 標點、或「數字＋`.`／`)`」開頭的文字（審查 I-4a）。`\` 換行之後的那一行若以 `- `、`+ `、`1. `、
 * `# `、`> `、`---`、`===`、`|`、`<div>` 之類開頭，parser 會在那裡斷段、開清單、把上一行變標題——所以這種換行寫成行內 `<br>`，
 * 那段文字留在同一行。只看標點開頭是刻意放寬（`(注意)` 也走 `<br>`）：比逐一列出 parser 的區塊規則穩。
 */
function blockishAfter(br: Element): boolean {
  const next = br.nextSibling;
  return next !== null && next.nodeType === 3 && /^(?:[!-/:-@[-`{-~]|\d+[.)])/.test(next.nodeValue ?? "");
}

/**
 * 段落內換行（`<br>`）讀出成 `\` 換行寫不回來的兩種情形，改寫成行內 `<br>`（寫入端認得：`L1<br>L2` 存成同一段的換行）：
 * - #386：換行之後那一行開頭是空白（網頁上 Shift+Enter 後打了空白，或 #386 修好前經 markdown 寫入多出來的那一格——資料庫裡已有、
 *   不做資料修正）。markdown 續行開頭的空白 parser 會剝掉；寫成 `L1<br> L2` 空白就在同一行、寫回照留（寫入端只拿掉 `<br>` 後排版用的
 *   `\n`，見 note-markdown-write.ts `dropNewlineAfterBreaks`）。判準見 {@link spacedAfter}；呼叫前先 {@link hoistEmphasisWhitespace}，
 *   粗體開頭的空白已在粗體外面。
 * - 清單項目、表格儲存格、標題裡的換行：BlockNote 的 markdown parser 不認那裡的 `\` 換行（清單項目會斷成「`a\`」加一個新段落、
 *   表格整列斷掉），一律寫 `<br>`。
 * - 換行之後那一行以標點開頭（{@link blockishAfter}）：`\` 換行後那一行會被當成新區塊的開頭。
 * 外部 HTML 裡 `<br>` 不會落在 `<code>`／`<pre>` 內（行內 code 在換行處拆成兩段、程式碼區塊的換行是 `\n`），不必排除。
 * 做法：`<br>` 先換成佔位符文字，轉完 markdown 再把佔位符換成 `<br>`（HTML → markdown 的轉換器會跳脫文字裡的 `<`，不能直接放）。
 * 回傳改了幾個。
 */
function tokenizeInlineBreaks(root: ParentNode, placeholder: string): number {
  let n = 0;
  for (const br of Array.from(root.querySelectorAll("br"))) {
    const atEdge = br.previousSibling === null || br.nextSibling === null; // 段落開頭／結尾的換行：轉換器把 `\` 形整個丟掉（審查 M-2）
    if (!atEdge && !br.closest("li,td,th,h1,h2,h3,h4,h5,h6") && !spacedAfter(br) && !blockishAfter(br)) continue;
    br.replaceWith(document.createTextNode(placeholder));
    n += 1;
  }
  return n;
}
/**
 * 換行佔位符：整份 HTML（含網址與屬性）與文字裡都沒出現過的字元 c（從私用區 U+E000 往上找），重複四次。轉回 `<br>` 時是對整份
 * markdown 取代，所以 c 必須全篇沒有：佔位符若出現在網址裡、或跟文件裡同一個字元相鄰重疊，就會換錯地方（審查 I1）。c 全篇沒有時，
 * 相鄰兩個佔位符 c×8 也照樣切成兩個。重複四次是讓它與 `<br>` 等寬：表格的欄寬是轉換器照佔位符的字數排的（審查 M-e）。
 * 轉換器原樣保留私用區字元。私用區的字全被用掉（實際上不會發生）回 null：不改寫換行。
 */
function uniquePlaceholder(haystack: string): string | null {
  for (let cp = 0xe000; cp <= 0xf8ff; cp += 1) {
    const c = String.fromCharCode(cp);
    if (!haystack.includes(c)) return c.repeat("<br>".length);
  }
  return null;
}
/** BlockNote 的 markdown parser 認得的反斜線跳脫字元（`\` 後接這些才是跳脫，其餘照字面）。 */
const MD_ESCAPABLE = "\\`*_{}[]()#+-.!~|>";
/**
 * 一段要寫成 markdown 的純文字裡，parser 會當成標記的字元加反斜線（轉換器本身完全不跳脫文字）：`*`、`` ` ``、`[`、`]` 一律；
 * `_` 只在兩側不都是 `\w`（ASCII 英數字或 `_`）時——與 parser 判字中底線的規則相同，所以 `snake_case`、`a__b` 不動；
 * `~` 只在連著另一個 `~` 或在這段文字的頭尾時（只有 `~~` 是刪除線）；
 * `\` 只在後面接著可跳脫的字元或在這段文字結尾時（`C:\Users` 不動）。`<` 不在此列（#379）。
 * 實際筆記的實例：斜體裡的字面 `**` 與反引號原樣讀出，寫回時 parser 把它們配成新的強調與 code，一輪走樣一次。
 */
function escapeMarkdownText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    const prev = i > 0 ? s[i - 1] : undefined;
    const next = i + 1 < s.length ? s[i + 1] : undefined;
    let esc = false;
    if (c === "*" || c === "`" || c === "[" || c === "]") esc = true;
    else if (c === "_") esc = !(prev !== undefined && next !== undefined && /\w/.test(prev) && /\w/.test(next));
    else if (c === "~") esc = prev === undefined || next === undefined || prev === "~" || next === "~";
    else if (c === "\\") esc = next === undefined || MD_ESCAPABLE.includes(next);
    out += esc ? `\\${c}` : c;
  }
  return out;
}
/**
 * 會寫成 markdown 行內文字的 block（外部 HTML 的段落、清單項目、儲存格、標題、引言）。收合清單／收合標題的文字在 `<summary>` 裡的
 * `<li>`／`<p>`／`<h*>` 中，這裡已涵蓋（審查 I-1：之前錯在把 summary 整個排除）。
 */
const MD_TEXT_BLOCKS = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote";
/**
 * `root` 底下要寫成 markdown 的文字節點逐一 {@link escapeMarkdownText}。不動：`<code>`／`<pre>` 裡（轉換器原樣輸出）、站內連結的文字
 * （{@link escapeNoteLinkText} 另外跳脫，不跳兩次）、不在 {@link MD_TEXT_BLOCKS} 裡的文字（圖片說明之類，轉換器不當 markdown 行內文字）。
 */
function escapeTextNodes(root: ParentNode): boolean {
  let changed = false;
  const walker = document.createTreeWalker(root as Node, 0x4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const el = n.parentElement;
    if (el === null || el.closest("pre,code,figure,figcaption") || el.closest('a[href^="/notes/"]') || !el.closest(MD_TEXT_BLOCKS)) continue;
    const t = n as Text;
    const next = escapeMarkdownText(t.data);
    if (next !== t.data) {
      t.data = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * 一行開頭的區塊標記（審查 I-4b）：段落、引言的第一段文字開頭若是 parser 的區塊標記，第一個字前加反斜線，讓它留在原段落。只跳到
 * parser 真的會認的形（規則照 BlockNote markdown parser 的區塊判斷）：`#`～`######` 後接空白或結尾（標題）、`>`（引言，後面接什麼都算）、
 * `-`／`+` 後接空白或結尾（清單）、數字＋`.`／`)` 後接空白或結尾（編號清單）、三個以上 `-`（可夾空白，分隔線）。`*`、`_`、`` ` ``、`~`
 * 已在 {@link escapeMarkdownText} 一律或在頭尾跳脫；`-1`、`#tag`、`1.5` 這類 parser 不認的不跳。`<` 開頭的 HTML 區塊不在此列（#379）。
 * 「後接結尾」是因為下一個節點（例如移出粗體的空白）可能接著是空白。前導空白（含 NBSP）之後的標記也算：轉換器會剝掉開頭空白（審查 I-1）。
 * 清單項目底下的子段落（含收合清單的子 block）也套用——它們是子區塊、parser 照區塊解析；只有項目自己的行內內容不套用（{@link isItemInline}）。
 */
const BLOCK_MARK = /^(?:#{1,6}(?=\s|$)|>|[-+](?=\s|$)|-\s*-\s*-[-\s]*$)/;
/** 編號清單的數字（後接 `.`／`)` 再接空白或結尾）：反斜線插在數字後。 */
const ORDERED_NUM = /^\d+(?=[.)](?:\s|$))/;
/** 清單項目、儲存格自己的行內內容（parser 只當行內文字，開頭不必跳）：儲存格裡、收合項目的 summary 裡、清單項目直屬的第一個段落。 */
const isItemInline = (b: Element): boolean =>
  b.closest("td,th,summary") !== null || (b.parentElement?.tagName === "LI" && b.parentElement.querySelector(":scope > p") === b);
/** 標題結尾的 ` #`（parser 會把標題結尾空白後的 `#` 整串當收尾標記剝掉）。 */
const HEADING_TAIL = /[ \t](#+)[ \t]*$/;
function escapeBlockStarts(root: ParentNode): boolean {
  let changed = false;
  const blocks = [...(root instanceof Element ? [root] : []), ...Array.from(root.querySelectorAll("p,blockquote,h1,h2,h3,h4,h5,h6"))];
  for (const b of blocks) {
    if (/^H[1-6]$/.test(b.tagName)) {
      // 標題的內容 parser 只當行內文字，開頭不必跳；只有結尾的 ` #` 會被剝
      const last = b.lastChild;
      if (last !== null && last.nodeType === 3) {
        const t = last as Text;
        const m = HEADING_TAIL.exec(t.data);
        if (m) {
          const at = m.index + m[0].indexOf("#");
          t.data = `${t.data.slice(0, at)}\\${t.data.slice(at)}`;
          changed = true;
        }
      }
      continue;
    }
    if (!b.matches("p,blockquote") || isItemInline(b)) continue;
    const first = b.firstChild;
    if (first === null || first.nodeType !== 3) continue;
    const t = first as Text;
    // 反斜線插在前導空白之後（轉換器會剝掉段落開頭的空白，剝完標記就在行首；parser 的清單、分隔線、引言規則本來也容許前導空白
    // ——審查 I-1）；編號清單插在數字後、跳脫 `.`／`)`（`\1` 不是跳脫）
    const lead = /^\s*/.exec(t.data)![0].length;
    const rest = t.data.slice(lead);
    const num = ORDERED_NUM.exec(rest);
    if (num === null && !BLOCK_MARK.test(rest)) continue;
    const at = lead + (num?.[0].length ?? 0);
    t.data = `${t.data.slice(0, at)}\\${t.data.slice(at)}`;
    changed = true;
  }
  return changed;
}
/**
 * 要交給 markdown 轉換器的節點：樣式邊緣的空白移出、寫不回 `\` 形的換行換成佔位符（`ctx.breaks` 累計）、文字裡的標記字元跳脫。
 * 順序：先移空白、再判換行（看的是移出後的文字）、最後跳脫（不影響開頭空白）。回傳有沒有改。
 */
function prepareForMarkdown(root: ParentNode, ctx: Ctx): boolean {
  const hoisted = hoistEmphasisWhitespace(root);
  const n = ctx.brToken === null ? 0 : tokenizeInlineBreaks(root, ctx.brToken);
  ctx.breaks += n;
  const escaped = escapeTextNodes(root);
  const starts = escapeBlockStarts(root);
  return hoisted || n > 0 || escaped || starts;
}

type Kind = "row" | "block" | "inline" | "none";
/** 分類依序判定、先中先用：列 → 整個輸出成 HTML（block 色、有寬度的圖片、有欄寬的表格）→ 行內顏色 → 其餘。 */
const kindOf = (n: Node): Kind => {
  if (n.nodeType !== 1) return "none";
  const el = n as Element;
  if (isRow(el)) return "row";
  if (hasBlockColor(el) || hasSizes(el)) return "block";
  return colorSpans(el).length > 0 ? "inline" : "none";
};
/** 全篇共用：行內顏色的佔位符表與「文件文字裡沒有佔位符字元」；換行佔位符與換了幾個。 */
type Ctx = { tokens: Map<string, string>; inlineOk: boolean; brToken: string | null; breaks: number };

/** 一串兄弟節點（頂層或一欄的內容）→ markdown，各段以空行相接、不帶結尾換行。 */
function serializeNodes(nodes: Node[], ctx: Ctx): string {
  const kinds = nodes.map(kindOf);
  const parts: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const box = document.createElement("div");
    box.append(...run);
    parts.push(cleanHTMLToMarkdown(box.innerHTML));
    run = [];
  };
  nodes.forEach((n, i) => {
    if (kinds[i] === "row") {
      flush();
      parts.push(rowMarkdown(n as Element, ctx));
      return;
    }
    if (kinds[i] === "block" || (kinds[i] === "inline" && !ctx.inlineOk)) {
      flush();
      parts.push(toBlockHTML(n as Element));
      return;
    }
    prepareForMarkdown(n as Element, ctx);
    if (kinds[i] === "inline") tokenizeInlineColors(n as Element, ctx.tokens);
    escapeNoteLinkText(n); // 只有 markdown 分支（上面 return 掉的 HTML 分支不跳脫）
    run.push(n);
  });
  flush();
  // #398 審查 I1：不用 `/\n+$/`（沒錨定開頭，code block 裡 10 萬個換行接一個字就 2.9 秒）——從尾端數。
  return parts
    .map(p => {
      let end = p.length;
      while (end > 0 && p.charCodeAt(end - 1) === 10) end--;
      return p.slice(0, end);
    })
    .filter(p => p !== "")
    .join("\n\n");
}

/** spec §11.1 規則 1–7：外層行、每欄「開標籤、空行、欄內容、空行、`</div>`」（空欄沒有內容那兩行）、`</div>`。 */
function rowMarkdown(row: Element, ctx: Ctx): string {
  const lines = [COLUMNS_OPEN_TAG];
  for (const col of Array.from(row.children).filter(c => c.matches("div[data-kb-column]"))) {
    lines.push(columnOpenTag(parseColumnFlex(col.getAttribute("style"))), "");
    const inner = serializeNodes(Array.from(col.childNodes), ctx);
    if (inner !== "") lines.push(inner, "");
    lines.push("</div>");
  }
  lines.push("</div>");
  return lines.join("\n");
}

/** 讀路徑的 markdown 匯出：沒有顏色、並排、寬度，也沒有任何要跳脫的字元、要改寫的換行、樣式邊緣空白時，與 `blocksToMarkdownLossy` 位元組相同（見檔頭）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
type AnyEditor = BlockNoteEditor<any, any, any>;
export function blocksToNoteMarkdown(editor: AnyEditor, blocks: Parameters<AnyEditor["blocksToHTMLLossy"]>[0]): string {
  const html = editor.blocksToHTMLLossy(blocks);
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const text = tpl.content.textContent ?? "";
  // 文件文字裡已經有佔位符字元（極少見）：行內顏色也退回整段 HTML，不冒換錯的險。
  const inlineOk = !text.includes(TOKEN_OPEN) && !text.includes(TOKEN_CLOSE);
  const ctx: Ctx = { tokens: new Map(), inlineOk, brToken: uniquePlaceholder(html + text), breaks: 0 };
  const restoreBreaks = (md: string): string => (ctx.breaks === 0 || ctx.brToken === null ? md : md.split(ctx.brToken).join("<br>"));
  const nodes = Array.from(tpl.content.childNodes);
  if (nodes.every(n => kindOf(n) === "none")) {
    const prepared = prepareForMarkdown(tpl.content, ctx);
    const escaped = escapeNoteLinkText(tpl.content);
    return restoreBreaks(cleanHTMLToMarkdown(prepared || escaped ? tpl.innerHTML : html));
  }
  const md = restoreBreaks(serializeNodes(nodes, ctx) + "\n");
  return ctx.tokens.size === 0 ? md : md.replace(new RegExp(`${TOKEN_OPEN}\\d+${TOKEN_CLOSE}`, "g"), t => ctx.tokens.get(t) ?? t);
}
