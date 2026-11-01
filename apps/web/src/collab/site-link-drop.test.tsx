import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import * as Y from "yjs";
import type { SiteLinkCandidate } from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";
import { attachTestElementRenderer } from "@/test/element-renderer";
import { collabUndoManager } from "./undo";
import { runFallbackConversion, type FallbackRequest, type SiteLinkEnv, type SiteLinkEnvRef } from "./site-link-convert";

// #352 spec 2026-10-30-drop-site-links-design §6.1：以 `buildNoteEditorOptions` 掛真編輯器（產品碼原樣），送真 DOM `drop` 事件。
// toast 換成 spy（同 `components/NoteEditor.test.ts`）：媒體阻擋會呼叫它。
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;
type Options = ReturnType<typeof buildNoteEditorOptions>;
type View = AnyEditor["_tiptapEditor"]["view"];
type PmNode = View["state"]["doc"];

const ORIGIN = window.location.origin;
const A_ID = "11111111-1111-4111-8111-111111111111";
const NOTES: SiteLinkCandidate[] = [{ id: A_ID, title: "Alpha", slug: "alpha", groupId: null, ownerHandle: "alice" }];
const URL_A = `${ORIGIN}/n/alice/alpha`;
/** 側欄 `<a>` 的形（文字 `D`：轉成後 `label "D"`）。 */
const A_FORM = { "text/html": `<a href="${URL_A}">D</a>`, "text/plain": URL_A, "text/uri-list": URL_A };
/** 同 A_FORM，但文字＝快取裡的標題：轉成後 `label ""`。 */
const A_ALPHA = { ...A_FORM, "text/html": `<a href="${URL_A}">Alpha</a>` };
/** 媒體阻擋（data URL 圖）：內層回 true、PM 不送 drop tr。 */
const MEDIA = { "text/html": `<img src="data:image/png;base64,AAAA">`, "text/plain": "x" };
const L = (text: string) => ({ type: "link", href: URL_A, content: text });

type Env = SiteLinkEnv & { list: SiteLinkCandidate[]; calls: FallbackRequest[][] };
function mkEnv(list: SiteLinkCandidate[] = NOTES): Env {
  const calls: FallbackRequest[][] = [];
  const env: Env = { origin: ORIGIN, list, notes: () => env.list, schedule: (r) => void calls.push(r), calls };
  return env;
}

const mounted: Array<{ editor: AnyEditor; container: HTMLElement; doc: Y.Doc }> = [];
function mount(env: SiteLinkEnv | null, wrap?: (opts: Options) => void): { editor: AnyEditor; envRef: SiteLinkEnvRef } {
  const doc = new Y.Doc();
  const envRef: SiteLinkEnvRef = { current: env };
  const editorRef: EditorRef = { current: null };
  const opts = buildNoteEditorOptions({
    doc,
    provider: { awareness: null } as never,
    user: { id: "u1", name: "Ann" },
    language: "en",
    translate: (k) => k,
    editorRef,
    noteId: "n",
    siteLinks: envRef,
  });
  wrap?.(opts);
  const editor = BlockNoteEditor.create(opts) as unknown as AnyEditor;
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor);
  mounted.push({ editor, container, doc });
  return { editor, envRef };
}

const view = (editor: AnyEditor): View => editor._tiptapEditor.view;

function dropOn(
  editor: AnyEditor,
  pos: number,
  data: Record<string, string>,
  o: { files?: File[]; coords?: [number, number]; ctrlKey?: boolean; dragging?: View["dragging"] } = {},
): void {
  const v = view(editor);
  v.posAtCoords = () => ({ pos, inside: -1 });
  const files = o.files ?? [];
  const items = files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f }));
  const dataTransfer = {
    types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
    items,
    files,
    getData: (t: string) => data[t] ?? "",
    dropEffect: "none",
    effectAllowed: "all",
  };
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: o.coords?.[0] ?? 0 });
  Object.defineProperty(event, "clientY", { value: o.coords?.[1] ?? 0 });
  Object.defineProperty(event, "ctrlKey", { value: !!o.ctrlKey });
  if (o.dragging) v.dragging = o.dragging;
  v.dom.dispatchEvent(event);
}

/** 每次 drop 之後都要清 microtask 再做下一步（spec §3 前提）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** 第 i 個頂層 blockContainer 之後的位置。文字起點＝區塊起點＋2。 */
function boundaryAfter(editor: AnyEditor, i: number): number {
  const group = view(editor).state.doc.firstChild!;
  let pos = 1;
  for (let k = 0; k <= i; k++) pos += group.child(k).nodeSize;
  return pos;
}

const pm = (editor: AnyEditor): string => view(editor).state.doc.toString();
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const links = (editor: AnyEditor, text: string): number => count(pm(editor), new RegExp(`link\\("${text}"\\)`, "g"));
const wikis = (editor: AnyEditor): number => count(pm(editor), /wikilink/g);
type Inline = { type: string; props?: Record<string, unknown>; href?: string; text?: string };
const inline = (editor: AnyEditor, i: number): Inline[] => editor.document[i]!.content as Inline[];
const wikiProps = (editor: AnyEditor, i: number) => inline(editor, i).filter((n) => n.type === "wikilink").map((n) => n.props);
/** 第一個文字等於 `text` 的 text node 的位置（起點）。 */
function textPos(editor: AnyEditor, text: string): number {
  let at = -1;
  view(editor).state.doc.descendants((n: PmNode, p: number) => {
    if (at === -1 && n.isText && n.text === text) at = p;
    return at === -1;
  });
  return at;
}

const DL1_PROPS = { targetNoteId: A_ID, snapshotTitle: "Alpha", label: "", anchorBlockId: "" };

afterEach(() => {
  toastMock.mockReset();
  vi.restoreAllMocks();
  for (const m of mounted.splice(0)) {
    m.editor.unmount();
    m.container.remove();
    m.doc.destroy();
  }
});

describe("#352 drop hook（spec §6.1）", () => {
  it("DL1：側欄 <a> 形（html＋plain＋uri-list）命中 → 恰一個 wikilink（label 空）、沒有一般連結、不排後備", async () => {
    const env = mkEnv();
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    dropOn(editor, 5, A_ALPHA);
    await flush();
    expect(wikiProps(editor, 0)).toEqual([DL1_PROPS]);
    expect(pm(editor)).not.toContain("link(");
    expect(env.calls).toHaveLength(0);
  });

  it("DL2：再多一個 application/x-knotebook-note 型別 → 結果同 DL1（判準不讀它）", async () => {
    const env = mkEnv();
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    dropOn(editor, 5, { ...A_ALPHA, "application/x-knotebook-note": A_ID });
    await flush();
    expect(wikiProps(editor, 0)).toEqual([DL1_PROPS]);
    expect(pm(editor)).not.toContain("link(");
    expect(env.calls).toHaveLength(0);
  });

  it("DL3：只有 text/plain 網址（B'，paste rule 附加 link mark）命中 → 一個 wikilink、label 空", async () => {
    const env = mkEnv();
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    dropOn(editor, 5, { "text/plain": URL_A });
    await flush();
    expect(wikiProps(editor, 0).map((p) => p?.label)).toEqual([""]);
    expect(wikiProps(editor, 0).map((p) => p?.targetNoteId)).toEqual([A_ID]);
  });

  for (const [name, data] of [
    ["A 形", A_FORM],
    ["B' 形", { "text/plain": URL_A }],
  ] as const) {
    it(`DL4：快取 miss（${name}）→ 維持一般連結；後備恰排一次`, async () => {
      const env = mkEnv([]);
      const { editor } = mount(env);
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
      dropOn(editor, 5, data);
      await flush();
      expect(wikis(editor)).toBe(0);
      expect(pm(editor)).toContain("link(");
      expect(env.calls).toHaveLength(1);
      expect(env.calls[0]![0]!.href).toBe(URL_A);
    });
  }

  for (const href of ["https://example.com/n/alice/alpha", `${ORIGIN}/p/abc`, `${ORIGIN}/n/alice/alpha?present`]) {
    it(`DL5：不是可轉的站內連結（${href.replace(ORIGIN, "<origin>")}）→ 不轉、不排後備`, async () => {
      const env = mkEnv();
      const { editor } = mount(env);
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
      dropOn(editor, 5, { "text/html": `<a href="${href}">D</a>`, "text/plain": href, "text/uri-list": href });
      await flush();
      expect(links(editor, "D")).toBe(1);
      expect(wikis(editor)).toBe(0);
      expect(env.calls).toHaveLength(0);
    });
  }

  /** `[p "src " L("S")]、[p "dst"]`：選取 S、設定 `view.dragging`，放在 dst 段尾。 */
  async function internalDrag(ctrlKey: boolean): Promise<AnyEditor> {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: ["src ", L("S")] },
      { type: "paragraph", content: "dst" },
    ]);
    const v = view(editor);
    const s = textPos(editor, "S");
    const dstEnd = textPos(editor, "dst") + 3;
    editor._tiptapEditor.commands.setTextSelection({ from: s, to: s + 1 });
    dropOn(editor, dstEnd, { "text/html": "<b>ignored</b>", "text/plain": "x" }, { ctrlKey, dragging: { slice: v.state.doc.slice(s, s + 1), move: true } });
    await flush();
    return editor;
  }

  it("DL6：內部搬移（dragging.move）既有一般站內連結 → 仍是一般連結", async () => {
    const editor = await internalDrag(false);
    expect(inline(editor, 1).map((n) => n.type)).toEqual(["text", "link"]);
    expect(inline(editor, 0).some((n) => n.type === "link")).toBe(false);
    expect(links(editor, "S")).toBe(1);
    expect(wikis(editor)).toBe(0);
  });

  it("DL7：內部複製拖（ctrlKey；jsdom 的 navigator.platform 不是 Mac）→ 來源仍在、複本仍是一般連結", async () => {
    const editor = await internalDrag(true);
    expect(inline(editor, 0).map((n) => n.type)).toEqual(["text", "link"]);
    expect(inline(editor, 1).map((n) => n.type)).toEqual(["text", "link"]);
    expect(links(editor, "S")).toBe(2);
    expect(wikis(editor)).toBe(0);
  });

  it("DL8：游標在別段；在 `X-[Alpha](url)end` 的 X 之後放下 `-<a>Alpha</a>` → 新放下的轉、既有的不轉", async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "other" },
      { type: "paragraph", content: ["X-", L("Alpha"), "end"] },
    ]);
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    dropOn(editor, boundaryAfter(editor, 0) + 2 + 1, { "text/html": `-<a href="${URL_A}">Alpha</a>`, "text/plain": "x" });
    await flush();
    expect(inline(editor, 1).map((n) => n.type)).toEqual(["text", "wikilink", "text", "link", "text"]);
  });

  // 範圍端點不得多涵蓋一格：緊貼既有連結 H 的前／後放下。H 用 `/notes/<id>`——快取命中（被涵蓋就會轉），
  // 但 href 與放下的不同，PM 不會把兩者合併成一個連結。
  for (const side of ["前", "後"] as const) {
    it(`DL8b：緊貼既有一般站內連結 H 的${side}方放下 → 只轉新放下的 D，H 不轉`, async () => {
      const { editor } = mount(mkEnv());
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: ["AAA ", { type: "link", href: `/notes/${A_ID}`, content: "H" }, " tail"] }]);
      const h = textPos(editor, "H");
      dropOn(editor, side === "前" ? h : h + 1, { "text/html": `<a href="${URL_A}">D</a>`, "text/plain": "x" });
      await flush();
      expect(links(editor, "H")).toBe(1);
      expect(links(editor, "D")).toBe(0);
      expect(wikis(editor)).toBe(1);
    });
  }

  it("DL9：唯讀時、envRef.current 為 null 時 → 不轉、不拋錯", async () => {
    const a = mount(mkEnv());
    a.editor.replaceBlocks(a.editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    a.editor.isEditable = false;
    expect(() => dropOn(a.editor, 5, A_FORM)).not.toThrow();
    await flush();
    expect(wikis(a.editor)).toBe(0);

    const b = mount(mkEnv());
    b.editor.replaceBlocks(b.editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    b.envRef.current = null;
    expect(() => dropOn(b.editor, 5, A_FORM)).not.toThrow();
    await flush();
    expect(wikis(b.editor)).toBe(0);
  });

  it("DL10（after 段）：轉換時拋錯（env.notes 拋錯）→ console.warn、維持一般連結、沒有 uncaught error", async () => {
    const env = mkEnv();
    env.notes = () => {
      throw new Error("boom");
    };
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dropOn(editor, 5, A_FORM);
    await flush();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toBe("[site-link] drop conversion failed");
    expect(links(editor, "D")).toBe(1);
  });

  it("DL12：在 `AAA [L] BBB` 的 AAA 之後放下兩段 → 既有 L 不轉；放下內容裡的站內連結轉", async () => {
    const a = mount(mkEnv());
    a.editor.replaceBlocks(a.editor.document, [{ type: "paragraph", content: ["AAA ", L("L"), " BBB"] }]);
    dropOn(a.editor, 3 + 3, { "text/html": "<p>new</p><p>two</p>", "text/plain": "x" });
    await flush();
    expect(links(a.editor, "L")).toBe(1);
    expect(wikis(a.editor)).toBe(0);

    const b = mount(mkEnv());
    b.editor.replaceBlocks(b.editor.document, [{ type: "paragraph", content: ["AAA ", L("L"), " BBB"] }]);
    dropOn(b.editor, 3 + 3, { "text/html": `<p>new</p><p>two <a href="${URL_A}">D</a></p>`, "text/plain": "x" });
    await flush();
    expect(links(b.editor, "L")).toBe(1);
    expect(links(b.editor, "D")).toBe(0);
    expect(wikis(b.editor)).toBe(1);
  });

  it("DL13：座標 (1,1)（jsdom 走 SideMenu 的 synthetic drop）→ hook 只跑一次、結果同 DL1", async () => {
    const env = mkEnv();
    let calls = 0;
    const { editor } = mount(env, (opts) => {
      const events = opts._tiptapOptions.editorProps.handleDOMEvents;
      const inner = events.drop;
      events.drop = (v, e) => {
        calls++;
        return inner(v, e);
      };
    });
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    dropOn(editor, 5, A_ALPHA, { coords: [1, 1] });
    await flush();
    expect(calls).toBe(1);
    expect(wikiProps(editor, 0)).toEqual([DL1_PROPS]);
    expect(pm(editor)).not.toContain("link(");
  });

  for (const [name, html] of [
    ["img 開頭", `<img src="https://example.com/x.png"><p>two <a href="${URL_A}">D</a></p>`],
    ["hr 開頭", `<hr><p>two <a href="${URL_A}">D</a></p>`],
  ] as const) {
    it(`DL14：區塊邊界放下${name}的內容；下一段以既有 NEXT 開頭 → NEXT 不轉、D 轉`, async () => {
      const { editor } = mount(mkEnv());
      editor.replaceBlocks(editor.document, [
        { type: "paragraph", content: "AAA" },
        { type: "paragraph", content: [L("NEXT"), " BBB"] },
      ]);
      dropOn(editor, boundaryAfter(editor, 0), { "text/html": html, "text/plain": "x" });
      await flush();
      expect(links(editor, "NEXT")).toBe(1);
      expect(links(editor, "D")).toBe(0);
      expect(wikis(editor)).toBe(1);
    });
  }

  it("DL15：文件結尾（size−1）放下 A 形 → D 轉、既有 H 不轉", async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: [L("H")] },
      { type: "paragraph", content: "" },
    ]);
    dropOn(editor, view(editor).state.doc.content.size - 1, A_FORM);
    await flush();
    expect(links(editor, "D")).toBe(0);
    expect(wikis(editor)).toBe(1);
    expect(links(editor, "H")).toBe(1);
  });

  /** DL16／DL16b 的第二次放下：沒有 drop tr 的三形。 */
  const NO_DROP_TR = {
    媒體阻擋: (editor: AnyEditor) => dropOn(editor, 5, MEDIA),
    Files: (editor: AnyEditor) => dropOn(editor, 5, {}, { files: [new File(["x"], "a.png", { type: "image/png" })] }),
    "只有 uri-list": (editor: AnyEditor) => dropOn(editor, 5, { "text/uri-list": URL_A }),
  } as const;

  for (const [name, second] of Object.entries(NO_DROP_TR)) {
    it(`DL16：miss 放下後再做一次沒有 drop tr 的放下（${name}）→ D、H 維持一般連結，後備次數不變`, async () => {
      const env = mkEnv([]);
      const { editor } = mount(env);
      editor.replaceBlocks(editor.document, [
        { type: "paragraph", content: "xxxxxxxxxxxx" },
        { type: "paragraph", content: ["AAA ", L("H")] },
      ]);
      dropOn(editor, 5, A_FORM);
      await flush();
      expect(links(editor, "D")).toBe(1);
      expect(env.calls).toHaveLength(1);
      second(editor);
      await flush();
      expect(links(editor, "D")).toBe(1);
      expect(links(editor, "H")).toBe(1);
      expect(env.calls).toHaveLength(1);
    });

    it(`DL16b：miss 放下後快取載入，再做一次沒有 drop tr 的放下（${name}）→ 先前的 D 仍是一般連結`, async () => {
      const env = mkEnv([]);
      const { editor } = mount(env);
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
      dropOn(editor, 5, A_FORM);
      await flush();
      expect(env.calls).toHaveLength(1);
      env.list = NOTES;
      second(editor);
      await flush();
      expect(links(editor, "D")).toBe(1);
      expect(wikis(editor)).toBe(0);
    });
  }

  const cells = Array.from({ length: 8 }, (_, i) => `<td>c${i}</td>`).join("");
  const WIDE = `<table><tr><td>a</td></tr><tr>${cells}<td>z <a href="${URL_A}">D</a></td></tr></table>`;
  for (const where of ["段中", "區塊邊界"] as const) {
    it(`DL17：寬表格（fixTables 補格把連結往後推），放在${where} → D 轉、既有 H 與 NEXT 不轉`, async () => {
      const { editor } = mount(mkEnv());
      editor.replaceBlocks(editor.document, [
        { type: "paragraph", content: ["AAA ", L("H")] },
        { type: "paragraph", content: [L("NEXT"), " BBB"] },
      ]);
      dropOn(editor, where === "段中" ? 5 : boundaryAfter(editor, 0), { "text/html": WIDE, "text/plain": "x" });
      await flush();
      expect(links(editor, "D")).toBe(0);
      expect(wikis(editor)).toBe(1);
      expect(links(editor, "H")).toBe(1);
      expect(links(editor, "NEXT")).toBe(1);
    });
  }

  /** 媒體阻擋的放下：hook 啟用（記錄設成 null）、內層回 true、PM 不送 drop tr。之後由測試同步送自己的 tr。 */
  function armWithoutDropTr(editor: AnyEditor): void {
    dropOn(editor, 5, MEDIA);
  }

  it("DLp1：drop tr 的最後一個 StepMap 不止一段（setNodeMarkup）→ 記 null、不轉（spec §3.1）", async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: ["AAA ", L("H")] }]);
    const v = view(editor);
    armWithoutDropTr(editor);
    let paraPos = -1;
    v.state.doc.descendants((n: PmNode, p: number) => {
      if (paraPos === -1 && n.type.name === "paragraph") paraPos = p;
      return paraPos === -1;
    });
    v.dispatch(v.state.tr.setNodeMarkup(paraPos, undefined, v.state.doc.nodeAt(paraPos)!.attrs).setMeta("uiEvent", "drop"));
    await flush();
    expect(links(editor, "H")).toBe(1);
    expect(wikis(editor)).toBe(0);
  });

  it("DLp2：記錄映射後成為空範圍（緊貼 H 插入再刪除）→ 不轉（不把緊鄰的既有連結收進來）", async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: ["AAA ", L("H"), " tail"] }]);
    const v = view(editor);
    const hEnd = textPos(editor, "H") + 1;
    armWithoutDropTr(editor);
    v.dispatch(v.state.tr.insertText("Q", hEnd).setMeta("uiEvent", "drop"));
    v.dispatch(v.state.tr.delete(hEnd, hEnd + 1));
    await flush();
    expect(links(editor, "H")).toBe(1);
    expect(wikis(editor)).toBe(0);
  });
});

/**
 * DL11（spec §4；量法依 knotebook-editor-undo-measurement：共編組態、不用 fake timers、`stopCapturing()` 只放在 drop 之前）。
 * 量到的結果即斷言；後備兩列比照 `site-link-convert.test.tsx` 的 W11，改由 drop 觸發。
 */
const MEASURED_DROP = { undoRemovesWholeDrop: true, fallbackAfterPauseRevertsToLink: true, fallbackImmediateRemovesAll: true } as const;

describe("#352 DL11 撤銷量測（共編）", () => {
  it(`同步命中：undo 一次整個拖放消失＝${String(MEASURED_DROP.undoRemovesWholeDrop)}`, async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "abc" }]);
    const manager = collabUndoManager(editor)!;
    const before = pm(editor);
    manager.stopCapturing();
    dropOn(editor, textPos(editor, "abc") + 3, A_FORM);
    await flush();
    expect(wikis(editor)).toBe(1);
    manager.undo();
    expect(pm(editor) === before).toBe(MEASURED_DROP.undoRemovesWholeDrop);
  });

  async function missThenFallback(pauseBeforeFallback: boolean): Promise<{ editor: AnyEditor; env: Env; before: string; manager: NonNullable<ReturnType<typeof collabUndoManager>> }> {
    const env = mkEnv([]);
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "abc" }]);
    const manager = collabUndoManager(editor)!;
    const before = pm(editor);
    manager.stopCapturing();
    dropOn(editor, textPos(editor, "abc") + 3, A_FORM);
    await flush();
    if (pauseBeforeFallback) manager.stopCapturing();
    await runFallbackConversion(editor, env.calls[0]!, ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    expect(wikis(editor)).toBe(1);
    return { editor, env, before, manager };
  }

  it(`後備在停頓之後落地：undo 一次只退回一般連結＝${String(MEASURED_DROP.fallbackAfterPauseRevertsToLink)}；退回後不再被轉`, async () => {
    const { editor, env, manager } = await missThenFallback(true);
    manager.undo();
    expect(links(editor, "D") === 1 && wikis(editor) === 0).toBe(MEASURED_DROP.fallbackAfterPauseRevertsToLink);
    await flush();
    expect(env.calls).toHaveLength(1);
    expect(wikis(editor)).toBe(0);
  });

  it(`後備緊接著落地（同一窗口）：undo 一次連放下一起撤＝${String(MEASURED_DROP.fallbackImmediateRemovesAll)}`, async () => {
    const { editor, before, manager } = await missThenFallback(false);
    manager.undo();
    expect(pm(editor) === before).toBe(MEASURED_DROP.fallbackImmediateRemovesAll);
  });
});
