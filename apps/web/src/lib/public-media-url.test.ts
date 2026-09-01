import { describe, expect, it } from "vitest";
import { BLOCKED_MEDIA_URL } from "./media-url";
import { publicMediaUrl } from "./public-media-url";

/** 43 字元 base64url——與 server 端 token 同形（實際值不影響映射邏輯）。 */
const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

describe("publicMediaUrl（#72 Task 3：公開頁的 resolveFileUrl 映射）", () => {
  const resolve = publicMediaUrl(TOKEN);

  it("自家上傳的相對網址 /api/uploads/:id → 映射成公開圖端點（token 進路徑）", () => {
    expect(resolve("/api/uploads/11111111-1111-1111-1111-111111111111")).toBe(
      `/api/public/notes/${TOKEN}/uploads/11111111-1111-1111-1111-111111111111`,
    );
  });

  it("外部 https 絕對網址原樣放行（hotlink 本來就允許，見 media-url.ts 檔頭）", () => {
    expect(resolve("https://example.com/pic.png")).toBe("https://example.com/pic.png");
  });

  it("同源**絕對**網址不映射（known-limitation：匿名端沒 session 會破圖——刻意不猜 origin）", () => {
    const absolute = `${window.location.origin}/api/uploads/22222222-2222-2222-2222-222222222222`;
    expect(resolve(absolute)).toBe(absolute);
  });

  it("危險 scheme 先過 safeMediaUrl → about:blank（映射不得成為 #12 守衛的繞道）", () => {
    expect(resolve("javascript:alert(1)")).toBe(BLOCKED_MEDIA_URL);
    expect(resolve("data:image/png;base64,AAA")).toBe(BLOCKED_MEDIA_URL);
  });

  it("空字串（BlockNote 的「還沒有檔案」表示法）原樣放行，不映射", () => {
    expect(resolve("")).toBe("");
  });

  it("多一段路徑（/api/uploads/a/b）不是上傳網址的形狀，不映射", () => {
    expect(resolve("/api/uploads/a/b")).toBe("/api/uploads/a/b");
  });

  it("帶 query/fragment 的變體不映射（自家上傳網址從不帶，寬鬆比對只會擴大攻擊面）", () => {
    expect(resolve("/api/uploads/x?y=1")).toBe("/api/uploads/x?y=1");
    expect(resolve("/api/uploads/x#y")).toBe("/api/uploads/x#y");
  });
});
