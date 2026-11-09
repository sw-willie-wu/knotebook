/**
 * `live-watch.ts`（審查 r4 I1）：套用期間活文件被改了哪些頂層 block；合併時只在改到這次寫入在意的 block 時才算衝突。
 * 文件用真的編輯器建（BlockNote 的 blockGroup／blockContainer 結構），「瀏覽器」是另一份文件、改完把 update 套進活文件。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { LiveWatch, containerItems, type MergeGuard } from "../../src/notes/editing/live-watch.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

async function liveDoc(): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, [
      { id: "h1", type: "heading", content: "A" },
      { id: "a1", type: "paragraph", content: "first" },
      { id: "a2", type: "paragraph", content: "second" },
      { id: "h2", type: "heading", content: "B" },
      { id: "b1", type: "paragraph", content: "third" },
    ] as never);
  } finally {
    s.close();
  }
  return doc;
}
/** 「瀏覽器」：同步 live 的一份，跑 `f`（編輯器操作），把 update 套回 live。 */
async function browser(live: Y.Doc, f: (ed: EditorSession["editor"]) => void): Promise<void> {
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(live));
  const sv = Y.encodeStateVector(b);
  const s = await EditorSession.open(rt, b);
  try {
    f(s.editor);
  } finally {
    s.close();
  }
  Y.applyUpdate(live, Y.encodeStateAsUpdate(b, sv));
}
const guardA = (live: Y.Doc): MergeGuard => ({ kind: "blocks", items: containerItems(live.getXmlFragment(YDOC_FRAGMENT), ["h1", "a1", "a2"]), anchors: [] });

describe("LiveWatch", () => {
  it("containerItems：基底裡這些 block 的頂層容器 item id（在別份文件也一樣）", async () => {
    const live = await liveDoc();
    const ids = containerItems(live.getXmlFragment(YDOC_FRAGMENT), ["a1", "b1"]);
    expect(ids).toHaveLength(2);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(live));
    expect(containerItems(copy.getXmlFragment(YDOC_FRAGMENT), ["a1", "b1"])).toEqual(ids);
  });

  it("別段（B）打字、在文件尾端加段落 → 不衝突；none 永不衝突；any 衝突", async () => {
    const live = await liveDoc();
    const w = new LiveWatch(live);
    await browser(live, ed => ed.updateBlock("b1", { content: "third, typed" }));
    await browser(live, ed => ed.insertBlocks([{ type: "paragraph", content: "new at end" }], "b1", "after"));
    expect(w.conflicts(guardA(live))).toBe(false);
    expect(w.conflicts({ kind: "none" })).toBe(false);
    expect(w.conflicts({ kind: "any" })).toBe(true);
    w.stop();
  });

  it("改到目標段的 block（打字、改屬性、刪掉）→ 衝突", async () => {
    for (const f of [
      (ed: EditorSession["editor"]) => ed.updateBlock("a2", { content: "second, typed" }),
      (ed: EditorSession["editor"]) => ed.updateBlock("a1", { props: { textColor: "red" } } as never),
      (ed: EditorSession["editor"]) => ed.removeBlocks(["a1"]),
      (ed: EditorSession["editor"]) => ed.updateBlock("h1", { content: "A renamed" }),
    ]) {
      const live = await liveDoc();
      const guard = guardA(live);
      const w = new LiveWatch(live);
      await browser(live, f);
      expect(w.conflicts(guard)).toBe(true);
      w.stop();
    }
  });

  it("新段落緊接在目標段最後一顆後面（會落進目標段）→ 衝突；插在下一段開頭之後 → 不衝突", async () => {
    const live = await liveDoc();
    const guard = guardA(live);
    const w = new LiveWatch(live);
    await browser(live, ed => ed.insertBlocks([{ type: "paragraph", content: "x" }, { type: "paragraph", content: "y" }], "a2", "after"));
    expect(w.conflicts(guard)).toBe(true);
    w.stop();
    const live2 = await liveDoc();
    const w2 = new LiveWatch(live2);
    await browser(live2, ed => ed.insertBlocks([{ type: "paragraph", content: "x" }], "h2", "after"));
    expect(w2.conflicts(guardA(live2))).toBe(false);
    w2.stop();
  });

  it("錨點（撤回刪段）：被刪 → 衝突；只是被改字 → 不衝突（同舊的錨點重核對）", async () => {
    const live = await liveDoc();
    const anchor: MergeGuard = { kind: "blocks", items: [], anchors: containerItems(live.getXmlFragment(YDOC_FRAGMENT), ["b1"]) };
    const w = new LiveWatch(live);
    await browser(live, ed => ed.updateBlock("b1", { content: "edited" }));
    expect(w.conflicts(anchor)).toBe(false);
    await browser(live, ed => ed.removeBlocks(["b1"]));
    expect(w.conflicts(anchor)).toBe(true);
    w.stop();
  });

  it("stop 之後的改動不記；沒有任何改動 → any 也不衝突", async () => {
    const live = await liveDoc();
    const w = new LiveWatch(live);
    expect(w.conflicts({ kind: "any" })).toBe(false);
    w.stop();
    await browser(live, ed => ed.updateBlock("a1", { content: "late" }));
    expect(w.conflicts({ kind: "any" })).toBe(false);
  });
});

/**
 * 合併後的內容（審查 r5 I3、m6）：真的 editOp（worker 同一支）＋真的 LiveWatch；瀏覽器在 AI 做事期間改活文件，守衛放行就合併，比對最後的
 * markdown 與順序——不只看 conflicts 的回傳值。
 */
describe("守衛放行後合併的內容", () => {
  const H = (t: string) => ({ type: "heading", props: { level: 1 }, content: t });
  const P = (t: string) => ({ type: "paragraph", content: t });
  const base = [H("A"), P("a1 text"), P("a2 text"), H("B"), P("b1 text"), P("b2 text"), H("C"), P("c1 text")];
  async function scenario(user: (ed: EditorSession["editor"]) => void): Promise<{ conflict: boolean; markdown: string }> {
    const doc = new Y.Doc();
    const s = await EditorSession.open(rt, doc);
    try {
      s.editor.replaceBlocks(s.editor.document, base as never);
    } finally {
      s.close();
    }
    const st = Y.encodeStateAsUpdate(doc);
    const live = new Y.Doc();
    Y.applyUpdate(live, st);
    const watch = new LiveWatch(live);
    const o = await rt.runDoc("u", { kind: "outline", state: st });
    if (o === "too_complex") throw new Error("outline");
    const b = o.outline.find(x => x.heading === "B")!;
    const r = await rt.runDoc("u", { kind: "edit", state: new Uint8Array(st), op: "replace_section", sectionId: b.sectionId, ifMatch: b.fingerprint, blocks: [H("B"), P("AI-NEW")] as never });
    if (r === "too_complex" || !r.ok) throw new Error("edit");
    await browser(live, user);
    const conflict = watch.conflicts(r.post.guard);
    watch.stop();
    if (!conflict) Y.applyUpdate(live, r.post.diff);
    const md = await rt.runDoc("u", { kind: "read", state: Y.encodeStateAsUpdate(live), wantShown: false });
    if (md === "too_complex" || typeof md.result === "string" || !("markdown" in md.result)) throw new Error("read");
    return { conflict, markdown: md.result.markdown };
  }

  it("別段（A）打字：合併，A 的修改與 B 的新內容都在、順序不變", async () => {
    const r = await scenario(ed => ed.updateBlock(ed.document[1]!.id, { content: "a1 text EDITED" }));
    expect(r.conflict).toBe(false);
    expect(r.markdown).toBe("# A\n\na1 text EDITED\n\na2 text\n\n# B\n\nAI-NEW\n\n# C\n\nc1 text\n");
  });

  it("在 B 標題正前方（A 段末尾）插一段：合併，那段留在 A、在 # B 之前（審查 r5 I3：不被排到 AI 新內容後面搬進 B）——跑 10 次（每次 client id 不同）", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await scenario(ed => ed.insertBlocks([P("USER-NEW")] as never, ed.document[3]!.id, "before"));
      expect(r.conflict).toBe(false);
      expect(r.markdown, `第 ${i + 1} 次`).toBe("# A\n\na1 text\n\na2 text\n\nUSER-NEW\n\n# B\n\nAI-NEW\n\n# C\n\nc1 text\n");
    }
  }, 60_000);

  it("在 B 最後一顆後面插一段：衝突、不合併（那段會落進 B）——活文件保留使用者的修改、沒有 AI 內容", async () => {
    const r = await scenario(ed => ed.insertBlocks([P("USER-AFTER-b2")] as never, ed.document[5]!.id, "after"));
    expect(r.conflict).toBe(true);
    expect(r.markdown).toBe("# A\n\na1 text\n\na2 text\n\n# B\n\nb1 text\n\nb2 text\n\nUSER-AFTER-b2\n\n# C\n\nc1 text\n");
  });
});
