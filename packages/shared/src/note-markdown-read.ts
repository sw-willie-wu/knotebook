/**
 * #222：MCP／REST 讀出筆記、站內 AI 送出的 markdown（server 與 web 共用；寫入的色值檢查是 `findDisallowedColor`）。
 *
 * **讀取**（{@link blocksToNoteMarkdown}）：`blocksToMarkdownLossy` ＝ 外部 HTML → markdown，
 * 顏色在 HTML → markdown 那一步全丟。這裡改成：先拿同一份外部 HTML，逐個**頂層節點**判斷——
 * - 有 markdown 表達不了的顏色（整段／清單項／標題／引言的 block 色、表格儲存格色）→ 整個節點輸出成
 *   寫入端認得的 HTML（`data-text-color`／`data-background-color`）；整張清單或整張表格一起。
 * - 只有行內顏色（文字色／文字底色）→ 節點維持 markdown，有色那一段寫成 `<span style="color:NAME">…</span>`
 *   夾在 markdown 裡（#222 Willie 要求：讓弱模型讀寫的 HTML 越少越好；見 {@link tokenizeInlineColors}）。
 * - 其餘相鄰節點照舊交給同一支 HTML → markdown。
 * 並排 PR-2（spec 2026-10-21 columns-layout §11.1／§11.2）再加三類：頂層的列（`div[data-kb-columns]`、不帶
 * `data-nesting-level`）輸出成 div 形、每一欄的內容以同一套分類序列化（{@link rowMarkdown}）；有寬度的圖片、
 * 有欄寬的表格（節點本身或後代）整個節點輸出成 HTML，寬度夾回 [32, 4000]（{@link normalizeSizes}）。
 * 整份沒有任何顏色、也沒有需要跳脫的站內連結文字（#269 RF1，見 {@link escapeNoteLinkText}）時直接回
 * `cleanHTMLToMarkdown(html)`——與 `blocksToMarkdownLossy` 位元組相同。
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

type Kind = "row" | "block" | "inline" | "none";
/** 分類依序判定、先中先用：列 → 整個輸出成 HTML（block 色、有寬度的圖片、有欄寬的表格）→ 行內顏色 → 其餘。 */
const kindOf = (n: Node): Kind => {
  if (n.nodeType !== 1) return "none";
  const el = n as Element;
  if (isRow(el)) return "row";
  if (hasBlockColor(el) || hasSizes(el)) return "block";
  return colorSpans(el).length > 0 ? "inline" : "none";
};
/** 全篇共用：行內顏色的佔位符表與「文件文字裡沒有佔位符字元」。 */
type Ctx = { tokens: Map<string, string>; inlineOk: boolean };

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
    if (kinds[i] === "inline") tokenizeInlineColors(n as Element, ctx.tokens);
    escapeNoteLinkText(n); // 只有 markdown 分支（上面 return 掉的 HTML 分支不跳脫）
    run.push(n);
  });
  flush();
  return parts.map(p => p.replace(/\n+$/, "")).filter(p => p !== "").join("\n\n");
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

/** 讀路徑的 markdown 匯出：沒有顏色、並排、寬度、也沒有要跳脫的站內連結文字時，與 `blocksToMarkdownLossy` 位元組相同（見檔頭）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
type AnyEditor = BlockNoteEditor<any, any, any>;
export function blocksToNoteMarkdown(editor: AnyEditor, blocks: Parameters<AnyEditor["blocksToHTMLLossy"]>[0]): string {
  const html = editor.blocksToHTMLLossy(blocks);
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const nodes = Array.from(tpl.content.childNodes);
  if (nodes.every(n => kindOf(n) === "none")) return cleanHTMLToMarkdown(escapeNoteLinkText(tpl.content) ? tpl.innerHTML : html);
  // 文件文字裡已經有佔位符字元（極少見）：行內顏色也退回整段 HTML，不冒換錯的險。
  const inlineOk = !(tpl.content.textContent ?? "").includes(TOKEN_OPEN) && !(tpl.content.textContent ?? "").includes(TOKEN_CLOSE);
  const ctx: Ctx = { tokens: new Map(), inlineOk };
  const md = serializeNodes(nodes, ctx) + "\n";
  return ctx.tokens.size === 0 ? md : md.replace(new RegExp(`${TOKEN_OPEN}\\d+${TOKEN_CLOSE}`, "g"), t => ctx.tokens.get(t) ?? t);
}
