import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";

const measured = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/note-size-guard", async importOriginal => {
  const m = await importOriginal<typeof import("@/lib/note-size-guard")>();
  return {
    ...m,
    noteStateBytes: (doc: Y.Doc, above?: number) => {
      measured.calls++;
      return m.noteStateBytes(doc, above);
    },
  };
});
const { useNoteOverLimit, NOTE_OVER_LIMIT_CHECK_MS } = await import("./useNoteOverLimit");

afterEach(() => vi.useRealTimers());

describe("useNoteOverLimit（超過上限的提示）", () => {
  it("已經超過上限：只新增的變動不重量（量回收過的複本很貴）；有刪除的變動才重量，回到上限內就消失", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "x".repeat(5_000));
    const limit = Y.encodeStateAsUpdate(doc).byteLength - 100;
    const hook = renderHook(() => useNoteOverLimit(doc, limit, true));
    expect(hook.result.current).toBe(true);
    measured.calls = 0;
    act(() => doc.getText("t").insert(5_000, " typing"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_OVER_LIMIT_CHECK_MS + 100);
    });
    expect(measured.calls, "只新增：沒有重量").toBe(0);
    expect(hook.result.current).toBe(true);
    act(() => doc.getText("t").delete(0, 4_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_OVER_LIMIT_CHECK_MS + 100);
    });
    expect(measured.calls).toBe(1);
    expect(hook.result.current).toBe(false);
  });

  it("還在上限內：新增的變動照樣節流重量（可能因此超過）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "x".repeat(100));
    const limit = Y.encodeStateAsUpdate(doc).byteLength + 500;
    const hook = renderHook(() => useNoteOverLimit(doc, limit, true));
    expect(hook.result.current).toBe(false);
    act(() => doc.getText("t").insert(100, "y".repeat(1_000)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_OVER_LIMIT_CHECK_MS + 100);
    });
    expect(hook.result.current).toBe(true);
  });
});
