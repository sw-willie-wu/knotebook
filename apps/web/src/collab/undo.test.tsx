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

/**
 * issue #100 修法的迴歸邊界（審查 C1，兩形在 main 上本來是好的，第一版修法弄壞過）：
 * 「殘渣」的鑑別不能用「長得像預設空文件」——那個結構可能是 redo 項目的**活 parent**
 * （yjs 的 redoItem 對已刪除且不在 redo 集合裡的 parent 直接回 null，redo 整疊 pop 光、
 * 什麼都沒恢復）。只有「這個 session 剛拒捕的那筆正規化、且之後沒有任何編輯沾過它」
 * 才可以清。
 */
describe("殘渣鑑別不得誤刪活 baseline（issue #100 審查 C1）", () => {
  function triggerWriteback(editor: AnyEditor): void {
    act(() => { const view = editor._tiptapEditor.view; view.dispatch(view.state.tr); });
  }

  it("同 session：撤到空→殘渣落地→再打字→undo→redo 要能復原新文字（殘渣已是新編輯的 parent，不可刪）", () => {
    const { editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    triggerWriteback(editor);
    // 使用者接著在殘渣的空段落上打新字（殘渣從此是這筆編輯的 parent）。
    act(() => { manager.stopCapturing(); });
    type(editor, "world");
    act(() => { manager.undo(); });
    triggerWriteback(editor);

    act(() => { manager.redo(); });
    expect(firstBlockText(editor), "redo 應復原 world；殘渣被誤刪的話 redo 整疊失效、文件停在全空").toBe("world");
  });

  it("重開曾撤空的筆記：殘渣已持久化為 baseline→打字→undo→redo 要能復原（新 session 沒拒捕過任何東西，不可清任何節點）", () => {
    // 第一個 session：製造殘渣並讓它成為持久化狀態。
    const first = collabEditor();
    render(<NoteEditorView editor={first.editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const firstManager = collabUndoManager(first.editor)!;
    type(first.editor, "hello");
    act(() => { firstManager.undo(); });
    act(() => { const view = first.editor._tiptapEditor.view; view.dispatch(view.state.tr); });
    expect(first.doc.getXmlFragment(YDOC_FRAGMENT).length, "殘渣應已落地").toBe(1);

    // 第二個 session：套用持久化狀態（等同重開筆記），在殘渣段落上編輯。
    const second = collabEditor();
    Y.applyUpdate(second.doc, Y.encodeStateAsUpdate(first.doc));
    render(<NoteEditorView editor={second.editor} editable theme="light" noteId="note-2" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(second.editor)!;

    type(second.editor, "world");
    act(() => { manager.undo(); });
    act(() => { const view = second.editor._tiptapEditor.view; view.dispatch(view.state.tr); });
    act(() => { manager.redo(); });
    expect(firstBlockText(second.editor), "redo 應復原 world；baseline 被誤刪＝資料遺失且不可 undo 救回").toBe("world");
  });
});

/**
 * 判別式各條腿的釘子（審查 I1：突變測試曾發現 origin 與 deleteSet 兩條腿沒有任何
 * 測試守著）。自然流程打不到這兩條腿（使用者情境都被其他條件先擋下），所以用
 * **合成 transaction** 直接打：判別式對 origin 只比對 `key === "y-sync$"` 字串，
 * 測試可以用假物件當 origin。
 */
describe("判別式的腿各自有守（issue #100 審查 I1）", () => {
  function triggerWriteback(editor: AnyEditor): void {
    act(() => { const view = editor._tiptapEditor.view; view.dispatch(view.state.tr); });
  }
  /** 造出「blockGroup > blockContainer > 空 paragraph」的合成節點。 */
  function defaultEmptyGroup(): Y.XmlElement {
    const group = new Y.XmlElement("blockGroup");
    const container = new Y.XmlElement("blockContainer");
    const paragraph = new Y.XmlElement("paragraph");
    container.insert(0, [paragraph]);
    group.insert(0, [container]);
    return group;
  }

  it("origin 腿：非 sync 來源的「純插入空文件形」必須被捕捉（例如未來 server seed）", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;
    // 先讓 UndoManager 追蹤這個合成 origin，隔離出「只有 origin 腿在分辨」的情境。
    const seedOrigin = { key: "not-sync" };
    manager.trackedOrigins.add(seedOrigin);

    // fragment 為空時插入預設空文件形——與正規化回寫唯一的差別是 origin。
    act(() => { doc.transact(() => { doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [defaultEmptyGroup()]); }, seedOrigin); });
    expect(manager.undoStack.length, "origin 不是 y-sync$ 就不得被判成正規化，必須進歷史").toBe(1);
  });

  it("deleteSet 腿：sync 來源「刪除＋重建成空文件形」的合成回寫必須被捕捉", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.stopCapturing(); });
    const before = manager.undoStack.length;
    // 假 y-sync$ origin：判別式只比對 key 字串。要先進 trackedOrigins（真的
    // ySyncPluginKey 本來就在裡面），否則 handler 在 origin 檢查就早退、測不到
    // 判別式。這筆有刪有插、結果是空文件形——deleteSet 腿是唯一擋住它的條件。
    const fakeSyncOrigin = { key: "y-sync$" };
    manager.trackedOrigins.add(fakeSyncOrigin);
    act(() => {
      doc.transact(() => {
        const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
        fragment.delete(0, fragment.length);
        fragment.insert(0, [defaultEmptyGroup()]);
      }, fakeSyncOrigin);
    });
    expect(manager.undoStack.length, "有刪除的回寫不是正規化，必須進歷史（否則這種清空不可 undo）").toBe(before + 1);
  });

  it("WeakSet 冪等：guard 重複裝（生命線每次重掛都會呼叫）不得再包一層 wrapper", () => {
    const { editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    const manager = collabUndoManager(editor)!;
    const captureRef = manager.captureTransaction;
    const redoRef = manager.redo;
    // 翻面 → 生命線 re-arm → guardEmptyDocNormalization 再被呼叫一次。
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    expect(manager.captureTransaction, "重複裝不得換掉（再包一層）captureTransaction").toBe(captureRef);
    expect(manager.redo, "重複裝不得換掉（再包一層）redo").toBe(redoRef);
  });

  // ⚠ 這條實際被釘住的是「作廢分支」（清殘渣與 redo 的 transaction 流經 captureTransaction
  // 就把記錄清掉），不是 redo wrapper 末尾那行 null——那行是縱深防禦（審查二 I2）。
  it("殘渣記錄用過即棄：redo 一次之後，同一顆節點不會被第二次 redo 誤刪", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    triggerWriteback(editor);
    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    // redoStack 已空；再按 redo 必須是安靜 no-op，不得動文件。
    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    expect(doc.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("hello");
  });
});

/**
 * 死窗口加固（第二輪審查 I1）：作廢不變量「captureTransaction 看得到每一筆」的前提
 * 是 manager 訂閱著 afterTransaction——而 #97 的病灶正是這條訂閱會在 view 重掛被拆。
 * 訂閱死掉期間遠端更新「就地沾染」殘渣節點的話，identity 比對擋不住（節點沒被換掉），
 * re-arm 後 redo 會把遠端內容連著殘渣一起刪掉（非 tracked origin、undo 救不回、會廣播）。
 * 加固：**re-arm 一律作廢殘渣記錄**（re-arm＝可能存在過死窗口），劣化方向是已
 * 文件化的「平行空 block」，fail-safe。
 */
describe("死窗口後 re-arm 作廢殘渣記錄（issue #100 審查二 I1）", () => {
  it("訂閱死掉期間遠端寫入殘渣段落 → re-arm → redo 不得刪掉遠端內容", () => {
    const { doc, editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    act(() => { const view = editor._tiptapEditor.view; view.dispatch(view.state.tr); });
    // 殘渣已被記錄。模擬死窗口：訂閱被拆（＝#97 的 view 重掛 destroy 期）。
    doc.off("afterTransaction", manager.afterTransactionHandler);
    // 遠端在殘渣的空段落裡插入內容（就地沾染，節點 identity 不變）。
    act(() => {
      doc.transact(() => {
        const paragraph = (doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
        (paragraph.get(0) as Y.XmlElement).insert(0, [new Y.XmlText("REMOTE")]);
      }, "remote-provider");
    });
    // re-arm（生命線在重掛後做的事）：editable 翻面觸發。
    rerender(<NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    act(() => { manager.redo(); });
    expect(
      doc.getXmlFragment(YDOC_FRAGMENT).toString(),
      "遠端內容不得被清殘渣連坐刪掉（非 tracked origin、undo 救不回）",
    ).toContain("REMOTE");
  });
});
