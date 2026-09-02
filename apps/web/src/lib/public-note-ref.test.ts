import { describe, expect, it } from "vitest";
import { publicNoteApiPath, publicNoteQueryKey } from "./public-note-ref";

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

describe("publicNoteApiPath（#122 PR3：兩形 API 網址的唯一組字點）", () => {
  it("token 形 → /api/public/notes/<token>", () => {
    expect(publicNoteApiPath({ kind: "token", token: TOKEN })).toBe(`/api/public/notes/${TOKEN}`);
  });

  it("別名形 → /api/public/notes/<handle>/<slug>；非 ASCII slug 先編碼（fetch URL 面）", () => {
    expect(publicNoteApiPath({ kind: "path", handle: "alice", slug: "my-doc" })).toBe(
      "/api/public/notes/alice/my-doc",
    );
    expect(publicNoteApiPath({ kind: "path", handle: "alice", slug: "café" })).toBe(
      "/api/public/notes/alice/caf%C3%A9",
    );
  });
});

describe("publicNoteQueryKey（兩形不得共 key——共了會拿到彼此的殘留快取）", () => {
  it("token 形與別名形前綴不同、段落逐值展開", () => {
    expect(publicNoteQueryKey({ kind: "token", token: TOKEN })).toEqual(["public-note", TOKEN]);
    expect(publicNoteQueryKey({ kind: "path", handle: "alice", slug: "my-doc" })).toEqual([
      "public-note-by-path",
      "alice",
      "my-doc",
    ]);
  });
});
