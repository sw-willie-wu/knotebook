import { afterEach, describe, expect, it, vi } from "vitest";
import { backTarget, historyIdx, readListIdx, recordListIdx } from "./phone-nav";

function stubHistoryState(state: unknown) {
  Object.defineProperty(window.history, "state", { configurable: true, get: () => state });
}

afterEach(() => {
  delete (window.history as unknown as Record<string, unknown>).state;
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("backTarget", () => {
  it.each([
    ["清單序號不存在 → 換掉目前這格", { listIdx: null, currentIdx: 5 }, { kind: "replace" }],
    ["目前序號不存在 → 換掉", { listIdx: 2, currentIdx: null }, { kind: "replace" }],
    ["清單序號等於目前 → 換掉（同一格不能退）", { listIdx: 5, currentIdx: 5 }, { kind: "replace" }],
    ["清單序號大於目前 → 換掉（記錄過期）", { listIdx: 7, currentIdx: 5 }, { kind: "replace" }],
    ["清單序號小於目前 → 退 delta 格", { listIdx: 2, currentIdx: 5 }, { kind: "go", delta: -3 }],
    ["差一格 → 退一格", { listIdx: 4, currentIdx: 5 }, { kind: "go", delta: -1 }],
    ["清單在第 0 格 → 退到底", { listIdx: 0, currentIdx: 1 }, { kind: "go", delta: -1 }],
  ])("%s", (_name, input, expected) => {
    expect(backTarget(input)).toEqual(expected);
  });
});

describe("historyIdx", () => {
  it("讀 history.state.idx", () => {
    stubHistoryState({ usr: null, key: "k", idx: 4 });
    expect(historyIdx()).toBe(4);
  });
  it("state 為 null 或 idx 不是數字 → null", () => {
    stubHistoryState(null);
    expect(historyIdx()).toBeNull();
    stubHistoryState({ idx: "3" });
    expect(historyIdx()).toBeNull();
  });
});

describe("recordListIdx / readListIdx", () => {
  it("記下目前序號，讀得回來", () => {
    stubHistoryState({ idx: 3 });
    recordListIdx();
    expect(readListIdx()).toBe(3);
  });

  it("目前序號讀不到時不覆寫舊記錄", () => {
    stubHistoryState({ idx: 3 });
    recordListIdx();
    stubHistoryState(null);
    recordListIdx();
    expect(readListIdx()).toBe(3);
  });

  it("沒記錄、內容不是整數 → null", () => {
    expect(readListIdx()).toBeNull();
    sessionStorage.setItem("nav.listIdx", "abc");
    expect(readListIdx()).toBeNull();
    sessionStorage.setItem("nav.listIdx", "1.5");
    expect(readListIdx()).toBeNull();
  });

  it("sessionStorage 讀寫丟錯 → readListIdx 回 null、recordListIdx 不丟", () => {
    stubHistoryState({ idx: 3 });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => recordListIdx()).not.toThrow();
    expect(readListIdx()).toBeNull();
  });
});
