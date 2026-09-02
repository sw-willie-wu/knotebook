import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { BLOCKED_MEDIA_URL } from "@/lib/media-url";
import { blocknoteZhTW } from "@/i18n/blocknote-zh-TW";
import { noteSchema } from "./schema";
import { buildReadonlyNoteEditorOptions } from "./editor-options";
import type { PublicNoteRef } from "@/lib/public-note-ref";

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

function build(language = "en", publicRef: PublicNoteRef = { kind: "token", token: TOKEN }) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  return { doc, awareness, options: buildReadonlyNoteEditorOptions({ doc, awareness, publicRef, language }) };
}

describe("buildReadonlyNoteEditorOptions（#72＋#122 PR3：公開唯讀頁兩形的編輯器選項）", () => {
  it("fragment 用 shared 的 YDOC_FRAGMENT 本尊（寫錯名字的症狀是空白頁零錯誤——store.ts 檔頭警告過的雷）", () => {
    const { doc, options } = build();
    expect(options.collaboration.fragment).toBe(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(options.collaboration.fragment).not.toBe(doc.getXmlFragment("default"));
  });

  it("schema 是 noteSchema 本尊（唯讀頁要渲染的內容形狀跟編輯頁同一套）", () => {
    const { options } = build();
    expect(options.schema).toBe(noteSchema);
  });

  it("provider 是 { awareness } 裸物件、就是傳進來那顆 local Awareness（Task 0 spike 定案：不掛 HocuspocusProvider）", () => {
    const { awareness, options } = build();
    expect(options.collaboration.provider).toEqual({ awareness });
    expect(options.collaboration.provider.awareness).toBe(awareness);
  });

  it("collaboration.user 給匿名替身（name/color 必填——withCollaboration 沒有 user 會炸；唯讀無 cursor 顯示，值不重要）", () => {
    const { options } = build();
    expect(typeof options.collaboration.user.name).toBe("string");
    expect(typeof options.collaboration.user.color).toBe("string");
    expect(options.collaboration.user.color.length).toBeGreaterThan(0);
  });

  it("語言以 zh 開頭 → 掛繁中字典；其餘 → undefined（與編輯頁同一條規則，抽底層後兩邊不各寫一份）", () => {
    expect(build("zh-TW").options.dictionary).toBe(blocknoteZhTW);
    expect(build("en").options.dictionary).toBeUndefined();
  });

  it("resolveFileUrl 走 publicMediaUrl：自家上傳映射到公開圖端點、危險 scheme 照樣被 #12 守衛擋下", async () => {
    const { options } = build();
    await expect(options.resolveFileUrl!("/api/uploads/abc")).resolves.toBe(
      `/api/public/notes/${TOKEN}/uploads/abc`,
    );
    await expect(options.resolveFileUrl!("javascript:alert(1)")).resolves.toBe(BLOCKED_MEDIA_URL);
  });

  it("resolveFileUrl 別名形（#122 PR3）：依 publicRef 映射到 by-path 圖端點", async () => {
    const { options } = build("en", { kind: "path", handle: "alice", slug: "my-doc" });
    await expect(options.resolveFileUrl!("/api/uploads/abc")).resolves.toBe(
      "/api/public/notes/alice/my-doc/uploads/abc",
    );
  });

  it("不掛任何編輯用選項：uploadFile／pasteHandler／_tiptapOptions 都不存在（唯讀頁沒有輸入路徑，掛了就是攻擊面）", () => {
    const keys = Object.keys(build().options);
    expect(keys).not.toContain("uploadFile");
    expect(keys).not.toContain("pasteHandler");
    expect(keys).not.toContain("_tiptapOptions");
  });
});
