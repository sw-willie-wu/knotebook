import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { collabUndoManager } from "@/collab/undo";
import { noteSchema } from "@/collab/schema";
import { isTourTransactionFilterOn } from "@/collab/tour-filter-flag";
import { createTourTransactionFilterExtension } from "@/collab/tour-transaction-filter";
import { getTourNoteEditor, registerEditor, type TourEditor } from "@/lib/tour-bridge";
import { TourEngine, type TourStopEntry } from "./engine";
import {
  canRunLiveStop,
  installLiveStopInput,
  isTriggerMenuShown,
  startTourTrigger,
  startLiveTrigger,
  stopTourTrigger,
  stopLiveTrigger,
  liveTriggerTarget,
} from "./live-stops";
import { isNarrowViewport, prepareStop, STOPS, stopTarget, type StopContext } from "./stops";

const NOTE_ID = "11111111-1111-1111-1111-111111111111";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** 帶 Y.Doc 共編的真編輯器（掛上交易過濾外掛並 mount），登記成示範筆記的編輯器。 */
async function setup(
  blocks: unknown[] = [{ type: "paragraph", content: "intro" }, { type: "paragraph" }],
): Promise<{ doc: Y.Doc; editor: TourEditor }> {
  const doc = new Y.Doc();
  cleanups.push(() => doc.destroy());
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      _tiptapOptions: { extensions: [createTourTransactionFilterExtension()] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  ) as any as TourEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  cleanups.push(() => {
    editor.unmount();
    el.remove();
  });
  await tick();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試用的 block 輸入
  editor.replaceBlocks(editor.document, blocks as any);
  cleanups.push(registerEditor(NOTE_ID, editor));
  return { doc, editor };
}

/** 文件的快照：block 結構＋Y 的完整狀態＋撤銷堆疊深度。 */
function snapshot(doc: Y.Doc, editor: TourEditor) {
  return {
    blocks: JSON.stringify(editor.document),
    update: Array.from(Y.encodeStateAsUpdate(doc)),
    undo: collabUndoManager(editor)?.undoStack.length ?? 0,
  };
}

const menuOf = (editor: TourEditor) => editor.getExtension(SuggestionMenu)!;

describe("canRunLiveStop", () => {
  it("編輯器已登記、可編輯、最後一段是空段落 → 成立", async () => {
    await setup();
    expect(canRunLiveStop(NOTE_ID)).toBe(true);
  });

  it("沒有登記的編輯器（或 id 不符）→ 不成立", async () => {
    await setup();
    expect(canRunLiveStop("other")).toBe(false);
  });

  it("最後一段有字 → 不成立", async () => {
    await setup([{ type: "paragraph" }, { type: "paragraph", content: "typed" }]);
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
  });

  it("最後一個 block 不是段落、或段落有子 block → 不成立", async () => {
    await setup([{ type: "paragraph" }, { type: "heading", props: { level: 2 } }]);
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
    cleanups.pop()!();
    const { editor } = await setup([{ type: "paragraph", children: [{ type: "paragraph", content: "child" }] }]);
    expect(editor.document.at(-1)!.children).toHaveLength(1);
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
  });

  it("唯讀 → 不成立", async () => {
    const { editor } = await setup();
    editor.isEditable = false;
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
  });

  it("讀文件時拋錯 → 不成立、不往外拋", async () => {
    const { editor } = await setup();
    vi.spyOn(editor, "document", "get").mockImplementation(() => {
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(canRunLiveStop(NOTE_ID)).toBe(false);
  });
});

describe("startTourTrigger／stopTourTrigger（帶 Y.Doc 的真編輯器）", () => {
  it("開 [[ 選單：選單開著，文件、Y 狀態、撤銷堆疊都不變", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    expect(startTourTrigger(editor, "[[")).toBe(true);
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    expect(snapshot(doc, editor)).toEqual(before);
    expect(editor._tiptapEditor.state.doc.textContent).toBe("intro");
  });

  it("開 / 選單也一樣", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    expect(startTourTrigger(editor, "/")).toBe(true);
    expect(isTriggerMenuShown(editor, "/")).toBe(true);
    expect(snapshot(doc, editor)).toEqual(before);
  });

  it("游標放進最後的空段落", async () => {
    const { editor } = await setup();
    startTourTrigger(editor, "[[");
    expect(editor.getTextCursorPosition().block.id).toBe(editor.document.at(-1)!.id);
  });

  it("結束後選單關了、文件前後相同、選取還原", async () => {
    const { doc, editor } = await setup();
    editor._tiptapEditor.commands.setTextSelection({ from: 3, to: 5 });
    const before = snapshot(doc, editor);
    startTourTrigger(editor, "[[");
    stopTourTrigger(editor);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    expect(snapshot(doc, editor)).toEqual(before);
    const { from, to } = editor._tiptapEditor.state.selection;
    expect([from, to]).toEqual([3, 5]);
  });

  it("選單先被別人關掉再結束：不拋錯、文件不變", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    startTourTrigger(editor, "[[");
    menuOf(editor).closeMenu();
    expect(() => stopTourTrigger(editor)).not.toThrow();
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    expect(snapshot(doc, editor)).toEqual(before);
  });

  it("重複開不會把游標已經移走的位置當成要還原的選取", async () => {
    const { editor } = await setup();
    editor._tiptapEditor.commands.setTextSelection({ from: 3, to: 5 });
    startTourTrigger(editor, "[[");
    startTourTrigger(editor, "[[");
    stopTourTrigger(editor);
    const { from, to } = editor._tiptapEditor.state.selection;
    expect([from, to]).toEqual([3, 5]);
  });

  it("重複開、重複關、沒開過就關：都是空操作", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    expect(() => stopTourTrigger(editor)).not.toThrow();
    startTourTrigger(editor, "[[");
    expect(startTourTrigger(editor, "[[")).toBe(true);
    stopTourTrigger(editor);
    expect(() => stopTourTrigger(editor)).not.toThrow();
    expect(snapshot(doc, editor)).toEqual(before);
  });

  it("開著選單時，使用者打的字被擋下（過濾開著），文件不變", async () => {
    const { doc, editor } = await setup();
    startLiveTrigger(NOTE_ID, "[[");
    const before = snapshot(doc, editor);
    const view = editor._tiptapEditor.view;
    view.dispatch(view.state.tr.insertText("x", view.state.selection.from));
    view.dispatch(view.state.tr.insertText("測", view.state.selection.from).setMeta("composition", 1));
    expect(snapshot(doc, editor)).toEqual(before);
    stopLiveTrigger(NOTE_ID);
    view.dispatch(view.state.tr.insertText("y", view.state.selection.from));
    expect(editor._tiptapEditor.state.doc.textContent).toBe("introy");
  });
});

describe("startLiveTrigger／stopLiveTrigger（站點用）", () => {
  it("進站：過濾開、選單開；離站：選單關、過濾關", async () => {
    const { editor } = await setup();
    startLiveTrigger(NOTE_ID, "[[");
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    stopLiveTrigger(NOTE_ID);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
  });

  it("關選單時拋錯：過濾照樣關掉（錯誤照常往外拋給引擎記錄）", async () => {
    const { editor } = await setup();
    startLiveTrigger(NOTE_ID, "[[");
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    vi.spyOn(menuOf(editor), "closeMenu").mockImplementation(() => {
      throw new Error("Attempting to update uninitialized suggestions menu");
    });
    expect(() => stopLiveTrigger(NOTE_ID)).toThrow("uninitialized");
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
  });

  it("沒有登記的編輯器：什麼都不做、不拋錯", () => {
    expect(getTourNoteEditor(NOTE_ID)).toBeNull();
    expect(() => startLiveTrigger(NOTE_ID, "[[")).not.toThrow();
    expect(() => stopLiveTrigger(NOTE_ID)).not.toThrow();
  });

  it("開關不經任何註冊或拆外掛", async () => {
    const { editor } = await setup();
    const tiptap = editor._tiptapEditor;
    const register = vi.spyOn(tiptap, "registerPlugin");
    const unregister = vi.spyOn(tiptap, "unregisterPlugin");
    const plugins = tiptap.state.plugins;
    startLiveTrigger(NOTE_ID, "[[");
    stopLiveTrigger(NOTE_ID);
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(tiptap.state.plugins).toBe(plugins);
  });
});

/** 一個有尺寸、掛著導覽目標屬性的元素（單元測試沒有真的選單畫面，借它當選單的根）。 */
function fakeTargetEl(id: string, parent: Element = document.body): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-kb-tour-target", id);
  parent.appendChild(el);
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 100, 40));
  return el;
}

describe("isTriggerMenuShown：看是哪個觸發字的選單", () => {
  it("開的是 / 時，[[ 不算開著；開的是 [[ 時，/ 不算開著", async () => {
    const { editor } = await setup();
    startTourTrigger(editor, "/");
    expect(isTriggerMenuShown(editor, "/")).toBe(true);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    stopTourTrigger(editor);
    startTourTrigger(editor, "[[");
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
  });

  it("選單關了就都不算", async () => {
    const { editor } = await setup();
    startTourTrigger(editor, "/");
    stopTourTrigger(editor);
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
  });
});

describe("liveTriggerTarget：/ 選單", () => {
  it("演示中、/ 選單開著：指 / 選單；上一站留在畫面上的 [[ 選單不算", async () => {
    const { editor } = await setup();
    const oldMenu = fakeTargetEl("wikilinkMenu");
    startTourTrigger(editor, "/");
    expect(liveTriggerTarget(NOTE_ID, "/", "slashMenu", "flowchart")).toEqual([]);
    const menu = fakeTargetEl("slashMenu");
    expect(liveTriggerTarget(NOTE_ID, "/", "slashMenu", "flowchart")).toEqual([menu]);
    expect(oldMenu).not.toBe(menu);
  });

  it("開著的是 [[ 選單時，/ 站不當成演示（改指流程圖）", async () => {
    const { editor } = await setup();
    const chart = fakeTargetEl("flowchart", editor.domElement);
    fakeTargetEl("slashMenu");
    startTourTrigger(editor, "[[");
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    expect(liveTriggerTarget(NOTE_ID, "/", "slashMenu", "flowchart")).toEqual([chart]);
  });

  it("/ 選單關掉：改指筆記裡現成的流程圖", async () => {
    const { editor } = await setup();
    const chart = fakeTargetEl("flowchart", editor.domElement);
    fakeTargetEl("slashMenu");
    startTourTrigger(editor, "/");
    menuOf(editor).closeMenu();
    expect(liveTriggerTarget(NOTE_ID, "/", "slashMenu", "flowchart")).toEqual([chart]);
  });
});

describe("liveTriggerTarget", () => {
  it("演示中、選單開著：指選單；選單的畫面還沒出現時回空陣列（引擎會等）", async () => {
    const { editor } = await setup();
    const link = fakeTargetEl("wikilink", editor.domElement);
    startTourTrigger(editor, "[[");
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([]);
    const menu = fakeTargetEl("wikilinkMenu");
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([menu]);
    expect(link).not.toBe(menu);
  });

  it("選單因故關掉：改指筆記裡現成的成品", async () => {
    const { editor } = await setup();
    const link = fakeTargetEl("wikilink", editor.domElement);
    fakeTargetEl("wikilinkMenu");
    startTourTrigger(editor, "[[");
    menuOf(editor).closeMenu();
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
  });

  it("不是導覽開的選單（使用者自己開的）：不當成演示，指現成的成品", async () => {
    const { editor } = await setup();
    const link = fakeTargetEl("wikilink", editor.domElement);
    fakeTargetEl("wikilinkMenu");
    menuOf(editor).openSuggestionMenu("[[", { deleteTriggerCharacter: false });
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
  });

  it("沒有在演示（靜態站）：指現成的成品，不看選單；現成的也沒有就回空陣列", async () => {
    const { editor } = await setup();
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([]);
    fakeTargetEl("wikilinkMenu");
    const link = fakeTargetEl("wikilink", editor.domElement);
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
  });

  it("退路只在示範筆記的編輯器裡找（別處同 id 的元素不算），找到的第一次捲進視窗、之後不再捲", async () => {
    const { editor } = await setup();
    fakeTargetEl("wikilink"); // 編輯器外面的同 id 元素（例如版本預覽）
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([]);
    const link = fakeTargetEl("wikilink", editor.domElement);
    const scroll = vi.fn();
    link.scrollIntoView = scroll;
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
    expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([link]);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });
});

describe("wikilink 站點接進引擎", () => {
  const CTX_BASE: StopContext = { searchQuery: "", aiActions: [], sampleNoteId: NOTE_ID, liveStops: true };
  /** 站序裡跟在演示站後面的一般站：目標是一個有尺寸的元素，引擎才會立刻進站。 */
  function lastStop(): TourStopEntry {
    const el = fakeTargetEl("userMenu");
    return { stop: { id: "userMenu", titleKey: "x", bodyKey: "x", target: () => [el] } };
  }

  async function runStops(ctx: StopContext, editor: TourEditor) {
    fakeTargetEl("wikilink", editor.domElement);
    const engine = new TourEngine([{ stop: STOPS.wikilink }, lastStop()], ctx);
    await engine.begin();
    return engine;
  }

  it("進站開選單與過濾；下一步、結束、卸載都收乾淨，文件不變", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    const menu = fakeTargetEl("wikilinkMenu");
    for (const leaveBy of ["next", "close", "unmount"] as const) {
      const engine = await runStops(CTX_BASE, editor);
      expect(engine.getSnapshot().entry?.stop.id).toBe("wikilink");
      expect(engine.getSnapshot().index).toBe(0);
      expect(isTriggerMenuShown(editor, "[[")).toBe(true);
      expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
      expect(liveTriggerTarget(NOTE_ID, "[[", "wikilinkMenu", "wikilink")).toEqual([menu]);
      if (leaveBy === "next") engine.next();
      else engine.end(leaveBy);
      await vi.waitFor(() => {
        expect(isTriggerMenuShown(editor, "[["), leaveBy).toBe(false);
        expect(isTourTransactionFilterOn(editor._tiptapEditor), leaveBy).toBe(false);
      });
      expect(snapshot(doc, editor), leaveBy).toEqual(before);
    }
  });

  it("上一步回到演示站：選單重新開", async () => {
    const { editor } = await setup();
    fakeTargetEl("wikilinkMenu");
    const engine = await runStops(CTX_BASE, editor);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(1));
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    engine.back();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(0));
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    engine.end("close");
  });

  it("不能演示（liveStops 為 false）：不開選單、不開過濾，指現成的連結", async () => {
    const { editor } = await setup();
    const engine = await runStops({ ...CTX_BASE, liveStops: false }, editor);
    expect(engine.getSnapshot().index).toBe(0);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    expect(STOPS.wikilink.live?.({ ...CTX_BASE, liveStops: false })).toBe(false);
    expect(STOPS.wikilink.live?.(CTX_BASE)).toBe(true);
    engine.end("close");
  });

  it.each([
    ["wikilink", "[["],
    ["slash", "/"],
  ] as const)("窄視窗也跑 prepare（%s 站）：選單開、過濾開；一般站在窄視窗仍不跑", async (stopId, trigger) => {
    const { editor } = await setup();
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
    expect(isNarrowViewport()).toBe(true);
    prepareStop(STOPS[stopId], CTX_BASE);
    expect(isTriggerMenuShown(editor, trigger)).toBe(true);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    stopLiveTrigger(NOTE_ID);
    const plain = vi.fn();
    prepareStop({ id: "tabs", titleKey: "x", bodyKey: "x", target: () => [], prepare: plain }, CTX_BASE);
    expect(plain).not.toHaveBeenCalled();
  });
});

describe("slash 站點接進引擎", () => {
  const CTX_BASE: StopContext = { searchQuery: "", aiActions: [], sampleNoteId: NOTE_ID, liveStops: true };
  function lastStop(): TourStopEntry {
    const el = fakeTargetEl("userMenu");
    return { stop: { id: "userMenu", titleKey: "x", bodyKey: "x", target: () => [el] } };
  }

  /** 兩個演示站接在一起（[[ 在前、/ 在後），選單畫面用假元素代替。 */
  async function run(ctx: StopContext, editor: TourEditor) {
    // 編輯器自己的 DOM 會在交易之後被 ProseMirror 重畫、把外來的假元素清掉：改讓「編輯器的 DOM」指向另一個固定的容器。
    const host = document.createElement("div");
    document.body.appendChild(host);
    vi.spyOn(editor, "domElement", "get").mockReturnValue(host);
    const chart = fakeTargetEl("flowchart", host);
    fakeTargetEl("wikilinkMenu");
    fakeTargetEl("wikilink", host);
    const slashMenu = fakeTargetEl("slashMenu");
    const engine = new TourEngine([{ stop: STOPS.wikilink }, { stop: STOPS.slash }, lastStop()], ctx);
    await engine.begin();
    return { engine, chart, slashMenu };
  }

  it("從 [[ 站走到 / 站：[[ 選單收掉、/ 選單打開，挖亮選單與流程圖；文件不變", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    const { engine, chart, slashMenu } = await run(CTX_BASE, editor);
    expect(isTriggerMenuShown(editor, "[[")).toBe(true);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().entry?.stop.id).toBe("slash"));
    expect(isTriggerMenuShown(editor, "/")).toBe(true);
    expect(isTriggerMenuShown(editor, "[[")).toBe(false);
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(true);
    expect(stopTarget(STOPS.slash, CTX_BASE)).toEqual([slashMenu, chart]);
    expect(snapshot(doc, editor)).toEqual(before);
  });

  it("離開 / 站（下一步、結束、卸載）：選單與過濾都收乾淨，文件不變", async () => {
    const { doc, editor } = await setup();
    const before = snapshot(doc, editor);
    for (const leaveBy of ["next", "close", "unmount"] as const) {
      const { engine } = await run(CTX_BASE, editor);
      engine.next();
      await vi.waitFor(() => expect(engine.getSnapshot().entry?.stop.id).toBe("slash"));
      if (leaveBy === "next") engine.next();
      else engine.end(leaveBy);
      await vi.waitFor(() => {
        expect(isTriggerMenuShown(editor, "/"), leaveBy).toBe(false);
        expect(isTourTransactionFilterOn(editor._tiptapEditor), leaveBy).toBe(false);
      });
      expect(snapshot(doc, editor), leaveBy).toEqual(before);
    }
  });

  it("上一步回到 / 站：選單重新開", async () => {
    const { editor } = await setup();
    const { engine } = await run(CTX_BASE, editor);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(1));
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(2));
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
    engine.back();
    await vi.waitFor(() => expect(engine.getSnapshot().index).toBe(1));
    expect(isTriggerMenuShown(editor, "/")).toBe(true);
    engine.end("close");
  });

  it("不能演示（liveStops 為 false）：不開選單，只挖亮現成的流程圖，卡片不是演示樣態", async () => {
    const { editor } = await setup();
    const ctx = { ...CTX_BASE, liveStops: false };
    const { engine, chart } = await run(ctx, editor);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().entry?.stop.id).toBe("slash"));
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
    expect(stopTarget(STOPS.slash, ctx)).toEqual([chart]);
    expect(STOPS.slash.live?.(ctx)).toBe(false);
    expect(STOPS.slash.live?.(CTX_BASE)).toBe(true);
    engine.end("close");
  });

  it("/ 選單中途被關掉：只剩流程圖", async () => {
    const { editor } = await setup();
    const { engine, chart } = await run(CTX_BASE, editor);
    engine.next();
    await vi.waitFor(() => expect(engine.getSnapshot().entry?.stop.id).toBe("slash"));
    menuOf(editor).closeMenu();
    expect(stopTarget(STOPS.slash, CTX_BASE)).toEqual([chart]);
    engine.end("close");
  });

  it("筆記裡沒有流程圖（被使用者刪了）：選單開著時只挖亮選單", async () => {
    const { editor } = await setup();
    const slashMenu = fakeTargetEl("slashMenu");
    startLiveTrigger(NOTE_ID, "/");
    expect(stopTarget(STOPS.slash, CTX_BASE)).toEqual([slashMenu]);
    stopLiveTrigger(NOTE_ID);
    expect(stopTarget(STOPS.slash, CTX_BASE)).toEqual([]);
    expect(isTriggerMenuShown(editor, "/")).toBe(false);
  });
});

describe("installLiveStopInput", () => {
  const handlers = { next: vi.fn(), back: vi.fn() };
  let editorSide: ReturnType<typeof vi.fn>;
  let uninstall: () => void;

  beforeEach(() => {
    handlers.next.mockReset();
    handlers.back.mockReset();
    editorSide = vi.fn();
    // 編輯器那一側的監聽：在 window 的 capture 之後才輪到。
    document.body.addEventListener("keydown", editorSide);
    document.body.addEventListener("click", editorSide);
    uninstall = installLiveStopInput(handlers);
  });

  afterEach(() => {
    uninstall();
    document.body.removeEventListener("keydown", editorSide);
    document.body.removeEventListener("click", editorSide);
  });

  function press(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    document.body.dispatchEvent(event);
    return event;
  }

  it("→ 和 Enter 下一步、← 上一步；都不送進編輯器", () => {
    for (const key of ["ArrowRight", "Enter"]) {
      const event = press({ key });
      expect(event.defaultPrevented, key).toBe(true);
    }
    expect(handlers.next).toHaveBeenCalledTimes(2);
    const left = press({ key: "ArrowLeft" });
    expect(left.defaultPrevented).toBe(true);
    expect(handlers.back).toHaveBeenCalledTimes(1);
    expect(editorSide).not.toHaveBeenCalled();
  });

  it("其他按鍵（方向鍵、字元、Tab、Backspace）一律擋下，不換站", () => {
    for (const key of ["ArrowDown", "ArrowUp", "a", "Tab", "Backspace", "/", "["]) {
      expect(press({ key }).defaultPrevented, key).toBe(true);
    }
    expect(handlers.next).not.toHaveBeenCalled();
    expect(handlers.back).not.toHaveBeenCalled();
    expect(editorSide).not.toHaveBeenCalled();
  });

  it("Esc 不在這裡處理：照常往下傳（遮罩在同一層接）", () => {
    const event = press({ key: "Escape" });
    expect(event.defaultPrevented).toBe(false);
    expect(editorSide).toHaveBeenCalledTimes(1);
    expect(handlers.next).not.toHaveBeenCalled();
  });

  it("輸入法組字中的按鍵擋下，但不換站", () => {
    const event = press({ key: "Process", keyCode: 229, isComposing: true });
    expect(event.defaultPrevented).toBe(true);
    press({ key: "Enter", isComposing: true });
    expect(handlers.next).not.toHaveBeenCalled();
    expect(editorSide).not.toHaveBeenCalled();
  });

  it("按住不放不連續跳站", () => {
    press({ key: "ArrowRight", repeat: true });
    expect(handlers.next).not.toHaveBeenCalled();
  });

  it("功能鍵放行（連編輯器也收得到）", () => {
    for (const key of ["F5", "F12"]) expect(press({ key }).defaultPrevented, key).toBe(false);
    expect(editorSide).toHaveBeenCalledTimes(2);
  });

  it("Ctrl／Meta／Alt 組合鍵一律不送進編輯器；瀏覽器快捷鍵不 preventDefault，所以照常有效", () => {
    for (const init of [{ key: "r", ctrlKey: true }, { key: "l", metaKey: true }, { key: "c", ctrlKey: true }, { key: "ArrowLeft", altKey: true }, { key: "I", ctrlKey: true, shiftKey: true }]) {
      expect(press(init).defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(editorSide).not.toHaveBeenCalled();
  });

  it("Ctrl／Meta＋z、y、v、x、a 與 Ctrl／Alt／Meta＋Enter 另外 preventDefault，也不換站", () => {
    const combos = [
      { key: "z", ctrlKey: true },
      { key: "Z", metaKey: true, shiftKey: true },
      { key: "y", ctrlKey: true },
      { key: "v", ctrlKey: true },
      { key: "x", metaKey: true },
      { key: "a", ctrlKey: true },
      { key: "Enter", ctrlKey: true },
      { key: "Enter", altKey: true },
      { key: "Enter", metaKey: true },
    ];
    for (const init of combos) expect(press(init).defaultPrevented, JSON.stringify(init)).toBe(true);
    expect(editorSide).not.toHaveBeenCalled();
    expect(handlers.next).not.toHaveBeenCalled();
    expect(handlers.back).not.toHaveBeenCalled();
  });

  it.each(["wikilinkMenu", "slashMenu"])("%s 上的點擊擋下；別處的點擊放行", (menuId) => {
    const menu = fakeTargetEl(menuId);
    const item = document.createElement("button");
    menu.appendChild(item);
    const onItem = vi.fn();
    item.addEventListener("click", onItem);
    item.click();
    expect(onItem).not.toHaveBeenCalled();
    const other = document.createElement("button");
    document.body.appendChild(other);
    const onOther = vi.fn();
    other.addEventListener("click", onOther);
    other.click();
    expect(onOther).toHaveBeenCalledTimes(1);
  });

  it("拆除後完全放行", () => {
    uninstall();
    expect(press({ key: "a" }).defaultPrevented).toBe(false);
    expect(press({ key: "ArrowRight" }).defaultPrevented).toBe(false);
    expect(handlers.next).not.toHaveBeenCalled();
    uninstall = installLiveStopInput(handlers);
  });
});
