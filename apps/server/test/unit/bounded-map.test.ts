import { describe, it, expect } from "vitest";
import { BoundedMap } from "../../src/lib/bounded-map.js";

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

  it("重寫既有 key 永遠不淘汰別人（delete 先於 size 檢查）", () => {
    // 這條順序是 `LoginThrottle` 安全論證的地基：「已在追蹤中的 key 再失敗一次」不得把
    // 別人的紀錄擠掉。若實作寫成「先檢查 size 再 delete」，這一發會先砍掉最舊的那筆。
    //
    // ⚠ 被重寫的 key 必須**不是**最舊的那筆，否則兩種寫法的結果一模一樣（錯誤實作砍掉的
    // 正好是它自己，接著又被放回去）——上面那條「移到尾端」的測試就是這樣，分不出兩者。
    const map = new BoundedMap<number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("b", 20);

    expect(map.size).toBe(3);
    expect(map.get("a")).toBe(1); // 最舊的那筆沒有被這次重寫波及
    expect(map.get("b")).toBe(20);
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
