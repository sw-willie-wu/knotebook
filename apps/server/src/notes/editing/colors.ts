/**
 * #222：MCP／REST 讀寫筆記的文字色／底色。
 *
 * **寫入**（{@link findDisallowedColor}）：markdown 解析出來的 block 裡，`textColor`／`backgroundColor`
 * 只收編輯器內建的 10 種色名（{@link PALETTE_COLORS}）。其他值（`#hex`、`rgb()`、CSS 合法但不在色盤的
 * 名稱、大小寫不符的 data-*）BlockNote 照樣存進 JSON，但編輯器畫面上不顯示——所以整筆拒絕，不靜默剝除。
 * ⚠ 走訪是**迭代**的（顯式堆疊）：巢狀深度由呼叫端的 markdown 決定，不能遞迴。
 *
 * **讀取**（{@link blocksToMarkdownWithColors}）：`blocksToMarkdownLossy` ＝ 外部 HTML → markdown，
 * 顏色在 HTML → markdown 那一步全丟。這裡改成：先拿同一份外部 HTML，逐個**頂層節點**判斷——
 * - 有 markdown 表達不了的顏色（整段／清單項／標題／引言的 block 色、表格儲存格色）→ 整個節點輸出成
 *   寫入端認得的 HTML（`data-text-color`／`data-background-color`）；整張清單或整張表格一起。
 * - 只有行內顏色（文字色／文字底色）→ 節點維持 markdown，有色那一段寫成 `<span style="color:NAME">…</span>`
 *   夾在 markdown 裡（#222 Willie 要求：讓弱模型讀寫的 HTML 越少越好；見 {@link tokenizeInlineColors}）。
 * - 其餘相鄰節點照舊交給同一支 HTML → markdown。
 * 整份沒有任何顏色時直接回 `cleanHTMLToMarkdown(html)`——與 `blocksToMarkdownLossy` 位元組相同。
 * 以「頂層節點」為單位的理由：外部 HTML 已經做完 BlockNote 的攤平（非清單的子 block 被拉到頂層），
 * 用同一份切，攤平行為與純 markdown 路徑一致，讀 → 寫回 → 再讀才會穩定。
 */
import { cleanHTMLToMarkdown } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";

export const PALETTE_COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
const PALETTE: ReadonlySet<string> = new Set(PALETTE_COLORS);
const COLOR_KEYS = ["textColor", "backgroundColor"] as const;

/** 讀寫兩端共用的判準：值是色盤裡的名稱（`default` 也算）。 */
const isPaletteColor = (v: unknown): v is string => typeof v === "string" && PALETTE.has(v);

function badColorIn(rec: unknown): string | null {
  if (rec === null || typeof rec !== "object") return null;
  for (const k of COLOR_KEYS) {
    const v = (rec as Record<string, unknown>)[k];
    if (v !== undefined && !isPaletteColor(v)) return String(v);
  }
  return null;
}

/**
 * 回傳 blocks 裡任一個不在色盤的色值（找不到回 `null`）。看三處：block 的 `props`、行內 text 的
 * `styles`（含連結內的 text）、表格儲存格的 `props` 與其行內內容。不保證回的是文件順序上的第一個。
 */
export function findDisallowedColor(blocks: readonly unknown[]): string | null {
  const stack: unknown[] = [];
  const pushAll = (xs: readonly unknown[]) => {
    for (const x of xs) stack.push(x); // 不用 push(...xs)：超大陣列展開成參數會爆堆疊
  };
  pushAll(blocks);
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === null || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      pushAll(n); // 舊形表格儲存格：直接是 inline 陣列
      continue;
    }
    const o = n as { props?: unknown; styles?: unknown; content?: unknown; children?: unknown };
    const hit = badColorIn(o.props) ?? badColorIn(o.styles);
    if (hit !== null) return hit;
    if (Array.isArray(o.content)) pushAll(o.content);
    else if (o.content !== null && typeof o.content === "object") {
      const rows = (o.content as { rows?: unknown }).rows;
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const cells = r !== null && typeof r === "object" ? (r as { cells?: unknown }).cells : undefined;
          if (Array.isArray(cells)) pushAll(cells);
        }
      }
    }
    if (Array.isArray(o.children)) pushAll(o.children);
  }
  return null;
}

// ── 讀取 ──────────────────────────────────────────────────────────────────

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

/** 就地改寫成寫入端認得的形：顏色 span → `style="color:X"`（字色＋底色合成一個）、block 色留 data-*、剝雜訊。 */
function rewrite(root: Element): void {
  for (const el of elementsOf(root)) {
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
  for (const outer of [root, ...Array.from(root.querySelectorAll("span"))].filter(e => e.tagName === "SPAN" && e.getAttribute("style")?.startsWith("color:"))) {
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

/** 整個頂層節點 → HTML 區塊。markdown 的 HTML 區塊遇到空行就結束：換行（只會出現在 <pre> 內）寫成字元參照。 */
function toBlockHTML(root: Element): string {
  rewrite(root);
  return root.outerHTML.replace(/\n/g, "&#10;");
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

/** 讀路徑的 markdown 匯出：沒有顏色時與 `blocksToMarkdownLossy` 位元組相同（見檔頭）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
type AnyEditor = BlockNoteEditor<any, any, any>;
export function blocksToMarkdownWithColors(editor: AnyEditor, blocks: Parameters<AnyEditor["blocksToHTMLLossy"]>[0]): string {
  const html = editor.blocksToHTMLLossy(blocks);
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const nodes = Array.from(tpl.content.childNodes);
  const kinds = nodes.map(n => (n.nodeType !== 1 ? "none" : hasBlockColor(n as Element) ? "block" : colorSpans(n as Element).length > 0 ? "inline" : "none"));
  if (kinds.every(k => k === "none")) return cleanHTMLToMarkdown(html);
  // 文件文字裡已經有佔位符字元（極少見）：行內顏色也退回整段 HTML，不冒換錯的險。
  const inlineOk = !(tpl.content.textContent ?? "").includes(TOKEN_OPEN) && !(tpl.content.textContent ?? "").includes(TOKEN_CLOSE);
  const tokens = new Map<string, string>();
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
    if (kinds[i] === "block" || (kinds[i] === "inline" && !inlineOk)) {
      flush();
      parts.push(toBlockHTML(n as Element));
      return;
    }
    if (kinds[i] === "inline") tokenizeInlineColors(n as Element, tokens);
    run.push(n);
  });
  flush();
  const md = parts.map(p => p.replace(/\n+$/, "")).filter(p => p !== "").join("\n\n") + "\n";
  return tokens.size === 0 ? md : md.replace(new RegExp(`${TOKEN_OPEN}\\d+${TOKEN_CLOSE}`, "g"), t => tokens.get(t) ?? t);
}
