import { describe, expect, it } from "vitest";
import { parseEmailList } from "@/components/groups/bulk-add";
import { otherTokens, replaceToken, tokenAt } from "./email-list";

/** 拆地址（parseEmailList）認的每一種分隔。 */
const SEPARATORS = [",", ";", "，", "；", "、", "\n", "\r\n", " ", "\t", "　", ", ", "；　"];

describe("lib/email-list", () => {
  it("與 parseEmailList 同一套分隔：拆得開的地方，游標所在的地址也在那裡斷開", () => {
    for (const sep of SEPARATORS) {
      const text = `a@x.com${sep}an`;
      expect(parseEmailList(text).all, JSON.stringify(sep)).toEqual(["a@x.com", "an"]);
      expect(tokenAt(text, text.length), JSON.stringify(sep)).toEqual({ start: text.length - 2, end: text.length, token: "an" });
      expect(otherTokens(text, text.length - 2, text.length), JSON.stringify(sep)).toEqual(["a@x.com"]);
    }
  });

  it("`名字 <地址>`：角括號也是邊界", () => {
    const text = "Ann <an";
    expect(tokenAt(text, text.length).token).toBe("an");
  });

  it("tokenAt：游標在地址中間取整個地址；在分隔上是空片段；超出範圍夾回", () => {
    expect(tokenAt("a@x.com, bob, c@y.com", 11)).toEqual({ start: 9, end: 12, token: "bob" });
    expect(tokenAt("a@x.com, ", 9)).toEqual({ start: 9, end: 9, token: "" });
    expect(tokenAt("an", 99)).toEqual({ start: 0, end: 2, token: "an" });
  });

  it("replaceToken：最後一個 → 補「, 」；中間那個 → 沿用原本的分隔；其他地址原樣", () => {
    expect(replaceToken("a@x.com，an", 8, 10, "ann@x.com")).toEqual({ text: "a@x.com，ann@x.com, ", caret: 19 });
    expect(replaceToken("a@x.com, an, c@y.com", 9, 11, "ann@x.com")).toEqual({ text: "a@x.com, ann@x.com, c@y.com", caret: 20 });
    expect(replaceToken("an；c@y.com", 0, 2, "ann@x.com")).toEqual({ text: "ann@x.com；c@y.com", caret: 10 });
    // 只靠空白隔開的下一個地址：補「, 」並收掉原本的空白
    expect(replaceToken("an c@y.com", 0, 2, "ann@x.com")).toEqual({ text: "ann@x.com, c@y.com", caret: 11 });
  });

  it("replaceToken：`名字 <地址>` 括號裡的地址（後面緊接 `>`）不補分隔，游標放到 `>`（與其後的分隔）後面", () => {
    expect(replaceToken("Ann <an>", 5, 7, "ann@x.com")).toEqual({ text: "Ann <ann@x.com>", caret: 15 });
    expect(replaceToken("Ann <an>, c@y.com", 5, 7, "ann@x.com")).toEqual({ text: "Ann <ann@x.com>, c@y.com", caret: 17 });
    expect(parseEmailList("Ann <ann@x.com>, c@y.com").all).toEqual(["ann@x.com", "c@y.com"]);
  });
});
