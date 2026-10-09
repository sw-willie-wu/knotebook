import { describe, expect, it } from "vitest";
import { locateSlide, repositionAfterUpdate, type SlideStructure } from "./reposition";

const deck = (spec: string): SlideStructure[] =>
  // "a:a1,a2|b:b1" → [{id:"a", slides:[a1,a2]}, {id:"b", slides:[b1]}]（章 id 取第一張，與 noteToSlides 同）
  spec.split("|").map((part) => {
    const ids = part.split(":")[1].split(",");
    return { id: ids[0], slides: ids.map((id) => ({ id })) };
  });

describe("locateSlide", () => {
  it("回傳 (h, v)；找不到回 null", () => {
    const d = deck("_:_title|a:a1,a2|b:b1");
    expect(locateSlide(d, "a2")).toEqual({ h: 1, v: 1 });
    expect(locateSlide(d, "b1")).toEqual({ h: 2, v: 0 });
    expect(locateSlide(d, "zz")).toBeNull();
  });
});

describe("repositionAfterUpdate（spec §7.2）", () => {
  it("①目前那張仍在 → 它的新位置（結構前移：前面一章被刪）", () => {
    const old = deck("_:_title|a:a1|b:b1,b2");
    const next = deck("_:_title|b:b1,b2");
    expect(repositionAfterUpdate(old, "b2", next)).toEqual({ h: 1, v: 1, id: "b2" });
  });

  it("①結構後移：前面插入一章 → 以 ID 重算出新的 h", () => {
    const old = deck("_:_title|b:b1,b2");
    const next = deck("_:_title|n:n1|b:b1,b2");
    expect(repositionAfterUpdate(old, "b2", next)).toEqual({ h: 2, v: 1, id: "b2" });
  });

  it("②目前那張消失 → 舊結構中緊接在它之前的那一張（同章上一張）", () => {
    const old = deck("_:_title|a:a1,a2,a3");
    const next = deck("_:_title|a:a1,a2");
    expect(repositionAfterUpdate(old, "a3", next)).toEqual({ h: 1, v: 1, id: "a2" });
  });

  it("②章首消失 → 上一章最後一張", () => {
    const old = deck("_:_title|a:a1,a2|b:b1,b2");
    const next = deck("_:_title|a:a1,a2|b2:b2");
    expect(repositionAfterUpdate(old, "b1", next)).toEqual({ h: 1, v: 1, id: "a2" });
  });

  it("③前一張也不在 → 舊結構中它所屬那章的第一張", () => {
    const old = deck("_:_title|a:a1,a2,a3");
    const next = deck("_:_title|a:a1");
    expect(repositionAfterUpdate(old, "a3", next)).toEqual({ h: 1, v: 0, id: "a1" });
  });

  it("④都不在 → 封面 (0,0)", () => {
    const old = deck("_:_title|a:a1,a2");
    const next = deck("_:_title|z:z1");
    expect(repositionAfterUpdate(old, "a2", next)).toEqual({ h: 0, v: 0, id: "_title" });
  });

  it("②只退一步：前一張不在就不再往前找（落到③章首）", () => {
    const old = deck("_:_title|a:a1,a2,a3,a4");
    const next = deck("_:_title|a:a1,a2");
    // a4 消失、前一張 a3 也消失 → ③ a 章第一張 a1（不是 a2）
    expect(repositionAfterUpdate(old, "a4", next)).toEqual({ h: 1, v: 0, id: "a1" });
  });

  it("③用的是**舊**結構的章首：新結構同一索引的章換了人時不跟新章首", () => {
    const old = deck("_:_title|a:a1,a2,a3");
    const next = deck("_:_title|q:q1|a1:a1");
    // a3、a2 都消失 → 舊章首 a1 仍在（新結構 h=2）；若誤用新結構第 old.h（=1）章的章首會得 q1
    expect(repositionAfterUpdate(old, "a3", next)).toEqual({ h: 2, v: 0, id: "a1" });
  });

  it("舊目前 id 不在舊結構（理論上不該發生）→ 封面", () => {
    expect(repositionAfterUpdate(deck("_:_title"), "ghost", deck("_:_title|a:a1"))).toEqual({ h: 0, v: 0, id: "_title" });
  });
});
