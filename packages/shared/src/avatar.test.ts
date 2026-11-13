import { describe, expect, it } from "vitest";
import {
  AVATAR_DISPLAY_SIZE,
  AVATAR_MIME_TYPES,
  MAX_AVATAR_DISPLAY_BYTES,
  MAX_OIDC_AVATAR_BYTES,
  avatarUrl,
  parseAvatarRef,
} from "./avatar.js";

const id = "0f0e1d2c-3b4a-4958-8677-665544332211";

describe("avatarUrl", () => {
  it("帶 ?v= 版本", () => {
    expect(avatarUrl(id, 3)).toBe(`/api/avatars/${id}?v=3`);
  });
  it("id 經 encodeURIComponent", () => {
    expect(avatarUrl("a/b", 1)).toBe("/api/avatars/a%2Fb?v=1");
  });
});

describe("parseAvatarRef 合法", () => {
  it("小寫 uuid 原樣", () => {
    expect(parseAvatarRef({ id, v: 1 })).toEqual({ id, v: 1 });
  });
  it("大寫 uuid 轉小寫", () => {
    expect(parseAvatarRef({ id: id.toUpperCase(), v: 7 })).toEqual({ id, v: 7 });
  });
  it("多餘欄忽略，只回 id、v", () => {
    const r = parseAvatarRef({ id, v: 2, extra: "x", url: "https://evil" });
    expect(r).toEqual({ id, v: 2 });
    expect(Object.keys(r!).sort()).toEqual(["id", "v"]);
  });
});

describe("parseAvatarRef 一律 null", () => {
  it.each<[string, unknown]>([
    ["https 網址", "https://example.com/a.png"],
    ["javascript:", "javascript:alert(1)"],
    ["站內網址字串", `/api/avatars/${id}?v=1`],
    ["null", null],
    ["undefined", undefined],
    ["數字", 42],
    ["陣列", []],
    ["空物件", {}],
    ["id 非 uuid", { id: "x", v: 1 }],
    ["id 路徑穿越", { id: "../../api/auth/me", v: 1 }],
    ["id 前綴穿越", { id: "../" + id, v: 1 }],
    ["id 後綴", { id: id + "/x", v: 1 }],
    ["id 為陣列", { id: [id], v: 1 }],
    ["缺 v", { id }],
    ["缺 id", { v: 1 }],
    ["v=0", { id, v: 0 }],
    ["v=-1", { id, v: -1 }],
    ["v=1.5", { id, v: 1.5 }],
    ["v=1e300", { id, v: 1e300 }],
    ["v=NaN", { id, v: Number.NaN }],
    ["v=Infinity", { id, v: Infinity }],
    ["v 為字串", { id, v: "1" }],
    ["id 為數字", { id: 123, v: 1 }],
  ])("%s", (_name, input) => {
    expect(parseAvatarRef(input)).toBeNull();
  });
});

describe("頭貼常數", () => {
  it("字面值", () => {
    expect(MAX_AVATAR_DISPLAY_BYTES).toBe(262144);
    expect(AVATAR_DISPLAY_SIZE).toBe(256);
    expect(MAX_OIDC_AVATAR_BYTES).toBe(1048576);
  });
  it("可接受的原圖 MIME 是 png／jpeg／webp，不含 gif", () => {
    expect([...AVATAR_MIME_TYPES]).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(AVATAR_MIME_TYPES).not.toContain("image/gif" as never);
  });
});
