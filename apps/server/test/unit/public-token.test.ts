import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64 } from "@knotebook/shared";
import { isValidPublicToken, redactPublicTokens } from "../../src/routes/public.js";

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

  it("redactPublicTokens：/p/ 與 /api/public/notes/ 之後的 token 段換成 :token；其餘 URL 原樣", () => {
    const t = "A".repeat(43);
    expect(redactPublicTokens(`/p/${t}`)).toBe("/p/:token");
    expect(redactPublicTokens(`/p/${t}?x=1`)).toBe("/p/:token?x=1");
    expect(redactPublicTokens(`/api/public/notes/${t}`)).toBe("/api/public/notes/:token");
    expect(redactPublicTokens(`/api/public/notes/${t}/uploads/abc`)).toBe("/api/public/notes/:token/uploads/abc");
    // 非 43 字元的段也遮（log 遮罩寧可過寬——「差一個字元的幾乎 token」也不留）
    expect(redactPublicTokens("/p/short")).toBe("/p/:token");
    // 其餘路徑原樣，包括 /pnot-a-prefix 這種非 segment 邊界
    expect(redactPublicTokens("/api/notes/abc")).toBe("/api/notes/abc");
    expect(redactPublicTokens("/pnot-a-prefix")).toBe("/pnot-a-prefix");
    expect(redactPublicTokens("/")).toBe("/");
    // 洩漏變體（審查真 socket 實測）：重複開頭斜線與大小寫變體，SPA fallback 照樣
    // 200，遮罩必須吃得下。
    expect(redactPublicTokens(`//p/${t}`)).toBe("/p/:token");
    expect(redactPublicTokens(`/P/${t}`)).toBe("/p/:token");
    expect(redactPublicTokens(`//api/public/notes/${t}`)).toBe("/api/public/notes/:token");
  });
});
