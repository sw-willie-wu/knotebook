import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { NoteEditorView } from "@/components/NoteEditor";

/**
 * issue #97 的迴歸守門：**共編模式下 Ctrl+Z／Ctrl+Shift+Z 完全沒反應**。
 *
 * 病灶（完整版在 `@/collab/undo` 檔頭）：`<BlockNoteView>` 的 mount ref callback 把
 * `editable` 列進 `useCallback` 依賴，`editable` 一翻面 React 就 detach 舊 ref
 * （`editor.unmount()`）再 attach 新的（`editor.mount()`）；y-prosemirror 的 undo
 * plugin 在 view 銷毀時呼叫 `undoManager.destroy()`（＝解除對 Y.Doc 的訂閱），
 * 但 plugin **state** 沿用同一個已死的 manager ⇒ 之後 `undoStack` 永遠是 0，
 * `editor.undo()` 靜默無作用、不丟例外。
 *
 * ⚠ **這一族用「掛起來就打字」的測法抓不到**——要重現必須真的讓 view 被拆一次。
 * 下面每一條都刻意走一種真實會發生的重掛路徑：
 * ① `editable` false→true（`NotePage` 的 `roleCanEdit && synced`，每開一篇筆記必然發生一次）
 * ② React `StrictMode`（`main.tsx` 有，開發模式每次掛載都會 mount→unmount→mount）
 *
 * 用真的 `<NoteEditorView>`（不是裸 `<BlockNoteView>`）：生命線就掛在那支上，
 * 測試要守的是「接線有沒有真的接上」，不是 helper 本身。
 */

const editors: BlockNoteEditor<never, never, never>[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/NoteEditorView.test.tsx）
type AnyEditor = BlockNoteEditor<any, any, any>;

/** 建一個「跟正式版同一條路」的共編 editor：`withCollaboration` + 自己的 Y.Doc。 */
function collabEditor(): { doc: Y.Doc; editor: AnyEditor } {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        // awareness 給 undefined＝不掛 y-cursor（測試不需要，也免得 jsdom 少 API）。
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  ) as any as AnyEditor;
  editors.push(editor as never);
  return { doc, editor };
}

async function getItems() {
  return [];
}

/** 目前第一個 block 的純文字（沒有內容時回空字串）。 */
function firstBlockText(editor: AnyEditor): string {
  const content = editor.document[0]?.content;
  if (!Array.isArray(content)) return "";
  return content.map((node: { text?: string }) => node.text ?? "").join("");
}

/** 打一段字（走 editor API，等同使用者輸入落進 Y.Doc 的那條路）。 */
function type(editor: AnyEditor, text: string): void {
  act(() => {
    editor.updateBlock(editor.document[0]!, { content: text });
  });
}

/**
 * 這篇筆記的 Y.Doc 上，`afterTransaction` 的訂閱者裡有沒有這個 UndoManager 的 handler。
 * ——這就是「UndoManager 還活著」的**充要條件**：`UndoManager.destroy()` 拆掉的正是
 * 這條訂閱，而少了它 `undoStack` 永遠長不出東西（undo 於是靜默無作用）。
 */
function isSubscribed(doc: Y.Doc, manager: Y.UndoManager): boolean {
  const observers = (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
  return observers.get("afterTransaction")?.has(manager.afterTransactionHandler) === true;
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    // 掛過的 editor 一律拆乾淨，免得 jsdom 的 document 累積 portal。
    try {
      (editor as unknown as AnyEditor).unmount();
    } catch {
      // 沒掛載過的 editor unmount 會抱怨，不影響測試。
    }
  }
});

describe("共編 undo/redo 生命線（issue #97）", () => {
  it("editable 從 false 翻成 true（等同 synced 完成）之後，undo 仍然能復原剛打的字", () => {
    const { editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    // ← 這一行就是 `NotePage` 的 `editable = roleCanEdit && synced` 在 synced 抵達時做的事。
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    type(editor, "hello world");
    expect(firstBlockText(editor)).toBe("hello world");

    act(() => {
      editor.undo();
    });

    expect(firstBlockText(editor)).toBe("");
  });

  it("editable 翻面之後 redo 也回得來（Ctrl+Shift+Z／Ctrl+Y 走的是同一個 UndoManager）", () => {
    const { editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    type(editor, "hello world");
    act(() => {
      editor.undo();
    });
    expect(firstBlockText(editor)).toBe("");

    act(() => {
      editor.redo();
    });

    expect(firstBlockText(editor)).toBe("hello world");
  });

  it("StrictMode 的模擬重掛（開發模式每次掛載都會發生）之後，undo 仍然有效", () => {
    const { editor } = collabEditor();
    render(
      <StrictMode>
        <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />
      </StrictMode>,
    );

    type(editor, "hello world");
    act(() => {
      editor.undo();
    });

    expect(firstBlockText(editor)).toBe("");
  });

  it("不變量：view 重掛之後，UndoManager 仍然訂閱著它的 Y.Doc", () => {
    const { doc, editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    const manager = collabUndoManager(editor);
    // 先釘住「找得到 manager」本身——BlockNote 換掉 `yUndo` extension 的形狀時，
    // 這條會紅（而不是讓生命線靜默退化成 no-op、讓其餘斷言變成空轉）。
    expect(manager).toBeDefined();
    expect(isSubscribed(doc, manager!)).toBe(true);

    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    expect(isSubscribed(doc, manager!)).toBe(true);
    // 而且是**同一個** manager（不是偷偷重建一個新的——重建會丟掉重掛前的歷史）。
    expect(collabUndoManager(editor)).toBe(manager);
  });

  it("重掛保留歷史：重掛前後各打一次字，兩次 Ctrl+Z 逐格倒回去（不是重建一個空的 UndoManager）", () => {
    const { editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    type(editor, "before");
    // `captureTimeout` 預設 500ms 會把相鄰的改動併成同一格；停止捕捉，確保兩次輸入
    // 分屬兩個 stack item，下面「兩次 undo」才真的在測兩格歷史。
    collabUndoManager(editor)!.stopCapturing();

    rerender(<NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    type(editor, "before / after");
    act(() => {
      editor.undo();
    });
    // 第一次 undo 撤掉重掛「之後」那一筆——這一格只有生命線把 manager 接回去才長得出來。
    expect(firstBlockText(editor)).toBe("before");

    act(() => {
      editor.undo();
    });
    // 第二次 undo 撤掉重掛「之前」那一筆——重建 manager 的修法會把這一格弄丟。
    expect(firstBlockText(editor)).toBe("");
  });

  it("換筆記不串味：新的 Y.Doc/editor 有自己的空 undo 歷史，undo 不會動到別篇的內容", () => {
    const { editor: first } = collabEditor();
    const { unmount } = render(
      <NoteEditorView editor={first} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    type(first, "note one");
    unmount();

    // `useCollab` 換筆記時會另開一份 Y.Doc/provider，`useCreateBlockNote([doc, provider])`
    // 因此建出全新的 editor——這裡照樣重現那個形狀。
    const { editor: second } = collabEditor();
    render(<NoteEditorView editor={second} editable theme="light" noteId="note-2" getItems={getItems} getSlashItems={getItems} />);

    expect(collabUndoManager(second)).not.toBe(collabUndoManager(first));
    expect(collabUndoManager(second)!.undoStack).toHaveLength(0);

    act(() => {
      second.undo();
    });

    // 第二篇沒有歷史可撤（本來就是空的），第一篇的內容原封不動。
    expect(firstBlockText(second)).toBe("");
    expect(firstBlockText(first)).toBe("note one");
  });
});

/**
 * issue #100：撤到空白文件之後 redo 失效。
 *
 * 機制（jsdom 完整重現，與真瀏覽器探針序列逐格吻合）：undo 讓 fragment 變空 →
 * BlockNote/PM 正規化補回空段落 → y-prosemirror sync plugin 的 `view.update` 在
 * **下一筆任意 PM transaction** 觸發時，以 `ySyncPluginKey`（＝使用者編輯共用的
 * origin）把正規化寫回 Y.Doc → `UndoManager` 當成新編輯 → `clear(false, true)`
 * 清掉 redoStack。「多等一下必敗、按得夠快偶爾贏」就是這個競態。
 *
 * 修法（`guardEmptyDocNormalization`）的判別式是三元組合：origin=y-sync$ ∧
 * deleteSet 空 ∧ 結果恰為預設空文件——使用者的任何真編輯都不滿足（全刪有
 * deleteSet；打第一個字結果非空）。下面「使用者自己清空」那條就是判別式不得
 * 過寬的守門。
 */
describe("撤到空白文件後的 redo（issue #100）", () => {
  /** 模擬「undo 之後 ~12ms 的任一 PM transaction」：空 tr 觸發 sync plugin 的 view.update 回寫。 */
  function triggerNormalizationWriteback(editor: AnyEditor): void {
    act(() => {
      const view = editor._tiptapEditor.view;
      view.dispatch(view.state.tr);
    });
  }

  it("打字 → undo 到空 → （正規化回寫發生後）redo 仍能復原文字，且文件結構單一", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    expect(doc.getXmlFragment(YDOC_FRAGMENT).length, "undo 後 fragment 應為空（本 bug 的前提）").toBe(0);

    triggerNormalizationWriteback(editor);
    expect(manager.redoStack.length, "正規化回寫不得清掉 redoStack（#100 的核心）").toBe(1);

    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    // 殘渣守門：redo 前正規化插入的空 blockGroup 必須被清掉，否則 fragment 出現
    // 兩個平行 blockGroup（不合法結構），PM 只渲染第一個、看起來像 redo 沒生效。
    const xml = doc.getXmlFragment(YDOC_FRAGMENT).toString();
    expect((xml.match(/<blockgroup/g) ?? []).length).toBe(1);
  });

  it("歷史可連續來回：redo 之後再 undo 再 redo 都要通，清殘渣那筆不得進歷史", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    triggerNormalizationWriteback(editor);
    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    // 清殘渣（非 tracked origin）不得變成一格歷史：此刻 undoStack 只該有 hello 那一筆。
    expect(manager.undoStack.length).toBe(1);

    act(() => { manager.undo(); });
    expect(doc.getXmlFragment(YDOC_FRAGMENT).length, "再 undo 應回到空").toBe(0);
    triggerNormalizationWriteback(editor);
    act(() => { manager.redo(); });
    expect(firstBlockText(editor), "第二輪 redo 也要通").toBe("hello");
  });

  it("判別式不得過寬：使用者自己把內容清空（結果同為空文件形，但有刪除）仍要可 undo", () => {
    const { editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    // 分格：不 stopCapturing 的話，打字與清空落在同一個 captureTimeout（500ms）會
    // 合併成一格，undo 一步就回到打字前——測不到「undo 恢復被清掉的內容」。
    act(() => { manager.stopCapturing(); });
    // 使用者清空：同樣經 y-sync$ 回寫、結果同為「空段落」形，但 deleteSet 非空——
    // 必須被捕捉，否則「刪光內容」變成不可撤銷的操作。（`content: []` 才是真清空；
    // 空字串 `""` 對 updateBlock 是 no-op 形。）
    act(() => { editor.updateBlock(editor.document[0]!, { content: [] }); });
    expect(firstBlockText(editor)).toBe("");

    act(() => { manager.undo(); });
    expect(firstBlockText(editor), "undo 要能復原被清掉的內容").toBe("hello");
  });

  it("editable 翻面（view 重掛、lifeline 重新 arm）之後守衛仍有效且不重複疊加", () => {
    const { doc, editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    triggerNormalizationWriteback(editor);
    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    expect((doc.getXmlFragment(YDOC_FRAGMENT).toString().match(/<blockgroup/g) ?? []).length).toBe(1);
  });
});
