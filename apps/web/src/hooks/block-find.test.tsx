import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { foldedIndexOf } from "@/lib/search-match";
import indexCssRaw from "../index.css?raw";
import { ANCHOR_FLASH_ATTR, ANCHOR_MARK_CLASS, ANCHOR_PENDING_CLASS, ANCHOR_SETTLE_MAX_MS, findTextFromState, scrollToBlock, useBlockAnchor } from "./useBlockAnchor";
import { clearSearchMark } from "./search-mark";
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

describe("捲動位置：搜尋跳轉捲到中間，一般錨點捲到最上面", () => {
  let spy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
  });
  const blocks = () => spy.mock.calls.map((c) => c[0]);

  it("P1 帶 findText 且命中 → center", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "the needle")]);
    scrollToBlock(root, "h1", "needle")();
    expect(blocks()).toEqual([{ block: "center" }]);
  });

  it("P2 帶 findText 但範圍內找不到、退回段落標題 → 也是 center", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing")]);
    scrollToBlock(root, "h1", "needle")();
    expect(blocks()).toEqual([{ block: "center" }]);
  });

  it("P3 _top 有命中 → center；_top 沒命中 → 捲到頂（不呼叫 scrollIntoView）", () => {
    root = buildRoot([P("t1", "a needle"), H("h1", 1, "One")]);
    scrollToBlock(root, "_top", "needle")();
    expect(blocks()).toEqual([{ block: "center" }]);
    root.remove();
    spy.mockClear();
    root = buildRoot([P("t1", "plain"), H("h1", 1, "One")]);
    root.scrollTo = vi.fn() as unknown as typeof root.scrollTo;
    scrollToBlock(root, "_top", "needle")();
    expect(spy).not.toHaveBeenCalled();
    expect(root.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("P4 一般 #b- 錨點（不帶 findText）→ start", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "the needle")]);
    scrollToBlock(root, "h1")();
    expect(blocks()).toEqual([{ block: "start" }]);
  });

  it("P5 浮層蓋在命中的 block 上（不是標題）；置中時捲動對準該 block 自己那一行（.bn-block-content），不是整個 outer", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "the needle")]);
    const cancel = scrollToBlock(root, "h1", "needle");
    expect(root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR)).toBe("b");
    const outer = root.querySelector<HTMLElement>('[data-id="b"]')!;
    expect(spy.mock.contexts[0]).toBe(outer.querySelector(":scope > .bn-block > .bn-block-content"));
    expect(spy.mock.contexts[0]).not.toBe(outer);
    cancel();
  });

  it("P7 父項包著很多子項：置中對準父項自己那一行，不是含全部子項的 outer；子項自己的那一行不會被選到", () => {
    root = buildRoot([H("h1", 1, "One"), P("parent", "the needle", [P("c1", "child 1"), P("c2", "child 2")])]);
    scrollToBlock(root, "h1", "needle")();
    const ctx = spy.mock.contexts[0] as HTMLElement;
    expect(ctx.closest(".bn-block-outer")!.getAttribute("data-id")).toBe("parent");
    expect(ctx.classList.contains("bn-block-content")).toBe(true);
    expect(blocks()).toEqual([{ block: "center" }]);
  });

  it("P8 那一行本身比捲動容器高 → 退回 start（仍對準那一行）；剛好不高於容器 → center", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "the needle")]);
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 500 });
    const line = root.querySelector<HTMLElement>('[data-id="b"] > .bn-block > .bn-block-content')!;
    line.getBoundingClientRect = () => ({ height: 501 }) as DOMRect;
    scrollToBlock(root, "h1", "needle")();
    expect(blocks()).toEqual([{ block: "start" }]);
    expect(spy.mock.contexts[0]).toBe(line);
    spy.mockClear();
    line.getBoundingClientRect = () => ({ height: 500 }) as DOMRect;
    scrollToBlock(root, "h1", "needle")();
    expect(blocks()).toEqual([{ block: "center" }]);
  });

  it("P9 一般錨點（start）對準 outer 本身，不是 content line", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "x")]);
    scrollToBlock(root, "b")();
    expect(spy.mock.contexts[0]).toBe(root.querySelector('[data-id="b"]'));
  });

  function Host({ root: r, onApi }: { root: HTMLElement; onApi?: (api: ReturnType<typeof useBlockAnchor>) => void }) {
    const api = useBlockAnchor({ noteKey: "n1", ready: true, root: r, currentNoteId: "n1" });
    onApi?.(api);
    return null;
  }
  it("M7 requestAnchor(id, findText) 把 findText 傳進 scrollToBlock：閃並捲到命中的 block（center），不是標題；不帶 findText 才是標題（start）", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing"), P("b", "the needle")]);
    let api!: ReturnType<typeof useBlockAnchor>;
    render(
      <MemoryRouter initialEntries={["/n"]}>
        <Host root={root} onApi={(x) => (api = x)} />
      </MemoryRouter>,
    );
    const rootEl = root;
    const flashed = () => rootEl.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR) ?? null;
    act(() => api.requestAnchor("h1", "needle"));
    expect(flashed()).toBe("b");
    expect(blocks()).toEqual([{ block: "center" }]);
    rootEl.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.remove();
    spy.mockClear();
    act(() => api.requestAnchor("h1"));
    expect(flashed()).toBe("h1");
    expect(blocks()).toEqual([{ block: "start" }]);
  });

  it("P6 經 useBlockAnchor：只有 #b- hash（複製出去的段落連結）→ start；hash＋state.kbFind（搜尋跳轉）→ center", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "needle")]);
    const a = render(
      <MemoryRouter initialEntries={[{ pathname: "/n", hash: "#b-h1" }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(blocks()).toEqual([{ block: "start" }]);
    a.unmount();
    spy.mockClear();
    render(
      <MemoryRouter initialEntries={[{ pathname: "/n", hash: "#b-h1", state: { kbFind: "needle" } }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(blocks()).toEqual([{ block: "center" }]);
  });
});

describe("搜尋跳轉的常駐標記", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    clearSearchMark();
    vi.useRealTimers();
  });
  const overlays = () => Array.from(document.querySelectorAll<HTMLElement>(`[${ANCHOR_FLASH_ATTR}]`));
  const esc = (init: KeyboardEventInit = {}, after?: (e: KeyboardEvent) => void) => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
    if (after) window.addEventListener("keydown", after, { once: true });
    window.dispatchEvent(e);
    return e;
  };
  const fresh = () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing"), P("b", "the needle")]);
    return root;
  };

  it("K1 閃兩下之後還在：帶 findText 的跳轉過了 2 s、10 s 浮層仍在，且是 .kn-anchor-mark（常駐）", () => {
    vi.useFakeTimers();
    scrollToBlock(fresh(), "h1", "needle");
    expect(overlays()).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
    expect(overlays()[0]!.getAttribute(ANCHOR_FLASH_ATTR)).toBe("b");
  });

  it("K1b 閃爍等捲動穩定才開始：跳轉當下是 pending（沒有 mark class）；目標位置還在動就一直 pending；連續兩個 frame 不動 → 換成 mark", () => {
    vi.useFakeTimers();
    const r = fresh();
    let top = 500;
    vi.spyOn(r.querySelector<HTMLElement>('[data-id="b"]')!, "getBoundingClientRect").mockImplementation(
      () => ({ top, left: 0, width: 100, height: 20, right: 100, bottom: top + 20, x: 0, y: top, toJSON: () => ({}) }),
    );
    scrollToBlock(r, "h1", "needle");
    const ov = overlays()[0]!;
    expect(ov.classList.contains(ANCHOR_PENDING_CLASS)).toBe(true);
    expect(ov.classList.contains(ANCHOR_MARK_CLASS)).toBe(false);
    for (let i = 0; i < 10; i++) {
      top -= 40; // 捲動中：每個 frame 位置都變
      vi.advanceTimersByTime(16);
    }
    expect(ov.classList.contains(ANCHOR_MARK_CLASS)).toBe(false);
    vi.advanceTimersByTime(100); // 停下來
    expect(ov.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
    expect(ov.classList.contains(ANCHOR_PENDING_CLASS)).toBe(false);
  });

  it("K1c 捲動一直不穩定也不能永遠不閃：ANCHOR_SETTLE_MAX_MS 後強制開始", () => {
    vi.useFakeTimers();
    const r = fresh();
    let top = 0;
    vi.spyOn(r.querySelector<HTMLElement>('[data-id="b"]')!, "getBoundingClientRect").mockImplementation(
      () => ({ top: (top += 7), left: 0, width: 1, height: 1, right: 1, bottom: 1, x: 0, y: 0, toJSON: () => ({}) }),
    );
    scrollToBlock(r, "h1", "needle");
    vi.advanceTimersByTime(ANCHOR_SETTLE_MAX_MS - 50);
    expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(false);
    vi.advanceTimersByTime(100);
    expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
  });

  it("K1d 開始閃之後重新對位只改位置：同一個元素、class 不變、不重建（動畫不會重播）", async () => {
    vi.useFakeTimers();
    const r = fresh();
    scrollToBlock(r, "h1", "needle");
    vi.advanceTimersByTime(200);
    const ov = overlays()[0]!;
    expect(ov.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
    const classBefore = ov.className;
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((recs) => records.push(...recs));
    mo.observe(document.body, { childList: true, subtree: true });
    // 內容變動 → MutationObserver → 下一個 frame 重新對位
    r.querySelector('[data-id="a"] .bn-inline-content')!.textContent = "changed";
    await vi.advanceTimersByTimeAsync(100);
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]).toBe(ov);
    expect(ov.className).toBe(classBefore);
    // 浮層沒有被移除／重新加入（只有 style 變）
    records.push(...mo.takeRecords());
    const touched = records.filter((rec) => rec.type === "childList" && [...rec.addedNodes, ...rec.removedNodes].includes(ov));
    expect(touched).toHaveLength(0);
    mo.disconnect();
  });

  it("K1e prefers-reduced-motion: reduce 下搜尋標記照樣進入閃爍（JS 不看這個設定，CSS 也不關 .kn-anchor-mark 的動畫）", () => {
    vi.useFakeTimers();
    const mm = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
    }));
    vi.stubGlobal("matchMedia", mm);
    try {
      scrollToBlock(fresh(), "h1", "needle");
      vi.advanceTimersByTime(200);
      expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    // 注意：這一段只是字串層的輔助；主守衛是 e2e 44 的 E11b（reduce 那一輪）在真瀏覽器裡取樣底色。
    // CSS：reduced-motion 區塊裡關動畫的規則必須排除 .kn-anchor-mark（不能選到它），且 mark 規則本身有 animation
    const css = indexCssRaw.replace(/\r\n/g, "\n");
    const start = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .kn-anchor-flash");
    expect(start).toBeGreaterThan(-1);
    const rmBlock = css.slice(start, css.indexOf("\n}\n", start) + 3);
    expect(rmBlock).toContain(":not(.kn-anchor-mark)");
    expect(rmBlock).not.toMatch(/\.kn-anchor-flash\.kn-anchor-mark/);
    expect(css).toMatch(/\.kn-anchor-flash\.kn-anchor-mark \{[^}]*animation: kn-anchor-mark/);
  });

  it("K2 一般錨點（不帶 findText）仍是 2 s 後消失，而且沒有常駐 class", () => {
    vi.useFakeTimers();
    scrollToBlock(fresh(), "h1");
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(false);
    vi.advanceTimersByTime(2_100);
    expect(overlays()).toHaveLength(0);
  });

  it("K3 Esc 清掉；別的鍵不清", () => {
    vi.useFakeTimers();
    scrollToBlock(fresh(), "h1", "needle");
    esc({ key: "a" });
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(1);
    esc();
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(0);
  });

  it("K4 別人的 Esc 不被搶：已經 preventDefault（後註冊的監聽才 preventDefault 也算）、輸入法組字中、有對話框開著 → 標記留著", () => {
    vi.useFakeTimers();
    scrollToBlock(fresh(), "h1", "needle");
    esc({}, (e) => e.preventDefault());
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(1);
    esc({ isComposing: true });
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(1);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    esc();
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(1);
    dialog.remove();
    esc();
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(0);
  });

  it("K5 clearSearchMark()（關閉搜尋）清掉；之後再呼叫是空操作", () => {
    scrollToBlock(fresh(), "h1", "needle");
    expect(overlays()).toHaveLength(1);
    clearSearchMark();
    expect(overlays()).toHaveLength(0);
    clearSearchMark();
  });

  it("K6 還在等 block 出現時就關閉搜尋 → block 出現後不會才冒出標記", async () => {
    root = buildRoot([P("t1", "x")]);
    scrollToBlock(root, "nope", "needle");
    clearSearchMark();
    const late = document.createElement("div");
    late.className = "bn-block-outer";
    late.setAttribute("data-id", "nope");
    late.innerHTML = '<div class="bn-block"><div class="bn-block-content"><p class="bn-inline-content">needle</p></div></div>';
    root.appendChild(late);
    await new Promise((r) => setTimeout(r, 30));
    expect(overlays()).toHaveLength(0);
  });

  it("K7 區塊被重繪（元素換掉、同一個 data-id）→ 標記還在並重新對位；區塊被刪掉 → 標記移除、不再找", async () => {
    const r = fresh();
    scrollToBlock(r, "h1", "needle");
    const old = r.querySelector<HTMLElement>('[data-id="b"]')!;
    const next = old.cloneNode(true) as HTMLElement;
    next.getBoundingClientRect = () => ({ top: 123, left: 7, width: 200, height: 30 }) as DOMRect;
    old.replaceWith(next);
    await waitFor(() => expect(overlays()[0]!.style.top).toBe("123px"));
    expect(overlays()).toHaveLength(1);
    next.remove();
    await waitFor(() => expect(overlays()).toHaveLength(0));
  });

  it("K8 找不到命中字、停在 _top：沒有浮層就沒有標記（捲回頂端）", () => {
    root = buildRoot([P("t1", "plain"), H("h1", 1, "One")]);
    root.scrollTo = vi.fn() as unknown as typeof root.scrollTo;
    scrollToBlock(root, "_top", "needle");
    expect(overlays()).toHaveLength(0);
    expect(root.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  function Host({ root: r, noteKey, onApi }: { root: HTMLElement; noteKey: string; onApi?: (api: ReturnType<typeof useBlockAnchor>) => void }) {
    const api = useBlockAnchor({ noteKey, ready: true, root: r, currentNoteId: noteKey });
    onApi?.(api);
    return null;
  }
  const hostUi = (r: HTMLElement, k: string, onApi: (api: ReturnType<typeof useBlockAnchor>) => void) => (
    <MemoryRouter initialEntries={["/n"]}>
      <Host root={r} noteKey={k} onApi={onApi} />
    </MemoryRouter>
  );

  it("K9 再點另一個搜尋結果：舊標記移除、換到新的位置（畫面上只有一個）", () => {
    const r = buildRoot([H("h1", 1, "One"), P("a", "alpha"), H("h2", 1, "Two"), P("b", "beta")]);
    root = r;
    let api!: ReturnType<typeof useBlockAnchor>;
    render(hostUi(r, "n1", (x) => (api = x)));
    act(() => api.requestAnchor("h1", "alpha"));
    expect(overlays().map((o) => o.getAttribute(ANCHOR_FLASH_ATTR))).toEqual(["a"]);
    act(() => api.requestAnchor("h2", "beta"));
    expect(overlays().map((o) => o.getAttribute(ANCHOR_FLASH_ATTR))).toEqual(["b"]);
  });

  it("K10 筆記內的一般錨點（wikilink／#b-）不清掉搜尋標記；它自己 2 s 後消失、標記還在", () => {
    vi.useFakeTimers();
    const r = buildRoot([H("h1", 1, "One"), P("a", "alpha"), H("h2", 1, "Two"), P("b", "beta")]);
    root = r;
    let api!: ReturnType<typeof useBlockAnchor>;
    render(hostUi(r, "n1", (x) => (api = x)));
    act(() => api.requestAnchor("h1", "alpha"));
    act(() => api.requestAnchor("h2"));
    expect(overlays().map((o) => o.getAttribute(ANCHOR_FLASH_ATTR)).sort()).toEqual(["a", "h2"]);
    act(() => void vi.advanceTimersByTime(2_100));
    expect(overlays().map((o) => o.getAttribute(ANCHOR_FLASH_ATTR))).toEqual(["a"]);
  });

  it("K11 離開這篇（noteKey 改變）→ 標記消失，不留在別篇", () => {
    const r = buildRoot([H("h1", 1, "One"), P("a", "alpha")]);
    root = r;
    let api!: ReturnType<typeof useBlockAnchor>;
    const view = render(hostUi(r, "n1", (x) => (api = x)));
    act(() => api.requestAnchor("h1", "alpha"));
    expect(overlays()).toHaveLength(1);
    view.rerender(hostUi(r, "n2", (x) => (api = x)));
    expect(overlays()).toHaveLength(0);
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

describe("搜尋標記的取消：等就緒期間（I1）與 Esc 的例外（I2、M3）", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    clearSearchMark();
    vi.useRealTimers();
    document.querySelectorAll("li[data-swipe-direction], .ProseMirror").forEach((n) => n.remove());
  });
  const ovs = () => Array.from(document.querySelectorAll<HTMLElement>(`[${ANCHOR_FLASH_ATTR}]`));
  function RHost({ root: r, ready, onApi }: { root: HTMLElement; ready: boolean; onApi: (api: ReturnType<typeof useBlockAnchor>) => void }) {
    const api = useBlockAnchor({ noteKey: "n1", ready, root: r, currentNoteId: "n1" });
    onApi(api);
    return null;
  }
  const ui = (r: HTMLElement, ready: boolean, onApi: (api: ReturnType<typeof useBlockAnchor>) => void) => (
    <MemoryRouter initialEntries={["/n"]}>
      <RHost root={r} ready={ready} onApi={onApi} />
    </MemoryRouter>
  );
  const pendingSetup = () => {
    const r = buildRoot([H("h1", 1, "One"), P("a", "the needle")]);
    root = r;
    let api!: ReturnType<typeof useBlockAnchor>;
    const view = render(ui(r, false, (x) => (api = x)));
    act(() => api.requestAnchor("h1", "needle"));
    expect(ovs()).toHaveLength(0);
    return { r, view, setApi: (x: ReturnType<typeof useBlockAnchor>) => (api = x) };
  };

  it("PA 還沒就緒（pending）時關閉搜尋 → 就緒後照樣捲過去，但不留標記", () => {
    const { r, view, setApi } = pendingSetup();
    clearSearchMark();
    view.rerender(ui(r, true, setApi));
    expect(ovs()).toHaveLength(0);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("PB 還沒就緒時按 Esc → 就緒後照樣捲過去，但不留標記", async () => {
    const { r, view, setApi } = pendingSetup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 10));
    view.rerender(ui(r, true, setApi));
    expect(ovs()).toHaveLength(0);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("PD 沒人取消：就緒後照常留標記（對照組）；下一次跳轉不繼承上一次的取消", () => {
    const { r, view, setApi } = pendingSetup();
    clearSearchMark();
    view.rerender(ui(r, true, setApi));
    expect(ovs()).toHaveLength(0);
    let api2!: ReturnType<typeof useBlockAnchor>;
    view.rerender(ui(r, true, (x) => (api2 = x)));
    act(() => api2.requestAnchor("h1", "needle"));
    expect(ovs()).toHaveLength(1);
  });

  /** 模擬 BlockNote 的 OverrideEscape：焦點在編輯器按 Esc → 先 blur()，再讓 ProseMirror preventDefault。 */
  function editor(onKey: (e: KeyboardEvent, pm: HTMLElement) => void): HTMLElement {
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    pm.tabIndex = 0;
    pm.addEventListener("keydown", (e) => onKey(e, pm));
    document.body.appendChild(pm);
    pm.focus();
    return pm;
  }
  const mark = () => {
    vi.useFakeTimers();
    root = buildRoot([H("h1", 1, "One"), P("a", "the needle")]);
    scrollToBlock(root, "h1", "needle");
    vi.advanceTimersByTime(200);
    expect(ovs()).toHaveLength(1);
  };
  const escOn = (el: Element) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

  it("PC 焦點在編輯器按 Esc：BlockNote blur 後 preventDefault → 這一下就清掉標記（不用按兩次）", () => {
    const pm = editor((e, el) => {
      el.blur();
      e.preventDefault();
    });
    mark();
    escOn(pm);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(0);
  });

  it("PC2 slash menu 的 Esc（preventDefault、焦點留在編輯器）→ 標記留著", () => {
    const pm = editor((e) => e.preventDefault());
    mark();
    escOn(pm);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(1);
  });

  it("PC3 AI 框／mermaid 的 Esc（stopPropagation，window 收不到）→ 標記留著", () => {
    const pm = editor((e, el) => {
      el.blur();
      e.preventDefault();
      e.stopPropagation();
    });
    mark();
    escOn(pm);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(1);
  });

  it("PC4 編輯器外別處 preventDefault 的 Esc（焦點在 body）→ 標記留著", () => {
    mark();
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.addEventListener("keydown", (ev) => ev.preventDefault(), { once: true });
    document.body.dispatchEvent(e);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(1);
  });

  it("M3 按下當下有開著的 toast：這一下 Esc 只關 toast（Radix 不 preventDefault），標記留著；toast 關後的下一下才清", () => {
    mark();
    const toast = document.createElement("li");
    toast.setAttribute("data-swipe-direction", "right");
    toast.setAttribute("data-state", "open");
    document.body.appendChild(toast);
    escOn(document.body);
    toast.setAttribute("data-state", "closed"); // 真瀏覽器：到 bubble 時 toast 可能已關
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(1);
    escOn(document.body);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(0);
  });
});
