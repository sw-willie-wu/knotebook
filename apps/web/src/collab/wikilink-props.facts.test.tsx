import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { YDOC_FRAGMENT, canonicalizeElements, topLevelContainers } from "@knotebook/shared";
import "@/i18n";
import { noteSchema } from "./schema";

// spec 2026-10-13 site-links §2.1【推】、§4.1【推】、§4.4、§16.2-1：BlockNote／y-prosemirror 的事實，量到的結果即斷言。
// ⚠ 量測案的期望值（MEASURED）是起草時的【推】假說：實跑與假說不同時，照實測改 MEASURED、把差異寫進回報——
// 不得為了湊假說改產品碼。CHANGELOG ③ 依這裡的結果決定寫不寫、怎麼寫（Task 18）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror EditorView 型別在 apps/web 值層級拿不到（memory knotebook-markdown-link-rule）
type AnyView = any;

const TARGET = "22222222-2222-4222-8222-222222222222";

/** 照 `NoteEditor` 的真實掛載：`BlockNoteView` 在 QueryClient＋Router 底下（WikilinkInline 用 useNotes／useNavigate）。 */
function mountInView(editor: AnyEditor) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BlockNoteView editor={editor} editable />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 舊文件：`p1` 段落（帶段落預設屬性）＝「before 」＋wikilink（只有 targetNoteId／snapshotTitle 兩個屬性）＋「 after」；`p2` 段落＝「second」。 */
function legacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  const c1 = new Y.XmlElement("blockContainer");
  c1.setAttribute("id", "p1");
  const p1 = new Y.XmlElement("paragraph");
  // 段落自己的預設屬性先寫齊（編輯器寫過的舊筆記本來就有）：否則 move 時段落補寫預設值也會讓 p1 的正規化變，
  // MEASURED_CANONICAL.move 就分不出是不是 wikilink 補寫造成的。
  p1.setAttribute("backgroundColor", "default");
  p1.setAttribute("textAlignment", "left");
  p1.setAttribute("textColor", "default");
  const before = new Y.XmlText();
  const wl = new Y.XmlElement("wikilink");
  wl.setAttribute("targetNoteId", TARGET);
  wl.setAttribute("snapshotTitle", "Legacy Title");
  const after = new Y.XmlText();
  p1.insert(0, [before, wl, after]);
  c1.insert(0, [p1]);
  const c2 = new Y.XmlElement("blockContainer");
  c2.setAttribute("id", "p2");
  const p2 = new Y.XmlElement("paragraph");
  const t2 = new Y.XmlText();
  p2.insert(0, [t2]);
  c2.insert(0, [p2]);
  group.insert(0, [c1, c2]);
  before.insert(0, "before ");
  after.insert(0, " after");
  t2.insert(0, "second");
  return doc;
}

function wikilinkElements(doc: Y.Doc): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  for (const node of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker((n) => n instanceof Y.XmlElement && n.nodeName === "wikilink")) {
    out.push(node as Y.XmlElement);
  }
  return out;
}

function anyBackfilled(doc: Y.Doc): boolean {
  return wikilinkElements(doc).some((el) => "label" in el.getAttributes() || "anchorBlockId" in el.getAttributes());
}

function collabEditor(doc: Y.Doc): AnyEditor {
  return BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: "u1", name: "U", color: "#123456" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整 schema 三元組（同 markdown-link.rule.test.tsx）
    } as any),
  ) as AnyEditor;
}

/** 游標放到 p1 段落「before 」的 `be|fore` 處（PM 位置以文字搜尋算，不寫死）。 */
function caretInBefore(editor: AnyEditor): void {
  const view: AnyView = editor._tiptapEditor.view;
  let target = -1;
  view.state.doc.descendants((node: AnyView, pos: number) => {
    if (target === -1 && node.isText && String(node.text).startsWith("before")) target = pos + 2;
    return target === -1;
  });
  editor._tiptapEditor.commands.setTextSelection(target);
}

function pressEnter(editor: AnyEditor): void {
  const view: AnyView = editor._tiptapEditor.view;
  view.someProp("handleKeyDown", (f: (v: AnyView, e: KeyboardEvent) => boolean) => f(view, new KeyboardEvent("keydown", { key: "Enter" })));
}

type Op = "open" | "type" | "split" | "move" | "paste";
/** 【推】假說（spec §2.1：`mappedIdentity` 成立的子元素被跳過，只有節點被重建時才補寫）。實測不同就照實改。 */
const MEASURED: Record<Op, boolean> = { open: false, type: false, split: true, move: true, paste: true };
/**
 * 【推】假說：p1 的正規化（＝MCP 段落指紋的輸入）是否因補寫而變。只量 open／move（兩者都不改 p1 的文字）。
 * 與 MEASURED 分開記：`canonicalizeElements` 若略去「等於預設值」的屬性，補寫了也不會變——兩者可能不一致，各自照實測。
 * CHANGELOG ③ 只看這一組（Task 18 Step 7）。
 */
const MEASURED_CANONICAL: Record<"open" | "move", boolean> = { open: false, move: true };

/** p1 container 底下（原件）各 wikilink 的 Y 屬性鍵（排序）。 */
function p1WikilinkAttrKeys(doc: Y.Doc): string[][] {
  const out: string[][] = [];
  for (const c of topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).filter((x) => x.getAttribute("id") === "p1")) {
    for (const node of c.createTreeWalker((n) => n instanceof Y.XmlElement && n.nodeName === "wikilink")) {
      out.push(Object.keys((node as Y.XmlElement).getAttributes()).sort());
    }
  }
  return out;
}

async function measure(op: Op): Promise<{
  backfilled: boolean;
  p1CanonicalChanged: boolean;
  legacyProps: Record<string, unknown> | null;
  p1Text: string;
  p1OriginalAttrKeys: string[][];
}> {
  const doc = legacyDoc();
  const canonicalP1 = () => canonicalizeElements(topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).filter((c) => c.getAttribute("id") === "p1"));
  const before = canonicalP1();
  const editor = collabEditor(doc);
  const view = mountInView(editor);
  try {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    if (op === "type") {
      caretInBefore(editor);
      editor._tiptapEditor.commands.insertContent("x");
    } else if (op === "split") {
      caretInBefore(editor);
      pressEnter(editor);
    } else if (op === "move") {
      editor.setTextCursorPosition("p1");
      editor.moveBlocksDown();
    } else if (op === "paste") {
      editor.setTextCursorPosition("p2", "end");
      editor.pasteHTML(editor.blocksToFullHTML([editor.getBlock("p1")!]));
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // plan gate r1 M6（spec §4.3）：編輯器讀舊 Y.Doc 時，舊 wikilink 的新 props 讀成預設 ""。
    const legacyProps =
      (editor.getBlock("p1")?.content as Array<{ type: string; props?: Record<string, unknown> }> | undefined)?.find((n) => n.type === "wikilink")?.props ?? null;
    const p1Text = ((editor.getBlock("p1")?.content ?? []) as Array<{ type: string; text?: string }>).map((n) => (n.type === "text" ? n.text : "")).join("");
    return { backfilled: anyBackfilled(doc), p1CanonicalChanged: canonicalP1() !== before, legacyProps, p1Text, p1OriginalAttrKeys: p1WikilinkAttrKeys(doc) };
  } finally {
    view.unmount();
    doc.destroy();
  }
}

describe("#269 事實：新 props 在真編輯器（BlockNoteView 掛載）裡的往返", () => {
  afterEach(() => document.body.replaceChildren());

  it("blocks 序列化（blocksToFullHTML＝internal serializer；不是 blocknote/html 剪貼簿那份）→ tryParseHTMLToBlocks 保留 label 與 anchorBlockId", () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [{ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: TARGET, snapshotTitle: "S", label: "L", anchorBlockId: "b1" } }] }],
    }) as AnyEditor;
    const view = mountInView(editor);
    try {
      const html = editor.blocksToFullHTML(editor.document);
      const parsed = editor.tryParseHTMLToBlocks(html);
      const node = (parsed[0]!.content as Array<{ type: string; props: Record<string, string> }>)[0]!;
      expect(node).toMatchObject({ type: "wikilink", props: { targetNoteId: TARGET, label: "L", anchorBlockId: "b1" } });
    } finally {
      view.unmount();
    }
  });

  it("站內複製貼上（spec §4.1）：blocknote/html＝view.serializeForClipboard 的 innerHTML 帶兩個 data-*，經 pasteHTML(html, true)（raw）貼出的 wikilink 帶 label 與 anchorBlockId", () => {
    // BlockNote 0.52.1 copyExtension：`blocknote/html` = `view.serializeForClipboard(selection.content()).dom.innerHTML`；
    // 貼上時 `blocknote/html` 一律走 `editor.pasteHTML(html, true)`（PM 的 raw paste，不重解析成 blocks）。
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [
        { type: "paragraph", content: ["a ", { type: "wikilink", props: { targetNoteId: TARGET, snapshotTitle: "S", label: "L", anchorBlockId: "b1" } }, " b"] },
        { type: "paragraph", content: "second" },
      ],
    }) as AnyEditor;
    const mountedView = mountInView(editor);
    try {
      const view: AnyView = editor._tiptapEditor.view;
      // 選取第一個段落的全部 inline content（位置以節點搜尋算，不寫死）。
      let range: { from: number; to: number } | null = null;
      view.state.doc.descendants((node: AnyView, pos: number) => {
        if (range === null && node.type.name === "paragraph") range = { from: pos + 1, to: pos + 1 + node.content.size };
        return range === null;
      });
      editor._tiptapEditor.commands.setTextSelection(range!);
      const html: string = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
      expect(html).toContain('data-label="L"');
      expect(html).toContain('data-anchor-block-id="b1"');

      editor.setTextCursorPosition(editor.document[1]!.id, "end");
      editor.pasteHTML(html, true);
      const pasted = (editor.document[1]!.content as Array<{ type: string; props?: Record<string, string> }>).find((n) => n.type === "wikilink");
      expect(pasted?.props).toEqual({ targetNoteId: TARGET, snapshotTitle: "S", label: "L", anchorBlockId: "b1" });
    } finally {
      mountedView.unmount();
    }
  });
});

describe("#269 量測（§4.4、CHANGELOG ③）：舊 wikilink 被新分頁補寫預設屬性的條件", () => {
  afterEach(() => document.body.replaceChildren());

  for (const op of ["open", "type", "split", "move", "paste"] as const) {
    it(`${op}：Y 屬性補寫＝${String(MEASURED[op])}（量到的結果即斷言）`, async () => {
      const r = await measure(op);
      // 前置：type 的「不補寫」只有在字真的打進去時才有意義。
      if (op === "type") expect(r.p1Text).toContain("bexfore");
      expect(r.backfilled).toBe(MEASURED[op]);
      // paste 的「補寫＝true」是貼出的副本帶齊屬性；來源 p1 原件不被補寫（複製不碰來源）。
      if (op === "paste") expect(r.p1OriginalAttrKeys).toEqual([["snapshotTitle", "targetNoteId"]]);
      // open／move 不改 p1 的文字：p1 的正規化（＝MCP 段落指紋的輸入）有沒有變，只取決於屬性補寫。
      if (op === "open" || op === "move") expect(r.p1CanonicalChanged).toBe(MEASURED_CANONICAL[op]);
      if (op === "open") expect(r.legacyProps).toMatchObject({ targetNoteId: TARGET, snapshotTitle: "Legacy Title", label: "", anchorBlockId: "" });
    });
  }
});
