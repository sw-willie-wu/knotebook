import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64 } from "@knotebook/shared";
import { isValidPublicToken } from "../../src/routes/public.js";

describe("公開分享的純函式（#72）", () => {
  it("EMPTY_YDOC_UPDATE_B64 真的等於空 Y.Doc 的 update 編碼（防兩端 import 同一個錯值的套套邏輯）", () => {
    const empty = Y.encodeStateAsUpdate(new Y.Doc());
    expect(Buffer.from(empty).toString("base64")).toBe(EMPTY_YDOC_UPDATE_B64);
    // 而且 client 端 applyUpdate 吃它不 throw（零長度才會 throw——那正是這個常數
    // 存在的理由，見 shared 的常數註解）。
    expect(() => Y.applyUpdate(new Y.Doc(), Buffer.from(EMPTY_YDOC_UPDATE_B64, "base64"))).not.toThrow();
  });

  it("isValidPublicToken：43 字元 base64url 才過；超長/過短/非法字元/空值全擋", () => {
    expect(isValidPublicToken("A".repeat(43))).toBe(true);
    expect(isValidPublicToken("abc-DEF_0123456789012345678901234567890123R")).toBe(true);
    expect(isValidPublicToken("A".repeat(42))).toBe(false);
    expect(isValidPublicToken("A".repeat(44))).toBe(false);
    expect(isValidPublicToken("A".repeat(200))).toBe(false);
    expect(isValidPublicToken("!".repeat(43))).toBe(false);
    expect(isValidPublicToken("A".repeat(42) + "=")).toBe(false); // base64（padding）不是 base64url
    expect(isValidPublicToken("")).toBe(false);
  });
});
