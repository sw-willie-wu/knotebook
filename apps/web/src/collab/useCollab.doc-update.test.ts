/**
 * `createDocUpdateDebouncer` 的純函式行為（#138 Task 4 起；本機編輯也要通知見下）。
 *
 * 遠端 update 的 origin 是 provider 本身（`@hocuspocus/provider` 的
 * `readSyncMessage(message.decoder, message.encoder, provider.document, provider)`，第四個參數
 * 就是 `Y.applyUpdate` 的 `transactionOrigin`）；本地打字的 origin 是 y-prosemirror 的
 * `ySyncPluginKey`。**兩種都要通知**：server 落盤時對兩者一樣寫 `notes.last_edited_*`，
 * 只聽遠端的話自己打的字永遠刷不到頁首的「最後編輯」，要重新整理才看得到。
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createDocUpdateDebouncer } from "./useCollab";

describe("createDocUpdateDebouncer", () => {
  it("任何 origin 的 update → delayMs 後呼叫一次（多次合併）；dispose 後不再呼叫", () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const remoteOrigin = {};
    const cb = vi.fn();
    const dispose = createDocUpdateDebouncer(doc, cb, 3_000);
    const text = doc.getText("t");

    for (const ch of ["a", "b", "c"]) doc.transact(() => text.insert(0, ch), remoteOrigin);
    vi.advanceTimersByTime(2_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);

    // 本機打字（origin 不是 provider）也要通知——頁首「最後編輯」的回歸守衛
    doc.transact(() => text.insert(0, "d"), { local: true });
    vi.advanceTimersByTime(3_000);
    expect(cb).toHaveBeenCalledTimes(2);

    // 本機與遠端交錯也只合併成一次（計時從最後一筆重算）
    doc.transact(() => text.insert(0, "e"), { local: true });
    vi.advanceTimersByTime(1_000);
    doc.transact(() => text.insert(0, "f"), remoteOrigin);
    vi.advanceTimersByTime(2_999);
    expect(cb).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(3);

    doc.transact(() => text.insert(0, "g"), remoteOrigin);
    dispose();
    vi.advanceTimersByTime(3_000);
    expect(cb).toHaveBeenCalledTimes(3);

    doc.destroy();
    vi.useRealTimers();
  });
});
