import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { Extension } from "@tiptap/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT, type SiteLinkCandidate } from "@knotebook/shared";
import { noteSchema } from "./schema";
import { collabUndoManager } from "./undo";
import { createSiteLinkConvertExtension, runFallbackConversion, type FallbackRequest, type SiteLinkEnv, type SiteLinkEnvRef } from "./site-link-convert";
import { SITE_LINK_CONVERT_META, Y_SYNC_META } from "./site-link-pm";
import { createPmPlugin } from "./pm-plugin";
import { attachTestElementRenderer } from "@/test/element-renderer";
import { P, row, shape } from "@/test/columns-fixtures";

// spec 2026-10-13 site-links §8.4、§6.5、§15.1 W4、§7.6（AddMarkStep 外掛、非同步後備兩列）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試只碰 view 的 state／dispatch／someProp 幾個欄位，沿用 any（同 AnyEditor 的慣例）
type AnyView = any;

const ORIGIN = window.location.origin;
const A_ID = "11111111-1111-4111-8111-111111111111";
const NOTES: SiteLinkCandidate[] = [{ id: A_ID, title: "Alpha", slug: "alpha", groupId: null, ownerHandle: "alice" }];

function env(notes: SiteLinkCandidate[] | undefined = NOTES): SiteLinkEnv & { requests: FallbackRequest[][] } {
  const requests: FallbackRequest[][] = [];
  return { origin: ORIGIN, notes: () => notes, schedule: (r) => void requests.push(r), requests };
}

function mount(e: SiteLinkEnv | null, collab = false, extra: Extension[] = []): { editor: AnyEditor; doc?: Y.Doc; container: HTMLElement } {
  const envRef: SiteLinkEnvRef = { current: e };
  // `extra` 排在前面：tiptap 先反轉再依 priority 排序，陣列越後面的 extension 其 plugin 越前面——本外掛因此先於 `extra` 跑。
  const extensions = [...extra, createSiteLinkConvertExtension({ envRef })];
  let doc: Y.Doc | undefined;
  const editor = (collab
    ? BlockNoteEditor.create(
        withCollaboration({
          schema: noteSchema,
          collaboration: { provider: { awareness: undefined }, fragment: (doc = new Y.Doc()).getXmlFragment(YDOC_FRAGMENT), user: { id: "u", name: "U", color: "#123456" } },
          _tiptapOptions: { extensions },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整 schema 三元組
        } as any),
      )
    : BlockNoteEditor.create({ schema: noteSchema, _tiptapOptions: { extensions } } as never)) as AnyEditor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor); // wikilink 的 toDOM 要它（見 helper 檔頭）
  return { editor, doc, container };
}

function typeChar(view: AnyView, ch: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f: (v: AnyView, a: number, b: number, c: string) => boolean | void) => f(view, from, to, ch));
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
}
const typeString = (view: AnyView, s: string) => [...s].forEach((ch) => typeChar(view, ch));

function inline(editor: AnyEditor): Array<{ type: string; props?: Record<string, string>; href?: string }> {
  return editor.document[0]!.content as Array<{ type: string; props?: Record<string, string>; href?: string }>;
}

describe("#269 W4 AddMarkStep 外掛", () => {
  let editor: AnyEditor;
  let container: HTMLElement;
  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("autolink（打網址＋空白）：同一次 dispatch 內換成 wikilink（文字＝網址 ⇒ label 空）", () => {
    ({ editor, container } = mount(env()));
    const view = editor._tiptapEditor.view;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    typeString(view, `see ${ORIGIN}/n/alice/alpha `);
    const w = inline(editor).find((n) => n.type === "wikilink");
    expect(w?.props).toEqual({ targetNoteId: A_ID, snapshotTitle: `${ORIGIN}/n/alice/alpha`, label: "", anchorBlockId: "" });
    expect(inline(editor).some((n) => n.type === "link")).toBe(false);
  });

  it("createLink（連結對話框的落地點）：換成 wikilink、label 規則（文字≠標題 ⇒ label＝文字）、錨點進 prop", () => {
    ({ editor, container } = mount(env()));
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.createLink(`/n/alice/alpha#b-h1`, "see this");
    expect(inline(editor).find((n) => n.type === "wikilink")?.props).toEqual({ targetNoteId: A_ID, snapshotTitle: "see this", label: "see this", anchorBlockId: "h1" });
  });

  it("選取上貼網址（tiptap Link 的 handlePaste → setMark）：外掛單獨掛著時換成 wikilink、label＝被選的字（產品組態下這條路徑歸貼上 hook）", () => {
    // 本檔的組態只掛外掛、沒有貼上 hook；產品組態（NoteEditor）裡選取上貼網址由貼上 hook 轉換（Task 12），這裡量的是外掛自己的行為。
    ({ editor, container } = mount(env()));
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "go Alpha now" }]);
    const view = editor._tiptapEditor.view;
    let from = -1;
    view.state.doc.descendants((n: AnyView, pos: number) => {
      if (from === -1 && n.isText && String(n.text).includes("Alpha")) from = pos + String(n.text).indexOf("Alpha");
      return from === -1;
    });
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 5 });
    editor.pasteText(`${ORIGIN}/notes/${A_ID}`);
    expect(inline(editor).find((n) => n.type === "wikilink")?.props).toEqual({ targetNoteId: A_ID, snapshotTitle: "Alpha", label: "", anchorBlockId: "" });
  });

  it("SLC-COL1 欄內（並排 PR-1 預留點 7）：第 2 欄段落選取上貼網址 → 換成 wikilink、列仍兩欄", () => {
    ({ editor, container } = mount(env()));
    editor.replaceBlocks(editor.document, [row([[P("left")], [P("go Alpha now", "c2p")]], "r1")]);
    const view = editor._tiptapEditor.view;
    let from = -1;
    view.state.doc.descendants((n: AnyView, pos: number) => {
      if (from === -1 && n.isText && String(n.text).includes("Alpha")) from = pos + String(n.text).indexOf("Alpha");
      return from === -1;
    });
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 5 });
    editor.pasteText(`${ORIGIN}/notes/${A_ID}`);
    const para = editor.getBlock("c2p")!.content as Array<{ type: string; props?: Record<string, string> }>;
    expect(para.find((n) => n.type === "wikilink")?.props).toEqual({ targetNoteId: A_ID, snapshotTitle: "Alpha", label: "", anchorBlockId: "" });
    expect(shape(editor)).toBe("ROW[COL(paragraph:left) | COL(paragraph:go  now)]");
  });

  it("快取 miss／未載入的站內網址：維持一般連結並排後備（每次動作一批）；外站連結不排", () => {
    const e = env([]);
    ({ editor, container } = mount(e));
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.createLink(`/n/bob/secret`, "s");
    editor.createLink("https://example.com/x", "ext");
    expect(inline(editor).filter((n) => n.type === "link").map((n) => n.href)).toEqual(["/n/bob/secret", "https://example.com/x"]);
    return Promise.resolve().then(() => {
      expect(e.requests).toHaveLength(1);
      expect(e.requests[0]!.map((r) => [r.href, r.text])).toEqual([["/n/bob/secret", "s"]]);
    });
  });

  it("帶 y-sync$ meta 或 knotebook:siteLinkConvert meta 的 tr：不轉", () => {
    ({ editor, container } = mount(env()));
    const view = editor._tiptapEditor.view;
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Alpha" }]);
    for (const meta of [Y_SYNC_META, SITE_LINK_CONVERT_META]) {
      let from = -1;
      view.state.doc.descendants((n: AnyView, pos: number) => {
        if (from === -1 && n.isText) from = pos;
        return from === -1;
      });
      const tr = view.state.tr.addMark(from, from + 5, view.state.schema.marks.link.create({ href: "/n/alice/alpha" }));
      tr.setMeta(meta, {});
      view.dispatch(tr);
      expect(inline(editor).some((n) => n.type === "wikilink"), meta).toBe(false);
      view.dispatch(view.state.tr.removeMark(0, view.state.doc.content.size, view.state.schema.marks.link));
    }
  });

  it("別的外掛對遠端更新／轉換本身的 tr 附加 link mark（附加 tr 單獨送到本外掛）：看根 tr，不轉", () => {
    // 測試用外掛：根 tr 帶 `test:linkify` 時附加一筆 addMark。plugin 順序排在本外掛之後（見 mount）⇒ 本外掛第一輪只看到根 tr
    // （沒有 AddMarkStep），下一輪才單獨看到附加的 tr——只看 tr 本身的 meta 會漏掉根上的 y-sync$／siteLinkConvert。
    const linkify = Extension.create({
      name: "testLinkify",
      addProseMirrorPlugins() {
        return [
          createPmPlugin({
            appendTransaction: (trs, _old, state) => {
              const req = trs.find((t) => t.getMeta("test:linkify") !== undefined)?.getMeta("test:linkify") as { from: number } | undefined;
              return req ? state.tr.addMark(req.from, req.from + 5, state.schema.marks.link.create({ href: "/n/alice/alpha" })) : null;
            },
          }) as never,
        ];
      },
    });
    ({ editor, container } = mount(env(), false, [linkify]));
    const view = editor._tiptapEditor.view;
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Alpha" }]);
    for (const meta of [Y_SYNC_META, SITE_LINK_CONVERT_META]) {
      let from = -1;
      view.state.doc.descendants((n: AnyView, pos: number) => {
        if (from === -1 && n.isText) from = pos;
        return from === -1;
      });
      view.dispatch(view.state.tr.setMeta(meta, {}).setMeta("test:linkify", { from }));
      // 前置：測試外掛真的附加了 link mark。
      expect(inline(editor).map((n) => n.type), meta).toEqual(["link"]);
      view.dispatch(view.state.tr.removeMark(0, view.state.doc.content.size, view.state.schema.marks.link));
    }
  });

  it("打字（ReplaceStep）不觸發：既有站內一般連結內打字不會被轉", () => {
    ({ editor, container } = mount(env()));
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/alice/alpha", content: "Alpha" }] }]);
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(false); // replaceBlocks 是 ReplaceStep，不轉
    const view = editor._tiptapEditor.view;
    let pos = -1;
    view.state.doc.descendants((n: AnyView, p: number) => {
      if (pos === -1 && n.isText) pos = p + 2;
      return pos === -1;
    });
    editor._tiptapEditor.commands.setTextSelection(pos);
    typeString(view, "x");
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(false);
  });

  it("連結內刪字、選取覆蓋（from < to 的 ReplaceStep）不觸發：撤銷轉換後留下的站內一般連結不會被編輯轉回", () => {
    ({ editor, container } = mount(env()));
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/alice/alpha", content: "Alpha" }] }]);
    const view = editor._tiptapEditor.view;
    let start = -1;
    view.state.doc.descendants((n: AnyView, p: number) => {
      if (start === -1 && n.isText) start = p;
      return start === -1;
    });
    view.dispatch(view.state.tr.delete(start + 2, start + 3)); // "Alpha" → "Alha"
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([["link", "/n/alice/alpha"]]);
    editor._tiptapEditor.commands.setTextSelection({ from: start + 1, to: start + 3 });
    typeString(view, "y"); // "Alha" 選 "lh" 打 "y" → "Aya"
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([["link", "/n/alice/alpha"]]);
  });

  it("拖放（uiEvent=drop）進來的純文字網址：paste rule 加了 link mark，但不轉、不排後備（§1.3、§17-4）", () => {
    const e = env();
    ({ editor, container } = mount(e));
    const view = editor._tiptapEditor.view;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    const at = view.state.selection.from;
    view.dispatch(view.state.tr.insertText(`${ORIGIN}/n/alice/alpha ${ORIGIN}/n/bob/secret`, at).setMeta("uiEvent", "drop"));
    // tiptap 的 paste rule 對外部 drop 也跑，兩個網址真的都成了 link（命中與未命中各一），而且都沒轉成 wikilink——
    // 一次斷言整列 `[type, href]`：轉錯時紅燈訊息直接看得到 wikilink，不會與「paste rule 沒加 link」混淆。
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([
      ["link", `${ORIGIN}/n/alice/alpha`],
      ["text", undefined],
      ["link", `${ORIGIN}/n/bob/secret`],
    ]);
    return Promise.resolve().then(() => expect(e.requests).toEqual([]));
  });

  it("貼上（uiEvent=paste）歸貼上 hook：外掛單獨掛著時，空選取 pasteText 裸網址——paste rule 加了 link，但外掛不轉、不排後備", () => {
    const e = env();
    ({ editor, container } = mount(e));
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.pasteText(`${ORIGIN}/n/alice/alpha`);
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([["link", `${ORIGIN}/n/alice/alpha`]]);
    return Promise.resolve().then(() => expect(e.requests).toEqual([]));
  });

  it("遠端更新（另一個 Y.Doc 寫進來的 link）：不轉", () => {
    const { editor: e1, doc, container: c1 } = mount(env(), true);
    editor = e1;
    container = c1;
    // 未編輯前 y-prosemirror 還沒把初始空文件寫進 Y.Doc（fragment 是空的）——先本地寫一次，遠端才有段落可以插字。
    editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc!));
    const para = (remote.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    const content = para.get(0) as Y.XmlElement;
    const text = new Y.XmlText();
    content.insert(0, [text]);
    text.insert(0, "Alpha", { link: { href: "/n/alice/alpha" } });
    Y.applyUpdate(doc!, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc!)), "remote");
    expect(inline(editor).some((n) => n.type === "link")).toBe(true);
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(false);
  });

  it("遠端更新寫進「站內網址＋空白」純文字：收端真的 autolink 加了 link（它不跳過 y-sync$），但根 tr 是遠端更新 ⇒ 不轉、不排後備", async () => {
    const e = env();
    const { editor: e1, doc, container: c1 } = mount(e, true);
    editor = e1;
    container = c1;
    editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc!));
    const content = ((remote.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    const text = new Y.XmlText();
    content.insert(0, [text]);
    text.insert(0, `see ${ORIGIN}/n/alice/alpha `); // 不帶 link 屬性：link 只能是收端 autolink 加的
    Y.applyUpdate(doc!, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc!)), "remote");
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([
      ["text", undefined],
      ["link", `${ORIGIN}/n/alice/alpha`],
      ["text", undefined],
    ]);
    await Promise.resolve();
    expect(e.requests).toEqual([]);
  });
});

describe("#269 非同步後備（§6.5、A6）", () => {
  afterEach(() => document.body.replaceChildren());

  it("解析成功 → 一筆 transaction 換掉仍在原區塊、href 與文字都相同的連結；文字被改過的放棄；相異 href 超過 20 只問前 20 個", async () => {
    const { editor } = mount(null);
    const hrefs = Array.from({ length: 22 }, (_, i) => `/n/bob/n${i}`);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: hrefs.map((h, i) => ({ type: "link" as const, href: h, content: `t${i}` })) }]);
    const blockId = editor.document[0]!.id;
    const requests: FallbackRequest[] = hrefs.map((h, i) => ({ blockIds: [blockId], href: h, text: i === 1 ? "changed" : `t${i}`, parsed: { path: { kind: "n", handle: "bob", slug: `n${i}` }, anchorBlockId: "" } }));
    const resolve = vi.fn(async (p: { path: { kind: string; slug?: string } }) => ({ id: `${"0".repeat(8)}-0000-4000-8000-${String(p.path.slug).padStart(12, "0")}`, title: "T" }));
    const dispatchSpy = vi.spyOn(editor._tiptapEditor.view, "dispatch");
    const n = await runFallbackConversion(editor, requests, ORIGIN, resolve as never);
    expect(resolve).toHaveBeenCalledTimes(20);
    expect(n).toBe(19); // n1 的文字對不上（request 說 "changed"）⇒ 放棄；n20、n21 超過上限沒問
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const tr = dispatchSpy.mock.calls[0]![0] as { getMeta(k: string): unknown };
    expect(tr.getMeta(SITE_LINK_CONVERT_META)).toBe(true);
    const types = inline(editor).map((x) => x.type);
    expect(types.filter((t) => t === "wikilink")).toHaveLength(19);
    expect(types.filter((t) => t === "link")).toHaveLength(3);
  });

  it("全部解析不到 → 不 dispatch", async () => {
    const { editor } = mount(null);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/bob/x", content: "x" }] }]);
    const spy = vi.spyOn(editor._tiptapEditor.view, "dispatch");
    const n = await runFallbackConversion(editor, [{ blockIds: [editor.document[0]!.id], href: "/n/bob/x", text: "x", parsed: { path: { kind: "n", handle: "bob", slug: "x" }, anchorBlockId: "" } }], ORIGIN, async () => null);
    expect(n).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("解析成功但原連結已找不到（文字被改）→ 放棄、不 dispatch", async () => {
    const { editor } = mount(null);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/bob/x", content: "x2" }] }]);
    const spy = vi.spyOn(editor._tiptapEditor.view, "dispatch");
    const n = await runFallbackConversion(editor, [{ blockIds: [editor.document[0]!.id], href: "/n/bob/x", text: "x", parsed: { path: { kind: "n", handle: "bob", slug: "x" }, anchorBlockId: "" } }], ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    expect(n).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("等 server 期間編輯器已 unmount（換篇）→ 不套用", async () => {
    const { editor, container } = mount(null);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/bob/x", content: "x" }] }]);
    const blockId = editor.document[0]!.id;
    editor.unmount();
    container.remove();
    const n = await runFallbackConversion(editor, [{ blockIds: [blockId], href: "/n/bob/x", text: "x", parsed: { path: { kind: "n", handle: "bob", slug: "x" }, anchorBlockId: "" } }], ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    expect(n).toBe(0);
    expect(inline(editor).map((x) => x.type)).toEqual(["link"]);
  });
});

/**
 * W11（§7.6 兩列，量到的結果即斷言；共編組態、不用 fake timers）：
 * - AddMarkStep 外掛：轉換與建連結在**同一筆 dispatch**（appendTransaction）⇒ 預期同一撤銷格：第一下 undo 整個連結消失。
 * - 非同步後備：(a) 後備在停頓之後才落地（stopCapturing 隔開）⇒ 第一下 undo 只把 wikilink 退回一般連結，且退回後不再被自動轉換；
 *   (b) 後備緊接著落地（同一個 500ms 窗口）⇒ 第一下 undo 連建連結一起撤。MEASURED 是【推】假說，實測不同就照實改並回報。
 */
const MEASURED = { addMarkSameCell: true, fallbackAfterPauseRevertsToLink: true, fallbackImmediateRemovesAll: true } as const;

describe("#269 W11 撤銷量測（外掛、後備）", () => {
  afterEach(() => document.body.replaceChildren());

  it(`AddMarkStep 外掛：第一下 undo 整個連結（含轉換）消失＝${String(MEASURED.addMarkSameCell)}`, () => {
    const { editor } = mount(env(), true);
    const manager = collabUndoManager(editor)!;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    manager.stopCapturing();
    editor.createLink("/n/alice/alpha", "x");
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(true);
    manager.undo();
    expect((editor.document[0]!.content as unknown[]).length === 0).toBe(MEASURED.addMarkSameCell);
  });

  it(`後備在停頓之後落地：第一下 undo 只退回一般連結＝${String(MEASURED.fallbackAfterPauseRevertsToLink)}；退回後不再被自動轉換`, async () => {
    const e = env([]);
    const { editor } = mount(e, true);
    const manager = collabUndoManager(editor)!;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    manager.stopCapturing();
    editor.createLink("/n/bob/secret", "s");
    await Promise.resolve();
    manager.stopCapturing();
    await runFallbackConversion(editor, e.requests[0]!, ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(true);
    manager.undo();
    const afterUndo = inline(editor).map((n) => n.type);
    expect(afterUndo.includes("link") && !afterUndo.includes("wikilink")).toBe(MEASURED.fallbackAfterPauseRevertsToLink);
    await Promise.resolve();
    expect(e.requests).toHaveLength(1); // 撤銷（y-sync$）不會再排後備
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(false);
  });

  it(`後備緊接著落地（同一窗口）：第一下 undo 連建連結一起撤＝${String(MEASURED.fallbackImmediateRemovesAll)}`, async () => {
    const e = env([]);
    const { editor } = mount(e, true);
    const manager = collabUndoManager(editor)!;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    manager.stopCapturing();
    editor.createLink("/n/bob/secret", "s");
    await Promise.resolve();
    await runFallbackConversion(editor, e.requests[0]!, ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    manager.undo();
    expect((editor.document[0]!.content as unknown[]).length === 0).toBe(MEASURED.fallbackImmediateRemovesAll);
  });
});
