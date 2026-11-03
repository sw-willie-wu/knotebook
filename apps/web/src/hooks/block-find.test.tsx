import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { foldedIndexOf } from "@/lib/search-match";
import { ANCHOR_FLASH_ATTR, findTextFromState, scrollToBlock, useBlockAnchor } from "./useBlockAnchor";
import { findMatchBlock, sectionUnits } from "./block-find";

/**
 * #93 PR2：點片段跳到命中的 block。DOM 照 BlockNote 的形（`VersionPreview.tsx` 的實測註解）：
 * `.bn-editor > .bn-block-group > .bn-block-outer[data-id] > .bn-block > .bn-block-content[data-content-type] > .bn-inline-content`，
 * 巢狀子 block 在 `.bn-block > .bn-block-group > .bn-block-outer`；並排列是 `.bn-block-group` 下的 `[data-node-type="columnList"]`。
 */
type B = { id: string; type?: string; level?: number; text?: string; children?: B[]; extra?: string; inner?: string; attrs?: string; toggle?: "open" | "collapsed" };
const H = (id: string, level: number, text: string): B => ({ id, type: "heading", level, text });
const P = (id: string, text: string, children?: B[]): B => ({ id, type: "paragraph", text, ...(children ? { children } : {}) });

function outerHtml(b: B): string {
  const lvl = b.level === undefined ? "" : ` data-level="${b.level}"`;
  const kids = b.children?.length ? `<div class="bn-block-group">${b.children.map(outerHtml).join("")}</div>` : "";
  const inline = b.inner ?? `<p class="bn-inline-content">${b.text ?? ""}</p>`;
  const body = b.toggle ? `<div><div class="bn-toggle-wrapper" data-show-children="${b.toggle === "open" ? "true" : "false"}">${inline}</div></div>` : inline;
  return `<div class="bn-block-outer" data-id="${b.id}"><div class="bn-block"><div class="bn-block-content" data-content-type="${b.type ?? "paragraph"}"${lvl}${b.attrs ?? ""}>${b.extra ?? ""}${body}</div>${kids}</div></div>`;
}
function buildRoot(top: Array<B | { columns: B[][] }>): HTMLElement {
  const root = document.createElement("div");
  const units = top
    .map((u) =>
      "columns" in u
        ? `<div data-node-type="columnList">${u.columns.map((c) => `<div data-node-type="column"><div class="bn-block-group">${c.map(outerHtml).join("")}</div></div>`).join("")}</div>`
        : outerHtml(u),
    )
    .join("");
  root.innerHTML = `<div class="bn-editor"><div class="bn-block-group">${units}</div></div>`;
  document.body.appendChild(root);
  return root;
}

let root: HTMLElement | null = null;
afterEach(() => {
  root?.remove();
  root = null;
});
const idOf = (el: HTMLElement | null) => el?.getAttribute("data-id") ?? null;

describe("foldedIndexOf（標亮與跳轉共用的比對）", () => {
  it("大小寫折疊、全形大寫折成全形小寫、全形≠半形（server 的 lower() 不做 NFKC）、長度會變的字 → -1", () => {
    expect(foldedIndexOf("Hello NEEDLE", "needle")).toBe(6);
    expect(foldedIndexOf("ＡＢＣ", "ａｂｃ")).toBe(0);
    expect(foldedIndexOf("ABC", "ａｂｃ")).toBe(-1);
    expect(foldedIndexOf("İstanbul", "stan")).toBe(-1);
  });
});

describe("sectionUnits（切法與 note-sections.ts 的 sectionize 一致）", () => {
  it("同級或更高級 heading 開新段；較深的子標題不另成段；_top 是第一個 heading 之前", () => {
    root = buildRoot([P("t1", "top a"), H("h1", 1, "One"), P("a", "a"), H("h2", 2, "Sub"), P("b", "b"), H("h3", 1, "Two"), P("c", "c")]);
    expect(sectionUnits(root, "_top")!.map(idOf)).toEqual(["t1"]);
    expect(sectionUnits(root, "h1")!.map(idOf)).toEqual(["h1", "a", "h2", "b"]);
    expect(sectionUnits(root, "h3")!.map(idOf)).toEqual(["h3", "c"]);
    expect(sectionUnits(root, "nope")).toBeNull();
  });

  it("## 開頭之後遇到 # → 新段（level <= 目前段）", () => {
    root = buildRoot([H("h2", 2, "Sub"), P("a", "a"), H("h1", 1, "Top"), P("b", "b")]);
    expect(sectionUnits(root, "h2")!.map(idOf)).toEqual(["h2", "a"]);
    expect(sectionUnits(root, "h1")!.map(idOf)).toEqual(["h1", "b"]);
  });

  it("欄內的 heading 不切段（並排列是一個頂層單位）", () => {
    root = buildRoot([H("h1", 1, "One"), { columns: [[H("hc", 1, "In column")], [P("pc", "x")]] }, P("after", "after")]);
    const units = sectionUnits(root, "h1")!;
    expect(units).toHaveLength(3);
    expect(sectionUnits(root, "hc")).toBeNull();
  });
});

describe("findMatchBlock", () => {
  it("F1 一般段落：範圍內第一個含字的 block；範圍外的命中不算", () => {
    root = buildRoot([P("t1", "needle in top"), H("h1", 1, "One"), P("a", "nothing"), P("b", "has the Needle here"), P("c", "needle again"), H("h2", 1, "Two"), P("d", "needle")]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("b");
    expect(idOf(findMatchBlock(root, "h2", "needle"))).toBe("d");
  });

  it("F2 _top：從開頭到第一個 heading 之前", () => {
    root = buildRoot([P("t1", "x"), P("t2", "a needle"), H("h1", 1, "One"), P("a", "needle")]);
    expect(idOf(findMatchBlock(root, "_top", "needle"))).toBe("t2");
    root.remove();
    root = buildRoot([P("t1", "x"), H("h1", 1, "One"), P("a", "needle")]);
    expect(findMatchBlock(root, "_top", "needle")).toBeNull();
  });

  it("F3 嵌套清單子項：回最內層真正含字的 block，不是外層", () => {
    root = buildRoot([H("h1", 1, "One"), P("outer", "parent item", [P("mid", "child", [P("deep", "grandchild needle")])]), P("z", "tail")]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("deep");
  });

  it("F3b 欄內命中：回欄內那個 block", () => {
    root = buildRoot([H("h1", 1, "One"), { columns: [[P("l", "left")], [P("r", "right needle")]] }]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("r");
  });

  it("F4 找不到 → null（呼叫端退回段落標題）；空字串 → null", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing")]);
    expect(findMatchBlock(root, "h1", "needle")).toBeNull();
    expect(findMatchBlock(root, "h1", "")).toBeNull();
  });

  it("F5 大小寫與全形：與標亮同一套（toLowerCase；全形大寫折成全形小寫；全形≠半形）", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "ａｂｃ lower fullwidth"), P("b", "Mixed CASE here")]);
    expect(idOf(findMatchBlock(root, "h1", "case"))).toBe("b");
    expect(idOf(findMatchBlock(root, "h1", "ＡＢＣ"))).toBe("a");
    expect(findMatchBlock(root, "h1", "abc")).toBeNull();
  });

  it("F6 程式碼區塊的語言選單選項不算文字；標題 block 自己的文字算", () => {
    root = buildRoot([
      H("h1", 1, "Needle title"),
      { id: "code", type: "codeBlock", text: "let x", extra: "<div><select><option>Needle lang</option></select></div>" },
    ]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("h1");
    root.remove();
    root = buildRoot([H("h1", 1, "One"), { id: "code", type: "codeBlock", text: "let x", extra: "<div><select><option>Needle lang</option></select></div>" }]);
    expect(findMatchBlock(root, "h1", "needle")).toBeNull();
  });
});

describe("收合的 toggle（I1）", () => {
  const T = (id: string, text: string, toggle: "open" | "collapsed", children: B[]): B => ({ id, type: "toggleListItem", text, toggle, children });

  it("T1 命中在收合 toggle 的子項（可多層）→ 回最外層收合的 toggle，不是被藏起來的子項", () => {
    root = buildRoot([H("h1", 1, "One"), T("t", "parent", "collapsed", [P("c", "child needle", [P("d", "deep needle")])]), P("z", "tail")]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("t");
  });

  it("T2 展開的 toggle → 照舊回最內層；外層展開、內層收合 → 回內層那顆收合的", () => {
    root = buildRoot([H("h1", 1, "One"), T("t", "parent", "open", [P("c", "child needle")])]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("c");
    root.remove();
    root = buildRoot([H("h1", 1, "One"), T("t", "parent", "open", [T("u", "mid", "collapsed", [P("c", "child needle")])])]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("u");
  });

  it("T3 toggle 自己的文字命中、本身收合 → 回它自己", () => {
    root = buildRoot([H("h1", 1, "One"), T("t", "parent needle", "collapsed", [P("c", "x")])]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("t");
  });
});

describe("表格與 mermaid（I2）", () => {
  it("TB1 表格格子是 <td><p>、沒有 .bn-inline-content：命中回表格那顆 block", () => {
    root = buildRoot([
      H("h1", 1, "One"),
      P("a", "nothing"),
      { id: "tbl", type: "table", inner: "<table><tbody><tr><td><p>cell one</p></td><th><p>Needle head</p></th></tr></tbody></table>" },
    ]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("tbl");
  });

  it("TB2 mermaid 讀 data-code（server 索引收的是 code 屬性）", () => {
    root = buildRoot([H("h1", 1, "One"), { id: "mm", type: "mermaid", inner: "<svg></svg>", attrs: ' data-code="graph TD; A--&gt;Needle"' }]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("mm");
  });
});

describe("重複 id 的段（M4）", () => {
  it("D1 同 id 的 heading 出現第二次 → 只取第一段（server 只收第一段）", () => {
    root = buildRoot([H("dup", 1, "One"), P("a", "first"), H("dup", 1, "One again"), P("b", "second needle")]);
    expect(sectionUnits(root, "dup")!.map(idOf)).toEqual(["dup", "a"]);
    expect(findMatchBlock(root, "dup", "needle")).toBeNull();
  });
});

describe("scrollToBlock + findText", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("G1 有命中 → 捲到並高亮含字的 block，不是 heading", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing"), P("b", "the needle")]);
    const cancel = scrollToBlock(root, "h1", "needle");
    const flash = root.querySelector(`[${ANCHOR_FLASH_ATTR}]`);
    expect(flash?.getAttribute(ANCHOR_FLASH_ATTR)).toBe("b");
    expect(root.querySelector('[data-id="b"]')!.scrollIntoView).toHaveBeenCalled();
    cancel();
  });

  it("G2 範圍內找不到 → 退回段落標題；不帶 findText → 照舊標題", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing")]);
    scrollToBlock(root, "h1", "needle")();
    root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.remove();
    const cancel = scrollToBlock(root, "h1");
    expect(root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR)).toBe("h1");
    cancel();
  });

  it("G3 _top：有命中 → 高亮該 block；沒有 → 捲回頂端、不高亮", () => {
    root = buildRoot([P("t1", "a needle"), H("h1", 1, "One")]);
    const c1 = scrollToBlock(root, "_top", "needle");
    expect(root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR)).toBe("t1");
    c1();
    root.remove();
    root = buildRoot([P("t1", "plain"), H("h1", 1, "One")]);
    root.scrollTo = vi.fn() as unknown as typeof root.scrollTo;
    scrollToBlock(root, "_top", "needle")();
    expect(root.scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)).toBeNull();
  });
});

describe("useBlockAnchor 讀 navigation state（別篇／整頁載入）", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  function Host({ root: r }: { root: HTMLElement }) {
    useBlockAnchor({ noteKey: "n1", ready: true, root: r, currentNoteId: "n1" });
    return null;
  }
  const flashed = () => document.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR) ?? null;

  it("H1 hash＋state.kbFind → 閃的是含字的 block", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "x"), P("b", "needle")]);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/n", hash: "#b-h1", state: { kbFind: "needle" } }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(flashed()).toBe("b");
  });

  it("H2 只有 hash（沒有 state，例如複製出去的連結）→ 閃 heading", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "needle")]);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/n", hash: "#b-h1" }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(flashed()).toBe("h1");
  });

  it("H3 沒有 hash、只有 state（_top 片段）→ 在 _top 範圍找", () => {
    root = buildRoot([P("t1", "a needle"), H("h1", 1, "One")]);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/n", state: { kbFind: "needle" } }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(flashed()).toBe("t1");
  });

  it("findTextFromState 只認非空字串", () => {
    expect(findTextFromState({ kbFind: "x" })).toBe("x");
    expect(findTextFromState({ kbFind: "" })).toBeNull();
    expect(findTextFromState({ kbFind: 3 })).toBeNull();
    expect(findTextFromState(null)).toBeNull();
  });
});
