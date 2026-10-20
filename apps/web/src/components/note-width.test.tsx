import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { getNoteWidth, setNoteWidth, subscribeNoteWidth, useNoteWidth } from "./note-width";

/** #297 §4.1：站內寬度——模組層 Map 是同分頁真相，localStorage 盡力寫、`storage` 事件同步他分頁。 */
describe("note-width（站內每篇寬度）", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("N1 讀：缺鍵／壞值／standard → standard；wide／full 原值；getItem 丟例外 → standard", () => {
    // 每個子案各用一個 id：Map 會快取第一次讀到的值，同一個 id 會讓後面的子案讀到前一案。
    expect(getNoteWidth("n1-missing")).toBe("standard");
    localStorage.setItem("note.width.n1-bogus", "bogus");
    expect(getNoteWidth("n1-bogus")).toBe("standard");
    localStorage.setItem("note.width.n1-standard", "standard");
    expect(getNoteWidth("n1-standard")).toBe("standard");
    localStorage.setItem("note.width.n1-wide", "wide");
    expect(getNoteWidth("n1-wide")).toBe("wide");
    localStorage.setItem("note.width.n1-full", "full");
    expect(getNoteWidth("n1-full")).toBe("full");
    localStorage.setItem("note.width.n1-blocked", "full");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getNoteWidth("n1-blocked")).toBe("standard");
  });

  it("N2 寫：wide／full 寫字串；standard 移除鍵", () => {
    setNoteWidth("n2", "wide");
    expect(localStorage.getItem("note.width.n2")).toBe("wide");
    setNoteWidth("n2", "full");
    expect(localStorage.getItem("note.width.n2")).toBe("full");
    setNoteWidth("n2", "standard");
    expect(localStorage.getItem("note.width.n2")).toBeNull();
  });

  it("N3 儲存被封鎖：選「寬」仍生效（先更新 Map 再盡力寫）", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useNoteWidth("n3"));
    act(() => result.current[1]("wide"));
    expect(result.current[0]).toBe("wide");
    expect(getNoteWidth("n3")).toBe("wide");
  });

  it("N4 每篇各自：設 A 全寬，B 仍標準；經 setNoteWidth 改值 hook 重繪", () => {
    const a = renderHook(() => useNoteWidth("n4-a"));
    const b = renderHook(() => useNoteWidth("n4-b"));
    act(() => setNoteWidth("n4-a", "full"));
    expect(a.result.current[0]).toBe("full");
    expect(b.result.current[0]).toBe("standard");
  });

  it("N5 storage 事件：只更新並通知該篇；newValue null → standard；key null → 全清並通知全部；他鍵忽略", () => {
    const fa = vi.fn();
    const fb = vi.fn();
    const ua = subscribeNoteWidth("n5-a", fa);
    const ub = subscribeNoteWidth("n5-b", fb);
    try {
      window.dispatchEvent(new StorageEvent("storage", { key: "note.width.n5-a", newValue: "full" }));
      expect(getNoteWidth("n5-a")).toBe("full");
      expect(fa).toHaveBeenCalledTimes(1);
      expect(fb).not.toHaveBeenCalled();

      window.dispatchEvent(new StorageEvent("storage", { key: "note.width.n5-a", newValue: null }));
      expect(getNoteWidth("n5-a")).toBe("standard");

      // 他分頁 localStorage.clear()：儲存是共用的，所以這邊也已經空了，事件只帶 key null。
      setNoteWidth("n5-a", "wide");
      setNoteWidth("n5-b", "wide");
      fa.mockClear();
      fb.mockClear();
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
      expect(getNoteWidth("n5-a")).toBe("standard");
      expect(getNoteWidth("n5-b")).toBe("standard");
      expect(fa).toHaveBeenCalled();
      expect(fb).toHaveBeenCalled();

      fa.mockClear();
      fb.mockClear();
      window.dispatchEvent(new StorageEvent("storage", { key: "sidebar.width", newValue: "300" }));
      expect(fa).not.toHaveBeenCalled();
      expect(fb).not.toHaveBeenCalled();
    } finally {
      ua();
      ub();
    }
  });

  it("N6 useNoteWidth(null) → standard；setter 不寫任何鍵", () => {
    const { result } = renderHook(() => useNoteWidth(null));
    expect(result.current[0]).toBe("standard");
    act(() => result.current[1]("full"));
    expect(result.current[0]).toBe("standard");
    expect(localStorage.length).toBe(0);
  });

  it("N7 大寫 id 一律轉小寫當鍵", () => {
    setNoteWidth("ABC", "full");
    expect(localStorage.getItem("note.width.abc")).toBe("full");
    expect(getNoteWidth("abc")).toBe("full");
  });

  it("N9 最後一個訂閱者離開時清空 Map：無人監聽期間他分頁寫入的值，再訂閱時由 localStorage 重新種入", () => {
    const un = subscribeNoteWidth("n9", vi.fn());
    try {
      setNoteWidth("n9", "full");
    } finally {
      un();
    }
    // 他分頁在沒有監聽器的期間寫入（同視窗的 setItem 不發 storage 事件，正好模擬「沒收到」）。
    localStorage.setItem("note.width.n9", "wide");
    const un2 = subscribeNoteWidth("n9", vi.fn());
    try {
      expect(getNoteWidth("n9")).toBe("wide");
    } finally {
      un2();
    }
  });

  it("N8a 設 X 寬", () => {
    setNoteWidth("n8", "wide");
    expect(getNoteWidth("n8")).toBe("wide");
  });

  it("N8b 下一案 X 回到標準（setup.ts 的 afterEach 重置模組 Map）", () => {
    expect(getNoteWidth("n8")).toBe("standard");
  });
});
