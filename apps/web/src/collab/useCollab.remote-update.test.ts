/**
 * #138 Task 4：`createRemoteUpdateDebouncer` 的純函式行為。
 *
 * 「遠端 update 的 origin 是 provider 本身」這件事由 `@hocuspocus/provider` 的
 * `readSyncMessage(message.decoder, message.encoder, provider.document, provider)`
 * 確定（第四個參數就是 `Y.applyUpdate` 的 `transactionOrigin`）；本檔只做身分比較，
 * 所以 provider 用一個空物件扮演即可，不呼叫它任何方法。
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { createRemoteUpdateDebouncer } from "./useCollab";

describe("createRemoteUpdateDebouncer", () => {
  it("origin 是 provider 的 update → delayMs 後呼叫一次（多次合併）；本地 origin 不觸發；dispose 後不再呼叫", () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const provider = {} as unknown as HocuspocusProvider;
    const cb = vi.fn();
    const dispose = createRemoteUpdateDebouncer(doc, provider, cb, 3_000);
    const text = doc.getText("t");

    for (const ch of ["a", "b", "c"]) doc.transact(() => text.insert(0, ch), provider);
    vi.advanceTimersByTime(2_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);

    doc.transact(() => text.insert(0, "d"), { local: true });
    vi.advanceTimersByTime(3_000);
    expect(cb).toHaveBeenCalledTimes(1);

    doc.transact(() => text.insert(0, "e"), provider);
    dispose();
    vi.advanceTimersByTime(3_000);
    expect(cb).toHaveBeenCalledTimes(1);

    doc.destroy();
    vi.useRealTimers();
  });
});
