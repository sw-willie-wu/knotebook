import { describe, it, expect } from "vitest";
import { BoundedMap } from "../../src/util/bounded-map.js";

describe("BoundedMap", () => {
  it("未達上限時就是一般的 Map", () => {
    const map = new BoundedMap<number>(3);
    map.set("a", 1);
    map.set("b", 2);

    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(2);
    expect(map.get("missing")).toBeUndefined();
    expect(map.size).toBe(2);
  });

  it("超過上限時淘汰最舊的一筆（插入序）", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(map.size).toBe(2);
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  it("重寫既有 key 會把它移到尾端（因而免於下一次淘汰）", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    // 'a' 重新寫入 → 移到尾端，最舊的變成 'b'。
    map.set("a", 10);
    map.set("c", 3);

    expect(map.get("a")).toBe(10);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBe(3);
  });

  it("get 不影響淘汰順序（刻意不做 access-recency LRU）", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.get("a"); // 純讀取不重排
    map.set("c", 3);

    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
  });

  it("delete 讓出空間，之後的插入不會再淘汰別人", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.delete("a")).toBe(true);
    expect(map.delete("a")).toBe(false);

    map.set("c", 3);
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
    expect(map.size).toBe(2);
  });

  it("上限為 1 時每次插入都只留最新的一筆", () => {
    const map = new BoundedMap<number>(1);
    map.set("a", 1);
    map.set("b", 2);

    expect(map.size).toBe(1);
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
  });

  it("maxKeys 不是正整數就丟錯（靜靜地變成無上限才是最糟的失敗）", () => {
    expect(() => new BoundedMap<number>(0)).toThrow();
    expect(() => new BoundedMap<number>(-1)).toThrow();
    expect(() => new BoundedMap<number>(1.5)).toThrow();
  });
});
