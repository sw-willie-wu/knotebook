/** `avatars/oidc-picture.ts`：IdP 回報的 `picture` claim 解析與來源優先序。 */
import { describe, expect, it } from "vitest";
import { parsePictureClaim, pickPicture } from "../../src/avatars/oidc-picture.js";

describe("parsePictureClaim", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
    ["object", { url: "https://img.example/a.png" }],
    ["array", ["https://img.example/a.png"]],
    ["empty string", ""],
    ["whitespace only", "   \t\n"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:image/png;base64,AAAA"],
    ["ftp scheme", "ftp://img.example/a.png"],
    ["file scheme", "file:///etc/passwd"],
    ["relative path", "/avatars/a.png"],
    ["scheme-relative", "//img.example/a.png"],
    ["bare host", "img.example/a.png"],
    ["embedded NUL", "https://img.example/a\0.png"],
    ["lone high surrogate", "https://img.example/a\uD800.png"],
    ["lone low surrogate", "https://img.example/a\uDC00.png"],
    ["2049 characters", "https://img.example/" + "a".repeat(2049 - "https://img.example/".length)],
  ])("rejects %s", (_name, value) => {
    expect(parsePictureClaim(value)).toBeNull();
  });

  it("accepts http and https URLs unchanged", () => {
    expect(parsePictureClaim("http://img.example/a.png")).toBe("http://img.example/a.png");
    expect(parsePictureClaim("https://img.example/a.png?size=64")).toBe("https://img.example/a.png?size=64");
  });

  it("accepts a URL of exactly 2048 characters", () => {
    const prefix = "https://img.example/";
    const url = prefix + "a".repeat(2048 - prefix.length);
    expect(url).toHaveLength(2048);
    expect(parsePictureClaim(url)).toBe(url);
  });

  it("returns the trimmed value when the claim has surrounding whitespace", () => {
    expect(parsePictureClaim("  https://img.example/a.png \n")).toBe("https://img.example/a.png");
  });

  it("accepts a well-formed surrogate pair", () => {
    const url = "https://img.example/\u{1F600}.png";
    expect(parsePictureClaim(url)).toBe(url);
  });
});

describe("pickPicture", () => {
  const idToken = "https://img.example/from-id-token.png";
  const userinfo = "https://img.example/from-userinfo.png";

  it("prefers the ID token value even when userinfo also has one", () => {
    expect(pickPicture({ picture: idToken }, { picture: userinfo })).toBe(idToken);
  });

  it("falls back to userinfo when the ID token has no picture", () => {
    expect(pickPicture({}, { picture: userinfo })).toBe(userinfo);
  });

  it("returns null when userinfo is undefined and the ID token has none", () => {
    expect(pickPicture({}, undefined)).toBeNull();
  });

  it("uses the ID token value when userinfo is undefined", () => {
    expect(pickPicture({ picture: idToken }, undefined)).toBe(idToken);
  });

  it("falls back to userinfo when the ID token value is unusable", () => {
    expect(pickPicture({ picture: "javascript:alert(1)" }, { picture: userinfo })).toBe(userinfo);
  });

  it("returns null when neither source has a usable value", () => {
    expect(pickPicture({ picture: 5 }, { picture: "" })).toBeNull();
  });
});
